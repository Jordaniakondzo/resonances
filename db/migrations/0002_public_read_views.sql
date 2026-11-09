-- T2 public read boundary: secure views for the public application.
--
-- The public application no longer reads the editorial tables. It reads two
-- security_barrier views in the dedicated schema public_read. The views are
-- owned by a controlled NOLOGIN role (resonances_public_views_owner) that holds
-- column-level SELECT on the source tables; the reader role (resonances_app_reader)
-- holds SELECT on the two views and nothing on the tables. The visibility rule
-- (status = 'published' AND published_at IS NOT NULL AND published_at <= now())
-- lives inside the views, so no caller can choose the instant or forget the rule.
--
-- Prerequisites: both roles are created OUTSIDE this migration by
-- db/provisioning/app-reader.sql, and the migration identity may SET ROLE to the
-- views owner without inheriting it:
--   GRANT resonances_public_views_owner TO <migration_role> WITH INHERIT FALSE, SET TRUE;
-- Everything below runs in the single transaction of the migrator. The six
-- business tables and migrations 0000 and 0001 are not modified.

-- 1. Preflight: roles must exist and have the expected, minimal shape.
DO $preflight$
DECLARE
  owner_oid oid;
  reader_oid oid;
  migrator_oid oid;
  offenders text;
  r record;
  v record;
  allowed boolean;
