-- Operational verification of the public reader (T2). READ-ONLY: it only reads
-- the catalogs. Run it as an administrator or migration identity, in the target
-- database, after migration 0002 AND again after LOGIN was enabled for
-- resonances_app_reader. It raises an exception naming the first violation, or
-- finishes with a NOTICE. It never changes anything.
--
-- It uses the effective-privilege functions (has_*_privilege, pg_has_role), so
-- inherited privileges, PUBLIC grants and SET ROLE paths are all taken into
-- account. Superusers and predefined pg_* roles are outside what it can bound.
--
-- While a migration identity still holds resonances_public_views_owner, name it first:
--   SET resonances.migration_role = '<migration_role>';
-- (recommended: revoke the membership after the migration and leave it unset).

DO $verify$
DECLARE
  reader oid := 'resonances_app_reader'::regrole;
  owner oid := 'resonances_public_views_owner'::regrole;
  r record;
  allowed_views text[] := ARRAY['public_read.publications', 'public_read.publication_themes'];
  authorized text;
  authorized_oid oid;
  offenders text;
  v record;
  allowed boolean;
BEGIN
  -- 1. Role shape. LOGIN is allowed (and expected) for the reader only.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE oid IN (reader, owner)
      AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'verify: privileged attribute on the reader or the views owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid = owner AND rolcanlogin) THEN
    RAISE EXCEPTION 'verify: the views owner can log in';
  END IF;

  -- 2. No membership, inheritance or SET ROLE path from the reader to ANY other role.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member IN (reader, owner)) THEN
    RAISE EXCEPTION 'verify: the reader or the views owner is a member of another role';
  END IF;
  FOR r IN SELECT oid, rolname FROM pg_catalog.pg_roles WHERE oid <> reader LOOP
    IF pg_catalog.pg_has_role(reader, r.oid, 'MEMBER')
       OR pg_catalog.pg_has_role(reader, r.oid, 'USAGE')
       OR pg_catalog.pg_has_role(reader, r.oid, 'SET') THEN
      RAISE EXCEPTION 'verify: the reader can inherit or SET ROLE to %', r.rolname;
    END IF;
  END LOOP;
  -- Roles holding the reader would inherit its rights.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid = reader) THEN
    RAISE EXCEPTION 'verify: another role is a member of the reader';
  END IF;

  -- C4: who can reach the views owner. The authorized migration identity is named
  -- explicitly (SET resonances.migration_role = '<role>';). Without it, NO membership
  -- of the owner is acceptable. Any other member is refused, even SET-only, and so is
  -- any chain of roles leading to the owner. NOLOGIN does not prevent SET ROLE.
  authorized := NULLIF(pg_catalog.current_setting('resonances.migration_role', true), '');
  IF authorized IS NOT NULL THEN
    SELECT oid INTO authorized_oid FROM pg_catalog.pg_roles WHERE rolname = authorized;
    IF authorized_oid IS NULL THEN
      RAISE EXCEPTION 'verify: resonances.migration_role names no existing role';
    END IF;
  END IF;
  SELECT string_agg(
           x.rolname || ' (' || concat_ws(' ',
             CASE WHEN m.inherit_option THEN 'INHERIT' END,
             CASE WHEN m.set_option THEN 'SET' END,
             CASE WHEN m.admin_option THEN 'ADMIN' END) || ')', ', ')
    INTO offenders
  FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles x ON x.oid = m.member
  WHERE m.roleid = owner AND m.member IS DISTINCT FROM authorized_oid;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'verify: unauthorized member(s) of resonances_public_views_owner: % (authorized migration role: %)', offenders, COALESCE(authorized, 'none');
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid = owner AND (inherit_option OR admin_option)
  ) THEN
    RAISE EXCEPTION 'verify: a membership of the views owner can inherit or administer it';
  END IF;
  FOR r IN
    SELECT oid, rolname FROM pg_catalog.pg_roles
    WHERE NOT rolsuper AND oid <> owner AND oid IS DISTINCT FROM authorized_oid
  LOOP
    IF pg_catalog.pg_has_role(r.oid, owner, 'MEMBER')
       OR pg_catalog.pg_has_role(r.oid, owner, 'USAGE')
       OR pg_catalog.pg_has_role(r.oid, owner, 'SET') THEN
      RAISE EXCEPTION 'verify: role % can reach resonances_public_views_owner through a membership chain', r.rolname;
    END IF;
  END LOOP;

  -- 3. Relations: the reader may SELECT the two public views and has NOTHING else,
  --    anywhere (every non-system schema, columns and sequences included).
  FOR r IN
    SELECT c.oid, c.relkind, n.nspname || '.' || c.relname AS qname
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
  LOOP
    IF r.relkind = 'S' THEN
      IF pg_catalog.has_sequence_privilege(reader, r.oid, 'USAGE,SELECT,UPDATE') THEN
        RAISE EXCEPTION 'verify: the reader has a privilege on sequence %', r.qname;
      END IF;
    ELSIF r.qname = ANY (allowed_views) THEN
      IF NOT pg_catalog.has_table_privilege(reader, r.oid, 'SELECT')
         OR pg_catalog.has_table_privilege(reader, r.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR pg_catalog.has_any_column_privilege(reader, r.oid, 'INSERT,UPDATE,REFERENCES') THEN
        RAISE EXCEPTION 'verify: unexpected privileges of the reader on view %', r.qname;
      END IF;
    ELSE
      IF pg_catalog.has_table_privilege(reader, r.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR pg_catalog.has_any_column_privilege(reader, r.oid, 'SELECT,INSERT,UPDATE,REFERENCES') THEN
        RAISE EXCEPTION 'verify: the reader has a privilege on %', r.qname;
      END IF;
    END IF;
  END LOOP;

  -- 4. Schemas: USAGE only on public and public_read, CREATE nowhere (database included).
  FOR r IN
    SELECT n.oid, n.nspname FROM pg_catalog.pg_namespace n
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
  LOOP
    IF pg_catalog.has_schema_privilege(reader, r.oid, 'CREATE') THEN
      RAISE EXCEPTION 'verify: the reader can CREATE in schema %', r.nspname;
    END IF;
    IF pg_catalog.has_schema_privilege(reader, r.oid, 'USAGE') AND r.nspname NOT IN ('public', 'public_read') THEN
      RAISE EXCEPTION 'verify: the reader has USAGE on schema %', r.nspname;
    END IF;
  END LOOP;
  IF pg_catalog.has_database_privilege(reader, pg_catalog.current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'verify: the reader can CREATE in the database';
  END IF;

  -- 5. No user-defined function may be executable by the reader (B1 functions included).
  FOR r IN
    SELECT p.oid, n.nspname || '.' || p.proname AS qname
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
  LOOP
    IF pg_catalog.has_function_privilege(reader, r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'verify: the reader can execute %', r.qname;
    END IF;
  END LOOP;

  -- 6. The views: exact set, owner, security_barrier, not security_invoker, owner has no write rights.
  IF (SELECT count(*) FROM pg_catalog.pg_class WHERE relnamespace = 'public_read'::regnamespace) <> 2 THEN
    RAISE EXCEPTION 'verify: public_read must contain exactly the two public views';
  END IF;
  FOR r IN
    SELECT c.relname, c.relkind, c.relowner, COALESCE(c.reloptions, ARRAY[]::text[]) AS opts
    FROM pg_catalog.pg_class c WHERE c.relnamespace = 'public_read'::regnamespace
  LOOP
    IF r.relkind <> 'v' OR r.relowner <> owner
       OR NOT (r.opts @> ARRAY['security_barrier=true'])
       OR EXISTS (SELECT 1 FROM unnest(r.opts) o WHERE o ~ '^security_invoker=(true|on)$') THEN
      RAISE EXCEPTION 'verify: unexpected definition of view public_read.%', r.relname;
    END IF;
  END LOOP;
  -- C5: effective privileges of the views owner on every relation it does NOT own
  -- (direct, inherited, or through PUBLIC). Allowed and REQUIRED: column-level SELECT
  -- on exactly the source columns of the two views. Anything else is a violation.
  FOR v IN
    SELECT n.nspname, c.relname, c.relkind, c.oid AS reloid, a.attname, a.attnum
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND c.relowner <> owner
  LOOP
    IF v.relkind = 'S' THEN
      IF pg_catalog.has_sequence_privilege(owner, v.reloid, 'USAGE,SELECT,UPDATE') THEN
        RAISE EXCEPTION 'verify: the views owner has a privilege on sequence %.%', v.nspname, v.relname;
      END IF;
    ELSE
      IF pg_catalog.has_table_privilege(owner, v.reloid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR pg_catalog.has_any_column_privilege(owner, v.reloid, 'INSERT,UPDATE,REFERENCES') THEN
        RAISE EXCEPTION 'verify: the views owner has a write-type privilege on %.%', v.nspname, v.relname;
      END IF;
      IF v.attnum IS NOT NULL THEN
        allowed := v.nspname = 'public' AND (v.relname, v.attname) IN (VALUES
      ('publications','id'),('publications','locale'),('publications','slug'),('publications','title'),
      ('publications','status'),('publications','published_at'),('publications','hook'),
      ('publications','observation'),('publications','evocation'),('publications','reflection'),
      ('publications','open_question'),('publications','media_asset_id'),
      ('publication_themes','publication_id'),('publication_themes','theme_id'),
      ('themes','id'),('themes','slug'),('themes','name'),
      ('media_assets','id'),('media_assets','web_url'),('media_assets','thumbnail_url'),
      ('media_assets','alt_text'),('media_assets','caption'),('media_assets','author'),
      ('media_assets','source'),('media_assets','license'),('media_assets','width'),('media_assets','height')
    );
        IF NOT allowed AND pg_catalog.has_column_privilege(owner, v.reloid, v.attnum, 'SELECT') THEN
          RAISE EXCEPTION 'verify: the views owner has an unauthorized SELECT on %.%.% (direct, inherited or through PUBLIC)', v.nspname, v.relname, v.attname;
        END IF;
        IF allowed AND NOT pg_catalog.has_column_privilege(owner, v.reloid, v.attnum, 'SELECT') THEN
          RAISE EXCEPTION 'verify: the views owner lacks SELECT on %.%.% (needed by the public views)', v.nspname, v.relname, v.attname;
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- C6: TEMPORARY is NOT revoked by T2 (it is a database-wide default granted to PUBLIC
  -- and the database is shared). The effective permission is reported so that the
  -- operator knows: the reader may create session-local temporary objects, never
  -- permanent ones (CREATE was checked above), and still cannot read any source table.
  RAISE NOTICE 'verify: OK (reader can log in: %; effective TEMPORARY on this database: %, via PUBLIC: %)',
    (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE oid = reader),
    pg_catalog.has_database_privilege(reader, pg_catalog.current_database(), 'TEMPORARY')::text,
    EXISTS (
      SELECT 1 FROM pg_catalog.pg_database d, LATERAL pg_catalog.aclexplode(
        COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) a
      WHERE d.datname = pg_catalog.current_database() AND a.grantee = 0 AND a.privilege_type = 'TEMPORARY')::text;
END
$verify$;
