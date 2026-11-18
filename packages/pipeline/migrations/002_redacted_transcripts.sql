-- Redacted transcripts: the only transcript text the score stage may read or send out.
-- Holds counts per PII type, never the redacted values.
CREATE TABLE redacted_transcripts (
  interaction_id    TEXT PRIMARY KEY REFERENCES interactions(id) ON DELETE CASCADE,
  transcript        TEXT NOT NULL,
  redactor_version  TEXT NOT NULL,
  counts_json       TEXT NOT NULL, -- RedactionCounts, e.g. {"EMAIL":1,"NAME":2,...}
  redacted_at       TEXT NOT NULL
);
