import { verifyRequest, AuthError } from "../auth";

// In-memory ephemeral store — intentionally not persisted.
// Transfer window is seconds to minutes; a restart requires re-pairing.
const pending = new Map<string, { payload: string; expiresAt: number }>();
const TTL_MS = 30 * 60 * 1000;

// Prune expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pending) {
    if (now > val.expiresAt) pending.delete(key);
  }
}, 5 * 60 * 1000);

/**
 * POST /api/transfer
 * Initiator uploads an encrypted history bundle for their new partner to collect.
 */
export async function uploadTransfer(req: Request, path: string): Promise<Response> {
  const bodyBytes = new Uint8Array(await req.clone().arrayBuffer());

  let auth;
  try {
    auth = await verifyRequest(req, path, bodyBytes);
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const body = JSON.parse(new TextDecoder().decode(bodyBytes));
  if (!body.payload || typeof body.payload !== "string") {
    return Response.json({ error: "payload required" }, { status: 400 });
  }

  pending.set(auth.pairId, { payload: body.payload, expiresAt: Date.now() + TTL_MS });
  console.log(`[transfer] upload pairId=${auth.pairId} size=${body.payload.length}`);
  return Response.json({ ok: true });
}

/**
 * GET /api/transfer
 * Follower collects the bundle. Consumed on first successful download.
 */
export async function downloadTransfer(req: Request, path: string): Promise<Response> {
  let auth;
  try {
    auth = await verifyRequest(req, path, null);
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const entry = pending.get(auth.pairId);
  if (!entry || Date.now() > entry.expiresAt) {
    return Response.json({ payload: null });
  }

  pending.delete(auth.pairId);
  console.log(`[transfer] download pairId=${auth.pairId}`);
  return Response.json({ payload: entry.payload });
}
