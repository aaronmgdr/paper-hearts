import { createSignal, Match, Switch, Show, onCleanup, onMount, lazy } from "solid-js";
import type { QRSVGProps } from "solid-qr-code";
import { useNavigate, useSearchParams } from "@solidjs/router";

const QRCodeSVG = lazy(() => import("solid-qr-code").then((m) => ({ default: m.QRCodeSVG })));

import type { WatchHandle } from "../lib/relay";
import { createIdentity, createBiometricsOnlyIdentity, initiateHandshake, joinHandshake, startWatchingForPartner, unlock, unlockWithPrf, unlockMethod, uploadHistoryBundleOverWs, collectHistoryBundle } from "../lib/store";
import { isPrfSupported } from "../lib/webauthn";
import { registerPush } from "../lib/push";
import BackButton from "../components/BackButton";
import styles from "./Onboarding.module.css";
import unlockStyles from "./Unlock.module.css";

type Step = "start" | "passphrase" | "relink-auth" | "show-qr" | "scan-qr" | "linked" | "offer-bundle" | "receive-bundle";

  const qrCode: QRSVGProps = {
    value: "", // this is replaced dynamically, but we need to set it to something to avoid type errors
    level: "medium",
    backgroundColor: "transparent",
    backgroundAlpha: 1,
    foregroundColor: "black",
    foregroundAlpha: 1,
    width: 256,
    height: 256,
  };

