import { useNavigate } from "@solidjs/router";
import styles from "./BackButton.module.css";

export default function BackButton(props: { href?: string; label?: string }) {
  const navigate = useNavigate();

  function handleClick() {
    if (props.href) {
      navigate(props.href, { replace: true });
    } else {
      history.back();
    }
  }

  return (
    <header class={styles.header}>
      <button class={styles.button} onClick={handleClick}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        {props.label ?? "Back"}
      </button>
    </header>
  );
}