BEGIN
  SELECT oid INTO owner_oid FROM pg_catalog.pg_roles WHERE rolname = 'resonances_public_views_owner';
  SELECT oid INTO reader_oid FROM pg_catalog.pg_roles WHERE rolname = 'resonances_app_reader';
  IF owner_oid IS NULL OR reader_oid IS NULL THEN
    RAISE EXCEPTION 'T2: roles resonances_public_views_owner and resonances_app_reader must be provisioned first (db/provisioning/app-reader.sql)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE oid IN (owner_oid, reader_oid)
      AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'T2: the views owner and the reader must not be superuser, CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid = owner_oid AND rolcanlogin) THEN
    RAISE EXCEPTION 'T2: the views owner must be NOLOGIN';
  END IF;

  -- C4: who can reach the views owner. Only the migration identity (current_user)
  -- may hold a membership, SET-only. Everything else is refused, even SET-only,
  -- and nothing is revoked here: a human inspects pg_auth_members and decides.
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles WHERE rolname = current_user;
  SELECT string_agg(
           x.rolname || ' (' || concat_ws(' ',
             CASE WHEN m.inherit_option THEN 'INHERIT' END,
             CASE WHEN m.set_option THEN 'SET' END,
             CASE WHEN m.admin_option THEN 'ADMIN' END) || ')', ', ')
    INTO offenders
  FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles x ON x.oid = m.member
  WHERE m.roleid = owner_oid AND m.member <> migrator_oid;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'T2: unauthorized member(s) of resonances_public_views_owner: %. Only the migration identity (%) may hold it, SET-only. Nothing was changed: inspect pg_auth_members, revoke deliberately, then rerun', offenders, current_user;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    WHERE m.roleid = owner_oid AND m.member = migrator_oid AND (m.inherit_option OR m.admin_option)
  ) THEN
    RAISE EXCEPTION 'T2: the migration identity (%) must hold resonances_public_views_owner SET-only (no INHERIT, no ADMIN OPTION)', current_user;
  END IF;
  -- Indirect paths: any other non-superuser role that is a member (through any chain),
  -- inherits or can SET ROLE to the owner. NOLOGIN does not prevent SET ROLE.
  FOR r IN
    SELECT oid, rolname FROM pg_catalog.pg_roles
    WHERE NOT rolsuper AND oid NOT IN (owner_oid, migrator_oid)
  LOOP
    IF pg_catalog.pg_has_role(r.oid, owner_oid, 'MEMBER')
       OR pg_catalog.pg_has_role(r.oid, owner_oid, 'USAGE')
       OR pg_catalog.pg_has_role(r.oid, owner_oid, 'SET') THEN
      RAISE EXCEPTION 'T2: role % can reach resonances_public_views_owner through a membership chain; nothing was changed', r.rolname;
    END IF;
  END LOOP;
  IF NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE oid = migrator_oid)
     AND pg_catalog.pg_has_role(migrator_oid, owner_oid, 'USAGE') THEN
    RAISE EXCEPTION 'T2: the migration identity inherits the views owner privileges; it must be SET-only';
  END IF;

  -- C5: effective privileges of the views owner on every relation it does NOT own.
  -- pg_catalog.has_*_privilege resolves direct grants, inherited roles and PUBLIC.
  -- Allowed: column-level SELECT on exactly the source columns of the two views.
  FOR v IN
    SELECT n.nspname, c.relname, c.relkind, c.oid AS reloid, a.attname, a.attnum
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND c.relowner <> owner_oid
  LOOP
    IF v.relkind = 'S' THEN
      IF pg_catalog.has_sequence_privilege(owner_oid, v.reloid, 'USAGE,SELECT,UPDATE') THEN
        RAISE EXCEPTION 'T2: the views owner has a privilege on sequence %.%; nothing was changed', v.nspname, v.relname;
      END IF;
    ELSE
      IF pg_catalog.has_table_privilege(owner_oid, v.reloid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR pg_catalog.has_any_column_privilege(owner_oid, v.reloid, 'INSERT,UPDATE,REFERENCES') THEN
        RAISE EXCEPTION 'T2: the views owner has a write-type privilege on %.%; nothing was changed', v.nspname, v.relname;
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
        IF NOT allowed AND pg_catalog.has_column_privilege(owner_oid, v.reloid, v.attnum, 'SELECT') THEN
          RAISE EXCEPTION 'T2: the views owner has an unauthorized SELECT on %.%.% (direct, inherited or through PUBLIC); nothing was changed', v.nspname, v.relname, v.attname;
        END IF;
        IF allowed AND FALSE AND NOT pg_catalog.has_column_privilege(owner_oid, v.reloid, v.attnum, 'SELECT') THEN
          RAISE EXCEPTION 'T2: the views owner lacks SELECT on %.%.% (needed by the public views)', v.nspname, v.relname, v.attname;
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- Neither role may be a member of another role: that would be an unplanned path to extra privileges.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member IN (owner_oid, reader_oid)) THEN
    RAISE EXCEPTION 'T2: the views owner and the reader must not be members of any role';
  END IF;
  IF pg_catalog.pg_has_role(reader_oid, owner_oid, 'MEMBER')
     OR pg_catalog.pg_has_role(reader_oid, owner_oid, 'USAGE')
     OR pg_catalog.pg_has_role(reader_oid, owner_oid, 'SET') THEN
    RAISE EXCEPTION 'T2: the reader must not be able to inherit or SET ROLE to the views owner';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    WHERE c.relowner IN (owner_oid, reader_oid)
      AND c.relnamespace NOT IN ('pg_catalog'::regnamespace, 'pg_toast'::regnamespace)
  ) THEN
    RAISE EXCEPTION 'T2: the views owner and the reader must not own any relation before the migration';
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, owner_oid, 'SET') THEN
    RAISE EXCEPTION 'T2: the migration role must be allowed to SET ROLE to resonances_public_views_owner';
  END IF;
  -- Default privileges of the owner would be applied to the objects created for it.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_default_acl d, LATERAL pg_catalog.aclexplode(d.defaclacl) a
    WHERE d.defaclrole = owner_oid AND a.grantee <> owner_oid
  ) THEN
    RAISE EXCEPTION 'T2: default privileges of the views owner grant rights to another role or PUBLIC; inspect pg_default_acl first';
  END IF;
END
$preflight$;
--> statement-breakpoint

-- 2. Remove every direct table privilege of the reader (for instance the
-- column grants of the first T2 iteration). Revoking on a table also revokes
-- its column privileges.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM resonances_app_reader;
--> statement-breakpoint

