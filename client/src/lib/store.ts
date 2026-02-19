import { createSignal } from "solid-js";
import type { EncryptedKey, PrfEncryptedKey } from "./crypto";
import * as relay from "./relay";
import * as storage from "./storage";
import { getDayId } from "./dayid";
import { enqueue, peekAll } from "./outbox";
import { flushOutbox, requestBackgroundSync } from "./sync";
import { registerPrfCredential, authenticateWithPrf } from "./webauthn";

const loadCrypto = () => import("./crypto");

// ── Reactive state ──────────────────────────────────────────

const [isReady, setIsReady] = createSignal(false);
const [isPaired, setIsPaired] = createSignal(false);
const [publicKey, setPublicKey] = createSignal<Uint8Array | null>(null);
const [secretKey, setSecretKey] = createSignal<Uint8Array | null>(null);
const [sharedSecret, setSharedSecret] = createSignal<Uint8Array | null>(null);
const [pendingCount, setPendingCount] = createSignal(0);
const [isOnline, setIsOnline] = createSignal(navigator.onLine);
const [unlockMethod, setUnlockMethod] = createSignal<"passphrase" | "biometrics" | null>(null);

export { isReady, isPaired, publicKey, secretKey, pendingCount, isOnline, unlockMethod };

export async function refreshPendingCount(): Promise<void> {
  const items = await peekAll();
  setPendingCount(items.length);
}

export function setupNetworkListeners(): void {
  window.addEventListener("online", () => {
    setIsOnline(true);
    if (isPaired()) {
      flushOutbox().catch(console.error);
      fetchAndDecryptEntries(getDayId()).catch(console.error);
    }
  });
  window.addEventListener("offline", () => setIsOnline(false));
}

// ── Helpers (moved from storage.ts to avoid its crypto dependency) ──

function identityToEncryptedKey(identity: storage.StoredIdentity, crypto: Awaited<ReturnType<typeof loadCrypto>>): EncryptedKey {
  return {
    salt: crypto.fromBase64(identity.encryptedKey.salt),
    nonce: crypto.fromBase64(identity.encryptedKey.nonce),
    ciphertext: crypto.fromBase64(identity.encryptedKey.ciphertext),
  };
}

function encryptedKeyToStorable(ek: EncryptedKey, crypto: Awaited<ReturnType<typeof loadCrypto>>) {
  return {
    salt: crypto.toBase64(ek.salt),
    nonce: crypto.toBase64(ek.nonce),
    ciphertext: crypto.toBase64(ek.ciphertext),
  };
}

// ── Init ────────────────────────────────────────────────────

export async function initialize(): Promise<void> {
  const crypto = await loadCrypto();
  await crypto.init();
  const identity = await storage.loadIdentity();
  if (identity) {
    setPublicKey(crypto.fromBase64(identity.publicKey));
    setIsPaired(!!identity.pairId && !!identity.partnerPublicKey);
    setUnlockMethod(identity.unlockMethod ?? "passphrase");
  }
  setIsReady(true);
}

// ── Unlock (decrypt secret key with passphrase) ─────────────

export async function unlock(passphrase: string): Promise<boolean> {
  const identity = await storage.loadIdentity();
  if (!identity) return false; 
  
  try {
    const crypto = await loadCrypto();
    const encKey = identityToEncryptedKey(identity, crypto);
    const sk = crypto.decryptSecretKey(encKey, passphrase);
    setSecretKey(sk);
    setPublicKey(crypto.fromBase64(identity.publicKey));

    if (identity.partnerPublicKey) {
      const partnerPk = crypto.fromBase64(identity.partnerPublicKey);
      setSharedSecret(
        crypto.computeSharedSecret(sk, crypto.fromBase64(identity.publicKey), partnerPk)
      );
    }
    return true;
  } catch {
    return false;
  }
}

// ── Biometric unlock (WebAuthn PRF) ─────────────────────────

/** Check if the stored identity has a PRF credential. */
export async function hasPrfCredential(): Promise<boolean> {
  const identity = await storage.loadIdentity();
  return !!identity?.prfEncryptedKey;
}

/** Unlock using WebAuthn PRF (biometric). Triggers biometric prompt. */
export async function unlockWithPrf(): Promise<boolean> {
  const identity = await storage.loadIdentity();
  if (!identity?.prfEncryptedKey) return false;

  try {
    const crypto = await loadCrypto();
    const credentialId = crypto.fromBase64(identity.prfEncryptedKey.credentialId);
    const prfKey = await authenticateWithPrf(credentialId);

    const encrypted: PrfEncryptedKey = {
      nonce: crypto.fromBase64(identity.prfEncryptedKey.nonce),
      ciphertext: crypto.fromBase64(identity.prfEncryptedKey.ciphertext),
    };
    const sk = crypto.decryptSecretKeyRaw(encrypted, prfKey);
    setSecretKey(sk);
    setPublicKey(crypto.fromBase64(identity.publicKey));

    if (identity.partnerPublicKey) {
      const partnerPk = crypto.fromBase64(identity.partnerPublicKey);
      setSharedSecret(
        crypto.computeSharedSecret(sk, crypto.fromBase64(identity.publicKey), partnerPk)
      );
    }
    return true;
  } catch {
    return false;
  }
}

