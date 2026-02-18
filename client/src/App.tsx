import { type ParentProps, Show, createSignal, onMount } from "solid-js";
import { useNavigate, useLocation } from "@solidjs/router";
import { initialize, isReady, isPaired, fetchAndDecryptEntries } from "./lib/store";
import { getDayId } from "./lib/dayid";
import { flushOutbox, listenForSyncMessages } from "./lib/sync";
import UnlockScreen from "./screens/Unlock";

export default function App(props: ParentProps) {
  const [unlocked, setUnlocked] = createSignal(false);
  const navigate = useNavigate();
  const location = useLocation();

  onMount(async () => {
    await initialize();
    // If no identity exists, go to onboarding
    const { loadIdentity } = await import("./lib/storage");
    const identity = await loadIdentity();
    if (!identity) {
      navigate("/onboarding", { replace: true });
      setUnlocked(true); // onboarding doesn't need unlock
    }
  });

  return (
    <Show when={isReady()} fallback={<div class="page" />}>
      <Show
        when={unlocked() || location.pathname === "/onboarding"}
        fallback={<UnlockScreen onUnlocked={() => {
          setUnlocked(true);
          
          if (isPaired()) {
            listenForSyncMessages();
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
