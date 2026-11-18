import type { Category, Channel } from '@nrs/core';

/** Plain words for an executive audience. */
export const CHANNEL_NAMES: Record<Channel, string> = {
  ai_agent: 'AI agent',
  human: 'People',
  hybrid: 'AI, then people',
};

export const CATEGORY_NAMES: Record<Category, string> = {
  promoter: 'Fixed easily',
  passive: 'Fixed, with effort',
  detractor: 'Let down',
};

const MINUS = '−';

/** NRS as "+12.3", "−4.0" or "0.0"; "—" when there is no data. */
export function formatNrs(x: number | null): string {
  if (x === null) return '—';
  if (x === 0) return '0.0';
  return `${x > 0 ? '+' : MINUS}${Math.abs(x).toFixed(1)}`;
}

export function formatPct(x: number | null): string {
  return x === null ? '—' : `${x.toFixed(1)}%`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export type Direction = 'better' | 'worse' | 'same' | 'none';

export interface DeltaView {
  direction: Direction;
  /** Shown next to the arrow, e.g. "4.1 pts". */
  amount: string;
  arrow: '▲' | '▼' | '■' | '';
  /** Full sentence for screen readers and tooltips. */
  sentence: string;
}

/**
 * A change vs. the prior period, never shown by color alone: an arrow for the direction of
 * the number, and a word for whether that's good. `higherIsBetter` is false for rates such
 * as "gave up", where going up is bad.
 */
export function describeDelta(
  delta: number | null,
  higherIsBetter: boolean,
  unit = 'pts',
): DeltaView {
  if (delta === null) {
    return {
      direction: 'none',
      amount: '',
      arrow: '',
      sentence: 'No earlier period to compare with.',
    };
  }
  const amount = `${Math.abs(delta).toFixed(1)} ${unit}`;
  if (delta === 0) {
    return {
      direction: 'same',
      amount,
      arrow: '■',
      sentence: 'No change from the previous period.',
    };
  }
  const up = delta > 0;
  const direction: Direction = up === higherIsBetter ? 'better' : 'worse';
  return {
    direction,
    amount,
    arrow: up ? '▲' : '▼',
    sentence: `${up ? 'Up' : 'Down'} ${amount} from the previous period, which is ${direction}.`,
  };
}

/** "Oct 16 – Nov 14, 2026" from inclusive YYYY-MM-DD dates. */
export function formatRange(from: string, to: string): string {
  const d = (s: string, year: boolean) =>
    new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(year ? { year: 'numeric' } : {}),
      timeZone: 'UTC',
    });
  return `${d(from, false)} – ${d(to, true)}`;
}

export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Inclusive YYYY-MM-DD range of `days` days ending on `latest`. */
export function presetRange(latest: string, days: number): { from: string; to: string } {
  const end = Date.parse(`${latest}T00:00:00Z`);
  return { from: new Date(end - (days - 1) * 86_400_000).toISOString().slice(0, 10), to: latest };
}

/** The YYYY-MM-DD dates covered by an ISO [start, end) bucket. */
export function bucketDates(start: string, end: string): { from: string; to: string } {
  return {
    from: start.slice(0, 10),
    to: new Date(Date.parse(end) - 86_400_000).toISOString().slice(0, 10),
  };
}
