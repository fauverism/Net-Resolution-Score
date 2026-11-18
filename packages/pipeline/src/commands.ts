import type { Config } from './config.ts';
import { migrate, openDb } from './db.ts';

export interface CommandContext {
  config: Config;
  log: (msg: string) => void;
}

export type Command = (ctx: CommandContext) => Promise<void>;

const notYet =
  (name: string): Command =>
  async ({ log }) => {
    log(`[${name}] not implemented yet`);
  };

/** Creates the db and applies migrations. Fixture loading comes later. */
const seed: Command = async ({ config, log }) => {
  const db = openDb(config.dbPath);
  try {
    const applied = migrate(db);
    log(`[seed] db: ${config.dbPath}`);
    log(applied.length ? `[seed] applied: ${applied.join(', ')}` : '[seed] schema up to date');
  } finally {
    db.close();
  }
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
    for (const stage of PIPELINE_STAGES) await COMMANDS[stage](ctx);
  },
} satisfies Record<string, Command>;

export type CommandName = keyof typeof COMMANDS;

export function isCommandName(name: string): name is CommandName {
  return Object.hasOwn(COMMANDS, name);
}
