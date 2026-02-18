/// <reference lib="webworker" />
import { precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

interface SyncEvent extends ExtendableEvent {
  tag: string;
}

// Precache static assets injected by vite-plugin-pwa
precacheAndRoute(self.__WB_MANIFEST);

// BackgroundSync: when connectivity returns, ask a client to flush the outbox
self.addEventListener("sync", ((event: SyncEvent) => {
  if (event.tag === "outbox") {
    event.waitUntil(notifyClientsToFlush());
  }
}) as EventListener);

async function notifyClientsToFlush(): Promise<void> {
  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) {
    client.postMessage({ type: "flush-outbox" });
  }
}

// Push notifications from server
self.addEventListener("push", ((event: PushEvent) => {
  event.waitUntil(
    self.registration.showNotification("Paper Hearts", {
      body: "Your partner wrote today",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "partner-entry",
    })
  );
}) as EventListener);

// Notification click: focus or open the app
self.addEventListener("notificationclick", ((event: NotificationEvent) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      const existing = clients.find((c) => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return self.clients.openWindow("/");
    })
  );
}) as EventListener);
