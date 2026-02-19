import { createSignal, Match, Switch, Show, onCleanup, onMount, lazy } from "solid-js";
import type { QRSVGProps } from "solid-qr-code";
import { useNavigate, useSearchParams } from "@solidjs/router";

const QRCodeSVG = lazy(() => import("solid-qr-code").then((m) => ({ default: m.QRCodeSVG })));

import { createIdentity, createBiometricsOnlyIdentity, initiateHandshake, joinHandshake, pollForPartner } from "../lib/store";
import { isPrfSupported } from "../lib/webauthn";
import BackButton from "../components/BackButton";
import styles from "./Onboarding.module.css";
import unlockStyles from "./Unlock.module.css";

type Step = "start" | "passphrase" | "show-qr" | "scan-qr" | "linked";


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
  const [error, setError] = createSignal("");
  const [qrData, setQrData] = createSignal("");
  const [tokenInput, setTokenInput] = createSignal(searchParams.token as string || "");
  const [loading, setLoading] = createSignal(false);
  const [prfSupported, setPrfSupported] = createSignal(false);

  onMount(async () => {
    setPrfSupported(await isPrfSupported());
  });

  function chooseRole(r: "initiator" | "follower") {
    setRole(r);
    if (relink) {
      proceedAfterPassphrase();
    } else {
      setStep("passphrase");
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
        startPolling();
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
      setStep("linked");
      setTimeout(() => navigate("/", { replace: true }), 1500);
    } catch (e: any) {
      setError(e.message || "Invalid code.");
    }
    setLoading(false);
  }

  
  

  let pollTimer: ReturnType<typeof setInterval> | undefined;

  function startPolling() {
    pollTimer = setInterval(async () => {
      const partner = await pollForPartner();
      if (partner) {
        clearInterval(pollTimer);
        setStep("linked");
        setTimeout(() => navigate("/", { replace: true }), 1500);
      }
    }, 3000);
  }

  onCleanup(() => {
    if (pollTimer) clearInterval(pollTimer);
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
            <p class={styles.sub}>{relink ? "Link your diary with a new partner code." : "Paper Hearts is a private shared diary for two."}</p>
            <div class={styles.actions}>
              <button class="btn-primary" onClick={() => chooseRole("initiator")}>
                I'll start — show my code
              </button>
              <button class="btn-secondary" onClick={() => chooseRole("follower")}>
                I have a code to scan
              </button>
            </div>
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
                value={passphrase()}
                onInput={(e) => setPassphrase(e.currentTarget.value)}
              />
              <input
                type="password"
                class={unlockStyles.input}
                placeholder="Confirm passphrase"
                value={confirm()}
                onInput={(e) => setConfirm(e.currentTarget.value)}
              />
              <Show when={error()}>
                <p class={unlockStyles.error}>{error()}</p>
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
            <h2 class={styles.heading}>Show this to your person</h2>
            <div class={styles.qrFrame}>
              <div class={styles.tokenDisplay}>
                <QRCodeSVG {...qrCode} value={qrData()} />
              </div>
            </div>
            <span class="label" style={{ "text-align": "center" }}>{qrData()}</span>
            <p class="label" style={{ "text-align": "center" }}>
              Share this code with your partner. It expires in 10 minutes.
            </p>
          </Match>

          <Match when={step() === "scan-qr"}>
            <h2 class={styles.heading}>Enter your partner's code</h2>
            <div class={unlockStyles.form}>
              <input
                type="text"
                class={unlockStyles.input}
                placeholder="Paste the code here"
                value={tokenInput()}
                onInput={(e) => setTokenInput(e.currentTarget.value)}
                autofocus
              />
              <Show when={error()}>
                <p class={unlockStyles.error}>{error()}</p>
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

          <Match when={step() === "linked"}>
            <div class={styles.linkedAnim} aria-label="You're linked">
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
