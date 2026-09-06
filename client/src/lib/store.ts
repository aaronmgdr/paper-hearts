import { createSignal } from "solid-js";
import type { EncryptedKey, PrfEncryptedKey } from "./crypto";
import * as relay from "./relay";
import * as storage from "./storage";
import { getSyncSince, formatDayLabel } from "./dayid";
import { enqueue, replaceForDayId, peekAll, clearOutbox } from "./outbox";
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
const [entriesVersion, setEntriesVersion] = createSignal(0);
const [partnerName, setPartnerNameSignal] = createSignal("Partner");

export { isReady, isPaired, publicKey, secretKey, pendingCount, isOnline, unlockMethod, entriesVersion, partnerName };

export function bumpEntriesVersion() {
  setEntriesVersion((v) => v + 1);
}

export async function refreshPendingCount(): Promise<void> {
  const items = await peekAll();
  setPendingCount(items.length);
}

const REFRESH_DEBOUNCE_MS = 2000;
const FOREGROUND_POLL_MS = 30_000;

let lastRelayRefresh = 0;
let foregroundPoll: ReturnType<typeof setInterval> | undefined;

function refreshFromRelay(): void {
  if (!isPaired()) return;
  const now = Date.now();
  // iOS fires visibilitychange + pageshow + focus together when returning
  // from the app switcher; one fetch is enough.
  if (now - lastRelayRefresh < REFRESH_DEBOUNCE_MS) return;
  lastRelayRefresh = now;
  flushOutbox().catch(console.error);
  fetchAndDecryptEntries(getSyncSince(), { sync: "incremental" })
    .then(() => bumpEntriesVersion())
    .catch(console.error);
}

function startForegroundPoll(): void {
  if (foregroundPoll) return;
  foregroundPoll = setInterval(() => {
    if (document.visibilityState === "visible") refreshFromRelay();
  }, FOREGROUND_POLL_MS);
}

function stopForegroundPoll(): void {
  if (!foregroundPoll) return;
  clearInterval(foregroundPoll);
  foregroundPoll = undefined;
}

export function setupNetworkListeners(): void {
  window.addEventListener("online", () => {
    setIsOnline(true);
    console.info("Network reconnected, flushing outbox and refreshing entries");
    refreshFromRelay();
  });
  window.addEventListener("offline", () => setIsOnline(false));
  // A second phone has no Background Sync and often no push of its own
  // (notifications stay on one device). iOS also freezes timers in the
  // background, so catch-up happens on open, foreground, and a poll while visible.
  const onForeground = () => {
    refreshFromRelay();
    startForegroundPoll();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onForeground();
    else stopForegroundPoll();
  });
  window.addEventListener("pageshow", onForeground);
  window.addEventListener("focus", () => refreshFromRelay());
  if (document.visibilityState === "visible") startForegroundPoll();
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
    if (identity.partnerName) setPartnerNameSignal(identity.partnerName);
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
  } catch (e) {
    console.error("[unlock]", e);
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
  } catch (e) {
    console.error("[unlockWithPrf]", e);
    return false;
  }
}

/** Enable biometric unlock. Secret key must already be in memory (after passphrase unlock). */
export async function enableBiometrics(): Promise<void> {
  const sk = secretKey();
  const pk = publicKey();
  if (!sk || !pk) throw new Error("Not unlocked");

  const crypto = await loadCrypto();
  console.info("[enableBiometrics] registering PRF credential");
  const { credentialId, prfKey } = await registerPrfCredential(pk);
  const encrypted = crypto.encryptSecretKeyRaw(sk, prfKey);
  console.info("[enableBiometrics] PRF credential registered, updating identity");
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
  } catch (e) {
    console.error("[changePassphrase] current passphrase verification failed:", e);
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

  const { publicKeyB64 } = await createIdentity(internalPassphrase);
  console.log("[createBiometricsOnlyIdentity] created identity with publicKey:", publicKeyB64.slice(0, 8), "…");
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
    // A re-link creates a new pair. Encrypting to the previous partner while
    // waiting for the new one to join would file undecryptable blobs in that
    // pair — the silent-failure mode this branch exists to stop. The partner
    // key is written back in completeInitiatorPairing.
    identity.partnerPublicKey = null;
    await storage.saveIdentity(identity);
  }
  setSharedSecret(null);
  setIsPaired(false);

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
  } else {
    console.warn("[joinHandshake] no identity")
  }
  await resetSyncCursor();

  return { partnerPublicKeyB64: data.partnerPublicKey };
}

