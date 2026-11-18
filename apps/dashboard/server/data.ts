import {
  buildPeriodReport,
  DriversReportSchema,
  nrsByChannel,
  periodFromDates,
  round1,
  ScoreRecordSchema,
  segment,
  toReportItem,
  weekBuckets,
  type DrillItem,
  type DrillQuery,
  type DrillResponse,
  type InteractionDetail,
  type MetaResponse,
  type PeriodQuery,
  type PeriodReport,
  type ReportItem,
  type ScoreRecord,
  type SummaryResponse,
} from '@nrs/core';
import {
  latestCalibration,
  loadPeriodScores,
  redact,
  type Db,
  type PeriodRow,
} from '@nrs/pipeline';

export interface Settings {
  /** Scores shown are for this model + scorer prompt version. */
  model: string;
  promptVersion: string;
}

const TREND_WEEKS = 12;

function rows(db: Db, s: Settings, start: string, end: string, line?: string): PeriodRow[] {
  const all = loadPeriodScores(db, start, end, s.model, s.promptVersion);
  return line ? all.filter((r) => r.businessLine === line) : all;
}

function toItems(rs: readonly PeriodRow[]): {
  items: ReportItem[];
  counts: PeriodReport['counts'];
} {
  const items: ReportItem[] = [];
  const counts = { interactions: rs.length, scored: 0, scoreFailed: 0, unscored: 0 };
  for (const r of rs) {
    if (!r.score) {
      counts.unscored++;
      continue;
    }
    if (r.score.status === 'scored') counts.scored++;
    else counts.scoreFailed++;
    items.push(toReportItem(r.score, r.reclassifications));
  }
  return { items, counts };
}

export function meta(db: Db, s: Settings): MetaResponse {
  const range = db
    .prepare('SELECT min(started_at) AS lo, max(started_at) AS hi FROM interactions')
    .get() as { lo: string | null; hi: string | null };
  const lines = db
    .prepare('SELECT DISTINCT business_line FROM interactions ORDER BY business_line')
    .pluck()
    .all() as string[];
  return {
    earliestDate: range.lo?.slice(0, 10) ?? null,
    latestDate: range.hi?.slice(0, 10) ?? null,
    businessLines: lines,
    model: s.model,
    promptVersion: s.promptVersion,
    demo: s.model.startsWith('demo-'),
  };
}

function latestDrivers(db: Db, s: Settings, periodStart: string, periodEnd: string) {
  const runs = db
    .prepare(
      `SELECT id, period_start, period_end, report_json FROM driver_runs
       WHERE model = ? AND report_json IS NOT NULL ORDER BY id DESC LIMIT 50`,
    )
    .all(s.model) as {
    id: number;
    period_start: string;
    period_end: string;
    report_json: string;
  }[];
  const run =
    runs.find((r) => r.period_start === periodStart && r.period_end === periodEnd) ?? runs[0];
  if (!run) return null;
  const report = DriversReportSchema.parse(JSON.parse(run.report_json));
  // Quotes and labels are model output about redacted text; redact again before sending.
  for (const d of report.top) {
    d.driver = redact(d.driver).text;
    d.label = redact(d.label).text;
    if (d.representative) d.representative.quote = redact(d.representative.quote).text;
  }
  return {
    runId: run.id,
    periodStart: run.period_start,
    periodEnd: run.period_end,
    matchesPeriod: run.period_start === periodStart && run.period_end === periodEnd,
    top: report.top,
  };
}

/** Everything the one-screen dashboard needs for a period and optional business line. */
export function summary(db: Db, s: Settings, q: PeriodQuery): SummaryResponse {
  const p = periodFromDates(q.from, q.to);
  const current = toItems(rows(db, s, p.periodStart, p.periodEnd, q.line));
  const prior = toItems(rows(db, s, p.priorStart, p.priorEnd, q.line));
  const surveys = (start: string, end: string) =>
    db
      .prepare('SELECT nps_score FROM surveys WHERE responded_at >= ? AND responded_at < ?')
      .pluck()
      .all(start, end) as number[];
  const report = buildPeriodReport({
    period: p,
    source: { model: s.model, promptVersion: s.promptVersion },
    current: current.items,
    prior: prior.items,
    counts: current.counts,
    surveys: {
      current: surveys(p.periodStart, p.periodEnd),
      prior: surveys(p.priorStart, p.priorEnd),
    },
  });

  const ai = report.byChannel.ai_agent;
  const human = report.byChannel.human;
  const gap = (a: number | null, b: number | null) =>
    a === null || b === null ? null : round1(a - b);

  // Weekly trend ending with the selected period; leading weeks with no data are dropped.
  const trend = weekBuckets(p.periodEnd, TREND_WEEKS)
    .map((w) => {
      const rs = rows(db, s, w.start, w.end, q.line);
      const { items } = toItems(rs);
      return {
        start: w.start,
        end: w.end,
        total: rs.length,
        overall: segment(items),
        byChannel: nrsByChannel(items),
      };
    })
    .filter((w, i, all) => all.slice(0, i + 1).some((x) => x.total > 0))
    .map(({ total: _total, ...w }) => w);

  return {
    query: q,
    report,
    aiVsHuman: { ai, human, gap: gap(ai.nrs, human.nrs), priorGap: gap(ai.prior, human.prior) },
    calibration: latestCalibration(db, s.model, s.promptVersion),
    drivers: latestDrivers(db, s, p.periodStart, p.periodEnd),
    trend,
  };
}

const CHANNEL_WORDS = { ai_agent: 'AI agent', human: 'people', hybrid: 'AI then people' } as const;