-- 3. The owner reads the sources column by column: no whole-table SELECT, no
-- write privilege, and none of original_url, original_filename, created_at,
-- updated_at, description or the reflection tables.
GRANT SELECT (
  id, locale, slug, title, status, published_at,
  hook, observation, evocation, reflection, open_question, media_asset_id
) ON public.publications TO resonances_public_views_owner;
--> statement-breakpoint
GRANT SELECT (publication_id, theme_id) ON public.publication_themes TO resonances_public_views_owner;
--> statement-breakpoint
GRANT SELECT (id, slug, name) ON public.themes TO resonances_public_views_owner;
--> statement-breakpoint
GRANT SELECT (
  id, web_url, thumbnail_url, alt_text, caption,
  author, source, license, width, height
) ON public.media_assets TO resonances_public_views_owner;
--> statement-breakpoint

-- 4. Schema and views, created by (and owned by) the dedicated owner.
-- CREATE SCHEMA is not idempotent on purpose: a pre-existing public_read must be inspected.
CREATE SCHEMA public_read AUTHORIZATION resonances_public_views_owner;
--> statement-breakpoint

SET LOCAL ROLE resonances_public_views_owner;
--> statement-breakpoint

DO $assert_role$
BEGIN
  IF current_user <> 'resonances_public_views_owner' THEN
    RAISE EXCEPTION 'T2: SET LOCAL ROLE did not take effect';
  END IF;
END
$assert_role$;
--> statement-breakpoint

REVOKE ALL ON SCHEMA public_read FROM PUBLIC;
--> statement-breakpoint

-- security_barrier: a function in a caller's WHERE clause can never run before
-- the visibility filter and see hidden rows. The views run with the owner's
-- privileges (security_invoker is deliberately NOT set); that is what lets the
-- reader read them without any access to the tables.
-- Time: now() is the database clock, fixed per transaction. No parameter can move it.
CREATE VIEW public_read.publications WITH (security_barrier = true) AS
SELECT
  p.id,
  p.locale,
  p.slug,
  p.title,
  p.hook,
  p.observation,
  p.evocation,
  p.reflection,
  p.open_question,
  p.published_at,
  m.web_url       AS image_web_url,
  m.thumbnail_url AS image_thumbnail_url,
  m.alt_text      AS image_alt_text,
  m.caption       AS image_caption,
  m.author        AS image_author,
  m.source        AS image_source,
  m.license       AS image_license,
  m.width         AS image_width,
  m.height        AS image_height
FROM public.publications AS p
-- Only Web variants are exposed: a media without a usable web_url yields no image columns at all.
LEFT JOIN public.media_assets AS m
  ON m.id = p.media_asset_id
 AND m.web_url IS NOT NULL
 AND btrim(m.web_url) <> ''
WHERE p.status = 'published'
  AND p.published_at IS NOT NULL
  AND p.published_at <= now()
  AND p.slug IS NOT NULL;
--> statement-breakpoint

-- Themes of visible publications only: the same visibility rule is applied to
-- the parent publication, so an association never outlives the publication's visibility.
CREATE VIEW public_read.publication_themes WITH (security_barrier = true) AS
SELECT
  pt.publication_id,
  t.slug AS theme_slug,
  t.name AS theme_name
FROM public.publication_themes AS pt
JOIN public.themes AS t ON t.id = pt.theme_id
JOIN public.publications AS p ON p.id = pt.publication_id
WHERE p.status = 'published'
  AND p.published_at IS NOT NULL
  AND p.published_at <= now()
  AND p.slug IS NOT NULL;
--> statement-breakpoint

COMMENT ON VIEW public_read.publications IS 'T2: public Publications. Visibility (published, dated, not in the future) is applied here, on the database clock.';
--> statement-breakpoint
COMMENT ON VIEW public_read.publication_themes IS 'T2: themes of publicly visible Publications.';
--> statement-breakpoint

GRANT USAGE ON SCHEMA public_read TO resonances_app_reader;
--> statement-breakpoint
GRANT SELECT ON public_read.publications TO resonances_app_reader;
--> statement-breakpoint
GRANT SELECT ON public_read.publication_themes TO resonances_app_reader;
--> statement-breakpoint

