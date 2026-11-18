import {
  decideLink,
  findReturnCandidates,
  linkFlags,
  LinkerOutputSchema,
  ScoredInteractionSchema,
  type Channel,
  type LinkableInteraction,
  type LinkerOutput,
  type LinkFlag,
  type LinkStatus,
  type ReturnWindowConfig,
  type TokenUsage,
} from '@nrs/core';
import type { Db } from '../db.ts';
import type { RedactedTranscript } from '../redact/redact.ts';
import { loadScoringInputs } from '../score/inputs.ts';
import type { LlmClient } from '../score/llm.ts';
import { mapWithConcurrency } from '../score/pool.ts';
import { addUsage, estimateCostUsd, ZERO_USAGE } from '../score/pricing.ts';
import { judgePair, linkCacheKey, type LinkerSettings, type LinkPair } from './linker.ts';

export interface LinkRunOptions extends LinkerSettings {
  concurrency: number;
  /** Judge at most this many new candidate pairs (cheap test runs). */
  limit?: number | undefined;
  window: ReturnWindowConfig;
  /** Which scores decide "resolved = yes" for A. */
  scorer: { model: string; promptVersion: string };
  threshold?: number;
  now?: () => Date;
}

export interface LinkRunSummary {
  runId: number;
  candidates: number;
  evaluated: number;
  cached: number;
  confirmed: number;
  unconfirmed: number;
  rejected: number;
  failed: number;
  /** A → detractor (false_resolution). */
  reclassified: number;
  /** B promoter → passive (repeat_contact). */
  repeatContacts: number;
  usage: TokenUsage;
  estCostUsd: number | null;
}

export const FALSE_RESOLUTION = 'false_resolution';
export const REPEAT_CONTACT = 'repeat_contact';
const SOURCE = 'link';

