import { Show, createResource, Suspense } from "solid-js";
import { useParams } from "@solidjs/router";
import { getDayId, formatDayLabel } from "../lib/dayid";
import Nav from "../components/Nav";
import styles from "./Today.module.css";
import { loadDayEntries, fetchAndDecryptEntries, isPaired } from "../lib/store";

interface Entries {
  mine: string | null;
  partner: string | null;
}

async function fetchDay(dayId: string): Promise<Entries> {
  const result: Entries = { mine: null, partner: null };

  // Load local first
  const local = await loadDayEntries(dayId);
  applyDayFile(local, result);

  // Fetch from relay if paired
  if (isPaired()) {
    try {
      await fetchAndDecryptEntries(dayId);
      const updated = await loadDayEntries(dayId);
      applyDayFile(updated, result);
    } catch (e) {
      console.error("Failed to fetch partner entries:", e);
    }
  }

  return result;
}

function applyDayFile(dayFile: Awaited<ReturnType<typeof loadDayEntries>>, result: Entries) {
  dayFile?.entries.forEach((e) => {
    if (e.author === "me") {
      result.mine = e.payload;
    } else {
      result.partner = e.payload;
    }
  });
}

export default function Today() {
  const params = useParams<{ dayId?: string }>();
  const dayId = () => params.dayId || getDayId();

  const [entries] = createResource(dayId, fetchDay);

  const bothRevealed = () => entries()?.mine != null && entries()?.partner != null;

  return (
    <div class="page">
      <header class={styles.header}>
        <h2>{formatDayLabel(dayId())}</h2>
      </header>

      <Suspense>
        <div class={styles.entries}>
          <Show
            when={entries()?.mine}
            fallback={
              <div class={styles.emptyCard}>
                <a class={styles.linkCompose} href="/compose">Dear Diary...</a>
              </div>
            }
          >
            {(text) => (
              <div class={styles.entryCard}>
                <span class="label">You</span>
                <p class={styles.entryText}>{text()}</p>
              </div>
            )}
          </Show>

          <Show
            when={entries()?.partner}
            fallback={
              <div class={styles.veil} role="status" aria-label="Waiting for partner's entry">
                <div class={styles.veilHeart} aria-hidden="true">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="var(--blush)" stroke="none">
                    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
                  </svg>
                </div>
                <p class="label">Waiting for your partner...</p>
              </div>
            }
          >
            {(text) => (
              <div class={styles.entryCard} classList={{ [styles.revealed]: bothRevealed() }}>
                <span class="label">Partner</span>
                <p class={styles.entryText}>{text()}</p>
              </div>
            )}
          </Show>
        </div>
      </Suspense>

      <Nav />
    </div>
  );
}
