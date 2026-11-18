import {
  AI_SUGGESTED,
  batchGoals,
  DriversReportSchema,
  finalCategory,
  normalizeGoal,
  periodFromDates,
  rankClusters,
  type DriverInput,
  type DriversReport,
  type RankedCluster,
  type TokenUsage,
} from '@nrs/core';
import { loadPeriodScores } from '../aggregate/load.ts';
import type { Db } from '../db.ts';
import { redact } from '../redact/redact.ts';
import type { LlmClient } from '../score/llm.ts';
import { addUsage, estimateCostUsd, ZERO_USAGE } from '../score/pricing.ts';
import type { ScorerPrompt } from '../score/prompt.ts';
import {
  labelBatch,
  suggestFixes,
  type DriverLlmSettings,
  type Suggestion,
  type SuggestInput,
} from './llm.ts';

export interface DriversOptions extends DriverLlmSettings {
  /** Inclusive YYYY-MM-DD dates (UTC). */
  from: string;
  to: string;
  /** Which scores decide the detractors. */
  scorerPromptVersion: string;
  clusterPrompt: ScorerPrompt;
  suggestPrompt: ScorerPrompt;
  batchSize?: number;
  topN?: number;
}

const UNVERIFIED = new Set(['evidence_unverified', 'evidence_not_from_customer']);

/** Final-category detractors with a scorer output; failed scores are only counted. */
function loadDetractors(db: Db, o: DriversOptions, start: string, end: string) {
  const inputs: DriverInput[] = [];
  let unclusterable = 0;
  const rows = loadPeriodScores(db, start, end, o.model, o.scorerPromptVersion);
  for (const { score, reclassifications } of rows) {
    if (!score || finalCategory(score, reclassifications) !== 'detractor') continue;
    if (score.status !== 'scored') {
      unclusterable++;
      continue;
    }
    inputs.push({
      interactionId: score.interactionId,
      channel: score.channel,
      businessLine: score.businessLine,
      // Model output about redacted transcripts, so already redacted; redact again anyway.
      customerGoal: redact(score.output.customer_goal).text,
      evidence: redact(score.output.evidence).text,
      evidenceVerified: !score.flags.some((f) => UNVERIFIED.has(f)),
      resolved: score.output.resolved,
      abandoned: score.output.abandoned,
      falseResolution: reclassifications.some((r) => r.reason === 'false_resolution'),
    });
  }
  return { inputs, unclusterable };
}

/** Up to 8 distinct goals and 5 distinct quotes (verified first) for the suggestion prompt. */
function examples(cluster: RankedCluster, inputs: readonly DriverInput[]): SuggestInput {
  const ids = new Set(cluster.interactionIds);
  const members = inputs.filter((i) => ids.has(i.interactionId));
  const goals = [
    ...new Map(members.map((m) => [normalizeGoal(m.customerGoal), m.customerGoal])).values(),
  ].slice(0, 8);
  const quotes = [...members]
    .sort(
      (a, b) =>
        Number(b.evidenceVerified) - Number(a.evidenceVerified) ||
        a.interactionId.localeCompare(b.interactionId),
    )
    .map((m) => m.evidence)
    .filter((q, i, all) => all.indexOf(q) === i)
    .slice(0, 5);
  return { cluster, goals, quotes };
}

/**
 * Clusters the period's detractors by customer goal, ranks clusters by volume × severity,
 * and adds an AI-suggested driver, fix and owner for the top 3. Saves to driver_runs.
 */
