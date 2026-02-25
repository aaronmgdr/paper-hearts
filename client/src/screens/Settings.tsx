import { createSignal, Match, onMount, Show, Switch } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import Nav from "../components/Nav";
import { isPushEnabled, registerPush, unregisterPush, sendTestNotification } from "../lib/push";
import { isPrfSupported } from "../lib/webauthn";
import { enableBiometrics, disableBiometrics, hasPrfCredential, breakupAndForget, changePassphrase, unlockMethod } from "../lib/store";
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

  onMount(async () => {
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
    console.log("Toggling push notifications...");
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

  return (
    <div class="page">
      <header class={styles.header}>
        <h2>Settings</h2>
      </header>

      <div class={styles.list}>
        <button class={styles.item} onClick={togglePush} disabled={pushLoading()}>
          <span>Notifications</span>
          <span class="meta">{pushLoading() ? "..." : pushOn() ? "On" : "Off"}</span>
        </button>
        {bioSupported() && (
          <button
            class={styles.item}
            onClick={toggleBiometrics}
            disabled={bioLoading() || (bioOn() && unlockMethod() === "biometrics")}
          >
            <span>Biometrics</span>
            <span class="meta">{bioLoading() ? "..." : bioOn() ? "On" : "Off"}</span>
          </button>
        )}
        <Show when={unlockMethod() !== "biometrics"}>
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
        <A href="/onboarding?relink=1" class={styles.item}>
          Re-add partner
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
