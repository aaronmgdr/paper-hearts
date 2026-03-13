-- Allow upsert (one entry per author per day) and track edits
ALTER TABLE entries ADD COLUMN updated_at TIMESTAMPTZ;
ALTER TABLE entries ADD CONSTRAINT entries_author_day_unique UNIQUE (author_key, day_id);
