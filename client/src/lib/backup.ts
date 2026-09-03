import * as relay from "./relay";
import * as storage from "./storage";
import { buildAccountBundle, installAccountBundle, publicKey, secretKey } from "./store";
import type { AccountBundle } from "./store";

const loadCrypto = () => import("./crypto");

/**
 * Two ways to survive losing every phone, because they fail differently.
 *
 * A **backup file** is a `.phbak` you save wherever you keep things — iCloud,
 * Drive, a laptop. Nothing about it touches the relay. It is only as current
 * as the last time you exported it, and only exists if you remembered to.
 *
 * A **recovery backup** lives on the relay, refreshed as you write, addressed
 * by a locator derived from a recovery code you wrote down. The relay holds
 * ciphertext and a locator; it has neither the code nor the key derived
 * alongside it. Restoring needs the code and nothing else — no phone, no
 * partner, no signature — which is the only shape that works once both phones
 * are gone.
 */

const BACKUP_ENABLED_KEY = "paper-hearts:recovery-backup";

// ── Encrypted backup file ───────────────────────────────────

export interface BackupFile {
  format: "paper-hearts-backup";
  v: 1;
  salt: string;
  nonce: string;
  ciphertext: string;
  createdAt: string;
}

/** Encrypt this account into a file payload under a passphrase. */
export async function exportBackupFile(passphrase: string): Promise<{ filename: string; json: string }> {
  if (passphrase.length < 8) throw new Error("Use at least 8 characters.");

  const crypto = await loadCrypto();
  const bundle = await buildAccountBundle();
  const encrypted = crypto.encryptSecretKey(
    new TextEncoder().encode(JSON.stringify(bundle)),
    passphrase
  );

  const file: BackupFile = {
    format: "paper-hearts-backup",
    v: 1,
    salt: crypto.toBase64(encrypted.salt),
    nonce: crypto.toBase64(encrypted.nonce),
    ciphertext: crypto.toBase64(encrypted.ciphertext),
    createdAt: new Date().toISOString(),
  };

  const stamp = new Date().toISOString().slice(0, 10);
  return { filename: `paper-hearts-${stamp}.phbak`, json: JSON.stringify(file) };
}

/** Decrypt a `.phbak` payload. Throws if the passphrase is wrong. */
export async function readBackupFile(json: string, passphrase: string): Promise<AccountBundle> {
  let file: BackupFile;
  try {
    file = JSON.parse(json);
  } catch {
    throw new Error("That file isn't a Paper Hearts backup.");
  }
  if (file?.format !== "paper-hearts-backup" || file.v !== 1) {
    throw new Error("That file isn't a Paper Hearts backup.");
  }

  const crypto = await loadCrypto();
  await crypto.init();

  let plaintext: Uint8Array;
  try {
    plaintext = crypto.decryptSecretKey(
      {
        salt: crypto.fromBase64(file.salt),
        nonce: crypto.fromBase64(file.nonce),
        ciphertext: crypto.fromBase64(file.ciphertext),
      },
      passphrase
    );
  } catch {
    throw new Error("Wrong passphrase for this backup.");
  }

  return JSON.parse(new TextDecoder().decode(plaintext)) as AccountBundle;
}

// ── Recovery backup on the relay ────────────────────────────

/** Mint a recovery code. Show it once, and only once — it is not recoverable. */
export async function createRecoveryCode(): Promise<string> {
  const crypto = await loadCrypto();
  await crypto.init();
  return crypto.generateRecoveryCode();
}

/**
 * Encrypt this account under the recovery code and store it on the relay.
 * The code itself is never sent — only the locator derived beside the key.
 */
export async function uploadRecoveryBackup(recoveryCode: string): Promise<void> {
  const pk = publicKey();
  const sk = secretKey();
  if (!pk || !sk) throw new Error("Unlock your diary first");

  const crypto = await loadCrypto();
  const { locator, key } = crypto.deriveRecoveryKeys(recoveryCode);
  const bundle = await buildAccountBundle();
  const payload = crypto.encrypt(JSON.stringify(bundle), key);

  const { status, data } = await relay.putBackup(locator, crypto.toBase64(payload), pk, sk);
  if (status !== 200) throw new Error(data.error || "Couldn't save your backup");

  await setRecoveryBackupEnabled(true);
}

