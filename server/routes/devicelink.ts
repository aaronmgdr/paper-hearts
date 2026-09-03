import sodium from "libsodium-wrappers-sumo";
import { verifyRequest, AuthError } from "../auth";

await sodium.ready;

/**
 * Moving an account to a second phone means moving the Ed25519 private key,
 * which is a stronger thing to hand the relay than pairing ever asks of it.
 * So the relay is only a mailbox here:
 *
 *   1. The existing phone starts a session and shares the token (QR / link).
 *   2. The new phone generates a throwaway X25519 key pair and posts the
 *      public half against that token.
 *   3. Both phones show a six-digit code derived from the token and that
 *      public key. If the relay substituted a key of its own to read the
 *      bundle, the two codes differ and the user stops.
 *   4. The existing phone seals the bundle to the new phone's key
 *      (crypto_box_seal) and posts it. The relay stores ciphertext it has no
 *      key for, hands it over once, and forgets it.
 *
 * In memory on purpose — the window is a minute or two, and a restart should
 * cost a retry rather than leave key material on disk.
 */

interface LinkSession {
  ownerKey: string;
  ephemeralPublicKey: string | null;
  payload: string | null;
  expiresAt: number;
}

const sessions = new Map<string, LinkSession>();
const TTL_MS = 15 * 60 * 1000;
const MAX_PAYLOAD_CHARS = 8 * 1024 * 1024; // ~6 MB of bundle, base64

setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now > s.expiresAt) sessions.delete(token);
  }
}, 60 * 1000);

function live(token: string): LinkSession | null {
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return session;
}

async function auth(req: Request, path: string, bodyBytes: Uint8Array | null) {
  try {
    return { auth: await verifyRequest(req, path, bodyBytes), error: null as Response | null };
  } catch (e) {
    if (e instanceof AuthError) {
      return { auth: null, error: Response.json({ error: e.message }, { status: e.status }) };
    }
    throw e;
  }
}

/**
 * POST /api/device-link/start
 * Authenticated. The existing device opens a mailbox and gets its token.
 */
export async function startDeviceLink(req: Request, path: string): Promise<Response> {
  const { auth: a, error } = await auth(req, path, null);
  if (error) return error;

  const token = sodium.to_base64(
    sodium.randombytes_buf(32),
    sodium.base64_variants.URLSAFE_NO_PADDING
  );
  sessions.set(token, {
    ownerKey: a!.publicKey,
    ephemeralPublicKey: null,
    payload: null,
    expiresAt: Date.now() + TTL_MS,
  });

  console.log(`[devicelink] start owner=${a!.publicKey.slice(0, 8)}… token=${token.slice(0, 8)}…`);
  return Response.json({ token, expiresInMs: TTL_MS }, { status: 201 });
}

/**
 * POST /api/device-link/claim
 * Unauthenticated — the new device has no identity yet. Registers the
 * throwaway public key the bundle will be sealed to.
 */
export async function claimDeviceLink(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const token = body?.token;
  const ephemeralPublicKey = body?.ephemeralPublicKey;

  if (typeof token !== "string" || typeof ephemeralPublicKey !== "string") {
    return Response.json({ error: "token and ephemeralPublicKey are required" }, { status: 400 });
  }

  try {
    const bytes = sodium.from_base64(ephemeralPublicKey, sodium.base64_variants.ORIGINAL);
    if (bytes.length !== sodium.crypto_box_PUBLICKEYBYTES) {
      return Response.json({ error: "Invalid ephemeral key length" }, { status: 400 });
    }
  } catch {
    return Response.json({ error: "Invalid base64 ephemeral key" }, { status: 400 });
  }

  const session = live(token);
  if (!session) {
    return Response.json({ error: "This code has expired. Start again on your other phone." }, { status: 404 });
  }
  if (session.ephemeralPublicKey && session.ephemeralPublicKey !== ephemeralPublicKey) {
    // A second claimant would swap the key the bundle gets sealed to.
    return Response.json({ error: "This code is already in use." }, { status: 409 });
  }

  session.ephemeralPublicKey = ephemeralPublicKey;
  console.log(`[devicelink] claimed token=${token.slice(0, 8)}…`);
  return Response.json({ ok: true });
}

/**
 * GET /api/device-link?token=…
 * Authenticated, owner only. Polls for the new device's throwaway key.
 */
export async function getDeviceLink(req: Request, path: string): Promise<Response> {
  const { auth: a, error } = await auth(req, path, null);
  if (error) return error;

  const token = new URL(req.url).searchParams.get("token") || "";
  const session = live(token);
  if (!session) return Response.json({ error: "Link session not found" }, { status: 404 });
  if (session.ownerKey !== a!.publicKey) {
    return Response.json({ error: "Not your link session" }, { status: 403 });
  }

  return Response.json({
    ephemeralPublicKey: session.ephemeralPublicKey,
    collected: session.ephemeralPublicKey !== null && session.payload === null,
  });
}

/**
 * POST /api/device-link/payload
 * Authenticated, owner only. Deposits the sealed bundle.
 */
export async function putDeviceLinkPayload(req: Request, path: string): Promise<Response> {
  const bodyBytes = new Uint8Array(await req.clone().arrayBuffer());
  const { auth: a, error } = await auth(req, path, bodyBytes);
  if (error) return error;

  const body = JSON.parse(new TextDecoder().decode(bodyBytes));
  const { token, payload } = body;

  if (typeof token !== "string" || typeof payload !== "string") {
    return Response.json({ error: "token and payload are required" }, { status: 400 });
  }
  if (payload.length > MAX_PAYLOAD_CHARS) {
    return Response.json({ error: "Bundle too large" }, { status: 413 });
  }

  const session = live(token);
  if (!session) return Response.json({ error: "Link session not found" }, { status: 404 });
  if (session.ownerKey !== a!.publicKey) {
    return Response.json({ error: "Not your link session" }, { status: 403 });
  }
  if (!session.ephemeralPublicKey) {
    return Response.json({ error: "The other device hasn't joined yet" }, { status: 409 });
  }

  session.payload = payload;
  console.log(`[devicelink] payload stored token=${token.slice(0, 8)}… size=${payload.length}`);
  return Response.json({ ok: true });
}

/**
 * GET /api/device-link/payload?token=…
 * Unauthenticated — the new device still has no identity. Consumed on read.
 * The token is 256 bits of randomness and the payload is sealed to a key the
 * relay never held, so guessing a token buys an attacker ciphertext.
 */
export async function getDeviceLinkPayload(req: Request): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token") || "";
  const session = live(token);
  if (!session) return Response.json({ error: "Link session not found" }, { status: 404 });
  if (!session.payload) return Response.json({ payload: null });

  const payload = session.payload;
  sessions.delete(token);
  console.log(`[devicelink] payload collected token=${token.slice(0, 8)}…`);
  return Response.json({ payload });
}

/** Test seam — the sessions map is process-local. */
export function _resetDeviceLinks(): void {
  sessions.clear();
}
