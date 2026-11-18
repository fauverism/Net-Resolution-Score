import { describe, expect, it } from 'vitest';
import {
  bucketDates,
  describeDelta,
  formatNrs,
  formatPct,
  formatRange,
  presetRange,
} from './format.ts';
import { dashboardHref, drillHref, interactionHref, parseRoute } from './router.ts';

describe('formatNrs', () => {
  it('signs values with a true minus sign and shows a dash for no data', () => {
    expect(formatNrs(12.3)).toBe('+12.3');
    expect(formatNrs(-4)).toBe('−4.0');
    expect(formatNrs(0)).toBe('0.0');
    expect(formatNrs(null)).toBe('—');
  });

  it('formats percentages', () => {
    expect(formatPct(15.67)).toBe('15.7%');
    expect(formatPct(null)).toBe('—');
  });
});

describe('describeDelta', () => {
  it('pairs the arrow with a word, so color is never the only signal', () => {
    expect(describeDelta(4.1, true)).toEqual({
      direction: 'better',
      amount: '4.1 pts',
      arrow: '▲',
      sentence: 'Up 4.1 pts from the previous period, which is better.',
    });
  });

  it('knows that a rising rate can be bad', () => {
    expect(describeDelta(2, false)).toMatchObject({ direction: 'worse', arrow: '▲' });
    expect(describeDelta(-2, false)).toMatchObject({ direction: 'better', arrow: '▼' });
  });

  it('handles no change and no prior data', () => {
    expect(describeDelta(0, true)).toMatchObject({ direction: 'same', arrow: '■' });
    expect(describeDelta(null, true)).toMatchObject({ direction: 'none', arrow: '' });
  });
});

describe('dates', () => {
  it('formats an inclusive range', () => {
    expect(formatRange('2026-10-16', '2026-11-14')).toBe('Oct 16 – Nov 14, 2026');
  });

  it('builds preset ranges ending on the latest date', () => {
    expect(presetRange('2026-11-14', 30)).toEqual({ from: '2026-10-16', to: '2026-11-14' });
    expect(presetRange('2026-11-14', 1)).toEqual({ from: '2026-11-14', to: '2026-11-14' });
  });

  it('turns a [start, end) bucket into inclusive dates', () => {
    expect(bucketDates('2026-11-08T00:00:00.000Z', '2026-11-15T00:00:00.000Z')).toEqual({
      from: '2026-11-08',
      to: '2026-11-14',
    });
  });
});

describe('routes', () => {
  it('round-trips a drill-down', () => {
    const href = drillHref({
      from: '2026-10-01',
      to: '2026-10-31',
      line: 'billing',
      metric: 'escape',
      channel: 'ai_agent',
    });
    expect(parseRoute(href)).toEqual({
      page: 'drill',
      query: {
        from: '2026-10-01',
        to: '2026-10-31',
        line: 'billing',
        metric: 'escape',
        channel: 'ai_agent',
      },
    });
  });

  it('round-trips a dashboard and an interaction', () => {
    expect(parseRoute(dashboardHref({ from: '2026-10-01', to: '2026-10-31' }))).toEqual({
      page: 'dashboard',
      query: { from: '2026-10-01', to: '2026-10-31' },
    });
    expect(
      parseRoute(interactionHref('int_00012', '#/drill?from=2026-10-01&to=2026-10-31')),
    ).toEqual({
      page: 'interaction',
      id: 'int_00012',
      back: '#/drill?from=2026-10-01&to=2026-10-31',
    });
  });

  it('ignores junk and falls back to the dashboard', () => {
    expect(parseRoute('#/drill?from=nope')).toEqual({ page: 'dashboard', query: {} });
    expect(parseRoute('#/drill?from=2026-10-01&to=2026-10-31&metric=hack&channel=email')).toEqual({
      page: 'drill',
      query: { from: '2026-10-01', to: '2026-10-31', metric: 'all' },
    });
    expect(parseRoute('#/interaction/<script>')).toEqual({ page: 'dashboard', query: {} });
    expect(parseRoute('')).toEqual({ page: 'dashboard', query: {} });
  });
});
