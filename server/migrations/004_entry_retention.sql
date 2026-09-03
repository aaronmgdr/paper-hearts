-- Entries are now held for a fixed window instead of being deleted the moment
-- one device acknowledges them. Deleting on ack makes a second device on the
-- same account impossible: whichever phone polls first destroys the blob before
-- the other has seen it. The sweep needs to find expired rows cheaply.
CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at);
