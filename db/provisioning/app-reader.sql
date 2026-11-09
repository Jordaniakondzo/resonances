-- Public read roles for the Web application (T2). Run by a database
-- administrator BEFORE migration 0002_public_read_views, with a role allowed to
-- create roles. This file is NOT a Drizzle migration: roles are cluster-wide
-- objects.
--
--   resonances_public_views_owner : owns the public_read schema and its views.
--                                   NOLOGIN, nobody logs in as this role.
--   resonances_app_reader         : identity of the Web application. Created
--                                   NOLOGIN; the operator enables LOGIN and sets
--                                   the credential outside of version control,
--                                   then runs db/provisioning/app-reader-verify.sql
--                                   and app-reader-selfcheck.sql (see
--                                   docs/operations/PUBLIC-READER-PROVISIONING.md).
--
-- The migration identity must be allowed to SET ROLE to the views owner (without
-- inheriting its privileges). It is the ONLY role that may ever hold the owner, and
-- the recommended practice is to grant it for the migration only:
--   GRANT resonances_public_views_owner TO <migration_role> WITH INHERIT FALSE, SET TRUE;
--   ... run the migration ...
--   REVOKE resonances_public_views_owner FROM <migration_role>;
-- While the grant exists, name the identity before running this file or the
-- verification: SET resonances.migration_role = '<migration_role>';
--
-- Safe to re-run ONLY while both roles are in the expected state. This file
-- creates missing roles and never alters an existing one: a role found in an
-- unexpected state makes it fail, and a human decides what to do.

DO $provision$
DECLARE
  role_name text;
  r pg_catalog.pg_roles%ROWTYPE;
  r2 record;
  authorized text;
  authorized_oid oid;
  offenders text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['resonances_public_views_owner', 'resonances_app_reader'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
        role_name);
    END IF;

    SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = role_name;
    IF r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls THEN
      RAISE EXCEPTION 'T2 provisioning: existing role % has privileged attributes; inspect it, nothing was changed', role_name;
    END IF;
    -- Any membership held BY the role is a path to privileges nobody planned.
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = r.oid) THEN
      RAISE EXCEPTION 'T2 provisioning: role % is a member of another role; inspect pg_auth_members, nothing was changed', role_name;
    END IF;
  END LOOP;

  -- The owner is never a login identity.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'resonances_public_views_owner' AND rolcanlogin) THEN
    RAISE EXCEPTION 'T2 provisioning: resonances_public_views_owner must be NOLOGIN, nothing was changed';
  END IF;
  -- Memberships OF the reader would let other roles inherit its rights.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    WHERE m.roleid = 'resonances_app_reader'::regrole
  ) THEN
    RAISE EXCEPTION 'T2 provisioning: another role is a member of resonances_app_reader, nothing was changed';
  END IF;

  -- C4: who can reach the views owner. The authorized migration identity is named
  -- explicitly, before running this file:
  --   SET resonances.migration_role = '<migration_role>';
  -- Without it, NO membership of the owner is acceptable (first installation, or
  -- the recommended "grant, migrate, revoke" practice). Even a SET-only member that
  -- is not the named identity is refused, and so is any chain of roles leading to
  -- the owner. Nothing is ever revoked here: the operator decides.
  authorized := NULLIF(pg_catalog.current_setting('resonances.migration_role', true), '');
  IF authorized IS NOT NULL THEN
    SELECT oid INTO authorized_oid FROM pg_catalog.pg_roles WHERE rolname = authorized;
    IF authorized_oid IS NULL THEN
      RAISE EXCEPTION 'T2 provisioning: resonances.migration_role names no existing role, nothing was changed';
    END IF;
  END IF;
  SELECT string_agg(
           x.rolname || ' (' || concat_ws(' ',
             CASE WHEN m.inherit_option THEN 'INHERIT' END,
             CASE WHEN m.set_option THEN 'SET' END,
             CASE WHEN m.admin_option THEN 'ADMIN' END) || ')', ', ')
    INTO offenders
  FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles x ON x.oid = m.member
  WHERE m.roleid = 'resonances_public_views_owner'::regrole
    AND m.member IS DISTINCT FROM authorized_oid;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'T2 provisioning: unauthorized member(s) of resonances_public_views_owner: % (authorized migration role: %). Nothing was changed: inspect pg_auth_members and revoke deliberately', offenders, COALESCE(authorized, 'none');
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    WHERE m.roleid = 'resonances_public_views_owner'::regrole
      AND (m.inherit_option OR m.admin_option)
  ) THEN
    RAISE EXCEPTION 'T2 provisioning: the authorized migration role must hold resonances_public_views_owner SET-only, nothing was changed';
  END IF;
  FOR r2 IN
    SELECT oid, rolname FROM pg_catalog.pg_roles
    WHERE NOT rolsuper
      AND oid <> 'resonances_public_views_owner'::regrole
      AND oid IS DISTINCT FROM authorized_oid
  LOOP
    IF pg_catalog.pg_has_role(r2.oid, 'resonances_public_views_owner'::regrole, 'MEMBER')
       OR pg_catalog.pg_has_role(r2.oid, 'resonances_public_views_owner'::regrole, 'USAGE')
       OR pg_catalog.pg_has_role(r2.oid, 'resonances_public_views_owner'::regrole, 'SET') THEN
      RAISE EXCEPTION 'T2 provisioning: role % can reach resonances_public_views_owner through a membership chain, nothing was changed', r2.rolname;
    END IF;
  END LOOP;
END
$provision$;
