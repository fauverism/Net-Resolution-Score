// `npm run pipeline [-- <command>] [options]`: runs one stage, or `all` by default.
import { runCli } from './cli.ts';

runCli(process.argv.slice(2), { defaultCommand: 'all' });
