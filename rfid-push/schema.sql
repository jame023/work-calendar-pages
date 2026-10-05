-- Only the separate RFID push project. No attendance tables or other applications.
create table public.rfid_push_settings (id boolean primary key default true check (id), value jsonb not null);
create table public.rfid_push_worker (id boolean primary key default true check (id), token uuid, lease_until timestamptz, last_poll timestamptz, last_error text, budget_month date, sends integer not null default 0);
insert into public.rfid_push_worker (id) values (true);
create table public.rfid_push_devices (
  device_id text primary key check (device_id ~ '^[a-f0-9]{64}$'), token_hash text not null check (token_hash ~ '^[a-f0-9]{64}$'),
  subscription jsonb not null, enabled boolean not null default true, activated_at timestamptz not null default now(), updated_at timestamptz not null default now(), last_test timestamptz
);
create table public.rfid_push_events (
  event_id text primary key check (length(event_id) between 1 and 256), fingerprint text not null,
  name text not null, result text not null check (result in ('เข้างาน','เลิกงาน')), scan_time text not null, received_at timestamptz not null, day date not null
);
create table public.rfid_push_deliveries (
  event_id text not null references public.rfid_push_events on delete cascade,
  device_id text not null references public.rfid_push_devices on delete cascade,
  state text not null default 'pending' check (state in ('pending','sending','sent','expired')),
  token uuid, lease_until timestamptz, next_attempt timestamptz not null default now(), attempts integer not null default 0, provider_status integer,
  primary key (event_id, device_id)
);
create index rfid_push_due on public.rfid_push_deliveries (next_attempt) where state in ('pending','sending');
alter table public.rfid_push_settings enable row level security;
alter table public.rfid_push_worker enable row level security;
alter table public.rfid_push_devices enable row level security;
alter table public.rfid_push_events enable row level security;
alter table public.rfid_push_deliveries enable row level security;
revoke all on public.rfid_push_settings, public.rfid_push_worker, public.rfid_push_devices, public.rfid_push_events, public.rfid_push_deliveries from public, anon, authenticated;
grant all on public.rfid_push_settings, public.rfid_push_worker, public.rfid_push_devices, public.rfid_push_events, public.rfid_push_deliveries to service_role;

