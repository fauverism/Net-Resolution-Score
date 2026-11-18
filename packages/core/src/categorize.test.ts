import { describe, expect, it } from 'vitest';
import { breakdown, categorize, isWithinReturnWindow, type OutcomeFacts } from './categorize.ts';

const ok: OutcomeFacts = {
  resolved: true,
  firstContact: true,
  effort: 1,
  escalated: false,
  abandoned: false,
  returnedWithinWindow: false,
};

describe('categorize', () => {
  it('promoter: resolved first try with effort 1', () => {
    expect(categorize(ok)).toBe('promoter');
  });

  it('passive: resolved with effort 2 or 3', () => {
    expect(categorize({ ...ok, effort: 2 })).toBe('passive');
    expect(categorize({ ...ok, effort: 3 })).toBe('passive');
  });

  it('passive, not promoter: resolved repeat contact with effort 1', () => {
    expect(categorize({ ...ok, firstContact: false })).toBe('passive');
  });

  it.each([
    ['unresolved', { resolved: false }],
    ['escalated', { escalated: true }],
    ['abandoned', { abandoned: true }],
    ['returned within window', { returnedWithinWindow: true }],
  ] as const)('detractor: %s', (_, override) => {
    expect(categorize({ ...ok, ...override })).toBe('detractor');
  });
});

describe('isWithinReturnWindow', () => {
  const t0 = new Date('2026-11-01T12:00:00Z');
  const plusDays = (d: number) => new Date(t0.getTime() + d * 86_400_000);

  it('includes the boundary day', () => {
    expect(isWithinReturnWindow(t0, plusDays(7), 7)).toBe(true);
    expect(isWithinReturnWindow(t0, plusDays(7.01), 7)).toBe(false);
  });

  it('excludes same instant and earlier times', () => {
    expect(isWithinReturnWindow(t0, t0, 7)).toBe(false);
    expect(isWithinReturnWindow(t0, plusDays(-1), 7)).toBe(false);
  });
});

describe('breakdown', () => {
  it('returns null NRS for no data', () => {
    expect(breakdown([]).nrs).toBeNull();
  });

  it('computes %promoters − %detractors', () => {
    const b = breakdown(['promoter', 'promoter', 'passive', 'detractor']);
    expect(b).toEqual({ total: 4, promoters: 2, passives: 1, detractors: 1, nrs: 25 });
  });

  it('spans −100 to +100', () => {
    expect(breakdown(['detractor', 'detractor']).nrs).toBe(-100);
    expect(breakdown(['promoter']).nrs).toBe(100);
  });
});
