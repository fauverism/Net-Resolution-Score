import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../db.ts';
import { latestCalibration, runCalibrate } from './stage.ts';

function setup(results: Record<string, unknown>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nrs-cal-'));
  const resultsDir = path.join(dir, 'results');
  mkdirSync(resultsDir);
  for (const [name, body] of Object.entries(results)) {
    writeFileSync(
      path.join(resultsDir, name),
      typeof body === 'string' ? body : JSON.stringify(body),
    );
  }
  const config = path.join(dir, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      categoryAccuracyThreshold: 0.8,
      resultsDir,
      decisionReady: { minGoldenCases: 50, maxInflationRate: 0.05, maxAgeDays: 30 },
    }),
  );
  const db = openDb(':memory:');
  migrate(db);
  return { db, config };
}

const result = (createdAt: string, model: string, acc: number, golden: number) => ({
  createdAt,
  model,
  cases: { seed: 200, golden },
  prompts: [{ prompt: 'scorer.v1', metrics: { categoryAccuracy: acc, inflationRate: 0.01 } }],
});
const now = new Date('2026-11-18T00:00:00.000Z');
const opts = (config: string, model = 'm') => ({
  model,
  promptVersion: 'scorer.v1',
  evalConfigPath: config,
  now,
});

describe('runCalibrate', () => {
  it('is decision-ready from the newest passing eval for this model and prompt', () => {
    const { db, config } = setup({
      '2026-11-01T00-00-00-000Z.json': result('2026-11-01T00:00:00.000Z', 'm', 0.6, 0),
      '2026-11-15T00-00-00-000Z.json': result('2026-11-15T00:00:00.000Z', 'm', 0.9, 60),
      '2026-11-16T00-00-00-000Z.json': result('2026-11-16T00:00:00.000Z', 'other-model', 0.1, 0),
    });
    const c = runCalibrate(db, opts(config), () => {});
    expect(c).toMatchObject({
      status: 'decision_ready',
      reasons: [],
      categoryAccuracy: 0.9,
      goldenCases: 60,
    });
    expect(latestCalibration(db, 'm', 'scorer.v1')).toEqual(c);
  });

  it('is calibrating, with reasons, when the eval falls short', () => {
    const { db, config } = setup({ 'a.json': result('2026-11-15T00:00:00.000Z', 'm', 0.75, 0) });
    const c = runCalibrate(db, opts(config), () => {});
    expect(c.status).toBe('calibrating');
    expect(c.reasons).toHaveLength(2);
  });

  it('is calibrating when there is no eval for this model, and skips unreadable files', () => {
    const logs: string[] = [];
    const { db, config } = setup({ 'z.json': '{ not json' });
    const c = runCalibrate(db, opts(config), (m) => logs.push(m));
    expect(c).toMatchObject({ status: 'calibrating', evalCreatedAt: null, goldenCases: 0 });
    expect(logs.join('\n')).toMatch(/skipping unreadable eval result z\.json/);
  });

  it('returns null before any calibration has run', () => {
    const { db } = setup({});
    expect(latestCalibration(db, 'm', 'scorer.v1')).toBeNull();
  });
});
