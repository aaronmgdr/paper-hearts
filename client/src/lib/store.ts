import { createSignal } from "solid-js";
import * as crypto from "./crypto";
import * as relay from "./relay";
import * as storage from "./storage";
import { getDayId } from "./dayid";
import { enqueue } from "./outbox";
import { flushOutbox, requestBackgroundSync } from "./sync";

// ── Reactive state ──────────────────────────────────────────

const [isReady, setIsReady] = createSignal(false);
const [isPaired, setIsPaired] = createSignal(false);
const [publicKey, setPublicKey] = createSignal<Uint8Array | null>(null);
const [secretKey, setSecretKey] = createSignal<Uint8Array | null>(null);
const [_partnerPublicKey, setPartnerPublicKey] = createSignal<Uint8Array | null>(null);
const [sharedSecret, setSharedSecret] = createSignal<Uint8Array | null>(null);

export { isReady, isPaired, publicKey, secretKey };

// ── Init ────────────────────────────────────────────────────

export async function initialize(): Promise<void> {
  await crypto.init();
  const identity = await storage.loadIdentity();
  if (identity) {
    setPublicKey(crypto.fromBase64(identity.publicKey));
    setIsPaired(!!identity.pairId && !!identity.partnerPublicKey);
    if (identity.partnerPublicKey) {
      setPartnerPublicKey(crypto.fromBase64(identity.partnerPublicKey));
    }
  }
  setIsReady(true);
}

// ── Unlock (decrypt secret key with passphrase) ─────────────

export async function unlock(passphrase: string): Promise<boolean> {
  const identity = await storage.loadIdentity();
  if (!identity) return false;

  try {
    const encKey = storage.identityToEncryptedKey(identity);
    const sk = crypto.decryptSecretKey(encKey, passphrase);
    setSecretKey(sk);
    setPublicKey(crypto.fromBase64(identity.publicKey));

    if (identity.partnerPublicKey) {
      const partnerPk = crypto.fromBase64(identity.partnerPublicKey);
      setPartnerPublicKey(partnerPk);
      setSharedSecret(
        crypto.computeSharedSecret(sk, crypto.fromBase64(identity.publicKey), partnerPk)
      );
    }
    return true;
  } catch {
    return false;
  }
}

// ── Onboarding ──────────────────────────────────────────────

export async function createIdentity(passphrase: string): Promise<{ publicKeyB64: string }> {
  await crypto.init();
  const kp = crypto.generateKeyPair();
  const encKey = crypto.encryptSecretKey(kp.secretKey, passphrase);
  const publicKeyB64 = crypto.toBase64(kp.publicKey);

  await storage.saveIdentity({
    publicKey: publicKeyB64,
    encryptedKey: storage.encryptedKeyToStorable(encKey),
    pairId: null,
    partnerPublicKey: null,
  });

  setPublicKey(kp.publicKey);
  setSecretKey(kp.secretKey);
  return { publicKeyB64 };
}

export async function initiateHandshake(): Promise<{ relayToken: string; pairId: string }> {
  const pk = publicKey();
  if (!pk) throw new Error("No identity");
  const pkB64 = crypto.toBase64(pk);
  const { status, data } = await relay.initiatePair(pkB64);
  if (status !== 201) throw new Error(data.error || "Failed to initiate pair");

  const identity = await storage.loadIdentity();
  if (identity) {
    identity.pairId = data.pairId;
    await storage.saveIdentity(identity);
  }

  return { relayToken: data.relayToken, pairId: data.pairId };
}

export async function joinHandshake(relayToken: string): Promise<{ partnerPublicKeyB64: string }> {
  const pk = publicKey();
  if (!pk) throw new Error("No identity");
  const pkB64 = crypto.toBase64(pk);
  const { status, data } = await relay.joinPair(pkB64, relayToken);
  if (status !== 200) throw new Error(data.error || "Failed to join pair");

  const partnerPk = crypto.fromBase64(data.partnerPublicKey);
  setPartnerPublicKey(partnerPk);
  setIsPaired(true);

  const sk = secretKey();
  if (sk) {
    setSharedSecret(crypto.computeSharedSecret(sk, pk, partnerPk));
  }

  const identity = await storage.loadIdentity();
  if (identity) {
    identity.pairId = data.pairId;
    identity.partnerPublicKey = data.partnerPublicKey;
    await storage.saveIdentity(identity);
  }

  return { partnerPublicKeyB64: data.partnerPublicKey };
}

