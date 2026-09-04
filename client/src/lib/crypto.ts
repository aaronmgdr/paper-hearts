import sodium from "libsodium-wrappers-sumo";

let ready = false;

export async function init(): Promise<void> {
  if (ready) return;
  await sodium.ready;
  ready = true;
}

// ── Key generation ──────────────────────────────────────────

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** Generate a new Ed25519 signing key pair. */
export function generateKeyPair(): KeyPair {
  const kp = sodium.crypto_sign_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

// ── Encoding helpers ────────────────────────────────────────

export function toBase64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

export function fromBase64(b64: string): Uint8Array {
  return sodium.from_base64(b64, sodium.base64_variants.ORIGINAL);
}

// ── Signing (for relay auth) ────────────────────────────────

/** Sign arbitrary bytes with Ed25519 secret key, return detached signature. */
export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return sodium.crypto_sign_detached(message, secretKey);
}

// ── Encryption (E2EE between partners) ──────────────────────

/** Derive an X25519 encryption key pair from Ed25519 signing keys. */
function deriveEncryptionKeys(edPk: Uint8Array, edSk: Uint8Array) {
  return {
    encPk: sodium.crypto_sign_ed25519_pk_to_curve25519(edPk),
    encSk: sodium.crypto_sign_ed25519_sk_to_curve25519(edSk),
  };
}

/** Compute the shared secret between our Ed25519 key and partner's Ed25519 public key. */
export function computeSharedSecret(
  myEdSk: Uint8Array,
  myEdPk: Uint8Array,
  partnerEdPk: Uint8Array
): Uint8Array {
  const my = deriveEncryptionKeys(myEdPk, myEdSk);
  const partnerEncPk = sodium.crypto_sign_ed25519_pk_to_curve25519(partnerEdPk);

  // Use crypto_scalarmult for X25519 DH
  const rawShared = sodium.crypto_scalarmult(my.encSk, partnerEncPk);

  // Hash the shared secret for use as a symmetric key (no key -> pass null)
  return sodium.crypto_generichash(
    sodium.crypto_secretbox_KEYBYTES,
    rawShared,
    null
  );
}

/** Encrypt plaintext with a shared secret. Returns nonce + ciphertext concatenated. */
export function encrypt(plaintext: string, sharedSecret: Uint8Array): Uint8Array {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const message = sodium.from_string(plaintext);
  const ciphertext = sodium.crypto_secretbox_easy(message, nonce, sharedSecret);

  // Prepend nonce to ciphertext
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce);
  combined.set(ciphertext, nonce.length);
  return combined;
}

/** Decrypt nonce+ciphertext with a shared secret. Returns plaintext string. */
export function decrypt(combined: Uint8Array, sharedSecret: Uint8Array): string {
  const nonceLen = sodium.crypto_secretbox_NONCEBYTES;
  const nonce = combined.slice(0, nonceLen);
  const ciphertext = combined.slice(nonceLen);
  const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, sharedSecret);
  return sodium.to_string(plaintext);
}

// ── Key-at-rest encryption (passphrase-based) ───────────────