/**
 * Open a WebSocket and wait for partner to join.
 * Returns a cleanup function to close the connection.
 */
export function startWatchingForPartner(
  onPaired: () => void,
  onError?: (err: Error) => void
): relay.WatchHandle {
  const pk = publicKey();
  const sk = secretKey();

  if (!pk || !sk) {
    return { stop: () => {}, sendBundle: () => {} };
  }

  return relay.watchForPartner(
    pk,
    sk,
    async (partnerPublicKeyB64) => {
      await completeInitiatorPairing(partnerPublicKeyB64);
      onPaired();
    },
    (err) => {
      console.error("[startWatchingForPartner]", err);
      onError?.(err);
    }
  );
}

/**
 * Encrypt all local entries and send over the initiator's open WebSocket.
 * Pass handle.sendBundle as the sendFn.
 */
export async function uploadHistoryBundleOverWs(sendFn: (payload: string) => void): Promise<void> {
  const ss = sharedSecret();
  if (!ss) return;

  const days = await storage.listDays();
  if (days.length === 0) return;

  const bundle: Array<{ dayId: string; entries: storage.StoredEntry[] }> = [];
  for (const dayId of days) {
    const day = await storage.loadDay(dayId);
    if (day && day.entries.length > 0) bundle.push({ dayId, entries: day.entries });
  }
  if (bundle.length === 0) return;

  const crypto = await loadCrypto();
  const encrypted = crypto.encrypt(JSON.stringify(bundle), ss);
  sendFn(crypto.toBase64(encrypted));
  console.log("[transfer] sent history bundle over WS:", bundle.length, "days");
}

/**
 * Open a WebSocket to collect a history bundle from the initiator.
 * Returns a cleanup function.
 * onDone — bundle imported successfully.
 * onWaiting — connection open, no bundle yet (initiator hasn't sent yet).
 * onError — connection error or timeout.
 */
export function collectHistoryBundle(
  onDone: () => void,
  onWaiting: () => void,
  onError: (err: Error) => void
): () => void {
  const pk = publicKey();
  const sk = secretKey();
  const ss = sharedSecret();
  if (!pk || !sk || !ss) { onError(new Error("Not unlocked")); return () => {}; }

  return relay.collectBundle(
    pk, sk,
    async (payloadB64) => {
      try {
        const crypto = await loadCrypto();
        const encrypted = crypto.fromBase64(payloadB64);
        const plainJson = crypto.decrypt(encrypted, ss);
        const bundle = JSON.parse(plainJson) as Array<{ dayId: string; entries: storage.StoredEntry[] }>;
        for (const { dayId, entries } of bundle) {
          const flipped = entries.map((e) => ({
            ...e,
            author: (e.author === "me" ? "partner" : "me") as "me" | "partner",
          }));
          const existing = (await storage.loadDay(dayId)) || { entries: [] };
          for (const entry of flipped) {
            const dupe = existing.entries.some(
              (e) => e.author === entry.author && e.timestamp === entry.timestamp
            );
            if (!dupe) existing.entries.push(entry);
          }
          await storage.saveDay(dayId, existing);
        }
        console.log("[transfer] imported bundle over WS:", bundle.length, "days");
        onDone();
        bumpEntriesVersion();
      } catch (e) {
        onError(e instanceof Error ? e : new Error(String(e)));
      }
    },
    onWaiting,
    onError
  );
}

