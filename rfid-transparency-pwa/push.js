(() => {
  const $ = id => document.getElementById(id);
  const TOKEN_KEY = 'rfidPushDeviceToken';
  const DEFAULT_SOURCE = 'https://script.google.com/macros/s/AKfycbyfgiTQWi9UHw0zVvdi3BOHL9lbSvBzwEg_IYkj8Xmobhj7rLpw_dpR_DpCgCv21xSn/exec';
  let config, server, registration, subscription, deviceToken, busy = false, initialization = 0;
  const status = text => { $('pushStatus').textContent = text; };
  const ios = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  function controls(enabled) {
    $('enablePush').hidden = enabled; $('enablePush').disabled = busy || !config;
    $('disablePush').hidden = !subscription; $('disablePush').disabled = busy;
    $('testPush').hidden = !enabled; $('testPush').disabled = busy;
  }
  function sourceMatches() {
    const value = localStorage.getItem('rfidAppsScriptUrl') || DEFAULT_SOURCE;
    return value === server.sourceUrl;
  }
  function bytes(value) { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
  async function timedFetch(url, options, milliseconds) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), milliseconds);
    try { return await fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }
  function token() {
    const value = localStorage.getItem(TOKEN_KEY);
    if (value && /^[A-Za-z0-9_-]{43}$/.test(value)) return value;
    const fresh = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    localStorage.setItem(TOKEN_KEY, fresh); return fresh;
  }
  async function api(route, body, client = config) {
    const response = await timedFetch(client.url + '/' + route, {
      method: body ? 'POST' : 'GET', credentials: 'omit', cache: 'no-store',
      headers: { apikey: client.key, Authorization: 'Bearer ' + client.key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    }, 20000);
    const data = await response.json();
    if (!response.ok || data.ok !== true) throw new Error(data.error || 'request_failed');
    return data;
  }
  const requestBody = () => ({ subscription: subscription.toJSON(), deviceToken });
  const errors = error => error?.name === 'NotAllowedError' || Notification.permission === 'denied'
    ? 'ยังไม่ได้อนุญาตแจ้งเตือน เปิดสิทธิ์ในตั้งค่าเบราว์เซอร์หรือโทรศัพท์ แล้วลองอีกครั้ง'
    : error?.message === 'device_token_invalid' ? 'รหัสของมือถือเครื่องนี้ไม่ตรงกับที่ลงทะเบียนไว้ ให้ปิดรับแล้วเปิดรับใหม่'
    : error?.message === 'device_limit' ? 'จำนวนมือถือที่เปิดรับครบแล้ว กรุณาแจ้งผู้ดูแล'
    : 'เชื่อมต่อการแจ้งเตือนไม่สำเร็จ กรุณาลองใหม่เมื่อออนไลน์';
  async function confirmPushWorker() {
    const active = registration.active;
    if (!active) throw new Error('worker_update_required');
    const ready = await new Promise(resolve => {
      const channel = new MessageChannel();
      const finish = value => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); resolve(value); };
      const timer = setTimeout(() => finish(false), 2000);
      channel.port1.onmessage = event => finish(event.data?.type === 'RFID_PUSH_CAPABILITY' && event.data.version === 1);
      try { active.postMessage({ type: 'RFID_PUSH_CAPABILITY' }, [channel.port2]); }
      catch (_) { finish(false); }
    });
    if (!ready) throw new Error('worker_update_required');
  }
  async function initialize() {
    const version = ++initialization;
    const current = () => version === initialization;
    config = null; server = null;
    controls(false);
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window) || !window.isSecureContext) {
      status(ios() && !installed() ? 'iPhone/iPad: เพิ่มแอปไปยังหน้าจอโฮม แล้วเปิดจากไอคอนเพื่อรับแจ้งเตือน' : 'เบราว์เซอร์นี้ยังไม่รองรับแจ้งเตือน กรุณาเปิดด้วยเบราว์เซอร์ที่รองรับ'); return;
    }
    if (ios() && !installed()) { status('iPhone/iPad: เพิ่มแอปไปยังหน้าจอโฮม แล้วเปิดจากไอคอนเพื่อรับแจ้งเตือน'); return; }
    try {
      const ready = await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('worker_not_ready')), 15000))]);
      if (!current()) return;
      registration = ready;
      const existing = await registration.pushManager.getSubscription();
      if (!current()) return;
      subscription = existing;
      controls(false);
      deviceToken = localStorage.getItem(TOKEN_KEY);
      await confirmPushWorker();
      if (!current()) return;
      const response = await timedFetch('./push-config.json', { cache: 'no-store', credentials: 'omit' }, 10000);
      if (!response.ok) throw new Error('config_unavailable');
      const value = await response.json();
      if (!current()) return;
      const endpoint = new URL(value.url);
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/rfid-push$/.test(endpoint.href) || typeof value.key !== 'string') throw new Error('config_invalid');
      const settings = await api('config', undefined, value);
      if (!current()) return;
      server = settings; config = value;
      if (!sourceMatches()) { config = null; controls(false); status('การแจ้งเตือนใช้กับระบบ RFID กลางเท่านั้น กรุณาตรวจการตั้งค่า'); return; }
      if (subscription && deviceToken) {
        const state = await api('status', requestBody());
        if (!current()) return;
        const enabled = state.enabled && Notification.permission === 'granted';
        controls(enabled); status(enabled ? 'เปิดรับแล้ว · แจ้งชื่อ วันที่ และเวลาเข้า–ออกของทุกคน แม้ปิดแอป' : 'ยังไม่ได้เปิดรับแจ้งเตือนบนมือถือเครื่องนี้');
      } else { controls(false); status(Notification.permission === 'denied' ? 'แจ้งเตือนถูกปิดไว้ กรุณาเปิดสิทธิ์ในตั้งค่าโทรศัพท์หรือเบราว์เซอร์' : 'เปิดรับเพื่อดูการเข้า–ออกของทุกคน แม้ปิดแอป'); }
    } catch (error) { if (!current()) return; config = null; controls(false); status(error.message === 'worker_update_required' ? 'แอปกำลังอัปเดตตัวรับแจ้งเตือน กรุณาปิดแล้วเปิดแอปใหม่ หรือกดรีเฟรชเมื่อออนไลน์' : 'ยังเชื่อมต่อการแจ้งเตือนไม่ได้ กดรีเฟรชเมื่อออนไลน์ ข้อมูลเข้า–ออกยังดูได้ตามปกติ'); }
  }
  $('enablePush').addEventListener('click', async () => {
    if (busy || !config) return;
    if (!sourceMatches()) { status('การแจ้งเตือนใช้กับระบบ RFID กลางเท่านั้น กรุณาตรวจการตั้งค่า'); return; }
    // Request directly in the click gesture; iOS requires this user interaction.
    const permission = Notification.permission === 'granted' ? Promise.resolve('granted') : Notification.requestPermission();
    busy = true; controls(false);
    let created = false;
    try {
      if (await permission !== 'granted') { status('ยังไม่ได้อนุญาตแจ้งเตือน คุณยังดูข้อมูลเข้า–ออกได้ตามปกติ'); return; }
      await confirmPushWorker();
      deviceToken = token();
      subscription = await registration.pushManager.getSubscription();
      if (!subscription) { subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(server.vapidPublicKey) }); created = true; }
      await api('subscribe', requestBody());
      status('เปิดรับแล้ว · แจ้งชื่อ วันที่ และเวลาเข้า–ออกของทุกคน แม้ปิดแอป');
      controls(true);
    } catch (error) {
      if (created && subscription) {
        const body = requestBody();
        await subscription.unsubscribe().catch(() => {});
        await api('unsubscribe', body).catch(() => {});
        subscription = await registration.pushManager.getSubscription().catch(() => null);
      }
      status(errors(error)); controls(false);
    }
    finally { busy = false; $('enablePush').disabled = !config; $('disablePush').disabled = false; $('testPush').disabled = false; }
  });
  $('disablePush').addEventListener('click', async () => {
    if (busy) return;
    initialization += 1;
    busy = true; controls(true);
    try {
      const body = requestBody();
      const removed = await subscription.unsubscribe();
      if (!removed && await registration.pushManager.getSubscription()) throw new Error('unsubscribe_failed');
      subscription = null;
      try { await api('unsubscribe', body); } catch (_) { /* Provider returns 410 after local unsubscribe; later polling deactivates the endpoint. */ }
      status('ปิดรับแจ้งเตือนบนมือถือเครื่องนี้แล้ว'); controls(false);
    } catch (error) { status(errors(error)); controls(true); }
    finally { busy = false; $('enablePush').disabled = !config; $('disablePush').disabled = false; $('testPush').disabled = false; }
  });
  $('testPush').addEventListener('click', async () => {
    if (busy || !subscription) return;
    busy = true; controls(true);
    try { await api('test', requestBody()); status('ส่งทดสอบแล้ว กรุณาดูแถบแจ้งเตือนของมือถือ'); }
    catch (error) { status(errors(error)); }
    finally { busy = false; controls(true); }
  });
  $('refreshBtn').addEventListener('click', () => { if (!config && !busy) initialize(); });
  $('saveSettings').addEventListener('click', () => { if (!busy) initialize(); });
  navigator.serviceWorker?.addEventListener('message', event => {
    if (event.data?.type === 'RFID_SCAN' && event.data.date === $('dateInput').value && !$('refreshBtn').disabled) $('refreshBtn').click();
  });
  initialize();
})();
