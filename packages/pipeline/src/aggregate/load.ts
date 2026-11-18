import {
  ReclassificationSchema,
  ScoreRecordSchema,
  type Channel,
  type Reclassification,
  type ScoreRecord,
} from '@nrs/core';
import type { Db } from '../db.ts';

export interface PeriodRow {
  interactionId: string;
  /** Null when the interaction has no score for this model + prompt version. */
  score: ScoreRecord | null;
  reclassifications: Reclassification[];
}

/**
 * Interactions started in [start, end) with their score and reclassifications, validated.
 * A score row that no longer validates is returned as a failed score, so it falls back
 * to the lowest defensible category.
 */
export function loadPeriodScores(
  db: Db,
  start: string,
  end: string,
  model: string,
  promptVersion: string,
): PeriodRow[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.channel, i.business_line, s.json
       FROM interactions i
       LEFT JOIN scores s ON s.interaction_id = i.id AND s.model = ? AND s.prompt_version = ?
       WHERE i.started_at >= ? AND i.started_at < ?
       ORDER BY i.id`,
    )
    .all(model, promptVersion, start, end) as {
    id: string;
    channel: Channel;
    business_line: string;
    json: string | null;
  }[];

  const reclassifications = (
    db
      .prepare(
        `SELECT r.id, r.interaction_id AS interactionId, r.from_category AS fromCategory,
                r.to_category AS toCategory, r.reason, r.source, r.created_at AS createdAt
         FROM reclassifications r JOIN interactions i ON i.id = r.interaction_id
         WHERE i.started_at >= ? AND i.started_at < ?`,
      )
      .all(start, end) as unknown[]
  ).map((r) => ReclassificationSchema.parse(r));
  const byInteraction = Map.groupBy(reclassifications, (r) => r.interactionId);

  return rows.map((row) => {
    let score: ScoreRecord | null = null;
    if (row.json) {
      const parsed = ScoreRecordSchema.safeParse(JSON.parse(row.json));
      score = parsed.success
        ? parsed.data
        : ({
            interactionId: row.id,
            channel: row.channel,
            businessLine: row.business_line,
            status: 'score_failed',
          } as ScoreRecord);
    }
    return { interactionId: row.id, score, reclassifications: byInteraction.get(row.id) ?? [] };
  });
}