/** Called by initiator after follower joins — we need to fetch partner's key. */
export async function completeInitiatorPairing(partnerPublicKeyB64: string): Promise<void> {
  const crypto = await loadCrypto();
  const partnerPk = crypto.fromBase64(partnerPublicKeyB64);
  setIsPaired(true);
  console.info("Computing shared secret with partner public key:", partnerPublicKeyB64.slice(0, 8), "…");
  const pk = publicKey();
  const sk = secretKey();
  if (sk && pk) {
    setSharedSecret(crypto.computeSharedSecret(sk, pk, partnerPk));
  }
  console.info("Shared secret computed, updating identity with partner public key");
  const identity = await storage.loadIdentity();
  if (identity) {
    identity.partnerPublicKey = partnerPublicKeyB64;
    await storage.saveIdentity(identity);
  }
  await resetSyncCursor();
}

// ── Connection health ───────────────────────────────────────

export type ConnectionHealth =
  | { state: "ok" }
  | { state: "not-paired" }
  | { state: "locked" }
  | { state: "offline" }
  | { state: "no-partner-on-relay" }
  | { state: "key-mismatch"; localKey: string; relayKey: string }
  | { state: "error"; message: string };

/**
 * Ask the relay who it thinks our partner is and compare with what this device
 * stored. A pairing can fail in two ways that both look identical on screen —
 * the relay has us alone in a pair, or it has us pointed at a different key
 * than the one we encrypt to. Either way every sync returns nothing and no
 * error is ever surfaced, so this is the only way to tell them apart.
 */
