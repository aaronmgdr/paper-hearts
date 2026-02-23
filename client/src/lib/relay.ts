const BASE = "/api";

const loadCrypto = () => import("./crypto");

// ── Signing helper ──────────────────────────────────────────

export async function signedHeaders(
  method: string,
  path: string,
  body: string | null,
  publicKey: Uint8Array,
  secretKey: Uint8Array
): Promise<Record<string, string>> {
  const { sign, toBase64 } = await loadCrypto();
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

export async function deleteAccount(
  publicKey: Uint8Array,
  secretKey: Uint8Array
) {
  const path = `${BASE}/account`;
  const headers = await signedHeaders("DELETE", path, null, publicKey, secretKey);
  const res = await fetch(path, { method: "DELETE", headers });
  return res.status;
}

export async function uploadTransfer(
  payloadB64: string,
  publicKey: Uint8Array,
  secretKey: Uint8Array
) {
  const path = `${BASE}/transfer`;
  const body = JSON.stringify({ payload: payloadB64 });
  const headers = await signedHeaders("POST", path, body, publicKey, secretKey);
  const res = await fetch(path, { method: "POST", headers, body });
  return res.status;
}

export async function downloadTransfer(
  publicKey: Uint8Array,
  secretKey: Uint8Array
): Promise<{ payload: string | null }> {
  const path = `${BASE}/transfer`;
  const headers = await signedHeaders("GET", path, null, publicKey, secretKey);
  const res = await fetch(path, { method: "GET", headers });
  return res.json();
}

/**
 * Open a WebSocket to wait for partner to join. Returns a cleanup function.
 * Signed payload: "WATCH\n{publicKeyB64}\n{timestamp}"
 */
export function watchForPartner(
  publicKey: Uint8Array,
  secretKey: Uint8Array,
  onPaired: (partnerPublicKey: string) => void,
  onError: (err: Error) => void
): () => void {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${window.location.host}/api/pairs/watch`);
  console.info('watch partner')
  ws.onopen = async () => {
    const { sign, toBase64 } = await loadCrypto();
    const pkB64 = toBase64(publicKey);
    const timestamp = new Date().toISOString();
    const payload = `WATCH\n${pkB64}\n${timestamp}`;
    const signature = sign(new TextEncoder().encode(payload), secretKey);
    ws.send(JSON.stringify({ type: "auth", publicKey: pkB64, timestamp, signature: toBase64(signature) }));
  };

  ws.onmessage = (event) => {
    try {
      console.log('onMessage')
      const msg = JSON.parse(event.data as string);
      if (msg.type === "paired") onPaired(msg.partnerPublicKey);
      else if (msg.type === "error") onError(new Error(msg.message));
    } catch (e) {
      console.error("[watchForPartner] bad message:", e);
    }
  };

  ws.onerror = () => onError(new Error("WebSocket connection failed"));
  ws.onclose = (e) => { if (!e.wasClean) onError(new Error("WebSocket closed unexpectedly")); };

  return () => ws.close();
}

export async function subscribePush(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  publicKey: Uint8Array,
  secretKey: Uint8Array
) {
  const path = `${BASE}/push/subscribe`;
  const body = JSON.stringify(subscription);
  const headers = await signedHeaders("POST", path, body, publicKey, secretKey);
  const res = await fetch(path, { method: "POST", headers, body });
  return { status: res.status, data: await res.json() };
}
