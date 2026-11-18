#!/usr/bin/env -S npx tsx
import { pathToFileURL } from 'node:url';
import { COMMANDS, isCommandName, type CommandName } from './commands.ts';
import { loadConfig, loadDotEnv } from './config.ts';

const USAGE = `Usage: nrs <command> [options]

Commands:
  ${Object.keys(COMMANDS).join(' | ')}

seed options:
  --seed <n>          random seed (default 42)
  --customers <n>     (default 500)
  --interactions <n>  approximate total (default 3000)
  --days <n>          length of the data period (default 60)
  --end <iso date>    end of the data period (default 2026-11-15)
  --demo-scores       also fill scores from the answer key (model "demo-answer-key"),
                      so the dashboard can be shown without an API key

score / link options:
  --limit <n>         judge at most n new items (cheap test runs)

aggregate / drivers options:
  --from YYYY-MM-DD --to YYYY-MM-DD   inclusive UTC dates
                      (default: the 30 days ending on the latest interaction)`;

/**
 * Runs `nrs <command> ...`. With `defaultCommand`, a missing command or leading flags
 * run that command instead: `npm run pipeline -- --limit 20` means `all --limit 20`.
 */
export async function main(
  argv: string[],
  opts: { defaultCommand?: CommandName } = {},
): Promise<number> {
  const args = argv.filter((a) => a !== '--');
  let [name, ...rest] = args;
  if (name === '-h' || name === '--help') {
    console.log(USAGE);
    return 0;
  }
  if (opts.defaultCommand && (!name || name.startsWith('-'))) {
    name = opts.defaultCommand;
    rest = args;
  }
  if (!name) {
    console.log(USAGE);
    return 1;
  }
  if (!isCommandName(name)) {
    console.error(`Unknown command: ${name}\n\n${USAGE}`);
    return 1;
  }
  loadDotEnv();
  await COMMANDS[name]({ config: loadConfig(), log: (m) => console.log(m) }, rest);
  return 0;
}

export function runCli(argv: string[], opts: { defaultCommand?: CommandName } = {}): void {
  main(argv, opts).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2));
}
