import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { randomBytes, createECDH } from 'node:crypto';
import { createHash } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';

const script=await fs.readFile(new URL('../../rfid-transparency-pwa/push.js',import.meta.url),'utf8');
const worker=await fs.readFile(new URL('../../rfid-transparency-pwa/sw.js',import.meta.url),'utf8');
const html=await fs.readFile(new URL('../../rfid-transparency-pwa/index.html',import.meta.url),'utf8');
const config=JSON.parse(await fs.readFile(new URL('../../rfid-transparency-pwa/push-config.json',import.meta.url),'utf8'));
const source='https://script.google.com/macros/s/AKfycbyfgiTQWi9UHw0zVvdi3BOHL9lbSvBzwEg_IYkj8Xmobhj7rLpw_dpR_DpCgCv21xSn/exec';
const point=createECDH('prime256v1');point.generateKeys();
const flush=async()=>{for(let i=0;i<5;i++)await new Promise(setImmediate);};
async function page(options={}) {
  const nodes=new Map(), calls=[], storage=new Map(), handlers=new Map();
  const isInstalled=options.installed!==false;
  let finishStatus;const pausedStatus=new Promise(resolve=>finishStatus=resolve);
  let finishConfig,configCalls=0;const pausedConfig=new Promise(resolve=>finishConfig=resolve);
  let active=options.existing?{endpoint:'https://fcm.googleapis.com/fcm/send/test',keys:{p256dh:point.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')},toJSON(){return {endpoint:this.endpoint,keys:this.keys}},async unsubscribe(){calls.push('unsubscribe');if(options.unsubscribeFail)throw new Error('unsubscribe_failed');active=null;return true}}:null;
  if(options.token)storage.set('rfidPushDeviceToken',randomBytes(32).toString('base64url'));
  storage.set('rfidAppsScriptUrl',options.different?'https://script.google.com/macros/s/different/exec':source);
  const node=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,disabled:false,dataset:{},textContent:'',value:'2026-10-03',addEventListener(type,fn){this[type]=fn;},click(){if(!this.disabled)return this['click-handler']?.();}});return nodes.get(id);};
  // Give click handlers normal DOM semantics while tests explicitly invoke user gestures.
  const get=id=>{const n=node(id);n.addEventListener=(type,fn)=>{n[type+'-handler']=fn;};return n;};
  const Notification={permission:options.denied?'denied':options.enabled?'granted':'default',requestPermission(){calls.push('permission');this.permission=options.dismiss?'default':options.denied?'denied':'granted';return Promise.resolve(this.permission);}};
  const navigator={userAgent:options.ios?'iPhone Safari':'Android Chrome',standalone:isInstalled,serviceWorker:{ready:Promise.resolve({active:{postMessage(data,ports){if(!options.legacyWorker)ports[0].postMessage({type:'RFID_PUSH_CAPABILITY',version:1})}},pushManager:{async getSubscription(){return active},async subscribe(args){calls.push({subscribe:args});active={endpoint:'https://fcm.googleapis.com/fcm/send/test',keys:{p256dh:point.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')},toJSON(){return {endpoint:this.endpoint,keys:this.keys}},async unsubscribe(){calls.push('unsubscribe');if(options.unsubscribeFail)throw new Error('unsubscribe_failed');active=null;return true}};return active;}}}),addEventListener(type,fn){handlers.set(type,fn)}}};
  const window={PushManager:function(){},Notification,isSecureContext:true,location:{protocol:options.file?'file:':'https:'},addEventListener(type,fn){handlers.set('window:'+type,fn)}};
  if(options.unsupported)delete window.PushManager;
  const context=vm.createContext({window,navigator,Notification,document:{getElementById:get},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    matchMedia:()=>({matches:isInstalled}),URL,Uint8Array,atob,btoa,crypto,AbortController,MessageChannel,setTimeout:(fn,ms)=>{if(options.legacyWorker&&ms===2000)setImmediate(fn);return 1;},clearTimeout(){},fetch:async(url,args)=>{
      calls.push({url,args});
      if(options.offline)throw new Error('offline');
      if(url==='./push-config.json')return Response.json(config);
      if(url.endsWith('/config'))return options.deferConfig&&configCalls++===0?pausedConfig:Response.json({ok:true,sourceUrl:source,vapidPublicKey:point.getPublicKey().toString('base64url')});
      if(url.endsWith('/status'))return options.deferStatus?pausedStatus:Response.json(options.ownerFail?{ok:false,error:'device_token_invalid'}:{ok:true,enabled:!!options.enabled},{status:options.ownerFail?403:200});
      if(url.endsWith('/subscribe')&&options.registerFail)return Response.json({ok:false,error:'storage_failed'},{status:503});
      return Response.json({ok:true,enabled:true});
    }});
  new vm.Script(script).runInContext(context);await flush();
  return {node:get,calls,storage,Notification,handlers,active:()=>active,finishStatus:()=>finishStatus(Response.json({ok:true,enabled:true})),finishConfig:()=>finishConfig(Response.json({ok:true,sourceUrl:source,vapidPublicKey:point.getPublicKey().toString('base64url')}))};
}

test('PWA permission and registration behavior',async t=>{
  await t.test('No automatic permission prompt; explicit gesture happens before network request',async()=>{const p=await page();assert(!p.calls.includes('permission'));await p.node('enablePush').click();const i=p.calls.indexOf('permission');const network=p.calls.findIndex((c,j)=>j>i&&c.url?.endsWith('/subscribe'));assert(i>=0&&network>i);assert(p.node('enablePush').hidden);assert(p.node('testPush').hidden);assert.equal(p.storage.get('rfidPushDeviceToken').length,43);});
  await t.test('Action highlight follows each accepted click without changing enrollment',async()=>{
    const p=await page({existing:true,token:true,enabled:true});
    assert(p.node('pushDetails').hidden);
    assert(p.node('pushPublicNote').hidden);
    assert.equal(p.node('disablePush').dataset.selected,'true');
    assert(p.active());
    const stopping=p.node('disablePush').click();
    assert.equal(p.node('disablePush').dataset.selected,'true');
    assert.equal(p.node('testPush').dataset.selected,'false');
    await stopping;
    assert(!p.active());
    assert(!p.node('pushDetails').hidden);
    assert(!p.node('pushPublicNote').hidden);
    assert.equal(p.node('enablePush').dataset.selected,'true');
    const starting=p.node('enablePush').click();
    assert.equal(p.node('enablePush').dataset.selected,'true');
    assert.equal(p.node('disablePush').dataset.selected,'false');
    await starting;
    assert(p.active());
    assert.equal(p.node('disablePush').dataset.selected,'true');
    assert(p.node('pushDetails').hidden);
  });
  await t.test('Failed opt-out keeps the active enrollment and its error visible',async()=>{
    const p=await page({existing:true,token:true,enabled:true,unsubscribeFail:true});
    assert(p.node('pushStatus').hidden);
    await p.node('disablePush').click();
    assert(p.active());
    assert(!p.node('pushStatus').hidden);
    assert(p.node('pushStatus').textContent.includes('ลองใหม่'));
    assert(p.node('pushDetails').hidden);
    assert(!p.node('disablePush').hidden);
  });
  await t.test('Denied and dismissed permissions do not register a device',async()=>{for(const key of ['denied','dismiss']){const p=await page({[key]:true});await p.node('enablePush').click();assert(!p.calls.some(c=>c.url?.endsWith('/subscribe')));assert(!p.active());assert(p.node('pushStatus').textContent.includes('ยังไม่ได้อนุญาต'));}});
  await t.test('Android and iOS require opening the installed Home Screen app',async()=>{for(const ios of [false,true]){const browser=await page({ios,installed:false});assert(browser.node('enablePush').disabled);assert(browser.node('pushStatus').textContent.includes('หน้าจอโฮม'));await browser.node('enablePush').click();assert(!browser.calls.includes('permission'));assert(!browser.calls.some(c=>c.url?.endsWith('/config')));browser.handlers.get('window:appinstalled')();assert(browser.node('pushStatus').textContent.includes('เปิดแอปจากไอคอน'));const app=await page({ios,installed:true});assert(!app.node('enablePush').disabled);}const unsupported=await page({unsupported:true});assert(unsupported.node('enablePush').disabled);});
  await t.test('Local file preview cannot offer notification enrollment',async()=>{const p=await page({file:true,installed:false});assert(p.node('enablePush').disabled);assert(p.node('pushStatus').textContent.includes('ไฟล์ตัวอย่าง'));assert.equal(p.calls.length,0);});
  await t.test('Failed enrollment rolls back browser subscription and never claims enabled',async()=>{const p=await page({registerFail:true});await p.node('enablePush').click();assert(p.calls.includes('unsubscribe'));assert(!p.active());assert(!p.node('enablePush').hidden);assert(p.node('testPush').hidden);});
  await t.test('Existing enabled enrollment is reused; page load only checks status',async()=>{const p=await page({existing:true,token:true,enabled:true});assert(p.node('enablePush').hidden);assert(!p.calls.includes('permission'));assert(!p.calls.some(c=>c.subscribe||c.url?.endsWith('/subscribe')));await p.node('testPush').click();assert(!p.calls.some(c=>c.url?.endsWith('/test')));assert(p.node('pushDetails').hidden);});
  await t.test('Revoked permission is not reported as enabled despite old server registration',async()=>{const p=await page({existing:true,token:true,enabled:true,denied:true});assert(!p.node('enablePush').hidden);assert(p.node('testPush').hidden);assert(!p.calls.includes('permission'));});
  await t.test('Ownership errors leave a local opt-out path',async()=>{const p=await page({existing:true,token:true,ownerFail:true});assert(!p.node('disablePush').hidden);await p.node('disablePush').click();assert(!p.active());assert(p.node('pushStatus').textContent.includes('ปิดรับ'));});
  await t.test('Local opt-out works even if backend cannot be reached',async()=>{const p=await page({existing:true,token:true,offline:true});assert(!p.node('disablePush').hidden);await p.node('disablePush').click();assert(!p.active());assert(p.node('pushStatus').textContent.includes('ปิดรับ'));});
  await t.test('The previously active worker without a push handler cannot enable notifications, but permits local opt-out',async()=>{const p=await page({legacyWorker:true,existing:true,token:true});assert(p.node('enablePush').disabled);assert(p.node('pushStatus').textContent.includes('อัปเดต'));assert(!p.node('disablePush').hidden);await p.node('disablePush').click();assert(!p.active());assert(!p.calls.some(c=>c.url?.endsWith('/subscribe')));});
  await t.test('A different Apps Script URL cannot register for the central source silently',async()=>{const p=await page({different:true});assert(p.node('enablePush').disabled);assert(p.node('pushStatus').textContent.includes('ระบบ RFID กลาง'));assert(!p.calls.some(c=>c.url?.endsWith('/subscribe')));});
  await t.test('Changing the source URL preserves local opt-out for an already enrolled phone',async()=>{const p=await page({different:true,existing:true,token:true,enabled:true});assert(p.node('enablePush').disabled);assert(!p.node('disablePush').hidden);await p.node('disablePush').click();assert(!p.active());assert(p.node('pushStatus').textContent.includes('ปิดรับ'));});
  await t.test('A late startup status cannot overwrite a completed local opt-out',async()=>{const p=await page({existing:true,token:true,enabled:true,deferStatus:true});assert(p.calls.some(c=>c.url?.endsWith('/status')));await p.node('disablePush').click();p.finishStatus();await flush();assert(!p.active());assert(!p.node('enablePush').hidden);assert(p.node('testPush').hidden);assert(p.node('pushStatus').textContent.includes('ปิดรับ'));});
  await t.test('Opt-out during initial config keeps incomplete enrollment disabled and refresh can recover before re-enabling',async()=>{const p=await page({existing:true,token:true,enabled:true,deferConfig:true});assert(p.calls.some(c=>c.url?.endsWith('/config')));await p.node('disablePush').click();assert(!p.active());assert(p.node('enablePush').disabled);p.finishConfig();await flush();assert(p.node('enablePush').disabled);const before=p.calls.filter(c=>c.url?.endsWith('/config')).length;p.node('refreshBtn').click();await flush();assert(p.calls.filter(c=>c.url?.endsWith('/config')).length>before);assert(!p.node('enablePush').disabled);await p.node('enablePush').click();assert(p.active());assert(p.node('enablePush').hidden);});
  await t.test('Foreground receipt refreshes only matching day',async()=>{const p=await page();let clicks=0;p.node('refreshBtn')['click-handler']=()=>clicks++;p.handlers.get('message')({data:{type:'RFID_SCAN',date:'2026-10-02'}});assert.equal(clicks,0);p.handlers.get('message')({data:{type:'RFID_SCAN',date:'2026-10-03'}});assert.equal(clicks,1);});
});

test('Service worker push, click, and cache behavior',async t=>{
  const handlers=new Map(), shown=[],opened=[],messages=[],deleted=[],assets=[];
  const scope='https://jame023.github.io/work-calendar-pages/rfid-transparency-pwa/';
  const clients=[{url:scope,postMessage:data=>messages.push(data),async navigate(url){opened.push(url);return this},async focus(){opened.push('focus')}},{url:'https://jame023.github.io/another-app/',postMessage(){throw Error('wrong app')}}];
  const context=vm.createContext({URL,fetch:async()=>Response.json({ok:true}),self:{location:{origin:'https://jame023.github.io'},registration:{scope,async showNotification(title,options){shown.push({title,options})}},addEventListener:(name,fn)=>handlers.set(name,fn),skipWaiting(){},clients:{claim(){},async matchAll(){return clients},async openWindow(url){opened.push(url)}}},caches:{async open(name){return{async addAll(list){assets.push(name,...list)},async put(){}}},async keys(){return['rfid-audit-mobile-v6','rfid-audit-mobile-v7','rfid-audit-mobile-v8','rfid-audit-mobile-v9','rfid-audit-mobile-v10','rfid-audit-mobile-v11','rfid-audit-mobile-v12','rfid-audit-mobile-v13','rfid-audit-mobile-v14','unrelated-cache']},async delete(key){deleted.push(key)}}});
  new vm.Script(worker).runInContext(context);
  const dispatch=async(name,values)=>{let pending;handlers.get(name)({...values,waitUntil(p){pending=p}});await pending};
  await t.test('Install includes push script; activation deletes only earlier RFID caches',async()=>{await dispatch('install',{});assert(assets.includes('./push.js'));assert(assets.includes('./push.js?v=14'));assert(assets.includes('rfid-audit-mobile-v14'));await dispatch('activate',{});assert.deepEqual(deleted,['rfid-audit-mobile-v6','rfid-audit-mobile-v7','rfid-audit-mobile-v8','rfid-audit-mobile-v9','rfid-audit-mobile-v10','rfid-audit-mobile-v11','rfid-audit-mobile-v12','rfid-audit-mobile-v13']);});
  await t.test('Active worker confirms its push capability through the caller message port',()=>{const replies=[];handlers.get('message')({data:{type:'RFID_PUSH_CAPABILITY'},ports:[{postMessage:data=>replies.push(data)}]});assert.equal(replies[0].type,'RFID_PUSH_CAPABILITY');assert.equal(replies[0].version,1);});
  const payload={version:1,eventId:'same-id',date:'2026-10-02',title:'คนทดสอบ · เลิกงาน',body:'02/10/2026 เวลา 16:15:55',url:'https://evil.example/'};
  await t.test('Each push displays a native notification; retry uses same tag without re-alert',async()=>{for(let i=0;i<2;i++)await dispatch('push',{data:{json:()=>payload}});assert.equal(shown.length,2);assert.equal(shown[0].options.tag,shown[1].options.tag);assert.equal(shown[1].options.renotify,false);assert.equal(shown[0].options.data.url,scope+'?date=2026-10-02');assert.equal(messages.length,2);});
  await t.test('Malformed push stays visible and safe; never opens supplied external URL',async()=>{await dispatch('push',{data:{json(){throw Error('invalid json')}}});assert(shown.at(-1).title.includes('RFID'));assert.equal(shown.at(-1).options.data.url,scope);});
  await t.test('Notification tap navigates only the RFID app to the event date',async()=>{let closed=false;await dispatch('notificationclick',{notification:{data:shown[0].options.data,close(){closed=true}}});assert(closed);assert.deepEqual(opened,[scope+'?date=2026-10-02','focus']);});
  await t.test('Forged notification click URL cannot navigate outside the app',async()=>{await dispatch('notificationclick',{notification:{data:{url:'https://evil.example/'},close(){}}});assert.equal(opened.at(-2),scope);});
  await t.test('Runtime configuration is never put into the offline cache',()=>{let intercepted=false;handlers.get('fetch')({request:{url:scope+'push-config.json'},respondWith(){intercepted=true}});assert.equal(intercepted,false);});
});

test('Attendance renderer highlights late check-ins, hides duplicates, and preserves its API contract',async()=>{
  const get=markup=>markup.match(/<script>([\s\S]*?)<\/script>/)[1];
  const normalized=get(html).replace(/  const linkedDate =[^\n]+\n  \$\("dateInput"\)\.value=linkedDate \? linkedDate\[1\] : today\(\);/,'  $("dateInput").value=today();');
  // Inline-script baseline covers attendance, freshness, loading, install guidance, and local filters.
  assert.equal(createHash('sha256').update(normalized).digest('hex'),'b4515d5627456f9820f49110891df26f94676f40bd7fc0a8e993545c6409eeae');
  assert(html.includes('<script src="./push.js?v=14" defer></script>'));assert.equal(config.url,'https://gzlbkabmxncznsporgxp.supabase.co/functions/v1/rfid-push');
  const claims=JSON.parse(Buffer.from(config.key.split('.')[1],'base64url').toString());assert.equal(claims.role,'anon');
});
