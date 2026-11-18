import { describe, expect, it } from 'vitest';
import {
  decideLink,
  findReturnCandidates,
  linkFlags,
  returnWindowDaysFor,
  type LinkableInteraction,
  type ReturnWindowConfig,
} from './linkRules.ts';

const cfg: ReturnWindowConfig = { defaultDays: 7, byBusinessLine: { billing: 14 } };
const day = (d: number) => new Date(Date.UTC(2026, 10, 1) + d * 86_400_000).toISOString();

let n = 0;
function ix(over: Partial<LinkableInteraction> & { day: number }): LinkableInteraction {
  const { day: d, ...rest } = over;
  return {
    interactionId: `int_${String(++n).padStart(3, '0')}`,
    customerId: 'c1',
    businessLine: 'tech_support',
    channel: 'ai_agent',
    startedAt: day(d),
    resolved: 'yes',
    category: 'promoter',
    ...rest,
  };
}
const pairs = (items: LinkableInteraction[]) =>
  findReturnCandidates(items, cfg).map((c) => [c.a.interactionId, c.b.interactionId]);

describe('returnWindowDaysFor', () => {
  it('uses the business-line override, then the default', () => {
    expect(returnWindowDaysFor('billing', cfg)).toBe(14);
    expect(returnWindowDaysFor('tech_support', cfg)).toBe(7);
  });

  it('ignores inherited object keys', () => {
    expect(returnWindowDaysFor('constructor', cfg)).toBe(7);
  });
});

describe('findReturnCandidates', () => {
  it('pairs a resolved interaction with a later one inside the window', () => {
    const a = ix({ day: 0 });
    const b = ix({ day: 3, resolved: null, category: null });
    expect(pairs([b, a])).toEqual([[a.interactionId, b.interactionId]]);
    expect(findReturnCandidates([a, b], cfg)[0]).toMatchObject({ gapDays: 3, windowDays: 7 });
  });

  it('includes the window boundary and excludes anything after it', () => {
    const a = ix({ day: 0 });
    const edge = ix({ day: 7, resolved: null, category: null });
    const late = ix({ day: 7.01, resolved: null, category: null });
    expect(pairs([a, edge, late])).toEqual([[a.interactionId, edge.interactionId]]);
  });

  it("uses A's business-line window", () => {
    const a = ix({ day: 0, businessLine: 'billing' });
    const b = ix({ day: 10, businessLine: 'tech_support' });
    expect(pairs([a, b])).toEqual([[a.interactionId, b.interactionId]]);
  });

  it('only pairs the same customer, and only forward in time', () => {
    const a = ix({ day: 2, category: 'passive' });
    const other = ix({ day: 3, customerId: 'c2' });
    const before = ix({ day: 1, resolved: 'no', category: 'detractor' });
    expect(pairs([a, other, before])).toEqual([]);
  });

  it('includes A with an unconfirmed ("partial") resolution: the usual false resolution', () => {
    const a = ix({ day: 0, resolved: 'partial', category: 'passive' });
    const b = ix({ day: 2, resolved: null, category: null });
    expect(pairs([a, b])).toEqual([[a.interactionId, b.interactionId]]);
  });

  it('skips A that is unscored or already a detractor, unless B is a promoter', () => {
    const b = ix({ day: 2, resolved: 'yes', category: 'passive' });
    for (const a of [
      ix({ day: 0, resolved: 'no', category: 'detractor' }),
      ix({ day: 0, resolved: null, category: null }),
      ix({ day: 0, resolved: 'yes', category: 'detractor' }),
    ]) {
      expect(pairs([a, b])).toEqual([]);
    }
  });

  it('pairs a detractor A with a promoter B, so the repeat contact can be capped', () => {
    const a = ix({ day: 0, resolved: 'no', category: 'detractor' });
    const b = ix({ day: 2, resolved: 'yes', category: 'promoter' });
    expect(pairs([a, b])).toEqual([[a.interactionId, b.interactionId]]);
  });

  it('returns every later interaction in the window', () => {
    const a = ix({ day: 0 });
    const b1 = ix({ day: 1 });
    const b2 = ix({ day: 2 });
    expect(pairs([a, b1, b2])).toEqual([
      [a.interactionId, b1.interactionId],
      [a.interactionId, b2.interactionId],
      [b1.interactionId, b2.interactionId],
    ]);
  });

  it('never pairs an interaction with one at the same instant', () => {
    expect(pairs([ix({ day: 0 }), ix({ day: 0 })])).toEqual([]);
  });
});

describe('decideLink', () => {
  it('confirms same goal at the 0.7 threshold and above', () => {
    expect(decideLink({ same_goal: true, confidence: 0.7, why: 'x' })).toBe('confirmed');
    expect(decideLink({ same_goal: true, confidence: 0.69, why: 'x' })).toBe('unconfirmed');
  });

  it('rejects a different goal whatever the confidence', () => {
    expect(decideLink({ same_goal: false, confidence: 0.99, why: 'x' })).toBe('rejected');
  });
});

describe('linkFlags', () => {
  it('flags AI-resolved, human-finished', () => {
    expect(linkFlags('ai_agent', 'human')).toEqual(['ai_resolved_human_finished']);
    expect(linkFlags('ai_agent', 'hybrid')).toEqual(['ai_resolved_human_finished']);
    expect(linkFlags('ai_agent', 'ai_agent')).toEqual([]);
    expect(linkFlags('human', 'human')).toEqual([]);
  });
});
