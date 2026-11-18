import { parseArgs } from 'node:util';
import type { Config } from './config.ts';
import { migrate, openDb } from './db.ts';
import { resolveFromRoot } from './paths.ts';
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

/** Pipeline order for `all`. Seed is separate: it's a setup step, not a pipeline stage. */
export const PIPELINE_STAGES = ['ingest', 'score', 'link', 'aggregate', 'drivers'] as const;

export const COMMANDS = {
  seed,
  ingest: notYet('ingest'),
  score: notYet('score'),
  link: notYet('link'),
  aggregate: notYet('aggregate'),
  drivers: notYet('drivers'),
  calibrate: notYet('calibrate'),
  all: async (ctx) => {
    for (const stage of PIPELINE_STAGES) await COMMANDS[stage](ctx, []);
  },
} satisfies Record<string, Command>;

export type CommandName = keyof typeof COMMANDS;

export function isCommandName(name: string): name is CommandName {
  return Object.hasOwn(COMMANDS, name);
}
