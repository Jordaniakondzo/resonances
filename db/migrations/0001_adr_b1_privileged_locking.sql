-- ADR-B1: privileged reference locking for the D03 import.
--
-- Installs three fixed SECURITY DEFINER functions that take row locks on
-- public.themes and public.media_assets on behalf of the importer, so that the
-- importer needs no UPDATE privilege on those tables. Prerequisites and
-- design: docs/adr/ADR-B1-PRIVILEGED-REFERENCE-LOCKING.md and
-- db/provisioning/d03-b1-roles.sql (roles are created OUTSIDE this migration).
--
-- Everything below runs in the single transaction of the migrator. The file
-- must never be executed outside a transaction: SET LOCAL ROLE would then have
-- no effect, and the assertions would reject the wrong ownership.
-- The six business tables and migration 0000 are not modified.

-- 1. Preflight: roles must exist and have the expected, minimal shape.
DO $preflight$
DECLARE
  owner_oid oid;
  importer_oid oid;
BEGIN
  SELECT oid INTO owner_oid FROM pg_catalog.pg_roles WHERE rolname = 'resonances_b1_owner';
  SELECT oid INTO importer_oid FROM pg_catalog.pg_roles WHERE rolname = 'resonances_importer';
  IF owner_oid IS NULL OR importer_oid IS NULL THEN
    RAISE EXCEPTION 'ADR-B1: roles resonances_b1_owner and resonances_importer must be provisioned first (db/provisioning/d03-b1-roles.sql)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE oid IN (owner_oid, importer_oid)
      AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'ADR-B1: B1 owner and importer must not be superuser, CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid = owner_oid AND rolcanlogin) THEN
    RAISE EXCEPTION 'ADR-B1: the B1 owner must be NOLOGIN';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = owner_oid) THEN
    RAISE EXCEPTION 'ADR-B1: the B1 owner must not be a member of any role';
  END IF;
  -- MEMBER is true for direct or indirect membership, regardless of INHERIT.
  IF pg_catalog.pg_has_role(importer_oid, owner_oid, 'MEMBER')
     OR pg_catalog.pg_has_role(importer_oid, owner_oid, 'USAGE')
     OR pg_catalog.pg_has_role(importer_oid, owner_oid, 'SET') THEN
    RAISE EXCEPTION 'ADR-B1: the importer must not be able to inherit or SET ROLE to the B1 owner';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    WHERE c.oid IN ('public.themes'::regclass, 'public.media_assets'::regclass)
      AND c.relowner = owner_oid
  ) THEN
    RAISE EXCEPTION 'ADR-B1: the B1 owner must not own the reference tables';
  END IF;
  -- The migration identity creates the schema for the owner, then acts as it.
  IF NOT pg_catalog.pg_has_role(current_user, owner_oid, 'SET') THEN
    RAISE EXCEPTION 'ADR-B1: the migration role must be allowed to SET ROLE to resonances_b1_owner';
  END IF;

  -- Default privileges. CREATE SCHEMA ... AUTHORIZATION <owner> applies the
  -- default privileges registered FOR ROLE <owner> (pg_default_acl), and
  -- REVOKE ... FROM PUBLIC does not remove entries granted to other roles.
  -- A pre-existing owner could therefore hand CREATE (or EXECUTE on future
  -- functions) to an untrusted role. Only entries whose grantee is the owner
  -- itself are acceptable. Fail closed: nothing is repaired here, the
  -- administrator must inspect and remove the entry.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_default_acl d, LATERAL pg_catalog.aclexplode(d.defaclacl) a
    WHERE d.defaclrole = owner_oid AND a.grantee <> owner_oid
  ) THEN
    RAISE EXCEPTION 'ADR-B1: default privileges of the B1 owner grant rights to another role or PUBLIC; inspect pg_default_acl and remove them first';
  END IF;

  -- A pre-existing owner must own nothing in this database (shared dependency
  -- records of kind "owner"); its own default-ACL entries were checked above.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_shdepend s
    WHERE s.refclassid = 'pg_catalog.pg_authid'::regclass
      AND s.refobjid = owner_oid
      AND s.deptype = 'o'
      AND s.dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
      AND s.classid <> 'pg_catalog.pg_default_acl'::regclass
  ) THEN
    RAISE EXCEPTION 'ADR-B1: the B1 owner must not own any object in this database before the migration';
  END IF;

  -- Paths to the owner. The migration identity is expected to hold SET only.
  -- Any membership that inherits the owner's rights or can administer it is
  -- refused, and so is any membership held by the importer or by a role the
  -- importer is a member of. Other SET-only members are an administrator
  -- decision (cluster-wide), reported in the operations document.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    WHERE m.roleid = owner_oid AND (m.inherit_option OR m.admin_option)
  ) THEN
    RAISE EXCEPTION 'ADR-B1: only SET-only memberships of the B1 owner are allowed (no INHERIT, no ADMIN OPTION)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    WHERE m.roleid = owner_oid
      AND pg_catalog.pg_has_role(m.member, importer_oid, 'MEMBER')
  ) THEN
    RAISE EXCEPTION 'ADR-B1: the importer, or a role it is a member of, must not be a member of the B1 owner';
  END IF;
