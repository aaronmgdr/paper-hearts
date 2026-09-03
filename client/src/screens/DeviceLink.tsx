import { createSignal, Match, Show, Switch, lazy, onCleanup, onMount } from "solid-js";
import type { QRSVGProps } from "solid-qr-code";
import { useNavigate, useSearchParams } from "@solidjs/router";

const QRCodeSVG = lazy(() => import("solid-qr-code").then((m) => ({ default: m.QRCodeSVG })));

import {
  startDeviceLink,
  awaitClaim,
  sendAccountBundle,
  claimDeviceLink,
  awaitAccountBundle,
  adoptAccount,
} from "../lib/devicelink";
import type { AccountBundle } from "../lib/store";
import { unlock, unlockWithPrf, unlockMethod } from "../lib/store";
import { registerPush } from "../lib/push";
import BackButton from "../components/BackButton";
import styles from "./Onboarding.module.css";
import unlockStyles from "./Unlock.module.css";
import local from "./DeviceLink.module.css";

const qrCode: QRSVGProps = {
  value: "",
  level: "medium",
  backgroundColor: "transparent",
  backgroundAlpha: 1,
  foregroundColor: "black",
  foregroundAlpha: 1,
  width: 256,
  height: 256,
};

type SendStep = "auth" | "share" | "verify" | "sending" | "done";
type ReceiveStep = "checking" | "warn-replace" | "verify" | "waiting" | "protect" | "done";

export default function DeviceLink() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const incomingToken = () => (searchParams.token as string) || "";
  const receiving = () => !!incomingToken();

  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);

  return (
    <div class="page">
      <BackButton href={receiving() ? "/onboarding" : "/settings"} />
      <div class={styles.center}>
        <Show
          when={receiving()}
          fallback={<SendSide error={error} setError={setError} loading={loading} setLoading={setLoading} />}
        >
          <ReceiveSide
            token={incomingToken()}
            error={error}
            setError={setError}
            loading={loading}
            setLoading={setLoading}
            onDone={() => navigate("/", { replace: true })}
          />
        </Show>
      </div>
    </div>
  );
}

interface SideProps {
  error: () => string;
  setError: (v: string) => void;
  loading: () => boolean;
  setLoading: (v: boolean) => void;
}

