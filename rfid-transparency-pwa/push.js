(() => {
  const $ = id => document.getElementById(id);
  const TOKEN_KEY = 'rfidPushDeviceToken';
  const DEFAULT_SOURCE = 'https://script.google.com/macros/s/AKfycbyfgiTQWi9UHw0zVvdi3BOHL9lbSvBzwEg_IYkj8Xmobhj7rLpw_dpR_DpCgCv21xSn/exec';
  const INSTALL_REQUIRED_TEXT = 'ต้องเปิดแอปจากไอคอนบนหน้าจอโฮมก่อนจึงรับแจ้งเตือนได้ หากยังไม่มีไอคอน ให้แตะ “ติดตั้งแอป”';
  const PERMISSION_DENIED_TEXT = 'ยังไม่ได้อนุญาตแจ้งเตือน · เปิดสิทธิ์ในตั้งค่าโทรศัพท์หรือเบราว์เซอร์ก่อน';
  let config, server, registration, subscription, deviceToken, busy = false, initialization = 0;
  let verifiedEnrollment = false, activeCheckVersion = 0, lastForegroundCheck = 0;
  const permissionState = () => window.Notification?.permission || 'default';
  let seenPermission = permissionState();
  const FOREGROUND_CHECK_INTERVAL_MS = 30000;
  const status = text => { $('pushStatus').textContent = text; };
  const beginLoading = label => window.beginRfidLoadingState?.(label) || (async () => {});
  const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  function updateSteps(enabled) {
    const step = (id, state, label) => {
      const element = $(id);
      if (!element) return;
      element.dataset.state = state;
      element.textContent = label;
    };
    step('installStep', installed() ? 'done' : 'pending', installed() ? 'ติดตั้งแล้ว · เปิดจากไอคอน' : 'ติดตั้งและเปิดจากไอคอน');
    const permission = permissionState();
    step('permissionStep', permission === 'granted' ? 'done' : permission === 'denied' ? 'blocked' : 'pending',
      permission === 'granted' ? 'อนุญาตแจ้งเตือนแล้ว' : permission === 'denied' ? 'ปิดสิทธิ์แจ้งเตือนอยู่' : 'รออนุญาตแจ้งเตือน');
    step('enrollmentStep', enabled ? 'done' : permission === 'denied' ? 'blocked' : 'pending',
      enabled ? 'เปิดรับบนเครื่องนี้แล้ว' : permission === 'denied' ? 'รอเปิดสิทธิ์แจ้งเตือน' : 'รอเปิดรับบนเครื่องนี้');
  }
  const actionIds = ['enablePush', 'disablePush', 'testPush'];
  let selectedAction = 'enablePush';
  function selectAction(id) {
    selectedAction = id;
    for (const actionId of actionIds) {
      $(actionId).dataset.selected = String(actionId === selectedAction);
    }
  }
  function controls(enabled) {
    const canReceive = !!enabled && verifiedEnrollment && !!subscription && installed() && permissionState() === 'granted';
    $('enablePush').hidden = canReceive; $('enablePush').disabled = busy || !config || !installed() || permissionState() === 'denied';
    $('disablePush').hidden = !subscription; $('disablePush').disabled = busy;
    $('testPush').hidden = !canReceive; $('testPush').disabled = busy;
    if (!busy && $(selectedAction).hidden) {
      selectedAction = canReceive ? 'testPush' : 'enablePush';
    }
    selectAction(selectedAction);
    seenPermission = permissionState();
    updateSteps(canReceive);
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
  async function initialize({ silent = false } = {}) {
    if (busy || (activeCheckVersion && activeCheckVersion === initialization)) return;
    const version = ++initialization;
    activeCheckVersion = version;
    lastForegroundCheck = Date.now();
    const current = () => version === initialization;
    verifiedEnrollment = false;
    config = null; server = null;
    controls(false);
    status('กำลังตรวจสอบสถานะแจ้งเตือนบนเครื่องนี้…');
    if (window.location.protocol === 'file:') { status('หน้านี้เป็นไฟล์ตัวอย่าง หากต้องการติดตั้งและรับแจ้งเตือน ให้เปิดลิงก์แอปบนเว็บไซต์ก่อน'); activeCheckVersion = 0; return; }
    if (!installed()) { status(INSTALL_REQUIRED_TEXT); activeCheckVersion = 0; return; }
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window) || !window.isSecureContext) {
      status('เบราว์เซอร์นี้ยังไม่รองรับแจ้งเตือน กรุณาเปิดด้วยเบราว์เซอร์ที่รองรับ'); activeCheckVersion = 0; return;
    }
    const finishLoading = silent ? async () => {} : beginLoading('กำลังตรวจสอบระบบแจ้งเตือน');
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
        verifiedEnrollment = enabled;
        controls(enabled); status(enabled ? 'เปิดรับแล้ว · แจ้งชื่อ วันที่ และเวลาเข้า–ออกของทุกคน แม้ปิดแอป' : permissionState() === 'denied' ? PERMISSION_DENIED_TEXT : 'ยังไม่ได้เปิดรับแจ้งเตือนบนมือถือเครื่องนี้');
      } else { controls(false); status(permissionState() === 'denied' ? PERMISSION_DENIED_TEXT : 'เปิดรับเพื่อดูการเข้า–ออกของทุกคน แม้ปิดแอป'); }
    } catch (error) { if (!current()) return; config = null; verifiedEnrollment = false; controls(false); status(error.message === 'worker_update_required' ? 'แอปกำลังอัปเดตตัวรับแจ้งเตือน กรุณาปิดแล้วเปิดแอปใหม่ หรือกดรีเฟรชเมื่อออนไลน์' : 'ยังเชื่อมต่อการแจ้งเตือนไม่ได้ กดรีเฟรชเมื่อออนไลน์ ข้อมูลเข้า–ออกยังดูได้ตามปกติ'); }
    finally { if (activeCheckVersion === version) activeCheckVersion = 0; await finishLoading(); }
  }
  $('enablePush').addEventListener('click', async () => {
    if (busy || !config) return;
    if (!installed()) { config = null; controls(false); status(INSTALL_REQUIRED_TEXT); return; }
    if (permissionState() === 'denied') { controls(false); status(PERMISSION_DENIED_TEXT); return; }
    if (!sourceMatches()) { status('การแจ้งเตือนใช้กับระบบ RFID กลางเท่านั้น กรุณาตรวจการตั้งค่า'); return; }
    selectAction('enablePush');
    // Request directly in the click gesture; iOS requires this user interaction.
    const permission = Notification.permission === 'granted' ? Promise.resolve('granted') : Notification.requestPermission();
    const finishLoading = beginLoading('กำลังเปิดรับแจ้งเตือนบนอุปกรณ์นี้');
    busy = true; controls(false);
    let created = false;
    try {
      if (await permission !== 'granted') { verifiedEnrollment = false; controls(false); status('ยังไม่ได้อนุญาตแจ้งเตือน คุณยังดูข้อมูลเข้า–ออกได้ตามปกติ'); return; }
      await confirmPushWorker();
      deviceToken = token();
      subscription = await registration.pushManager.getSubscription();
      if (!subscription) { subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(server.vapidPublicKey) }); created = true; }
      const enrollment = await api('subscribe', requestBody());
      verifiedEnrollment = enrollment.enabled === true && permissionState() === 'granted';
      status(verifiedEnrollment ? 'เปิดรับแล้ว · แจ้งชื่อ วันที่ และเวลาเข้า–ออกของทุกคน แม้ปิดแอป' : permissionState() !== 'granted' ? 'สิทธิ์แจ้งเตือนถูกปิดระหว่างเปิดรับ กรุณาเปิดสิทธิ์ในตั้งค่าเครื่อง' : 'ระบบยังไม่ยืนยันการเปิดรับบนเครื่องนี้ กรุณากดรีเฟรช');
      controls(verifiedEnrollment);
    } catch (error) {
      verifiedEnrollment = false;
      if (created && subscription) {
        const body = requestBody();
        await subscription.unsubscribe().catch(() => {});
        await api('unsubscribe', body).catch(() => {});
        subscription = await registration.pushManager.getSubscription().catch(() => null);
      }
      status(errors(error)); controls(false);
    }
    finally { busy = false; controls(verifiedEnrollment); await finishLoading(); }
  });
  $('disablePush').addEventListener('click', async () => {
    if (busy) return;
    selectAction('disablePush');
    initialization += 1;
    const wasVerified = verifiedEnrollment;
    const finishLoading = beginLoading('กำลังปิดรับแจ้งเตือนบนอุปกรณ์นี้');
    busy = true; controls(true);
    try {
      const body = requestBody();
      const removed = await subscription.unsubscribe();
      if (!removed && await registration.pushManager.getSubscription()) throw new Error('unsubscribe_failed');
      subscription = null;
      try { await api('unsubscribe', body); } catch (_) { /* Provider returns 410 after local unsubscribe; later polling deactivates the endpoint. */ }
      verifiedEnrollment = false;
      status('ปิดรับแจ้งเตือนบนมือถือเครื่องนี้แล้ว'); controls(false);
    } catch (error) { verifiedEnrollment = wasVerified; status(errors(error)); controls(wasVerified); }
    finally { busy = false; controls(verifiedEnrollment); await finishLoading(); }
  });
  $('testPush').addEventListener('click', async () => {
    if (busy || !subscription || !verifiedEnrollment || permissionState() !== 'granted') return;
    selectAction('testPush');
    const finishLoading = beginLoading('กำลังส่งการแจ้งเตือนทดสอบ');
    busy = true; controls(true);
    try {
      await api('test', requestBody());
      if (permissionState() !== 'granted') {
        verifiedEnrollment = false;
        status(permissionState() === 'denied' ? PERMISSION_DENIED_TEXT : 'สิทธิ์แจ้งเตือนเปลี่ยนไป กรุณาตรวจสอบและเปิดรับอีกครั้ง');
      } else status('ส่งทดสอบแล้ว กรุณาดูแถบแจ้งเตือนของมือถือ');
    }
    catch (error) { status(errors(error)); }
    finally { busy = false; controls(verifiedEnrollment); await finishLoading(); }
  });
  $('refreshBtn').addEventListener('click', () => { if (!busy) initialize(); });
  $('saveSettings').addEventListener('click', () => { if (!busy) initialize(); });
  window.addEventListener('appinstalled', () => {
    controls(verifiedEnrollment);
    if (!installed()) status('ติดตั้งแล้ว เปิดแอปจากไอคอนบนหน้าจอโฮมเพื่อเปิดรับแจ้งเตือน');
  });
  function recheckOnReturn() {
    if (document.visibilityState === 'hidden') return;
    const permissionChanged = permissionState() !== seenPermission;
    if (permissionChanged) {
      verifiedEnrollment = false;
      controls(false);
      status(permissionState() === 'denied' ? PERMISSION_DENIED_TEXT : 'กำลังตรวจสอบสถานะแจ้งเตือนบนเครื่องนี้…');
    }
    if (busy || (!permissionChanged && Date.now() - lastForegroundCheck < FOREGROUND_CHECK_INTERVAL_MS)) return;
    initialize({ silent: true });
  }
  document.addEventListener?.('visibilitychange', recheckOnReturn);
  window.addEventListener('focus', recheckOnReturn);
  navigator.serviceWorker?.addEventListener('message', event => {
    if (event.data?.type === 'RFID_SCAN' && event.data.date === $('dateInput').value && !$('refreshBtn').disabled) $('refreshBtn').click();
  });
  initialize();
})();