END
$preflight$;
--> statement-breakpoint

-- 2. Private schema, owned by the dedicated owner. CREATE SCHEMA is not
-- idempotent on purpose: a pre-existing d03_priv must be inspected by a human.
CREATE SCHEMA d03_priv AUTHORIZATION resonances_b1_owner;
--> statement-breakpoint

-- 3. Act as the owner so that it owns every object from the first instant.
SET LOCAL ROLE resonances_b1_owner;
--> statement-breakpoint

DO $assert_role$
BEGIN
  IF current_user <> 'resonances_b1_owner' THEN
    RAISE EXCEPTION 'ADR-B1: SET LOCAL ROLE did not take effect';
  END IF;
END
$assert_role$;
--> statement-breakpoint

-- Nobody but the owner may use or create objects in the private schema.
REVOKE ALL ON SCHEMA d03_priv FROM PUBLIC;
--> statement-breakpoint

-- Functions created later by the owner will not be executable by PUBLIC either.
ALTER DEFAULT PRIVILEGES FOR ROLE resonances_b1_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint

-- 4. Functions: one fixed table, one fixed lock mode, one uuid parameter.
-- Static SQL, schema-qualified tables, trusted search_path with pg_temp last.
-- They neither begin nor end a transaction: the locks last until the caller's
-- COMMIT or ROLLBACK (or a rollback to a savepoint taken before the call).

-- FOR SHARE protects the (locale, slug) pair the import resolved.
CREATE FUNCTION d03_priv.lock_theme(p_id uuid)
RETURNS TABLE (id uuid, locale text, slug text)
LANGUAGE plpgsql
VOLATILE
STRICT
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
ROWS 1
AS $fn$
BEGIN
  RETURN QUERY
    SELECT t.id, t.locale, t.slug
    FROM public.themes AS t
    WHERE t.id = p_id
    FOR SHARE OF t;
END;
$fn$;
--> statement-breakpoint

-- FOR KEY SHARE only protects existence and key columns of a media used by
-- drafts or archives; it does not block non-key UPDATEs.
CREATE FUNCTION d03_priv.lock_media_key(p_id uuid)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql
VOLATILE
STRICT
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
ROWS 1
AS $fn$
BEGIN
  RETURN QUERY
    SELECT m.id
    FROM public.media_assets AS m
    WHERE m.id = p_id
    FOR KEY SHARE OF m;
END;
$fn$;
--> statement-breakpoint

-- FOR SHARE protects the readiness metadata of a media used by published content.
CREATE FUNCTION d03_priv.lock_media_ready(p_id uuid)
RETURNS TABLE (
  id uuid,
  original_url text,
  alt_text text,
  source text,
  license text,
  author text,
  width integer,
  height integer
)
LANGUAGE plpgsql
VOLATILE
STRICT
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
ROWS 1
AS $fn$
BEGIN
  RETURN QUERY
    SELECT m.id, m.original_url, m.alt_text, m.source, m.license, m.author,
           m.width, m.height
    FROM public.media_assets AS m
    WHERE m.id = p_id
    FOR SHARE OF m;
