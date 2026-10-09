-- One row per install, event and version: a replayed event is ignored (INSERT OR IGNORE).
-- No address, no time of day, nothing about the user's terminals or files. Of where an event
-- came from, only the country (two characters, as Cloudflare names it); NULL in rows from
-- before it was kept. A table made before then gets the column from README.md's ALTER.
CREATE TABLE IF NOT EXISTS events (
  day TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('install', 'update')),
  install_id TEXT NOT NULL,
  version TEXT NOT NULL,
  previous_version TEXT,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  install_method TEXT NOT NULL CHECK (install_method IN ('plugin', 'managed', 'source')),
  country TEXT,
  UNIQUE (install_id, event, version)
);
CREATE INDEX IF NOT EXISTS events_day ON events (day);
