import { describe, expect, it } from 'vitest';
import {
  abandonmentRate,
  buildPeriodReport,
  deltaVsPrior,
  escapeRate,
  falseResolutionRate,
  finalCategory,
  npsScore,
  nrs,
  nrsByBusinessLine,
  nrsByChannel,
  PeriodReportSchema,
  periodFromDates,
  rateByChannel,
  round1,
  sampleSizeWarning,
  segment,
  toReportItem,
  type Reclassification,
  type ReportItem,
} from './report.ts';
import type { Category, ScoreRecord, ScorerOutput } from './schemas.ts';

// ───────────── builders ─────────────

const output = (over: Partial<ScorerOutput> = {}): ScorerOutput => ({
  channel: 'ai_agent',
  customer_goal: 'reset password',
  resolved: 'yes',
  effort: 1,
  sentiment_start: 0,
  sentiment_end: 1,
  asked_for_human: false,
  abandoned: false,
  category: 'promoter',
  evidence: 'works',
  ...over,
});

const meta = {
  interactionId: 'i1',
  channel: 'ai_agent' as const,
  businessLine: 'billing',
  model: 'test-model',
  promptVersion: 'scorer.v1',
  scoredAt: '2026-11-01T00:00:00.000Z',
  attempts: 1,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
};

const scored = (category: Category, over: Partial<ScorerOutput> = {}): ScoreRecord => ({
  ...meta,
  status: 'scored',
  output: output({ category, ...over }),
  category,
  override: null,
  flags: [],
  cacheKey: 'k',
  cached: false,
});

const failed: ScoreRecord = {
  ...meta,
  status: 'score_failed',
  reason: 'invalid_output',
  detail: 'bad',
};

let rid = 0;
const reclass = (over: Partial<Reclassification> = {}): Reclassification => ({
  id: ++rid,
  interactionId: 'i1',
  fromCategory: 'promoter',
  toCategory: 'detractor',
  reason: 'false_resolution',
  source: 'link',
  createdAt: '2026-11-05T00:00:00.000Z',
  ...over,
});

let iid = 0;
const item = (category: Category, over: Partial<ReportItem> = {}): ReportItem => ({
  interactionId: `i${++iid}`,
  channel: 'ai_agent',
  businessLine: 'billing',
  category,
  scoreFailed: false,
  askedForHuman: false,
  abandoned: false,
  claimedResolved: category !== 'detractor',
  falseResolution: false,
  ...over,
});
const many = (n: number, category: Category, over: Partial<ReportItem> = {}) =>
  Array.from({ length: n }, () => item(category, over));

// ───────────── finalCategory ─────────────

describe('finalCategory', () => {
  it("uses the score's category when there are no reclassifications", () => {
    expect(finalCategory(scored('promoter'), [])).toBe('promoter');
  });

  it('turns a reclassified promoter into a detractor', () => {
    expect(finalCategory(scored('promoter'), [reclass()])).toBe('detractor');
  });

  it('applies the latest reclassification', () => {
    const early = reclass({ toCategory: 'detractor', createdAt: '2026-11-02T00:00:00.000Z' });
    const late = reclass({ toCategory: 'passive', createdAt: '2026-11-03T00:00:00.000Z' });
    expect(finalCategory(scored('promoter'), [late, early])).toBe('passive');
  });

  it("ignores another interaction's reclassifications", () => {
    expect(finalCategory(scored('promoter'), [reclass({ interactionId: 'other' })])).toBe(
      'promoter',
    );
  });

  it('falls back to detractor for a failed score', () => {
    expect(finalCategory(failed, [])).toBe('detractor');
  });
});

describe('toReportItem', () => {
  it('carries the facts the rates need', () => {
    const i = toReportItem(scored('promoter'), [reclass()]);
    expect(i).toMatchObject({
      category: 'detractor',
      claimedResolved: true,
      falseResolution: true,
    });
  });

  it('marks a failed score as unknown facts', () => {
    expect(toReportItem(failed, [])).toMatchObject({
      category: 'detractor',
      scoreFailed: true,
      claimedResolved: false,
    });
  });
});

// ───────────── NRS ─────────────

