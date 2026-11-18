import { PeriodReportSchema, ScoreRecordSchema, type Category, type Channel } from '@nrs/core';
import { describe, expect, it } from 'vitest';
import { migrate, openDb, type Db } from '../db.ts';
import { validOutput } from '../score/testUtils.ts';
import { defaultPeriod, runAggregate } from './stage.ts';

const MODEL = 'test-model';
const opts = { from: '2026-10-01', to: '2026-10-31', model: MODEL, promptVersion: 'scorer.v1' };

interface Row {
  id: string;
  at: string;
  channel?: Channel;
  line?: string;
  /** Omit for an unscored interaction; 'failed' for a score_failed row. */
  score?: Category | 'failed';
  askedForHuman?: boolean;
}

function db(rows: Row[], extra: (d: Db) => void = () => {}): Db {
  const d = openDb(':memory:');
  migrate(d);
  d.prepare("INSERT INTO customers VALUES ('c1', '2026-01-01T00:00:00.000Z')").run();
  for (const r of rows) {
    const channel = r.channel ?? 'ai_agent';
    const line = r.line ?? 'billing';
    d.prepare('INSERT INTO interactions VALUES (?, ?, ?, ?, ?, ?)').run(
      r.id,
      'c1',
      channel,
      r.at,
      'Customer: hi',
      line,
    );
    if (!r.score) continue;
    const base = {
      interactionId: r.id,
      channel,
      businessLine: line,
      model: MODEL,
      promptVersion: 'scorer.v1',
      scoredAt: r.at,
      attempts: 1,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    const record = ScoreRecordSchema.parse(
      r.score === 'failed'
        ? { ...base, status: 'score_failed', reason: 'invalid_output', detail: 'bad' }
        : {
            ...base,
            status: 'scored',
            output: validOutput({
              channel,
              category: r.score,
              resolved: r.score === 'detractor' ? 'no' : 'yes',
              asked_for_human: r.askedForHuman ?? false,
            }),
            category: r.score,
            override: null,
            flags: [],
            cacheKey: 'k',
            cached: false,
          },
    );
    d.prepare(
      'INSERT INTO scores (interaction_id, json, model, prompt_version, scored_at, status) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(r.id, JSON.stringify(record), MODEL, 'scorer.v1', r.at, record.status);
  }
  extra(d);
  return d;
}

const oct = (day: number) => `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`;
const sep = (day: number) => `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;

describe('runAggregate', () => {
  it('saves a valid PeriodReport to runs', () => {
    const d = db([
      { id: 'p1', at: oct(2), score: 'promoter' },
      { id: 'p2', at: oct(3), score: 'promoter' },
    ]);
    const { runId, report } = runAggregate(d, opts, () => {});
    const row = d.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Record<string, string>;
    expect(row.period_start).toBe('2026-10-01T00:00:00.000Z');
    expect(row.period_end).toBe('2026-11-01T00:00:00.000Z');
    expect(PeriodReportSchema.parse(JSON.parse(row.report_json!))).toEqual(report);
    expect(report.overall).toMatchObject({ n: 2, nrs: 100, warning: 'low confidence' });
  });

  it('counts a reclassified promoter as a detractor, without touching its score', () => {
    const d = db(
      [
        { id: 'fr', at: oct(2), score: 'promoter' },
        { id: 'ok', at: oct(3), score: 'promoter' },
      ],
      (x) =>
        x
          .prepare(
            `INSERT INTO reclassifications (interaction_id, from_category, to_category, reason, source, created_at)
             VALUES ('fr', 'promoter', 'detractor', 'false_resolution', 'link', '2026-10-05T00:00:00.000Z')`,
          )
          .run(),
    );
    const before = d.prepare('SELECT json FROM scores WHERE interaction_id = ?').pluck().get('fr');
    const { report } = runAggregate(d, opts, () => {});
    expect(report.overall).toMatchObject({ promoters: 1, detractors: 1, nrs: 0 });
    expect(report.rates.falseResolution.overall).toMatchObject({ n: 2, count: 1, pct: 50 });
    expect(d.prepare('SELECT json FROM scores WHERE interaction_id = ?').pluck().get('fr')).toBe(
      before,
    );
  });

  it('counts failed scores as detractors and leaves unscored ones out', () => {
    const d = db([
      { id: 'a', at: oct(2), score: 'promoter' },
      { id: 'b', at: oct(3), score: 'failed' },
      { id: 'c', at: oct(4) },
    ]);
    const { report } = runAggregate(d, opts, () => {});
    expect(report.counts).toEqual({ interactions: 3, scored: 1, scoreFailed: 1, unscored: 1 });
    expect(report.overall).toMatchObject({ n: 2, promoters: 1, detractors: 1 });
    expect(report.rates.abandonment.overall.n).toBe(1); // failed score's facts are unknown
  });

  it('only includes interactions inside the period, and compares with the prior one', () => {
    const d = db(
      [
        ...Array.from({ length: 30 }, (_, i) => ({
          id: `cur${i}`,
          at: oct(1 + (i % 28)),
          score: 'promoter' as const,
        })),
        { id: 'edge-out', at: '2026-11-01T00:00:00.000Z', score: 'detractor' }, // end is exclusive
        { id: 'prior1', at: sep(15), score: 'detractor' },
        { id: 'prior2', at: sep(20), score: 'promoter' },
      ],
      (x) => {
        const s = x.prepare(
          "INSERT INTO surveys (customer_id, nps_score, responded_at) VALUES ('c1', ?, ?)",
        );
        s.run(10, oct(5));
        s.run(2, sep(10));
      },
    );
    const { report } = runAggregate(d, opts, () => {});
    expect(report.overall).toMatchObject({ n: 30, nrs: 100, prior: 0, delta: 100, warning: null });
    expect(report.byChannel.ai_agent).toMatchObject({ n: 30, warning: null });
    expect(report.byChannel.human).toMatchObject({ n: 0, nrs: null, warning: 'low confidence' });
    expect(report.nps).toMatchObject({ n: 1, score: 100, prior: -100, delta: 200 });
  });

  it('reports the AI escape rate', () => {
    const d = db([
      { id: 'e', at: oct(2), score: 'detractor', askedForHuman: true },
      { id: 'f', at: oct(3), score: 'promoter' },
      { id: 'g', at: oct(4), score: 'detractor', askedForHuman: true, channel: 'human' },
    ]);
    expect(runAggregate(d, opts, () => {}).report.rates.escape).toMatchObject({
      n: 2,
      count: 1,
      pct: 50,
    });
  });

  it('saves a valid report for an empty period', () => {
    const { report } = runAggregate(db([]), opts, () => {});
    expect(report.overall).toMatchObject({ n: 0, nrs: null, delta: null });
    expect(report.counts.interactions).toBe(0);
  });

  it('ignores scores from another model or prompt version', () => {
    const d = db([{ id: 'a', at: oct(2), score: 'promoter' }]);
    expect(runAggregate(d, { ...opts, model: 'other' }, () => {}).report.counts.unscored).toBe(1);
  });

  it('logs figures and warnings', () => {
    const logs: string[] = [];
    runAggregate(db([{ id: 'a', at: oct(2), score: 'promoter' }]), opts, (m) => logs.push(m));
    const out = logs.join('\n');
    expect(out).toContain('NRS 100.0, n 1  [low confidence]');
    expect(out).toContain('2026-10-01 → 2026-10-31');
  });
});

describe('defaultPeriod', () => {
  it('is the 30 days ending on the latest interaction', () => {
    expect(defaultPeriod(db([{ id: 'a', at: oct(31) }]))).toEqual({
      from: '2026-10-02',
      to: '2026-10-31',
    });
  });

  it('asks for dates when there is no data', () => {
    expect(() => defaultPeriod(db([]))).toThrow(/No interactions/);
  });
});
