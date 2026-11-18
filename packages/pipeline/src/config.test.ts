import { describe, expect, it } from 'vitest';
import { loadConfig, requireModel } from './config.ts';

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
