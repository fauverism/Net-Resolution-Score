#!/usr/bin/env -S npx tsx
import { COMMANDS, isCommandName } from './commands.ts';
import { loadConfig, loadDotEnv } from './config.ts';

const USAGE = `Usage: nrs <command>

Commands:
  ${Object.keys(COMMANDS).join(' | ')}

seed options:
  --seed <n>          random seed (default 42)
  --customers <n>     (default 500)
  --interactions <n>  approximate total (default 3000)
  --days <n>          length of the data period (default 60)
  --end <iso date>    end of the data period (default 2026-11-15)`;

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv.filter((a) => a !== '--');
  if (!name || name === '-h' || name === '--help') {
    console.log(USAGE);
    return name ? 0 : 1;
  }
  if (!isCommandName(name)) {
    console.error(`Unknown command: ${name}\n\n${USAGE}`);
    return 1;
  }
  loadDotEnv();
  await COMMANDS[name]({ config: loadConfig(), log: (m) => console.log(m) }, rest);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
