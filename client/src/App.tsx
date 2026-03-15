import { type ParentProps, Show, createSignal, onMount } from "solid-js";
import { useLocation } from "@solidjs/router";
import { initialize, isReady, isPaired, fetchAndDecryptEntries, setupNetworkListeners } from "./lib/store";
import { getDayId } from "./lib/dayid";
import { flushOutbox, listenForSyncMessages } from "./lib/sync";
// import { registerPush } from "./lib/push";
import UnlockScreen from "./screens/Unlock";


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

  return (
    <Show when={isReady()} fallback={<div class="page" />}>
      <a href="#main-content" class="skip-link">Skip to main content</a>
      <Show
        when={unlocked() || location.pathname === "/onboarding"}
        fallback={<UnlockScreen onUnlocked={() => {
          setUnlocked(true);
          
          if (isPaired()) {
            listenForSyncMessages();
            // registerPush().catch(console.error); [Violation] Only request notification permission in response to a user gesture.
            fetchAndDecryptEntries(getDayId()).catch(console.error);
            flushOutbox().catch(console.error);
          }
        }} />}
      >
        {props.children}
      </Show>
    </Show>
  );
}