/** Every interaction with its scorer verdict (null when unscored or unparseable). */
function loadLinkable(db: Db, scorer: LinkRunOptions['scorer']): LinkableInteraction[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.customer_id, i.business_line, i.channel, i.started_at, s.json
       FROM interactions i
       LEFT JOIN scores s ON s.interaction_id = i.id AND s.model = ? AND s.prompt_version = ?
                          AND s.status = 'scored'`,
    )
    .all(scorer.model, scorer.promptVersion) as {
    id: string;
    customer_id: string;
    business_line: string;
    channel: Channel;
    started_at: string;
    json: string | null;
  }[];
  return rows.map((r) => {
    const score = r.json ? ScoredInteractionSchema.safeParse(JSON.parse(r.json)) : null;
    return {
      interactionId: r.id,
      customerId: r.customer_id,
      businessLine: r.business_line,
      channel: r.channel,
      startedAt: r.started_at,
      resolved: score?.success ? score.data.output.resolved : null,
      category: score?.success ? score.data.category : null,
    };
  });
}

function getCached(db: Db, key: string): LinkerOutput | null {
  const json = db
    .prepare('SELECT output_json FROM link_cache WHERE cache_key = ?')
    .pluck()
    .get(key) as string | undefined;
  if (!json) return null;
  const parsed = LinkerOutputSchema.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : null;
}

/**
 * Stage 1 finds (A, B) candidates deterministically; stage 2 asks the LLM whether B is
 * about the same goal. Confirmed links reclassify A as a detractor (false_resolution) in
 * the reclassifications table. Score rows are never modified. Logs ids and counts only.
 */
export async function runLinking(
  db: Db,
  client: LlmClient,
  opts: LinkRunOptions,
  log: (msg: string) => void,
): Promise<LinkRunSummary> {
  const now = opts.now ?? (() => new Date());
  const { model, prompt } = opts;

  const linkable = loadLinkable(db, opts.scorer);
  const byId = new Map(linkable.map((i) => [i.interactionId, i]));
  const reclassified = new Set(
    db
      .prepare('SELECT interaction_id FROM reclassifications WHERE reason = ? AND source = ?')
      .pluck()
      .all(FALSE_RESOLUTION, SOURCE) as string[],
  );
  const judged = new Set(
    db
      .prepare(
        `SELECT a_interaction_id || '|' || b_interaction_id FROM links
           WHERE model = ? AND prompt_version = ? AND status != 'link_failed'`,
      )
      .pluck()
      .all(model, prompt.version) as string[],
  );

  const all = findReturnCandidates(linkable, opts.window).filter(
    (c) =>
      !reclassified.has(c.a.interactionId) &&
      !judged.has(`${c.a.interactionId}|${c.b.interactionId}`),
  );

  // Transcripts come only through the redaction gate.
  const transcripts = new Map<string, RedactedTranscript>(
    loadScoringInputs(db).map((i) => [i.interactionId, i.transcript]),
  );
  const ready: LinkPair[] = [];
  let unredacted = 0;
  for (const candidate of all) {
    const aTranscript = transcripts.get(candidate.a.interactionId);
    const bTranscript = transcripts.get(candidate.b.interactionId);
    if (aTranscript && bTranscript) ready.push({ candidate, aTranscript, bTranscript });
    else unredacted++;
  }
  const pairs = opts.limit === undefined ? ready : ready.slice(0, opts.limit);

  const runId = Number(
    db
      .prepare(
        `INSERT INTO link_runs (model, prompt_version, started_at, candidates) VALUES (?, ?, ?, ?)`,
      )
      .run(model, prompt.version, now().toISOString(), pairs.length).lastInsertRowid,
  );
  log(
    `[link] run ${runId}: ${pairs.length} candidate pairs to judge` +
      (ready.length > pairs.length ? ` (--limit; ${ready.length} pending)` : '') +
      (unredacted ? `, ${unredacted} skipped (not redacted yet)` : '') +
      `, model ${model}, prompt ${prompt.version}`,
  );

  const upsertLink = db.prepare(
    `INSERT INTO links (a_interaction_id, b_interaction_id, customer_id, gap_days, window_days, model,
       prompt_version, status, same_goal, confidence, why, detail, flags_json, run_id, created_at)
     VALUES (@a, @b, @customer, @gap, @window, @model, @prompt, @status, @same, @confidence, @why,
       @detail, @flags, @run, @at)
     ON CONFLICT (a_interaction_id, b_interaction_id, model, prompt_version) DO UPDATE SET
       status = excluded.status, same_goal = excluded.same_goal, confidence = excluded.confidence,
       why = excluded.why, detail = excluded.detail, flags_json = excluded.flags_json,
       run_id = excluded.run_id, created_at = excluded.created_at`,
  );
  const putCache = db.prepare(
    `INSERT OR REPLACE INTO link_cache (cache_key, model, prompt_version, output_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const s = {
    evaluated: 0,
    cached: 0,
    confirmed: 0,
    unconfirmed: 0,
    rejected: 0,
    failed: 0,
    reclassified: 0,
    repeatContacts: 0,
    usage: ZERO_USAGE,
  };

  const judgeOne = async (p: LinkPair) => {
    const { a, b, gapDays, windowDays } = p.candidate;
    const row = {
      a: a.interactionId,
      b: b.interactionId,
      customer: a.customerId,
      gap: Math.round(gapDays * 1000) / 1000,
      window: windowDays,
      model,
      prompt: prompt.version,
      run: runId,
      at: now().toISOString(),
    };
    const key = linkCacheKey(p, opts);
    let output = getCached(db, key);
    if (output) {
      s.cached++;
    } else {
      const result = await judgePair(client, p, opts);
      s.usage = addUsage(s.usage, result.usage);
      if (!result.ok) {
        s.failed++;
        upsertLink.run({
          ...row,
          status: 'link_failed',
          same: null,
          confidence: null,
          why: null,
          detail: `${result.reason}: ${result.detail}`,
          flags: '[]',
        });
        log(`[link] ${a.interactionId} → ${b.interactionId} link_failed: ${result.reason}`);
        return;
      }
      output = result.output;
      putCache.run(key, model, prompt.version, JSON.stringify(output), now().toISOString());
    }
    s.evaluated++;
    const status: LinkStatus = decideLink(output, opts.threshold);
    s[status === 'link_failed' ? 'failed' : status]++;
    upsertLink.run({
      ...row,
      status,
      same: output.same_goal ? 1 : 0,
      confidence: output.confidence,
      why: output.why,
      detail: null,
      flags: JSON.stringify(status === 'rejected' ? [] : linkFlags(a.channel, b.channel)),
    });
  };

  const finish = (error: string | null) => {
    const cost = estimateCostUsd(model, s.usage);
    db.prepare(
      `UPDATE link_runs SET finished_at = ?, evaluated = ?, cached = ?, confirmed = ?, unconfirmed = ?,
         rejected = ?, failed = ?, reclassified = ?, repeat_contacts = ?, input_tokens = ?, output_tokens = ?,
         cache_read_tokens = ?, cache_write_tokens = ?, est_cost_usd = ?, error = ?
       WHERE id = ?`,
    ).run(
      now().toISOString(),
      s.evaluated,
      s.cached,
      s.confirmed,
      s.unconfirmed,
      s.rejected,
      s.failed,
      s.reclassified,
      s.repeatContacts,
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
    await mapWithConcurrency(pairs, opts.concurrency, judgeOne);
  } catch (err) {
    const e = err as { name?: string; status?: number };
    finish([e.name ?? 'Error', e.status].filter(Boolean).join(' '));
    log(`[link] run ${runId} aborted`);
    throw err;
  }

  const r = reclassifyConfirmed(db, byId, model, prompt.version, now, log);
  s.reclassified = r.falseResolutions;
  s.repeatContacts = r.repeatContacts;
  const estCostUsd = finish(null);

  const n = (x: number) => x.toLocaleString('en-US');
  log(
    `[link] run ${runId} done: ${s.evaluated} judged (${s.cached} from cache): ${s.confirmed} confirmed, ` +
      `${s.unconfirmed} unconfirmed (< threshold), ${s.rejected} different goal, ${s.failed} failed; ` +
      `${s.reclassified} reclassified as false_resolution, ${s.repeatContacts} return contacts capped at passive`,
  );
  log(
    `[link] tokens: input ${n(s.usage.inputTokens)}, output ${n(s.usage.outputTokens)}, ` +
      `cache read ${n(s.usage.cacheReadTokens)}, cache write ${n(s.usage.cacheWriteTokens)}; ` +
      `est. cost ${estCostUsd === null ? `unknown (no price for ${model})` : `$${estCostUsd.toFixed(4)}`}`,
  );

  return { runId, candidates: pairs.length, ...s, estCostUsd };
}

/**
 * Turns confirmed links into reclassifications. Score rows are never edited.
 * - A → detractor, reason false_resolution: the customer came back about the same goal.
 *   One row per A, pointing at the earliest confirmed return; flags union across all
 *   confirmed returns, so an AI "resolution" later finished by a human is flagged even if
 *   an AI retry came first.
 * - B (the return contact) promoter → passive, reason repeat_contact: it can't be
 *   "resolved on first try". B that isn't a promoter needs no row; B not yet scored is
 *   picked up on a later run.
 */
function reclassifyConfirmed(
  db: Db,
  byId: Map<string, LinkableInteraction>,
  model: string,
  promptVersion: string,
  now: () => Date,
  log: (msg: string) => void,
): { falseResolutions: number; repeatContacts: number } {
  const confirmedWithout = (side: 'a' | 'b', reason: string, order: string) =>
    db
      .prepare(
        `SELECT l.id, l.a_interaction_id AS a, l.b_interaction_id AS b, l.gap_days AS gap,
                l.flags_json AS flags
         FROM links l JOIN interactions bi ON bi.id = l.b_interaction_id
         WHERE l.status = 'confirmed' AND l.model = ? AND l.prompt_version = ?
           AND NOT EXISTS (SELECT 1 FROM reclassifications r
                           WHERE r.interaction_id = l.${side}_interaction_id
                             AND r.reason = ? AND r.source = ?)
         ORDER BY ${order}`,
      )
      .all(model, promptVersion, reason, SOURCE) as {
      id: number;
      a: string;
      b: string;
      gap: number;
      flags: string;
    }[];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO reclassifications
       (interaction_id, from_category, to_category, reason, source, created_at, link_id, flags_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let falseResolutions = 0;
  let repeatContacts = 0;
  db.transaction(() => {
    const forA = confirmedWithout('a', FALSE_RESOLUTION, 'l.a_interaction_id, bi.started_at');
    for (const [a, links] of Map.groupBy(forA, (l) => l.a)) {
      const from = byId.get(a)?.category;
      if (!from || from === 'detractor') continue;
      const first = links[0]!;
      const flags = [...new Set(links.flatMap((l) => JSON.parse(l.flags) as LinkFlag[]))].sort();
      const at = now().toISOString();
      insert.run(
        a,
        from,
        'detractor',
        FALSE_RESOLUTION,
        SOURCE,
        at,
        first.id,
        JSON.stringify(flags),
      );
      falseResolutions++;
      log(
        `[link] ${a} ${from} → detractor (false_resolution; returned after ${first.gap.toFixed(1)}d as ${first.b}` +
          (flags.length ? `; ${flags.join(', ')}` : '') +
          ')',
      );
    }

    const forB = confirmedWithout('b', REPEAT_CONTACT, 'l.b_interaction_id, l.id');
    for (const [b, links] of Map.groupBy(forB, (l) => l.b)) {
      if (byId.get(b)?.category !== 'promoter') continue;
      const first = links[0]!;
      insert.run(
        b,
        'promoter',
        'passive',
        REPEAT_CONTACT,
        SOURCE,
        now().toISOString(),
        first.id,
        '[]',
      );
      repeatContacts++;
      log(`[link] ${b} promoter → passive (repeat_contact; return of ${first.a})`);
    }
  })();
  return { falseResolutions, repeatContacts };
}
