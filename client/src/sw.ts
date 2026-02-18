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
