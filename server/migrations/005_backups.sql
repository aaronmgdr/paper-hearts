-- Opt-in recovery backups.
--
-- The row is addressed by a locator the client derives from a recovery code
-- that never leaves the user's hands, so restoring works with no device and no
-- key — which is the whole point, since losing every phone otherwise loses the
-- diary. The relay stores ciphertext it has no key for.
--
-- owner_key is kept only to cap each account at one backup and to let a user
-- delete their own. It is metadata the relay already saw on the upload request.
CREATE TABLE backups (
  locator     TEXT PRIMARY KEY,
  owner_key   TEXT NOT NULL REFERENCES users(public_key) ON DELETE CASCADE,
  payload     BYTEA NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_backups_owner ON backups(owner_key);
