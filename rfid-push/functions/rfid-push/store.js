import { PushError } from './core.js';

export function createStore(url, key, fetcher = fetch) {
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;
  async function request(path, body) {
    const response = await fetcher(url + '/rest/v1/' + path, { method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      if (failure.code === '42501') throw new PushError('device_token_invalid', 403);
      if (failure.code === 'P0001' && failure.message === 'device_limit') throw new PushError('device_limit', 429);
      throw new PushError('storage_failed', 503);
    }
    return response.json();
  }
  const rpc = (name, data) => request('rpc/rfid_push_' + name, data);
  return {
    async settings() { const rows = await request('rfid_push_settings?select=value&id=eq.true'); if (!rows[0]) throw new PushError('push_not_configured', 503); return rows[0].value; },
    device: (action, id, hash, subscription = null) => rpc('device', { p_action: action, p_id: id, p_token_hash: hash, p_subscription: subscription }),
    acquire: token => rpc('acquire', { p_token: token }),
    ingest: (token, events) => rpc('ingest', { p_token: token, p_events: events }),
    claim: (token, limit) => rpc('claim', { p_token: token, p_limit: limit }),
    begin: (token, delivery) => rpc('begin_send', { p_token: token, p_event_id: delivery.event_id, p_device_id: delivery.device_id }),
    finish: (token, delivery, outcome, status) => rpc('finish', { p_token: token, p_event_id: delivery.event_id, p_device_id: delivery.device_id, p_state: outcome.state, p_next: outcome.next, p_status: status, p_deactivate: Boolean(outcome.deactivate) }),
    release: (token, error) => rpc('release', { p_token: token, p_error: error })
  };
}