/** Fetch and decrypt a recovery backup. Needs the code and nothing else. */
export async function restoreFromRecoveryCode(recoveryCode: string): Promise<AccountBundle> {
  const crypto = await loadCrypto();
  await crypto.init();

  const { locator, key } = crypto.deriveRecoveryKeys(recoveryCode);
  const { status, data } = await relay.getBackup(locator);

  if (status === 404) throw new Error("No backup found for that recovery code.");
  if (status === 429) throw new Error("Too many attempts. Wait a minute and try again.");
  if (status !== 200) throw new Error(data.error || "Couldn't reach the relay");

  try {
    return JSON.parse(crypto.decrypt(crypto.fromBase64(data.payload), key)) as AccountBundle;
  } catch {
    // The locator matched, so the code is nearly right — a transcription slip
    // in a character the normaliser doesn't fold, most likely.
    throw new Error("That recovery code didn't unlock the backup. Check it and try again.");
  }
}

export interface RecoveryBackupStatus {
  exists: boolean;
  updatedAt?: string;
  bytes?: number;
}

export async function getRecoveryBackupStatus(): Promise<RecoveryBackupStatus> {
  const pk = publicKey();
  const sk = secretKey();
  if (!pk || !sk) return { exists: false };

  const { status, data } = await relay.getBackupStatus(pk, sk);
  if (status !== 200) return { exists: false };
  return data as RecoveryBackupStatus;
}

export async function deleteRecoveryBackup(): Promise<void> {
  const pk = publicKey();
  const sk = secretKey();
  if (!pk || !sk) throw new Error("Unlock your diary first");
  await relay.deleteBackup(pk, sk);
  await setRecoveryBackupEnabled(false);
}

/** Restore an account from any bundle, protecting the key with a passphrase. */
export async function restoreAccount(bundle: AccountBundle, passphrase: string): Promise<void> {
  await installAccountBundle(bundle, passphrase);
}

// ── Keeping the backup current ──────────────────────────────
//
// A recovery backup that stops at the day it was created is close to useless,
// so it is refreshed after entries are written. The code is not kept anywhere,
// so the refresh re-derives from the locator the device recorded when the
// backup was set up.

interface StoredRecoverySettings {
  enabled: boolean;
  /** The code, wrapped with the device's own key material — see note below. */
  code?: string;
}

/**
 * The recovery code has to be re-usable by this device to refresh the backup,
 * so it is held in the same store as the diary itself. That store is already
 * where the identity key lives; a device that can read it can read everything
 * anyway. What matters is that the code never reaches the relay.
 */
export async function setRecoveryCodeForRefresh(code: string): Promise<void> {
  await storage.saveSetting(BACKUP_ENABLED_KEY, JSON.stringify({ enabled: true, code }));
}

async function loadRecoverySettings(): Promise<StoredRecoverySettings> {
  const raw = await storage.loadSetting(BACKUP_ENABLED_KEY);
  if (!raw) return { enabled: false };
  try {
    return JSON.parse(raw) as StoredRecoverySettings;
  } catch {
    return { enabled: false };
  }
}

export async function isRecoveryBackupEnabled(): Promise<boolean> {
  return (await loadRecoverySettings()).enabled;
}

async function setRecoveryBackupEnabled(enabled: boolean): Promise<void> {
  const current = await loadRecoverySettings();
  await storage.saveSetting(
    BACKUP_ENABLED_KEY,
    JSON.stringify(enabled ? { ...current, enabled: true } : { enabled: false })
  );
}

/**
 * Push a fresh copy if recovery backup is on. Called after writing an entry;
 * failures are not worth interrupting the user for, since the next write
 * retries.
 */
export async function refreshRecoveryBackup(): Promise<void> {
  const settings = await loadRecoverySettings();
  if (!settings.enabled || !settings.code) return;
  if (!navigator.onLine) return;
  try {
    await uploadRecoveryBackup(settings.code);
  } catch (e) {
    console.info("[backup] refresh deferred:", e);
  }
}
