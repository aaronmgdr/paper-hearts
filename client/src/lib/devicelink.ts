import * as relay from "./relay";
import { buildAccountBundle, installAccountBundle, publicKey, secretKey } from "./store";
import type { AccountBundle } from "./store";
import type { BoxKeyPair } from "./crypto";

const loadCrypto = () => import("./crypto");

const POLL_INTERVAL_MS = 2000;

/**
 * Moving an account onto a second phone means moving the identity private key,
 * so the relay is treated as a courier that must not be able to open the
 * parcel:
 *
 *   existing phone            relay              new phone
 *   ──────────────            ─────              ─────────
 *   start ─────────────────▶  token
 *   share link / QR ───────────────────────────▶ opens it
 *                             ephemeral pk ◀──── generates throwaway X25519
 *   poll ──────────────────▶  ephemeral pk
 *   show 6-digit code                            show 6-digit code
 *        ── the user checks the two numbers match ──
 *   seal(bundle, pk) ──────▶  ciphertext ──────▶ open, install
 *
 * The six digits come from the token and the ephemeral key together. A relay
 * that swapped in a key of its own in order to read the bundle would change
 * the number on one screen but not the other.
 */

export interface DeviceLinkSession {
  token: string;
  /** The link to open on the other phone. */
  url: string;
}

/** Existing phone: open a mailbox and get the link to hand over. */
export async function startDeviceLink(): Promise<DeviceLinkSession> {
  const pk = publicKey();
  const sk = secretKey();
  if (!pk || !sk) throw new Error("Unlock your diary first");

  const { status, data } = await relay.startDeviceLink(pk, sk);
  if (status !== 201) throw new Error(data.error || "Couldn't start the transfer");

  const url = new URL("/device-link", window.location.origin);
  url.searchParams.set("token", data.token);
  return { token: data.token, url: url.toString() };
}

/**
 * Existing phone: wait for the new phone to join. Resolves with its throwaway
 * public key, or null if cancelled.
 */
export function awaitClaim(
  token: string,
  onClaimed: (ephemeralPublicKeyB64: string, verificationCode: string) => void,
  onError: (err: Error) => void
): () => void {
  let stopped = false;
  const pk = publicKey();
  const sk = secretKey();
  if (!pk || !sk) {
    onError(new Error("Unlock your diary first"));
    return () => {};
  }

  (async () => {
    const { pairingVerificationCode } = await loadCrypto();
    while (!stopped) {
      try {
        const { status, data } = await relay.getDeviceLink(token, pk, sk);
        if (stopped) return;
        if (status === 404) throw new Error("This transfer expired. Start again.");
        if (status !== 200) throw new Error(data.error || "Transfer failed");
        if (data.ephemeralPublicKey) {
          onClaimed(
            data.ephemeralPublicKey,
            pairingVerificationCode(token, data.ephemeralPublicKey)
          );
          return;
        }
      } catch (e) {
        if (!stopped) onError(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  })();

  return () => { stopped = true; };
}

/** Existing phone: seal this account to the new phone's key and send it. */
export async function sendAccountBundle(
  token: string,
  ephemeralPublicKeyB64: string
): Promise<void> {
  const pk = publicKey();
  const sk = secretKey();
  if (!pk || !sk) throw new Error("Unlock your diary first");

  const crypto = await loadCrypto();
  const bundle = await buildAccountBundle();
  const sealed = crypto.seal(
    JSON.stringify(bundle),
    crypto.fromBase64(ephemeralPublicKeyB64)
  );

  const { status, data } = await relay.putDeviceLinkPayload(
    token,
    crypto.toBase64(sealed),
    pk,
    sk
  );
  if (status !== 200) throw new Error(data.error || "Couldn't send your diary");
}

// ── New phone ───────────────────────────────────────────────

export interface ClaimResult {
  keys: BoxKeyPair;
  verificationCode: string;
}

/** New phone: generate a throwaway key pair and register it against the token. */
export async function claimDeviceLink(token: string): Promise<ClaimResult> {
  const crypto = await loadCrypto();
  await crypto.init();

  const keys = crypto.generateBoxKeyPair();
  const ephemeralPublicKeyB64 = crypto.toBase64(keys.publicKey);

  const { status, data } = await relay.claimDeviceLink(token, ephemeralPublicKeyB64);
  if (status !== 200) throw new Error(data.error || "That code didn't work");

  return {
    keys,
    verificationCode: crypto.pairingVerificationCode(token, ephemeralPublicKeyB64),
  };
}

/** New phone: poll until the sealed bundle lands, then open it. */
export function awaitAccountBundle(
  token: string,
  keys: BoxKeyPair,
  onBundle: (bundle: AccountBundle) => void,
  onError: (err: Error) => void,
  timeoutMs = 10 * 60 * 1000
): () => void {
  let stopped = false;
  const deadline = Date.now() + timeoutMs;

  (async () => {
    const crypto = await loadCrypto();
    while (!stopped) {
      if (Date.now() > deadline) {
        onError(new Error("Timed out waiting for your other phone."));
        return;
      }
      try {
        const { status, data } = await relay.getDeviceLinkPayload(token);
        if (stopped) return;
        if (status === 404) throw new Error("This transfer expired. Start again on your other phone.");
        if (status !== 200) throw new Error(data.error || "Transfer failed");
        if (data.payload) {
          const json = crypto.openSealed(crypto.fromBase64(data.payload), keys);
          onBundle(JSON.parse(json) as AccountBundle);
          return;
        }
      } catch (e) {
        if (!stopped) onError(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  })();

  return () => { stopped = true; };
}

/** New phone: adopt the account, protecting the key at rest with a passphrase. */
export async function adoptAccount(
  bundle: AccountBundle,
  passphrase: string
): Promise<void> {
  await installAccountBundle(bundle, passphrase);
}
