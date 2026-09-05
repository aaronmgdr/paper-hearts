import * as relay from "./relay";
import { buildAccountBundle, installAccountBundle, publicKey, secretKey } from "./store";
import type { AccountBundle } from "./store";
import type { BoxKeyPair } from "./crypto";

const loadCrypto = () => import("./crypto");

const POLL_INTERVAL_MS = 2000;

/**
 * A refusal from the relay — an expired token, someone else's session. Ends the
 * transfer. Anything else thrown while polling is the network, and these run on
 * phones that lock their screens and change cells mid-handshake, so those are
 * retried rather than treated as failure.
 */
class TransferRefused extends Error {}

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

/**
 * Accept a raw mailbox token, a `/device-link?token=` path, or a full URL.
 * iPhone Camera opens Safari instead of the Home Screen app, so the receiving
 * phone often pastes this by hand rather than following a scanned link.
 */
export function parseDeviceLinkToken(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const fromQuery = (value: string): string | undefined => {
    const match = value.match(/[?&]token=([^&]+)/);
    if (!match) return undefined;
    try {
      return decodeURIComponent(match[1].replace(/\+/g, " ")) || undefined;
    } catch {
      return match[1] || undefined;
    }
  };

  try {
    const url = new URL(trimmed);
    const fromSearch = url.searchParams.get("token");
    if (fromSearch) return fromSearch;
  } catch {
    // Not an absolute URL — fall through to query / raw token.
  }

  const queried = fromQuery(trimmed);
  if (queried) return queried;

  // Device-link tokens are 32 random bytes, URL-safe base64 (no padding).
  if (/^[A-Za-z0-9_-]{16,}$/.test(trimmed)) return trimmed;
  return undefined;
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
        if (status === 404) throw new TransferRefused("This transfer expired. Start again.");
        if (status !== 200) throw new TransferRefused(data.error || "Transfer failed");
        if (data.ephemeralPublicKey) {
          onClaimed(
            data.ephemeralPublicKey,
            pairingVerificationCode(token, data.ephemeralPublicKey)
          );
          return;
        }
      } catch (e) {
        if (stopped) return;
        if (e instanceof TransferRefused) {
          onError(e);
          return;
        }
        console.info("[devicelink] poll failed, retrying:", e);
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
        if (status === 404) {
          throw new TransferRefused("This transfer expired. Start again on your other phone.");
        }
        if (status !== 200) throw new TransferRefused(data.error || "Transfer failed");
        if (data.payload) {
          // A bundle that won't open is terminal — it was sealed to a different
          // key, which is the case the six-digit check exists to catch.
          let bundle: AccountBundle;
          try {
            bundle = JSON.parse(
              crypto.openSealed(crypto.fromBase64(data.payload), keys)
            ) as AccountBundle;
          } catch {
            throw new TransferRefused("That bundle wasn't meant for this phone. Start again.");
          }
          onBundle(bundle);
          return;
        }
      } catch (e) {
        if (stopped) return;
        if (e instanceof TransferRefused) {
          onError(e);
          return;
        }
        console.info("[devicelink] poll failed, retrying:", e);
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
