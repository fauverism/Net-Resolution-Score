import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { ScoreRecordSchema, type GroundTruthLabel } from '@nrs/core';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../db.ts';
import { runRedaction } from '../redact/stage.ts';
import { DEFAULT_GENERATE_OPTIONS, generate } from '../seed/generate.ts';
import { writeSeed } from '../seed/write.ts';
import { DEFAULT_BACKOFF } from './backoff.ts';
import { loadPrompt } from './prompt.ts';
import { runScoring, type ScoringRunOptions } from './stage.ts';
import { fakeClient, fakeMessage, sentTranscript, validOutput } from './testUtils.ts';

function setup() {
  const data = generate({ ...DEFAULT_GENERATE_OPTIONS, customers: 30, interactions: 60 });
  const db = openDb(':memory:');
  migrate(db);
  writeSeed(db, data, path.join(mkdtempSync(path.join(tmpdir(), 'nrs-')), 'gt.json'));
  runRedaction(db, () => {});
  return { db, labels: data.groundTruth.labels };
}

const opts: ScoringRunOptions = {
  model: 'test-model',
  prompt: loadPrompt(),
  concurrency: 4,
  backoff: { ...DEFAULT_BACKOFF, sleep: async () => {} },
};

/** Answers with a valid score quoting the first customer line; every 3rd says resolved=no but promoter. */
const smart = () =>
  fakeClient((params, n) => {
    const firstCustomer = sentTranscript(params)
      .split('\n')[0]!
      .replace(/^Customer: /, '');
    return fakeMessage(
      JSON.stringify(
        validOutput({
          evidence: firstCustomer,
          resolved: n % 3 === 0 ? 'no' : 'yes',
          channel: 'ai_agent',
        }),
      ),
    );
  }, 2);

const leaks = (text: string, labels: GroundTruthLabel[]) =>
  labels
    .flatMap((l) => l.pii)
    .filter((p) =>
      new RegExp(
        `(?<![A-Za-z0-9])${p.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`,
      ).test(text),
    );

