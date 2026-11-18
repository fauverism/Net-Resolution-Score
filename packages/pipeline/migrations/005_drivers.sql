-- One row per `drivers` run: the saved DriversReport plus what the run cost.
CREATE TABLE driver_runs (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  period_start            TEXT NOT NULL,
  period_end              TEXT NOT NULL,
  model                   TEXT NOT NULL,
  cluster_prompt_version  TEXT NOT NULL,
  suggest_prompt_version  TEXT NOT NULL,
  started_at              TEXT NOT NULL,
  finished_at             TEXT,
  detractors              INTEGER NOT NULL DEFAULT 0,
  clusters                INTEGER NOT NULL DEFAULT 0,
  llm_calls               INTEGER NOT NULL DEFAULT 0,
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens      INTEGER NOT NULL DEFAULT 0,
  est_cost_usd            REAL,
  error                   TEXT,
  report_json             TEXT  -- DriversReport; null if the run aborted
);

-- Validated LLM output keyed by hash(purpose + prompt + model + request content).
CREATE TABLE llm_cache (
  cache_key       TEXT PRIMARY KEY,
  purpose         TEXT NOT NULL,
  model           TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  output_json     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
