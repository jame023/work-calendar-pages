export class PushError extends Error {
  constructor(code, status = 400) { super(code); this.status = status; }
}

export async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
}

export function bangkokDay(now) {
  return new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 10);
}

export function sourceDates(now) {
  // Also read yesterday: retries and a scan around midnight can reach the audit later.
  return [bangkokDay(now), bangkokDay(new Date(now.getTime() - 86400000))];
}

export function parseSourceTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw new PushError('source_time_invalid', 502);
  const date = new Date(value.replace(' ', 'T') + '+07:00');
  if (!Number.isFinite(date.getTime()) || new Date(date.getTime() + 7 * 3600000).toISOString().slice(0, 19).replace('T', ' ') !== value) throw new PushError('source_time_invalid', 502);
  return date;
}

export function readEvents(data, day, now) {
  if (!data || data.ok !== true || data.timezone !== 'Asia/Bangkok' || data.filters?.date !== day || data.filters?.result !== 'all' || !Array.isArray(data.rows) || data.chain?.ok !== true) throw new PushError('source_not_verified', 502);
  if (!Number.isInteger(data.totals?.events) || data.totals.events !== data.rows.length) throw new PushError('source_incomplete', 502);
  const events = [];
  for (const row of data.rows) {
    if (!['เข้างาน', 'เลิกงาน'].includes(row.result) || row.unknown === true || typeof row.name !== 'string' || !row.name.trim() || row.name.trim() === 'ยังไม่มีชื่อ') continue;
    if (row.chainValid !== true || row.nodeId !== 'RFID' || typeof row.eventId !== 'string' || !row.eventId || row.eventId.length > 256 || !/^[a-f0-9]{64}$/.test(row.eventHash) || row.name.length > 200) throw new PushError('source_event_invalid', 502);
    const received = parseSourceTime(row.serverReceivedTime);
    parseSourceTime(row.scanTime);
    if (row.scanTime.slice(0, 10) !== day || received.getTime() > now.getTime() + 60000) throw new PushError('source_time_invalid', 502);
    events.push({ event_id: row.eventId, fingerprint: row.eventHash, name: row.name,
      result: row.result, scan_time: row.scanTime, received_at: received.toISOString(), day });
  }
  return events;
}

function decodeKey(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new PushError('subscription_invalid');
  let bytes;
  try { bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
  catch { throw new PushError('subscription_invalid'); }
  if (bytes.length !== length) throw new PushError('subscription_invalid');
  return bytes;
}

export async function validateSubscription(subscription) {
  if (!subscription || typeof subscription.endpoint !== 'string' || subscription.endpoint.length > 2048) throw new PushError('subscription_invalid');
  let url;
  try { url = new URL(subscription.endpoint); } catch { throw new PushError('subscription_invalid'); }
  const host = url.hostname;
  const allowed = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' || host === 'web.push.apple.com';
  if (!allowed || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || url.pathname === '/') throw new PushError('push_provider_unsupported');
  const point = decodeKey(subscription.keys?.p256dh, 65);
  if (point[0] !== 4) throw new PushError('subscription_invalid');
  try { await crypto.subtle.importKey('raw', point, { name: 'ECDH', namedCurve: 'P-256' }, false, []); }
  catch { throw new PushError('subscription_invalid'); }
  decodeKey(subscription.keys?.auth, 16);
  return { endpoint: url.href, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } };
}

export function validateDeviceToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new PushError('device_token_invalid');
  return token;
}

export function attendancePayload(event) {
  const date = event.day;
  return { version: 1, eventId: event.event_id, date, title: event.name + ' · ' + event.result,
    body: date.split('-').reverse().join('/') + ' เวลา ' + event.scan_time.slice(11),
    url: './?date=' + date };
}

export function deliveryOutcome(status, attempt, now) {
  if (status >= 200 && status < 300) return { state: 'sent', next: now.toISOString() };
  if ([404, 410].includes(status)) return { state: 'expired', deactivate: true, next: now.toISOString() };
  const retry = status === 0 || status === 408 || status === 429 || status >= 500;
  return { state: retry ? 'pending' : 'expired', next: new Date(now.getTime() + Math.min(3600, 30 * 2 ** Math.min(attempt, 7)) * 1000).toISOString() };
}

export async function runPoll(store, settings, fetchSource, sendPush, now = new Date()) {
  const token = crypto.randomUUID();
  if (!await store.acquire(token)) return { ok: true, busy: true };
  const stopStarting = Date.now() + 80000;
  let error = '';
  try {
    let events = [], sourceError = '';
    try {
      for (const day of sourceDates(now)) events.push(...readEvents(await fetchSource(settings.sourceUrl, day), day, now));
    } catch (failure) {
      sourceError = failure instanceof PushError ? failure.message : 'source_unavailable';
      events = []; error = sourceError;
    }
    // Never ingest a partial source batch. Already verified persisted deliveries
    // can still be repaired while the attendance API is temporarily unavailable.
    if (!sourceError) await store.ingest(token, events);
    const deliveries = await store.claim(token, 50);
    let sent = 0;
    // Bounded sequential batches keep the invocation inside its lease and runtime budget.
    for (let i = 0; i < deliveries.length && Date.now() < stopStarting; i += 10) {
      const completed = await Promise.allSettled(deliveries.slice(i, i + 10).map(async delivery => {
        // A claim can become obsolete while prior batches run. Re-authorize this
        // individual attempt against current enrollment and both live leases.
        const ready = await store.begin(token, delivery);
        if (!ready.subscription) return;
        let status = 0;
        try {
          await sendPush(await validateSubscription(ready.subscription), attendancePayload(delivery), settings);
          status = 201;
        } catch (failure) { status = failure instanceof PushError ? 400 : Number(failure.statusCode) || 0; }
        const outcome = deliveryOutcome(status, delivery.attempts, new Date());
        const acknowledged = await store.finish(token, delivery, outcome, status);
        if (acknowledged && outcome.state === 'sent') sent += 1;
      }));
      const failure = completed.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    }
    return { ok: !sourceError, ...(sourceError ? { error: sourceError } : {}), sourceEvents: events.length, claimed: deliveries.length, sent };
  } catch (failure) {
    error = failure instanceof PushError ? failure.message : 'poll_failed';
    throw failure;
  } finally { await store.release(token, error); }
}
