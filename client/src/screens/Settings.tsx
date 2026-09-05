import { createSignal, Match, onMount, Show, Switch } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import Nav from "../components/Nav";
import { isPushEnabled, registerPush, unregisterPush, sendTestNotification } from "../lib/push";
import { isPrfSupported } from "../lib/webauthn";
import { enableBiometrics, disableBiometrics, hasPrfCredential, breakupAndForget, changePassphrase, exportMonth, savePartnerName, checkConnectionHealth, unlockMethod, publicKey, partnerName } from "../lib/store";
import type { ConnectionHealth } from "../lib/store";
import styles from "./Settings.module.css";

export default function Settings() {
  const navigate = useNavigate();
  const [pushOn, setPushOn] = createSignal(false);
  const [pushLoading, setPushLoading] = createSignal(true);
  const [bioSupported, setBioSupported] = createSignal(false);
  const [bioOn, setBioOn] = createSignal(false);
  const [bioLoading, setBioLoading] = createSignal(true);
  const [devMode, setDevMode] = createSignal(sessionStorage.getItem("devMode") === "1");
  const [confirmBreakup, setConfirmBreakup] = createSignal(false);
  const [breakupLoading, setBreakupLoading] = createSignal(false);

  // Change passphrase
  const [showChangePassphrase, setShowChangePassphrase] = createSignal(false);
  const [currentPass, setCurrentPass] = createSignal("");
  const [newPass, setNewPass] = createSignal("");
  const [confirmPass, setConfirmPass] = createSignal("");
  const [changeLoading, setChangeLoading] = createSignal(false);
  const [changeError, setChangeError] = createSignal("");
  const [changeDone, setChangeDone] = createSignal(false);

  // Partner name
  const [showRenamePartner, setShowRenamePartner] = createSignal(false);
  const [partnerNameInput, setPartnerNameInput] = createSignal("");

  function openRenamePartner() {
    setPartnerNameInput(partnerName() === "Partner" ? "" : partnerName());
    setShowRenamePartner(true);
  }

  async function handleSavePartnerName() {
    await savePartnerName(partnerNameInput());
    setShowRenamePartner(false);
  }

  // Export
  const currentMonth = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };
  // Connection health
  const [health, setHealth] = createSignal<ConnectionHealth | null>(null);
  const [healthLoading, setHealthLoading] = createSignal(false);

  async function runHealthCheck() {
    setHealthLoading(true);
    setHealth(await checkConnectionHealth());
    setHealthLoading(false);
  }

  const [showExport, setShowExport] = createSignal(false);
  const [exportMonthVal, setExportMonthVal] = createSignal(currentMonth());
  const [exportLoading, setExportLoading] = createSignal(false);
  const [exportEmpty, setExportEmpty] = createSignal(false);

  onMount(async () => {
    if (!publicKey()) {
      navigate("/onboarding");
      return;
    }
    // Check push status
    setPushOn(await isPushEnabled());
    setPushLoading(false);

    // Check biometrics status
    const supported = await isPrfSupported();
    setBioSupported(supported);
    if (supported) {
      setBioOn(await hasPrfCredential());
    }
    setBioLoading(false);
  });

  async function togglePush() {
    setPushLoading(true);
    try {
      if (pushOn()) {
        await unregisterPush();
        setPushOn(false);
      } else {
        await registerPush();
        setPushOn(await isPushEnabled());
      }
    } catch (e) {
      console.error("Push toggle failed:", e);
    }
    setPushLoading(false);
  }

  function toggleDevMode() {
    const next = !devMode();
    setDevMode(next);
    if (next) sessionStorage.setItem("devMode", "1");
    else sessionStorage.removeItem("devMode");
  }

  async function toggleBiometrics() {
    setBioLoading(true);
    try {
      if (bioOn()) {
        await disableBiometrics();
        setBioOn(false);
      } else {
        await enableBiometrics();
        setBioOn(true);
      }
    } catch (e) {
      console.error("Biometrics toggle failed:", e);
    }
    setBioLoading(false);
  }

  async function handleBreakup() {
    setBreakupLoading(true);
    await breakupAndForget();
    navigate("/onboarding", { replace: true });
  }

  function openChangePassphrase() {
    setCurrentPass("");
    setNewPass("");
    setConfirmPass("");
    setChangeError("");
    setChangeDone(false);
    setShowChangePassphrase(true);
  }

  async function handleChangePassphrase() {
    if (newPass().length < 4) {
      setChangeError("At least 4 characters.");
      return;
    }
    if (newPass() !== confirmPass()) {
      setChangeError("Passphrases don't match.");
      return;
    }
    setChangeLoading(true);
    setChangeError("");
    const ok = await changePassphrase(currentPass(), newPass());
    setChangeLoading(false);
    if (!ok) {
      setChangeError("Current passphrase is wrong.");
    } else {
      setChangeDone(true);
      setTimeout(() => setShowChangePassphrase(false), 1200);
    }
  }

  async function handleExport() {
    setExportEmpty(false);
    setExportLoading(true);
    try {
      const content = await exportMonth(exportMonthVal());
      if (!content) {
        setExportEmpty(true);
        return;
      }
      // const [year, month] = exportMonthVal().split("-").map(Number);
      // const monthLabel = new Date(year, month - 1, 1).toLocaleDateString("en-US", {
      //   month: "long", year: "numeric",
      // });
      const filename = `paper-hearts-${exportMonthVal()}.md`;
      const file = new File([content], filename, { type: "text/markdown" });

      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      if (e?.name !== "AbortError") console.error("Export failed:", e);
    } finally {
      setExportLoading(false);
    }
  }

  return (
    <div class="page">
      <header class={styles.header}>
        <h2>Settings</h2>
      </header>

      <div class={styles.list}>
        <Show
          when={showRenamePartner()}
          fallback={
            <button class={styles.item} onClick={openRenamePartner}>
              <span>Partner name</span>
              <span class="meta">{partnerName() === "Partner" ? "Not set" : partnerName()}</span>
            </button>
          }
        >
          <form class={styles.passphraseForm} onSubmit={(e) => { e.preventDefault(); handleSavePartnerName(); }}>
            <input
              type="text"
              class={styles.passphraseInput}
              placeholder="e.g. Alex"
              aria-label="Partner's name"
              value={partnerNameInput()}
              onInput={(e) => setPartnerNameInput(e.currentTarget.value)}
              maxLength={30}
              autofocus
            />
            <div class={styles.dangerActions}>
              <button
                type="submit"
                class={styles.dangerConfirm}
                style={{ background: "var(--blush)" }}
              >
                Save
              </button>
              <button type="button" class={styles.dangerCancel} onClick={() => setShowRenamePartner(false)}>
                Cancel
              </button>
            </div>
          </form>
        </Show>
        <button class={styles.item} onClick={togglePush} disabled={pushLoading()}>
          <span>Notifications</span>
          <span class="meta">{pushLoading() ? "..." : pushOn() ? "This phone" : "Off"}</span>
        </button>
        {/* only show when there is already a passphrase set */}
        <Show when={bioSupported() && unlockMethod() !== "biometrics"}>
          <button
            class={styles.item}
            onClick={toggleBiometrics}
            disabled={bioLoading() || (bioOn() && unlockMethod() === "biometrics")}
          >
            <span>Biometrics</span>
            <span class="meta">{bioLoading() ? "..." : bioOn() ? "On" : "Off"}</span>
          </button>
        </Show>
        <Show when={!bioSupported()}>
          <Show
            when={showChangePassphrase()}
            fallback={
              <button class={styles.item} onClick={openChangePassphrase}>
                Change passphrase
              </button>
            }
          >
            <form class={styles.passphraseForm} onSubmit={(e) => { e.preventDefault(); handleChangePassphrase(); }}>
              <Show when={changeDone()}>
                <p class={styles.changeSuccess}>Passphrase updated.</p>
              </Show>
              <Show when={!changeDone()}>
                <input
                  type="password"
                  class={styles.passphraseInput}
                  placeholder="Current passphrase"
                  aria-label="Current passphrase"
                  value={currentPass()}
                  onInput={(e) => setCurrentPass(e.currentTarget.value)}
                  autofocus
                />
                <input
                  type="password"
                  class={styles.passphraseInput}
                  placeholder="New passphrase"
                  aria-label="New passphrase"
                  value={newPass()}
                  onInput={(e) => setNewPass(e.currentTarget.value)}
                />
                <input
                  type="password"
                  class={styles.passphraseInput}
                  placeholder="Confirm new passphrase"
                  aria-label="Confirm new passphrase"
                  value={confirmPass()}
                  onInput={(e) => setConfirmPass(e.currentTarget.value)}
                />
                <Show when={changeError()}>
                  <p class={styles.changeError} role="alert">{changeError()}</p>
                </Show>
                <div class={styles.dangerActions}>
                  <button
                    type="submit"
                    class={styles.dangerConfirm}
                    style={{ background: "var(--blush)" }}
                    disabled={changeLoading() || !currentPass() || !newPass() || !confirmPass()}
                  >
                    {changeLoading() ? "Saving..." : "Save"}
                  </button>
                  <button type="button" class={styles.dangerCancel} onClick={() => setShowChangePassphrase(false)}>
                    Cancel
                  </button>
                </div>
              </Show>
            </form>
          </Show>
        </Show>
        <button class={styles.item} onClick={() => { setShowExport((v) => !v); setExportEmpty(false); }}>
          <span>Export entries</span>
        </button>
        <Show when={showExport()}>
          <div class={styles.exportPanel}>
            <input
              type="month"
              class={styles.monthInput}
              value={exportMonthVal()}
              onInput={(e) => { setExportMonthVal(e.currentTarget.value); setExportEmpty(false); }}
              aria-label="Select month to export"
            />
            <button
              class="btn-primary"
              onClick={handleExport}
              disabled={exportLoading() || !exportMonthVal()}
            >
              {exportLoading() ? "Exporting..." : "Export"}
            </button>
            <Show when={exportEmpty()}>
              <p class={styles.exportEmpty}>No entries for this month.</p>
            </Show>
          </div>
        </Show>
        <button class={styles.item} onClick={runHealthCheck} disabled={healthLoading()}>
          <span>Check connection</span>
          <span class="meta">{healthLoading() ? "Checking..." : ""}</span>
        </button>
        <Show when={health()}>
          {(h) => (
            <div class={styles.healthPanel}>
              <Switch>
                <Match when={h().state === "ok"}>
                  <p class={styles.healthLine}>Connected. The relay and this device agree on your partner's key.</p>
                </Match>
                <Match when={h().state === "no-partner-on-relay"}>
                  <p class={styles.healthLine}>
                    <span class={styles.healthBad}>Not connected.</span> The relay has you on your own.
                  </p>
                  <p class={styles.healthDetail}>
                    This device thinks you're linked, but the relay disagrees — so nothing either of you
                    writes will reach the other. Re-add your partner below to fix it.
                  </p>
                </Match>
                <Match when={h().state === "key-mismatch"}>
                  <p class={styles.healthLine}>
                    <span class={styles.healthBad}>Keys don't match.</span> Your partner re-linked from a
                    different device.
                  </p>
                  <p class={styles.healthDetail}>
                    You're encrypting to their old key, so their entries can't be read. Re-add your partner
                    below to pick up the new one.
                  </p>
                </Match>
                <Match when={h().state === "not-paired"}>
                  <p class={styles.healthLine}>This device isn't linked to a partner yet.</p>
                </Match>
                <Match when={h().state === "locked"}>
                  <p class={styles.healthLine}>Unlock your diary first, then check again.</p>
                </Match>
                <Match when={h().state === "offline"}>
                  <p class={styles.healthLine}>You're offline. Try again when you have a connection.</p>
                </Match>
                <Match when={h().state === "error"}>
                  <p class={styles.healthLine}>
                    <span class={styles.healthBad}>Couldn't reach the relay.</span>
                  </p>
                  <p class={styles.healthDetail}>{(h() as { message: string }).message}</p>
                </Match>
              </Switch>
            </div>
          )}
        </Show>
        <A href="/onboarding?relink=1" class={styles.item}>
          Re-add partner
        </A>
        <A href="/device-link" class={styles.item}>
          Add another phone
        </A>
        <A href="/recovery" class={styles.item}>
          Backup &amp; recovery
        </A>
        <A href="/privacy" class={styles.item}>
          <span>Paper Hearts Privacy</span>
          <span class="meta">v1.0.0-{__GIT_HASH__}</span>
        </A>
        <button class={styles.item} onClick={toggleDevMode}>
          <span>Developer mode</span>
          <span class="meta">{devMode() ? "On" : "Off"}</span>
        </button>
        <Show when={devMode()}>
          <button class={styles.item} onClick={sendTestNotification}>
            Send test notification
          </button>
        </Show>
      </div>

      <div class={styles.danger}>
        <Switch>
          <Match when={devMode() && !confirmBreakup()}>
            <button class={styles.dangerItem} onClick={() => setConfirmBreakup(true)}>
              Breakup &amp; Forget
            </button>
          </Match>
          <Match when={devMode() && confirmBreakup()}> 
            <p class={styles.dangerWarning}>
              This deletes all your diary entries and removes you from the relay. It cannot be undone.
            </p>
            <div class={styles.dangerActions}>
            <button class={styles.dangerConfirm} onClick={handleBreakup} disabled={breakupLoading()}>
              {breakupLoading() ? "Deleting..." : "Delete everything"}
            </button>
            <button class={styles.dangerCancel} onClick={() => setConfirmBreakup(false)}>
              Cancel
            </button>
          </div>
          </Match>
        </Switch>
      </div>
      <Nav />
    </div>
  );
}
