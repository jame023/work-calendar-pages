import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createECDH, randomBytes, hkdfSync, createDecipheriv, createPublicKey, verify } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import webpush from 'web-push';
import { sha256, bangkokDay, sourceDates, parseSourceTime, readEvents, validateSubscription, deliveryOutcome, attendancePayload, runPoll } from '../functions/rfid-push/core.js';
import { createHandler } from '../functions/rfid-push/server.js';
import { createStore } from '../functions/rfid-push/store.js';

const origin = 'https://jame023.github.io';
const vapid = webpush.generateVAPIDKeys();
const settings = { origin, sourceUrl: 'https://script.google.com/macros/s/test/exec', subject: origin,
  vapidPublicKey: vapid.publicKey, vapidPrivateKey: vapid.privateKey, cronToken: 'test-cron-capability', startedAt: new Date(Date.now()-86400000).toISOString() };
function device(suffix = 'one') {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  return { ecdh, auth: randomBytes(16), subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/' + suffix, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: '' } } };
}
const phone = device(); phone.subscription.keys.auth = phone.auth.toString('base64url');
const token = randomBytes(32).toString('base64url');
const stamp = date => new Date(date.getTime()+7*3600000).toISOString().slice(0,19).replace('T',' ');
function row(id = 'RFID-event-one', overrides = {}) {
  return { eventId: id, eventHash: 'a'.repeat(64), seq: '1', name: 'คนทดสอบ', result: 'เข้างาน', nodeId: 'RFID', chainValid: true,
    scanTime: stamp(new Date()), serverReceivedTime: stamp(new Date()), ...overrides };
}
function source(rows, day = bangkokDay(new Date())) { return { ok: true, timezone: 'Asia/Bangkok', filters: { date: day, result: 'all' }, chain: { ok: true }, totals: { events: rows.length }, rows }; }

test('Source validation and RFC Web Push interoperability', async t => {
  await t.test('Bangkok boundary includes both scan days', () => { const now = new Date('2026-10-02T17:00:00Z'); assert.equal(bangkokDay(now),'2026-10-03'); assert.deepEqual(sourceDates(now),['2026-10-03','2026-10-02']); });
  await t.test('Invalid dates cannot roll into another day', () => { assert.throws(()=>parseSourceTime('2026-02-30 12:00:00')); assert.throws(()=>parseSourceTime('2026-10-03 25:00:00')); assert.equal(parseSourceTime('2026-10-03 07:57:15').toISOString(),'2026-10-03T00:57:15.000Z'); });
  await t.test('Only actual check-in/out, exact names, no UID in notification', () => {
    const rows = [row('1',{name:' คนทดสอบ '}), row('2',{result:'เลิกงาน'}), row('3',{result:'ซ้ำ'}), row('4',{result:'ไม่พบชื่อ',name:'ยังไม่มีชื่อ'}),row('5',{unknown:true})];
    const events=readEvents(source(rows),bangkokDay(new Date()),new Date()); assert.equal(events.length,2); assert.equal(events[0].name,' คนทดสอบ ');
    assert(!JSON.stringify(attendancePayload(events[0])).includes('uid')); assert(attendancePayload(events[1]).title.includes('เลิกงาน'));
  });
  await t.test('Same SEQ with different full Event IDs remains two events', () => { assert.equal(readEvents(source([row('first'),row('second')]),bangkokDay(new Date()),new Date()).length,2); });
  await t.test('Invalid chain, incomplete pages, wrong source date rejected', () => { const s=source([row()]); assert.throws(()=>readEvents({...s,chain:{ok:false}},s.filters.date,new Date())); assert.throws(()=>readEvents({...s,totals:{events:2}},s.filters.date,new Date())); assert.throws(()=>readEvents(s,'2026-01-01',new Date())); });
  await t.test('Provider whitelist and real P-256 validation prevent arbitrary outbound requests', async () => {
    assert.deepEqual(await validateSubscription(phone.subscription),phone.subscription);
    for(const endpoint of ['https://127.0.0.1/x','http://fcm.googleapis.com/x','https://fcm.googleapis.com.evil.example/x','https://fcm.googleapis.com:444/x','https://a@fcm.googleapis.com/x']) await assert.rejects(validateSubscription({...phone.subscription,endpoint}));
    await assert.rejects(validateSubscription({...phone.subscription,keys:{...phone.subscription.keys,p256dh:Buffer.concat([Buffer.from([4]),Buffer.alloc(64)]).toString('base64url')}}));
  });
  await t.test('Retry/expiry outcomes reflect provider response', () => { const now=new Date(); assert.equal(deliveryOutcome(201,1,now).state,'sent'); assert.equal(deliveryOutcome(503,1,now).state,'pending'); assert.equal(deliveryOutcome(0,1,now).state,'pending'); assert.equal(deliveryOutcome(429,1,now).state,'pending'); assert.equal(deliveryOutcome(410,1,now).deactivate,true); assert.equal(deliveryOutcome(403,1,now).state,'expired'); });
  await t.test('Real library encrypts AES128GCM and signs VAPID; independently decrypt/verify', () => {
    const payload = JSON.stringify({name:'คนทดสอบ',result:'เลิกงาน',time:'16:15:55'});
    const details=webpush.generateRequestDetails(phone.subscription,payload,{vapidDetails:{subject:origin,publicKey:vapid.publicKey,privateKey:vapid.privateKey},contentEncoding:'aes128gcm'});
    assert.equal(details.headers['Content-Encoding'],'aes128gcm');
    const body=details.body; const salt=body.subarray(0,16); const length=body[20]; const sender=body.subarray(21,21+length); const encrypted=body.subarray(21+length);
    const shared=phone.ecdh.computeSecret(sender);
    const info=Buffer.concat([Buffer.from('WebPush: info\0'),phone.ecdh.getPublicKey(),sender]);
    const ikm=Buffer.from(hkdfSync('sha256',shared,phone.auth,info,32));
    const key=Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16));
    const nonce=Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12));
    const decrypt=createDecipheriv('aes-128-gcm',key,nonce); decrypt.setAuthTag(encrypted.subarray(-16));
    const clear=Buffer.concat([decrypt.update(encrypted.subarray(0,-16)),decrypt.final()]); assert.equal(clear.at(-1),2); assert.equal(clear.subarray(0,-1).toString(),payload);
    const jwt=details.headers.Authorization.match(/t=([^,]+)/)[1]; const [h,p,s]=jwt.split('.');
    const publicBytes=Buffer.from(vapid.publicKey,'base64url');
    const publicKey=createPublicKey({format:'jwk',key:{kty:'EC',crv:'P-256',x:publicBytes.subarray(1,33).toString('base64url'),y:publicBytes.subarray(33).toString('base64url')}});
    assert(verify('sha256',Buffer.from(h+'.'+p),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(s,'base64url')));
    assert.equal(JSON.parse(Buffer.from(p,'base64url')).aud,'https://fcm.googleapis.com');
  });
});

