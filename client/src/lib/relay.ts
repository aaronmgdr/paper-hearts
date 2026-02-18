import { sign, toBase64 } from "./crypto";

const BASE = "/api";

// ── Signing helper ──────────────────────────────────────────

async function signedHeaders(
  method: string,
  path: string,
  body: string | null,
  publicKey: Uint8Array,
  secretKey: Uint8Array
): Promise<Record<string, string>> {
  const timestamp = new Date().toISOString();

  const bodyHash = body
    ? Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))
        )
      )
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
    : "";

  const payload = `${method}\n${path}\n${timestamp}\n${bodyHash}`;
  const payloadBytes = new TextEncoder().encode(payload);
  const signature = sign(payloadBytes, secretKey);

  return {
    Authorization: `Signature ${toBase64(signature)}`,
    "X-Public-Key": toBase64(publicKey),
    "X-Timestamp": timestamp,
    "Content-Type": "application/json",
  };
}

// ── Unauthenticated endpoints ───────────────────────────────

export async function initiatePair(publicKeyB64: string) {
  const res = await fetch(`${BASE}/pairs/initiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: publicKeyB64 }),
  });
  return { status: res.status, data: await res.json() };
}

export async function joinPair(publicKeyB64: string, relayToken: string) {
  const res = await fetch(`${BASE}/pairs/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: publicKeyB64, relayToken }),
  });
  return { status: res.status, data: await res.json() };
}

export async function getPairStatus(
  publicKey: Uint8Array,
  secretKey: Uint8Array
) {
  const path = `${BASE}/pairs/status`;
  const headers = await signedHeaders("GET", path, null, publicKey, secretKey);
  const res = await fetch(path, { method: "GET", headers });
  return { status: res.status, data: await res.json() };
}

// ── Authenticated endpoints ─────────────────────────────────

export async function postEntry(
  dayId: string,
  payloadB64: string,
  publicKey: Uint8Array,
  secretKey: Uint8Array
) {
  const path = `${BASE}/entries`;
  const body = JSON.stringify({ dayId, payload: payloadB64 });
  const headers = await signedHeaders("POST", path, body, publicKey, secretKey);
  const res = await fetch(path, { method: "POST", headers, body });
  return { status: res.status, data: await res.json() };
}

export async function getEntries(
  since: string,
  publicKey: Uint8Array,
  secretKey: Uint8Array
) {
  const path = `${BASE}/entries?since=${since}`;
  const headers = await signedHeaders("GET", path, null, publicKey, secretKey);
  const res = await fetch(path, { method: "GET", headers });
  return { status: res.status, data: await res.json() };
}

export async function ackEntries(
  entryIds: string[],
  publicKey: Uint8Array,
  secretKey: Uint8Array
) {
  const path = `${BASE}/entries/ack`;
  const body = JSON.stringify({ entryIds });
  const headers = await signedHeaders("POST", path, body, publicKey, secretKey);
  const res = await fetch(path, { method: "POST", headers, body });
  return { status: res.status, data: await res.json() };
}
