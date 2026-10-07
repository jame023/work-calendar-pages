const CACHE_PREFIX="rfid-audit-mobile-";
const CACHE=CACHE_PREFIX+"v13";
const ASSETS=["./","./index.html","./push.js","./push.js?v=10","./manifest.webmanifest","./icon-192.png","./icon-512.png"];

self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate",event=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(
      keys.filter(key=>key.startsWith(CACHE_PREFIX)&&key!==CACHE).map(key=>caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch",event=>{
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin)return;
  if(url.pathname.endsWith('/push-config.json'))return;
  event.respondWith(
    fetch(event.request).then(response=>{
      const copy=response.clone();
      caches.open(CACHE).then(cache=>cache.put(event.request,copy));
      return response;
    }).catch(()=>caches.match(event.request))
  );
});

self.addEventListener('message',event=>{
  if(event.data?.type==='RFID_PUSH_CAPABILITY')event.ports[0]?.postMessage({type:'RFID_PUSH_CAPABILITY',version:1});
});

self.addEventListener('push',event=>{
  event.waitUntil((async()=>{
    let data;
    try{data=event.data.json()}catch(_){data={}}
    const valid=data?.version===1&&typeof data.eventId==='string'&&data.eventId.length>0&&data.eventId.length<=256&&typeof data.title==='string'&&typeof data.body==='string';
    const id=valid?data.eventId:'rfid-message';
    const date=valid&&/^\d{4}-\d{2}-\d{2}$/.test(data.date)?data.date:'';
    // Always display a notification: Safari does not allow silent Web Push.
    // The same tag replaces a visible retry without another sound/vibration.
    await self.registration.showNotification(valid?data.title:'RFID · แจ้งเตือน',{
      body:valid?data.body:'เปิดแอปเพื่อตรวจข้อมูลเข้า–ออกงาน',tag:'rfid-'+id,renotify:false,
      icon:new URL('./icon-192.png',self.registration.scope).href,
      badge:new URL('./icon-192.png',self.registration.scope).href,
      data:{url:new URL(date?'./?date='+date:'./',self.registration.scope).href}
    });
    const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    clients.filter(client=>client.url.startsWith(self.registration.scope)).forEach(client=>client.postMessage({type:'RFID_SCAN',date}));
  })());
});

self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const scope=self.registration.scope;
    let target;
    try{target=new URL(event.notification.data?.url||'./',scope)}catch(_){target=new URL(scope)}
    const url=target.href.startsWith(scope)?target.href:scope;
    const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing=clients.find(client=>client.url.startsWith(scope));
    if(existing){const navigated=await existing.navigate(url);if(navigated)return navigated.focus()}
    return self.clients.openWindow(url);
  })());
});
