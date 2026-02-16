
# Blind Relay Server Specification

**Runtime:** Bun
**Database:** PostgreSQL
**Auth:** Ed25519 signature verification (libsodium)

---

## 1. Overview

The Blind Relay is a minimal REST server that stores and forwards encrypted blobs between two paired users. It never sees decrypted content. Its responsibilities are:

- Register public keys during onboarding
- Verify Ed25519 signatures on every request
- Store encrypted blobs until acknowledged
- Enforce rate limits (2 blobs per dayId per key)

---

## 2. Database Schema

### 2.1 `pairs` Table

Stores paired users. Created during the onboarding handshake.

```sql
CREATE TABLE pairs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.2 `users` Table

Stores registered public keys, linked to a pair.

```sql
CREATE TABLE users (
  public_key    TEXT PRIMARY KEY,           -- Base64-encoded Ed25519 public key
  pair_id       UUID NOT NULL REFERENCES pairs(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_pair_id ON users(pair_id);
```

### 2.3 `entries` Table

Stores encrypted blobs pending delivery.

```sql
CREATE TABLE entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_key    TEXT NOT NULL REFERENCES users(public_key),
  pair_id       UUID NOT NULL REFERENCES pairs(id),
  day_id        DATE NOT NULL,
  payload       BYTEA NOT NULL,             -- Encrypted blob
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  fetched_at    TIMESTAMPTZ,                -- Set when recipient GETs this entry
  acked_at      TIMESTAMPTZ                 -- Set when recipient ACKs; row deleted after
);

CREATE INDEX idx_entries_pair_day ON entries(pair_id, day_id);
CREATE INDEX idx_entries_recipient ON entries(pair_id, author_key);
```

### 2.4 `relay_tokens` Table

Temporary tokens used during the onboarding handshake.

```sql
CREATE TABLE relay_tokens (
  token         TEXT PRIMARY KEY,           -- Cryptographically random token
  initiator_key TEXT NOT NULL,              -- Public key of the user who created the token
  pair_id       UUID NOT NULL REFERENCES pairs(id),
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed      BOOLEAN NOT NULL DEFAULT false
);
```

---

## 3. API Endpoints

All endpoints (except token redemption) require an `Authorization` header with an Ed25519 signature.

### 3.1 Authentication

Every authenticated request includes:

```
Authorization: Signature <base64-signature>
X-Public-Key: <base64-ed25519-public-key>
X-Timestamp: <ISO-8601-timestamp>
```

The signed payload is: `${method}\n${path}\n${timestamp}\n${bodyHash}`

Where `bodyHash` is the SHA-256 hex digest of the request body (or empty string for GET).

The server:
1. Looks up the public key in the `users` table.
2. Rejects if the timestamp is older than 5 minutes (replay protection).
3. Verifies the Ed25519 signature against the reconstructed payload.

### 3.2 Onboarding Endpoints

#### `POST /pairs/initiate`

Called by the Initiator to start a new pair and get a relay token.

**Request body:**
```json
{
  "publicKey": "base64-ed25519-public-key"
}
```

**Server action:**
1. Create a new `pairs` row.
2. Create a `users` row for the initiator.
3. Generate a cryptographically random relay token (32 bytes, base64url).
4. Store in `relay_tokens` with a 10-minute TTL.
5. Return the token.

**Response:**
```json
{
  "pairId": "uuid",
  "relayToken": "base64url-token"
}
```

> Note: This is the only unauthenticated endpoint — the user doesn't exist yet.

#### `POST /pairs/join`

Called by the Follower after scanning the QR code.

**Request body:**
```json
{
  "publicKey": "base64-ed25519-public-key",
  "relayToken": "base64url-token"
}
```

**Server action:**
1. Look up the relay token. Reject if expired or already consumed.
2. Mark the token as consumed.
3. Create a `users` row for the follower, linked to the same `pair_id`.
4. Return the initiator's public key and pair ID.

**Response:**
```json
{
  "pairId": "uuid",
  "partnerPublicKey": "base64-ed25519-public-key"
}
```

> Note: Also unauthenticated — the follower doesn't exist yet. The relay token serves as one-time authorization.

### 3.3 Entry Endpoints

#### `POST /entries`

Upload an encrypted entry blob.

**Request body:**
```json
{
  "dayId": "2026-02-15",
  "payload": "base64-encrypted-blob"
}
```

**Server action:**
1. Verify Ed25519 signature.
2. Look up the user's `pair_id`.
3. Check rate limit: `SELECT COUNT(*) FROM entries WHERE author_key = $1 AND day_id = $2`. Reject if >= 2.
4. Insert into `entries`.
5. Return success.

**Response:**
```json
{
  "id": "entry-uuid",
  "status": "stored"
}
```

#### `GET /entries?since={dayId}`

Fetch undelivered blobs for the requesting user (i.e. entries written by their partner).

**Server action:**
1. Verify Ed25519 signature.
2. Find the user's `pair_id` and partner's `public_key`.
3. Query: `SELECT * FROM entries WHERE pair_id = $1 AND author_key = $2 AND day_id >= $3 AND acked_at IS NULL` (where `$2` is the partner's key).
4. Mark returned entries with `fetched_at = now()` where not already set.
5. Return the entries.

**Response:**
```json
{
  "entries": [
    {
      "id": "entry-uuid",
      "dayId": "2026-02-15",
      "payload": "base64-encrypted-blob"
    }
  ]
}
```

#### `POST /entries/ack`

Confirm receipt of entries. Server deletes them after acknowledgement.

**Request body:**
```json
{
  "entryIds": ["entry-uuid-1", "entry-uuid-2"]
}
```

**Server action:**
1. Verify Ed25519 signature.
2. Verify each entry belongs to the user's pair and was authored by the partner (prevent acking own entries).
3. Delete the acknowledged entries from the `entries` table.

**Response:**
```json
{
  "deleted": 2
}
```

---

## 4. Rate Limiting

- **Write limit:** 2 blobs per `dayId` per public key. Enforced via SQL count at write time.
- **Request throttle:** General request throttle of 60 requests/minute per public key to prevent abuse. Tracked in-memory (Bun process). Not persisted — resets on restart, which is acceptable.

---

## 5. Blob Lifecycle

```
Client writes entry
        │
        ▼
POST /entries ──► Signature verified ──► Rate limit checked ──► Stored in Postgres
                                                                       │
                                                          Partner opens app
                                                                       │
                                                                       ▼
                                                              GET /entries
                                                        (fetched_at set)
                                                                       │
                                                          Partner decrypts
                                                                       │
                                                                       ▼
                                                            POST /entries/ack
                                                                       │
                                                                       ▼
                                                              Row deleted
```

---

## 6. Relay Token Lifecycle

```
Initiator opens app
        │
        ▼
POST /pairs/initiate ──► Pair created ──► Token generated (10 min TTL)
        │
        ▼
QR code displayed (contains: initiator public key + relay token)
        │
        ▼
Follower scans QR
        │
        ▼
POST /pairs/join ──► Token validated ──► Follower registered ──► Token consumed
        │
        ▼
Both devices now have partner's public key
```

---

## 7. Cleanup

- **Expired relay tokens:** A scheduled job (or lazy cleanup on read) deletes tokens where `expires_at < now()`.
- **Orphaned entries:** Entries older than 30 days with no ack are candidates for cleanup. This handles edge cases where a user abandons the app.

---

## 8. Dependencies

| Package | Purpose |
| --- | --- |
| `bun` | Runtime & HTTP server (built-in `Bun.serve`) |
| `postgres` (porsager/postgres) | Postgres client for Bun |
| `libsodium-wrappers` | Ed25519 signature verification |
