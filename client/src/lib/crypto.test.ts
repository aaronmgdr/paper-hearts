import { describe, test, expect, beforeAll } from "vitest";
import {
  init,
  generateKeyPair,
  encrypt,
  decrypt,
  computeSharedSecret,
  encryptSecretKey,
  decryptSecretKey,
  encryptSecretKeyRaw,
  decryptSecretKeyRaw,
  toBase64,
  fromBase64,
} from "./crypto";

beforeAll(async () => {
  await init();
});

describe("encrypt / decrypt", () => {
  test("round-trips a plaintext string", () => {
    const kp = generateKeyPair();
    const partner = generateKeyPair();
    const secret = computeSharedSecret(kp.secretKey, kp.publicKey, partner.publicKey);

    const plaintext = "I love you";
    const ciphertext = encrypt(plaintext, secret);
    expect(decrypt(ciphertext, secret)).toBe(plaintext);
  });

  test("produces different ciphertext each time (random nonce)", () => {
    const kp = generateKeyPair();
    const partner = generateKeyPair();
    const secret = computeSharedSecret(kp.secretKey, kp.publicKey, partner.publicKey);

    const a = encrypt("same text", secret);
    const b = encrypt("same text", secret);
    expect(a).not.toEqual(b);
  });

  test("throws on tampered ciphertext", () => {
    const kp = generateKeyPair();
    const partner = generateKeyPair();
    const secret = computeSharedSecret(kp.secretKey, kp.publicKey, partner.publicKey);

    const ciphertext = encrypt("secret", secret);
    ciphertext[ciphertext.length - 1] ^= 0xff; // flip last byte
    expect(() => decrypt(ciphertext, secret)).toThrow();
  });
});

describe("computeSharedSecret", () => {
  test("both parties derive the same shared secret", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();

    const aliceSecret = computeSharedSecret(alice.secretKey, alice.publicKey, bob.publicKey);
    const bobSecret = computeSharedSecret(bob.secretKey, bob.publicKey, alice.publicKey);

    expect(aliceSecret).toEqual(bobSecret);
  });

  test("different key pairs produce different secrets", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const carol = generateKeyPair();

    const aliceBob = computeSharedSecret(alice.secretKey, alice.publicKey, bob.publicKey);
    const aliceCarol = computeSharedSecret(alice.secretKey, alice.publicKey, carol.publicKey);

    expect(aliceBob).not.toEqual(aliceCarol);
  });
});

describe("encryptSecretKey / decryptSecretKey (passphrase)", () => {
  test("round-trips the secret key with correct passphrase", () => {
    const kp = generateKeyPair();
    const encrypted = encryptSecretKey(kp.secretKey, "my-passphrase");
    const recovered = decryptSecretKey(encrypted, "my-passphrase");
    expect(recovered).toEqual(kp.secretKey);
  });

  test("throws with wrong passphrase", () => {
    const kp = generateKeyPair();
    const encrypted = encryptSecretKey(kp.secretKey, "correct");
    expect(() => decryptSecretKey(encrypted, "wrong")).toThrow();
  });
});

describe("encryptSecretKeyRaw / decryptSecretKeyRaw (PRF/biometric)", () => {
  test("round-trips the secret key with a 32-byte raw key", () => {
    const kp = generateKeyPair();
    // Simulate a WebAuthn PRF output (32 random bytes)
    const wrappingKey = crypto.getRandomValues(new Uint8Array(32));
    const encrypted = encryptSecretKeyRaw(kp.secretKey, wrappingKey);
    const recovered = decryptSecretKeyRaw(encrypted, wrappingKey);
    expect(recovered).toEqual(kp.secretKey);
  });

  test("throws with wrong wrapping key", () => {
    const kp = generateKeyPair();
    const key1 = crypto.getRandomValues(new Uint8Array(32));
    const key2 = crypto.getRandomValues(new Uint8Array(32));
    const encrypted = encryptSecretKeyRaw(kp.secretKey, key1);
    expect(() => decryptSecretKeyRaw(encrypted, key2)).toThrow();
  });
});

