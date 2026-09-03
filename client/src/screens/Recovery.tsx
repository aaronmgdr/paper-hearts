import { createSignal, Match, Show, Switch, onMount } from "solid-js";
import {
  createRecoveryCode,
  uploadRecoveryBackup,
  setRecoveryCodeForRefresh,
  getRecoveryBackupStatus,
  deleteRecoveryBackup,
  isRecoveryBackupEnabled,
  exportBackupFile,
} from "../lib/backup";
import type { RecoveryBackupStatus } from "../lib/backup";
import { publicKey } from "../lib/store";
import BackButton from "../components/BackButton";
import Nav from "../components/Nav";
import styles from "./Onboarding.module.css";
import unlockStyles from "./Unlock.module.css";
import local from "./DeviceLink.module.css";
import settingsStyles from "./Settings.module.css";

type Panel = "none" | "file" | "code-intro" | "code-show" | "code-confirm" | "code-done";

export default function Recovery() {
  const [panel, setPanel] = createSignal<Panel>("none");
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);

  const [status, setStatus] = createSignal<RecoveryBackupStatus>({ exists: false });
  const [enabled, setEnabled] = createSignal(false);

  const [filePass, setFilePass] = createSignal("");
  const [fileConfirm, setFileConfirm] = createSignal("");
  const [recoveryCode, setRecoveryCode] = createSignal("");
  const [typedCode, setTypedCode] = createSignal("");
  const [copied, setCopied] = createSignal(false);

  onMount(async () => {
    if (!publicKey()) return;
    setEnabled(await isRecoveryBackupEnabled());
    setStatus(await getRecoveryBackupStatus());
  });

  async function handleExportFile() {
    if (filePass().length < 8) return setError("Use at least 8 characters.");
    if (filePass() !== fileConfirm()) return setError("Passphrases don't match.");
    setError("");
    setLoading(true);
    try {
      const { filename, json } = await exportBackupFile(filePass());
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setPanel("none");
      setFilePass("");
      setFileConfirm("");
    } catch (e: any) {
      setError(e.message || "Couldn't create the backup file.");
    }
    setLoading(false);
  }

  async function handleGenerateCode() {
    setError("");
    setLoading(true);
    try {
      setRecoveryCode(await createRecoveryCode());
      setPanel("code-show");
    } catch (e: any) {
      setError(e.message || "Couldn't create a recovery code.");
    }
    setLoading(false);
  }

  async function handleConfirmCode() {
    const { normalizeRecoveryCode } = await import("../lib/crypto");
    if (normalizeRecoveryCode(typedCode()) !== normalizeRecoveryCode(recoveryCode())) {
      return setError("That doesn't match. Check what you wrote down.");
    }
    setError("");
    setLoading(true);
    try {
      await uploadRecoveryBackup(recoveryCode());
      await setRecoveryCodeForRefresh(recoveryCode());
      setEnabled(true);
      setStatus(await getRecoveryBackupStatus());
      setRecoveryCode("");
      setTypedCode("");
      setPanel("code-done");
    } catch (e: any) {
      setError(e.message || "Couldn't save your backup.");
    }
    setLoading(false);
  }

  async function handleTurnOff() {
    setLoading(true);
    setError("");
    try {
      await deleteRecoveryBackup();
      setEnabled(false);
      setStatus({ exists: false });
    } catch (e: any) {
      setError(e.message || "Couldn't remove the backup.");
    }
    setLoading(false);
  }

  const lastSaved = () =>
    status().updatedAt ? new Date(status().updatedAt!).toLocaleDateString() : "";

  return (
    <div class="page">
      <BackButton href="/settings" />
      <div class={styles.center}>
        <h1 class={styles.heading}>Backup &amp; recovery</h1>
        <p class={styles.sub}>
          Your diary lives on your phones. If every phone is lost, these are the only ways back.
        </p>
      </div>

      <div class={settingsStyles.list}>
        <button class={settingsStyles.item} onClick={() => { setPanel(panel() === "file" ? "none" : "file"); setError(""); }}>
          <span>Save a backup file</span>
        </button>
        <Show when={panel() === "file"}>
          <div class={settingsStyles.exportPanel}>
            <p class={local.status}>
              An encrypted file you keep yourself — iCloud, Drive, a laptop. Nothing is sent to
              the relay. It only holds what you had written when you saved it.
            </p>
            <div class={unlockStyles.form}>
              <input
                type="password"
                class={unlockStyles.input}
                placeholder="Passphrase for this file (8+)"
                aria-label="Backup file passphrase"
                value={filePass()}
                onInput={(e) => setFilePass(e.currentTarget.value)}
              />
              <input
                type="password"
                class={unlockStyles.input}
                placeholder="Confirm passphrase"
                aria-label="Confirm backup file passphrase"
                value={fileConfirm()}
                onInput={(e) => setFileConfirm(e.currentTarget.value)}
              />
              <Show when={error()}>
                <p class={unlockStyles.error} role="alert">{error()}</p>
              </Show>
              <button class="btn-primary" onClick={handleExportFile} disabled={loading()}>
                {loading() ? "Preparing..." : "Download backup"}
              </button>
            </div>
            <p class={local.status}>
              Without this passphrase the file cannot be opened — not by us, not by anyone.
            </p>
          </div>
        </Show>

        <button
          class={settingsStyles.item}
          onClick={() => { setPanel(panel() === "none" ? "code-intro" : "none"); setError(""); }}
        >
          <span>Recovery code backup</span>
          <span class="meta">{enabled() && status().exists ? `On · ${lastSaved()}` : "Off"}</span>
        </button>

        <Show when={panel() !== "none" && panel() !== "file"}>
          <div class={settingsStyles.exportPanel}>
            <Switch>
              <Match when={panel() === "code-intro"}>
                <p class={local.status}>
                  Keeps an encrypted copy of your diary on the relay, refreshed as you write.
                  A recovery code — yours alone — is the only thing that can open it, so you
                  can restore with no phone and no partner.
                </p>
                <p class={local.status}>
                  The relay stores ciphertext it has no key for. Write the code down somewhere
                  that isn't your phone; it cannot be reissued.
                </p>
                <Show when={error()}>
                  <p class={unlockStyles.error} role="alert">{error()}</p>
                </Show>
                <div class={styles.actions}>
                  <button class="btn-primary" onClick={handleGenerateCode} disabled={loading()}>
                    {loading() ? "Working..." : enabled() ? "Create a new code" : "Set it up"}
                  </button>
                  <Show when={enabled() && status().exists}>
                    <button class="btn-secondary" onClick={handleTurnOff} disabled={loading()}>
                      Turn off and delete
                    </button>
                  </Show>
                </div>
              </Match>

              <Match when={panel() === "code-show"}>
                <p class={local.status}>Write this down. You will be asked to type it back.</p>
                <p class={local.recoveryCode}>{recoveryCode()}</p>
                <div class={styles.actions}>
                  <button
                    class="btn-secondary"
                    onClick={() => {
                      navigator.clipboard.writeText(recoveryCode());
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                  >
                    {copied() ? "Copied!" : "Copy"}
                  </button>
                  <button class="btn-primary" onClick={() => { setPanel("code-confirm"); setError(""); }}>
                    I've written it down
                  </button>
                </div>
              </Match>

              <Match when={panel() === "code-confirm"}>
                <p class={local.status}>Type the code back to confirm you have it.</p>
                <div class={unlockStyles.form}>
                  <input
                    type="text"
                    class={unlockStyles.input}
                    placeholder="Your recovery code"
                    aria-label="Recovery code"
                    autocomplete="off"
                    autocapitalize="characters"
                    value={typedCode()}
                    onInput={(e) => setTypedCode(e.currentTarget.value)}
                  />
                  <Show when={error()}>
                    <p class={unlockStyles.error} role="alert">{error()}</p>
                  </Show>
                  <button class="btn-primary" onClick={handleConfirmCode} disabled={loading() || !typedCode()}>
                    {loading() ? "Saving..." : "Confirm and back up"}
                  </button>
                  <button class="btn-secondary" onClick={() => { setPanel("code-show"); setError(""); }}>
                    Show me the code again
                  </button>
                </div>
              </Match>

              <Match when={panel() === "code-done"}>
                <p class={local.status}>
                  Recovery backup is on. It refreshes each time you write, so keep that code
                  somewhere safe and lasting.
                </p>
                <button class="btn-secondary" onClick={() => setPanel("none")}>Done</button>
              </Match>
            </Switch>
          </div>
        </Show>
      </div>
      <Nav />
    </div>
  );
}
