import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CategorySchema, CHANNELS } from '@nrs/core';
import { EvalResultsSchema, type EvalResults } from './runEval.ts';

/** evals/results/<timestamp>.json, e.g. 2026-11-18T10-53-00-000Z.json. */
export function writeResults(dir: string, results: EvalResults): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${results.createdAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify(EvalResultsSchema.parse(results), null, 2)}\n`);
  return file;
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

/** A short side-by-side table, then each prompt's confusion matrix. */
export function formatSummary(r: EvalResults): string {
  const names = r.prompts.map((p) => p.prompt);
  const w = Math.max(12, ...names.map((n) => n.length + 2));
  const label = 26;
  const row = (name: string, cells: string[]) =>
    `${name.padEnd(label)}${cells.map((c) => c.padStart(w)).join('')}`;
  const metric = (name: string, f: (p: EvalResults['prompts'][number]) => string) =>
    row(name, r.prompts.map(f));

  const lines = [
    `Eval: ${r.cases.total} cases (${r.cases.seed} seed, ${r.cases.golden} golden), model ${r.model}, ` +
      `threshold ${pct(r.threshold)} category accuracy`,
    '',
    row('', names),
    metric('category accuracy', (p) => pct(p.metrics.categoryAccuracy)),
    ...CHANNELS.map((c) =>
      metric(`  ${c} (n ${r.prompts[0]!.metrics.byChannel[c].n})`, (p) =>
        pct(p.metrics.byChannel[c].categoryAccuracy),
      ),
    ),
    metric('resolved', (p) => pct(p.metrics.fieldAccuracy.resolved)),
    metric('effort', (p) => pct(p.metrics.fieldAccuracy.effort)),
    metric('asked_for_human', (p) => pct(p.metrics.fieldAccuracy.asked_for_human)),
    metric('abandoned', (p) => pct(p.metrics.fieldAccuracy.abandoned)),
    metric('inflated (scored too high)', (p) => pct(p.metrics.inflationRate)),
    metric('failed to score', (p) => String(p.metrics.failed)),
    metric('est. cost', (p) => (p.estCostUsd === null ? 'unknown' : `$${p.estCostUsd.toFixed(2)}`)),
    metric('result', (p) => (p.passed ? 'PASS' : 'FAIL')),
  ];

  const cats = CategorySchema.options;
  for (const p of r.prompts) {
    lines.push('', `${p.prompt}: confusion (rows expected, columns scored)`);
    lines.push(`${''.padEnd(12)}${[...cats, 'failed'].map((c) => c.padStart(11)).join('')}`);
    for (const e of cats) {
      lines.push(
        `${e.padEnd(12)}${[...cats, 'failed'].map((a) => String(p.metrics.confusion[e]![a]).padStart(11)).join('')}`,
      );
    }
  }

  const failing = r.prompts.filter((p) => !p.passed).map((p) => p.prompt);
  lines.push(
    '',
    failing.length
      ? `FAIL: ${failing.join(', ')} below ${pct(r.threshold)} category accuracy`
      : `PASS: every prompt at or above ${pct(r.threshold)}`,
  );
  return lines.join('\n');
}
