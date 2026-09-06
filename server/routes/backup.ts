import sql from "../db";
import { verifyRequest, AuthError } from "../auth";

/**
 * Recovery backups.
 *
 * Every other route on this relay is reachable only by signing with a key that
 * lives on a phone. That is exactly the wrong shape for "we both lost our
 * phones": the credential is gone with the hardware. So a backup is addressed
 * by a locator the client derives from a recovery code the user wrote down,
 * and reading one needs nothing but that code.
 *
 * The relay never sees the code, the locator's sibling encryption key, or the
 * plaintext. What it can see is that some account has a backup and how big it
 * is. Uploading is authenticated so the table can't be filled by strangers;
 * reading is not, because by then there may be no key left to sign with.
 */

const MAX_PAYLOAD_BYTES = 12 * 1024 * 1024;

/**
 * PUT /api/backup
 * Authenticated. Creates or replaces this account's backup.
 */
export async function putBackup(req: Request, path: string): Promise<Response> {
  const bodyBytes = new Uint8Array(await req.clone().arrayBuffer());

  let auth;
  try {
    auth = await verifyRequest(req, path, bodyBytes);
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }

  let body: { locator?: unknown; payload?: unknown };
  try {
    body = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { locator, payload } = body;

  if (typeof locator !== "string" || locator.length < 16 || locator.length > 128) {
    return Response.json({ error: "locator is required" }, { status: 400 });
  }
  if (typeof payload !== "string" || payload.length === 0) {
    return Response.json({ error: "payload is required" }, { status: 400 });
  }

  const payloadBytes = Buffer.from(payload, "base64");
  if (payloadBytes.length > MAX_PAYLOAD_BYTES) {
    return Response.json({ error: "Backup too large" }, { status: 413 });
  }

  // One backup per account. Rotating the recovery code changes the locator, so
  // the old row has to go with it rather than linger as an orphan restorable
  // by a code the user believes they retired.
  //
  // A locator collision across accounts is vanishingly unlikely (256-bit
  // hash) but the previous upsert reassigned ownership and overwrote the
  // victim's ciphertext. Refuse that instead of taking their row.
  const stored = await sql.begin(async (tx) => {
    // @ts-expect-error — postgres TransactionSql inherits call signature from Sql but TS doesn't resolve it
    await tx`DELETE FROM backups WHERE owner_key = ${auth.publicKey} AND locator != ${locator}`;
    // @ts-expect-error — same
    const upserted = await tx`
      INSERT INTO backups (locator, owner_key, payload)
      VALUES (${locator}, ${auth.publicKey}, ${payloadBytes})
      ON CONFLICT (locator) DO UPDATE
        SET payload    = EXCLUDED.payload,
            updated_at = now()
        WHERE backups.owner_key = EXCLUDED.owner_key
      RETURNING locator
    `;
    return upserted;
  });

  if (stored.length === 0) {
    return Response.json({ error: "This recovery code is already in use" }, { status: 409 });
  }

  console.log(`[backup] stored owner=${auth.publicKey.slice(0, 8)}… bytes=${payloadBytes.length}`);
  return Response.json({ ok: true, updatedAt: new Date().toISOString() });
}

/**
 * GET /api/backup?locator=…
 * Unauthenticated by design — see the note at the top of this file. Throttled
 * per IP in index.ts, since there is no public key to throttle on.
 */
export async function getBackup(req: Request): Promise<Response> {
  const locator = new URL(req.url).searchParams.get("locator") || "";
  if (locator.length < 16 || locator.length > 128) {
    return Response.json({ error: "locator is required" }, { status: 400 });
  }

  const rows = await sql`
    SELECT payload, updated_at FROM backups WHERE locator = ${locator}
  `;
  if (rows.length === 0) {
    console.log(`[backup] miss locator=${locator.slice(0, 8)}…`);
    return Response.json({ error: "No backup found for that recovery code" }, { status: 404 });
  }

  console.log(`[backup] served locator=${locator.slice(0, 8)}…`);
  return Response.json({
    payload: Buffer.from(rows[0].payload).toString("base64"),
    updatedAt: rows[0].updated_at,
  });
}

/**
 * GET /api/backup/status
 * Authenticated. Whether this account has a backup, and how fresh it is.
 */
export async function backupStatus(req: Request, path: string): Promise<Response> {
  let auth;
  try {
    auth = await verifyRequest(req, path, null);
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const rows = await sql`
    SELECT updated_at, octet_length(payload) AS bytes
    FROM backups WHERE owner_key = ${auth.publicKey}
  `;
  if (rows.length === 0) return Response.json({ exists: false });

  return Response.json({
    exists: true,
    updatedAt: rows[0].updated_at,
    bytes: Number(rows[0].bytes),
  });
}

/**
 * DELETE /api/backup
 * Authenticated. Removes this account's backup.
 */
export async function deleteBackup(req: Request, path: string): Promise<Response> {
  let auth;
  try {
    auth = await verifyRequest(req, path, null);
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const deleted = await sql`
    DELETE FROM backups WHERE owner_key = ${auth.publicKey} RETURNING locator
  `;
  console.log(`[backup] deleted ${deleted.length} for ${auth.publicKey.slice(0, 8)}…`);
  return new Response(null, { status: 204 });
}
