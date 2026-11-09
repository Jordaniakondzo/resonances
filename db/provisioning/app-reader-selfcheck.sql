-- Post-LOGIN self-check of the public reader (T2). Run it CONNECTED AS
-- resonances_app_reader, with the same connection settings the Web application
-- uses (APP_DATABASE_URL). It writes nothing: every forbidden statement is
-- expected to be refused and the whole block ends without committing changes.
--
--   psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/provisioning/app-reader-selfcheck.sql
--
-- It proves, from the reader's own session, what app-reader-verify.sql proves
-- from the catalogs: the real identity, no way to switch role, no access to the
-- source tables, no write, and a working read of the public views. It passes both
-- in a read-only session (the Web application's settings) and in a read-write one;
-- the final notice states which, and what that means for TEMPORARY.

DO $selfcheck$
DECLARE
  r record;
  leaked boolean;
  statement text;
  temp_granted boolean;
  read_only boolean;
  temp_outcome text;
BEGIN
  IF session_user <> 'resonances_app_reader' OR current_user <> 'resonances_app_reader' THEN
    RAISE EXCEPTION 'selfcheck: connected as % / % instead of resonances_app_reader', session_user, current_user;
  END IF;

  -- No role can be assumed. Success of a SET ROLE is a violation (and is reset at once).
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname <> 'resonances_app_reader' LOOP
    leaked := false;
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', r.rolname);
      EXECUTE 'RESET ROLE';
      leaked := true;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
    IF leaked THEN
      RAISE EXCEPTION 'selfcheck: SET ROLE % succeeded', r.rolname;
    END IF;
  END LOOP;

  -- The source tables and the private columns are closed; writes are refused.
  FOREACH statement IN ARRAY ARRAY[
    'SELECT count(*) FROM public.publications',
    'SELECT count(*) FROM public.themes',
    'SELECT count(*) FROM public.media_assets',
    'SELECT original_url FROM public.media_assets',
    'SELECT count(*) FROM public.reflections',
    'INSERT INTO public.publications (slug, status) VALUES (''selfcheck-x'', ''draft'')',
    'UPDATE public.publications SET status = ''published''',
    'DELETE FROM public.publications',
    'TRUNCATE public.publications',
    'CREATE TABLE public.selfcheck_x (id int)',
    'CREATE VIEW public_read.selfcheck_x AS SELECT 1'
  ] LOOP
    leaked := false;
    BEGIN
      EXECUTE statement;
      leaked := true;
    EXCEPTION WHEN insufficient_privilege OR read_only_sql_transaction THEN
      NULL;
    END;
    IF leaked THEN
      RAISE EXCEPTION 'selfcheck: statement was NOT refused: %', statement;
    END IF;
  END LOOP;

  -- The public views work (zero rows is fine on an empty database).
  PERFORM 1 FROM public_read.publications LIMIT 1;
  PERFORM 1 FROM public_read.publication_themes LIMIT 1;

  -- C6/C9: TEMPORARY is not revoked by T2 (database-wide default, shared database).
  -- Two different things are compared here:
  --   * the RIGHT, granted by PostgreSQL (has_database_privilege, usually through PUBLIC);
  --   * what the CURRENT transaction may do with it. A read-only transaction (the Web
  --     pool sets default_transaction_read_only=on) refuses every CREATE, temporary
  --     tables included, whatever the right says.
  -- Each observed outcome is checked against the condition that explains it:
  --   created                 -> right granted AND transaction read-write
  --   refused, read-only      -> transaction read-only (says nothing about the right)
  --   refused, no privilege   -> right not granted
  -- A temporary table never gives access to a source table, and permanent objects
  -- stay refused (checked above).
  temp_granted := has_database_privilege(current_user, current_database(), 'TEMPORARY');
  read_only := pg_catalog.current_setting('transaction_read_only')::boolean;
  BEGIN
    EXECUTE 'CREATE TEMPORARY TABLE selfcheck_tmp (id int)';
    EXECUTE 'DROP TABLE pg_temp.selfcheck_tmp';
    temp_outcome := 'created and dropped';
  EXCEPTION
    WHEN read_only_sql_transaction THEN
      temp_outcome := 'refused by the read-only transaction';
    WHEN insufficient_privilege THEN
      temp_outcome := 'refused for lack of TEMPORARY';
  END;
  IF (temp_outcome = 'created and dropped' AND (read_only OR NOT temp_granted))
     OR (temp_outcome = 'refused by the read-only transaction' AND NOT read_only)
     OR (temp_outcome = 'refused for lack of TEMPORARY' AND temp_granted) THEN
    RAISE EXCEPTION 'selfcheck: TEMPORARY is % in the catalog and the transaction is read-only: %, but temporary table creation was %',
      temp_granted, read_only, temp_outcome;
  END IF;

  RAISE NOTICE 'selfcheck: OK (effective TEMPORARY: %; read-only transaction: %; temporary table: %)',
    temp_granted::text, read_only::text, temp_outcome;
END
$selfcheck$;
