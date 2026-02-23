import { subscribePush } from "./relay";
import { publicKey, secretKey } from "./store";

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

/** Check if push notifications are currently active. */
export async function isPushEnabled(): Promise<boolean> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub !== null;
}

/** Fire a local test notification via the service worker. */
export async function sendTestNotification(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification("Paper Hearts", {
    body: "Your partner wrote today",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: "test-notification",
  });
}

/** Unsubscribe from push notifications. */
export async function unregisterPush(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) await sub.unsubscribe();
}

/**
 * Request notification permission and register the push subscription with the server.
 * No-ops if VAPID key isn't configured, permission is denied, or SW isn't available.
 */
export async function registerPush(): Promise<void> {
  if (!VAPID_PUBLIC_KEY || !("serviceWorker" in navigator) || !("PushManager" in window)) return;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return;

  const pk = publicKey();
  const sk = secretKey();
  if (!pk || !sk) return;

  const reg = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY).buffer as ArrayBuffer,
  });

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys) return;

  await subscribePush(
    { endpoint: json.endpoint, keys: json.keys as { p256dh: string; auth: string } },
    pk,
    sk
  );
}