describe('nrs', () => {
  it('is null for an empty set, not 0', () => {
    expect(nrs([])).toBeNull();
  });

  it('is +100 when everyone is a promoter', () => {
    expect(nrs(many(5, 'promoter'))).toBe(100);
  });

  it('is −100 when everyone is a detractor', () => {
    expect(nrs(many(5, 'detractor'))).toBe(-100);
  });

  it('is 0 for all passives', () => {
    expect(nrs(many(3, 'passive'))).toBe(0);
  });

  it('rounds to 1 decimal', () => {
    // 1 promoter, 2 passives: 33.333… → 33.3
    expect(nrs([item('promoter'), item('passive'), item('passive')])).toBe(33.3);
    // 1 detractor, 2 passives: −33.3
    expect(nrs([item('detractor'), item('passive'), item('passive')])).toBe(-33.3);
  });

  it('counts a reclassified promoter as a detractor', () => {
    const items = [toReportItem(scored('promoter'), [reclass()]), item('promoter')];
    expect(nrs(items)).toBe(0);
  });
});

describe('round1', () => {
  it('rounds half away from zero and never returns −0', () => {
    expect(round1(12.25)).toBe(12.3);
    expect(round1(-12.25)).toBe(-12.3);
    expect(Object.is(round1(-0.04), 0)).toBe(true);
  });
});

describe('sampleSizeWarning', () => {
  it('flags fewer than 30 as low confidence', () => {
    expect(sampleSizeWarning(0)).toBe('low confidence');
    expect(sampleSizeWarning(29)).toBe('low confidence');
    expect(sampleSizeWarning(30)).toBeNull();
  });
});

describe('segment', () => {
  it('counts each category and flags a small segment', () => {
    expect(
      segment([item('promoter'), item('passive'), item('detractor'), item('detractor')]),
    ).toEqual({
      n: 4,
      promoters: 1,
      passives: 1,
      detractors: 2,
      nrs: -25,
      warning: 'low confidence',
    });
  });

  it('has no warning at 30 or more', () => {
    expect(segment(many(30, 'promoter')).warning).toBeNull();
  });
});

describe('nrsByChannel', () => {
  it('always reports all three channels, empty ones as null and low confidence', () => {
    const r = nrsByChannel([...many(30, 'promoter'), item('detractor', { channel: 'human' })]);
    expect(Object.keys(r)).toEqual(['ai_agent', 'human', 'hybrid']);
    expect(r.ai_agent).toMatchObject({ n: 30, nrs: 100, warning: null });
    expect(r.human).toMatchObject({ n: 1, nrs: -100, warning: 'low confidence' });
    expect(r.hybrid).toMatchObject({ n: 0, nrs: null, warning: 'low confidence' });
  });

  it('is all-empty for no data', () => {
    expect(Object.values(nrsByChannel([])).every((s) => s.n === 0 && s.nrs === null)).toBe(true);
  });
});

describe('nrsByBusinessLine', () => {
  it('reports each line present, sorted', () => {
    const r = nrsByBusinessLine([item('promoter', { businessLine: 'tech' }), item('detractor')]);
    expect(Object.keys(r)).toEqual(['billing', 'tech']);
    expect(r.billing!.nrs).toBe(-100);
    expect(r.tech!.nrs).toBe(100);
  });

  it('is empty for no data', () => {
    expect(nrsByBusinessLine([])).toEqual({});
  });
});

// ───────────── rates ─────────────

describe('escapeRate', () => {
  it('counts only ai_agent interactions', () => {
    const r = escapeRate([
      item('detractor', { askedForHuman: true }),
      item('promoter'),
      item('detractor', { channel: 'human', askedForHuman: true }),
    ]);
    expect(r).toEqual({ n: 2, count: 1, pct: 50, warning: 'low confidence' });
  });

  it('is null with no ai_agent interactions', () => {
    expect(escapeRate([item('promoter', { channel: 'human' })]).pct).toBeNull();
    expect(escapeRate([]).pct).toBeNull();
  });

  it('leaves failed scores out of the denominator', () => {
    expect(escapeRate([item('detractor', { scoreFailed: true }), item('promoter')]).n).toBe(1);
  });
});

describe('falseResolutionRate', () => {
  it('is false resolutions over claimed resolutions', () => {
    const items = [
      toReportItem(scored('promoter'), [reclass()]),
      item('promoter'),
      item('passive'),
      item('detractor', { claimedResolved: false }),
    ];
    expect(falseResolutionRate(items)).toMatchObject({ n: 3, count: 1, pct: 33.3 });
  });

  it('is 0 for all promoters, null for nothing claimed resolved', () => {
    expect(falseResolutionRate(many(4, 'promoter')).pct).toBe(0);
    expect(falseResolutionRate(many(4, 'detractor', { claimedResolved: false })).pct).toBeNull();
  });
});

