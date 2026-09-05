import { isIOS } from "./platform";

// WebAuthn PRF extension helpers for biometric unlock

/** Fixed salt used for PRF evaluation — must never change once deployed. */
const PRF_SALT_INPUT = "paper-hearts-prf-v1";

async function getPrfSalt(): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  return crypto.subtle.digest("SHA-256", encoder.encode(PRF_SALT_INPUT));
}

/**
 * Check if the current device supports WebAuthn PRF with a platform authenticator.
 * This is a lightweight check — no user interaction required.
 */
export async function isPrfSupported(): Promise<boolean> {
  if (
    typeof window === "undefined" ||
    !window.PublicKeyCredential ||
    !PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable
  ) {
    return false;
  }

  const platformAvailable =
    await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  if (!platformAvailable) return false;

  // Face ID counts as a platform authenticator, but Safari/iOS does not
  // implement WebAuthn PRF. Offering "Use biometrics" there only fails later.
  if (isIOS()) {
    const getCaps = (
      PublicKeyCredential as typeof PublicKeyCredential & {
        getClientCapabilities?: () => Promise<{ prf?: boolean }>;
      }
    ).getClientCapabilities;
    if (typeof getCaps !== "function") return false;
    try {
      const caps = await getCaps.call(PublicKeyCredential);
      return caps.prf === true;
    } catch {
      return false;
    }
  }

  // Other browsers: a platform authenticator is a strong enough hint to offer
  // the choice. Registration still fails closed if PRF is missing.
  return true;
}

/**
 * Register a new WebAuthn credential with PRF extension.
 * Triggers a biometric prompt. Returns the credential ID and the PRF-derived key.
 */
export async function registerPrfCredential(
  userId: Uint8Array
): Promise<{ credentialId: Uint8Array; prfKey: Uint8Array }> {
  const salt = await getPrfSalt();

  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "Paper Hearts", id: location.hostname },
      user: {
        id: userId as BufferSource,
        name: "Paper Hearts User",
        displayName: "Paper Hearts User",
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { alg: -7, type: "public-key" },   // ES256
        { alg: -257, type: "public-key" },  // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "preferred",
      },
      extensions: {
        prf: { eval: { first: salt } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;

  if (!credential) throw new Error("Credential creation cancelled");

  const ext = (credential.getClientExtensionResults() as any).prf;
  if (!ext?.enabled && !ext?.results?.first) {
    throw new Error("PRF extension not supported by this authenticator");
  }

  // If we got results from creation, use them; otherwise do a get() to evaluate PRF
  let prfOutput: ArrayBuffer;
  if (ext.results?.first) {
    prfOutput = ext.results.first;
  } else {
    // Some implementations only return PRF on get(), not create()
    const credentialId = new Uint8Array(credential.rawId);
    const key = await authenticateWithPrf(credentialId);
    return { credentialId, prfKey: key };
  }

  return {
    credentialId: new Uint8Array(credential.rawId),
    prfKey: new Uint8Array(prfOutput),
  };
}

/**
 * Authenticate with an existing credential and evaluate PRF to get the key.
 * Triggers a biometric prompt.
 */
export async function authenticateWithPrf(
  credentialId: Uint8Array
): Promise<Uint8Array> {
  const salt = await getPrfSalt();

  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [
        {
          id: credentialId as BufferSource,
          type: "public-key",
          transports: ["internal"],
        },
      ],
      userVerification: "required",
      extensions: {
        prf: { eval: { first: salt } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;

  if (!assertion) throw new Error("Authentication cancelled");

  const ext = (assertion.getClientExtensionResults() as any).prf;
  if (!ext?.results?.first) {
    throw new Error("PRF evaluation failed — no output returned");
  }

  return new Uint8Array(ext.results.first);
}