export async function checkConnectionHealth(): Promise<ConnectionHealth> {
  const pk = publicKey();
  const sk = secretKey();
  if (!pk || !sk) return { state: "locked" };
  if (!navigator.onLine) return { state: "offline" };

  const identity = await storage.loadIdentity();
  if (!identity?.pairId || !identity.partnerPublicKey) return { state: "not-paired" };

  try {
    const { status, data } = await relay.getPairStatus(pk, sk);
    if (status !== 200) {
      return { state: "error", message: data?.error || `Relay returned ${status}` };
    }
    if (!data.paired) return { state: "no-partner-on-relay" };
    if (data.partnerPublicKey !== identity.partnerPublicKey) {
      return {
        state: "key-mismatch",
        localKey: identity.partnerPublicKey,
        relayKey: data.partnerPublicKey,
      };
    }
    return { state: "ok" };
  } catch (e) {
    return { state: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

// ── Entries ─────────────────────────────────────────────────

export async function submitEntry(text: string, dayId: string): Promise<void> {
  // Save locally — one entry per day, replace any existing "me" entry
  const existing = (await storage.loadDay(dayId)) || { entries: [] };
  const idx = existing.entries.findIndex((e) => e.author === "me");
  const timestamp = new Date().toISOString();
  const entry: storage.StoredEntry = {
    dayId,
    author: "me",
    payload: text,
    timestamp,
  };
  if (idx >= 0) {
    existing.entries[idx] = entry;
  } else {
    existing.entries.push(entry);
  }
  await storage.saveDay(dayId, existing);

  // Encrypt and queue for relay
  const ss = sharedSecret();
  if (!ss) throw new Error("Not unlocked or not paired");

  const crypto = await loadCrypto();
  const plaintext = JSON.stringify({
    text,
    format: "markdown",
    timestamp,
  });

  const encrypted = crypto.encrypt(plaintext, ss);
  const payloadB64 = crypto.toBase64(encrypted);

  await enqueue(dayId, payloadB64);
  await refreshPendingCount();
  requestBackgroundSync().catch(console.error);
  flushOutbox().catch(console.error);
  // Imported lazily: backup.ts imports this module, and a static import here
  // would close the cycle at module-evaluation time.
  import("./backup").then((m) => m.refreshRecoveryBackup()).catch(console.error);
}

export async function updateEntry(text: string, dayId: string): Promise<void> {
  // Update local storage — preserve original timestamp, just replace content
  const existing = (await storage.loadDay(dayId)) || { entries: [] };
  const idx = existing.entries.findIndex((e) => e.author === "me");
  if (idx >= 0) {
    existing.entries[idx] = { ...existing.entries[idx], payload: text };
  } else {
    existing.entries.push({ dayId, author: "me", payload: text, timestamp: new Date().toISOString() });
  }
  await storage.saveDay(dayId, existing);

  // Re-encrypt and update relay — replace in outbox if still queued, otherwise enqueue fresh
  const ss = sharedSecret();
  if (!ss) throw new Error("Not unlocked or not paired");

  const crypto = await loadCrypto();
  const plaintext = JSON.stringify({
    text,
    format: "markdown",
    timestamp: existing.entries.find((e) => e.author === "me")!.timestamp,
  });
  const encrypted = crypto.encrypt(plaintext, ss);
  const payloadB64 = crypto.toBase64(encrypted);

  const replaced = await replaceForDayId(dayId, payloadB64);
  if (!replaced) {
    await enqueue(dayId, payloadB64);
  }

  await refreshPendingCount();
  requestBackgroundSync().catch(console.error);
  flushOutbox().catch(console.error);
  // Imported lazily: backup.ts imports this module, and a static import here
  // would close the cycle at module-evaluation time.
  import("./backup").then((m) => m.refreshRecoveryBackup()).catch(console.error);
}

/**
 * Fold a relayed entry into a day's local file. Same author+day: keep the
 * newer timestamp so a phone that has written (or still has an unflushed
 * outbox item) is not rolled back by an older copy from the other handset.
 */
export function mergeRelayedEntry(
  existing: storage.DayFile,
  incoming: storage.StoredEntry
): boolean {
  const idx = existing.entries.findIndex((e) => e.author === incoming.author);
  if (idx < 0) {
    existing.entries.push(incoming);
    return true;
  }
  const current = existing.entries[idx];
  if (incoming.timestamp < current.timestamp) return false;
  if (incoming.payload === current.payload && incoming.timestamp === current.timestamp) {
    return false;
  }
  existing.entries[idx] = incoming;
  return true;
}

const SYNC_CURSOR_KEY = "paper-hearts:sync-cursor";

/**
 * The relay's own clock, from the last complete sync. Only the background
 * sync uses it — a targeted fetch for one archived day asks a narrower
 * question, and letting its answer move the shared cursor would skip
 * everything outside that day.
 *
 * Nothing here is derived from this device's clock: the value is whatever the
 * relay last handed back.
 */
async function loadSyncCursor(): Promise<string | null> {
  return storage.loadSetting(SYNC_CURSOR_KEY);
}

async function saveSyncCursor(cursor: string): Promise<void> {
  await storage.saveSetting(SYNC_CURSOR_KEY, cursor);
}

/**
 * Forget where we had synced to, so the next sync pulls the whole window
 * again. Anything that replaces this device's diary has to call this: a phone
 * that adopts an account or restores a backup holds a partial archive, and a
 * cursor would tell the relay it was already up to date.
 */
export async function resetSyncCursor(): Promise<void> {
  await storage.saveSetting(SYNC_CURSOR_KEY, "");
}

/**
 * - `incremental` — the foreground poll. Asks only for what moved since the
 *   last sync, and records the new mark.
 * - `full` — app open and push wake-ups. Pulls the whole window regardless of
 *   the mark, then records a fresh one. Once a session, this is cheap, and it
 *   heals a cursor that has drifted for any reason.
 * - omitted — a targeted fetch for one archived day. Narrower than the window,
 *   so it must not touch the shared mark.
 */
export async function fetchAndDecryptEntries(
  since: string,
  opts: { sync?: "full" | "incremental" } = {}
): Promise<void> {
  console.log("[fetchAndDecryptEntries] fetching entries since", since);
  const pk = publicKey();
  const sk = secretKey();
  const ss = sharedSecret();
  if (!pk || !sk || !ss) throw new Error("Not unlocked or not paired");

  const cursor = opts.sync === "incremental" ? (await loadSyncCursor()) || null : null;
  const { status, data } = await relay.getEntries(since, pk, sk, cursor);
  if (status !== 200) return;

  const entries = data.entries || [];
  const idsToAck: string[] = [];
  let allHandled = true;
  const crypto = await loadCrypto();

  for (const entry of entries) {
    try {
      const encrypted = crypto.fromBase64(entry.payload);
      const plainJson = crypto.decrypt(encrypted, ss);
      const parsed = JSON.parse(plainJson);

      const dayId = entry.dayId;
      const author: storage.StoredEntry["author"] = entry.author === "me" ? "me" : "partner";
      const existing = (await storage.loadDay(dayId)) || { entries: [] };
      const changed = mergeRelayedEntry(existing, {
        dayId,
        author,
        payload: parsed.text,
        timestamp: parsed.timestamp,
      });
      if (changed) await storage.saveDay(dayId, existing);

      // Own rows are for the other handset; ack is how we tell the partner
      // path "this device has seen it". Acking our own writes is a no-op on
      // the relay (it only marks the partner's blobs).
      //
      // Only ack what actually moved. The relay no longer filters on acked_at,
      // so every poll re-returns the whole retention window — acking all of it
      // each time would post a few dozen ids every 30 seconds to no effect.
      if (author === "partner" && changed) idsToAck.push(entry.id);
    } catch (e) {
      allHandled = false;
      console.error("[fetchAndDecryptEntries] failed to decrypt entry:", e);
    }
  }

  if (idsToAck.length > 0) {
    await relay.ackEntries(idsToAck, pk, sk);
  }

  // Only move the cursor when every row landed. Advancing past an entry that
  // failed to decrypt would put it permanently out of reach — the relay would
  // never offer it again.
  if (opts.sync && allHandled && data.nextChangedSince) {
    await saveSyncCursor(data.nextChangedSince);
  }
}

export async function loadDayEntries(dayId: string): Promise<storage.DayFile | null> {
  return storage.loadDay(dayId);
}

export async function loadAllDays(): Promise<string[]> {
  return storage.listDays();
}

/** Build a Markdown export of all entries for a given month ("YYYY-MM").
 *  Returns an empty string if there are no entries for that month. */
export async function exportMonth(monthStr: string): Promise<string> {
  const days = (await storage.listDays())
    .filter((d) => d.startsWith(monthStr))
    .sort();

  if (days.length === 0) return "";

  const [year, month] = monthStr.split("-").map(Number);
  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  const lines: string[] = [`# Paper Hearts — ${monthLabel}`, ""];

  for (const dayId of days) {
    const day = await storage.loadDay(dayId);
    if (!day) continue;
    const mine = day.entries.find((e) => e.author === "me");
    const partner = day.entries.find((e) => e.author === "partner");
    if (!mine && !partner) continue;

    lines.push(`## ${formatDayLabel(dayId)}`);
    if (mine) {
      lines.push("");
      lines.push(`**You**`);
      lines.push("");
      lines.push(mine.payload);
    }
    if (partner) {
      lines.push("");
      lines.push(`**${partnerName()}**`);
      lines.push("");
      lines.push(partner.payload);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

// ── History bundle transfer ──────────────────────────────────

/** Initiator: encrypt all local entries and upload to relay for follower to collect. */
export async function uploadHistoryBundle(): Promise<void> {
  const pk = publicKey();
  const sk = secretKey();
  const ss = sharedSecret();
  if (!pk || !sk || !ss) return;

  const days = await storage.listDays();
  if (days.length === 0) return;

  const bundle: Array<{ dayId: string; entries: storage.StoredEntry[] }> = [];
  for (const dayId of days) {
    const day = await storage.loadDay(dayId);
    if (day && day.entries.length > 0) {
      bundle.push({ dayId, entries: day.entries });
    }
  }
  if (bundle.length === 0) return;

  const crypto = await loadCrypto();
  const encrypted = crypto.encrypt(JSON.stringify(bundle), ss);
  await relay.uploadTransfer(crypto.toBase64(encrypted), pk, sk);
  console.log("[transfer] uploaded history bundle:", bundle.length, "days");
}

/**
 * Follower: single-attempt download. Returns true if a bundle was found and
 * imported. Use this from the UI so the user isn't blocked for 30 seconds.
 */
export async function downloadHistoryBundleNow(): Promise<boolean> {
  const pk = publicKey();
  const sk = secretKey();
  const ss = sharedSecret();
  if (!pk || !sk || !ss) return false;

  const { payload } = await relay.downloadTransfer(pk, sk);
  if (!payload) return false;

  const crypto = await loadCrypto();
  const encrypted = crypto.fromBase64(payload);
  const plainJson = crypto.decrypt(encrypted, ss);
  const bundle = JSON.parse(plainJson) as Array<{ dayId: string; entries: storage.StoredEntry[] }>;

  for (const { dayId, entries } of bundle) {
    const flipped = entries.map((e) => ({
      ...e,
      author: (e.author === "me" ? "partner" : "me") as "me" | "partner",
    }));
    const existing = (await storage.loadDay(dayId)) || { entries: [] };
    for (const entry of flipped) {
      const dupe = existing.entries.some(
        (e) => e.author === entry.author && e.timestamp === entry.timestamp
      );
      if (!dupe) existing.entries.push(entry);
    }
    await storage.saveDay(dayId, existing);
  }
  console.log("[transfer] imported history bundle:", bundle.length, "days");
  return true;
}

/** Follower: poll relay for history bundle, decrypt and import. */
export async function downloadHistoryBundle(): Promise<void> {
  const pk = publicKey();
  const sk = secretKey();
  const ss = sharedSecret();
  if (!pk || !sk || !ss) return;

  const MAX_ATTEMPTS = 15;
  const POLL_INTERVAL_MS = 2000;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const { payload } = await relay.downloadTransfer(pk, sk);
    if (payload) {
      const crypto = await loadCrypto();
      const encrypted = crypto.fromBase64(payload);
      const plainJson = crypto.decrypt(encrypted, ss);
      const bundle = JSON.parse(plainJson) as Array<{ dayId: string; entries: storage.StoredEntry[] }>;

      for (const { dayId, entries } of bundle) {
        // Flip author perspective: initiator's "me" entries are our "partner" entries
        const flipped = entries.map((e) => ({
          ...e,
          author: (e.author === "me" ? "partner" : "me") as "me" | "partner",
        }));
        const existing = (await storage.loadDay(dayId)) || { entries: [] };
        // Merge: add flipped entries not already present by author+timestamp
        for (const entry of flipped) {
          const dupe = existing.entries.some(
            (e) => e.author === entry.author && e.timestamp === entry.timestamp
          );
          if (!dupe) existing.entries.push(entry);
        }
        await storage.saveDay(dayId, existing);
      }
      console.log("[transfer] imported history bundle:", bundle.length, "days");
      return;
    }

    if (i < MAX_ATTEMPTS - 1) {
      await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
    }
  }
  console.log("[transfer] no history bundle received after", MAX_ATTEMPTS, "attempts");
}

export async function savePartnerName(name: string): Promise<void> {
  const identity = await storage.loadIdentity();
  if (!identity) return;
  const trimmed = name.trim();
  identity.partnerName = trimmed || undefined;
  await storage.saveIdentity(identity);
  setPartnerNameSignal(trimmed || "Partner");
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

// ── Account bundles ─────────────────────────────────────────

/**
 * Everything needed to be this account on another device: the identity key
 * pair, who it is paired with, and the diary itself.
 *
 * Entries travel as plaintext inside the bundle. That is not a downgrade —
 * they are stored decrypted on each device already, and the bundle as a whole
 * is sealed (device link) or encrypted with a key derived from a recovery code
 * or passphrase (backup) before it goes anywhere.
 */
export interface AccountBundle {
  v: 1;
  publicKey: string;
  secretKey: string;
  pairId: string | null;
  partnerPublicKey: string | null;
  partnerName?: string;
  days: Array<{ dayId: string; entries: storage.StoredEntry[] }>;
  exportedAt: string;
}

/** Collect this device's identity and diary. Requires the diary to be unlocked. */
export async function buildAccountBundle(): Promise<AccountBundle> {
  const pk = publicKey();
  const sk = secretKey();
  if (!pk || !sk) throw new Error("Unlock your diary first");

  const identity = await storage.loadIdentity();
  if (!identity) throw new Error("No identity on this device");

  const crypto = await loadCrypto();
  const days: AccountBundle["days"] = [];
  for (const dayId of await storage.listDays()) {
    const day = await storage.loadDay(dayId);
    if (day && day.entries.length > 0) days.push({ dayId, entries: day.entries });
  }

  return {
    v: 1,
    publicKey: crypto.toBase64(pk),
    secretKey: crypto.toBase64(sk),
    pairId: identity.pairId,
    partnerPublicKey: identity.partnerPublicKey,
    partnerName: identity.partnerName,
    days,
    exportedAt: new Date().toISOString(),
  };
}

/**
 * Become the account in a bundle on this device.
 *
 * Days are merged rather than replaced: restoring onto a phone that already
 * has entries — a partial restore, or a second device that has been writing
 * offline — must not throw away what is already here.
 */
export async function installAccountBundle(
  bundle: AccountBundle,
  passphrase: string
): Promise<void> {
  if (bundle?.v !== 1) throw new Error("This backup was made by a different version of Paper Hearts");
  if (!bundle.publicKey || !bundle.secretKey) throw new Error("Backup is missing its keys");

  const crypto = await loadCrypto();
  await crypto.init();

  const sk = crypto.fromBase64(bundle.secretKey);
  const pk = crypto.fromBase64(bundle.publicKey);
  const encKey = crypto.encryptSecretKey(sk, passphrase);

  await storage.saveIdentity({
    publicKey: bundle.publicKey,
    encryptedKey: encryptedKeyToStorable(encKey, crypto),
    unlockMethod: "passphrase",
    pairId: bundle.pairId,
    partnerPublicKey: bundle.partnerPublicKey,
    ...(bundle.partnerName ? { partnerName: bundle.partnerName } : {}),
  });

  for (const { dayId, entries } of bundle.days ?? []) {
    const existing = (await storage.loadDay(dayId)) || { entries: [] };
    for (const entry of entries) {
      const idx = existing.entries.findIndex((e) => e.author === entry.author);
      if (idx >= 0) {
        // Same author, same day: keep whichever was written last.
        if (entry.timestamp >= existing.entries[idx].timestamp) existing.entries[idx] = entry;
      } else {
        existing.entries.push(entry);
      }
    }
    await storage.saveDay(dayId, existing);
  }

  // The outbox holds ciphertext encrypted under the previous identity. Flushing
  // it after adopt would upload those blobs as this account. Recovery settings
  // wrap a code with the old secret key and would look enabled while being
  // unable to refresh.
  await clearOutbox();
  await storage.saveSetting("paper-hearts:recovery-backup", JSON.stringify({ enabled: false }));
  await refreshPendingCount();

  setPublicKey(pk);
  setSecretKey(sk);
  setUnlockMethod("passphrase");
  setIsPaired(!!bundle.pairId && !!bundle.partnerPublicKey);
  if (bundle.partnerPublicKey) {
    setSharedSecret(crypto.computeSharedSecret(sk, pk, crypto.fromBase64(bundle.partnerPublicKey)));
  }
  if (bundle.partnerName) setPartnerNameSignal(bundle.partnerName);
  await resetSyncCursor();
  bumpEntriesVersion();
}
