import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  calibrationStatus,
  CalibrationSchema,
  DecisionReadyCriteriaSchema,
  type Calibration,
  type EvalEvidence,
} from '@nrs/core';
import { z } from 'zod';
import type { Db } from '../db.ts';
import { resolveFromRoot } from '../paths.ts';

/** The parts of evals/config.json calibration needs (the file has more). */
const EvalConfigFileSchema = z.object({
  categoryAccuracyThreshold: z.number().min(0).max(1),
  resultsDir: z.string(),
  decisionReady: DecisionReadyCriteriaSchema.omit({ minCategoryAccuracy: true }),
});

/** The parts of an evals/results/*.json file calibration needs. */
const EvalResultFileSchema = z.object({
  createdAt: z.string(),
  model: z.string(),
  cases: z.object({ seed: z.number().int(), golden: z.number().int() }),
  prompts: z.array(
    z.object({
      prompt: z.string(),
      metrics: z.object({
        categoryAccuracy: z.number().nullable(),
        inflationRate: z.number().nullable(),
      }),
    }),
  ),
});

export interface CalibrateOptions {
  model: string;
  promptVersion: string;
  evalConfigPath: string;
  now?: Date;
}

/** Newest eval result for this model + prompt, or null. Unreadable files are skipped. */
function latestEvidence(
  dir: string,
  model: string,
  promptVersion: string,
  log: (msg: string) => void,
): { file: string; evidence: EvalEvidence } | null {
  if (!existsSync(dir)) return null;
  // Result files are named by ISO timestamp, so names sort by time.
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse();
  for (const f of files) {
    let parsed;
    try {
      parsed = EvalResultFileSchema.safeParse(JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
    } catch {
      parsed = null;
    }
    if (!parsed?.success) {
      log(`[calibrate] skipping unreadable eval result ${f}`);
      continue;
    }
    const r = parsed.data;
    const p = r.prompts.find((x) => x.prompt === promptVersion);
    if (r.model !== model || !p) continue;
    return {
      file: f,
      evidence: {
        createdAt: r.createdAt,
        categoryAccuracy: p.metrics.categoryAccuracy,
        inflationRate: p.metrics.inflationRate,
        goldenCases: r.cases.golden,
        seedCases: r.cases.seed,
      },
    };
  }
  return null;
}

/** Decides "decision-ready" vs "calibrating" from the latest eval and saves it. */
export function runCalibrate(db: Db, o: CalibrateOptions, log: (msg: string) => void): Calibration {
  const cfg = EvalConfigFileSchema.parse(JSON.parse(readFileSync(o.evalConfigPath, 'utf8')));
  const now = o.now ?? new Date();
  const found = latestEvidence(resolveFromRoot(cfg.resultsDir), o.model, o.promptVersion, log);
  const { status, reasons } = calibrationStatus(
    found?.evidence ?? null,
    { ...cfg.decisionReady, minCategoryAccuracy: cfg.categoryAccuracyThreshold },
    now,
  );
  const calibration = CalibrationSchema.parse({
    status,
    reasons,
    model: o.model,
    promptVersion: o.promptVersion,
    evalCreatedAt: found?.evidence.createdAt ?? null,
    categoryAccuracy: found?.evidence.categoryAccuracy ?? null,
    inflationRate: found?.evidence.inflationRate ?? null,
    goldenCases: found?.evidence.goldenCases ?? 0,
    seedCases: found?.evidence.seedCases ?? 0,
    createdAt: now.toISOString(),
  });
  db.prepare(
    `INSERT INTO calibrations (model, prompt_version, status, reasons_json, eval_file, eval_created_at,
       category_accuracy, inflation_rate, golden_cases, seed_cases, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.model,
    o.promptVersion,
    calibration.status,
    JSON.stringify(calibration.reasons),
    found?.file ?? null,
    calibration.evalCreatedAt,
    calibration.categoryAccuracy,
    calibration.inflationRate,
    calibration.goldenCases,
    calibration.seedCases,
    calibration.createdAt,
  );
  log(
    `[calibrate] ${status === 'decision_ready' ? 'Decision-ready' : 'Calibrating'}` +
      (found ? ` (from ${found.file})` : ' (no eval for this model and prompt yet)'),
  );
  for (const r of reasons) log(`[calibrate]   ${r}`);
  return calibration;
}

/** The latest saved calibration for this model + prompt, or null. */
export function latestCalibration(
  db: Db,
  model: string,
  promptVersion: string,
): Calibration | null {
  const row = db
    .prepare(
      `SELECT * FROM calibrations WHERE model = ? AND prompt_version = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(model, promptVersion) as Record<string, unknown> | undefined;
  if (!row) return null;
  return CalibrationSchema.parse({
    status: row.status,
    reasons: JSON.parse(row.reasons_json as string),
    model: row.model,
    promptVersion: row.prompt_version,
    evalCreatedAt: row.eval_created_at,
    categoryAccuracy: row.category_accuracy,
    inflationRate: row.inflation_rate,
    goldenCases: row.golden_cases,
    seedCases: row.seed_cases,
    createdAt: row.created_at,
  });
}