END;
$fn$;
--> statement-breakpoint

COMMENT ON FUNCTION d03_priv.lock_theme(uuid) IS 'ADR-B1: FOR SHARE on one theme; returns id, locale, slug. Zero rows if absent.';
--> statement-breakpoint
COMMENT ON FUNCTION d03_priv.lock_media_key(uuid) IS 'ADR-B1: FOR KEY SHARE on one media asset; returns id. Zero rows if absent.';
--> statement-breakpoint
COMMENT ON FUNCTION d03_priv.lock_media_ready(uuid) IS 'ADR-B1: FOR SHARE on one media asset; returns readiness fields. Zero rows if absent.';
--> statement-breakpoint

-- 5. Same transaction as the CREATE FUNCTION statements: no EXECUTE window for
-- PUBLIC. Only the importer is then granted USAGE and EXECUTE.
REVOKE EXECUTE ON FUNCTION d03_priv.lock_theme(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION d03_priv.lock_media_key(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION d03_priv.lock_media_ready(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA d03_priv TO resonances_importer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION d03_priv.lock_theme(uuid) TO resonances_importer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION d03_priv.lock_media_key(uuid) TO resonances_importer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION d03_priv.lock_media_ready(uuid) TO resonances_importer;
--> statement-breakpoint

-- The functions resolve public.* objects; keep that access explicit.
GRANT USAGE ON SCHEMA public TO resonances_b1_owner;
--> statement-breakpoint

-- Back to the migration identity: it owns the reference tables and grants on them.
RESET ROLE;
--> statement-breakpoint

-- 6. Owner privileges on the reference tables. SELECT covers only the columns
-- the functions read. PostgreSQL requires UPDATE on at least one column for
-- FOR SHARE / FOR KEY SHARE; updated_at is the least harmful choice: it is not
-- a key (not in the primary key, a unique constraint or a foreign key), not an
-- editorial or readiness field, and no application code reads it. No UPDATE(id).
GRANT SELECT (id, locale, slug), UPDATE (updated_at) ON public.themes TO resonances_b1_owner;
--> statement-breakpoint
GRANT SELECT (id, original_url, alt_text, source, license, author, width, height),
      UPDATE (updated_at) ON public.media_assets TO resonances_b1_owner;
--> statement-breakpoint

-- 7. Post-conditions: fail the whole migration if the effective result drifts.
DO $verify$
DECLARE
  fn oid;
  owner_oid oid := 'resonances_b1_owner'::regrole;
  importer_oid oid := 'resonances_importer'::regrole;
  acl_row record;
  r record;
BEGIN
  IF current_user = 'resonances_b1_owner' THEN
    RAISE EXCEPTION 'ADR-B1: RESET ROLE did not take effect';
  END IF;

  -- Default privileges of the owner: still only the owner's own entries
  -- (the REVOKE FROM PUBLIC above leaves exactly {owner=X/owner}).
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_default_acl d, LATERAL pg_catalog.aclexplode(d.defaclacl) a
    WHERE d.defaclrole = owner_oid AND a.grantee <> owner_oid
  ) THEN
    RAISE EXCEPTION 'ADR-B1: default privileges of the B1 owner grant rights to another role or PUBLIC';
  END IF;

  -- The owner owns exactly: the schema, the three functions and (at most) its
  -- default-ACL entries. Nothing else in this database.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_shdepend s
    WHERE s.refclassid = 'pg_catalog.pg_authid'::regclass
      AND s.refobjid = owner_oid AND s.deptype = 'o'
      AND s.dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
    GROUP BY s.classid
    HAVING NOT (
      (s.classid = 'pg_catalog.pg_namespace'::regclass AND count(*) = 1)
      OR (s.classid = 'pg_catalog.pg_proc'::regclass AND count(*) = 3)
      OR s.classid = 'pg_catalog.pg_default_acl'::regclass
    )
  ) THEN
    RAISE EXCEPTION 'ADR-B1: the B1 owner owns unexpected objects';
  END IF;

  -- No path to the owner other than SET-only memberships (see preflight).
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    WHERE m.roleid = owner_oid
      AND (m.inherit_option OR m.admin_option
           OR pg_catalog.pg_has_role(m.member, importer_oid, 'MEMBER'))
  ) THEN
    RAISE EXCEPTION 'ADR-B1: unexpected path to the B1 owner (inheritance, ADMIN OPTION or the importer)';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace = 'd03_priv'::regnamespace) <> 3 THEN
    RAISE EXCEPTION 'ADR-B1: d03_priv must contain exactly the three B1 functions';
  END IF;
  IF (SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname = 'd03_priv')
     <> 'resonances_b1_owner'::regrole THEN
    RAISE EXCEPTION 'ADR-B1: d03_priv has the wrong owner';
  END IF;

  -- Resolved through catalog OIDs: the migration identity has no USAGE on
  -- d03_priv, so a schema-qualified regprocedure literal would be refused.
  IF (
    SELECT count(*) FROM pg_catalog.pg_proc
    WHERE pronamespace = 'd03_priv'::regnamespace
      AND proname IN ('lock_theme', 'lock_media_key', 'lock_media_ready')
      AND pronargs = 1 AND proargtypes[0] = 'uuid'::regtype
  ) <> 3 THEN
    RAISE EXCEPTION 'ADR-B1: d03_priv must contain exactly the three uuid-argument B1 functions';
  END IF;
  FOR fn IN
    SELECT p.oid FROM pg_catalog.pg_proc p
    WHERE p.pronamespace = 'd03_priv'::regnamespace
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc
      WHERE oid = fn
        AND proowner = 'resonances_b1_owner'::regrole
        AND prosecdef
        AND provolatile = 'v'
        AND proisstrict
        AND proconfig = ARRAY['search_path=pg_catalog, pg_temp']
    ) THEN
      RAISE EXCEPTION 'ADR-B1: unexpected definition for function %', fn;
    END IF;
    -- A grantee of 0 in the ACL means PUBLIC.
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p, LATERAL pg_catalog.aclexplode(p.proacl) a
      WHERE p.oid = fn AND a.grantee = 0
    ) THEN
      RAISE EXCEPTION 'ADR-B1: PUBLIC can execute function %', fn;
    END IF;
    IF NOT pg_catalog.has_function_privilege('resonances_importer', fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'ADR-B1: the importer cannot execute function %', fn;
    END IF;

    -- Exact allow-list: a NULL ACL would mean the default (PUBLIC EXECUTE);
    -- otherwise only the owner and a non-grantable EXECUTE for the importer.
    IF (SELECT proacl IS NULL FROM pg_catalog.pg_proc WHERE oid = fn) THEN
      RAISE EXCEPTION 'ADR-B1: unexpected ACL on function % (default ACL)', fn;
    END IF;
    FOR acl_row IN
      SELECT a.grantee, a.privilege_type, a.is_grantable
      FROM pg_catalog.pg_proc p, LATERAL pg_catalog.aclexplode(p.proacl) a
      WHERE p.oid = fn
    LOOP
      IF acl_row.grantee = owner_oid THEN
        CONTINUE;
      ELSIF acl_row.grantee = importer_oid
            AND acl_row.privilege_type = 'EXECUTE'
            AND NOT acl_row.is_grantable THEN
        CONTINUE;
      END IF;
      RAISE EXCEPTION 'ADR-B1: unexpected ACL entry on function % (grantee oid %, % grantable=%)',
        fn, acl_row.grantee, acl_row.privilege_type, acl_row.is_grantable;
    END LOOP;
    -- Effective privileges, inheritance included: only the owner, the importer
    -- and roles inheriting the importer may execute. Superusers and predefined
    -- pg_* roles are outside the trust boundary this migration can control.
    FOR r IN
      SELECT o.oid, o.rolname FROM pg_catalog.pg_roles o
      WHERE NOT o.rolsuper AND o.rolname !~ '^pg_' AND o.oid <> owner_oid
    LOOP
      IF pg_catalog.has_function_privilege(r.oid, fn, 'EXECUTE')
         AND NOT pg_catalog.pg_has_role(r.oid, importer_oid, 'USAGE') THEN
        RAISE EXCEPTION 'ADR-B1: unexpected ACL effect: role % can execute function %', r.rolname, fn;
      END IF;
    END LOOP;
  END LOOP;

  -- Schema: exact allow-list as well. The owner keeps its rights, the
  -- importer holds a non-grantable USAGE and nothing else.
  -- A NULL ACL means "default privileges" and aclexplode(NULL) returns no row,
  -- so the loop below would silently accept it: refuse it explicitly.
  IF (SELECT n.nspacl IS NULL FROM pg_catalog.pg_namespace n WHERE n.nspname = 'd03_priv') THEN
    RAISE EXCEPTION 'ADR-B1: schema d03_priv has no ACL (default privileges)';
  END IF;
  -- Positive check: the importer must really be able to reach the functions.
  IF NOT pg_catalog.has_schema_privilege(importer_oid, 'd03_priv', 'USAGE') THEN
    RAISE EXCEPTION 'ADR-B1: the importer lacks USAGE on schema d03_priv';
  END IF;
  FOR acl_row IN
    SELECT a.grantee, a.privilege_type, a.is_grantable
    FROM pg_catalog.pg_namespace n, LATERAL pg_catalog.aclexplode(n.nspacl) a
    WHERE n.nspname = 'd03_priv'
  LOOP
    IF acl_row.grantee = owner_oid THEN
      CONTINUE;
    ELSIF acl_row.grantee = importer_oid
          AND acl_row.privilege_type = 'USAGE'
          AND NOT acl_row.is_grantable THEN
      CONTINUE;
    END IF;
    RAISE EXCEPTION 'ADR-B1: unexpected ACL entry on schema d03_priv (grantee oid %, % grantable=%)',
      acl_row.grantee, acl_row.privilege_type, acl_row.is_grantable;
  END LOOP;
  -- Effective privileges, inheritance included: nobody but the owner may
  -- CREATE; only the importer (and roles inheriting it) may USE the schema.
  FOR r IN
    SELECT o.oid, o.rolname FROM pg_catalog.pg_roles o
    WHERE NOT o.rolsuper AND o.rolname !~ '^pg_' AND o.oid <> owner_oid
  LOOP
    IF pg_catalog.has_schema_privilege(r.oid, 'd03_priv', 'CREATE') THEN
      RAISE EXCEPTION 'ADR-B1: unexpected ACL effect: role % can CREATE in d03_priv', r.rolname;
    END IF;
    IF pg_catalog.has_schema_privilege(r.oid, 'd03_priv', 'USAGE')
       AND NOT pg_catalog.pg_has_role(r.oid, importer_oid, 'USAGE') THEN
      RAISE EXCEPTION 'ADR-B1: unexpected ACL effect: role % can use d03_priv', r.rolname;
    END IF;
  END LOOP;

  IF pg_catalog.has_schema_privilege('resonances_importer', 'd03_priv', 'CREATE') THEN
    RAISE EXCEPTION 'ADR-B1: the importer must not CREATE in d03_priv';
  END IF;
  IF pg_catalog.has_table_privilege('resonances_b1_owner', 'public.themes', 'UPDATE')
     OR pg_catalog.has_table_privilege('resonances_b1_owner', 'public.media_assets', 'UPDATE')
     OR pg_catalog.has_column_privilege('resonances_b1_owner', 'public.themes', 'id', 'UPDATE')
     OR pg_catalog.has_column_privilege('resonances_b1_owner', 'public.media_assets', 'id', 'UPDATE') THEN
    RAISE EXCEPTION 'ADR-B1: the B1 owner holds excessive UPDATE privileges';
  END IF;
  IF pg_catalog.has_any_column_privilege('resonances_importer', 'public.themes', 'UPDATE')
     OR pg_catalog.has_any_column_privilege('resonances_importer', 'public.media_assets', 'UPDATE') THEN
    RAISE EXCEPTION 'ADR-B1: the importer must hold no UPDATE on reference tables';
  END IF;
END
$verify$;
