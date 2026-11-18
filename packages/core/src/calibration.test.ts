import { describe, expect, it } from 'vitest';
import { calibrationStatus, type DecisionReadyCriteria, type EvalEvidence } from './calibration.ts';

const criteria: DecisionReadyCriteria = {
  minCategoryAccuracy: 0.8,
  minGoldenCases: 50,
  maxInflationRate: 0.05,
  maxAgeDays: 30,
};
const now = new Date('2026-11-18T00:00:00.000Z');
const good: EvalEvidence = {
  createdAt: '2026-11-10T00:00:00.000Z',
  categoryAccuracy: 0.9,
  inflationRate: 0.02,
  goldenCases: 60,
  seedCases: 200,
};

describe('calibrationStatus', () => {
  it('is decision-ready when every check passes', () => {
    expect(calibrationStatus(good, criteria, now)).toEqual({
      status: 'decision_ready',
      reasons: [],
    });
  });

  it('is calibrating with no eval yet', () => {
    const r = calibrationStatus(null, criteria, now);
    expect(r.status).toBe('calibrating');
    expect(r.reasons[0]).toMatch(/hasn't been checked/);
  });

  it('accepts values exactly at the bar', () => {
    expect(
      calibrationStatus(
        {
          ...good,
          categoryAccuracy: 0.8,
          inflationRate: 0.05,
          goldenCases: 50,
          createdAt: '2026-10-19T00:00:00.000Z',
        },
        criteria,
        now,
      ).status,
    ).toBe('decision_ready');
  });

  it('explains each failing check in plain words', () => {
    const r = calibrationStatus(
      {
        createdAt: '2026-09-01T00:00:00.000Z',
        categoryAccuracy: 0.72,
        inflationRate: 0.08,
        goldenCases: 0,
        seedCases: 200,
      },
      criteria,
      now,
    );
    expect(r.status).toBe('calibrating');
    expect(r.reasons).toEqual([
      'Scoring agreed with reviewers on 72% of conversations; the bar is 80%.',
      'Checked against 0 real conversations so far; 50 are needed.',
      'Scoring was too generous on 8% of conversations; the limit is 5%.',
      'The last check was 78 days ago; it must be within 30 days.',
    ]);
  });

  it('treats unknown accuracy or inflation as failing (never assume the best)', () => {
    const r = calibrationStatus(
      { ...good, categoryAccuracy: null, inflationRate: null },
      criteria,
      now,
    );
    expect(r.reasons).toHaveLength(2);
  });

  it('treats an unreadable date as too old', () => {
    const r = calibrationStatus({ ...good, createdAt: 'not a date' }, criteria, now);
    expect(r).toEqual({
      status: 'calibrating',
      reasons: ['The date of the last check is unknown; it must be within the last 30 days.'],
    });
  });
});
