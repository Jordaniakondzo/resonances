-- ADR-B1 role provisioning. Run by a database administrator BEFORE applying
-- migration 0001_adr_b1_privileged_locking, with a role allowed to create
-- roles. This file is NOT a Drizzle migration: roles are cluster-wide objects
-- and their creation needs privileges the migration identity should not hold.
--
-- It is idempotent, sets no password and grants no table privilege.
--
--   resonances_b1_owner : owner of the d03_priv schema and its three SECURITY
--                         DEFINER functions. Nobody logs in as this role.
--   resonances_importer : identity used by the private D03 importer. It is
--                         created NOLOGIN; the operator decides how it
--                         authenticates (LOGIN, password or other mechanism)
--                         outside of version control.
--
-- The migration identity must additionally be allowed to SET ROLE to the
-- owner (without inheriting its privileges). The administrator grants that
-- once per migration identity, for example:
--   GRANT resonances_b1_owner TO <migration_role> WITH INHERIT FALSE, SET TRUE;
-- Nothing in this file may make resonances_importer a member of the owner.

DO $provision$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'resonances_b1_owner') THEN
    CREATE ROLE resonances_b1_owner NOLOGIN;
  END IF;
  -- Re-assert the attributes on every run so that drift is corrected.
  ALTER ROLE resonances_b1_owner
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'resonances_importer') THEN
    CREATE ROLE resonances_importer NOLOGIN;
  END IF;
  -- LOGIN is deliberately left untouched for an existing importer role.
  ALTER ROLE resonances_importer
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
END
$provision$;
