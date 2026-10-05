// Operator-only SQL protocol for two independent PostgreSQL sessions. Run after
// dual review in the new, empty RFID push project, before cron or enrollment.
// No provider request is made. The fixture is isolated and removed by cleanup.
import { randomUUID, createHash } from 'node:crypto';

export function buildConcurrencyProbe() {
  const token = randomUUID(), tag = 'rfid-push-probe-' + randomUUID();
  const id = createHash('sha256').update(tag).digest('hex');
  const hash = 'c'.repeat(64), old = tag + '-old', fresh = tag + '-fresh';
  const sub = JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/' + tag, keys: { p256dh: 'synthetic-no-send', auth: 'synthetic-no-send' } });
  const device = action => `select public.rfid_push_device('${action}','${id}','${hash}','${sub}'::jsonb);`;
  const ingest = (event, age) => `select public.rfid_push_ingest('${token}',jsonb_build_array(jsonb_build_object(
    'event_id','${event}','fingerprint','${hash}','name','RFID concurrency test','result','เข้างาน',
    'scan_time',to_char((now()-interval '${age}') at time zone 'Asia/Bangkok','YYYY-MM-DD HH24:MI:SS'),
    'received_at',now()-interval '${age}','day',to_char((now()-interval '${age}') at time zone 'Asia/Bangkok','YYYY-MM-DD'))));`;
  return {
    tag, id, token,
    setup: `do $$ begin
      if exists(select 1 from public.rfid_push_devices where enabled) or exists(select 1 from public.rfid_push_worker where lease_until>now()) then raise exception 'probe_requires_no_devices_or_worker'; end if;
      if not exists(select 1 from public.rfid_push_settings where (value->>'startedAt')::timestamptz<now()-interval '1 minute') then raise exception 'probe_started_too_recently'; end if;
    end $$;
    ${device('subscribe')}
    update public.rfid_push_devices set activated_at=now()-interval '1 hour' where device_id='${id}';
    select public.rfid_push_acquire('${token}') as acquired;`,
    hold: `begin; set local application_name='${tag}'; ${device('unsubscribe')} ${device('subscribe')} select pg_sleep(15); commit;`,
    observe: `select exists(select 1 from pg_stat_activity where application_name='${tag}' and wait_event='PgSleep') as holding;`,
    ingest: `begin; set local application_name='${tag}-ingest'; set local statement_timeout='25s'; ${ingest(old, '1 minute')} commit;`,
    observeBlocked: `select exists(select 1 from pg_stat_activity i join pg_stat_activity h on h.pid=any(pg_blocking_pids(i.pid))
      where i.application_name='${tag}-ingest' and i.wait_event_type='Lock' and h.application_name='${tag}') as overlapping_lock;`,
    verify: `select exists(select 1 from public.rfid_push_events where event_id='${old}') as event_stored,
      (select count(*)::int from public.rfid_push_deliveries where event_id='${old}' and device_id='${id}') as old_deliveries;`,
    fresh: `${ingest(fresh, '0 seconds')}
      do $$ begin if jsonb_array_length(public.rfid_push_claim('${token}',50))<>1 then raise exception 'fresh_claim_count_invalid'; end if; end $$;
      select public.rfid_push_begin_send('${token}','${fresh}','${id}') ? 'subscription' as authorized;`,
    cancel: `${device('unsubscribe')}
      select public.rfid_push_begin_send('${token}','${fresh}','${id}') ? 'subscription' as still_authorized;`,
    cleanup: `select public.rfid_push_release('${token}','');
      delete from public.rfid_push_devices where device_id='${id}' and token_hash='${hash}';
      delete from public.rfid_push_events where event_id in ('${old}','${fresh}');`
  };
}