/** Enable biometric unlock. Secret key must already be in memory (after passphrase unlock). */
export async function enableBiometrics(): Promise<void> {
  const sk = secretKey();
  const pk = publicKey();
  if (!sk || !pk) throw new Error("Not unlocked");

  const crypto = await loadCrypto();
  const { credentialId, prfKey } = await registerPrfCredential(pk);
  const encrypted = crypto.encryptSecretKeyRaw(sk, prfKey);

  const identity = await storage.loadIdentity();
  if (!identity) throw new Error("No identity");

  identity.prfEncryptedKey = {
    credentialId: crypto.toBase64(credentialId),
    nonce: crypto.toBase64(encrypted.nonce),
    ciphertext: crypto.toBase64(encrypted.ciphertext),
  };
  await storage.saveIdentity(identity);
}

/** Change the passphrase. Returns false if the current passphrase is wrong. */
export async function changePassphrase(currentPassphrase: string, newPassphrase: string): Promise<boolean> {
  const identity = await storage.loadIdentity();
  if (!identity) return false;

  const crypto = await loadCrypto();

  // Verify the current passphrase
  try {
    const encKey = identityToEncryptedKey(identity, crypto);
    crypto.decryptSecretKey(encKey, currentPassphrase);
  } catch {
    return false;
  }

  // Re-encrypt with the new passphrase
  const sk = secretKey();
  if (!sk) return false;

  const newEncKey = crypto.encryptSecretKey(sk, newPassphrase);
  identity.encryptedKey = encryptedKeyToStorable(newEncKey, crypto);
  await storage.saveIdentity(identity);
  return true;
}

/** Disable biometric unlock. */
export async function disableBiometrics(): Promise<void> {
  const identity = await storage.loadIdentity();
  if (!identity) return;
  delete identity.prfEncryptedKey;
  await storage.saveIdentity(identity);
}

// ── Onboarding ──────────────────────────────────────────────

export async function createIdentity(passphrase: string): Promise<{ publicKeyB64: string }> {
  const crypto = await loadCrypto();
  await crypto.init();
  const kp = crypto.generateKeyPair();
  const encKey = crypto.encryptSecretKey(kp.secretKey, passphrase);
  const publicKeyB64 = crypto.toBase64(kp.publicKey);

  await storage.saveIdentity({
    publicKey: publicKeyB64,
    encryptedKey: encryptedKeyToStorable(encKey, crypto),
    pairId: null,
    partnerPublicKey: null,
  });

  setPublicKey(kp.publicKey);
  setSecretKey(kp.secretKey);
  return { publicKeyB64 };
}

/** Create an identity protected only by biometrics (no user-facing passphrase). */
export async function createBiometricsOnlyIdentity(): Promise<void> {
  // Generate a random internal passphrase — the user never sees this
  const randomBytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(randomBytes);
  const internalPassphrase = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  await createIdentity(internalPassphrase);

  // Mark identity as biometrics-only
  const identity = await storage.loadIdentity();
  if (identity) {
    identity.unlockMethod = "biometrics";
    await storage.saveIdentity(identity);
  }
  setUnlockMethod("biometrics");

  // Enroll the PRF/biometric credential
  await enableBiometrics();
}

export async function initiateHandshake(): Promise<{ relayToken: string; pairId: string }> {
  const pk = publicKey();
  if (!pk) throw new Error("No identity");
  const crypto = await loadCrypto();
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
  const crypto = await loadCrypto();
  const pkB64 = crypto.toBase64(pk);
  const { status, data } = await relay.joinPair(pkB64, relayToken);
  if (status !== 200) throw new Error(data.error || "Failed to join pair");

  const partnerPk = crypto.fromBase64(data.partnerPublicKey);
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
  const crypto = await loadCrypto();
  const partnerPk = crypto.fromBase64(partnerPublicKeyB64);
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

export async function submitEntry(text: string, dayId: string): Promise<void> {
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

  const crypto = await loadCrypto();
  const plaintext = JSON.stringify({
    text,
    format: "markdown",
    timestamp: new Date().toISOString(),
  });

  const encrypted = crypto.encrypt(plaintext, ss);
  const payloadB64 = crypto.toBase64(encrypted);

  await enqueue(dayId, payloadB64);
  await refreshPendingCount();
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
  const crypto = await loadCrypto();

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

export async function breakupAndForget(): Promise<void> {
  const pk = publicKey();
  const sk = secretKey();

  // Best-effort server deletion — don't block on failure
  if (pk && sk) {
    relay.deleteAccount(pk, sk).catch(console.error);
  }

  // Clear all local OPFS data
  await storage.clearAllLocalData();

  // Drop the IndexedDB outbox
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("paper-hearts-outbox");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
  });

  // Clear session storage
  sessionStorage.clear();

  // Reset all reactive state
  setPublicKey(null);
  setSecretKey(null);
  setSharedSecret(null);
  setIsPaired(false);
  setIsReady(false);
  setPendingCount(0);
  window.location.assign("/onboarding");
  window.location.reload();
}
