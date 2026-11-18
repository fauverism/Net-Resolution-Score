import { describe, expect, it } from 'vitest';
import {
  batchGoals,
  detractorSeverity,
  normalizeGoal,
  pickRepresentative,
  rankClusters,
  type DriverInput,
} from './drivers.ts';

let n = 0;
const d = (over: Partial<DriverInput> = {}): DriverInput => ({
  interactionId: `i${String(++n).padStart(3, '0')}`,
  channel: 'ai_agent',
  businessLine: 'billing',
  customerGoal: 'refund a duplicate charge',
  evidence: 'Still no refund.',
  evidenceVerified: true,
  resolved: 'no',
  abandoned: false,
  falseResolution: false,
  ...over,
});

describe('detractorSeverity', () => {
  it('ranks unresolved/abandoned > false resolution > high effort', () => {
    expect(detractorSeverity({ resolved: 'no', abandoned: false, falseResolution: false })).toBe(3);
    expect(detractorSeverity({ resolved: 'yes', abandoned: true, falseResolution: false })).toBe(3);
    expect(detractorSeverity({ resolved: 'yes', abandoned: false, falseResolution: true })).toBe(2);
    expect(
      detractorSeverity({ resolved: 'partial', abandoned: false, falseResolution: false }),
    ).toBe(1);
  });

  it('uses the highest tier that applies', () => {
    expect(detractorSeverity({ resolved: 'no', abandoned: true, falseResolution: true })).toBe(3);
  });
});

describe('batchGoals', () => {
  it('dedupes goals case- and space-insensitively, keeping first-seen order', () => {
    expect(batchGoals(['Reset password', 'reset  PASSWORD ', 'Refund'])).toEqual([
      ['Reset password', 'Refund'],
    ]);
  });

  it('splits into batches of at most 50 by default', () => {
    const goals = Array.from({ length: 120 }, (_, i) => `goal ${i}`);
    expect(batchGoals(goals).map((b) => b.length)).toEqual([50, 50, 20]);
    expect(batchGoals(goals, 60).map((b) => b.length)).toEqual([60, 60]);
  });

  it('handles no goals', () => {
    expect(batchGoals([])).toEqual([]);
  });

  it('rejects a batch size below 1', () => {
    expect(() => batchGoals(['x'], 0)).toThrow();
  });
});

describe('normalizeGoal', () => {
  it('lowercases, trims and collapses spaces', () => {
    expect(normalizeGoal('  Reset   Password ')).toBe('reset password');
  });
});

describe('pickRepresentative', () => {
  it('prefers a verified quote over a more severe unverified one', () => {
    const verified = d({ resolved: 'partial', evidence: 'real quote' });
    const invented = d({ evidenceVerified: false, evidence: 'made up' });
    expect(pickRepresentative([invented, verified])).toEqual({
      interactionId: verified.interactionId,
      quote: 'real quote',
    });
  });

  it('then prefers the most severe, then the earliest id', () => {
    const effort = d({ resolved: 'partial' });
    const unresolved1 = d();
    const unresolved2 = d();
    expect(pickRepresentative([effort, unresolved2, unresolved1])!.interactionId).toBe(
      unresolved1.interactionId,
    );
  });

  it('is null for no members', () => {
    expect(pickRepresentative([])).toBeNull();
  });
});

describe('rankClusters', () => {
  const label = (goal: string) =>
    goal.includes('refund') ? 'Refund not received' : 'Login problems';

  it('ranks by volume × severity, not volume alone', () => {
    const refunds = [d(), d()]; // 2 × severity 3 = 6
    const logins = [1, 2, 3, 4, 5].map(() => d({ customerGoal: 'log in', resolved: 'partial' })); // 5 × 1 = 5
    const ranked = rankClusters([...logins, ...refunds], label, 7);
    expect(ranked.map((c) => [c.label, c.volume, c.score])).toEqual([
      ['Refund not received', 2, 6],
      ['Login problems', 5, 5],
    ]);
  });

  it('breaks ties by volume, then label', () => {
    const a = [d({ customerGoal: 'refund' })]; // 1 × 3 = 3
    const b = [1, 2, 3].map(() => d({ customerGoal: 'log in', resolved: 'partial' })); // 3 × 1 = 3
    expect(rankClusters([...a, ...b], label, 4).map((c) => c.label)).toEqual([
      'Login problems',
      'Refund not received',
    ]);
  });

  it('reports share of all detractors, severity mix, channel mix and business lines', () => {
    const members = [
      d(),
      d({ channel: 'human', resolved: 'yes', falseResolution: true }),
      d({ channel: 'hybrid', resolved: 'partial', businessLine: 'tech' }),
      d({ abandoned: true, resolved: 'partial' }),
    ];
    const [c] = rankClusters(members, label, 10);
    expect(c).toMatchObject({
      volume: 4,
      score: 3 + 2 + 1 + 3,
      meanSeverity: 2.3,
      pctOfDetractors: 40,
      severityMix: { unresolvedOrAbandoned: 2, falseResolution: 1, highEffort: 1 },
      channelMix: {
        ai_agent: { n: 2, pct: 50 },
        human: { n: 1, pct: 25 },
        hybrid: { n: 1, pct: 25 },
      },
      businessLines: { billing: 3, tech: 1 },
      warning: 'low confidence',
    });
  });

  it('flags small clusters as low confidence, not ones with 30+', () => {
    const big = Array.from({ length: 30 }, () => d());
    expect(rankClusters(big, label, 30)[0]).toMatchObject({ warning: null, pctOfDetractors: 100 });
  });

  it('returns nothing for no detractors', () => {
    expect(rankClusters([], label, 0)).toEqual([]);
  });
});
