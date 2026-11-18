import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { REPO_ROOT, resolveFromRoot } from './paths.ts';

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  RETURN_WINDOW_DAYS: z.coerce.number().int().positive().default(7),
  SCORING_CONCURRENCY: z.coerce.number().int().positive().default(5),
  NRS_DB_PATH: z.string().default('data/nrs.db'),
});

export interface Config {
  anthropicApiKey: string | undefined;
  /** Never hardcoded; read from ANTHROPIC_MODEL. Use requireModel() where scoring needs it. */
  anthropicModel: string | undefined;
  returnWindowDays: number;
  scoringConcurrency: number;
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
    scoringConcurrency: parsed.SCORING_CONCURRENCY,
    dbPath: resolveFromRoot(parsed.NRS_DB_PATH),
  };
}

export function requireModel(config: Config): string {
  if (!config.anthropicModel) throw new Error('ANTHROPIC_MODEL is not set. See .env.example.');
  return config.anthropicModel;
}