/** The interactions behind one number on the dashboard. */
export function drill(db: Db, s: Settings, q: DrillQuery): DrillResponse {
  const p = periodFromDates(q.from, q.to);
  let rs = rows(db, s, p.periodStart, p.periodEnd, q.line);
  let title = 'All conversations';

  if (q.metric === 'driver') {
    const run = q.driverRun
      ? (db.prepare('SELECT report_json FROM driver_runs WHERE id = ?').pluck().get(q.driverRun) as
          string | undefined)
      : undefined;
    const driver = run
      ? DriversReportSchema.parse(JSON.parse(run)).top.find((d) => d.rank === q.driverRank)
      : undefined;
    if (!driver) throw new HttpError(404, 'That driver was not found.');
    const ids = new Set(driver.interactionIds);
    const dr = db
      .prepare('SELECT period_start, period_end FROM driver_runs WHERE id = ?')
      .get(q.driverRun) as { period_start: string; period_end: string };
    rs = rows(db, s, dr.period_start, dr.period_end).filter((r) => ids.has(r.interactionId));
    title = `Unhappy customers: ${driver.driver}`;
  }
  if (q.channel) {
    rs = rs.filter((r) => r.channel === q.channel);
  }

  const items: DrillItem[] = [];
  for (const r of rs) {
    const item = r.score ? toReportItem(r.score, r.reclassifications) : null;
    const keep =
      q.metric === 'escape'
        ? r.channel === 'ai_agent' && !!item?.askedForHuman
        : q.metric === 'false_resolution'
          ? !!item?.falseResolution
          : q.metric === 'abandoned'
            ? !!item?.abandoned
            : true;
    if (!keep) continue;
    if (q.category && item?.category !== q.category) continue;
    items.push({
      interactionId: r.interactionId,
      startedAt: r.startedAt,
      channel: r.channel,
      businessLine: r.businessLine,
      category: item?.category ?? null,
      reclassified: r.reclassifications.length > 0,
    });
  }
  items.sort(
    (a, b) =>
      b.startedAt.localeCompare(a.startedAt) || a.interactionId.localeCompare(b.interactionId),
  );

  if (q.metric === 'escape') title = 'AI conversations where the customer asked for a person';
  if (q.metric === 'false_resolution') title = 'Told it was fixed, but the customer came back';
  if (q.metric === 'abandoned') title = 'Customers who gave up mid-conversation';
  const parts = [title];
  if (q.channel) parts.push(`handled by ${CHANNEL_WORDS[q.channel]}`);
  if (q.category) parts.push(`${q.category}s only`);
  return { title: parts.join(', '), total: items.length, items };
}

/** Model-written text in a score is about redacted transcripts; redact again anyway. */
function redactScore(score: ScoreRecord): ScoreRecord {
  if (score.status !== 'scored') return score;
  return {
    ...score,
    output: {
      ...score.output,
      evidence: redact(score.output.evidence).text,
      customer_goal: redact(score.output.customer_goal).text,
    },
  };
}

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

/** One interaction: redacted transcript, score, and every reclassification with its reason. */
export function interaction(db: Db, s: Settings, id: string): InteractionDetail {
  const row = db
    .prepare(
      `SELECT i.id, i.started_at, i.channel, i.business_line, i.transcript AS raw, r.transcript AS redacted
       FROM interactions i LEFT JOIN redacted_transcripts r ON r.interaction_id = i.id WHERE i.id = ?`,
    )
    .get(id) as
    | {
        id: string;
        started_at: string;
        channel: string;
        business_line: string;
        raw: string;
        redacted: string | null;
      }
    | undefined;
  if (!row) throw new HttpError(404, 'That conversation was not found.');

  const scoreJson = db
    .prepare(
      'SELECT json FROM scores WHERE interaction_id = ? AND model = ? AND prompt_version = ?',
    )
    .pluck()
    .get(id, s.model, s.promptVersion) as string | undefined;
  const score = scoreJson ? redactScore(ScoreRecordSchema.parse(JSON.parse(scoreJson))) : null;

  const recl = db
    .prepare(
      `SELECT r.id, r.interaction_id, r.from_category, r.to_category, r.reason, r.source, r.created_at,
              l.a_interaction_id, l.b_interaction_id, l.gap_days, l.confidence, l.why
       FROM reclassifications r LEFT JOIN links l ON l.id = r.link_id
       WHERE r.interaction_id = ? ORDER BY r.id`,
    )
    .all(id) as Record<string, string | number | null>[];

  const reclassifications = recl.map((r) => ({
    id: r.id as number,
    interactionId: r.interaction_id as string,
    fromCategory: r.from_category,
    toCategory: r.to_category,
    reason: r.reason as string,
    source: r.source as string,
    createdAt: r.created_at as string,
    link:
      r.a_interaction_id === null
        ? null
        : {
            otherInteractionId: (r.a_interaction_id === id
              ? r.b_interaction_id
              : r.a_interaction_id) as string,
            gapDays: r.gap_days as number,
            confidence: r.confidence as number | null,
            why: r.why as string | null,
          },
  }));

  const final = score
    ? toReportItem(score, reclassifications as Parameters<typeof toReportItem>[1]).category
    : null;
  return {
    interactionId: row.id,
    startedAt: row.started_at,
    channel: row.channel as InteractionDetail['channel'],
    businessLine: row.business_line,
    // Never the raw text: the stored redacted copy, or redacted now if it hasn't been yet.
    transcript: redact(row.redacted ?? row.raw).text,
    score,
    finalCategory: final,
    reclassifications: reclassifications as InteractionDetail['reclassifications'],
  };
}
