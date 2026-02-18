import { createSignal } from "solid-js";
import { unlock } from "../lib/store";
import styles from "./Unlock.module.css";

export default function UnlockScreen(props: { onUnlocked: () => void }) {
  const [passphrase, setPassphrase] = createSignal("");
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);

  async function handleUnlock(e: Event) {
    e.preventDefault();
    if (!passphrase().trim() || loading()) return;

    setLoading(true);
    setError("");
    const ok = await unlock(passphrase());
    setLoading(false);

    if (ok) {
      props.onUnlocked();
    } else {
      setError("Wrong passphrase. Try again.");
    }
  }

  return (
    <div class="page">
      <div class={styles.center}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--blush)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <h1 class={styles.heading}>Paper Hearts</h1>
        <form onSubmit={handleUnlock} class={styles.form}>
          <input
            type="password"
            class={styles.input}
            placeholder="Enter your passphrase"
            value={passphrase()}
            onInput={(e) => setPassphrase(e.currentTarget.value)}
            autofocus
          />
          {error() && <p class={styles.error}>{error()}</p>}
          <button type="submit" class="btn-primary" disabled={!passphrase().trim() || loading()}>
            {loading() ? "Unlocking..." : "Unlock"}
          </button>
        </form>
      </div>
    </div>
  );
}
