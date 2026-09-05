import { type ParentProps, Show, createEffect, createSignal, onMount } from "solid-js";
import { useLocation } from "@solidjs/router";
import { initialize, isReady, isPaired, secretKey, fetchAndDecryptEntries, setupNetworkListeners } from "./lib/store";
import { getSyncSince } from "./lib/dayid";
import { flushOutbox, listenForSyncMessages } from "./lib/sync";
// import { registerPush } from "./lib/push";
import UnlockScreen from "./screens/Unlock";

/** Routes that must work before the diary is unlocked — a new phone, or one
 *  whose passphrase is gone but a backup remains. */
function isPublicRoute(pathname: string): boolean {
  return pathname === "/onboarding" || pathname === "/restore" || pathname === "/device-link";
}

let syncStarted = false;
function startSyncedSession() {
  if (syncStarted || !isPaired()) return;
  syncStarted = true;
  listenForSyncMessages();
  // registerPush().catch(console.error); [Violation] Only request notification permission in response to a user gesture.
  fetchAndDecryptEntries(getSyncSince(), { sync: "full" }).catch(console.error);
  flushOutbox().catch(console.error);
}

export default function App(props: ParentProps) {
  const [unlocked, setUnlocked] = createSignal(false);
  const location = useLocation();

  onMount(async () => {
    // ── Service worker update handling ──────────────────────────────────────
    if ("serviceWorker" in navigator) {
      // When user returns to the app after it was backgrounded, a new SW may
      // already be installed and waiting. Send SKIP_WAITING so it activates.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          navigator.serviceWorker.getRegistration().then((reg) => {
            if (reg?.waiting) {
              reg.waiting.postMessage({ type: "SKIP_WAITING" });
            }
          });
        }
      });

      // When a new SW takes control, reload to serve the latest assets.
      // Guard: only reload if there was already a controller (i.e. this is an
      // update, not the very first SW install on a fresh visit).
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          window.location.reload();
        });
      }
    }
    // ────────────────────────────────────────────────────────────────────────

   
    await initialize();
    setupNetworkListeners();
    // If no identity exists, go to onboarding
    const { loadIdentity } = await import("./lib/storage");
    const identity = await loadIdentity();
    if (!identity) {
      setUnlocked(true); // No identity yet — show Today, prompt on first submit
    }
  });

  // Restore and device-link install the key in memory without going through
  // UnlockScreen. Treat that as unlocked and start sync the same way.
  createEffect(() => {
    if (secretKey()) {
      setUnlocked(true);
      startSyncedSession();
    }
  });

  return (
    <Show when={isReady()} fallback={<div class="page" />}>
      <a href="#main-content" class="skip-link">Skip to main content</a>
      <Show
        when={unlocked() || isPublicRoute(location.pathname)}
        fallback={<UnlockScreen onUnlocked={() => {
          setUnlocked(true);
          startSyncedSession();
        }} />}
      >
        {props.children}
      </Show>
    </Show>
  );
}