/** Poll relay to check if follower has joined. Returns partner public key if paired. */
export async function pollForPartner(): Promise<string | null> {
  const pk = publicKey();
  const sk = secretKey();
  if (!pk || !sk) return null;

  const { status, data } = await relay.getPairStatus(pk, sk);
  if (status !== 200 || !data.paired) return null;

  await completeInitiatorPairing(data.partnerPublicKey);
  return data.partnerPublicKey;
}

/** Called by initiator after follower joins — we need to fetch partner's key. */
export async function completeInitiatorPairing(partnerPublicKeyB64: string): Promise<void> {
  const partnerPk = crypto.fromBase64(partnerPublicKeyB64);
  setPartnerPublicKey(partnerPk);
  setIsPaired(true);

  const pk = publicKey();
  const sk = secretKey();
  if (sk && pk) {
    setSharedSecret(crypto.computeSharedSecret(sk, pk, partnerPk));
  }

  const identity = await storage.loadIdentity();
  if (identity) {
    identity.partnerPublicKey = partnerPublicKeyB64;
    await storage.saveIdentity(identity);
  }
}

// ── Entries ─────────────────────────────────────────────────

export async function submitEntry(text: string): Promise<void> {
  const dayId = getDayId();

  // Save locally
  const existing = (await storage.loadDay(dayId)) || { entries: [] };
  existing.entries.push({
    dayId,
    author: "me",
    payload: text,
    timestamp: new Date().toISOString(),
  });
  await storage.saveDay(dayId, existing);

  // Encrypt and queue for relay
  const ss = sharedSecret();
  if (!ss) throw new Error("Not unlocked or not paired");

  const plaintext = JSON.stringify({
    text,
    format: "markdown",
    timestamp: new Date().toISOString(),
  });

  const encrypted = crypto.encrypt(plaintext, ss);
  const payloadB64 = crypto.toBase64(encrypted);

  await enqueue(dayId, payloadB64);
  requestBackgroundSync().catch(console.error);
  flushOutbox().catch(console.error);
}

export async function fetchAndDecryptEntries(since: string): Promise<void> {
  const pk = publicKey();
  const sk = secretKey();
  const ss = sharedSecret();
  if (!pk || !sk || !ss) throw new Error("Not unlocked or not paired");

  const { status, data } = await relay.getEntries(since, pk, sk);
  if (status !== 200) return;

  const entries = data.entries || [];
  const idsToAck: string[] = [];

  for (const entry of entries) {
    try {
      const encrypted = crypto.fromBase64(entry.payload);
      const plainJson = crypto.decrypt(encrypted, ss);
      const parsed = JSON.parse(plainJson);

      const dayId = entry.dayId;
      const existing = (await storage.loadDay(dayId)) || { entries: [] };

      // Don't add duplicates
      const hasPartnerEntry = existing.entries.some((e) => e.author === "partner");
      if (!hasPartnerEntry) {
        existing.entries.push({
          dayId,
          author: "partner",
          payload: parsed.text,
          timestamp: parsed.timestamp,
        });
        await storage.saveDay(dayId, existing);
      }

      idsToAck.push(entry.id);
    } catch (e) {
      console.error("Failed to decrypt entry:", e);
    }
  }

  if (idsToAck.length > 0) {
    await relay.ackEntries(idsToAck, pk, sk);
  }
}

export async function loadDayEntries(dayId: string): Promise<storage.DayFile | null> {
  return storage.loadDay(dayId);
}

export async function loadAllDays(): Promise<string[]> {
  return storage.listDays();
}
