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
          <h2>There is no account recovery</h2>
          <p>
            Because we never hold your keys, we have no way to recover your data if
            you lose access to your device. If both you and your partner lose your
            devices or private keys, your entries are gone permanently. There is no
            reset link. There is no support ticket that can recover them.
          </p>
        </section>

        <section>
          <h2>Partner backup is the only way to recover</h2>
          <p>
            The only way to restore your writing after losing a device is to transfer
            your identity from your partner's device using the in-app recovery flow.
            Your partner's device holds a copy of the shared keys needed to re-derive
            access. Keep your partnership active and both devices in good health.
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
            We do have have the ability to read any of your information to sell it. 
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
