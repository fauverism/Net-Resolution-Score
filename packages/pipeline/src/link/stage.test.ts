import Anthropic from '@anthropic-ai/sdk';
import {
  ScoredInteractionSchema,
  type Category,
  type Channel,
  type ReturnWindowConfig,
  type Resolved,
} from '@nrs/core';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../db.ts';
import { runRedaction } from '../redact/stage.ts';
import { DEFAULT_BACKOFF } from '../score/backoff.ts';
import { loadPrompt } from '../score/prompt.ts';
import { fakeClient, fakeMessage, validOutput } from '../score/testUtils.ts';
import { DEFAULT_LINKER_PROMPT_VERSION } from './linker.ts';
import { runLinking, type LinkRunOptions } from './stage.ts';

// ───────────── hand-built fixtures ─────────────

interface Fixture {
  id: string;
  customer: string;
  channel: Channel;
  line: string;
  day: number;
  transcript: string;
  score?: { resolved: Resolved; category: Category };
}

const day = (d: number) => new Date(Date.UTC(2026, 9, 1, 12) + d * 86_400_000).toISOString();

const FIXTURES: Fixture[] = [
  // c1: same goal. The AI "refunded" a double charge; the refund never arrived and a human finished it.
  {
    id: 'a_same',
    customer: 'c1',
    channel: 'ai_agent',
    line: 'billing',
    day: 0,
    transcript:
      "Customer: Hi, I'm Maria Garcia. I was charged twice this month.\nAgent: I've refunded the duplicate charge. You're all set!\nCustomer: Okay, thanks.",
    score: { resolved: 'yes', category: 'promoter' },
  },
  {
    id: 'b_same',
    customer: 'c1',
    channel: 'human',
    line: 'billing',
    day: 3,
    transcript:
      'Customer: The refund for the double charge never arrived.\nAgent: Sorry about that. I have processed it now.',
  },
  // c2: different goal. Router set up fine; days later the customer moves house.
  {
    id: 'a_diff',
    customer: 'c2',
    channel: 'ai_agent',
    line: 'tech_support',
    day: 0,
    transcript:
      'Customer: Help me set up my new router.\nAgent: Activated.\nCustomer: It works now!',
    score: { resolved: 'yes', category: 'promoter' },
  },
  {
    id: 'b_diff',
    customer: 'c2',
    channel: 'ai_agent',
    line: 'account_changes',
    day: 2,
    transcript: 'Customer: I need to update my address, I am moving.\nAgent: Done.',
  },
  // c3: same goal, but 9 days later: outside the default 7-day window.
  {
    id: 'a_late',
    customer: 'c3',
    channel: 'human',
    line: 'tech_support',
    day: 0,
    transcript: "Customer: I need a password reset.\nAgent: Sent.\nCustomer: I'm in, thanks.",
    score: { resolved: 'yes', category: 'promoter' },
  },
  {
    id: 'b_late',
    customer: 'c3',
    channel: 'human',
    line: 'tech_support',
    day: 9,
    transcript: "Customer: I still can't log in after the password reset.\nAgent: Let me look.",
  },
  // c4: probably the same goal, but the model is unsure (confidence 0.5).
  {
    id: 'a_unsure',
    customer: 'c4',
    channel: 'ai_agent',
    line: 'tech_support',
    day: 0,
    transcript: 'Customer: My internet is slow.\nAgent: Optimized.\nCustomer: Seems better.',
    score: { resolved: 'yes', category: 'passive' },
  },
  {
    id: 'b_unsure',
    customer: 'c4',
    channel: 'ai_agent',
    line: 'tech_support',
    day: 4,
    transcript: 'Customer: My internet is acting up.\nAgent: Checking.',
  },
  // c5: A was never confirmed resolved, so it can't be a false resolution.
  {
    id: 'a_partial',
    customer: 'c5',
    channel: 'ai_agent',
    line: 'billing',
    day: 0,
    transcript: "Customer: I was charged twice.\nAgent: Fixed!\nCustomer: We'll see.",
    score: { resolved: 'partial', category: 'passive' },
  },
  {
    id: 'b_partial',
    customer: 'c5',
    channel: 'human',
    line: 'billing',
    day: 2,
    transcript: 'Customer: The double charge is still there.\nAgent: Refunded.',
  },
  // c6: AI "fixed" it, an AI retry also failed, then a human finished it.
  {
    id: 'a_chain',
    customer: 'c6',
    channel: 'ai_agent',
    line: 'billing',
    day: 0,
    transcript: 'Customer: I was charged twice.\nAgent: Refunded!\nCustomer: Great, thanks.',
    score: { resolved: 'yes', category: 'promoter' },
  },
  {
    id: 'b_chain_ai',
    customer: 'c6',
    channel: 'ai_agent',
    line: 'billing',
    day: 1,
    transcript: 'Customer: The double charge refund is missing.\nAgent: It is processing.',
  },
  {
    id: 'b_chain_human',
    customer: 'c6',
    channel: 'hybrid',
    line: 'billing',
    day: 2,
    transcript: 'Customer: Still no refund for the double charge.\nAgent: Fixed for real now.',
  },
];

