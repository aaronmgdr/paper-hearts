import { peekAll, remove } from "./outbox";
import { signedHeaders } from "./relay";
import { publicKey, secretKey } from "./store";

const API_ENTRIES = "/api/entries";

/**
 * Flush all pending outbox items: sign fresh and POST to relay.
 * Silently skips if keys aren't available. Removes items on success.
 */
export async function flushOutbox(): Promise<void> {
  const pk = publicKey();
  const sk = secretKey();
  if (!pk || !sk) return;

  const items = await peekAll();
  for (const item of items) {
    try {
      const body = JSON.stringify({ dayId: item.dayId, payload: item.payloadB64 });
      const headers = await signedHeaders("POST", API_ENTRIES, body, pk, sk);
      const res = await fetch(API_ENTRIES, { method: "POST", headers, body });
      if (res.ok) {
        await remove(item.id);
      }
    } catch {
      // Network error — item stays in outbox for next flush
    }
  }
}

/** Register BackgroundSync tag (Android/Chrome only, no-op on Safari). */
export async function requestBackgroundSync(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await (reg as any).sync?.register("outbox");
  } catch {
    // BackgroundSync not supported — rely on flush-on-open
  }
}

/** Listen for SW messages requesting a flush. */
export function listenForSyncMessages(): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "flush-outbox") {
      flushOutbox().catch(console.error);
    }
  });
}
