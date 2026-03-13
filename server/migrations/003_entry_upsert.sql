-- Remove duplicate (author_key, day_id) rows before adding the unique constraint.
-- Keeps the most recently created entry per author per day, deletes the rest.
DELETE FROM entries
WHERE id NOT IN (
  SELECT DISTINCT ON (author_key, day_id) id
  FROM entries
  ORDER BY author_key, day_id, created_at DESC
);

-- Allow upsert (one entry per author per day) and track edits
ALTER TABLE entries ADD COLUMN updated_at TIMESTAMPTZ;
ALTER TABLE entries ADD CONSTRAINT entries_author_day_unique UNIQUE (author_key, day_id);
