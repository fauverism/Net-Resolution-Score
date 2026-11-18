-- Initial schema. Timestamps are ISO-8601 UTC strings.

CREATE TABLE customers (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL
);

CREATE TABLE interactions (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customers(id),
  channel        TEXT NOT NULL CHECK (channel IN ('ai_agent', 'human', 'hybrid')),
  started_at     TEXT NOT NULL,
  transcript     TEXT NOT NULL, -- PII-redacted
  business_line  TEXT NOT NULL
);
CREATE INDEX idx_interactions_customer_started ON interactions (customer_id, started_at);
CREATE INDEX idx_interactions_started ON interactions (started_at);

CREATE TABLE scores (
  interaction_id  TEXT NOT NULL REFERENCES interactions(id),
  json            TEXT NOT NULL, -- ScoredInteraction, Zod-validated
  model           TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  scored_at       TEXT NOT NULL,
  PRIMARY KEY (interaction_id, model, prompt_version)
);

-- Category changes after scoring (e.g. link stage finds a return, or a human override).
CREATE TABLE reclassifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  interaction_id  TEXT NOT NULL REFERENCES interactions(id),
  from_category   TEXT NOT NULL CHECK (from_category IN ('detractor', 'passive', 'promoter')),
  to_category     TEXT NOT NULL CHECK (to_category IN ('detractor', 'passive', 'promoter')),
  reason          TEXT NOT NULL,
  source          TEXT NOT NULL, -- e.g. 'link', 'calibrate', 'manual'
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_reclassifications_interaction ON reclassifications (interaction_id);

CREATE TABLE surveys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  nps_score     INTEGER NOT NULL CHECK (nps_score BETWEEN 0 AND 10),
  responded_at  TEXT NOT NULL
);
CREATE INDEX idx_surveys_customer ON surveys (customer_id);

CREATE TABLE runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  report_json   TEXT NOT NULL, -- PeriodReport
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
