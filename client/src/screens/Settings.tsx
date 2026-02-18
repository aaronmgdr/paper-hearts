import { createSignal, onMount } from "solid-js";
import { A } from "@solidjs/router";
import Nav from "../components/Nav";
import { isPushEnabled, registerPush, unregisterPush } from "../lib/push";
import styles from "./Settings.module.css";

export default function Settings() {
  const [pushOn, setPushOn] = createSignal(false);
  const [pushLoading, setPushLoading] = createSignal(true);

  onMount(async () => {
    setPushOn(await isPushEnabled());
    setPushLoading(false);
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
        <button class={styles.item} onClick={() => { /* TODO */ }}>
          Change passphrase
        </button>
        <A href="/onboarding" class={styles.item}>
          Re-add partner
        </A>
        <div class={styles.item}>
          <span>About Paper Hearts</span>
          <span class="meta">v1.0.0</span>
        </div>
      </div>

      <Nav />
    </div>
  );
}
