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
  parseDeviceLinkToken,
} from "../lib/devicelink";
import type { AccountBundle } from "../lib/store";
import { unlock, unlockWithPrf, unlockMethod } from "../lib/store";
import { isIOS, isStandalonePWA } from "../lib/platform";
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
type ReceiveStep = "paste" | "checking" | "warn-replace" | "verify" | "protect" | "add-to-home" | "done";
type Side = "loading" | "send" | "receive";

export default function DeviceLink() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const urlToken = () => parseDeviceLinkToken(searchParams.token as string) ?? "";
  const [side, setSide] = createSignal<Side>("loading");

  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);

  onMount(async () => {
    if (urlToken()) {
      setSide("receive");
      return;
    }
    const { loadIdentity } = await import("../lib/storage");
    // A blank phone visiting /device-link is here to join, not to send.
    setSide((await loadIdentity()) ? "send" : "receive");
  });

  const receiving = () => side() === "receive";

  return (
    <div class="page">
      <BackButton href={receiving() ? "/onboarding" : "/settings"} />
      <div class={styles.center}>
        <Switch>
          <Match when={side() === "loading"}>
            <div />
          </Match>
          <Match when={side() === "send"}>
            <SendSide error={error} setError={setError} loading={loading} setLoading={setLoading} />
          </Match>
          <Match when={side() === "receive"}>
            <ReceiveSide
              initialToken={urlToken()}
              error={error}
              setError={setError}
              loading={loading}
              setLoading={setLoading}
              onDone={() => navigate("/", { replace: true })}
            />
          </Match>
        </Switch>
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

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      props.setError("Couldn't copy. Long-press the link instead.");
    }
  }

  return (
    <Switch>
      <Match when={step() === "auth"}>
        <h1 class={styles.heading}>Add another phone</h1>
        <p class={styles.sub}>
          Your other phone will hold the same diary. Either one can write — open the
          other phone to see it. Notifications ping only one phone, whichever last
          turned them on.
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
        <div class={styles.actions}>
          <button class="btn-primary" onClick={copyLink}>
            {copied() ? "Copied!" : "Copy link"}
          </button>
          <Show when={!!navigator.share}>
            <button
              class="btn-secondary"
              onClick={() => navigator.share({ url: link() }).catch(() => {})}
            >
              Share…
            </button>
          </Show>
        </div>
        <p class={styles.qrWarning}>
          On iPhone: add Paper Hearts to the Home Screen first, open it from the
          icon, then paste this link there. The Camera app opens Safari, which
          is a separate copy of the app and will not keep the diary.
        </p>
        <Show when={props.error()}>
          <p class={unlockStyles.error} role="alert">{props.error()}</p>
          <button class="btn-secondary" onClick={handleAuth} disabled={props.loading()}>
            Start again
          </button>
        </Show>
        <p class={local.warning}>
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
function ReceiveSide(props: SideProps & { initialToken: string; onDone: () => void }) {
  const [step, setStep] = createSignal<ReceiveStep>(props.initialToken ? "checking" : "paste");
  const [token, setToken] = createSignal(props.initialToken);
  const [paste, setPaste] = createSignal("");
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
    if (await loadIdentity()) {
      setStep("warn-replace");
      return;
    }
    if (token()) await beginClaim();
  });

  async function handlePaste() {
    const parsed = parseDeviceLinkToken(paste());
    if (!parsed) {
      props.setError("That doesn't look like a device-link. Paste the whole link, or the token from it.");
      return;
    }
    setToken(parsed);
    await beginClaim();
  }

  async function beginClaim() {
    const t = token();
    if (!t) {
      setStep("paste");
      return;
    }
    props.setLoading(true);
    props.setError("");
    setStep("checking");
    try {
      const result = await claimDeviceLink(t);
      setVerifyCode(result.verificationCode);
      setStep("verify");
      stopPolling = awaitAccountBundle(
        t,
        result.keys,
        (b) => { setBundle(b); setStep("protect"); },
        (err) => props.setError(err.message)
      );
    } catch (e: any) {
      props.setError(e.message || "That link didn't work.");
      setStep(t ? "checking" : "paste");
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
      // Do not register push here. One subscription per account — enabling
      // notifications on this phone would silently take them off the other.
      if (isIOS() && !isStandalonePWA()) {
        setStep("add-to-home");
      } else {
        setStep("done");
        setTimeout(props.onDone, 1500);
      }
    } catch (e: any) {
      props.setError(e.message || "Couldn't set up this phone.");
    } finally {
      props.setLoading(false);
    }
  }

  function continueAfterReplace() {
    if (token()) void beginClaim();
    else setStep("paste");
  }

  return (
    <Switch>
      <Match when={step() === "paste"}>
        <h1 class={styles.heading}>This is a second phone</h1>
        <Show when={isIOS() && !isStandalonePWA()}>
          <p class={styles.sub}>
            You're in Safari. iPhone keeps Safari and the Home Screen app separate —
            finish there, not here.
          </p>
          <ol class={local.steps}>
            <li>Tap Share, then Add to Home Screen.</li>
            <li>Open Paper Hearts from the icon.</li>
            <li>Come back to this screen and paste the link.</li>
          </ol>
        </Show>
        <Show when={!isIOS() || isStandalonePWA()}>
          <p class={styles.sub}>
            Paste the link from your other phone. Either phone can write after this;
            open this one to pick up new entries.
          </p>
        </Show>
        <div class={unlockStyles.form}>
          <input
            type="text"
            class={unlockStyles.input}
            placeholder="Paste the link here"
            aria-label="Device link"
            value={paste()}
            onInput={(e) => setPaste(e.currentTarget.value)}
            autofocus={isStandalonePWA() || !isIOS()}
            autocapitalize="off"
            autocomplete="off"
            spellcheck={false}
          />
          <Show when={props.error()}>
            <p class={unlockStyles.error} role="alert">{props.error()}</p>
          </Show>
          <button
            class="btn-primary"
            onClick={handlePaste}
            disabled={props.loading() || !paste().trim()}
          >
            {props.loading() ? "Connecting..." : "Continue"}
          </button>
        </div>
      </Match>

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
          <button class="btn-primary" onClick={continueAfterReplace} disabled={props.loading()}>
            Continue
          </button>
          <button class="btn-secondary" onClick={props.onDone}>Cancel</button>
        </div>
      </Match>

      <Match when={step() === "checking"}>
        <h2 class={styles.heading}>{props.error() ? "Couldn't connect" : "Connecting…"}</h2>
        <Show when={isIOS() && !isStandalonePWA() && !props.error()}>
          <p class={styles.sub}>
            If you opened this from Camera, you're in Safari. After the diary arrives,
            add this page to the Home Screen — or cancel, install from the site first,
            and paste the link inside the app.
          </p>
        </Show>
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

      <Match when={step() === "add-to-home"}>
        <h2 class={styles.heading}>Add this page to Home Screen</h2>
        <p class={styles.sub}>
          The diary is on this Safari tab. iPhone will not copy it to the Home Screen
          icon unless you add it from here.
        </p>
        <ol class={local.steps}>
          <li>Tap Share.</li>
          <li>Add to Home Screen.</li>
          <li>Open Paper Hearts from the new icon — not from Safari.</li>
        </ol>
        <p class={local.warning}>
          If the icon opens an empty diary, you added it from the site instead of
          this page. Open that icon, go to Add another phone, and paste the same link.
        </p>
        <button class={styles.linkButton} onClick={props.onDone}>
          Continue in Safari anyway
        </button>
      </Match>

      <Match when={step() === "done"}>
        <div class={styles.linkedAnim} aria-hidden="true">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="var(--blush)" stroke="none">
            <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
          </svg>
        </div>
        <h2 class={styles.heading}>This phone is ready.</h2>
        <p class={styles.sub}>Both phones now hold the same diary. Open the other one to pick up new writes.</p>
      </Match>
    </Switch>
  );
}