/** The phone that already has the diary. */
function SendSide(props: SideProps) {
  const navigate = useNavigate();
  const [step, setStep] = createSignal<SendStep>("auth");
  const [passphrase, setPassphrase] = createSignal("");
  const [link, setLink] = createSignal("");
  const [token, setToken] = createSignal("");
  const [ephemeralKey, setEphemeralKey] = createSignal("");
  const [verifyCode, setVerifyCode] = createSignal("");
  const [copied, setCopied] = createSignal(false);

  let stopPolling: (() => void) | undefined;
  onCleanup(() => stopPolling?.());

  async function handleAuth() {
    props.setLoading(true);
    props.setError("");
    try {
      const ok = unlockMethod() === "biometrics" ? await unlockWithPrf() : await unlock(passphrase());
      if (!ok) {
        props.setError("Authentication failed. Please try again.");
        return;
      }
      const session = await startDeviceLink();
      setToken(session.token);
      setLink(session.url);
      setStep("share");
      stopPolling = awaitClaim(
        session.token,
        (ephemeral, code) => {
          setEphemeralKey(ephemeral);
          setVerifyCode(code);
          setStep("verify");
        },
        (err) => props.setError(err.message)
      );
    } catch (e: any) {
      props.setError(e.message || "Something went wrong.");
    } finally {
      props.setLoading(false);
    }
  }

  async function handleSend() {
    props.setLoading(true);
    props.setError("");
    setStep("sending");
    try {
      await sendAccountBundle(token(), ephemeralKey());
      setStep("done");
      setTimeout(() => navigate("/settings", { replace: true }), 2000);
    } catch (e: any) {
      props.setError(e.message || "Couldn't send your diary.");
      setStep("verify");
    } finally {
      props.setLoading(false);
    }
  }

  return (
    <Switch>
      <Match when={step() === "auth"}>
        <h1 class={styles.heading}>Add another phone</h1>
        <p class={styles.sub}>
          Your other phone will hold the same diary — both phones stay in sync, and either
          one can write.
        </p>
        <Show
          when={unlockMethod() === "biometrics"}
          fallback={
            <div class={unlockStyles.form}>
              <input
                type="password"
                class={unlockStyles.input}
                placeholder="Your passphrase"
                aria-label="Your passphrase"
                value={passphrase()}
                onInput={(e) => setPassphrase(e.currentTarget.value)}
                autofocus
              />
              <Show when={props.error()}>
                <p class={unlockStyles.error} role="alert">{props.error()}</p>
              </Show>
              <button class="btn-primary" onClick={handleAuth} disabled={props.loading() || !passphrase()}>
                {props.loading() ? "Verifying..." : "Continue"}
              </button>
            </div>
          }
        >
          <div class={styles.actions}>
            <Show when={props.error()}>
              <p class={unlockStyles.error} role="alert">{props.error()}</p>
            </Show>
            <button class="btn-primary" onClick={handleAuth} disabled={props.loading()}>
              {props.loading() ? "Verifying..." : "Verify with biometrics"}
            </button>
          </div>
        </Show>
      </Match>

      <Match when={step() === "share"}>
        <h2 class={styles.heading}>Open this on your other phone</h2>
        <div class={styles.qrFrame}>
          <QRCodeSVG {...qrCode} value={link()} />
        </div>
        <p class={local.status}>Waiting for your other phone…</p>
        <button
          class="btn-primary"
          onClick={async () => {
            if (navigator.share) {
              await navigator.share({ url: link() }).catch(() => {});
            } else {
              navigator.clipboard.writeText(link());
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }
          }}
        >
          {copied() ? "Copied!" : "Share link"}
        </button>
        <Show when={props.error()}>
          <p class={unlockStyles.error} role="alert">{props.error()}</p>
          <button class="btn-secondary" onClick={handleAuth} disabled={props.loading()}>
            Start again
          </button>
        </Show>
        <p class={styles.qrWarning}>
          This link carries your whole diary to whichever device opens it. Only open it on a
          phone that is yours.
        </p>
      </Match>

      <Match when={step() === "verify"}>
        <h2 class={styles.heading}>Check the number</h2>
        <p class={local.code}>{verifyCode()}</p>
        <p class={local.codeLabel}>
          Your other phone should be showing the same six digits. If it isn't, stop — something
          is between the two devices.
        </p>
        <Show when={props.error()}>
          <p class={unlockStyles.error} role="alert">{props.error()}</p>
        </Show>
        <div class={styles.actions}>
          <button class="btn-primary" onClick={handleSend} disabled={props.loading()}>
            The numbers match — send my diary
          </button>
          <button class="btn-secondary" onClick={() => navigate("/settings", { replace: true })}>
            They don't match
          </button>
        </div>
      </Match>

      <Match when={step() === "sending"}>
        <h2 class={styles.heading}>Sending…</h2>
        <p class={styles.sub}>Encrypting your diary for your other phone.</p>
      </Match>

      <Match when={step() === "done"}>
        <h2 class={styles.heading}>Sent.</h2>
        <p class={styles.sub}>Finish setting up on your other phone.</p>
      </Match>
    </Switch>
  );
}

