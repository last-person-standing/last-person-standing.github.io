-- =====================================================================
-- Last Person Standing - Stage 5: run the chase-email check every hour
-- Run AFTER deploying the chase-emails function (see guides/stage-5-setup.md).
--
-- Paste this into the SQL Editor, replace the TWO values marked <<< in the
-- editor (not in VS Code, because this file goes to GitHub), then Run.
-- Safe to run again, e.g. to change the secret.
-- =====================================================================

-- 1. Turn on the scheduler and web-request extensions
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;

-- 2. Store your project URL and the cron secret in Supabase's encrypted Vault
do $$
declare
  v_url    text := 'https://YOUR-PROJECT-REF.supabase.co';   -- <<< your Project URL
  v_secret text := 'PASTE-THE-SAME-CRON_SECRET-HERE';         -- <<< same value as the CRON_SECRET function secret
begin
  -- Keep just https://xxxx.supabase.co, even if /rest/v1 or similar was copied with it
  v_url := regexp_replace(trim(v_url), '^(https://[^/]+).*$', '\1');
  v_secret := trim(v_secret);
  if v_url like '%YOUR-PROJECT-REF%' or v_secret like 'PASTE-%' then
    raise exception 'Replace the two values marked <<< first.';
  end if;

  if exists (select 1 from vault.secrets where name = 'project_url') then
    perform vault.update_secret((select id from vault.secrets where name = 'project_url'), v_url);
  else
    perform vault.create_secret(v_url, 'project_url');
  end if;

  if exists (select 1 from vault.secrets where name = 'chase_cron_secret') then
    perform vault.update_secret((select id from vault.secrets where name = 'chase_cron_secret'), v_secret);
  else
    perform vault.create_secret(v_secret, 'chase_cron_secret');
  end if;
end $$;

-- 3. Every hour, on the hour, ask the function to check. It only sends at the
--    days/times chosen on the host screen (UK time), so running hourly is fine.
--    (Scheduling again with the same name replaces the old schedule.)
select cron.schedule(
  'chase-emails',
  '0 * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/chase-emails',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'chase_cron_secret')),
    body    := '{"mode":"cron"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- ---------------------------------------------------------------------
-- Handy checks (run one at a time):
-- See the schedule:            select * from cron.job;
-- See the last few runs:       select status, start_time, return_message from cron.job_run_details order by start_time desc limit 5;
-- See the function's replies:  select status_code, content from net._http_response order by created desc limit 5;
-- Stop the schedule entirely:  select cron.unschedule('chase-emails');
-- ---------------------------------------------------------------------
