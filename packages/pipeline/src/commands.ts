import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { requireModel, type Config } from './config.ts';
import { migrate, openDb } from './db.ts';
import { resolveFromRoot } from './paths.ts';
import { runRedaction } from './redact/index.ts';
import { DEFAULT_LINKER_PROMPT_VERSION, runLinking } from './link/index.ts';
import { DEFAULT_PROMPT_VERSION, loadPrompt } from './score/prompt.ts';
import { anthropicScorerClient } from './score/scorer.ts';
import { runScoring } from './score/stage.ts';
import { DEFAULT_GENERATE_OPTIONS, generate, summarize, writeSeed } from './seed/index.ts';

export const GROUND_TRUTH_PATH = 'data/fixtures/ground-truth.json';

export interface CommandContext {
  config: Config;
  log: (msg: string) => void;
}

export type Command = (ctx: CommandContext, args?: string[]) => Promise<void>;

const notYet =
  (name: string): Command =>
  async ({ log }) => {
    log(`[${name}] not implemented yet`);
  };

/**
 * Migrates the db and replaces its contents with reproducible synthetic data.
 * Hidden labels go to data/fixtures/ground-truth.json (never into the db).
 */
const seed: Command = async ({ config, log }, args = []) => {
  const d = DEFAULT_GENERATE_OPTIONS;
  const { values } = parseArgs({
    args,
    options: {
      seed: { type: 'string', default: String(d.seed) },
      customers: { type: 'string', default: String(d.customers) },
      interactions: { type: 'string', default: String(d.interactions) },
      days: { type: 'string', default: String(d.days) },
      end: { type: 'string', default: d.end.toISOString() },
    },
  });
  const int = (name: string, v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
    return n;
  };
  const end = new Date(values.end);
  if (Number.isNaN(end.getTime())) throw new Error('--end must be an ISO date');

  const data = generate({
    ...d,
    seed: int('seed', values.seed),
    customers: int('customers', values.customers),
    interactions: int('interactions', values.interactions),
    days: int('days', values.days),
    end,
    returnWindowDays: config.returnWindowDays,
  });

  const db = openDb(config.dbPath);
  try {
    const applied = migrate(db);
    if (applied.length) log(`[seed] applied migrations: ${applied.join(', ')}`);
    writeSeed(db, data, resolveFromRoot(GROUND_TRUTH_PATH));
  } finally {
    db.close();
  }
  log(`[seed] db: ${config.dbPath}`);
  log(`[seed] ground truth: ${GROUND_TRUTH_PATH}`);
  log(summarize(data));
};

const withDb =
  (fn: (db: ReturnType<typeof openDb>, ctx: CommandContext) => void): Command =>
  async (ctx) => {
    const db = openDb(ctx.config.dbPath);
    try {
      migrate(db);
      fn(db, ctx);
    } finally {
      db.close();
    }
  };

/** Must run before score: score only ever sees redacted transcripts. */
const redactStage = withDb((db, { log }) => {
  runRedaction(db, log);
});

/**
 * Scores redacted transcripts with the Anthropic API. `--limit N` caps how many
 * unscored interactions this run sends (cheap test runs).
 */
function parseLimit(args: string[]): number | undefined {
  const { values } = parseArgs({ args, options: { limit: { type: 'string' } }, strict: false });
  if (typeof values.limit !== 'string') return undefined;
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 0)
    throw new Error('--limit must be a non-negative integer');
  return limit;
}

const score: Command = async ({ config, log }, args = []) => {
  const limit = parseLimit(args);
  const model = requireModel(config); // fail fast before touching anything
  const db = openDb(config.dbPath);
  try {
    migrate(db);
    // Our own backoff handles 429/529, so turn off the SDK's built-in retries.
    const client = anthropicScorerClient(new Anthropic({ maxRetries: 0 }));
    await runScoring(
      db,
      client,
      {
        model,
        prompt: loadPrompt(),
        effort: config.scoringEffort,
        concurrency: config.scoringConcurrency,
        limit,
      },
      log,
    );
  } finally {
    db.close();
  }
};

/**
 * Finds false resolutions: deterministic (A, B) candidates within the return window,
 * confirmed by the LLM. `--limit N` caps how many new pairs this run judges.
 */
const link: Command = async ({ config, log }, args = []) => {
  const limit = parseLimit(args);
  const model = requireModel(config);
  const db = openDb(config.dbPath);
  try {
    migrate(db);
    await runLinking(
      db,
      anthropicScorerClient(new Anthropic({ maxRetries: 0 })),
      {
        model,
        prompt: loadPrompt(DEFAULT_LINKER_PROMPT_VERSION),
        effort: config.scoringEffort,
        concurrency: config.scoringConcurrency,
        limit,
        window: config.returnWindow,
        scorer: { model, promptVersion: DEFAULT_PROMPT_VERSION },
      },
      log,
    );
  } finally {
    db.close();
  }
};

/** Pipeline order for `all`. Seed is separate: it's a setup step, not a pipeline stage. */
export const PIPELINE_STAGES = [
  'ingest',
  'redact',
  'score',
  'link',
  'aggregate',
  'drivers',
] as const;

export const COMMANDS = {
  seed,
  ingest: notYet('ingest'),
  redact: redactStage,
  score,
  link,
  aggregate: notYet('aggregate'),
  drivers: notYet('drivers'),
  calibrate: notYet('calibrate'),
  // Flags go to the LLM stages, e.g. `npm run pipeline -- --limit 20`.
  all: async (ctx, args = []) => {
    for (const stage of PIPELINE_STAGES) {
      await COMMANDS[stage](ctx, stage === 'score' || stage === 'link' ? args : []);
    }
  },
} satisfies Record<string, Command>;

export type CommandName = keyof typeof COMMANDS;

export function isCommandName(name: string): name is CommandName {
  return Object.hasOwn(COMMANDS, name);
}