/** The phone that is joining an existing account. */
function ReceiveSide(props: SideProps & { token: string; onDone: () => void }) {
  const [step, setStep] = createSignal<ReceiveStep>("checking");
  const [verifyCode, setVerifyCode] = createSignal("");
  const [bundle, setBundle] = createSignal<AccountBundle | null>(null);
  const [passphrase, setPassphrase] = createSignal("");
  const [confirm, setConfirm] = createSignal("");

  let stopPolling: (() => void) | undefined;
  onCleanup(() => stopPolling?.());

  onMount(async () => {
    const { loadIdentity } = await import("../lib/storage");
    // Adopting an account replaces whatever identity is on this phone. On a
    // fresh install there is nothing to lose; anywhere else, say so first.
    setStep((await loadIdentity()) ? "warn-replace" : "checking");
    if (step() === "checking") await beginClaim();
  });

  async function beginClaim() {
    props.setLoading(true);
    props.setError("");
    try {
      const result = await claimDeviceLink(props.token);
      setVerifyCode(result.verificationCode);
      setStep("verify");
      stopPolling = awaitAccountBundle(
        props.token,
        result.keys,
        (b) => { setBundle(b); setStep("protect"); },
        (err) => props.setError(err.message)
      );
    } catch (e: any) {
      props.setError(e.message || "That link didn't work.");
      setStep("checking");
    } finally {
      props.setLoading(false);
    }
  }

  async function handleProtect() {
    if (passphrase().length < 8) {
      props.setError("Use at least 8 characters.");
      return;
    }
    if (passphrase() !== confirm()) {
      props.setError("Passphrases don't match.");
      return;
    }
    props.setLoading(true);
    props.setError("");
    try {
      await adoptAccount(bundle()!, passphrase());
      registerPush().catch(console.error);
      setStep("done");
      setTimeout(props.onDone, 1500);
    } catch (e: any) {
      props.setError(e.message || "Couldn't set up this phone.");
    } finally {
      props.setLoading(false);
    }
  }

  return (
    <Switch>
      <Match when={step() === "warn-replace"}>
        <h2 class={styles.heading}>Replace this diary?</h2>
        <p class={styles.sub}>
          This phone already has a Paper Hearts diary. Continuing replaces its identity with
          the one from your other phone.
        </p>
        <p class={styles.bundleWarning}>
          Entries already written here are kept and merged in, but this phone will stop being
          its own account. You'll set a new passphrase for it, and any biometric unlock on
          this phone will need setting up again in Settings.
        </p>
        <Show when={props.error()}>
          <p class={unlockStyles.error} role="alert">{props.error()}</p>
        </Show>
        <div class={styles.actions}>
          <button class="btn-primary" onClick={beginClaim} disabled={props.loading()}>
            Continue
          </button>
          <button class="btn-secondary" onClick={props.onDone}>Cancel</button>
        </div>
      </Match>

      <Match when={step() === "checking"}>
        <h2 class={styles.heading}>{props.error() ? "Couldn't connect" : "Connecting…"}</h2>
        <Show when={props.error()}>
          <p class={unlockStyles.error} role="alert">{props.error()}</p>
          <div class={styles.actions}>
            <button class="btn-primary" onClick={beginClaim} disabled={props.loading()}>
              Try again
            </button>
            <button class="btn-secondary" onClick={props.onDone}>Cancel</button>
          </div>
        </Show>
      </Match>

      <Match when={step() === "verify"}>
        <h2 class={styles.heading}>Check the number</h2>
        <p class={local.code}>{verifyCode()}</p>
        <p class={local.codeLabel}>
          Your other phone should be showing the same six digits. Confirm there, and your diary
          will arrive here.
        </p>
        <Show when={!props.error()}>
          <p class={local.status}>Waiting for your other phone…</p>
        </Show>
        <Show when={props.error()}>
          <p class={unlockStyles.error} role="alert">{props.error()}</p>
          <div class={styles.actions}>
            <button class="btn-primary" onClick={beginClaim} disabled={props.loading()}>
              Try again
            </button>
          </div>
        </Show>
      </Match>

      <Match when={step() === "protect"}>
        <h2 class={styles.heading}>Protect this phone</h2>
        <p class={styles.sub}>
          Your diary arrived. Choose a passphrase to unlock it on this device — it can be
          different from the one on your other phone.
        </p>
        <div class={unlockStyles.form}>
          <input
            type="password"
            class={unlockStyles.input}
            placeholder="Passphrase (8+ characters)"
            aria-label="Passphrase"
            value={passphrase()}
            onInput={(e) => setPassphrase(e.currentTarget.value)}
            autofocus
          />
          <input
            type="password"
            class={unlockStyles.input}
            placeholder="Confirm passphrase"
            aria-label="Confirm passphrase"
            value={confirm()}
            onInput={(e) => setConfirm(e.currentTarget.value)}
          />
          <Show when={props.error()}>
            <p class={unlockStyles.error} role="alert">{props.error()}</p>
          </Show>
          <button class="btn-primary" onClick={handleProtect} disabled={props.loading()}>
            {props.loading() ? "Setting up..." : "Finish"}
          </button>
        </div>
      </Match>

      <Match when={step() === "done"}>
        <div class={styles.linkedAnim} aria-hidden="true">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="var(--blush)" stroke="none">
            <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
          </svg>
        </div>
        <h2 class={styles.heading}>This phone is ready.</h2>
        <p class={styles.sub}>Both phones now hold the same diary.</p>
      </Match>
    </Switch>
  );
}
