import { A } from "@solidjs/router";
import styles from "./Privacy.module.css";

export default function Privacy() {
  return (
    <div class="page">
      <header class={styles.header}>
        <A href="/settings" class={styles.back}>← Back</A>
        <h1>Privacy Policy</h1>
        <p class="meta">Last updated February 2026</p>
      </header>

      <div class={styles.body}>
        <section>
          <h2>What Paper Hearts is</h2>
          <p>
            Paper Hearts is a private, end-to-end encrypted shared diary for two people.
            We cannot read your entries. No one can, except you and your partner.
          </p>
        </section>

        <section>
          <h2>Your data is encrypted before it leaves your device</h2>
          <p>
            Every entry is encrypted on your device using a shared secret derived from
            both your cryptographic keys before it is sent to our server. The server
            stores only ciphertext — it has no knowledge of your passphrase, your keys,
            or the contents of your diary.
          </p>
        </section>

        <section>
          <h2>You can delete everything</h2>
          <p>
            You can permanently delete all your entries and remove yourself from the
            relay server at any time from Settings → Breakup &amp; Forget. This is
            irreversible and deletes your data from our servers immediately.
          </p>
        </section>

        <section>
          <h2>How long the relay holds an entry</h2>
          <p>
            An encrypted entry stays on the relay for 30 days after it is written, then
            it is deleted. It has to outlive the moment your partner first reads it, so
            that a second phone on the same account can still collect it — your partner's
            entries and your own. The relay holds ciphertext throughout and never holds
            the key.
          </p>
        </section>

        <section>
          <h2>Recovery is yours to arrange</h2>
          <p>
            We never hold your keys, so we cannot recover anything for you. There is no
            reset link and no support ticket that can bring a diary back.
          </p>
          <p>
            What we do offer is two ways to arrange it yourself, in Settings → Backup
            &amp; recovery. A <strong>backup file</strong> is encrypted with a passphrase
            you choose and saved wherever you keep it — it never touches our server. A{" "}
            <strong>recovery code backup</strong> keeps an encrypted copy on the relay,
            openable only with a code generated on your device and shown to you once. We
            never see that code, and without it the copy cannot be read by us or anyone
            else.
          </p>
          <p>
            The trade is real: with recovery turned on, an encrypted copy of your diary
            exists somewhere other than your phones, and anyone who finds your recovery
            code can open it. If you would rather that copy not exist, leave it off —
            and accept that losing every device loses the diary.
          </p>
        </section>

        <section>
          <h2>If one phone remains</h2>
          <p>
            Settings → Add another phone copies this account onto a new device. That is
            how you replace a phone, not how you recover from losing every device —
            that is what a backup file or recovery code is for. On iPhone, add Paper
            Hearts to the Home Screen first and paste the link inside that app — a
            Camera scan opens Safari, which does not keep the same diary.
          </p>
        </section>

        <section>
          <h2>Analytics</h2>
          <p>
            We may collect anonymous, aggregate usage metrics — such as the number of
            entries submitted, pairs created, re-pairings, and account deletions — to
            understand how the app is being used. These counts are never linked to
            your identity, your keys, or the content of your entries.
          </p>
          <p>
            We do not use third-party analytics services. Any metrics collected are
            server-side counters only.
          </p>
        </section>

        <section>
          <h2>No advertising. No selling your data.</h2>
          <p>
            We do not have the ability to read any of your information, and we do not sell it.
          </p>
        </section>

        <section>
          <h2>Contact</h2>
          <p>
            Questions? Email us at{" "}
            <a href="mailto:hello@paperhearts.app">hello@paperhearts.app</a>.
          </p>
        </section>
      </div>
    </div>
  );
}
