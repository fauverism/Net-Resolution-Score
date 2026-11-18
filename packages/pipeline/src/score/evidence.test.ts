import { describe, expect, it } from 'vitest';
import { matchEvidence } from './evidence.ts';

const transcript = [
  'Customer: My internet has been down since this morning. Is there an outage?',
  'Agent: Please unplug the router for 30 seconds, then plug it back in.',
  "Customer: Okay, I did that. The light is still red, and I'm [NAME], by the way.",
  "Agent: I've refreshed your connection and the issue has been resolved!",
].join('\n');

describe('matchEvidence', () => {
  it('finds an exact customer quote', () => {
    expect(matchEvidence('The light is still red', transcript)).toBe('customer');
  });

  it('tolerates case, punctuation and curly quotes', () => {
    expect(matchEvidence('okay i did that — the light is STILL red', transcript)).toBe('customer');
    expect(matchEvidence('and I’m [NAME], by the way', transcript)).toBe('customer');
  });

  it('tolerates a small omission', () => {
    expect(
      matchEvidence('My internet has been down since this morning. Is there outage?', transcript),
    ).toBe('customer');
  });

  it('flags a quote that only appears in agent turns', () => {
    expect(matchEvidence('the issue has been resolved', transcript)).toBe('agent_only');
  });

  it('flags a fabricated or paraphrased quote', () => {
    expect(matchEvidence('Thanks, everything works perfectly now!', transcript)).toBe('not_found');
    expect(matchEvidence('internet broken all day', transcript)).toBe('not_found');
  });

  it('does not match an empty quote', () => {
    expect(matchEvidence('   ', transcript)).toBe('not_found');
  });
});
