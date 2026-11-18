import type { Calibration } from '@nrs/core';
import type { ReactNode } from 'react';
import { describeDelta } from '../format.ts';

/**
 * Change vs. the previous period. Direction is shown by an arrow AND a word ("better" /
 * "worse"), never by color alone; screen readers get the whole sentence.
 */
export function Delta({
  value,
  higherIsBetter,
  unit = 'pts',
  label,
}: {
  value: number | null;
  higherIsBetter: boolean;
  unit?: string;
  /** What changed, when it isn't the number above it (e.g. "Gap"). */
  label?: string;
}) {
  const d = describeDelta(value, higherIsBetter, unit);
  if (d.direction === 'none')
    return <span className="delta delta--none">No earlier period to compare</span>;
  return (
    <span className={`delta delta--${d.direction}`}>
      <span aria-hidden="true">
        {label ? `${label}: ` : ''}
        {d.arrow} {d.amount} · {d.direction === 'same' ? 'no change' : d.direction}
      </span>
      <span className="visually-hidden">
        {label ? `${label}: ` : ''}
        {d.sentence}
      </span>
    </span>
  );
}

/** Shown on any figure based on fewer than 30 conversations. */
export function LowConfidence({ n }: { n: number }) {
  return (
    <span className="tag tag--warn">
      <span aria-hidden="true">⚠ </span>Low confidence: only {n} conversation{n === 1 ? '' : 's'}
    </span>
  );
}

/** Marks a suggestion as a starting point from the AI, not a decision. */
export function AiSuggested() {
  return <span className="tag tag--ai">AI-suggested</span>;
}

export function CalibrationBadge({ calibration }: { calibration: Calibration | null }) {
  const ready = calibration?.status === 'decision_ready';
  const reasons = calibration?.reasons ?? ["The scoring hasn't been checked yet."];
  return (
    <div className="calibration">
      <span className={`badge ${ready ? 'badge--ready' : 'badge--calibrating'}`}>
        {ready && <span aria-hidden="true">✓ </span>}
        {ready ? 'Decision-ready' : 'Calibrating'}
      </span>
      {ready ? (
        <span className="calibration__note">The scoring has been checked and meets the bar.</span>
      ) : (
        <details className="calibration__why">
          <summary>Why not decision-ready yet?</summary>
          <ul>
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function Status({
  children,
  role = 'status',
}: {
  children: ReactNode;
  role?: 'status' | 'alert';
}) {
  return (
    <p className={`status${role === 'alert' ? ' status--error' : ''}`} role={role}>
      {children}
    </p>
  );
}
