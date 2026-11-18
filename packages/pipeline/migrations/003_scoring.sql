-- One row per `score` run: what it cost and what it did.
CREATE TABLE score_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  model               TEXT NOT NULL,
  prompt_version      TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  finished_at         TEXT,
  requested           INTEGER NOT NULL DEFAULT 0,
  scored              INTEGER NOT NULL DEFAULT 0,
  cached              INTEGER NOT NULL DEFAULT 0,
  failed              INTEGER NOT NULL DEFAULT 0,
  lowered             INTEGER NOT NULL DEFAULT 0,
  flagged             INTEGER NOT NULL DEFAULT 0,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  est_cost_usd        REAL, -- null when the model has no known price
  error               TEXT  -- set when the run aborted (e.g. "AuthenticationError 401")
);

ALTER TABLE scores ADD COLUMN status TEXT NOT NULL DEFAULT 'scored'
  CHECK (status IN ('scored', 'score_failed'));
ALTER TABLE scores ADD COLUMN run_id INTEGER REFERENCES score_runs(id);

-- Validated scorer output keyed by hash(prompt + model + redacted transcript).
-- Survives re-seeding, so re-runs cost nothing.
CREATE TABLE score_cache (
  cache_key       TEXT PRIMARY KEY,
  model           TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  output_json     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
