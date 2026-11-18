import {
  buildPeriodReport,
  PeriodReportSchema,
  periodFromDates,
  ReclassificationSchema,
  ScoreRecordSchema,
  toReportItem,
  type PeriodReport,
  type Reclassification,
  type ReportItem,
  type ScoreRecord,
} from '@nrs/core';
import type { Db } from '../db.ts';

export interface AggregateOptions {
  /** Inclusive YYYY-MM-DD dates (UTC). */
  from: string;
  to: string;
  /** Which scores to report on. */
  model: string;
  promptVersion: string;
}

interface Loaded {
  items: ReportItem[];
  counts: PeriodReport['counts'];
}

/** Interactions started in [start, end) with their score (if any) and reclassifications. */
function loadPeriod(
  db: Db,
  start: string,
  end: string,
  model: string,
  promptVersion: string,
): Loaded {
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
    channel: string;
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

  const items: ReportItem[] = [];
  const counts = { interactions: rows.length, scored: 0, scoreFailed: 0, unscored: 0 };
  for (const row of rows) {
    if (!row.json) {
      counts.unscored++;
      continue;
    }
    const parsed = ScoreRecordSchema.safeParse(JSON.parse(row.json));
    // A row that no longer validates is treated like a failed score: lowest defensible category.
    const score: ScoreRecord = parsed.success
      ? parsed.data
      : ({
          interactionId: row.id,
          channel: row.channel,
          businessLine: row.business_line,
          status: 'score_failed',
        } as ScoreRecord);
    if (score.status === 'scored') counts.scored++;
    else counts.scoreFailed++;
    items.push(toReportItem(score, byInteraction.get(row.id) ?? ([] as Reclassification[])));
  }
  return { items, counts };
}

function surveyScores(db: Db, start: string, end: string): number[] {
  return db
    .prepare('SELECT nps_score FROM surveys WHERE responded_at >= ? AND responded_at < ?')
    .pluck()
    .all(start, end) as number[];
}

/** The latest interaction's UTC date and the 30 days ending on it (for `all`). */
export function defaultPeriod(db: Db): { from: string; to: string } {
  const latest = db.prepare('SELECT max(started_at) FROM interactions').pluck().get() as
    string | null;
  if (!latest)
    throw new Error('No interactions to aggregate. Run `npm run seed`, or pass --from and --to.');
  const to = latest.slice(0, 10);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

/** Builds the PeriodReport, validates it, and saves it to `runs`. Logs figures only. */
export function runAggregate(
  db: Db,
  opts: AggregateOptions,
  log: (msg: string) => void,
): { runId: number; report: PeriodReport } {
  const period = periodFromDates(opts.from, opts.to);
  const current = loadPeriod(
    db,
    period.periodStart,
    period.periodEnd,
    opts.model,
    opts.promptVersion,
  );
  const prior = loadPeriod(db, period.priorStart, period.priorEnd, opts.model, opts.promptVersion);

  const report = PeriodReportSchema.parse(
    buildPeriodReport({
      period,
      source: { model: opts.model, promptVersion: opts.promptVersion },
      current: current.items,
      prior: prior.items,
      counts: current.counts,
      surveys: {
        current: surveyScores(db, period.periodStart, period.periodEnd),
        prior: surveyScores(db, period.priorStart, period.priorEnd),
      },
    }),
  );

  const runId = Number(
    db
      .prepare('INSERT INTO runs (period_start, period_end, report_json) VALUES (?, ?, ?)')
      .run(report.periodStart, report.periodEnd, JSON.stringify(report)).lastInsertRowid,
  );

  logReport(runId, opts, report, log);
  return { runId, report };
}

function logReport(
  runId: number,
  opts: AggregateOptions,
  r: PeriodReport,
  log: (msg: string) => void,
): void {
  const num = (x: number | null) => (x === null ? 'n/a' : x.toFixed(1));
  const delta = (x: number | null) =>
    x === null ? '' : ` (${x >= 0 ? '+' : ''}${x.toFixed(1)} vs prior)`;
  const warn = (w: string | null) => (w ? `  [${w}]` : '');
  const pct = (x: number | null) => (x === null ? 'n/a' : `${x.toFixed(1)}%`);
  const c = r.counts;

  log(
    `[aggregate] run ${runId}: ${opts.from} → ${opts.to}, ${c.interactions} interactions ` +
      `(${c.scored} scored, ${c.scoreFailed} failed → detractor, ${c.unscored} unscored)`,
  );
  if (c.unscored > 0)
    log(`[aggregate] note: ${c.unscored} unscored interactions are not in the report`);
  log(
    `[aggregate] NRS ${num(r.overall.nrs)}${delta(r.overall.delta)}, n ${r.overall.n}${warn(r.overall.warning)}`,
  );
  for (const [name, s] of [...Object.entries(r.byChannel), ...Object.entries(r.byBusinessLine)]) {
    log(
      `[aggregate]   ${name.padEnd(16)} ${num(s.nrs).padStart(6)}${delta(s.delta)}, n ${s.n}${warn(s.warning)}`,
    );
  }
  log(
    `[aggregate] escape (ai_agent) ${pct(r.rates.escape.pct)}, ` +
      `false resolution ${pct(r.rates.falseResolution.overall.pct)}, ` +
      `abandonment ${pct(r.rates.abandonment.overall.pct)}; ` +
      `NPS ${num(r.nps.score)}, n ${r.nps.n}${warn(r.nps.warning)}`,
  );
}
