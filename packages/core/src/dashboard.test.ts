import { describe, expect, it } from 'vitest';
import { DrillQuerySchema, PeriodQuerySchema, weekBuckets } from './dashboard.ts';

describe('weekBuckets', () => {
  it('returns consecutive 7-day buckets ending at the given instant, oldest first', () => {
    expect(weekBuckets('2026-11-15T00:00:00.000Z', 2)).toEqual([
      { start: '2026-11-01T00:00:00.000Z', end: '2026-11-08T00:00:00.000Z' },
      { start: '2026-11-08T00:00:00.000Z', end: '2026-11-15T00:00:00.000Z' },
    ]);
  });

  it('returns nothing for zero weeks and rejects bad dates', () => {
    expect(weekBuckets('2026-11-15T00:00:00.000Z', 0)).toEqual([]);
    expect(() => weekBuckets('soon', 2)).toThrow(/Invalid date/);
  });
});

describe('query schemas', () => {
  it('accept a period with an optional business line', () => {
    expect(
      PeriodQuerySchema.parse({ from: '2026-10-01', to: '2026-10-31', line: 'billing' }).line,
    ).toBe('billing');
  });

  it('reject malformed dates and lines', () => {
    expect(PeriodQuerySchema.safeParse({ from: '10/01/2026', to: '2026-10-31' }).success).toBe(
      false,
    );
    expect(
      PeriodQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-31', line: "x' OR 1=1" })
        .success,
    ).toBe(false);
  });

  it('default the drill metric and coerce driver numbers from query strings', () => {
    const q = DrillQuerySchema.parse({
      from: '2026-10-01',
      to: '2026-10-31',
      metric: 'driver',
      driverRun: '3',
      driverRank: '1',
    });
    expect(q).toMatchObject({ metric: 'driver', driverRun: 3, driverRank: 1 });
    expect(DrillQuerySchema.parse({ from: '2026-10-01', to: '2026-10-31' }).metric).toBe('all');
  });
});
