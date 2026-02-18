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
