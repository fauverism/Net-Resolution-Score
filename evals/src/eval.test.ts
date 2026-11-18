import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { GroundTruthFileSchema, type ScorerOutput } from '@nrs/core';
import { loadPrompt, migrate, openDb, redact } from '@nrs/pipeline';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BACKOFF } from '../../packages/pipeline/src/score/backoff.ts';
import {
  fakeClient,
  fakeMessage,
  validOutput,
} from '../../packages/pipeline/src/score/testUtils.ts';
import { DEFAULT_GENERATE_OPTIONS, generate } from '../../packages/pipeline/src/seed/generate.ts';
import { writeSeed } from '../../packages/pipeline/src/seed/write.ts';
import { loadGoldenCases, loadSeedCases, type EvalCase } from './cases.ts';
import { loadEvalConfig } from './config.ts';
import { formatSummary, writeResults } from './report.ts';
import { EvalResultsSchema, runEval } from './runEval.ts';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'nrs-eval-'));

function seeded() {
  const dir = tmp();
  const gt = path.join(dir, 'gt.json');
  const db = openDb(':memory:');
  migrate(db);
  const data = generate({ ...DEFAULT_GENERATE_OPTIONS, customers: 40, interactions: 120 });
  writeSeed(db, data, gt);
  return { db, gt, data };
}

const opts = (prompts = [loadPrompt('scorer.v1')]) => ({
  model: 'test-model',
  prompts,
  concurrency: 4,
  threshold: 0.8,
  backoff: { ...DEFAULT_BACKOFF, sleep: async () => {} },
});

/** Answers with the expected label for each transcript, optionally getting some wrong. */
function oracle(
  cases: EvalCase[],
  wrong: (c: EvalCase) => Partial<ScorerOutput> | null = () => null,
) {
  const byTranscript = new Map(cases.map((c) => [c.transcript as string, c]));
  return fakeClient((params) => {
    const t = (params.messages[0]!.content as string)
      .split('<transcript>\n')[1]!
      .split('\n</transcript>')[0]!;
    const c = byTranscript.get(t)!;
    return fakeMessage(
      JSON.stringify(validOutput({ channel: c.channel, ...c.expected, ...(wrong(c) ?? {}) })),
    );
  });
}

describe('loadSeedCases', () => {
  it('pairs every ground-truth label with its transcript, redacted', () => {
    const { db, gt, data } = seeded();
    const cases = loadSeedCases(db, gt, null);
    expect(cases).toHaveLength(data.interactions.length);
    const names = data.groundTruth.labels.flatMap((l) =>
      l.pii.filter((p) => p.type === 'name').map((p) => p.value),
    );
    const all = cases.map((c) => c.transcript).join('\n');
    for (const n of names) expect(all).not.toMatch(new RegExp(`\\b${n}\\b`));
    expect(all).toContain('[NAME]');
  });

  it('takes a stratified sample covering every channel', () => {
    const { db, gt } = seeded();
    const cases = loadSeedCases(db, gt, 30);
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(cases.length).toBeLessThan(60);
    expect(new Set(cases.map((c) => c.channel))).toEqual(new Set(['ai_agent', 'human', 'hybrid']));
  });

  it('explains what to do when the seed is missing or out of sync', () => {
    const { db } = seeded();
    expect(() => loadSeedCases(db, path.join(tmp(), 'nope.json'), null)).toThrow(/npm run seed/);
    const other = path.join(tmp(), 'gt.json');
    const file = GroundTruthFileSchema.parse(
      generate({ ...DEFAULT_GENERATE_OPTIONS, seed: 9, customers: 5, interactions: 400 })
        .groundTruth,
    );
    writeFileSync(other, JSON.stringify(file));
    expect(() => loadSeedCases(db, other, null)).toThrow(/isn't in the db/);
  });
});

describe('loadGoldenCases', () => {
  it('loads *.jsonl, redacts transcripts, and ignores the example file', () => {
    const dir = tmp();
    writeFileSync(
      path.join(dir, 'batch1.jsonl'),
      JSON.stringify({
        id: 't1',
        channel: 'human',
        transcript: 'Customer: Hi, this is Maria Garcia, maria@example.com.\nAgent: Hello!',
        expected: {
          category: 'passive',
          resolved: 'partial',
          effort: 1,
          asked_for_human: false,
          abandoned: false,
        },
      }) + '\n',
    );
    writeFileSync(path.join(dir, 'example.jsonl.example'), '{"not": "loaded"}\n');
    const cases = loadGoldenCases(dir);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ id: 'golden:t1', source: 'golden', channel: 'human' });
    expect(cases[0]!.transcript).toBe(
      redact('Customer: Hi, this is Maria Garcia, maria@example.com.\nAgent: Hello!').text,
    );
    expect(cases[0]!.transcript).not.toContain('Maria');
  });

  it('points at the bad line', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'a.jsonl'), '\n{"id": "x", "channel": "phone"}\n');
    expect(() => loadGoldenCases(dir)).toThrow(/a\.jsonl:2/);
  });

  it('rejects duplicate ids and returns nothing for a missing folder', () => {
    const dir = tmp();
    const line = JSON.stringify({
      id: 'd',
      channel: 'human',
      transcript: 'Customer: hi',
      expected: {
        category: 'detractor',
        resolved: 'no',
        effort: 1,
        asked_for_human: false,
        abandoned: true,
      },
    });
    writeFileSync(path.join(dir, 'a.jsonl'), `${line}\n${line}\n`);
    expect(() => loadGoldenCases(dir)).toThrow(/duplicate id/);
    expect(loadGoldenCases(path.join(dir, 'missing'))).toEqual([]);
  });
});

