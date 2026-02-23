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
