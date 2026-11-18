import type Anthropic from '@anthropic-ai/sdk';
import {
  categoryCap,
  enforceCategory,
  ScoredInteractionSchema,
  type GroundTruthLabel,
  type ReturnWindowConfig,
} from '@nrs/core';
import { defaultPeriod } from '../aggregate/stage.ts';
import { runCalibrate } from '../calibrate/stage.ts';
import type { Db } from '../db.ts';
import { resolveFromRoot } from '../paths.ts';
import { DEFAULT_CLUSTER_PROMPT_VERSION, DEFAULT_SUGGEST_PROMPT_VERSION } from '../drivers/llm.ts';
import { runDrivers } from '../drivers/stage.ts';
import { DEFAULT_LINKER_PROMPT_VERSION } from '../link/linker.ts';
import { runLinking } from '../link/stage.ts';
import { runRedaction } from '../redact/stage.ts';
import type { LlmClient } from '../score/llm.ts';
import { DEFAULT_PROMPT_VERSION, loadPrompt } from '../score/prompt.ts';
import type { SeedData } from './generate.ts';

/**
 * Not a model. Demo scores are tagged with this name so they can never be mistaken for
 * real ones; the dashboard shows a "Demo data" banner for any model starting "demo-".
 */
export const DEMO_MODEL = 'demo-answer-key';

function message(
  text: string,
  stop: Anthropic.Message['stop_reason'] = 'end_turn',
): Anthropic.Message {
  return {
    id: 'demo',
    type: 'message',
    role: 'assistant',
    model: DEMO_MODEL,
    content: [{ type: 'text', text, citations: null }],
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  } as unknown as Anthropic.Message;
}

/**
 * A local stand-in for the model that answers from the seed's answer key, so the real
 * link and drivers code runs without network calls:
 * - link: "same goal" means the same planted journey.
 * - drivers: each goal's cluster is its own goal summary; fix/owner suggestions are left
 *   empty rather than invented.
 */
function answerKeyClient(db: Db, labels: readonly GroundTruthLabel[]): LlmClient {
  const byId = new Map(labels.map((l) => [l.interactionId, l]));
  const idByTranscript = new Map(
    (
      db.prepare('SELECT interaction_id, transcript FROM redacted_transcripts').all() as {
        interaction_id: string;
        transcript: string;
      }[]
    ).map((r) => [r.transcript, r.interaction_id]),
  );
  const journey = (l: GroundTruthLabel): string =>
    l.previousInteractionId ? journey(byId.get(l.previousInteractionId)!) : l.interactionId;
  const between = (text: string, open: string, close: string) =>
    text.split(open)[1]!.split(close)[0]!;

  return {
    async create(params) {
      const text = params.messages[0]!.content as string;
      if (text.includes('<transcript_a>')) {
        const a = byId.get(
          idByTranscript.get(between(text, '<transcript_a>\n', '\n</transcript_a>'))!,
        )!;
        const b = byId.get(
          idByTranscript.get(between(text, '<transcript_b>\n', '\n</transcript_b>'))!,
        )!;
        const same = journey(a) === journey(b);
        return message(
          JSON.stringify({ same_goal: same, confidence: 0.95, why: 'Demo: from the answer key.' }),
        );
      }
      if (text.includes('Goals to label:')) {
        const goals = [...text.matchAll(/^(g\d+): (.*)$/gm)];
        return message(
          JSON.stringify({ assignments: goals.map(([, id, goal]) => ({ id, label: goal })) }),
        );
      }
      // Fix and owner suggestions: decline, so nothing is invented for the demo.
      return message('', 'refusal');
    },
  };
}

/**
 * Fills the db with demo scores from the seed's answer key (as a scorer following the
 * prompt would read each transcript), then runs the real link, drivers and calibrate
 * stages against them. View with ANTHROPIC_MODEL=demo-answer-key npm run dev.
 */
export async function writeDemoScores(
  db: Db,
  data: SeedData,
  window: ReturnWindowConfig,
  log: (msg: string) => void,
): Promise<void> {
  runRedaction(db, () => {});
  const insert = db.prepare(
    `INSERT OR REPLACE INTO scores (interaction_id, json, model, prompt_version, scored_at, status)
     VALUES (?, ?, ?, ?, ?, 'scored')`,
  );
  const redactedById = new Map(
    (
      db.prepare('SELECT interaction_id, transcript FROM redacted_transcripts').all() as {
        interaction_id: string;
        transcript: string;
      }[]
    ).map((r) => [r.interaction_id, r.transcript]),
  );
  db.transaction(() => {
    for (const l of data.groundTruth.labels) {
      const resolved = l.falseResolution ? 'partial' : l.resolved ? 'yes' : 'no';
      const facts = {
        resolved,
        effort: l.effort,
        asked_for_human: l.escalated,
        abandoned: l.abandoned,
      } as const;
      // The customer's opening line states the problem: the most telling quote. Taken from
      // the redacted transcript, as a real scorer would see it.
      const quote = redactedById
        .get(l.interactionId)!
        .split('\n')
        .find((t) => t.startsWith('Customer: '))!
        .slice('Customer: '.length);
      const output = {
        channel: l.channel,
        customer_goal: l.goal,
        sentiment_start: 0,
        sentiment_end: 0,
        evidence: quote,
        ...facts,
        category: categoryCap(facts).cap,
      };
      const record = ScoredInteractionSchema.parse({
        interactionId: l.interactionId,
        channel: l.channel,
        businessLine: l.businessLine,
        model: DEMO_MODEL,
        promptVersion: DEFAULT_PROMPT_VERSION,
        scoredAt: l.startedAt,
        attempts: 0,
        status: 'scored',
        output,
        ...enforceCategory(output),
        flags: [],
        cacheKey: 'demo',
        cached: false,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });
      insert.run(
        l.interactionId,
        JSON.stringify(record),
        DEMO_MODEL,
        DEFAULT_PROMPT_VERSION,
        l.startedAt,
      );
    }
  })();
  log(
    `[seed] demo scores: ${data.groundTruth.labels.length} (model "${DEMO_MODEL}", from the answer key)`,
  );

  const client = answerKeyClient(db, data.groundTruth.labels);
  const quiet = () => {};
  const link = await runLinking(
    db,
    client,
    {
      model: DEMO_MODEL,
      prompt: loadPrompt(DEFAULT_LINKER_PROMPT_VERSION),
      concurrency: 16,
      window,
      scorer: { model: DEMO_MODEL, promptVersion: DEFAULT_PROMPT_VERSION },
    },
    quiet,
  );
  log(
    `[seed] demo links: ${link.reclassified} false resolutions, ${link.repeatContacts} repeat contacts`,
  );

  const { from, to } = defaultPeriod(db);
  await runDrivers(
    db,
    client,
    {
      from,
      to,
      model: DEMO_MODEL,
      scorerPromptVersion: DEFAULT_PROMPT_VERSION,
      clusterPrompt: loadPrompt(DEFAULT_CLUSTER_PROMPT_VERSION),
      suggestPrompt: loadPrompt(DEFAULT_SUGGEST_PROMPT_VERSION),
    },
    quiet,
  );
  log(`[seed] demo drivers for ${from} → ${to} (no fix or owner suggestions in demo data)`);
  runCalibrate(
    db,
    {
      model: DEMO_MODEL,
      promptVersion: DEFAULT_PROMPT_VERSION,
      evalConfigPath: resolveFromRoot('evals/config.json'),
    },
    quiet,
  );
  log(`[seed] view it with: ANTHROPIC_MODEL=${DEMO_MODEL} npm run dev`);
}
