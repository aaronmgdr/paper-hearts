import { createSignal, onMount, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { getDayId, formatDayLabel } from "../lib/dayid";
import Nav from "../components/Nav";
import styles from "./Compose.module.css";
import { submitEntry } from "../lib/store";

export default function Compose() {
  const navigate = useNavigate();
  const dayId = getDayId();
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [sent, setSent] = createSignal(false);

  // Track the visual viewport height so the page shrinks when the keyboard appears,
  // keeping the footer (and Send button) visible above the keyboard.
  const getVVH = () => window.visualViewport?.height ?? window.innerHeight;
  const [viewHeight, setViewHeight] = createSignal(getVVH());
  const initialHeight = getVVH();
  const keyboardOpen = () => viewHeight() < initialHeight - 150;

  onMount(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setViewHeight(vv.height);
    vv.addEventListener("resize", update);
    onCleanup(() => vv.removeEventListener("resize", update));
  });

  async function handleSubmit() {
    const content = text().trim();
    if (!content || sending()) return;

    setSending(true);
    try {
      console.log("Submitting entry for", dayId, content);
      await submitEntry(content, dayId);
      setSent(true);
      setTimeout(() => navigate("/"), 800);
    } catch (e) {
      console.error("Failed to submit entry:", e);
      setSending(false);
    }
  }

  return (
    <div
      class="page"
      role="main"
      style={{ height: `${viewHeight()}px`, "min-height": "unset", overflow: "hidden" }}
    >
      <header class={styles.header}>
        <h2>{formatDayLabel(dayId)}</h2>
      </header>

      <div class={styles.editor}>
        <textarea
          class={styles.textarea}
          placeholder="What's on your heart today?"
          value={text()}
          spellcheck="true"
          onInput={(e) => setText(e.currentTarget.value)}
          autofocus
        />
      </div>

      <footer
        class={styles.footer}
        style={keyboardOpen() ? { "padding-bottom": "var(--space-2)" } : undefined}
      >
        <span class="meta">{text().length} characters</span>
        <button
          class={sent() ? styles.btnSent : "btn-primary"}
          onClick={handleSubmit}
          disabled={!text().trim() || sending()}
        >
          {sent() ? "Sent" : sending() ? "Sending..." : "Send"}
        </button>
      </footer>

      <Nav />
    </div>
  );
}