test('Actual PostgreSQL schema, transactional queue, server routes, and failure recovery', async t => {
  const db=new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await db.exec(await fs.readFile(new URL('../schema.sql',import.meta.url),'utf8'));
  await db.query('insert into public.rfid_push_settings(value) values ($1)',[settings]);
  const call=async(name,params)=>{const args=Object.values(params); const sql='select public.rfid_push_'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') as value'; return (await db.query(sql,args)).rows[0].value;};
  const store={ settings:async()=>settings, device:(action,id,hash,subscription=null)=>call('device',{action,id,hash,subscription}),
    acquire:token=>call('acquire',{token}), ingest:(token,events)=>call('ingest',{token,events}), claim:(token,limit)=>call('claim',{token,limit}),
    begin:(token,d)=>call('begin_send',{token,event:d.event_id,device:d.device_id}),
    finish:(token,d,o,status)=>call('finish',{token,event:d.event_id,device:d.device_id,state:o.state,next:o.next,status,deactivate:!!o.deactivate}), release:(token,error)=>call('release',{token,error}) };
  const id=await sha256(phone.subscription.endpoint), hash=await sha256(token);
  const sent=[];
  let failSend=false;
  const send=async(sub,payload)=>{if(failSend)throw {statusCode:503};sent.push({sub,payload});};
  const fetchSource=async(url,day)=>source(day===bangkokDay(new Date())?[row('normal')]:[],day);
  await t.test('No enabled device skips source work',async()=>{assert.equal(await store.acquire(crypto.randomUUID()),false);});
  await t.test('Scheduled retention works without enabled devices or healthy source and preserves recent data and unrelated logs',async()=>{
    await db.exec('begin');
    try {
      const oldId='d'.repeat(64),recentId='e'.repeat(64);
      await db.query("insert into public.rfid_push_devices(device_id,token_hash,subscription,enabled,updated_at) values ($1,$1,'{}',false,now()-interval '8 days'),($2,$2,'{}',false,now()-interval '6 days')",[oldId,recentId]);
      await db.exec("insert into public.rfid_push_events(event_id,fingerprint,name,result,scan_time,received_at,day) values ('retention-old','hash','คนทดสอบ','เข้างาน',to_char((now()-interval '4 days') at time zone 'Asia/Bangkok','YYYY-MM-DD HH24:MI:SS'),now()-interval '4 days',current_date-4),('retention-recent','hash','คนทดสอบ','เลิกงาน',to_char((now()-interval '2 days') at time zone 'Asia/Bangkok','YYYY-MM-DD HH24:MI:SS'),now()-interval '2 days',current_date-2)");
      await db.query("insert into public.rfid_push_deliveries(event_id,device_id) values ('retention-old',$1),('retention-recent',$2)",[recentId,oldId]);
      let sourceCalls=0;
      const unavailable=async()=>{sourceCalls++;throw new Error('source unavailable')};
      assert.equal((await runPoll(store,settings,unavailable,send)).ok,true);assert.equal(sourceCalls,0);
      await db.query('update public.rfid_push_devices set enabled=true where device_id=$1',[recentId]);
      assert.equal((await runPoll(store,settings,unavailable,send)).ok,false);assert(sourceCalls>0);assert.equal(sent.length,0);
      await db.query('update public.rfid_push_devices set enabled=false where device_id=$1',[recentId]);
      assert.equal((await db.query("select count(*)::int as count from public.rfid_push_events where event_id='retention-old'")).rows[0].count,1);
      // Local pg_cron is unavailable; execute the exact scheduled SQL body against PostgreSQL.
      await db.exec("create schema cron; create table cron.job(jobid bigint primary key,jobname text); create table cron.job_run_details(jobid bigint,end_time timestamptz); insert into cron.job values (1,'rfid-push-poll'),(2,'unrelated-job'),(3,'rfid-push-log-cleanup'); insert into cron.job_run_details values (1,now()-interval '2 days'),(1,now()),(2,now()-interval '2 days'),(3,now()-interval '2 days')");
      const cronSql=await fs.readFile(new URL('../enable-cron.sql',import.meta.url),'utf8');
      const cleanup=cronSql.match(/cron\.schedule\('rfid-push-log-cleanup',[^\n]*\$job\$([\s\S]*?)\$job\$/);
      assert(cleanup,'scheduled retention SQL body exists');await db.exec(cleanup[1]);
      assert.deepEqual((await db.query("select event_id from public.rfid_push_events where event_id like 'retention-%' order by event_id")).rows,[{event_id:'retention-recent'}]);
      assert.deepEqual((await db.query('select device_id from public.rfid_push_devices order by device_id')).rows,[{device_id:recentId}]);
      assert.equal((await db.query('select count(*)::int as count from public.rfid_push_deliveries')).rows[0].count,0);
      assert.deepEqual((await db.query('select jobid::int from cron.job_run_details order by jobid')).rows,[{jobid:1},{jobid:2}]);
    } finally { await db.exec('rollback'); }
  });
  await t.test('Subscribe persists independent device ownership',async()=>{assert.equal((await store.device('subscribe',id,hash,phone.subscription)).enabled,true);await assert.rejects(store.device('status',id,'b'.repeat(64)));await db.query("update public.rfid_push_devices set activated_at=now()-interval '1 hour'");});
  await t.test('Normal check-in queues and sends once; identical retry sends nothing',async()=>{await runPoll(store,settings,fetchSource,send);assert.equal(sent.length,1);assert(sent[0].payload.title.includes('เข้างาน'));await runPoll(store,settings,fetchSource,send);assert.equal(sent.length,1);});
  await t.test('Multiple people and checkout use separate Event IDs even for repeated SEQ',async()=>{const input=[row('second',{name:'อีกคน'}),row('checkout',{result:'เลิกงาน'})];await runPoll(store,settings,async(_,day)=>source(day===bangkokDay(new Date())?input:[],day),send);assert.equal(sent.length,3);assert(sent.some(x=>x.payload.title==='คนทดสอบ · เลิกงาน'));});
  await t.test('A second device receives its own delivery once',async()=>{const second=device('two');second.subscription.keys.auth=second.auth.toString('base64url');const secondId=await sha256(second.subscription.endpoint);await store.device('subscribe',secondId,'c'.repeat(64),second.subscription);await db.query("update public.rfid_push_devices set activated_at=now()-interval '1 hour'");await runPoll(store,settings,async(_,day)=>source(day===bangkokDay(new Date())?[row('both')]:[],day),send);assert.equal(sent.filter(x=>x.payload.eventId==='both').length,2);});
  await t.test('History before subscription does not become new notifications',async()=>{const old=stamp(new Date(Date.now()-7200000));const before=sent.length;await runPoll(store,settings,async(_,day)=>source(day===old.slice(0,10)?[row('history',{scanTime:old,serverReceivedTime:old})]:[],day),send);assert.equal(sent.length,before);});
  for (const change of ['reenable','replace']) for (const state of ['pending','sending']) await t.test(`Enrollment ${change} cancels its prior ${state} queue and rejects obsolete completions`,async()=>{
    await db.exec('begin');
    try {
      const lock=crypto.randomUUID();assert(await store.acquire(lock));
      const old=stamp(new Date(Date.now()-60000));
      const event=readEvents(source([row('enrollment-old',{scanTime:old,serverReceivedTime:old})],old.slice(0,10)),old.slice(0,10),new Date())[0];
      await store.ingest(lock,[event]);
      const claimed=state==='sending'?await store.claim(lock,50):[];
      if(change==='reenable')await store.device('unsubscribe',id,hash);
      const replacement=change==='replace'?{...phone.subscription,keys:{...phone.subscription.keys,auth:randomBytes(16).toString('base64url')}}:phone.subscription;
      await store.device('subscribe',id,hash,replacement);
      assert.equal((await db.query("select state from public.rfid_push_deliveries where event_id='enrollment-old' and device_id=$1",[id])).rows[0].state,'expired');
      assert(!(await store.claim(lock,50)).some(x=>x.event_id==='enrollment-old'&&x.device_id===id));
      if(state==='sending')assert.equal(await store.finish(lock,claimed.find(x=>x.device_id===id),{state:'expired',deactivate:true,next:new Date().toISOString()},410),false);
      assert.equal((await store.device('status',id,hash)).enabled,true);
      assert.equal((await db.query("select state from public.rfid_push_deliveries where event_id='normal' and device_id=$1",[id])).rows[0].state,'sent');
      const fresh=readEvents(source([row('enrollment-fresh')]),bangkokDay(new Date()),new Date());
      await store.ingest(lock,fresh);assert((await store.claim(lock,50)).some(x=>x.event_id==='enrollment-fresh'&&x.device_id===id));
    } finally { await db.exec('rollback'); }
  });
  await t.test('Enrollment cancellation between batches prevents later provider calls from the already claimed array',async()=>{
    await db.exec('begin');
    try {
      const delivered=[];let finished=0,canceledCount;
      const guarded={...store,finish:async(lock,d,outcome,status)=>{
        const result=await store.finish(lock,d,outcome,status);finished++;
        if(finished===10){await store.device('unsubscribe',id,hash);await store.device('subscribe',id,hash,phone.subscription);canceledCount=delivered.filter(x=>x.endpoint===phone.subscription.endpoint).length;}
        return result;
      }};
      const rows=Array.from({length:20},(_,i)=>row('batch-race-'+String(i).padStart(2,'0')));
      await runPoll(guarded,settings,async(_,day)=>source(day===bangkokDay(new Date())?rows:[],day),async(sub,payload)=>delivered.push({endpoint:sub.endpoint,event:payload.eventId}));
      assert(canceledCount>0);assert.equal(delivered.filter(x=>x.endpoint===phone.subscription.endpoint).length,canceledCount);
      assert.equal(delivered.filter(x=>x.endpoint!==phone.subscription.endpoint).length,20);
      await runPoll(store,settings,async(_,day)=>source([],day),async()=>{throw Error('canceled old queue must not send')});
    } finally { await db.exec('rollback'); }
  });
  await t.test('Each send authorization requires enabled enrollment and current worker/delivery leases',async()=>{
    await db.exec('begin');
    try {
      const lock=crypto.randomUUID();assert(await store.acquire(lock));
      await store.ingest(lock,readEvents(source([row('authorize-send')]),bangkokDay(new Date()),new Date()));
      const d=(await store.claim(lock,50)).find(x=>x.device_id===id);
      assert.deepEqual((await store.begin(lock,d)).subscription,phone.subscription);
      assert(!(await store.begin(crypto.randomUUID(),d)).subscription);
      await db.query("update public.rfid_push_worker set lease_until=now()-interval '1 second'");
      assert(!(await store.begin(lock,d)).subscription);
      await db.query("update public.rfid_push_worker set lease_until=now()+interval '1 minute'");
      await db.query("update public.rfid_push_deliveries set lease_until=now()-interval '1 second' where event_id='authorize-send'");
      assert(!(await store.begin(lock,d)).subscription);
      await store.device('unsubscribe',id,hash);assert(!(await store.begin(lock,d)).subscription);
    } finally { await db.exec('rollback'); }
  });
  await t.test('Identity conflict rolls back all inserted events and delivery rows',async()=>{const lock=crypto.randomUUID();assert(await store.acquire(lock));const event=readEvents(source([row('normal')]),bangkokDay(new Date()),new Date())[0];await assert.rejects(store.ingest(lock,[{...event,event_id:'rollback-first'},{...event,fingerprint:'b'.repeat(64)}]));assert.equal((await db.query("select count(*)::int as count from public.rfid_push_events where event_id='rollback-first'")).rows[0].count,0);await store.release(lock,'expected');});
  await t.test('Transient failure retains queue, then repairs without new source events',async()=>{failSend=true;await runPoll(store,settings,async(_,day)=>source(day===bangkokDay(new Date())?[row('repair')]:[],day),send);assert.equal((await db.query("select count(*)::int as count from public.rfid_push_deliveries where event_id='repair' and state='pending'")).rows[0].count,2);failSend=false;await db.query("update public.rfid_push_deliveries set next_attempt=now() where event_id='repair'");await runPoll(store,settings,async(_,day)=>source([],day),send);assert.equal(sent.filter(x=>x.payload.eventId==='repair').length,2);});
  await t.test('Crash after ingest/claim recovers only after lease expiry',async()=>{const lock=crypto.randomUUID();assert(await store.acquire(lock));const event=readEvents(source([row('crash')]),bangkokDay(new Date()),new Date());await store.ingest(lock,event);const claimed=await store.claim(lock,50);assert.equal(claimed.length,2);assert.equal(await store.acquire(crypto.randomUUID()),false);await db.query("update public.rfid_push_worker set lease_until=now()-interval '1 second'");await db.query("update public.rfid_push_deliveries set lease_until=now()-interval '1 second' where event_id='crash'");await runPoll(store,settings,async(_,day)=>source([],day),send);assert.equal(sent.filter(x=>x.payload.eventId==='crash').length,2);assert.equal(await store.finish(lock,claimed[0],{state:'sent',next:new Date().toISOString()},201),false);});
  await t.test('Provider acceptance followed by database failure repairs only the unacknowledged device',async()=>{
    const failing={...store,finish:async(lock,d,outcome,status)=>{if(d.event_id==='ack-loss'&&d.device_id===id)throw new Error('database failure after provider accepted');return store.finish(lock,d,outcome,status)}};
    await assert.rejects(runPoll(failing,settings,async(_,day)=>source(day===bangkokDay(new Date())?[row('ack-loss')]:[],day),send));
    assert.equal((await db.query("select count(*)::int as count from public.rfid_push_deliveries where event_id='ack-loss' and state='sent'")).rows[0].count,1);
    await db.query("update public.rfid_push_deliveries set lease_until=now()-interval '1 second' where event_id='ack-loss' and state='sending'");
    await runPoll(store,settings,async(_,day)=>source([],day),send);
    assert.equal((await db.query("select count(*)::int as count from public.rfid_push_deliveries where event_id='ack-loss'")).rows[0].count,2);
    assert.equal(sent.filter(x=>x.payload.eventId==='ack-loss').length,3);
  });
  await t.test('Source failure still drains previously verified retry deliveries and records degraded status',async()=>{
    failSend=true;await runPoll(store,settings,async(_,day)=>source(day===bangkokDay(new Date())?[row('source-outage')]:[],day),send);failSend=false;
    await db.query("update public.rfid_push_deliveries set next_attempt=now() where event_id='source-outage'");
    const result=await runPoll(store,settings,async()=>{throw new Error('network failed')},send);
    assert.equal(result.ok,false);assert.equal(result.error,'source_unavailable');assert.equal(result.sourceEvents,0);
    assert.equal(sent.filter(x=>x.payload.eventId==='source-outage').length,2);
    const status=(await db.query('select token,last_error from public.rfid_push_worker')).rows[0];assert.equal(status.token,null);assert.equal(status.last_error,'source_unavailable');
  });
  await t.test('A failed second source page cannot ingest a partial new batch',async()=>{
    const result=await runPoll(store,settings,async(_,day)=>{if(day===bangkokDay(new Date()))return source([row('incomplete-new')],day);throw new Error('second day unavailable')},send);
    assert.equal(result.ok,false);assert.equal((await db.query("select count(*)::int as count from public.rfid_push_events where event_id='incomplete-new'")).rows[0].count,0);
  });
  await t.test('Opt-out stops queue eligibility, expiry deactivates endpoint',async()=>{await store.device('unsubscribe',id,hash);const before=sent.length;await runPoll(store,settings,async(_,day)=>source(day===bangkokDay(new Date())?[row('stop')]:[],day),send);assert.equal(sent.length,before+1);await runPoll(store,settings,async(_,day)=>source(day===bangkokDay(new Date())?[row('gone')]:[],day),async()=>{throw {statusCode:410}});assert.equal((await db.query('select count(*)::int as count from public.rfid_push_devices where enabled')).rows[0].count,0);await store.device('subscribe',id,hash,phone.subscription);});
  await t.test('Monthly send budget stops new attempts and does not open paid services',async()=>{await db.query("update public.rfid_push_worker set budget_month=date_trunc('month',now())::date,sends=100000");await runPoll(store,settings,async(_,day)=>source(day===bangkokDay(new Date())?[row('budget')]:[],day),send);assert.equal(sent.filter(x=>x.payload.eventId==='budget').length,0);await db.query('update public.rfid_push_worker set sends=0');});
  await t.test('Device limit also blocks reactivating an old disabled endpoint',async()=>{
    await db.exec('begin');
    try {
      await db.exec("update public.rfid_push_devices set enabled=false; insert into public.rfid_push_devices(device_id,token_hash,subscription) select lpad(n::text,64,'0'),repeat('a',64),'{}'::jsonb from generate_series(1,200) n");
      await assert.rejects(store.device('subscribe',id,hash,phone.subscription),/device_limit/);
    } finally { await db.exec('rollback'); }
  });
  await t.test('Server blocks unrelated origins, unauthorized polls, and reports safe errors',async()=>{const handler=createHandler(store,send);let response=await handler(new Request('https://example.test/config',{headers:{Origin:'https://evil.example'}}));assert.equal(response.status,403);response=await handler(new Request('https://example.test/poll',{method:'POST'}));assert.equal(response.status,401);response=await handler(new Request('https://example.test/config',{headers:{Origin:origin}}));const data=await response.json();assert.equal(response.headers.get('Access-Control-Allow-Origin'),origin);assert.equal(data.vapidPublicKey,vapid.publicKey);assert(!JSON.stringify(data).includes(vapid.privateKey));response=await handler(new Request('https://example.test/status',{method:'POST',headers:{Origin:origin},body:JSON.stringify({subscription:phone.subscription,deviceToken:token})}));assert.equal((await response.json()).enabled,true);});
  await t.test('Test sends reject an exhausted shared monthly budget without contacting the provider',async()=>{
    await db.exec('begin');
    try {
      await db.exec("update public.rfid_push_worker set budget_month=date_trunc('month',now())::date,sends=100000; update public.rfid_push_devices set last_test=null");
      let calls=0;const handler=createHandler(store,async()=>{calls++;});
      const response=await handler(new Request('https://example.test/test',{method:'POST',headers:{Origin:origin},body:JSON.stringify({subscription:phone.subscription,deviceToken:token})}));
      assert.equal(response.status,429);assert.equal(calls,0);
      assert.equal((await db.query('select sends from public.rfid_push_worker')).rows[0].sends,100000);
      assert.equal((await db.query('select last_test from public.rfid_push_devices where device_id=$1',[id])).rows[0].last_test,null);
    } finally {await db.exec('rollback');}
  });
  await t.test('The last monthly slot is shared by test notifications and attendance delivery',async()=>{
    await db.exec('begin');
    try {
      await db.exec("update public.rfid_push_worker set budget_month=date_trunc('month',now())::date,sends=99999; update public.rfid_push_devices set last_test=null,activated_at=now()-interval '1 hour'");
      let calls=0;const provider=async()=>{calls++;};const handler=createHandler(store,provider);
      const request=()=>new Request('https://example.test/test',{method:'POST',headers:{Origin:origin},body:JSON.stringify({subscription:phone.subscription,deviceToken:token})});
      assert.equal((await handler(request())).status,200);assert.equal(calls,1);
      assert.equal((await db.query('select sends from public.rfid_push_worker')).rows[0].sends,100000);
      await db.exec('update public.rfid_push_devices set last_test=null');
      assert.equal((await handler(request())).status,429);
      await runPoll(store,settings,async(_,day)=>source(day===bangkokDay(new Date())?[row('shared-budget')]:[],day),provider);
      assert.equal(calls,1);
      assert.equal((await db.query("select state from public.rfid_push_deliveries where event_id='shared-budget' and device_id=$1",[id])).rows[0].state,'pending');
    } finally {await db.exec('rollback');}
  });
  await t.test('Test admission resets the monthly budget and counts failed provider attempts',async()=>{
    await db.exec('begin');
    try {
      await db.exec("update public.rfid_push_worker set budget_month=(date_trunc('month',now())-interval '1 month')::date,sends=100000; update public.rfid_push_devices set last_test=null");
      let calls=0;const handler=createHandler(store,async()=>{calls++;throw {statusCode:503};});
      const request=()=>new Request('https://example.test/test',{method:'POST',headers:{Origin:origin},body:JSON.stringify({subscription:phone.subscription,deviceToken:token})});
      assert.equal((await handler(request())).status,503);assert.equal(calls,1);
      assert.deepEqual((await db.query("select sends,budget_month=date_trunc('month',now())::date as current_month from public.rfid_push_worker")).rows[0],{sends:1,current_month:true});
      assert.equal((await handler(request())).status,429);assert.equal(calls,1);
    } finally {await db.exec('rollback');}
  });
  await t.test('Test send is device-owned and rate limited',async()=>{const handler=createHandler(store,send);const request=()=>new Request('https://example.test/test',{method:'POST',headers:{Origin:origin},body:JSON.stringify({subscription:phone.subscription,deviceToken:token})});assert.equal((await handler(request())).status,200);assert.equal((await handler(request())).status,429);});
  await t.test('RLS and RPC execution deny anonymous and authenticated direct reads/writes',async()=>{for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(db.query('select * from public.rfid_push_settings'));await assert.rejects(db.query('select public.rfid_push_claim($1,50)',[crypto.randomUUID()]));await assert.rejects(db.query('select public.rfid_push_begin_send($1,$2,$3)',[crypto.randomUUID(),'event',id]));await db.exec('reset role');}await db.exec('set role service_role');assert.equal((await db.query('select count(*)::int as count from public.rfid_push_settings')).rows[0].count,1);await db.exec('reset role');});
  await db.close();
});

test('REST store keeps credentials server-only and treats authorization failure distinctly',async()=>{let request;const store=createStore('https://example.test','eyJ.server-only',async(url,options)=>{request={url,options};return Response.json([{value:settings}]);});assert.equal((await store.settings()).cronToken,settings.cronToken);assert.equal(request.options.headers.Authorization,'Bearer eyJ.server-only');const denied=createStore('https://example.test','secret',async()=>Response.json({code:'42501'},{status:403}));await assert.rejects(denied.device('status','id','hash'),/device_token_invalid/);});
