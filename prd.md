
# Product Requirements Document: Paper Hearts (v1.2)

**Codename:** Paper Hearts

**Status:** Finalized for Development

**Encryption Model:** End-to-End Encryption (E2EE)
**Platform:** Progressive Web App (PWA)
**V1 Targets:** Android (Chrome) & iOS (Safari)
**Client Stack:** SolidJS + Vite + TypeScript
**Server Stack:** Bun + PostgreSQL

---

## 1. Product Vision

A private-by-design shared diary for couples. The app enforces a "mutual disclosure" model: content is only revealed once both partners have contributed for the day, ensuring shared vulnerability and consistent engagement.

---

## 2. Core Functional Requirements

### 2.1 The "Paper Hearts" Day (The 4 AM Pivot)

* **The Logic:** To support late-night writers, a "Diary Day" is a 24-hour window from **04:01:00 AM** to **04:00:59 AM** local time.
* **Impact:** An entry written at 3:00 AM on a Tuesday is saved under Monday’s `dayId`.

### 2.2 The "Veil" & Reveal Mechanism

* **Immediate Reveal:** Partner content is decrypted and displayed the moment both users have successfully sent an entry for that `dayId`.
* **Fallback:** If one partner fails to write, the "Veil" lifts automatically at **04:01 AM** the following morning to allow archival access. If a late entry syncs after the veil has already lifted (e.g. partner was offline), the view updates to show both entries alongside each other.
* **Access Control:** The private key is "unlocked" in memory via **WebAuthn (Passkeys + PRF)** on supported devices, or via a **passphrase prompt** on devices without PRF support (e.g. iOS/Safari).
* **Offline Behavior:** Users can write entries while offline. The entry is saved locally and queued for sync. When connectivity is restored, the app syncs automatically. A late sync may arrive after the 4 AM cutoff — the entry is still attributed to its original `dayId` based on when it was written, not when it was synced.

### 2.3 Onboarding (The Single-Scan Handshake)

1. **Initiator:** Displays a QR code containing their Public Key (Ed25519) and a temporary Relay Token.
2. **Follower:** Scans the QR and automatically posts their Public Key back to the relay.
3. **Completion:** Both devices now hold the other's Public Key, enabling E2EE communication.

---

## 3. Technical Architecture

### 3.1 Encryption & Privacy

* **Standard:** **libsodium** (via `libsodium-wrappers` / `tweetnacl`).
* **Key Pair:** Each user generates an **Ed25519** signing key pair as their primary identity. The **X25519** encryption key is derived from the Ed25519 key using libsodium's `crypto_sign_ed25519_sk_to_curve25519` / `crypto_sign_ed25519_pk_to_curve25519`. One key pair serves both signing and encryption.
* **Encryption:** A shared secret is derived via **X25519 Diffie-Hellman** on the derived encryption keys. Content is encrypted/decrypted using **XSalsa20-Poly1305** (libsodium `crypto_secretbox`) with the shared secret.
* **E2EE:** Content is encrypted on the sender's device and decrypted on the receiver's device. The Blind Relay server only handles encrypted binary blobs and has no access to private keys.
* **Key-at-Rest Protection (Tiered):**
    * **Primary (Android/Chrome):** The **WebAuthn PRF extension** derives a hardware-bound secret to encrypt the Ed25519 private key at rest.
    * **Fallback (iOS/Safari):** A user-chosen passphrase processed through **Argon2id** (libsodium `crypto_pwhash`) derives the encryption key for the private key at rest. Used when PRF is unavailable.
    * **Detection:** On app launch, feature-detect PRF support. Route to the appropriate unlock flow automatically — users never need to know which method they're using.

### 3.2 Storage & Persistence

* **Vault:** **Origin Private File System (OPFS)** serves as the high-performance local database. Each device stores a full local copy of all entries (both the user's own and their partner's).
* **No Conflict Resolution Needed:** Each partner writes their own separate entry per `dayId`. Entries are never co-edited, so there are no write conflicts to resolve.
* **Recovery Protocol:**
    1. The recovering user installs the app on a new device and generates a fresh Ed25519 key pair.
    2. The partner performs a new **Single-Scan Handshake** (same QR flow as onboarding) to exchange the new public key.
    3. The partner's device re-encrypts the full archive using the new shared secret derived from the new key pair.
    4. The re-encrypted archive is transferred directly to the new device via **WebRTC** (peer-to-peer). Historical entries never pass through the Blind Relay — only the two devices involved in recovery.

### 3.3 Blind Relay Protocol

The relay is a simple REST API. It stores and forwards encrypted blobs without any knowledge of their contents.

