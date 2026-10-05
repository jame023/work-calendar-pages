import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import webpush from 'web-push';

if (!process.argv[2]) throw new Error('Provide a private output filename outside the published source. Existing files will not be overwritten.');
const config = JSON.parse(await fs.readFile(new URL('../rfid-transparency-pwa/push-config.json', import.meta.url), 'utf8'));
const page = await fs.readFile(new URL('../rfid-transparency-pwa/index.html', import.meta.url), 'utf8');
const sourceUrl = page.match(/const DEFAULT_API_URL = "([^"]+)";/)?.[1];
const vapid = webpush.generateVAPIDKeys();
if (!sourceUrl || !config.url.startsWith('https://gzlbkabmxncznsporgxp.supabase.co/')) throw new Error('Unreviewed destination');
const settings = { origin: 'https://jame023.github.io', sourceUrl, subject: 'https://jame023.github.io/work-calendar-pages/rfid-transparency-pwa/',
  vapidPublicKey: vapid.publicKey, vapidPrivateKey: vapid.privateKey, cronToken: randomBytes(32).toString('base64url'),
  startedAt: new Date().toISOString(), functionUrl: config.url, anonKey: config.key };
await fs.writeFile(process.argv[2], JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log('Created private settings. No credential values printed.');