-- Back to the migration identity.
RESET ROLE;
--> statement-breakpoint

-- 5. Post-conditions: fail the whole migration if the effective result drifts.
DO $verify$
DECLARE
  owner_oid oid := 'resonances_public_views_owner'::regrole;
  reader_oid oid := 'resonances_app_reader'::regrole;
  migrator_oid oid;
  offenders text;
  r record;
  v record;
  t text;
  allowed boolean;
BEGIN
  IF current_user = 'resonances_public_views_owner' THEN
    RAISE EXCEPTION 'T2: RESET ROLE did not take effect';
  END IF;

  -- Exactly the two views, owned by the owner, security_barrier, not security_invoker.
  IF (SELECT count(*) FROM pg_catalog.pg_class WHERE relnamespace = 'public_read'::regnamespace) <> 2 THEN
    RAISE EXCEPTION 'T2: public_read must contain exactly the two public views';
  END IF;
  FOR v IN
    SELECT c.relname, c.relkind, c.relowner, c.reloptions
    FROM pg_catalog.pg_class c WHERE c.relnamespace = 'public_read'::regnamespace
  LOOP
    IF v.relkind <> 'v' OR v.relowner <> owner_oid
       OR NOT (COALESCE(v.reloptions, ARRAY[]::text[]) @> ARRAY['security_barrier=true'])
       OR EXISTS (SELECT 1 FROM unnest(COALESCE(v.reloptions, ARRAY[]::text[])) o WHERE o ~ '^security_invoker=(true|on)$') THEN
      RAISE EXCEPTION 'T2: unexpected definition for view public_read.%', v.relname;
    END IF;
  END LOOP;
  IF (SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname = 'public_read') <> owner_oid THEN
    RAISE EXCEPTION 'T2: public_read has the wrong owner';
  END IF;

  -- Reader: SELECT on the views, nothing else on them. Resolved through catalog
  -- OIDs: the migration identity has no USAGE on public_read, so a schema-qualified
  -- regclass literal would be refused.
  FOR v IN
    SELECT c.oid, c.relname FROM pg_catalog.pg_class c
    WHERE c.relnamespace = 'public_read'::regnamespace
  LOOP
    IF NOT pg_catalog.has_table_privilege(reader_oid, v.oid, 'SELECT') THEN
      RAISE EXCEPTION 'T2: the reader cannot SELECT from public_read.%', v.relname;
    END IF;
    IF pg_catalog.has_table_privilege(reader_oid, v.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'T2: the reader holds a write-type privilege on public_read.%', v.relname;
    END IF;
  END LOOP;

  -- Reader: no privilege of any kind on the editorial tables, columns included.
  FOREACH t IN ARRAY ARRAY[
    'public.publications', 'public.publication_themes', 'public.themes',
    'public.media_assets', 'public.reflections', 'public.reflection_themes'
  ] LOOP
    IF pg_catalog.has_table_privilege(reader_oid, t::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR pg_catalog.has_any_column_privilege(reader_oid, t::regclass, 'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'T2: the reader still has a privilege on %', t;
    END IF;
  END LOOP;

  -- C4: who can reach the views owner. Only the migration identity (current_user)
  -- may hold a membership, SET-only. Everything else is refused, even SET-only,
  -- and nothing is revoked here: a human inspects pg_auth_members and decides.
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles WHERE rolname = current_user;
  SELECT string_agg(
           x.rolname || ' (' || concat_ws(' ',
             CASE WHEN m.inherit_option THEN 'INHERIT' END,
             CASE WHEN m.set_option THEN 'SET' END,
             CASE WHEN m.admin_option THEN 'ADMIN' END) || ')', ', ')
    INTO offenders
  FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles x ON x.oid = m.member
  WHERE m.roleid = owner_oid AND m.member <> migrator_oid;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'T2: unauthorized member(s) of resonances_public_views_owner: %. Only the migration identity (%) may hold it, SET-only. Nothing was changed: inspect pg_auth_members, revoke deliberately, then rerun', offenders, current_user;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    WHERE m.roleid = owner_oid AND m.member = migrator_oid AND (m.inherit_option OR m.admin_option)
  ) THEN
    RAISE EXCEPTION 'T2: the migration identity (%) must hold resonances_public_views_owner SET-only (no INHERIT, no ADMIN OPTION)', current_user;
  END IF;
  -- Indirect paths: any other non-superuser role that is a member (through any chain),
  -- inherits or can SET ROLE to the owner. NOLOGIN does not prevent SET ROLE.
  FOR r IN
    SELECT oid, rolname FROM pg_catalog.pg_roles
    WHERE NOT rolsuper AND oid NOT IN (owner_oid, migrator_oid)
  LOOP
    IF pg_catalog.pg_has_role(r.oid, owner_oid, 'MEMBER')
       OR pg_catalog.pg_has_role(r.oid, owner_oid, 'USAGE')
       OR pg_catalog.pg_has_role(r.oid, owner_oid, 'SET') THEN
      RAISE EXCEPTION 'T2: role % can reach resonances_public_views_owner through a membership chain; nothing was changed', r.rolname;
    END IF;
  END LOOP;
  IF NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE oid = migrator_oid)
     AND pg_catalog.pg_has_role(migrator_oid, owner_oid, 'USAGE') THEN
    RAISE EXCEPTION 'T2: the migration identity inherits the views owner privileges; it must be SET-only';
  END IF;

  -- C5: effective privileges of the views owner on every relation it does NOT own.
  -- pg_catalog.has_*_privilege resolves direct grants, inherited roles and PUBLIC.
  -- Allowed: column-level SELECT on exactly the source columns of the two views.
  FOR v IN
    SELECT n.nspname, c.relname, c.relkind, c.oid AS reloid, a.attname, a.attnum
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND c.relowner <> owner_oid
  LOOP
    IF v.relkind = 'S' THEN
      IF pg_catalog.has_sequence_privilege(owner_oid, v.reloid, 'USAGE,SELECT,UPDATE') THEN
        RAISE EXCEPTION 'T2: the views owner has a privilege on sequence %.%; nothing was changed', v.nspname, v.relname;
      END IF;
    ELSE
      IF pg_catalog.has_table_privilege(owner_oid, v.reloid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR pg_catalog.has_any_column_privilege(owner_oid, v.reloid, 'INSERT,UPDATE,REFERENCES') THEN
        RAISE EXCEPTION 'T2: the views owner has a write-type privilege on %.%; nothing was changed', v.nspname, v.relname;
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
        IF NOT allowed AND pg_catalog.has_column_privilege(owner_oid, v.reloid, v.attnum, 'SELECT') THEN
          RAISE EXCEPTION 'T2: the views owner has an unauthorized SELECT on %.%.% (direct, inherited or through PUBLIC); nothing was changed', v.nspname, v.relname, v.attname;
        END IF;
        IF allowed AND TRUE AND NOT pg_catalog.has_column_privilege(owner_oid, v.reloid, v.attnum, 'SELECT') THEN
          RAISE EXCEPTION 'T2: the views owner lacks SELECT on %.%.% (needed by the public views)', v.nspname, v.relname, v.attname;
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- The schema: reader may use it, nobody else may create in it.
  IF NOT pg_catalog.has_schema_privilege(reader_oid, 'public_read', 'USAGE')
     OR pg_catalog.has_schema_privilege(reader_oid, 'public_read', 'CREATE') THEN
    RAISE EXCEPTION 'T2: unexpected reader privileges on schema public_read';
  END IF;

  -- Default privileges of the owner are still only its own.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_default_acl d, LATERAL pg_catalog.aclexplode(d.defaclacl) a
    WHERE d.defaclrole = owner_oid AND a.grantee <> owner_oid
  ) THEN
    RAISE EXCEPTION 'T2: default privileges of the views owner grant rights to another role or PUBLIC';
  END IF;
END
$verify$;
