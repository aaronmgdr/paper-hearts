import sodium from "libsodium-wrappers-sumo";
import sql from "../db";
import { verifyRequest, AuthError } from "../auth";

await sodium.ready;

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * POST /api/pairs/initiate
 * Unauthenticated. Creates a new pair and returns a relay token.
 */
export async function initiate(req: Request): Promise<Response> {
  const body = await req.json();
  const { publicKey } = body;

  if (!publicKey || typeof publicKey !== "string") {
    return Response.json({ error: "publicKey is required" }, { status: 400 });
  }

  // Validate it's a valid base64 Ed25519 public key
  try {
    const keyBytes = sodium.from_base64(
      publicKey,
      sodium.base64_variants.ORIGINAL
    );
    if (keyBytes.length !== sodium.crypto_sign_PUBLICKEYBYTES) {
      return Response.json({ error: "Invalid public key length" }, { status: 400 });
    }
  } catch {
    return Response.json({ error: "Invalid base64 public key" }, { status: 400 });
  }

  console.log(`[initiate] publicKey=${publicKey.slice(0, 8)}…`);

  // Check if this key is already registered
  const existing = await sql`SELECT public_key FROM users WHERE public_key = ${publicKey}`;
  if (existing.length > 0) {
    console.log(`[initiate] REJECTED: key already registered`);
    return Response.json({ error: "Public key already registered" }, { status: 409 });
  }

  // Create pair, register user, generate token — all in a transaction
  const result = await sql.begin(async (tx) => {
    const [pair] = await tx`INSERT INTO pairs DEFAULT VALUES RETURNING id`;

    await tx`
      INSERT INTO users (public_key, pair_id)
      VALUES (${publicKey}, ${pair.id})
    `;

    // Generate cryptographically random relay token
    const tokenBytes = sodium.randombytes_buf(32);
    const token = sodium.to_base64(tokenBytes, sodium.base64_variants.URLSAFE_NO_PADDING);

    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    await tx`
      INSERT INTO relay_tokens (token, initiator_key, pair_id, expires_at)
      VALUES (${token}, ${publicKey}, ${pair.id}, ${expiresAt})
    `;

    return { pairId: pair.id, relayToken: token };
  });

  console.log(`[initiate] OK pairId=${result.pairId} token=${result.relayToken.slice(0, 8)}…`);
  return Response.json(result, { status: 201 });
}

/**
 * POST /api/pairs/join
 * Unauthenticated. Redeems a relay token to join an existing pair.
 */
export async function join(req: Request): Promise<Response> {
  const body = await req.json();
  const { publicKey, relayToken } = body;

  console.log(`[join] publicKey=${publicKey?.slice(0, 8)}… token=${relayToken?.slice(0, 8)}…`);

  if (!publicKey || typeof publicKey !== "string") {
    return Response.json({ error: "publicKey is required" }, { status: 400 });
  }
  if (!relayToken || typeof relayToken !== "string") {
    return Response.json({ error: "relayToken is required" }, { status: 400 });
  }

  // Validate public key format
  try {
    const keyBytes = sodium.from_base64(
      publicKey,
      sodium.base64_variants.ORIGINAL
    );
    if (keyBytes.length !== sodium.crypto_sign_PUBLICKEYBYTES) {
      return Response.json({ error: "Invalid public key length" }, { status: 400 });
    }
  } catch {
    return Response.json({ error: "Invalid base64 public key" }, { status: 400 });
  }

  // Look up and validate the token
  const tokens = await sql`
    SELECT token, initiator_key, pair_id, expires_at, consumed
    FROM relay_tokens
    WHERE token = ${relayToken}
  `;

  if (tokens.length === 0) {
    console.log(`[join] REJECTED: token not found`);
    return Response.json({ error: "Invalid relay token" }, { status: 404 });
  }

  const tokenRow = tokens[0];
  console.log(`[join] token found: pairId=${tokenRow.pair_id} consumed=${tokenRow.consumed} expires=${tokenRow.expires_at}`);

  if (tokenRow.consumed) {
    console.log(`[join] REJECTED: token already consumed`);
    return Response.json({ error: "Token already consumed" }, { status: 410 });
  }

  if (new Date(tokenRow.expires_at) < new Date()) {
    console.log(`[join] REJECTED: token expired`);
    return Response.json({ error: "Token expired" }, { status: 410 });
  }

  if (publicKey === tokenRow.initiator_key) {
    console.log(`[join] REJECTED: same key as initiator`);
    return Response.json({ error: "Cannot join your own pair" }, { status: 400 });
  }

  // Register follower and consume token in a transaction
  const result = await sql.begin(async (tx) => {
    await tx`
      INSERT INTO users (public_key, pair_id)
      VALUES (${publicKey}, ${tokenRow.pair_id})
    `;

    await tx`
      UPDATE relay_tokens SET consumed = true WHERE token = ${relayToken}
    `;

    return {
      pairId: tokenRow.pair_id,
      partnerPublicKey: tokenRow.initiator_key,
    };
  });

  console.log(`[join] OK pairId=${result.pairId} partnerKey=${result.partnerPublicKey.slice(0, 8)}…`);
  return Response.json(result, { status: 200 });
}

/**
 * GET /api/pairs/status
 * Authenticated. Returns partner's public key if one has joined.
 * Used by the initiator to poll for follower completion.
 */
export async function pairStatus(req: Request, path: string): Promise<Response> {
  let auth;
  try {
    auth = await verifyRequest(req, path, null);
  } catch (e) {
    if (e instanceof AuthError) {
      return Response.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  console.log(`[pairStatus] user=${auth.publicKey.slice(0, 8)}… pairId=${auth.pairId}`);

  const partners = await sql`
    SELECT public_key FROM users
    WHERE pair_id = ${auth.pairId} AND public_key != ${auth.publicKey}
  `;

  if (partners.length === 0) {
    console.log(`[pairStatus] no partner yet`);
    return Response.json({ paired: false });
  }

  console.log(`[pairStatus] partner found: ${partners[0].public_key.slice(0, 8)}…`);
  return Response.json({
    paired: true,
    partnerPublicKey: partners[0].public_key,
  });
}
