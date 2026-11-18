-- One row per `calibrate` run: is the scorer trustworthy enough to act on its numbers?
CREATE TABLE calibrations (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  model              TEXT NOT NULL,
  prompt_version     TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('decision_ready', 'calibrating')),
  reasons_json       TEXT NOT NULL,  -- plain-language reasons it's still calibrating
  eval_file          TEXT,           -- the evals/results file it was based on, if any
  eval_created_at    TEXT,
  category_accuracy  REAL,
  inflation_rate     REAL,
  golden_cases       INTEGER NOT NULL DEFAULT 0,
  seed_cases         INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL
);
