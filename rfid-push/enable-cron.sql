-- Run only in the reviewed RFID push project after private settings are installed.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
select cron.schedule('rfid-push-poll','30 seconds',$job$
  select net.http_post(
    url := value->>'functionUrl' || '/poll',
    headers := jsonb_build_object('Content-Type','application/json','apikey',value->>'anonKey','Authorization','Bearer ' || (value->>'anonKey'),'x-rfid-cron-token',value->>'cronToken'),
    body := '{}'::jsonb, timeout_milliseconds := 110000
  ) from public.rfid_push_settings where id;
$job$);
select cron.schedule('rfid-push-log-cleanup','15 * * * *',$job$
  delete from public.rfid_push_events where received_at < now() - interval '3 days';
  delete from public.rfid_push_devices where not enabled and updated_at < now() - interval '7 days';
  delete from cron.job_run_details where jobid in
    (select jobid from cron.job where jobname in ('rfid-push-poll','rfid-push-log-cleanup'))
    and end_time < now() - interval '1 day';
$job$);
