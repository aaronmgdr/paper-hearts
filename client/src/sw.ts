/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { StaleWhileRevalidate } from "workbox-strategies";
import { clientsClaim } from "workbox-core";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// Take control of all clients immediately when a new SW activates
clientsClaim();

// Allow the vite-plugin-pwa autoUpdate flow to activate this SW
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

interface SyncEvent extends ExtendableEvent {
  tag: string;
}

// Precache static assets injected by vite-plugin-pwa
precacheAndRoute(self.__WB_MANIFEST);

// SPA offline support: serve cached index.html for all navigation requests
// (e.g. opening the app directly to /settings while offline)
registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html")));

// Cache Google Fonts responses so the app looks right offline
registerRoute(
  ({ url }) =>
    url.origin === "https://fonts.googleapis.com" ||
    url.origin === "https://fonts.gstatic.com",
  new StaleWhileRevalidate({ cacheName: "google-fonts" })
);

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
    Promise.all([
      self.registration.showNotification("Paper Hearts", {
        body: "Your partner wrote today",
        icon: "/icons/icon-192x192.png",
        badge: "/icons/icon-192x192.png",
        tag: "partner-entry",
      }),
      notifyClientsToFetch(),
    ])
  );
}) as EventListener);

async function notifyClientsToFetch(): Promise<void> {
  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) {
    client.postMessage({ type: "fetch-entries" });
  }
}

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
