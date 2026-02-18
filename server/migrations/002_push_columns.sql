ALTER TABLE users
  ADD COLUMN push_endpoint TEXT,
  ADD COLUMN push_p256dh   TEXT,
  ADD COLUMN push_auth     TEXT;
