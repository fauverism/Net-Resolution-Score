import {
  enforceCategory,
  ScoreRecordSchema,
  type ScoreFlag,
  type ScoreRecord,
  type ScorerOutput,
  type TokenUsage,
} from '@nrs/core';
import type { Db } from '../db.ts';
import { cacheKey, getCached, putCached } from './cache.ts';
import { matchEvidence } from './evidence.ts';
import { loadScoringInputs, type ScoringInput } from './inputs.ts';
import { mapWithConcurrency } from './pool.ts';
import { addUsage, estimateCostUsd, ZERO_USAGE } from './pricing.ts';
import { scoreInteraction, type ScorerClient, type ScorerSettings } from './scorer.ts';

export interface ScoringRunOptions extends ScorerSettings {
  concurrency: number;
  /** Score at most this many unscored interactions (cheap test runs). */
  limit?: number | undefined;
  now?: () => Date;
}

export interface ScoringRunSummary {
  runId: number;
  requested: number;
  scored: number;
  cached: number;
  failed: number;
  lowered: number;
  flagged: number;
  usage: TokenUsage;
  estCostUsd: number | null;
}

/** Interactions with no successful score yet for this model + prompt version. */
function pendingInputs(db: Db, model: string, promptVersion: string): ScoringInput[] {
  const done = new Set(
    db
      .prepare(
        `SELECT interaction_id FROM scores WHERE model = ? AND prompt_version = ? AND status = 'scored'`,
      )
      .pluck()
      .all(model, promptVersion) as string[],
  );
  return loadScoringInputs(db).filter((i) => !done.has(i.interactionId));
}

function postProcess(input: ScoringInput, output: ScorerOutput) {
  const { category, override } = enforceCategory(output);
  const flags: ScoreFlag[] = [];
  if (override) flags.push('category_lowered');
  const evidence = matchEvidence(output.evidence, input.transcript);
  if (evidence === 'not_found') flags.push('evidence_unverified');
  if (evidence === 'agent_only') flags.push('evidence_not_from_customer');
  if (output.channel !== input.channel) flags.push('channel_mismatch');
  return { category, override, flags };
}

/**
 * Scores every redacted, not-yet-scored interaction. Logs ids, categories and counts;
 * never transcript text, evidence quotes or goals.
 */