create function public.rfid_push_device(p_action text, p_id text, p_token_hash text, p_subscription jsonb default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare d public.rfid_push_devices%rowtype;
begin
  if p_action not in ('subscribe','unsubscribe','status','test') then raise exception 'action_invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(873144);
  -- Match ingestion's worker-before-device order when reserving test capacity.
  if p_action = 'test' then
    perform 1 from public.rfid_push_worker where id for update;
  end if;
  select * into d from public.rfid_push_devices where device_id = p_id for update;
  if found and d.token_hash <> p_token_hash then raise exception using errcode = '42501', message = 'device_token_invalid'; end if;
  if p_action = 'subscribe' then
    if (d.device_id is null or not d.enabled) and (select count(*) from public.rfid_push_devices where enabled) >= 200 then raise exception 'device_limit'; end if;
    if d.device_id is null then
      insert into public.rfid_push_devices (device_id, token_hash, subscription) values (p_id, p_token_hash, p_subscription);
    else
      if not d.enabled or d.subscription is distinct from p_subscription then
        update public.rfid_push_deliveries set state='expired',token=null,lease_until=null
          where device_id=p_id and state in ('pending','sending');
      end if;
      update public.rfid_push_devices set subscription = p_subscription, enabled = true,
        activated_at = case when enabled and subscription = p_subscription then activated_at else now() end, updated_at = now() where device_id = p_id;
    end if;
    return jsonb_build_object('enabled',true);
  elsif p_action = 'unsubscribe' then
    update public.rfid_push_deliveries set state='expired',token=null,lease_until=null
      where device_id=p_id and state in ('pending','sending');
    update public.rfid_push_devices set enabled = false, updated_at = now() where device_id = p_id;
    return jsonb_build_object('enabled',false);
  elsif p_action = 'test' then
    if d.device_id is null or not d.enabled or d.last_test > now() - interval '1 minute' then return '{}'::jsonb; end if;
    update public.rfid_push_worker
      set sends = case when budget_month is distinct from date_trunc('month',now())::date then 1 else sends + 1 end,
        budget_month = date_trunc('month',now())::date
      where id and (budget_month is distinct from date_trunc('month',now())::date or sends < 100000);
    if not found then return '{}'::jsonb; end if;
    update public.rfid_push_devices set last_test = now() where device_id = p_id;
    return jsonb_build_object('subscription', d.subscription);
  end if;
  return jsonb_build_object('enabled',coalesce(d.enabled,false));
end $$;

create function public.rfid_push_acquire(p_token uuid) returns boolean
language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (select 1 from public.rfid_push_devices where enabled) then return false; end if;
  update public.rfid_push_worker set token = p_token, lease_until = now() + interval '120 seconds'
  where id and (lease_until is null or lease_until < now());
  return found;
end $$;

create function public.rfid_push_ingest(p_token uuid, p_events jsonb) returns integer
language plpgsql security invoker set search_path = '' as $$
declare e jsonb; d public.rfid_push_devices%rowtype; stored text; added integer = 0;
begin
  perform 1 from public.rfid_push_worker where id and token = p_token and lease_until > now() for update;
  if not found then raise exception 'lease_lost'; end if;
  for e in select value from jsonb_array_elements(p_events) loop
    select fingerprint into stored from public.rfid_push_events where event_id = e->>'event_id';
    if found and stored <> e->>'fingerprint' then raise exception 'event_identity_conflict'; end if;
    insert into public.rfid_push_events (event_id,fingerprint,name,result,scan_time,received_at,day)
      values (e->>'event_id',e->>'fingerprint',e->>'name',e->>'result',e->>'scan_time',(e->>'received_at')::timestamptz,(e->>'day')::date) on conflict (event_id) do nothing;
    -- FOR UPDATE returns current enrollment values after waiting on a concurrent
    -- update. Evaluate eligibility only after acquiring that device's lock.
    for d in select * from public.rfid_push_devices order by device_id for update loop
      if d.enabled and d.activated_at < (e->>'received_at')::timestamptz + interval '1 second'
        and (e->>'received_at')::timestamptz >= ((select value from public.rfid_push_settings where id)->>'startedAt')::timestamptz
        and (e->>'received_at')::timestamptz > now() - interval '1 day' then
        insert into public.rfid_push_deliveries (event_id,device_id) values (e->>'event_id',d.device_id) on conflict do nothing;
      end if;
    end loop;
    added = added + 1;
  end loop;
  update public.rfid_push_worker set last_poll = now(), last_error = '' where id;
  delete from public.rfid_push_events where received_at < now() - interval '3 days';
  delete from public.rfid_push_devices where not enabled and updated_at < now() - interval '7 days';
  return added;
end $$;

create function public.rfid_push_claim(p_token uuid, p_limit integer) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare result jsonb; slots integer; claimed integer;
begin
  perform 1 from public.rfid_push_worker where id and token = p_token and lease_until > now() for update;
  if not found then raise exception 'lease_lost'; end if;
  update public.rfid_push_worker set sends = 0, budget_month = date_trunc('month',now())::date where id and budget_month is distinct from date_trunc('month',now())::date;
  select least(greatest(p_limit,0),50,greatest(100000-sends,0)) into slots from public.rfid_push_worker where id;
  update public.rfid_push_deliveries q set state = 'expired' from public.rfid_push_events e where q.event_id = e.event_id and q.state in ('pending','sending') and e.received_at < now() - interval '1 day';
  with due as (
    select q.event_id,q.device_id from public.rfid_push_deliveries q join public.rfid_push_devices d using (device_id)
    where d.enabled and q.next_attempt <= now() and (q.state = 'pending' or (q.state = 'sending' and q.lease_until < now()))
    order by q.next_attempt,q.event_id limit slots for update of q skip locked
  ), taken as (
    update public.rfid_push_deliveries q set state = 'sending',token = p_token,lease_until = now() + interval '120 seconds',attempts = attempts + 1
    from due where q.event_id = due.event_id and q.device_id = due.device_id returning q.*
  ) select coalesce(jsonb_agg(jsonb_build_object('event_id',t.event_id,'device_id',t.device_id,'attempts',t.attempts,
      'subscription',d.subscription,'name',e.name,'result',e.result,'day',e.day,'scan_time',e.scan_time)), '[]'::jsonb), count(*)
    into result,claimed from taken t join public.rfid_push_devices d using(device_id) join public.rfid_push_events e using(event_id);
  update public.rfid_push_worker set sends = sends + claimed where id;
  return result;
end $$;

create function public.rfid_push_begin_send(p_token uuid, p_event_id text, p_device_id text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare d public.rfid_push_devices%rowtype;
begin
  select * into d from public.rfid_push_devices where device_id=p_device_id for update;
  if not found or not d.enabled then return '{}'::jsonb; end if;
  perform 1 from public.rfid_push_deliveries where event_id=p_event_id and device_id=p_device_id
    and state='sending' and token=p_token and lease_until > now() for update;
  if not found then return '{}'::jsonb; end if;
  if not exists (select 1 from public.rfid_push_worker where id and token=p_token and lease_until > now()) then return '{}'::jsonb; end if;
  return jsonb_build_object('subscription',d.subscription);
end $$;

create function public.rfid_push_finish(p_token uuid, p_event_id text, p_device_id text, p_state text, p_next timestamptz, p_status integer, p_deactivate boolean) returns boolean
language plpgsql security invoker set search_path = '' as $$
begin
  -- Keep the same device-before-delivery lock order as enrollment cancellation.
  perform 1 from public.rfid_push_devices where device_id=p_device_id for update;
  update public.rfid_push_deliveries set state=p_state,next_attempt=p_next,provider_status=p_status,token=null,lease_until=null
    where event_id=p_event_id and device_id=p_device_id and state='sending' and token=p_token;
  if not found then return false; end if;
  if p_deactivate then
    update public.rfid_push_devices set enabled=false,updated_at=now() where device_id=p_device_id;
    update public.rfid_push_deliveries set state='expired',token=null,lease_until=null
      where device_id=p_device_id and state in ('pending','sending');
  end if;
  return true;
end $$;

create function public.rfid_push_release(p_token uuid, p_error text) returns boolean
language plpgsql security invoker set search_path = '' as $$
begin
  update public.rfid_push_worker set token=null,lease_until=null,last_error=left(p_error,200) where id and token=p_token;
  return found;
end $$;

revoke all on function public.rfid_push_device(text,text,text,jsonb), public.rfid_push_acquire(uuid), public.rfid_push_ingest(uuid,jsonb), public.rfid_push_claim(uuid,integer), public.rfid_push_begin_send(uuid,text,text), public.rfid_push_finish(uuid,text,text,text,timestamptz,integer,boolean), public.rfid_push_release(uuid,text) from public,anon,authenticated;
grant execute on function public.rfid_push_device(text,text,text,jsonb), public.rfid_push_acquire(uuid), public.rfid_push_ingest(uuid,jsonb), public.rfid_push_claim(uuid,integer), public.rfid_push_begin_send(uuid,text,text), public.rfid_push_finish(uuid,text,text,text,timestamptz,integer,boolean), public.rfid_push_release(uuid,text) to service_role;
