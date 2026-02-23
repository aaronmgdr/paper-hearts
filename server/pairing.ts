import sodium from "libsodium-wrappers-sumo";
import sql from "./db";
import type { ServerWebSocket } from "bun";

await sodium.ready;

const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000;

export interface WsData {
  pairId: string | null;
}

// In-memory map of pairId → waiting WebSocket (initiator)
const waiting = new Map<string, ServerWebSocket<WsData>>();

/**
 * Authenticate a WebSocket auth message and register the connection.
 * Called from the WS message handler on first message.
 * Signed payload: "WATCH\n{publicKey}\n{timestamp}"
 */
export async function handleWsAuth(ws: ServerWebSocket<WsData>, msg: unknown): Promise<void> {
  const { publicKey: pkB64, timestamp, signature } = msg as Record<string, string>;

  // Validate timestamp freshness
  const tsDate = new Date(timestamp);
  if (isNaN(tsDate.getTime()) || Date.now() - tsDate.getTime() > MAX_TIMESTAMP_AGE_MS) {
    ws.send(JSON.stringify({ type: "error", message: "Timestamp invalid or expired" }));
    ws.close();
    return;
  }

  // Verify Ed25519 signature
  try {
    const pkBytes = sodium.from_base64(pkB64, sodium.base64_variants.ORIGINAL);
    const sigBytes = sodium.from_base64(signature, sodium.base64_variants.ORIGINAL);
    const payload = `WATCH\n${pkB64}\n${timestamp}`;
    if (!sodium.crypto_sign_verify_detached(sigBytes, new TextEncoder().encode(payload), pkBytes)) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid signature" }));
      ws.close();
      return;
    }
  } catch {
    ws.send(JSON.stringify({ type: "error", message: "Invalid key or signature format" }));
    ws.close();
    return;
  }

  // Look up user
  const users = await sql`SELECT pair_id FROM users WHERE public_key = ${pkB64}`;
  if (users.length === 0) {
    ws.send(JSON.stringify({ type: "error", message: "Unknown user" }));
    ws.close();
    return;
  }

  const pairId = users[0].pair_id;
  ws.data.pairId = pairId;
  waiting.set(pairId, ws);
  console.log(`[watch] registered pairId=${pairId} key=${pkB64.slice(0, 8)}…`);
  ws.send(JSON.stringify({ type: "ready" }));
}

/**
 * Push paired notification to the waiting initiator WebSocket.
 * Called by join() after follower successfully joins.
 */
export function notifyPaired(pairId: string, partnerPublicKey: string): void {
  const ws = waiting.get(pairId);
  if (!ws) return;
  try {
    ws.send(JSON.stringify({ type: "paired", partnerPublicKey }));
    ws.close();
  } catch { /* already closed */ }
  waiting.delete(pairId);
  console.log(`[watch] notified pairId=${pairId}`);
}

/** Remove a waiting connection on disconnect. */
export function removeWaiting(pairId: string): void {
  waiting.delete(pairId);
}
