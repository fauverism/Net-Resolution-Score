import { describe, expect, it } from 'vitest';
import { loadConfig, parseWindowOverrides, requireModel } from './config.ts';

describe('loadConfig', () => {
  it('defaults the return window to 7 days and concurrency to 5', () => {
    const c = loadConfig({});
    expect(c.returnWindowDays).toBe(7);
    expect(c.scoringConcurrency).toBe(5);
  });

  it('treats empty strings as unset', () => {
    const c = loadConfig({ RETURN_WINDOW_DAYS: '', ANTHROPIC_MODEL: '' });
    expect(c.returnWindowDays).toBe(7);
    expect(() => requireModel(c)).toThrow(/ANTHROPIC_MODEL/);
  });

  it('reads overrides from env', () => {
    const c = loadConfig({ RETURN_WINDOW_DAYS: '14', ANTHROPIC_MODEL: 'm' });
    expect(c.returnWindowDays).toBe(14);
    expect(requireModel(c)).toBe('m');
  });
});

describe('return window overrides', () => {
  it('parses per-business-line overrides', () => {
    expect(parseWindowOverrides('billing=14, tech_support = 5')).toEqual({
      billing: 14,
      tech_support: 5,
    });
    expect(parseWindowOverrides(undefined)).toEqual({});
  });

  it('rejects malformed entries', () => {
    expect(() => parseWindowOverrides('billing')).toThrow(/invalid entry "billing"/);
    expect(() => parseWindowOverrides('billing=0')).toThrow();
    expect(() => parseWindowOverrides('Billing Team=3')).toThrow();
  });

  it('builds the window config from env', () => {
    const c = loadConfig({ RETURN_WINDOW_DAYS: '10', RETURN_WINDOW_DAYS_BY_LINE: 'billing=14' });
    expect(c.returnWindow).toEqual({ defaultDays: 10, byBusinessLine: { billing: 14 } });
  });
});
