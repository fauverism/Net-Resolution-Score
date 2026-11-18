import type { Channel } from '@nrs/core';
import type { Db } from '../db.ts';
import { redact, type RedactedTranscript } from '../redact/redact.ts';

/** Everything the scorer may send to the Anthropic API for one interaction. */
export interface ScoringInput {
  interactionId: string;
  channel: Channel;
  businessLine: string;
  startedAt: string;
  transcript: RedactedTranscript;
}

/**
 * The score stage's only source of transcripts. Reads redacted_transcripts and never
 * interactions.transcript; interactions not yet redacted are left out, not scored raw.
 * Stored text goes through redact() again (it's idempotent), so a bad row can't leak PII.
 */
export function loadScoringInputs(db: Db): ScoringInput[] {
  const rows = db
    .prepare(
      `SELECT i.id AS interactionId, i.channel, i.business_line AS businessLine,
              i.started_at AS startedAt, r.transcript AS stored
       FROM redacted_transcripts r
       JOIN interactions i ON i.id = r.interaction_id
       ORDER BY i.started_at, i.id`,
    )
    .all() as (Omit<ScoringInput, 'transcript'> & { stored: string })[];
  return rows.map(({ stored, ...rest }) => ({ ...rest, transcript: redact(stored).text }));
}