describe('runEval', () => {
  it('scores 100% when the scorer matches, and passes', async () => {
    const { db, gt } = seeded();
    const cases = loadSeedCases(db, gt, 40);
    const r = await runEval(oracle(cases), cases, opts());
    expect(r.passed).toBe(true);
    expect(r.prompts[0]!.metrics).toMatchObject({
      categoryAccuracy: 1,
      inflationRate: 0,
      failed: 0,
    });
    expect(r.prompts[0]!.metrics.fieldAccuracy).toEqual({
      resolved: 1,
      effort: 1,
      asked_for_human: 1,
      abandoned: 1,
    });
  });

  it('fails below the threshold and shows inflation in the confusion matrix', async () => {
    const { db, gt } = seeded();
    const cases = loadSeedCases(db, gt, 40);
    // Get every detractor wrong by calling it a clean promoter.
    const client = oracle(cases, (c) =>
      c.expected.category === 'detractor'
        ? {
            category: 'promoter',
            resolved: 'yes',
            effort: 1,
            asked_for_human: false,
            abandoned: false,
          }
        : null,
    );
    const r = await runEval(client, cases, opts());
    const m = r.prompts[0]!.metrics;
    const detractors = cases.filter((c) => c.expected.category === 'detractor').length;
    expect(m.confusion.detractor!.promoter).toBe(detractors);
    expect(m.inflationRate).toBeCloseTo(detractors / cases.length, 2);
    expect(r.passed).toBe(m.categoryAccuracy! >= 0.8);
  });

  it('applies the same category enforcement as the pipeline', async () => {
    const { db, gt } = seeded();
    const cases = loadSeedCases(db, gt, 20).filter((c) => c.expected.category === 'detractor');
    // The model says promoter but its own facts say unresolved: enforcement lowers it.
    const r = await runEval(
      oracle(cases, () => ({ category: 'promoter' })),
      cases,
      opts(),
    );
    expect(r.prompts[0]!.metrics.categoryAccuracy).toBe(1);
  });

  it('counts failed scores as wrong, and fails the run', async () => {
    const { db, gt } = seeded();
    const cases = loadSeedCases(db, gt, 20);
    const r = await runEval(
      fakeClient(() => fakeMessage('not json')),
      cases,
      opts(),
    );
    expect(r.prompts[0]!.metrics).toMatchObject({ failed: cases.length, categoryAccuracy: 0 });
    expect(r.passed).toBe(false);
    expect(r.prompts[0]!.cases[0]!.failure).toMatch(/invalid_output/);
  });

  it('compares prompt versions side by side on the same cases', async () => {
    const { db, gt } = seeded();
    const cases = loadSeedCases(db, gt, 20);
    const client = oracle(cases);
    const r = await runEval(
      client,
      cases,
      opts([loadPrompt('scorer.v1'), loadPrompt('linker.v1')]),
    );
    expect(r.prompts.map((p) => p.prompt)).toEqual(['scorer.v1', 'linker.v1']);
    expect(client.calls).toHaveLength(cases.length * 2);
    expect(client.calls[cases.length]!.system).not.toEqual(client.calls[0]!.system);
  });

  it('reuses the score cache: a second run is free', async () => {
    const { db, gt } = seeded();
    const cases = loadSeedCases(db, gt, 20);
    await runEval(oracle(cases), cases, { ...opts(), db });
    const again = oracle(cases);
    await runEval(again, cases, { ...opts(), db });
    expect(again.calls).toHaveLength(0);
  });

  it('never sends unredacted text', async () => {
    const { db, gt, data } = seeded();
    const cases = loadSeedCases(db, gt, 40);
    const client = oracle(cases);
    await runEval(client, cases, opts());
    const sent = JSON.stringify(client.calls);
    for (const e of data.groundTruth.labels.flatMap((l) =>
      l.pii.filter((p) => p.type === 'email'),
    )) {
      expect(sent).not.toContain(e.value);
    }
  });

  it('aborts on an auth error', async () => {
    const { db, gt } = seeded();
    const cases = loadSeedCases(db, gt, 5);
    const client = fakeClient(
      () => new Anthropic.AuthenticationError(401, undefined, 'bad', new Headers()),
    );
    await expect(runEval(client, cases, { ...opts(), concurrency: 1 })).rejects.toBeInstanceOf(
      Anthropic.AuthenticationError,
    );
  });
});

describe('results and summary', () => {
  it('writes a timestamped, valid results file with no transcripts', async () => {
    const { db, gt } = seeded();
    const cases = loadSeedCases(db, gt, 20);
    const r = await runEval(oracle(cases), cases, opts(), new Date('2026-11-18T10:53:00.000Z'));
    const file = writeResults(tmp(), r);
    expect(path.basename(file)).toBe('2026-11-18T10-53-00-000Z.json');
    const text = readFileSync(file, 'utf8');
    expect(EvalResultsSchema.parse(JSON.parse(text))).toEqual(r);
    expect(text).not.toContain('Customer:');
  });

  it('prints a side-by-side table, confusion matrices and the verdict', async () => {
    const { db, gt } = seeded();
    const cases = loadSeedCases(db, gt, 20);
    const r = await runEval(
      oracle(cases),
      cases,
      opts([loadPrompt('scorer.v1'), loadPrompt('linker.v1')]),
    );
    const s = formatSummary(r);
    expect(s).toMatch(/category accuracy\s+100\.0%\s+100\.0%/);
    expect(s).toContain('scorer.v1: confusion (rows expected, columns scored)');
    expect(s).toContain('PASS: every prompt at or above 80.0%');
  });
});

describe('evals/config.json', () => {
  it('is valid and starts at 0.8', () => {
    const cfg = loadEvalConfig(path.join(import.meta.dirname, '..', 'config.json'));
    expect(cfg.categoryAccuracyThreshold).toBe(0.8);
  });
});
