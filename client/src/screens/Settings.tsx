import { createSignal, onMount } from "solid-js";
import { A } from "@solidjs/router";
import Nav from "../components/Nav";
import { isPushEnabled, registerPush, unregisterPush } from "../lib/push";
import { isPrfSupported } from "../lib/webauthn";
import { enableBiometrics, disableBiometrics, hasPrfCredential } from "../lib/store";
import styles from "./Settings.module.css";

export default function Settings() {
  const [pushOn, setPushOn] = createSignal(false);
  const [pushLoading, setPushLoading] = createSignal(true);
  const [bioSupported, setBioSupported] = createSignal(false);
  const [bioOn, setBioOn] = createSignal(false);
  const [bioLoading, setBioLoading] = createSignal(true);
  const [devMode, setDevMode] = createSignal(sessionStorage.getItem("devMode") === "1");

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
          <button class={styles.item} onClick={toggleBiometrics} disabled={bioLoading()}>
            <span>Biometrics</span>
            <span class="meta">{bioLoading() ? "..." : bioOn() ? "On" : "Off"}</span>
          </button>
        )}
        <button class={styles.item} onClick={() => { /* TODO */ }}>
          Change passphrase
        </button>
        <A href="/onboarding?relink=1" class={styles.item}>
          Re-add partner
        </A>
        <div class={styles.item}>
          <span>About Paper Hearts</span>
          <span class="meta">v1.0.0</span>
        </div>
        <button class={styles.item} onClick={toggleDevMode}>
          <span>Developer mode</span>
          <span class="meta">{devMode() ? "On" : "Off"}</span>
        </button>
      </div>

      <Nav />
    </div>
  );
}