function setup(fixtures: Fixture[] = FIXTURES) {
  const db = openDb(':memory:');
  migrate(db);
  for (const c of new Set(fixtures.map((f) => f.customer))) {
    db.prepare('INSERT INTO customers (id, created_at) VALUES (?, ?)').run(c, day(-100));
  }
  for (const f of fixtures) {
    db.prepare(
      'INSERT INTO interactions (id, customer_id, channel, started_at, transcript, business_line) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(f.id, f.customer, f.channel, day(f.day), f.transcript, f.line);
    if (!f.score) continue;
    const record = ScoredInteractionSchema.parse({
      interactionId: f.id,
      channel: f.channel,
      businessLine: f.line,
      model: 'test-model',
      promptVersion: 'scorer.v1',
      scoredAt: day(f.day + 0.01),
      attempts: 1,
      status: 'scored',
      output: validOutput({ channel: f.channel, ...f.score }),
      category: f.score.category,
      override: null,
      flags: [],
      cacheKey: `key-${f.id}`,
      cached: false,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    db.prepare(
      `INSERT INTO scores (interaction_id, json, model, prompt_version, scored_at, status)
       VALUES (?, ?, 'test-model', 'scorer.v1', ?, 'scored')`,
    ).run(f.id, JSON.stringify(record), record.scoredAt);
  }
  runRedaction(db, () => {});
  return db;
}

/** Judges by keywords in the two transcripts, like a careful reader would. */
const WHY = {
  refund: 'B says the refund promised in A never arrived.',
  login: 'B is the same failed password reset.',
  unsure: 'Both are about internet quality, but B is vague.',
  different: 'B is a new, unrelated request.',
};
function judge(params: Anthropic.MessageCreateParamsNonStreaming) {
  const text = params.messages[0]!.content as string;
  const a = text.split('<transcript_a>')[1]!.split('</transcript_a>')[0]!;
  const b = text.split('<transcript_b>')[1]!.split('</transcript_b>')[0]!;
  const out = (same_goal: boolean, confidence: number, why: string) =>
    fakeMessage(JSON.stringify({ same_goal, confidence, why }));
  if (a.includes('charged twice') && b.includes('double charge'))
    return out(true, 0.93, WHY.refund);
  if (a.includes('password') && b.includes("can't log in")) return out(true, 0.9, WHY.login);
  if (a.includes('slow') && b.includes('acting up')) return out(true, 0.5, WHY.unsure);
  return out(false, 0.85, WHY.different);
}

const WINDOW: ReturnWindowConfig = { defaultDays: 7, byBusinessLine: {} };
const opts: LinkRunOptions = {
  model: 'test-model',
  prompt: loadPrompt(DEFAULT_LINKER_PROMPT_VERSION),
  concurrency: 3,
  window: WINDOW,
  scorer: { model: 'test-model', promptVersion: 'scorer.v1' },
  backoff: { ...DEFAULT_BACKOFF, sleep: async () => {} },
};

const reclassifications = (db: ReturnType<typeof setup>) =>
  db.prepare('SELECT * FROM reclassifications ORDER BY interaction_id').all() as Record<
    string,
    unknown
  >[];
const linkRow = (db: ReturnType<typeof setup>, a: string, b: string) =>
  db
    .prepare('SELECT * FROM links WHERE a_interaction_id = ? AND b_interaction_id = ?')
    .get(a, b) as Record<string, unknown> | undefined;
const pairsSent = (client: ReturnType<typeof fakeClient>) =>
  client.calls.map((c) => (c.messages[0]!.content as string).split('\n')[1]);

// ───────────── tests ─────────────

describe('runLinking', () => {
  it('reclassifies a same-goal return as a false resolution, flagged ai_resolved_human_finished', async () => {
    const db = setup();
    const s = await runLinking(db, fakeClient(judge), opts, () => {});
    const link = linkRow(db, 'a_same', 'b_same')!;
    expect(link).toMatchObject({
      status: 'confirmed',
      same_goal: 1,
      confidence: 0.93,
      why: WHY.refund,
    });
    expect(JSON.parse(link.flags_json as string)).toEqual(['ai_resolved_human_finished']);

    const r = reclassifications(db).find((x) => x.interaction_id === 'a_same')!;
    expect(r).toMatchObject({
      from_category: 'promoter',
      to_category: 'detractor',
      reason: 'false_resolution',
      source: 'link',
      link_id: link.id,
    });
    expect(JSON.parse(r.flags_json as string)).toEqual(['ai_resolved_human_finished']);
    expect(s.reclassified).toBe(2); // a_same and a_chain
  });

  it('leaves a different-goal return alone', async () => {
    const db = setup();
    await runLinking(db, fakeClient(judge), opts, () => {});
    expect(linkRow(db, 'a_diff', 'b_diff')).toMatchObject({ status: 'rejected', same_goal: 0 });
    expect(reclassifications(db).map((r) => r.interaction_id)).not.toContain('a_diff');
  });

  it('never asks about a return outside the window', async () => {
    const db = setup();
    const client = fakeClient(judge);
    await runLinking(db, client, opts, () => {});
    expect(linkRow(db, 'a_late', 'b_late')).toBeUndefined();
    expect(
      client.calls.some((c) => JSON.stringify(c.messages).includes('I need a password reset')),
    ).toBe(false);
  });

  it('uses a per-business-line window override', async () => {
    const db = setup();
    const window = { defaultDays: 7, byBusinessLine: { tech_support: 10 } };
    await runLinking(db, fakeClient(judge), { ...opts, window }, () => {});
    expect(linkRow(db, 'a_late', 'b_late')).toMatchObject({ status: 'confirmed', window_days: 10 });
    const r = reclassifications(db).find((x) => x.interaction_id === 'a_late')!;
    expect(JSON.parse(r.flags_json as string)).toEqual([]); // human → human: no flag
  });

  it('records a same-goal answer below 0.7 confidence as unconfirmed, without reclassifying', async () => {
    const db = setup();
    await runLinking(db, fakeClient(judge), opts, () => {});
    expect(linkRow(db, 'a_unsure', 'b_unsure')).toMatchObject({
      status: 'unconfirmed',
      confidence: 0.5,
    });
    expect(reclassifications(db).map((r) => r.interaction_id)).not.toContain('a_unsure');
  });

  it('only considers A when the scorer said resolved = "yes"', async () => {
    const db = setup();
    await runLinking(db, fakeClient(judge), opts, () => {});
    expect(linkRow(db, 'a_partial', 'b_partial')).toBeUndefined();
  });

  it('reclassifies once per A, from the earliest return, with flags from every confirmed return', async () => {
    const db = setup();
    await runLinking(db, fakeClient(judge), opts, () => {});
    const firstLink = linkRow(db, 'a_chain', 'b_chain_ai')!;
    expect(JSON.parse(firstLink.flags_json as string)).toEqual([]); // AI → AI
    const r = reclassifications(db).filter((x) => x.interaction_id === 'a_chain');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ link_id: firstLink.id });
    expect(JSON.parse(r[0]!.flags_json as string)).toEqual(['ai_resolved_human_finished']);
  });

  it('never modifies score rows', async () => {
    const db = setup();
    const before = db.prepare('SELECT * FROM scores ORDER BY interaction_id').all();
    await runLinking(db, fakeClient(judge), opts, () => {});
    expect(db.prepare('SELECT * FROM scores ORDER BY interaction_id').all()).toEqual(before);
  });

  it('is idempotent: a re-run makes no calls and adds nothing', async () => {
    const db = setup();
    await runLinking(db, fakeClient(judge), opts, () => {});
    const counts = () => [
      db.prepare('SELECT count(*) FROM links').pluck().get(),
      db.prepare('SELECT count(*) FROM reclassifications').pluck().get(),
    ];
    const before = counts();
    const again = fakeClient(judge);
    const s = await runLinking(db, again, opts, () => {});
    expect(again.calls).toHaveLength(0);
    expect(s).toMatchObject({ candidates: 0, reclassified: 0 });
    expect(counts()).toEqual(before);
  });

  it('serves repeat judgments from cache', async () => {
    const db = setup();
    await runLinking(db, fakeClient(judge), opts, () => {});
    db.prepare('DELETE FROM reclassifications').run();
    db.prepare('DELETE FROM links').run();
    const again = fakeClient(judge);
    const s = await runLinking(db, again, opts, () => {});
    expect(again.calls).toHaveLength(0);
    expect(s.cached).toBe(s.evaluated);
    expect(s.reclassified).toBe(2);
  });

  it('sends only redacted transcripts and logs ids, never reasons', async () => {
    const db = setup();
    const client = fakeClient(judge);
    const logs: string[] = [];
    await runLinking(db, client, opts, (m) => logs.push(m));
    const sent = JSON.stringify(client.calls);
    expect(sent).not.toContain('Maria');
    expect(sent).not.toContain('Garcia');
    expect(sent).toContain('[NAME]');
    const logged = logs.join('\n');
    for (const why of Object.values(WHY)) expect(logged).not.toContain(why);
    expect(logged).toContain(
      'a_same promoter → detractor (false_resolution; returned after 3.0d as b_same',
    );
  });

  it('respects --limit', async () => {
    const db = setup();
    const client = fakeClient(judge);
    const s = await runLinking(db, client, { ...opts, limit: 2 }, () => {});
    expect(s.candidates).toBe(2);
    expect(client.calls).toHaveLength(2);
    expect(pairsSent(client)).toHaveLength(2);
  });

  it('records link_failed on invalid output and retries it next run', async () => {
    const db = setup();
    const bad = fakeClient(() => fakeMessage(JSON.stringify(validOutput()))); // scorer shape, not linker
    const s = await runLinking(db, bad, { ...opts, limit: 1 }, () => {});
    expect(s.failed).toBe(1);
    expect(bad.calls).toHaveLength(2); // one retry with the validation error
    expect(
      db.prepare("SELECT count(*) FROM links WHERE status = 'link_failed'").pluck().get(),
    ).toBe(1);

    await runLinking(db, fakeClient(judge), opts, () => {});
    expect(
      db.prepare("SELECT count(*) FROM links WHERE status = 'link_failed'").pluck().get(),
    ).toBe(0);
  });

  it('aborts on an auth error and records it on the run', async () => {
    const db = setup();
    const client = fakeClient(
      () => new Anthropic.AuthenticationError(401, undefined, 'bad key', new Headers()),
    );
    await expect(
      runLinking(db, client, { ...opts, concurrency: 1 }, () => {}),
    ).rejects.toBeInstanceOf(Anthropic.AuthenticationError);
    expect(client.calls).toHaveLength(1);
    expect(db.prepare('SELECT error FROM link_runs').pluck().get()).toBe('AuthenticationError 401');
    expect(reclassifications(db)).toEqual([]);
  });
});