export async function runDrivers(
  db: Db,
  client: LlmClient,
  o: DriversOptions,
  log: (msg: string) => void,
): Promise<{ runId: number; report: DriversReport }> {
  const period = periodFromDates(o.from, o.to);
  const { inputs, unclusterable } = loadDetractors(db, o, period.periodStart, period.periodEnd);
  const totalDetractors = inputs.length + unclusterable;

  const runId = Number(
    db
      .prepare(
        `INSERT INTO driver_runs (period_start, period_end, model, cluster_prompt_version,
           suggest_prompt_version, started_at, detractors) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        period.periodStart,
        period.periodEnd,
        o.model,
        o.clusterPrompt.version,
        o.suggestPrompt.version,
        new Date().toISOString(),
        totalDetractors,
      ).lastInsertRowid,
  );
  log(
    `[drivers] run ${runId}: ${o.from} → ${o.to}, ${totalDetractors} detractors, model ${o.model}`,
  );

  let usage: TokenUsage = ZERO_USAGE;
  let calls = 0;
  const finish = (report: DriversReport | null, clusters: number, error: string | null) =>
    db
      .prepare(
        `UPDATE driver_runs SET finished_at = ?, clusters = ?, llm_calls = ?, input_tokens = ?,
           output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, est_cost_usd = ?,
           error = ?, report_json = ? WHERE id = ?`,
      )
      .run(
        new Date().toISOString(),
        clusters,
        calls,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.cacheWriteTokens,
        estimateCostUsd(o.model, usage),
        error,
        report ? JSON.stringify(report) : null,
        runId,
      );

  try {
    // 1. Label goals batch by batch. Sequential, so each batch sees the labels so far.
    const labelOf = new Map<string, string>();
    const labels: string[] = [];
    const goals = inputs.map((i) => i.customerGoal);
    for (const batch of batchGoals(goals, o.batchSize ?? 50)) {
      const r = await labelBatch(db, client, o, o.clusterPrompt, batch, labels);
      usage = addUsage(usage, r.usage);
      calls += r.calls;
      if (!r.labels) {
        log(
          `[drivers] a batch of ${batch.length} goals couldn't be labeled; left out of the ranking`,
        );
        continue;
      }
      for (const [goal, label] of r.labels) {
        labelOf.set(normalizeGoal(goal), label);
        if (!labels.includes(label)) labels.push(label);
      }
    }

    // 2. Rank clusters by volume × severity.
    const labeled = inputs.filter((i) => labelOf.has(normalizeGoal(i.customerGoal)));
    const ranked = rankClusters(labeled, (g) => labelOf.get(normalizeGoal(g))!, totalDetractors);
    const top = ranked.slice(0, o.topN ?? 3);

    // 3. AI-suggested driver sentence, fix and owner for the top clusters.
    let suggestions: Suggestion[] | null = null;
    if (top.length) {
      const r = await suggestFixes(
        db,
        client,
        o,
        o.suggestPrompt,
        top.map((c) => examples(c, inputs)),
      );
      usage = addUsage(usage, r.usage);
      calls += r.calls;
      suggestions = r.suggestions;
      if (!suggestions)
        log('[drivers] suggestion call failed; top drivers saved without fixes or owners');
    }

    const report = DriversReportSchema.parse({
      version: 1,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      source: {
        model: o.model,
        scorerPromptVersion: o.scorerPromptVersion,
        clusterPromptVersion: o.clusterPrompt.version,
        suggestPromptVersion: o.suggestPrompt.version,
      },
      counts: {
        detractors: totalDetractors,
        clustered: labeled.length,
        unclusterable,
        labelingFailed: inputs.length - labeled.length,
        clusters: ranked.length,
      },
      top: top.map(({ interactionIds: _ids, ...c }, i) => {
        const s = suggestions?.[i];
        return {
          ...c,
          rank: i + 1,
          driver: s?.driver ?? c.label,
          suggestedFix: s ? { value: s.suggested_fix, source: AI_SUGGESTED } : null,
          suggestedOwner: s ? { value: s.suggested_owner, source: AI_SUGGESTED } : null,
        };
      }),
      others: ranked.slice(top.length).map(({ label, volume, score, pctOfDetractors }) => ({
        label,
        volume,
        score,
        pctOfDetractors,
      })),
    } satisfies DriversReport);

    finish(report, ranked.length, null);
    logDrivers(runId, report, usage, o.model, log);
    return { runId, report };
  } catch (err) {
    const e = err as { name?: string; status?: number };
    finish(null, 0, [e.name ?? 'Error', e.status].filter(Boolean).join(' '));
    log(`[drivers] run ${runId} aborted`);
    throw err;
  }
}

function logDrivers(
  runId: number,
  r: DriversReport,
  usage: TokenUsage,
  model: string,
  log: (msg: string) => void,
): void {
  const c = r.counts;
  log(
    `[drivers] ${c.detractors} detractors → ${c.clusters} clusters` +
      (c.unclusterable ? `, ${c.unclusterable} failed scores not clustered` : '') +
      (c.labelingFailed ? `, ${c.labelingFailed} not labeled` : ''),
  );
  for (const d of r.top) {
    const mix = Object.entries(d.channelMix)
      .filter(([, m]) => m.n > 0)
      .map(([ch, m]) => `${ch} ${m.pct}%`)
      .join(', ');
    log(`[drivers] #${d.rank} ${d.driver}`);
    log(
      `[drivers]    ${d.pctOfDetractors}% of detractors (n ${d.volume}, score ${d.score})` +
        `${d.warning ? ` [${d.warning}]` : ''}; channels: ${mix}`,
    );
    if (d.representative) log(`[drivers]    quote (redacted): "${d.representative.quote}"`);
    log(`[drivers]    fix (${AI_SUGGESTED}): ${d.suggestedFix?.value ?? 'unavailable'}`);
    log(`[drivers]    owner (${AI_SUGGESTED}): ${d.suggestedOwner?.value ?? 'unavailable'}`);
  }
  const cost = estimateCostUsd(model, usage);
  log(
    `[drivers] run ${runId} saved; tokens in ${usage.inputTokens}, out ${usage.outputTokens}; ` +
      `est. cost ${cost === null ? `unknown (no price for ${model})` : `$${cost.toFixed(4)}`}`,
  );
}