describe("toBase64 / fromBase64", () => {
  test("round-trips bytes", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});

describe("sealed boxes (device link)", () => {
  test("only the holder of the throwaway key can open the bundle", async () => {
    const { generateBoxKeyPair, seal, openSealed } = await import("./crypto");
    const recipient = generateBoxKeyPair();
    const eavesdropper = generateBoxKeyPair();

    const sealed = seal(JSON.stringify({ secretKey: "abc" }), recipient.publicKey);

    expect(JSON.parse(openSealed(sealed, recipient)).secretKey).toBe("abc");
    expect(() => openSealed(sealed, eavesdropper)).toThrow();
  });

  test("verification code depends on both halves of the handshake", async () => {
    const { pairingVerificationCode, generateBoxKeyPair, toBase64 } = await import("./crypto");
    const a = toBase64(generateBoxKeyPair().publicKey);
    const b = toBase64(generateBoxKeyPair().publicKey);

    // Stable for the same inputs — the two phones must agree.
    expect(pairingVerificationCode("token", a)).toBe(pairingVerificationCode("token", a));
    expect(pairingVerificationCode("token", a)).toMatch(/^\d{6}$/);

    // A relay swapping in its own key changes the number on one screen.
    expect(pairingVerificationCode("token", a)).not.toBe(pairingVerificationCode("token", b));
    expect(pairingVerificationCode("token", a)).not.toBe(pairingVerificationCode("other", a));
  });
});

describe("recovery codes", () => {
  test("a fresh code is grouped and unique", async () => {
    const { generateRecoveryCode } = await import("./crypto");
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4})+$/);
    expect(generateRecoveryCode()).not.toBe(code);
  });

  test("locator and key are independent and neither leaks the other", async () => {
    const { generateRecoveryCode, deriveRecoveryKeys, toBase64 } = await import("./crypto");
    const code = generateRecoveryCode();
    const { locator, key } = deriveRecoveryKeys(code);

    expect(locator.length).toBeGreaterThan(16);
    expect(key.length).toBe(32);
    // The relay is given the locator; it must not be the encryption key.
    expect(locator).not.toBe(toBase64(key));
  });

  test("derivation survives how people actually transcribe a code", async () => {
    const { deriveRecoveryKeys } = await import("./crypto");
    const canonical = deriveRecoveryKeys("A1B2-C3D4");

    // Spacing, case, and the classic look-alike slips all land on the same keys.
    expect(deriveRecoveryKeys("a1b2 c3d4").locator).toBe(canonical.locator);
    expect(deriveRecoveryKeys("A1B2C3D4").locator).toBe(canonical.locator);
    expect(deriveRecoveryKeys("AIB2-C3D4").locator).toBe(canonical.locator); // I -> 1
  });

  test("a different code opens nothing", async () => {
    const { generateRecoveryCode, deriveRecoveryKeys } = await import("./crypto");
    const a = deriveRecoveryKeys(generateRecoveryCode());
    const b = deriveRecoveryKeys(generateRecoveryCode());
    expect(a.locator).not.toBe(b.locator);
  });

  test("a bundle encrypted under a recovery code round-trips", async () => {
    const { generateRecoveryCode, deriveRecoveryKeys, encrypt, decrypt } = await import("./crypto");
    const code = generateRecoveryCode();
    const bundle = JSON.stringify({ v: 1, days: [{ dayId: "2026-09-03" }] });

    const sealed = encrypt(bundle, deriveRecoveryKeys(code).key);
    expect(decrypt(sealed, deriveRecoveryKeys(code).key)).toBe(bundle);
    expect(() => decrypt(sealed, deriveRecoveryKeys(generateRecoveryCode()).key)).toThrow();
  });
});