describe('abandonmentRate', () => {
  it('is abandoned over all scored interactions', () => {
    expect(
      abandonmentRate([item('detractor', { abandoned: true }), ...many(3, 'promoter')]).pct,
    ).toBe(25);
    expect(abandonmentRate(many(40, 'detractor', { abandoned: true }))).toMatchObject({
      pct: 100,
      warning: null,
    });
  });

  it('splits by channel', () => {
    const r = rateByChannel(abandonmentRate, [
      item('detractor', { abandoned: true, channel: 'hybrid' }),
    ]);
    expect(r.hybrid.pct).toBe(100);
    expect(r.ai_agent.pct).toBeNull();
  });
});

// ───────────── comparison ─────────────

describe('deltaVsPrior', () => {
  it('is current − prior in points, 1 decimal', () => {
    expect(deltaVsPrior(12.4, -3.3)).toBe(15.7);
    expect(deltaVsPrior(-100, 100)).toBe(-200);
    expect(deltaVsPrior(5, 5)).toBe(0);
  });

  it('is null when either side has no data', () => {
    expect(deltaVsPrior(null, 10)).toBeNull();
    expect(deltaVsPrior(10, null)).toBeNull();
  });
});

describe('npsScore', () => {
  it('is %9–10 minus %0–6', () => {
    expect(npsScore([10, 9, 8, 7, 0])).toBe(20);
    expect(npsScore([])).toBeNull();
  });
});

describe('periodFromDates', () => {
  it('covers whole UTC days, end exclusive, with an equal prior period', () => {
    expect(periodFromDates('2026-10-01', '2026-10-31')).toEqual({
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-11-01T00:00:00.000Z',
      priorStart: '2026-08-31T00:00:00.000Z',
      priorEnd: '2026-10-01T00:00:00.000Z',
    });
  });

  it('allows a single day', () => {
    expect(periodFromDates('2026-10-05', '2026-10-05').periodEnd).toBe('2026-10-06T00:00:00.000Z');
  });

  it('rejects bad or reversed dates', () => {
    expect(() => periodFromDates('2026-02-30', '2026-03-01')).toThrow(/--from/);
    expect(() => periodFromDates('10/01/2026', '2026-10-31')).toThrow(/--from/);
    expect(() => periodFromDates('2026-10-31', '2026-10-01')).toThrow(/on or after/);
  });
});

// ───────────── the report ─────────────

describe('buildPeriodReport', () => {
  const base = {
    period: periodFromDates('2026-10-01', '2026-10-31'),
    source: { model: 'test-model', promptVersion: 'scorer.v1' },
    counts: { interactions: 0, scored: 0, scoreFailed: 0, unscored: 0 },
    surveys: { current: [], prior: [] },
  };

  it('produces a valid report for empty periods', () => {
    const r = buildPeriodReport({ ...base, current: [], prior: [] });
    expect(PeriodReportSchema.parse(r)).toEqual(r);
    expect(r.overall).toMatchObject({
      n: 0,
      nrs: null,
      prior: null,
      delta: null,
      warning: 'low confidence',
    });
    expect(r.byBusinessLine).toEqual({});
  });

  it('compares with the prior period and flags small segments', () => {
    const current = [
      ...many(30, 'promoter'),
      toReportItem({ ...scored('promoter'), interactionId: 'x' }, [
        reclass({ interactionId: 'x' }),
      ]),
      item('detractor', { channel: 'human', businessLine: 'tech', askedForHuman: true }),
    ];
    const prior = many(40, 'detractor', { claimedResolved: false });
    const r = buildPeriodReport({
      ...base,
      current,
      prior,
      surveys: { current: [10, 9, 3], prior: [0] },
    });
    expect(PeriodReportSchema.parse(r)).toEqual(r);

    // 30 promoters, 2 detractors (one is the reclassified promoter) of 32
    expect(r.overall).toMatchObject({ n: 32, nrs: 87.5, prior: -100, delta: 187.5, warning: null });
    expect(r.byChannel.ai_agent).toMatchObject({ n: 31, nrs: 93.5, warning: null });
    expect(r.byChannel.human).toMatchObject({ n: 1, warning: 'low confidence' });
    expect(r.byBusinessLine.tech).toMatchObject({
      n: 1,
      prior: null,
      delta: null,
      warning: 'low confidence',
    });
    expect(r.rates.falseResolution.overall).toMatchObject({
      n: 31,
      count: 1,
      pct: 3.2,
      prior: null,
    });
    expect(r.rates.escape).toMatchObject({ n: 31, count: 0, pct: 0 });
    expect(r.nps).toMatchObject({
      n: 3,
      score: 33.3,
      prior: -100,
      delta: 133.3,
      warning: 'low confidence',
    });
  });
});
