import sodium from "libsodium-wrappers-sumo";
import sql from "./db";

await sodium.ready;

const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000; // 5 minutes

interface AuthResult {
  publicKey: string;
  pairId: string;
}

/**
 * Verify Ed25519 signature on an authenticated request.
 *
 * Expected headers:
 *   Authorization: Signature <base64-signature>
 *   X-Public-Key: <base64-ed25519-public-key>
 *   X-Timestamp: <ISO-8601-timestamp>
 *
 * Signed payload: ${method}\n${path}\n${timestamp}\n${bodyHash}
 * bodyHash = SHA-256 hex of request body (empty string for GET)
 */
export async function verifyRequest(
  req: Request,
  path: string,
  bodyBytes: Uint8Array | null
): Promise<AuthResult> {
  const authHeader = req.headers.get("Authorization");
  const publicKeyB64 = req.headers.get("X-Public-Key");
  const timestamp = req.headers.get("X-Timestamp");

  if (!authHeader || !publicKeyB64 || !timestamp) {
    throw new AuthError("Missing auth headers", 401);
  }

  // Parse signature
  const match = authHeader.match(/^Signature\s+(.+)$/);
  if (!match) {
    throw new AuthError("Invalid Authorization header format", 401);
  }
  const signatureB64 = match[1];

  // Check timestamp freshness (replay protection)
  const tsDate = new Date(timestamp);
  if (isNaN(tsDate.getTime())) {
    throw new AuthError("Invalid timestamp", 401);
  }
  if (Date.now() - tsDate.getTime() > MAX_TIMESTAMP_AGE_MS) {
    throw new AuthError("Timestamp too old", 401);
  }

  // Reconstruct signed payload
  const bodyHash = bodyBytes
    ? Buffer.from(
        await crypto.subtle.digest("SHA-256", bodyBytes)
      ).toString("hex")
    : "";

  const payload = `${req.method}\n${path}\n${timestamp}\n${bodyHash}`;
  const payloadBytes = new TextEncoder().encode(payload);

  // Decode key and signature
  let publicKeyBytes: Uint8Array;
  let signatureBytes: Uint8Array;
  try {
    publicKeyBytes = sodium.from_base64(
      publicKeyB64,
      sodium.base64_variants.ORIGINAL
    );
    signatureBytes = sodium.from_base64(
      signatureB64,
      sodium.base64_variants.ORIGINAL
    );
  } catch {
    throw new AuthError("Invalid base64 in key or signature", 401);
  }

  if (publicKeyBytes.length !== sodium.crypto_sign_PUBLICKEYBYTES) {
    throw new AuthError("Invalid public key length", 401);
  }

  // Verify Ed25519 signature
  const valid = sodium.crypto_sign_verify_detached(
    signatureBytes,
    payloadBytes,
    publicKeyBytes
  );
  if (!valid) {
    throw new AuthError("Invalid signature", 401);
  }

  // Look up user in database
  const users = await sql`
    SELECT public_key, pair_id FROM users WHERE public_key = ${publicKeyB64}
  `;
  if (users.length === 0) {
    throw new AuthError("Unknown public key", 401);
  }

  return {
    publicKey: users[0].public_key,
    pairId: users[0].pair_id,
  };
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
