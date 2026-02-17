import sodium from "libsodium-wrappers-sumo";
import { getBaseUrl } from "./setup";

await sodium.ready;

/** Generate an Ed25519 key pair, returned as base64 strings + raw secret */
export function generateKeyPair() {
  const kp = sodium.crypto_sign_keypair();
  return {
    publicKey: sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL),
    secretKey: kp.privateKey,
  };
}

/** Sign a request and return headers for authenticated endpoints */
export async function signedHeaders(
  method: string,
  path: string,
  body: string | null,
  publicKeyB64: string,
  secretKey: Uint8Array
): Promise<Record<string, string>> {
  const timestamp = new Date().toISOString();

  const bodyHash = body
    ? Buffer.from(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))
      ).toString("hex")
    : "";

  const payload = `${method}\n${path}\n${timestamp}\n${bodyHash}`;
  const payloadBytes = new TextEncoder().encode(payload);

  const signature = sodium.crypto_sign_detached(payloadBytes, secretKey);
  const signatureB64 = sodium.to_base64(
    signature,
    sodium.base64_variants.ORIGINAL
  );

  return {
    Authorization: `Signature ${signatureB64}`,
    "X-Public-Key": publicKeyB64,
    "X-Timestamp": timestamp,
    "Content-Type": "application/json",
  };
}

/** POST helper (unauthenticated) */
export async function post(path: string, body: object, headers?: Record<string, string>) {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, any> };
}

/** Authenticated POST helper */
export async function authPost(
  path: string,
  body: object,
  publicKeyB64: string,
  secretKey: Uint8Array
) {
  const bodyStr = JSON.stringify(body);
  const headers = await signedHeaders("POST", path, bodyStr, publicKeyB64, secretKey);
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: "POST",
    headers,
    body: bodyStr,
  });
  return { status: res.status, data: (await res.json()) as Record<string, any> };
}

/** Authenticated GET helper */
export async function authGet(
  path: string,
  publicKeyB64: string,
  secretKey: Uint8Array
) {
  const headers = await signedHeaders("GET", path, null, publicKeyB64, secretKey);
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: "GET",
    headers,
  });
  return { status: res.status, data: (await res.json()) as Record<string, any> };
}

/** Create a paired couple — returns both key pairs + pairId */
export async function createPair() {
  const initiator = generateKeyPair();
  const follower = generateKeyPair();

  const initRes = await post("/api/pairs/initiate", {
    publicKey: initiator.publicKey,
  });

  await post("/api/pairs/join", {
    publicKey: follower.publicKey,
    relayToken: initRes.data.relayToken,
  });

  return { initiator, follower, pairId: initRes.data.pairId };
}

/** Today's dayId in YYYY-MM-DD format */
export function todayDayId(): string {
  return new Date().toISOString().slice(0, 10);
}
