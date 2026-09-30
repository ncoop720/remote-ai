import { api } from './api';

export type PushState = 'unsupported' | 'insecure' | 'install-first' | 'denied' | 'off' | 'on';

const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

export function registerServiceWorker(): void {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  return navigator.serviceWorker.getRegistration('/');
}

export async function pushState(): Promise<PushState> {
  if (!window.isSecureContext) return 'insecure';
  if (!('serviceWorker' in navigator)) return 'unsupported';
  // iPhones only offer push to web apps added to the Home Screen.
  if (!('PushManager' in window)) return isIos() && !isStandalone() ? 'install-first' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export async function enablePush(): Promise<void> {
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications were not allowed');
  const reg = (await registration()) ?? (await navigator.serviceWorker.register('/sw.js'));
  await navigator.serviceWorker.ready;
  // A subscription made with older server keys can't be reused.
  await (await reg.pushManager.getSubscription())?.unsubscribe();
  const { publicKey } = await api.pushInfo();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api.pushSubscribe(sub.toJSON());
}

export async function disablePush(): Promise<void> {
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe();
}

export const PUSH_HINT: Partial<Record<PushState, string>> = {
  insecure: 'Notifications need a secure page: open the dashboard over https (e.g. tailscale serve) or on localhost.',
  unsupported: "This browser can't receive push notifications.",
  'install-first': 'On iPhone, add this page to your Home Screen (Share → Add to Home Screen), open it from there, then turn notifications on.',
  denied: 'Notifications are blocked for this site. Allow them in the browser’s site settings, then try again.',
};