export interface EncryptedKey {
  salt: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

/** Encrypt the secret key at rest using Argon2id-derived key from passphrase. */
export function encryptSecretKey(
  secretKey: Uint8Array,
  passphrase: string
): EncryptedKey {
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const derived = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    passphrase,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(secretKey, nonce, derived);
  return { salt, nonce, ciphertext };
}

/** Decrypt the secret key at rest using the passphrase. Throws on wrong passphrase. */
export function decryptSecretKey(
  encrypted: EncryptedKey,
  passphrase: string
): Uint8Array {
  const derived = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    passphrase,
    encrypted.salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
  return sodium.crypto_secretbox_open_easy(
    encrypted.ciphertext,
    encrypted.nonce,
    derived
  );
}

// ── Key-at-rest encryption (raw key, for WebAuthn PRF) ──────

export interface PrfEncryptedKey {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

/** Encrypt the secret key using a raw 32-byte wrapping key (from PRF). */
export function encryptSecretKeyRaw(
  secretKey: Uint8Array,
  wrappingKey: Uint8Array
): PrfEncryptedKey {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(secretKey, nonce, wrappingKey);
  return { nonce, ciphertext };
}

/** Decrypt the secret key using a raw 32-byte wrapping key (from PRF). */
export function decryptSecretKeyRaw(
  encrypted: PrfEncryptedKey,
  wrappingKey: Uint8Array
): Uint8Array {
  return sodium.crypto_secretbox_open_easy(
    encrypted.ciphertext,
    encrypted.nonce,
    wrappingKey
  );
}

// ── Anonymous sealed boxes (device link) ────────────────────

export interface BoxKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * A throwaway X25519 key pair, used once to receive an identity bundle on a
 * new device. Distinct from the Ed25519 identity key: it exists for the
 * duration of one transfer and is never stored.
 */
export function generateBoxKeyPair(): BoxKeyPair {
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

/**
 * Seal a message to a public key. The sender is anonymous and cannot open its
 * own ciphertext — which is what we want for a one-way handoff through a relay
 * that must not be able to read it.
 */
export function seal(plaintext: string, recipientPublicKey: Uint8Array): Uint8Array {
  return sodium.crypto_box_seal(sodium.from_string(plaintext), recipientPublicKey);
}

/** Open a sealed box. Throws if it wasn't sealed to this key pair. */
export function openSealed(sealed: Uint8Array, keys: BoxKeyPair): string {
  return sodium.to_string(
    sodium.crypto_box_seal_open(sealed, keys.publicKey, keys.secretKey)
  );
}

/**
 * Six digits derived from both halves of a device-link handshake, shown on
 * each phone. A relay that swapped in a key of its own to read the bundle
 * would produce a different number on the two screens.
 */
export function pairingVerificationCode(token: string, ephemeralPublicKeyB64: string): string {
  const digest = sodium.crypto_generichash(
    8,
    sodium.from_string(`paper-hearts/device-link/v1\n${token}\n${ephemeralPublicKeyB64}`),
    null
  );
  let n = 0;
  for (const byte of digest.slice(0, 4)) n = (n * 256 + byte) % 1_000_000;
  return String(n).padStart(6, "0");
}

// ── Recovery codes ──────────────────────────────────────────

// Crockford-style base32, minus I L O U — the characters people misread when
// copying a code off paper months after they wrote it down.
const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// One alphabet character per random byte, so 5 bits survive each: 20 chars is
// ~100 bits. Ample against a rate-limited online lookup, which is the only way
// a code is ever tried.
const RECOVERY_BYTES = 20;
const MIN_RECOVERY_LENGTH = 16;

/** A fresh recovery code, grouped for transcription: XXXX-XXXX-… (5 groups). */
export function generateRecoveryCode(): string {
  const bytes = sodium.randombytes_buf(RECOVERY_BYTES);
  let out = "";
  for (const byte of bytes) {
    out += RECOVERY_ALPHABET[byte >> 3];
  }
  // 20 bytes -> 20 chars at 5 bits each; regroup into fours for readability.
  return (out.match(/.{1,4}/g) || []).join("-");
}

/** Strip formatting and fold look-alike characters back to canonical form. */
export function normalizeRecoveryCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/U/g, "V");
}

export interface RecoveryKeys {
  /** Names the backup on the relay. Reveals nothing about the encryption key. */
  locator: string;
  /** Encrypts the backup. Never leaves the device. */
  key: Uint8Array;
}

/**
 * Split a recovery code into the two independent values a backup needs. They
 * come from separate keyed hashes with different context strings, so holding
 * the locator — which the relay does — says nothing about the key.
 */
export function deriveRecoveryKeys(code: string): RecoveryKeys {
  const normalized = normalizeRecoveryCode(code);
  // Guarded here so a half-typed code produces our message rather than
  // libsodium's key-length error — on the screen someone reaches after losing
  // every device, that distinction matters.
  if (normalized.length < MIN_RECOVERY_LENGTH) {
    throw new Error("That doesn't look like a full recovery code.");
  }
  const material = sodium.from_string(normalized);
  const locator = sodium.crypto_generichash(
    32,
    sodium.from_string("paper-hearts/backup-locator/v1"),
    material
  );
  const key = sodium.crypto_generichash(
    sodium.crypto_secretbox_KEYBYTES,
    sodium.from_string("paper-hearts/backup-key/v1"),
    material
  );
  return { locator: sodium.to_base64(locator, sodium.base64_variants.URLSAFE_NO_PADDING), key };
}

/**
 * A wrapping key bound to this device's identity, for small secrets that have
 * to survive on disk but must not be readable without unlocking — the recovery
 * code, which can fetch and decrypt the whole account on its own.
 */
export function deriveLocalWrapKey(secretKey: Uint8Array): Uint8Array {
  return sodium.crypto_generichash(
    sodium.crypto_secretbox_KEYBYTES,
    sodium.from_string("paper-hearts/recovery-code-wrap/v1"),
    secretKey
  );
}
