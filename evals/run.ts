// npm run eval [-- --prompt scorer.v1 --prompt scorer.v2] [--sample N | --sample all] [--no-seed] [--no-golden]
// Scores the eval set with each prompt, writes evals/results/<timestamp>.json, prints a
// summary, and exits non-zero if any prompt is below the threshold in evals/config.json.
import Anthropic from '@anthropic-ai/sdk';
import { parseArgs } from 'node:util';
import {
  anthropicClient,
  DEFAULT_PROMPT_VERSION,
  loadConfig,
  loadDotEnv,
  loadPrompt,
  migrate,
  openDb,
  requireModel,
  resolveFromRoot,
} from '@nrs/pipeline';
import { loadGoldenCases, loadSeedCases } from './src/cases.ts';
import { loadEvalConfig } from './src/config.ts';
import { formatSummary, writeResults } from './src/report.ts';
import { runEval } from './src/runEval.ts';

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      prompt: { type: 'string', multiple: true },
      sample: { type: 'string' },
      'no-seed': { type: 'boolean' },
      'no-golden': { type: 'boolean' },
    },
  });

  loadDotEnv();
  const env = loadConfig();
  const model = requireModel(env);
  const cfg = loadEvalConfig(resolveFromRoot('evals/config.json'));
  const prompts = (values.prompt?.length ? values.prompt : [DEFAULT_PROMPT_VERSION]).map((v) =>
    loadPrompt(v),
  );

  let sample = cfg.seedSampleSize;
  if (values.sample === 'all') sample = null;
  else if (values.sample !== undefined) {
    sample = Number(values.sample);
    if (!Number.isInteger(sample) || sample < 1)
      throw new Error('--sample must be a positive integer or "all"');
  }

  const db = openDb(env.dbPath);
  try {
    migrate(db);
    const cases = [
      ...(values['no-seed'] ? [] : loadSeedCases(db, resolveFromRoot(cfg.groundTruthPath), sample)),
      ...(values['no-golden'] ? [] : loadGoldenCases(resolveFromRoot(cfg.goldenDir))),
    ];
    console.log(
      `[eval] ${cases.length} cases × ${prompts.length} prompt(s) (${prompts.map((p) => p.version).join(', ')}), ` +
        `model ${model}, concurrency ${env.scoringConcurrency}`,
    );
    const results = await runEval(anthropicClient(new Anthropic({ maxRetries: 0 })), cases, {
      model,
      prompts,
      concurrency: env.scoringConcurrency,
      threshold: cfg.categoryAccuracyThreshold,
      effort: env.scoringEffort,
      db,
    });
    const file = writeResults(resolveFromRoot(cfg.resultsDir), results);
    console.log(`\n${formatSummary(results)}\n\n[eval] results: ${file}`);
    return results.passed ? 0 : 1;
  } finally {
    db.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
