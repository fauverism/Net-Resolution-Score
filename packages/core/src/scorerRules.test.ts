import { describe, expect, it } from 'vitest';
import type { ScorerOutput } from './schemas.ts';
import { categoryCap, enforceCategory, lowerCategory } from './scorerRules.ts';

const base: ScorerOutput = {
  channel: 'ai_agent',
  customer_goal: 'Reset password',
  resolved: 'yes',
  effort: 1,
  sentiment_start: 0,
  sentiment_end: 1,
  asked_for_human: false,
  abandoned: false,
  category: 'promoter',
  evidence: "I'm in. New password set.",
};

describe('lowerCategory', () => {
  it('picks the lower category', () => {
    expect(lowerCategory('promoter', 'passive')).toBe('passive');
    expect(lowerCategory('detractor', 'promoter')).toBe('detractor');
    expect(lowerCategory('passive', 'passive')).toBe('passive');
  });
});

describe('categoryCap', () => {
  it('allows promoter only for a confirmed, effortless resolution', () => {
    expect(categoryCap(base)).toEqual({ cap: 'promoter', reasons: [] });
  });

  it.each([
    [{ resolved: 'no' as const }, 'resolved=no'],
    [{ asked_for_human: true }, 'asked_for_human'],
    [{ abandoned: true }, 'abandoned'],
  ])('caps at detractor: %o', (override, reason) => {
    expect(categoryCap({ ...base, ...override })).toEqual({ cap: 'detractor', reasons: [reason] });
  });

  it.each([
    [{ resolved: 'partial' as const }, 'resolved=partial'],
    [{ effort: 2 }, 'effort=2'],
    [{ effort: 3 }, 'effort=3'],
  ])('caps at passive: %o', (override, reason) => {
    expect(categoryCap({ ...base, ...override })).toEqual({ cap: 'passive', reasons: [reason] });
  });

  it('lists every reason', () => {
    expect(categoryCap({ ...base, resolved: 'no', abandoned: true }).reasons).toEqual([
      'resolved=no',
      'abandoned',
    ]);
  });
});

describe('enforceCategory', () => {
  it('keeps a consistent category', () => {
    expect(enforceCategory(base)).toEqual({ category: 'promoter', override: null });
  });

  it('never lets resolved=no be a promoter', () => {
    expect(enforceCategory({ ...base, resolved: 'no' })).toEqual({
      category: 'detractor',
      override: { from: 'promoter', to: 'detractor', reasons: ['resolved=no'] },
    });
  });

  it('lowers an unconfirmed resolution to passive', () => {
    expect(enforceCategory({ ...base, resolved: 'partial' }).category).toBe('passive');
  });

  it('never raises: a detractor stays a detractor even when facts allow more', () => {
    expect(enforceCategory({ ...base, category: 'detractor' })).toEqual({
      category: 'detractor',
      override: null,
    });
  });
});
