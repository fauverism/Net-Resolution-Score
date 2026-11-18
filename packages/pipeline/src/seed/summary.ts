import { breakdown, CHANNELS, type GroundTruthLabel } from '@nrs/core';
import { BUSINESS_LINES } from './goals.ts';
import type { SeedData } from './generate.ts';

const pct = (n: number, d: number) =>
  d === 0 ? '  n/a' : `${((100 * n) / d).toFixed(1)}%`.padStart(6);
const fmtNrs = (n: number | null) => (n === null ? '  n/a' : n.toFixed(1).padStart(6));

/** Human-readable summary of the planted patterns, computed from the hidden labels. */
export function summarize(data: SeedData): string {
  const labels = data.groundTruth.labels;
  const where = (f: (l: GroundTruthLabel) => boolean) => labels.filter(f);
  const ai = where((l) => l.channel === 'ai_agent');
  const out = [
    `customers ${data.customers.length}, interactions ${labels.length}, surveys ${data.surveys.length}`,
    `channel mix: ${CHANNELS.map((c) => `${c} ${pct(where((l) => l.channel === c).length, labels.length).trim()}`).join(', ')}`,
    `AI false resolutions ${pct(ai.filter((l) => l.falseResolution).length, ai.length).trim()}, ` +
      `AI escapes ${pct(ai.filter((l) => l.escalated).length, ai.length).trim()}, ` +
      `abandoned ${pct(where((l) => l.abandoned).length, labels.length).trim()}`,
    '',
    `true NRS (window ${data.groundTruth.returnWindowDays}d)   ${CHANNELS.map((c) => c.padStart(9)).join('')}`,
  ];
  for (const line of BUSINESS_LINES) {
    const cells = CHANNELS.map((c) => {
      const slice = where((l) => l.businessLine === line && l.channel === c);
      return fmtNrs(breakdown(slice.map((l) => l.trueCategory)).nrs).padStart(9);
    });
    out.push(`  ${line.padEnd(26)}${cells.join('')}`);
  }
  return out.join('\n');
}
