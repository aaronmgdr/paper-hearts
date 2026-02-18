import { A } from "@solidjs/router";
import Nav from "../components/Nav";
import styles from "./Settings.module.css";

export default function Settings() {
  return (
    <div class="page">
      <header class={styles.header}>
        <h2>Settings</h2>
      </header>

      <div class={styles.list}>
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
