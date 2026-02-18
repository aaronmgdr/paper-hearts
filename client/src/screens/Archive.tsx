import { For, Switch, Match, createResource } from "solid-js";
import { A } from "@solidjs/router";
import { formatDayLabel } from "../lib/dayid";
import Nav from "../components/Nav";
import styles from "./Archive.module.css";
import { loadAllDays, loadDayEntries } from "../lib/store";

interface DayEntry {
  dayId: string;
  myEntry: boolean;
  partnerEntry: boolean;
}

async function fetchArchive(): Promise<DayEntry[]> {
  const dayIds = await loadAllDays();
  const entries: DayEntry[] = [];

  for (const dayId of dayIds) {
    try {
      const day = await loadDayEntries(dayId);
      if (day) {
        entries.push({
          dayId,
          myEntry: day.entries.some((e) => e.author === "me"),
          partnerEntry: day.entries.some((e) => e.author === "partner"),
        });
      }
    } catch (e) {
      console.error(`Failed to load day ${dayId}:`, e);
    }
  }

  return entries.sort((a, b) => b.dayId.localeCompare(a.dayId));
}

export default function Archive() {
  const [days] = createResource(fetchArchive);

  return (
    <div class="page">
      <header class={styles.header}>
        <h2>Archive</h2>
      </header>

      <div class={styles.list}>
        <Switch>
          <Match when={days.loading}>
            <p class="label" style={{ "text-align": "center", "padding-top": "48px" }}>Loading...</p>
          </Match>
          <Match when={days.error}>
            <p class="label" style={{ "text-align": "center", "padding-top": "48px" }}>
              Failed to load archive: {String(days.error)}
            </p>
          </Match>
          <Match when={days()?.length === 0}>
            <p class="label" style={{ "text-align": "center", "padding-top": "48px" }}>No entries yet.</p>
          </Match>
          <Match when={days()}>
            <For each={days()}>
              {(day) => (
                <A href={`/archive/${day.dayId}`} class={styles.row}>
                  <span class={styles.dayLabel}>{formatDayLabel(day.dayId)}</span>
                  <span class={styles.hearts} aria-label={heartLabel(day)}>
                    <Heart filled={day.myEntry} />
                    <Heart filled={day.partnerEntry} />
                  </span>
                </A>
              )}
            </For>
          </Match>
        </Switch>
      </div>

      <Nav />
    </div>
  );
}

function Heart(props: { filled: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={props.filled ? "var(--blush)" : "none"} stroke={props.filled ? "var(--blush)" : "var(--veiled)"} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
    </svg>
  );
}

function heartLabel(day: DayEntry): string {
  if (day.myEntry && day.partnerEntry) return "Both wrote";
  if (day.myEntry) return "Only you wrote";
  if (day.partnerEntry) return "Only partner wrote";
  return "Neither wrote";
}
