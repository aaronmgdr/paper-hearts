import sql from "../db";
import { verifyRequest, AuthError } from "../auth";
import { notifyPartner } from "../push";
import { ENTRY_RETENTION_DAYS } from "../retention";


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

  // Upsert: one entry per author per day. On conflict, replace payload and
  // reset fetched_at/acked_at so partner re-receives the updated entry.
  const payloadBytes = Buffer.from(payload, "base64");
  const [entry] = await sql`
    INSERT INTO entries (author_key, pair_id, day_id, payload)
    VALUES (${auth.publicKey}, ${auth.pairId}, ${dayId}, ${payloadBytes})
    ON CONFLICT (author_key, day_id) DO UPDATE
      SET payload     = EXCLUDED.payload,
          pair_id     = EXCLUDED.pair_id,
          updated_at  = now(),
          fetched_at  = NULL,
          acked_at    = NULL
    RETURNING id, (updated_at IS NOT NULL AND xmax != 0) AS is_update
  `;

  const isUpdate = entry.is_update;
  console.log(`[createEntry] ${isUpdate ? "updated" : "created"} id=${entry.id}`);
  console.time(`notifyPartner for pairId=${auth.pairId}`);
  // Notify partner (fire-and-forget)
  notifyPartner(auth.publicKey, auth.pairId, isUpdate).then(() => {
    console.timeEnd(`notifyPartner for pairId=${auth.pairId}`);
  }).catch((e) =>
    console.error("[createEntry] push error:", e)
  );

  return Response.json({ id: entry.id, status: "stored" }, { status: 201 });
}

/**
 * GET /api/entries?since={dayId}&scope=all
 * Authenticated. Fetch the partner's entries, and with `scope=all` your own.
 *
 * Own entries have to come back for a second phone to work at all: those blobs
 * are authored by this public key, and two phones share a key rather than a
 * user row, so filtering them out leaves the second handset permanently blank.
 * Clients label each row `me` or `partner` and merge by author+day.
 *
 * `scope=all` is opt-in because clients before it ignored the label and filed
 * every returned row in the partner slot. The service worker precaches the app
 * shell and only swaps on SKIP_WAITING, so a cached older client keeps talking
 * to a new relay for at least one session — and on a day where only you had
 * written, your own blob would show up as your partner's and lift the veil.
 * Defaulting to partner-only keeps those clients correct until they update.
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
  const includeOwn = url.searchParams.get("scope") === "all";
  console.log(
    `[getEntries] user=${auth.publicKey.slice(0, 8)}… since=${since} scope=${includeOwn ? "all" : "partner"}`
  );

  // Everything in this pair inside the retention window, acknowledged or not.
  // Filtering on acked_at would hide an entry from a second device as soon as
  // the first collected it.
  const entries = await sql`
    SELECT id, author_key, day_id, payload, fetched_at FROM entries
    WHERE pair_id = ${auth.pairId}
      AND day_id >= ${since}
      AND created_at > now() - make_interval(days => ${ENTRY_RETENTION_DAYS})
      AND (${includeOwn} OR author_key != ${auth.publicKey})
    ORDER BY day_id ASC, author_key ASC
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
    author: e.author_key === auth.publicKey ? "me" : "partner",
  }));

  console.log(`[getEntries] returning ${result.length} entries`);
  return Response.json({ entries: result });
}

/**
 * POST /api/entries/ack
 * Authenticated. Confirm receipt of entries — marks them acknowledged.
 *
 * Acknowledging no longer deletes: the retention sweep does that, once the
 * window has passed and every device on the account has had a chance to
 * collect. See ENTRY_RETENTION_DAYS.
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

  // Only entries in this pair, authored by the partner
  const acked = await sql`
    UPDATE entries SET acked_at = now()
    WHERE id = ANY(${entryIds})
      AND pair_id = ${auth.pairId}
      AND author_key = ${partnerKey}
      AND acked_at IS NULL
    RETURNING id
  `;

  console.log(`[ackEntries] acknowledged ${acked.length}`);
  return Response.json({ acknowledged: acked.length });
}
