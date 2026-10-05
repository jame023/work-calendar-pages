import { PushError, sha256, validateSubscription, validateDeviceToken, runPoll } from './core.js';

export function createHandler(store, sendPush, fetcher = fetch) {
  return async request => {
    let cors = { 'Vary': 'Origin', 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
    try {
      const settings = await store.settings();
      const origin = request.headers.get('Origin');
      if (origin && origin !== settings.origin) throw new PushError('origin_not_allowed', 403);
      if (origin) cors = { ...cors, 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      const path = new URL(request.url).pathname.split('/').pop();
      const answer = data => Response.json(data, { headers: cors });
      if (path === 'config' && request.method === 'GET') return answer({ ok: true, sourceUrl: settings.sourceUrl, vapidPublicKey: settings.vapidPublicKey });
      if (request.method !== 'POST') throw new PushError('method_not_allowed', 405);
      if (path === 'poll') {
        if (request.headers.get('x-rfid-cron-token') !== settings.cronToken) throw new PushError('unauthorized', 401);
        const source = async (url, day) => {
          const endpoint = new URL(url); endpoint.search = new URLSearchParams({ api: 'rfid-public', date: day, name: '', result: 'all', limit: '500' }).toString();
          const response = await fetcher(endpoint, { signal: AbortSignal.timeout(20000), redirect: 'follow', cache: 'no-store' });
          if (!response.ok) throw new PushError('source_unavailable', 502);
          const text = await response.text();
          if (text.length > 2 * 1024 * 1024) throw new PushError('source_too_large', 502);
          try { return JSON.parse(text); } catch { throw new PushError('source_invalid_json', 502); }
        };
        return answer(await runPoll(store, settings, source, sendPush));
      }
      if (!['subscribe', 'unsubscribe', 'status', 'test'].includes(path)) throw new PushError('not_found', 404);
      if (!origin) throw new PushError('origin_required', 403);
      const text = await request.text();
      if (text.length > 4096) throw new PushError('request_too_large', 413);
      let body;
      try { body = JSON.parse(text); } catch { throw new PushError('request_invalid'); }
      const token = validateDeviceToken(body.deviceToken);
      const subscription = await validateSubscription(body.subscription);
      const id = await sha256(subscription.endpoint);
      const result = await store.device(path, id, await sha256(token), path === 'subscribe' ? subscription : null);
      if (path === 'test') {
        if (!result.subscription) throw new PushError('test_not_ready', 429);
        await sendPush(await validateSubscription(result.subscription), { version: 1, eventId: 'test-' + crypto.randomUUID(), date: '', title: 'RFID · ทดสอบแจ้งเตือน', body: 'มือถือเครื่องนี้เปิดรับแจ้งเตือนแล้ว', url: './' }, settings);
        return answer({ ok: true });
      }
      return answer({ ok: true, enabled: result.enabled });
    } catch (failure) {
      const known = failure instanceof PushError;
      return Response.json({ ok: false, error: known ? failure.message : 'push_failed' }, { status: known ? failure.status : 503, headers: cors });
    }
  };
}
