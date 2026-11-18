import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ReturnWindowConfig } from '@nrs/core';
import { z } from 'zod';
import { REPO_ROOT, resolveFromRoot } from './paths.ts';

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  RETURN_WINDOW_DAYS: z.coerce.number().int().positive().default(7),
  /** Per-business-line overrides: "billing=14,tech_support=5". */
  RETURN_WINDOW_DAYS_BY_LINE: z.string().optional(),
  SCORING_CONCURRENCY: z.coerce.number().int().positive().default(5),
  SCORING_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  NRS_DB_PATH: z.string().default('data/nrs.db'),
});

export interface Config {
  anthropicApiKey: string | undefined;
  /** Never hardcoded; read from ANTHROPIC_MODEL. Use requireModel() where scoring needs it. */
  anthropicModel: string | undefined;
  returnWindowDays: number;
  /** Default plus per-business-line overrides, for the link stage. */
  returnWindow: ReturnWindowConfig;
  scoringConcurrency: number;
  /** Optional effort for the scorer; unset uses the model's default. */
  scoringEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;
  dbPath: string;
}

/** Load repo-root .env into process.env if present (does not override existing vars). */
export function loadDotEnv(): void {
  const file = path.join(REPO_ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings (as in .env.example) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = EnvSchema.parse(cleaned);
  return {
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    anthropicModel: parsed.ANTHROPIC_MODEL,
    returnWindowDays: parsed.RETURN_WINDOW_DAYS,
    returnWindow: {
      defaultDays: parsed.RETURN_WINDOW_DAYS,
      byBusinessLine: parseWindowOverrides(parsed.RETURN_WINDOW_DAYS_BY_LINE),
    },
    scoringConcurrency: parsed.SCORING_CONCURRENCY,
    scoringEffort: parsed.SCORING_EFFORT,
    dbPath: resolveFromRoot(parsed.NRS_DB_PATH),
  };
}

export function requireModel(config: Config): string {
  if (!config.anthropicModel) throw new Error('ANTHROPIC_MODEL is not set. See .env.example.');
  return config.anthropicModel;
}

const OverrideSchema = z.tuple([
  z.string().regex(/^[a-z][a-z0-9_]*$/, 'business line must be snake_case'),
  z.coerce.number().int().positive(),
]);

/** Parses "billing=14,tech_support=5" into { billing: 14, tech_support: 5 }. */
export function parseWindowOverrides(raw: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (raw ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const parsed = OverrideSchema.safeParse(part.split('=').map((x) => x.trim()));
    if (!parsed.success) {
      throw new Error(`RETURN_WINDOW_DAYS_BY_LINE: invalid entry "${part}" (expected line=days)`);
    }
    out[parsed.data[0]] = parsed.data[1];
  }
  return out;
}
