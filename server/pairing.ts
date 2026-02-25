import sodium from "libsodium-wrappers-sumo";
import sql from "./db";
import type { ServerWebSocket } from "bun";

await sodium.ready;

const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000;

export interface WsData {
  pairId: string | null;
  role: "watcher" | "collector" | null;
}

// Initiator WebSockets (kept open after "paired" for bundle transfer)
const waiting = new Map<string, ServerWebSocket<WsData>>();

// Follower WebSockets waiting to receive a bundle
const collectors = new Map<string, ServerWebSocket<WsData>>();

// Bundles buffered when follower hasn't connected yet (TTL: 5 min)
const pendingBundles = new Map<string, { payload: string; expiresAt: number }>();
const BUNDLE_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingBundles) {
    if (now > val.expiresAt) pendingBundles.delete(key);
  }
}, 2 * 60 * 1000);

/** Shared auth validation for watcher and collector WebSockets. Returns pairId or null. */
async function verifyWsAuth(
  ws: ServerWebSocket<WsData>,
  msg: Record<string, string>,
  prefix: string
): Promise<string | null> {
  const { publicKey: pkB64, timestamp, signature } = msg;

  const tsDate = new Date(timestamp);
  if (isNaN(tsDate.getTime()) || Date.now() - tsDate.getTime() > MAX_TIMESTAMP_AGE_MS) {
    ws.send(JSON.stringify({ type: "error", message: "Timestamp invalid or expired" }));
    ws.close();
    return null;
  }

  try {
    const pkBytes = sodium.from_base64(pkB64, sodium.base64_variants.ORIGINAL);
    const sigBytes = sodium.from_base64(signature, sodium.base64_variants.ORIGINAL);
    const payload = `${prefix}\n${pkB64}\n${timestamp}`;
    if (!sodium.crypto_sign_verify_detached(sigBytes, new TextEncoder().encode(payload), pkBytes)) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid signature" }));
      ws.close();
      return null;
    }
  } catch {
    ws.send(JSON.stringify({ type: "error", message: "Invalid key or signature format" }));
    ws.close();
    return null;
  }

  const users = await sql`SELECT pair_id FROM users WHERE public_key = ${pkB64}`;
  if (users.length === 0) {
    ws.send(JSON.stringify({ type: "error", message: "Unknown user" }));
    ws.close();
    return null;
  }

  return users[0].pair_id as string;
}

/**
 * Authenticate an initiator (watcher) WebSocket.
 * Signed payload: "WATCH\n{publicKey}\n{timestamp}"
 */
export async function handleWsAuth(ws: ServerWebSocket<WsData>, msg: unknown): Promise<void> {
  const pairId = await verifyWsAuth(ws, msg as Record<string, string>, "WATCH");
  if (!pairId) return;

  ws.data.pairId = pairId;
  ws.data.role = "watcher";
  waiting.set(pairId, ws);
  console.log(`[watch] registered pairId=${pairId}`);
  ws.send(JSON.stringify({ type: "ready" }));
}

/**
 * Authenticate a follower (collector) WebSocket and deliver bundle if already buffered.
 * Signed payload: "COLLECT\n{publicKey}\n{timestamp}"
 */
export async function handleWsCollect(ws: ServerWebSocket<WsData>, msg: unknown): Promise<void> {
  const pairId = await verifyWsAuth(ws, msg as Record<string, string>, "COLLECT");
  if (!pairId) return;

  ws.data.pairId = pairId;
  ws.data.role = "collector";

  const pending = pendingBundles.get(pairId);
  if (pending && Date.now() <= pending.expiresAt) {
    pendingBundles.delete(pairId);
    ws.send(JSON.stringify({ type: "bundle", payload: pending.payload }));
    ws.close();
    console.log(`[watch] delivered buffered bundle to pairId=${pairId}`);
    return;
  }

  collectors.set(pairId, ws);
  ws.send(JSON.stringify({ type: "ready" }));
  console.log(`[watch] collector waiting pairId=${pairId}`);
}

/**
 * Handle bundle payload from initiator. Relays to follower if already
 * connected, otherwise buffers for 5 minutes.
 */
export function handleWsBundle(ws: ServerWebSocket<WsData>, payload: string): void {
  const pairId = ws.data.pairId;
  if (!pairId) return;

  const collector = collectors.get(pairId);
  if (collector) {
    collector.send(JSON.stringify({ type: "bundle", payload }));
    collector.close();
    collectors.delete(pairId);
    console.log(`[watch] relayed bundle live pairId=${pairId}`);
  } else {
    pendingBundles.set(pairId, { payload, expiresAt: Date.now() + BUNDLE_TTL_MS });
    console.log(`[watch] buffered bundle pairId=${pairId}`);
  }

  waiting.delete(pairId);
  ws.close();
}

/**
 * Notify initiator that follower has joined.
 * Does NOT close the WebSocket — kept open for optional bundle transfer.
 */
export function notifyPaired(pairId: string, partnerPublicKey: string): void {
  const ws = waiting.get(pairId);
  if (!ws) return;
  try {
    ws.send(JSON.stringify({ type: "paired", partnerPublicKey }));
    // Intentionally left open so initiator can send history bundle
  } catch { /* already closed */ }
  console.log(`[watch] notified pairId=${pairId}`);
}

/** Remove a waiting or collecting connection on disconnect. */
export function removeWaiting(ws: ServerWebSocket<WsData>): void {
  const pairId = ws.data.pairId;
  if (!pairId) return;
  if (ws.data.role === "watcher") {
    waiting.delete(pairId);
  } else if (ws.data.role === "collector") {
    collectors.delete(pairId);
  }
}
