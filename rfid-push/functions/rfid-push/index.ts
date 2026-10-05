import webpush from 'npm:web-push@3.6.7';
import { createStore } from './store.js';
import { createHandler } from './server.js';

const store = createStore(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };
type Settings = { subject: string; vapidPublicKey: string; vapidPrivateKey: string };
const sendPush = (subscription: Subscription, payload: Record<string, unknown>, settings: Settings) => webpush.sendNotification(subscription, JSON.stringify(payload), {
  vapidDetails: { subject: settings.subject, publicKey: settings.vapidPublicKey, privateKey: settings.vapidPrivateKey },
  TTL: 86400, urgency: 'normal', contentEncoding: 'aes128gcm', timeout: 10000
});
Deno.serve(createHandler(store, sendPush));
