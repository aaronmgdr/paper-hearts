import { createSignal, Match, Show, Switch } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { restoreFromRecoveryCode, readBackupFile, restoreAccount } from "../lib/backup";
import type { AccountBundle } from "../lib/store";
import { registerPush } from "../lib/push";
import BackButton from "../components/BackButton";
import styles from "./Onboarding.module.css";
import unlockStyles from "./Unlock.module.css";
import local from "./DeviceLink.module.css";

type Step = "choose" | "code" | "file" | "protect" | "done";

export default function Restore() {
  const navigate = useNavigate();
  const [step, setStep] = createSignal<Step>("choose");
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);

  const [code, setCode] = createSignal("");
  const [filePass, setFilePass] = createSignal("");
  const [fileJson, setFileJson] = createSignal("");
  const [fileName, setFileName] = createSignal("");
  const [bundle, setBundle] = createSignal<AccountBundle | null>(null);

  const [passphrase, setPassphrase] = createSignal("");
  const [confirm, setConfirm] = createSignal("");

  async function handleCode() {
    setLoading(true);
    setError("");
    try {
      setBundle(await restoreFromRecoveryCode(code()));
      setStep("protect");
    } catch (e: any) {
      setError(e.message || "Couldn't restore from that code.");
    }
    setLoading(false);
  }

  async function handleFilePick(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setFileJson(await file.text());
    setError("");
  }

  async function handleFile() {
    setLoading(true);
    setError("");
    try {
      setBundle(await readBackupFile(fileJson(), filePass()));
      setStep("protect");
    } catch (e: any) {
      setError(e.message || "Couldn't open that backup.");
    }
    setLoading(false);
  }

  async function handleProtect() {
    if (passphrase().length < 8) return setError("Use at least 8 characters.");
    if (passphrase() !== confirm()) return setError("Passphrases don't match.");
    setLoading(true);
    setError("");
    try {
      await restoreAccount(bundle()!, passphrase());
      registerPush().catch(console.error);
      setStep("done");
      setTimeout(() => navigate("/", { replace: true }), 1500);
    } catch (e: any) {
      setError(e.message || "Couldn't set up this phone.");
    }
    setLoading(false);
  }

  const restoredDays = () => bundle()?.days?.length ?? 0;

  return (
    <div class="page">
      <BackButton href="/onboarding" />
      <div class={styles.center}>
        <Switch>
          <Match when={step() === "choose"}>
            <h1 class={styles.heading}>Restore your diary</h1>
            <p class={styles.sub}>Bring back a diary from a backup you made earlier.</p>
            <div class={styles.actions}>
              <button class="btn-primary" onClick={() => { setStep("code"); setError(""); }}>
                I have a recovery code
              </button>
              <button class="btn-secondary" onClick={() => { setStep("file"); setError(""); }}>
                I have a backup file
              </button>
            </div>
          </Match>

          <Match when={step() === "code"}>
            <h2 class={styles.heading}>Enter your recovery code</h2>
            <p class={styles.sub}>
              The code you wrote down when you turned on recovery backup.
            </p>
            <div class={unlockStyles.form}>
              <input
                type="text"
                class={unlockStyles.input}
                placeholder="XXXX-XXXX-XXXX-…"
                aria-label="Recovery code"
                autocomplete="off"
                autocapitalize="characters"
                value={code()}
                onInput={(e) => setCode(e.currentTarget.value)}
                autofocus
              />
              <Show when={error()}>
                <p class={unlockStyles.error} role="alert">{error()}</p>
              </Show>
              <button class="btn-primary" onClick={handleCode} disabled={loading() || !code().trim()}>
                {loading() ? "Looking..." : "Restore"}
              </button>
            </div>
          </Match>

          <Match when={step() === "file"}>
            <h2 class={styles.heading}>Open your backup file</h2>
            <p class={styles.sub}>The .phbak file you saved, and its passphrase.</p>
            <div class={unlockStyles.form}>
              <input
                type="file"
                accept=".phbak,application/json"
                aria-label="Backup file"
                onChange={handleFilePick}
              />
              <Show when={fileName()}>
                <p class={local.status}>{fileName()}</p>
              </Show>
              <input
                type="password"
                class={unlockStyles.input}
                placeholder="Backup passphrase"
                aria-label="Backup passphrase"
                value={filePass()}
                onInput={(e) => setFilePass(e.currentTarget.value)}
              />
              <Show when={error()}>
                <p class={unlockStyles.error} role="alert">{error()}</p>
              </Show>
              <button
                class="btn-primary"
                onClick={handleFile}
                disabled={loading() || !fileJson() || !filePass()}
              >
                {loading() ? "Opening..." : "Restore"}
              </button>
            </div>
          </Match>

          <Match when={step() === "protect"}>
            <h2 class={styles.heading}>Protect this phone</h2>
            <p class={styles.sub}>
              {restoredDays()} {restoredDays() === 1 ? "day" : "days"} recovered. Choose a
              passphrase to unlock your diary on this device.
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
              <Show when={error()}>
                <p class={unlockStyles.error} role="alert">{error()}</p>
              </Show>
              <button class="btn-primary" onClick={handleProtect} disabled={loading()}>
                {loading() ? "Setting up..." : "Finish"}
              </button>
            </div>
          </Match>

          <Match when={step() === "done"}>
            <div class={styles.linkedAnim} aria-hidden="true">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="var(--blush)" stroke="none">
                <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
              </svg>
            </div>
            <h2 class={styles.heading}>Your diary is back.</h2>
            <p class={styles.sub}>
              Your partner may need to re-add you before new entries start flowing again.
            </p>
          </Match>
        </Switch>
      </div>
    </div>
  );
}
