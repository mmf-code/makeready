-- Run only in the dedicated MakeReady project after setting these Vault secrets:
-- makeready_app_url: deployed HTTPS origin, makeready_executor_secret: EXECUTOR_SECRET.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
select cron.schedule('makeready-reconcile','* * * * *',$$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='makeready_app_url') || '/api/internal/reconcile',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='makeready_executor_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 240000
  );
$$);