* **Protocol:** HTTPS REST endpoints. No WebSockets — write frequency (~1x/day per user) does not justify persistent connections.
* **Authentication:** Every request is signed with the user's **Ed25519 private key**. The client signs a payload (e.g. request body + timestamp) and sends the signature in a header. The relay verifies it against the user's registered public key. No passwords, sessions, or tokens — the key pair *is* the identity.
* **Registration:** During onboarding, each client registers its Ed25519 public key with the relay via the temporary Relay Token. The relay stores the public key and uses it to verify all future requests from that user.
* **Rate Limiting:** The relay enforces a maximum of **2 encrypted blobs per `dayId` per public key** (one entry + one potential re-send). Requests beyond this limit are rejected.
* **Endpoints:**
    * `POST /entries` — Upload a signed, encrypted entry blob. The server verifies the signature, checks the rate limit, stores the blob, and marks it as pending delivery.
    * `GET /entries?since={dayId}` — Fetch all undelivered blobs for the requesting user (signature-verified).
    * `POST /entries/ack` — Client confirms receipt of specific blobs. The server deletes them after acknowledgement.
* **Retention Policy:** Blobs are retained on the server until **both** conditions are met: (1) the recipient has fetched the blob, and (2) the recipient has sent an explicit acknowledgement. Only then is the blob deleted.
* **Polling:** The client polls for new entries on app open and periodically while in the foreground. Push notifications (V2+) may supplement polling in future versions.
* **Server Sees:** Public key, `dayId`, blob size, and delivery status. The server never sees decrypted content or entry metadata beyond what is needed for routing and verification.

### 3.4 PWA & Platform Requirements

* **Install Flow:**
    * **Days 1–2:** The app runs in-browser. A dismissible banner encourages home screen install with platform-specific instructions (Android: "Add to Home Screen" banner; iOS: Share → "Add to Home Screen").
    * **After 2 days of entries:** The app requires installation to continue. A blocking prompt explains that installing protects their diary from being deleted by the browser. The app blocks compose until it detects standalone mode (`display-mode: standalone`).
* **Why mandatory after day 2:** On iOS, Safari evicts all script-writable storage (OPFS, IndexedDB, service workers) after 7 days of inactivity for in-browser tabs. Home screen PWAs are exempt. Since Paper Hearts stores encrypted keys and diary entries locally, data loss from eviction would be catastrophic. The 2-day grace period lets users experience the app before committing.
* **Service Worker:** Caches the app shell and libsodium WASM for offline-first launch. Re-caches critical assets on every app open to stay resilient against iOS eviction edge cases.
* **Web App Manifest:** `display: standalone`, app icons, theme color, `scope` set to `/`. Required for home screen install on both platforms.
* **iOS-Specific Constraints:**
    * **No background sync.** The app syncs only when opened in the foreground (polling model in 3.3 already accounts for this).
    * **All browsers on iOS use WebKit.** Chrome/Firefox on iOS behave identically to Safari — there is no way around WebKit limitations.
    * **Storage limit:** ~20% of disk per origin (~60% for home screen installs). Text-only diary entries will never approach this limit.
    * **Push notifications** (iOS 16.4+, home screen only) are deferred to V2.

### 3.5 Analytics & Monitoring

The app tracks **Transmission Metadata** to ensure sync reliability:

* **Captured Fields:** `userId`, `dayId`, `userSentStatus` (Bool), `partnerSentStatus` (Bool).
* **Usage:** Used strictly for debugging delivery failures and monitoring active engagement. No content, timestamps, or personal identifiers are included.

---

## 4. Data Schema (Entry Object)

```json
{
  "version": "1.0",
  "metadata": {
    "dayId": "2026-02-15",
    "authorPublicKey": "base64-ed25519-public-key"
  },
  "payload": "libsodium-encrypted-base64-blob"
}
```

The encrypted payload, once decrypted, contains:

```json
{
  "text": "The diary entry content...",
  "format": "markdown",
  "timestamp": "2026-02-16T02:30:00Z"
}
```

* **Immutability:** Entries cannot be edited or deleted in V1. Once submitted, they are permanent. Entry editing may be introduced in a future version.
* **`version` field:** Present in the plaintext envelope for client-side schema migration only. The relay does not parse or use it.

---

## 5. Screens & Flows

| Screen | Description |
| --- | --- |
| **Initial Kiss** | Onboarding flow — generate keys, display/scan QR, exchange public keys, register with relay. |
| **Compose** | Text input for the day's entry. Submit encrypts and queues for sync. |
| **Today / Yesterday** | Shows veiled state (waiting for partner) or revealed state (both entries visible). Reused for today and yesterday. |
| **Archive** | List of previous days. Tapping a day opens the same revealed-entry view. |
| **Re-add Partner** | Recovery flow — same QR handshake as Initial Kiss, triggers archive re-encryption and WebRTC transfer. |
| **Settings** | Passphrase management, key info, about. |

---

## 6. Roadmap

| Version | Focus | Features |
| --- | --- | --- |
| **V1 (MVP)** | **Foundation** | E2EE (libsodium), Single-Scan Handshake, OPFS storage, 4 AM Pivot, Blind Relay (Bun + Postgres), WebRTC recovery, PWA with mandatory install. |
| **V2** | **Engagement** | Push notifications (iOS + Android), on-device LLM sentiment analysis (WebGPU, local only), tablet-optimized writing experience. |
| **V3** | **Experience** | Calendar view, entry editing. |

---