import { describe, expect, it } from 'vitest';
import {
  confusionMatrix,
  evalMetrics,
  expectedFromGroundTruth,
  fnv1a,
  GoldenCaseSchema,
  stratifiedSample,
  type EvalExpected,
  type EvalObservation,
} from './evals.ts';
import type { GroundTruthLabel } from './groundTruth.ts';

const label = (over: Partial<GroundTruthLabel> = {}): GroundTruthLabel => ({
  interactionId: 'int_1',
  customerId: 'cus_1',
  channel: 'ai_agent',
  businessLine: 'billing',
  goalId: 'duplicate_charge',
  goal: 'Dispute a duplicate charge',
  startedAt: '2026-10-01T10:00:00.000Z',
  resolved: true,
  visiblyResolved: true,
  falseResolution: false,
  firstContact: true,
  effort: 1,
  escalated: false,
  abandoned: false,
  previousInteractionId: null,
  returnInteractionId: null,
  returnAfterDays: null,
  transcriptCategory: 'promoter',
  trueCategory: 'promoter',
  pii: [],
  ...over,
});

describe('expectedFromGroundTruth', () => {
  it('expects a clean resolution to be a promoter', () => {
    expect(expectedFromGroundTruth(label())).toEqual({
      category: 'promoter',
      resolved: 'yes',
      effort: 1,
      asked_for_human: false,
      abandoned: false,
    });
  });

  it('expects a false resolution to read as "partial" / passive, not its true detractor', () => {
    const fr = label({ resolved: false, falseResolution: true, trueCategory: 'detractor' });
    expect(expectedFromGroundTruth(fr)).toMatchObject({ resolved: 'partial', category: 'passive' });
  });

  it('expects effort 2–3 to cap at passive', () => {
    expect(expectedFromGroundTruth(label({ effort: 3 })).category).toBe('passive');
  });

  it('expects escalation and abandonment to be detractors', () => {
    expect(expectedFromGroundTruth(label({ escalated: true }))).toMatchObject({
      category: 'detractor',
      asked_for_human: true,
    });
    expect(expectedFromGroundTruth(label({ resolved: false, abandoned: true }))).toMatchObject({
      category: 'detractor',
      resolved: 'no',
      abandoned: true,
    });
  });

  it('judges only the transcript: a return contact can still be a promoter (linking caps it)', () => {
    expect(
      expectedFromGroundTruth(label({ firstContact: false, trueCategory: 'passive' })).category,
    ).toBe('promoter');
  });
});

const exp = (over: Partial<EvalExpected> = {}): EvalExpected => ({
  category: 'promoter',
  resolved: 'yes',
  effort: 1,
  asked_for_human: false,
  abandoned: false,
  ...over,
});
let n = 0;
const obs = (
  expected: EvalExpected,
  actual: EvalExpected | null,
  channel: EvalObservation['channel'] = 'ai_agent',
) => ({
  id: `c${++n}`,
  channel,
  expected,
  actual,
});

describe('evalMetrics', () => {
  it('is all null for no cases', () => {
    const m = evalMetrics([]);
    expect(m).toMatchObject({ n: 0, failed: 0, categoryAccuracy: null, inflationRate: null });
    expect(m.fieldAccuracy).toEqual({
      resolved: null,
      effort: null,
      asked_for_human: null,
      abandoned: null,
    });
  });

  it('scores category and each field separately', () => {
    const m = evalMetrics([
      obs(exp(), exp()),
      obs(exp(), exp({ category: 'passive', effort: 2 })),
      obs(
        exp({ category: 'detractor', abandoned: true, resolved: 'no' }),
        exp({ category: 'detractor', resolved: 'no' }),
      ),
      obs(
        exp({ category: 'detractor', asked_for_human: true }),
        exp({ category: 'detractor', asked_for_human: true }),
      ),
    ]);
    expect(m.categoryAccuracy).toBe(0.75);
    expect(m.fieldAccuracy).toEqual({
      resolved: 1,
      effort: 0.75,
      asked_for_human: 1,
      abandoned: 0.75,
    });
  });

  it('counts a failed score as wrong everywhere', () => {
    const m = evalMetrics([obs(exp(), exp()), obs(exp(), null)]);
    expect(m).toMatchObject({ n: 2, failed: 1, categoryAccuracy: 0.5 });
    expect(m.fieldAccuracy.resolved).toBe(0.5);
  });

  it('measures inflation: scored higher than expected', () => {
    const m = evalMetrics([
      obs(exp({ category: 'detractor' }), exp({ category: 'promoter' })), // inflated
      obs(exp({ category: 'passive' }), exp({ category: 'detractor' })), // deflated, not inflation
      obs(exp(), exp()),
      obs(exp(), null),
    ]);
    expect(m.inflationRate).toBe(0.25);
  });

  it('reports accuracy by channel, with empty channels as null', () => {
    const m = evalMetrics([
      obs(exp(), exp(), 'human'),
      obs(exp(), exp({ category: 'passive' }), 'human'),
    ]);
    expect(m.byChannel.human).toEqual({ n: 2, categoryAccuracy: 0.5 });
    expect(m.byChannel.hybrid).toEqual({ n: 0, categoryAccuracy: null });
  });
});

describe('confusionMatrix', () => {
  it('has expected categories as rows and scored categories (or failed) as columns', () => {
    const m = confusionMatrix([
      obs(exp(), exp()),
      obs(exp(), exp({ category: 'passive' })),
      obs(exp({ category: 'detractor' }), null),
    ]);
    expect(m.promoter).toEqual({ detractor: 0, passive: 1, promoter: 1, failed: 0 });
    expect(m.detractor).toEqual({ detractor: 0, passive: 0, promoter: 0, failed: 1 });
    expect(m.passive).toEqual({ detractor: 0, passive: 0, promoter: 0, failed: 0 });
  });
});

describe('stratifiedSample', () => {
  const items = [
    ...Array.from({ length: 90 }, (_, i) => ({ id: `a${i}`, s: 'common' })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, s: 'rare' })),
    { id: 'c0', s: 'single' },
  ];
  const sample = (size: number, salt?: string) =>
    stratifiedSample(
      items,
      size,
      (x) => x.s,
      (x) => x.id,
      salt ? { salt } : {},
    );

  it('is deterministic and changes with the salt', () => {
    expect(sample(20)).toEqual(sample(20));
    expect(sample(20, 'other').map((x) => x.id)).not.toEqual(sample(20).map((x) => x.id));
  });

  it('keeps rare strata (at least 5, or all of a tiny one)', () => {
    const s = sample(20);
    expect(s.filter((x) => x.s === 'rare')).toHaveLength(5);
    expect(s.filter((x) => x.s === 'single')).toHaveLength(1);
    expect(s.filter((x) => x.s === 'common')).toHaveLength(18);
  });

  it('returns everything when the size covers it', () => {
    expect(sample(500)).toHaveLength(items.length);
  });
});

describe('fnv1a', () => {
  it('is stable', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
  });
});

describe('GoldenCaseSchema', () => {
  it('validates a hand-labeled case and rejects unknown fields', () => {
    const ok = { id: 'g1', channel: 'human', transcript: 'Customer: hi', expected: exp() };
    expect(GoldenCaseSchema.parse(ok)).toEqual(ok);
    expect(
      GoldenCaseSchema.safeParse({ ...ok, expected: { ...exp(), confidence: 1 } }).success,
    ).toBe(false);
  });
});