export async function runScoring(
  db: Db,
  client: ScorerClient,
  opts: ScoringRunOptions,
  log: (msg: string) => void,
): Promise<ScoringRunSummary> {
  const now = opts.now ?? (() => new Date());
  const { model, prompt } = opts;
  const all = pendingInputs(db, model, prompt.version);
  const inputs = opts.limit === undefined ? all : all.slice(0, opts.limit);

  const runId = Number(
    db
      .prepare(
        `INSERT INTO score_runs (model, prompt_version, started_at, requested) VALUES (?, ?, ?, ?)`,
      )
      .run(model, prompt.version, now().toISOString(), inputs.length).lastInsertRowid,
  );
  log(
    `[score] run ${runId}: ${inputs.length} to score` +
      (all.length > inputs.length ? ` (--limit; ${all.length} pending)` : '') +
      `, model ${model}, prompt ${prompt.version}, concurrency ${opts.concurrency}`,
  );

  const upsert = db.prepare(
    `INSERT INTO scores (interaction_id, json, model, prompt_version, scored_at, status, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (interaction_id, model, prompt_version) DO UPDATE SET
       json = excluded.json, scored_at = excluded.scored_at,
       status = excluded.status, run_id = excluded.run_id`,
  );
  const save = (r: ScoreRecord) => {
    ScoreRecordSchema.parse(r);
    upsert.run(
      r.interactionId,
      JSON.stringify(r),
      r.model,
      r.promptVersion,
      r.scoredAt,
      r.status,
      runId,
    );
  };

  const s = { scored: 0, cached: 0, failed: 0, lowered: 0, flagged: 0, usage: ZERO_USAGE, done: 0 };

  const scoreOne = async (input: ScoringInput) => {
    const key = cacheKey(input.transcript, prompt, model);
    const meta = {
      interactionId: input.interactionId,
      channel: input.channel,
      businessLine: input.businessLine,
      model,
      promptVersion: prompt.version,
    };

    let output = getCached(db, key);
    let attempts = 0;
    let retried = false;
    let usage = ZERO_USAGE;
    if (output) {
      s.cached++;
    } else {
      const result = await scoreInteraction(client, input, opts);
      s.usage = addUsage(s.usage, result.usage);
      attempts = result.attempts;
      usage = result.usage;
      if (!result.ok) {
        s.failed++;
        save({
          ...meta,
          status: 'score_failed',
          reason: result.reason,
          detail: result.detail,
          attempts,
          usage,
          scoredAt: now().toISOString(),
        });
        log(`[score] ${input.interactionId} score_failed: ${result.reason}`);
        return;
      }
      output = result.output;
      retried = result.retried;
      putCached(db, key, output, prompt, model, now());
    }

    const { category, override, flags } = postProcess(input, output);
    if (retried) flags.push('retried');
    if (override) {
      s.lowered++;
      log(
        `[score] ${input.interactionId} lowered ${override.from} → ${override.to} (${override.reasons.join(', ')})`,
      );
    }
    if (flags.some((f) => f.startsWith('evidence_') || f === 'channel_mismatch')) s.flagged++;
    s.scored++;
    save({
      ...meta,
      status: 'scored',
      output,
      category,
      override,
      flags,
      cacheKey: key,
      cached: attempts === 0,
      attempts,
      usage,
      scoredAt: now().toISOString(),
    });
  };

  const finish = (error: string | null) => {
    const cost = estimateCostUsd(model, s.usage);
    db.prepare(
      `UPDATE score_runs SET finished_at = ?, scored = ?, cached = ?, failed = ?, lowered = ?, flagged = ?,
         input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
         est_cost_usd = ?, error = ?
       WHERE id = ?`,
    ).run(
      now().toISOString(),
      s.scored,
      s.cached,
      s.failed,
      s.lowered,
      s.flagged,
      s.usage.inputTokens,
      s.usage.outputTokens,
      s.usage.cacheReadTokens,
      s.usage.cacheWriteTokens,
      cost,
      error,
      runId,
    );
    return cost;
  };

  try {
    await mapWithConcurrency(inputs, opts.concurrency, async (input) => {
      try {
        await scoreOne(input);
      } finally {
        if (++s.done % 100 === 0) log(`[score] ${s.done}/${inputs.length}`);
      }
    });
  } catch (err) {
    // Non-retryable API error (auth, bad request, unknown model) or a bug: record and stop.
    const e = err as { name?: string; status?: number };
    finish([e.name ?? 'Error', e.status].filter(Boolean).join(' '));
    log(`[score] run ${runId} aborted after ${s.done}/${inputs.length}`);
    throw err;
  }
  const estCostUsd = finish(null);

  const n = (x: number) => x.toLocaleString('en-US');
  log(
    `[score] run ${runId} done: ${s.scored} scored (${s.cached} from cache), ${s.failed} failed, ` +
      `${s.lowered} lowered, ${s.flagged} flagged`,
  );
  log(
    `[score] tokens: input ${n(s.usage.inputTokens)}, output ${n(s.usage.outputTokens)}, ` +
      `cache read ${n(s.usage.cacheReadTokens)}, cache write ${n(s.usage.cacheWriteTokens)}; ` +
      `est. cost ${estCostUsd === null ? `unknown (no price for ${model})` : `$${estCostUsd.toFixed(4)}`}`,
  );

  return {
    runId,
    requested: inputs.length,
    scored: s.scored,
    cached: s.cached,
    failed: s.failed,
    lowered: s.lowered,
    flagged: s.flagged,
    usage: s.usage,
    estCostUsd,
  };
}
