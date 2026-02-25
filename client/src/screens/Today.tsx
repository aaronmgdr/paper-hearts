import { createSignal, Show, createResource, Suspense } from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import { getDayId, formatDayLabel } from "../lib/dayid";
import Nav from "../components/Nav";
import styles from "./Today.module.css";
import { loadDayEntries, fetchAndDecryptEntries, isPaired, submitEntry } from "../lib/store";

interface Entries {
  mine: string | null;
  partner: string | null;
}

async function fetchDay(dayId: string): Promise<Entries> {
  const result: Entries = { mine: null, partner: null };

  const local = await loadDayEntries(dayId);
  applyDayFile(local, result);

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

const isDevMode = () => sessionStorage.getItem("devMode") === "1";

export default function Today() {
  const params = useParams<{ dayId?: string }>();
  const navigate = useNavigate();
  const dayId = () => params.dayId || getDayId();
  const isToday = () => !params.dayId || params.dayId === getDayId();

  const [entries, { mutate }] = createResource(dayId, fetchDay);
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [sent, setSent] = createSignal(false);
  const [myExpanded, setMyExpanded] = createSignal(false);

  const bothRevealed = () => entries()?.mine != null && entries()?.partner != null;
  const showCompose = () => (isToday() || isDevMode()) && entries()?.mine == null;

  async function handleSubmit() {
    const content = text().trim();
    if (!content || sending()) return;

    setSending(true);
    try {
      await submitEntry(content, dayId());
      setSent(true);
      mutate((prev) => ({ mine: content, partner: prev?.partner ?? null }));
    } catch (e) {
      console.error("Failed to submit entry:", e);
      setSending(false);
    }
  }

  return (
    <div id="main-content" class="page" role="main">
      <header class={styles.header}>
        <h2>{formatDayLabel(dayId())}</h2>
        <Show when={isDevMode() && isToday()}>
          <input
            type="date"
            class={styles.devDateInput}
            max={getDayId()}
            onChange={(e) => {
              const val = e.currentTarget.value;
              if (val) navigate(`/archive/${val}`);
            }}
          />
        </Show>
      </header>

      <Suspense>
        <Show when={showCompose()}>
          <Show when={entries()?.partner != null}>
            <div class={styles.partnerWrote} role="status" aria-live="polite">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="var(--blush)" stroke="none" aria-hidden="true">
                <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
              </svg>
              <span class="label">Your partner has written today</span>
            </div>
          </Show>

          <div class={styles.editor}>
            <textarea
              class={styles.textarea}
              placeholder="What's on your heart today?"
              aria-label="Write your journal entry"
              value={text()}
              onInput={(e) => setText(e.currentTarget.value)}
              autofocus
            />
          </div>

          <footer class={styles.footer}>
            <span class="meta">{text().length} characters</span>
            <button
              class={sent() ? styles.btnSent : "btn-primary"}
              onClick={handleSubmit}
              disabled={!text().trim() || sending()}
            >
              {sent() ? "Sent" : sending() ? "Sending..." : "Send"}
            </button>
          </footer>
        </Show>

        <Show when={!showCompose()}>
          <div class={styles.entries}>
            <Show when={entries()?.mine}>
              {(text) => (
                <div
                  class={styles.entryCard}
                  classList={{ [styles.collapsed]: !myExpanded() }}
                  role="button"
                  tabindex="0"
                  aria-expanded={myExpanded()}
                  onClick={() => setMyExpanded((v) => !v)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setMyExpanded((v) => !v); } }}
                >
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
                  <p class={styles.veilLabel}>Waiting for your partner...</p>
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
        </Show>
      </Suspense>

      <Nav />
    </div>
  );
}
