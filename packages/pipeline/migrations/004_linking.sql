-- One row per `link` run: what it cost and what it did.
CREATE TABLE link_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  model               TEXT NOT NULL,
  prompt_version      TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  finished_at         TEXT,
  candidates          INTEGER NOT NULL DEFAULT 0,
  evaluated           INTEGER NOT NULL DEFAULT 0,
  cached              INTEGER NOT NULL DEFAULT 0,
  confirmed           INTEGER NOT NULL DEFAULT 0,
  unconfirmed         INTEGER NOT NULL DEFAULT 0,
  rejected            INTEGER NOT NULL DEFAULT 0,
  failed              INTEGER NOT NULL DEFAULT 0,
  reclassified        INTEGER NOT NULL DEFAULT 0,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  est_cost_usd        REAL,
  error               TEXT
);

-- Every candidate pair the LLM judged (or failed to judge): the audit trail behind
-- each false_resolution reclassification.
CREATE TABLE links (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  a_interaction_id  TEXT NOT NULL REFERENCES interactions(id),
  b_interaction_id  TEXT NOT NULL REFERENCES interactions(id),
  customer_id       TEXT NOT NULL,
  gap_days          REAL NOT NULL,
  window_days       INTEGER NOT NULL,
  model             TEXT NOT NULL,
  prompt_version    TEXT NOT NULL,
  status            TEXT NOT NULL
    CHECK (status IN ('confirmed', 'unconfirmed', 'rejected', 'link_failed')),
  same_goal         INTEGER,      -- null when link_failed
  confidence        REAL,
  why               TEXT,         -- model's reason; stored for audit, never logged
  detail            TEXT,         -- failure reason when link_failed
  flags_json        TEXT NOT NULL DEFAULT '[]',
  run_id            INTEGER REFERENCES link_runs(id),
  created_at        TEXT NOT NULL,
  UNIQUE (a_interaction_id, b_interaction_id, model, prompt_version)
);
CREATE INDEX idx_links_a ON links (a_interaction_id);

-- Validated linker output keyed by hash(prompt + model + both redacted transcripts).
CREATE TABLE link_cache (
  cache_key       TEXT PRIMARY KEY,
  model           TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  output_json     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

-- Reclassifications point at the evidence that caused them. Score rows are never edited.
ALTER TABLE reclassifications ADD COLUMN link_id INTEGER REFERENCES links(id);
ALTER TABLE reclassifications ADD COLUMN flags_json TEXT NOT NULL DEFAULT '[]';
CREATE UNIQUE INDEX ux_reclassifications_once ON reclassifications (interaction_id, reason, source);
