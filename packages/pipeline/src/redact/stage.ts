import type { Db } from '../db.ts';
import {
  addCounts,
  emptyCounts,
  formatCounts,
  redact,
  REDACTOR_VERSION,
  type RedactionCounts,
} from './redact.ts';

export interface RedactionRunSummary {
  redacted: number;
  alreadyCurrent: number;
  counts: RedactionCounts;
}

/**
 * Redacts every interaction that has no redacted transcript for the current redactor version.
 * Logs counts only: never a transcript or a value.
 */
export function runRedaction(
  db: Db,
  log: (msg: string) => void,
  now = new Date(),
): RedactionRunSummary {
  const pending = db
    .prepare(
      `SELECT i.id, i.transcript FROM interactions i
       LEFT JOIN redacted_transcripts r ON r.interaction_id = i.id AND r.redactor_version = ?
       WHERE r.interaction_id IS NULL
       ORDER BY i.id`,
    )
    .all(REDACTOR_VERSION) as { id: string; transcript: string }[];
  const total = db.prepare('SELECT count(*) FROM interactions').pluck().get() as number;

  const upsert = db.prepare(
    `INSERT INTO redacted_transcripts (interaction_id, transcript, redactor_version, counts_json, redacted_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (interaction_id) DO UPDATE SET
       transcript = excluded.transcript,
       redactor_version = excluded.redactor_version,
       counts_json = excluded.counts_json,
       redacted_at = excluded.redacted_at`,
  );

  let counts = emptyCounts();
  const at = now.toISOString();
  db.transaction(() => {
    for (const row of pending) {
      const result = redact(row.transcript);
      counts = addCounts(counts, result.counts);
      upsert.run(row.id, result.text, REDACTOR_VERSION, JSON.stringify(result.counts), at);
    }
  })();

  const summary = { redacted: pending.length, alreadyCurrent: total - pending.length, counts };
  log(
    `[redact] v${REDACTOR_VERSION}: ${summary.redacted} redacted, ${summary.alreadyCurrent} already current`,
  );
  log(`[redact] tokens: ${formatCounts(counts)}`);
  return summary;
}
