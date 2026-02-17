-- Pairs: two users linked together
CREATE TABLE pairs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Users: registered public keys, linked to a pair
CREATE TABLE users (
  public_key    TEXT PRIMARY KEY,
  pair_id       UUID NOT NULL REFERENCES pairs(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_pair_id ON users(pair_id);

-- Entries: encrypted blobs pending delivery
CREATE TABLE entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_key    TEXT NOT NULL REFERENCES users(public_key),
  pair_id       UUID NOT NULL REFERENCES pairs(id),
  day_id        DATE NOT NULL,
  payload       BYTEA NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  fetched_at    TIMESTAMPTZ,
  acked_at      TIMESTAMPTZ
);

CREATE INDEX idx_entries_pair_day ON entries(pair_id, day_id);
CREATE INDEX idx_entries_recipient ON entries(pair_id, author_key);

-- Relay tokens: temporary onboarding tokens
CREATE TABLE relay_tokens (
  token         TEXT PRIMARY KEY,
  initiator_key TEXT NOT NULL,
  pair_id       UUID NOT NULL REFERENCES pairs(id),
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed      BOOLEAN NOT NULL DEFAULT false
);