export default function Onboarding() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const relink = !!searchParams.relink;
  const [step, setStep] = createSignal<Step>(searchParams.token ? "passphrase" : "start");
  const [role, setRole] = createSignal<"initiator" | "follower">(searchParams.token ? "follower" : "initiator");
  const [passphrase, setPassphrase] = createSignal("");
  const [confirm, setConfirm] = createSignal("");
  const [relinkPassphrase, setRelinkPassphrase] = createSignal("");
  const [error, setError] = createSignal("");
  const [qrData, setQrData] = createSignal("");
  const [tokenInput, setTokenInput] = createSignal(searchParams.token as string || "");
  const [loading, setLoading] = createSignal(false);
  const [prfSupported, setPrfSupported] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [bundleWaiting, setBundleWaiting] = createSignal(false);

  onMount(async () => {
    setPrfSupported(await isPrfSupported());
  });

  function chooseRole(r: "initiator" | "follower") {
    setRole(r);
    if (relink) {
      // Always require re-authentication before generating a link code.
      // Someone picking up an unlocked phone shouldn't be able to replace your connection.
      setStep("relink-auth");
    } else {
      setStep("passphrase");
    }
  }

  const pairingToken = () => qrData()?.split("token=")[1]

  async function handleRelinkAuth() {
    setLoading(true);
    setError("");
    try {
      let ok = false;
      if (unlockMethod() === "biometrics") {
        ok = await unlockWithPrf();
      } else {
        ok = await unlock(relinkPassphrase());
      }
      if (!ok) {
        setError("Authentication failed. Please try again.");
        setLoading(false);
        return;
      }
      await proceedAfterPassphrase();
    } catch (e: any) {
      setError(e.message || "Authentication failed.");
      setLoading(false);
    }
  }

  async function handlePassphrase() {
    if (passphrase().length < 4) {
      setError("At least 4 characters.");
      return;
    }
    if (passphrase() !== confirm()) {
      setError("Passphrases don't match.");
      return;
    }
    setError("");
    setLoading(true);

    try {
      await createIdentity(passphrase());
      await proceedAfterPassphrase();
    } catch (e: any) {
      setError(e.message || "Something went wrong.");
      setLoading(false);
    }
  }

  async function handleBiometricsOnly() {
    setLoading(true);
    setError("");
    try {
      await createBiometricsOnlyIdentity();
      await proceedAfterPassphrase();
    } catch (e: any) {
      setError(e.message || "Biometric setup failed. Try a passphrase instead.");
      setLoading(false);
    }
  }

  async function proceedAfterPassphrase() {
    if (role() === "initiator") {
      setLoading(true);
      setError("");
      try {
        const { relayToken } = await initiateHandshake();
        const url = new URL(window.location.href);
        url.searchParams.set("token", relayToken);
        setQrData(url.toString());
        setStep("show-qr");
        startWatching();
      } catch (e: any) {
        setError(e.message || "Couldn't reach server. Please try again.");
      } finally {
        setLoading(false);
      }
    } else {
      setLoading(false);
      setStep("scan-qr");
    }
  }

  async function handleJoin() {
    const token = tokenInput().trim();
    if (!token) return;
    setLoading(true);
    setError("");

    try {
      await joinHandshake(token);
      registerPush().catch(console.error);
      if (relink) {
        setStep("receive-bundle");
      } else {
        setStep("linked");
        setTimeout(() => navigate("/", { replace: true }), 1500);
      }
    } catch (e: any) {
      setError(e.message || "Invalid code.");
    }
    setLoading(false);
  }

  let watchHandle: WatchHandle | undefined;

  function startWatching() {
    watchHandle = startWatchingForPartner(
      () => {
        registerPush().catch(console.error);
        if (relink) {
          setStep("offer-bundle");
        } else {
          setStep("linked");
          setTimeout(() => navigate("/", { replace: true }), 1500);
        }
      },
      (err) => setError(err.message),
    );
  }

  async function handleSendBundle() {
    setLoading(true);
    setError("");
    try {
      if (watchHandle) await uploadHistoryBundleOverWs(watchHandle.sendBundle);
    } catch (e: any) {
      setError(e.message || "Failed to send entries.");
    }
    setLoading(false);
    setStep("linked");
    setTimeout(() => navigate("/", { replace: true }), 1500);
  }

  function handleSkipBundle() {
    watchHandle?.stop();
    setStep("linked");
    setTimeout(() => navigate("/", { replace: true }), 1500);
  }

  let stopCollecting: (() => void) | undefined;

  function handleStartCollecting() {
    setLoading(true);
    setError("");
    setBundleWaiting(false);
    stopCollecting = collectHistoryBundle(
      () => { setLoading(false); navigate("/", { replace: true }); },
      () => { setBundleWaiting(true); setLoading(false); },
      (err) => { setLoading(false); setError(err.message); }
    );
  }

  onCleanup(() => {
    watchHandle?.stop();
    stopCollecting?.();
  });

  return (
    <div class="page">
      <Show when={relink && step() === "start"}>
        <BackButton href="/settings" />
      </Show>
      <div class={styles.center}>
        <Switch>
          <Match when={step() === "start"}>
            <h1 class={styles.heading}>{relink ? "Re-add your partner" : "Start your diary"}</h1>
            <p class={styles.sub}>{relink ? "Generate a code for your partner to scan on their new device." : "Paper Hearts is a private shared diary for two."}</p>
            <div class={styles.actions}>
              <Show
                when={relink}
                fallback={<>
                  <button class="btn-primary" onClick={() => chooseRole("initiator")}>
                    I'll start — show my code
                  </button>
                  <button class="btn-secondary" onClick={() => chooseRole("follower")}>
                    I have a code to scan
                  </button>
                </>}
              >
                <button class="btn-primary" onClick={() => chooseRole("initiator")} disabled={loading()}>
                  {loading() ? "Generating..." : "Generate code"}
                </button>
              </Show>
            </div>
          </Match>

          <Match when={step() === "relink-auth"}>
            <h2 class={styles.heading}>Confirm it's you</h2>
            <p class={styles.sub}>Verify your identity before generating a new link code.</p>
            <Show
              when={unlockMethod() === "biometrics"}
              fallback={
                <div class={unlockStyles.form}>
                  <input
                    type="password"
                    class={unlockStyles.input}
                    placeholder="Your passphrase"
                    aria-label="Your passphrase"
                    value={relinkPassphrase()}
                    onInput={(e) => setRelinkPassphrase(e.currentTarget.value)}
                    autofocus
                  />
                  <Show when={error()}>
                    <p class={unlockStyles.error} role="alert">{error()}</p>
                  </Show>
                  <button
                    class="btn-primary"
                    onClick={handleRelinkAuth}
                    disabled={loading() || !relinkPassphrase()}
                  >
                    {loading() ? "Verifying..." : "Continue"}
                  </button>
                </div>
              }
            >
              <div class={styles.actions}>
                <Show when={error()}>
                  <p class={unlockStyles.error} role="alert">{error()}</p>
                </Show>
                <button class="btn-primary" onClick={handleRelinkAuth} disabled={loading()}>
                  {loading() ? "Verifying..." : "Verify with biometrics"}
                </button>
              </div>
            </Show>
          </Match>

          <Match when={step() === "passphrase"}>
            <h2 class={styles.heading}>Protect your diary</h2>
            <p class={styles.sub}>Choose how you'll unlock your diary on this device.</p>
            <Show when={prfSupported()}>
              <div class={styles.actions}>
                <button class="btn-primary" onClick={handleBiometricsOnly} disabled={loading()}>
                  {loading() ? "Setting up..." : "Use biometrics"}
                </button>
              </div>
              <p class={styles.orDivider}>or set a passphrase</p>
            </Show>
            <div class={unlockStyles.form}>
              <input
                type="password"
                class={unlockStyles.input}
                placeholder="Passphrase (8+ characters)"
                aria-label="Passphrase"
                value={passphrase()}
                onInput={(e) => setPassphrase(e.currentTarget.value)}
              />
              <input
                type="password"
                class={unlockStyles.input}
                placeholder="Confirm passphrase"
                aria-label="Confirm passphrase"
                value={confirm()}
                onInput={(e) => setConfirm(e.currentTarget.value)}
              />
              <Show when={error()}>
                <p class={unlockStyles.error} role="alert">{error()}</p>
              </Show>
              <button
                class="btn-secondary"
                onClick={handlePassphrase}
                disabled={loading()}
              >
                {loading() ? "Setting up..." : "Use passphrase"}
              </button>
            </div>
          </Match>

          <Match when={step() === "show-qr"}>
            <h2 class={styles.heading}>{relink ? "Share with your partner's new device" : "Show this to your person"}</h2>
            <div class={styles.qrFrame}>
              <QRCodeSVG {...qrCode} value={qrData()} />
            </div>
            <code>{pairingToken()}</code>
            <button
              class="btn-primary"
              onClick={async () => {
                if (navigator.share) {
                  await navigator.share({ url: qrData() }).catch(() => {});
                } else {
                  navigator.clipboard.writeText(qrData());
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }
              }}
            >
              {copied() ? "Copied!" : "Share link"}
            </button>

            <p class={styles.qrWarning}>
              Only share this with your partner. Anyone who scans it can replace your connection.
            </p>
          </Match>

          <Match when={step() === "scan-qr"}>
            <h2 class={styles.heading}>Enter your partner's code</h2>
            <div class={unlockStyles.form}>
              <input
                type="text"
                class={unlockStyles.input}
                placeholder="Paste the code here"
                aria-label="Partner's link code"
                value={tokenInput()}
                onInput={(e) => setTokenInput(e.currentTarget.value)}
                autofocus
              />
              <Show when={error()}>
                <p class={unlockStyles.error} role="alert">{error()}</p>
              </Show>
              <button
                class="btn-primary"
                onClick={handleJoin}
                disabled={loading() || !tokenInput().trim()}
              >
                {loading() ? "Linking..." : "Link diaries"}
              </button>
            </div>
          </Match>

          <Match when={step() === "offer-bundle"}>
            <div class={styles.linkedAnim} aria-hidden="true">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="var(--blush)" stroke="none">
                <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
              </svg>
            </div>
            <h2 class={styles.heading}>You're linked.</h2>
            <p class={styles.sub}>Share your diary history with your partner's new device?</p>
            <p class={styles.bundleWarning}>
              Only do this if you are certain this is the same person you've been writing with. Your private entries will be sent encrypted.
            </p>
            <Show when={error()}>
              <p class={unlockStyles.error} role="alert">{error()}</p>
            </Show>
            <div class={styles.actions}>
              <button class="btn-primary" onClick={handleSendBundle} disabled={loading()}>
                {loading() ? "Sending..." : "Share my entries"}
              </button>
              <button class="btn-secondary" onClick={handleSkipBundle} disabled={loading()}>
                Skip for now
              </button>
            </div>
          </Match>

          <Match when={step() === "receive-bundle"}>
            <div class={styles.linkedAnim} aria-hidden="true">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="var(--blush)" stroke="none">
                <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
              </svg>
            </div>
            <h2 class={styles.heading}>You're linked.</h2>
            <p class={styles.sub}>Your partner can share their diary history with you.</p>
            <Show when={bundleWaiting()}>
              <p class={styles.sub}>Waiting for your partner to send…</p>
            </Show>
            <Show when={error()}>
              <p class={unlockStyles.error} role="alert">{error()}</p>
            </Show>
            <div class={styles.actions}>
              <button class="btn-primary" onClick={handleStartCollecting} disabled={loading()}>
                {loading() ? "Receiving…" : (error() ? "Try again" : "Accept entries")}
              </button>
              <button class="btn-secondary" onClick={() => navigate("/", { replace: true })} disabled={loading()}>
                Skip
              </button>
            </div>
          </Match>

          <Match when={step() === "linked"}>
            <div class={styles.linkedAnim} aria-hidden="true">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="var(--blush)" stroke="none">
                <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
              </svg>
            </div>
            <h2 class={styles.heading}>You're linked.</h2>
            <p class={styles.sub}>Your diaries are now connected.</p>
          </Match>
        </Switch>
      </div>
    </div>
  );
}
