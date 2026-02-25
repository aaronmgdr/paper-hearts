import sql from "../db";
import { verifyRequest, AuthError } from "../auth";
import { notifyPartner } from "../push";

const MAX_BLOBS_PER_DAY = 2

/**
 * POST /api/entries
 * Authenticated. Upload an encrypted entry blob.
 */
export async function createEntry(req: Request, path: string): Promise<Response> {
  const bodyBytes = new Uint8Array(await req.clone().arrayBuffer());

  let auth;
  try {
    auth = await verifyRequest(req, path, bodyBytes);
  } catch (e) {
    if (e instanceof AuthError) {
      return Response.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const body = JSON.parse(new TextDecoder().decode(bodyBytes));
  const { dayId, payload } = body;

  console.log(`[createEntry] user=${auth.publicKey.slice(0, 8)}… dayId=${dayId} payloadLen=${payload?.length ?? 0}`);

  if (!dayId || typeof dayId !== "string") {
    return Response.json({ error: "dayId is required" }, { status: 400 });
  }
  if (!payload || typeof payload !== "string") {
    return Response.json({ error: "payload is required" }, { status: 400 });
  }

  // Validate dayId format (YYYY-MM-DD)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayId)) {
    return Response.json({ error: "dayId must be YYYY-MM-DD" }, { status: 400 });
  }

  // Rate limit: max entries per dayId per key
  const [countResult] = await sql`
    SELECT COUNT(*)::int AS count FROM entries
    WHERE author_key = ${auth.publicKey} AND day_id = ${dayId}
  `;
  if (countResult.count >= MAX_BLOBS_PER_DAY) {
    return Response.json(
      { error: `Rate limit: max ${MAX_BLOBS_PER_DAY} entries per day` },
      { status: 429 }
    );
  }

  // Store the encrypted blob
  const payloadBytes = Buffer.from(payload, "base64");
  const [entry] = await sql`
    INSERT INTO entries (author_key, pair_id, day_id, payload)
    VALUES (${auth.publicKey}, ${auth.pairId}, ${dayId}, ${payloadBytes})
    RETURNING id
  `;

  console.log(`[createEntry] OK id=${entry.id}`);
  console.time(`notifyPartner for pairId=${auth.pairId}`);
  // Notify partner (fire-and-forget)
  notifyPartner(auth.publicKey, auth.pairId).then(() => {
    console.timeEnd(`notifyPartner for pairId=${auth.pairId}`);
  }).catch((e) =>
    console.error("[createEntry] push error:", e)
  );

  return Response.json({ id: entry.id, status: "stored" }, { status: 201 });
}

/**
 * GET /api/entries?since={dayId}
 * Authenticated. Fetch undelivered entries from partner.
 */
export async function getEntries(req: Request, path: string): Promise<Response> {
  let auth;
  try {
    auth = await verifyRequest(req, path, null);
  } catch (e) {
    if (e instanceof AuthError) {
      return Response.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const url = new URL(req.url);
  const since = url.searchParams.get("since") || "1970-01-01";
  console.log(`[getEntries] user=${auth.publicKey.slice(0, 8)}… since=${since}`);

  // Find the partner's public key
  const partners = await sql`
    SELECT public_key FROM users
    WHERE pair_id = ${auth.pairId} AND public_key != ${auth.publicKey}
  `;

  if (partners.length === 0) {
    return Response.json({ entries: [] });
  }

  const partnerKey = partners[0].public_key;

  // Fetch unacked entries from partner
  const entries = await sql`
    SELECT id, day_id, payload, fetched_at FROM entries
    WHERE pair_id = ${auth.pairId}
      AND author_key = ${partnerKey}
      AND day_id >= ${since}
      AND acked_at IS NULL
    ORDER BY day_id ASC
  `;

  // Mark as fetched
  const unfetchedIds = entries
    .filter((e) => !e.fetched_at)
    .map((e) => e.id);

  if (unfetchedIds.length > 0) {
    await sql`
      UPDATE entries SET fetched_at = now()
      WHERE id = ANY(${unfetchedIds})
    `;
  }

  const result = entries.map((e) => ({
    id: e.id,
    dayId: typeof e.day_id === "string" ? e.day_id.slice(0, 10) : new Date(e.day_id).toISOString().slice(0, 10),
    payload: Buffer.from(e.payload).toString("base64"),
  }));

  console.log(`[getEntries] returning ${result.length} entries`);
  return Response.json({ entries: result });
}

/**
 * POST /api/entries/ack
 * Authenticated. Confirm receipt of entries — server deletes them.
 */
export async function ackEntries(req: Request, path: string): Promise<Response> {
  const bodyBytes = new Uint8Array(await req.clone().arrayBuffer());

  let auth;
  try {
    auth = await verifyRequest(req, path, bodyBytes);
  } catch (e) {
    if (e instanceof AuthError) {
      return Response.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const body = JSON.parse(new TextDecoder().decode(bodyBytes));
  const { entryIds } = body;

  console.log(`[ackEntries] user=${auth.publicKey.slice(0, 8)}… ids=${JSON.stringify(entryIds)}`);

  if (!Array.isArray(entryIds) || entryIds.length === 0) {
    return Response.json({ error: "entryIds array is required" }, { status: 400 });
  }

  // Find partner's key to verify we're only acking entries from partner
  const partners = await sql`
    SELECT public_key FROM users
    WHERE pair_id = ${auth.pairId} AND public_key != ${auth.publicKey}
  `;

  if (partners.length === 0) {
    return Response.json({ error: "No partner found" }, { status: 400 });
  }

  const partnerKey = partners[0].public_key;

  // Delete entries that belong to this pair and were authored by partner
  const deleted = await sql`
    DELETE FROM entries
    WHERE id = ANY(${entryIds})
      AND pair_id = ${auth.pairId}
      AND author_key = ${partnerKey}
    RETURNING id
  `;

  console.log(`[ackEntries] deleted ${deleted.length}`);
  return Response.json({ deleted: deleted.length });
}