describe('runScoring', () => {
  it('respects --limit and the concurrency cap', async () => {
    const { db } = setup();
    const client = smart();
    const s = await runScoring(db, client, { ...opts, limit: 10 }, () => {});
    expect(s).toMatchObject({ requested: 10, scored: 10, failed: 0 });
    expect(client.calls).toHaveLength(10);
    expect(client.peak).toBeLessThanOrEqual(4);
    expect(client.peak).toBeGreaterThan(1);
  });

  it('sends only redacted transcripts and logs no PII or quotes', async () => {
    const { db, labels } = setup();
    const client = smart();
    const logs: string[] = [];
    await runScoring(db, client, opts, (m) => logs.push(m));
    expect(leaks(JSON.stringify(client.calls), labels)).toEqual([]);
    const logged = logs.join('\n');
    expect(leaks(logged, labels)).toEqual([]);
    for (const c of client.calls) {
      const quote = sentTranscript(c)
        .split('\n')[0]!
        .replace(/^Customer: /, '');
      expect(logged).not.toContain(quote);
    }
  });

  it('stores model, prompt_version and a valid record on every row', async () => {
    const { db } = setup();
    await runScoring(db, smart(), opts, () => {});
    const rows = db.prepare('SELECT * FROM scores').all() as Record<string, string>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.model).toBe('test-model');
      expect(r.prompt_version).toBe('scorer.v1');
      expect(r.status).toBe('scored');
      const rec = ScoreRecordSchema.parse(JSON.parse(r.json!));
      expect(rec.model).toBe('test-model');
    }
  });

  it('lowers inconsistent categories, flags them, and logs the override', async () => {
    const { db } = setup();
    const logs: string[] = [];
    const s = await runScoring(db, smart(), { ...opts, limit: 9 }, (m) => logs.push(m));
    expect(s.lowered).toBe(3);
    expect(
      logs.filter((l) => l.includes('lowered promoter → detractor (resolved=no)')),
    ).toHaveLength(3);
    const lowered = (db.prepare('SELECT json FROM scores').pluck().all() as string[])
      .map((j) => JSON.parse(j))
      .filter((r) => r.flags.includes('category_lowered'));
    expect(
      lowered.every((r) => r.category === 'detractor' && r.output.category === 'promoter'),
    ).toBe(true);
  });

  it('flags evidence that is not in the transcript', async () => {
    const { db } = setup();
    const client = fakeClient(() =>
      fakeMessage(JSON.stringify(validOutput({ evidence: 'Totally invented quote here' }))),
    );
    const s = await runScoring(db, client, { ...opts, limit: 3 }, () => {});
    expect(s.flagged).toBe(3);
    const flags = (db.prepare('SELECT json FROM scores').pluck().all() as string[]).map(
      (j) => JSON.parse(j).flags,
    );
    expect(flags.every((f: string[]) => f.includes('evidence_unverified'))).toBe(true);
  });

  it('costs nothing on re-runs: skips scored rows, then serves from cache', async () => {
    const { db } = setup();
    const first = smart();
    const s1 = await runScoring(db, first, { ...opts, model: 'claude-opus-5-5' }, () => {});
    expect(s1.estCostUsd).toBeGreaterThan(0);

    const second = smart();
    const s2 = await runScoring(db, second, { ...opts, model: 'claude-opus-5-5' }, () => {});
    expect(s2.requested).toBe(0);
    expect(second.calls).toHaveLength(0);

    db.prepare('DELETE FROM scores').run(); // e.g. after re-seeding
    const third = smart();
    const s3 = await runScoring(db, third, { ...opts, model: 'claude-opus-5-5' }, () => {});
    expect(third.calls).toHaveLength(0);
    expect(s3).toMatchObject({ cached: s1.scored, scored: s1.scored, estCostUsd: 0 });
  });

  it('does not reuse cache across models or prompt versions', async () => {
    const { db } = setup();
    await runScoring(db, smart(), { ...opts, limit: 5 }, () => {});
    const other = smart();
    await runScoring(db, other, { ...opts, model: 'other-model', limit: 5 }, () => {});
    expect(other.calls).toHaveLength(5);
  });

  it('records score_failed and retries those rows on the next run', async () => {
    const { db } = setup();
    const bad = fakeClient(() => fakeMessage('not json'));
    const s = await runScoring(db, bad, { ...opts, limit: 2 }, () => {});
    expect(s.failed).toBe(2);
    expect(bad.calls).toHaveLength(4); // one retry each
    const failed = db
      .prepare("SELECT json FROM scores WHERE status = 'score_failed'")
      .pluck()
      .all() as string[];
    expect(failed.map((j) => JSON.parse(j).reason)).toEqual(['invalid_output', 'invalid_output']);

    const good = smart();
    const s2 = await runScoring(db, good, { ...opts, limit: 2 }, () => {});
    expect(s2.scored).toBe(2);
    expect(
      db.prepare("SELECT count(*) FROM scores WHERE status = 'score_failed'").pluck().get(),
    ).toBe(0);
  });

  it('records tokens and estimated cost on the run', async () => {
    const { db } = setup();
    const s = await runScoring(
      db,
      smart(),
      { ...opts, model: 'claude-opus-5-5', limit: 4 },
      () => {},
    );
    const run = db.prepare('SELECT * FROM score_runs WHERE id = ?').get(s.runId) as Record<
      string,
      number
    >;
    expect(run).toMatchObject({
      requested: 4,
      scored: 4,
      input_tokens: 4000,
      output_tokens: 800,
      cache_read_tokens: 3200,
    });
    // 4000×$4 + 800×$20 + 3200×$0.20, per million
    expect(run.est_cost_usd).toBeCloseTo((4000 * 4 + 800 * 20 + 3200 * 0.2) / 1e6, 8);
  });

  it('aborts on an auth error and records it on the run', async () => {
    const { db } = setup();
    const client = fakeClient(
      () => new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers()),
    );
    await expect(
      runScoring(db, client, { ...opts, concurrency: 1 }, () => {}),
    ).rejects.toBeInstanceOf(Anthropic.AuthenticationError);
    expect(client.calls).toHaveLength(1); // stopped, didn't hammer the API
    const run = db.prepare('SELECT finished_at, error FROM score_runs').get() as Record<
      string,
      string
    >;
    expect(run.finished_at).not.toBeNull();
    expect(run.error).toBe('AuthenticationError 401');
    expect(db.prepare('SELECT count(*) FROM scores').pluck().get()).toBe(0);
  });
});
