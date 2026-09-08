-- Additive only, like every migration here: new nullable columns, no rewrite of
-- existing rows. 0001_init.sql is already applied to the local database and may
-- be applied to a remote one, so it is never edited in place.

-- The dashboard has to say which two transactions a gap sits between, and the
-- projected timeline marks an adjacency as gapped by looking for a gap whose
-- before_event_id is that event. Without the bounds, the read model can show
-- that a gap exists but not where.
ALTER TABLE gaps ADD COLUMN after_event_id  TEXT;
ALTER TABLE gaps ADD COLUMN before_event_id TEXT;

-- Set when a CONFIRMED_GAP stops looking like a gap because a late email
-- arrived. Surfaced to the operator; never acted on automatically.
ALTER TABLE gaps ADD COLUMN fillable_at TEXT;
