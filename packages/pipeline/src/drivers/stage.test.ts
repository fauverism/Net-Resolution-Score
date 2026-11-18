import Anthropic from '@anthropic-ai/sdk';
import {
  DriversReportSchema,
  ScoreRecordSchema,
  type Category,
  type Channel,
  type ScoreFlag,
  type ScorerOutput,
} from '@nrs/core';
import { describe, expect, it } from 'vitest';
import { migrate, openDb, type Db } from '../db.ts';
import { DEFAULT_BACKOFF } from '../score/backoff.ts';
import { loadPrompt } from '../score/prompt.ts';
import { fakeClient, fakeMessage, validOutput } from '../score/testUtils.ts';
import { DEFAULT_CLUSTER_PROMPT_VERSION, DEFAULT_SUGGEST_PROMPT_VERSION } from './llm.ts';
import { runDrivers, type DriversOptions } from './stage.ts';

// ───────────── fixtures ─────────────

interface Fx {
  id: string;
  category?: Category | 'failed';
  channel?: Channel;
  line?: string;
  out?: Partial<ScorerOutput>;
  flags?: ScoreFlag[];
  falseResolution?: boolean;
  day?: number;
}

const at = (day = 5) => `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`;

function build(fixtures: Fx[]): Db {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO customers VALUES ('c1', '2026-01-01T00:00:00.000Z')").run();
  for (const f of fixtures) {
    const channel = f.channel ?? 'ai_agent';
    const line = f.line ?? 'billing';
    db.prepare('INSERT INTO interactions VALUES (?, ?, ?, ?, ?, ?)').run(
      f.id,
      'c1',
      channel,
      at(f.day),
      'x',
      line,
    );
    if (!f.category) continue; // unscored
    const base = {
      interactionId: f.id,
      channel,
      businessLine: line,
      model: 'test-model',
      promptVersion: 'scorer.v1',
      scoredAt: at(f.day),
      attempts: 1,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    const rec = ScoreRecordSchema.parse(
      f.category === 'failed'
        ? { ...base, status: 'score_failed', reason: 'invalid_output', detail: 'bad' }
        : {
            ...base,
            status: 'scored',
            output: validOutput({ channel, category: f.category, ...f.out }),
            category: f.category,
            override: null,
            flags: f.flags ?? [],
            cacheKey: 'k',
            cached: false,
          },
    );
    db.prepare(
      'INSERT INTO scores (interaction_id, json, model, prompt_version, scored_at, status) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(f.id, JSON.stringify(rec), 'test-model', 'scorer.v1', at(f.day), rec.status);
    if (f.falseResolution) {
      db.prepare(
        `INSERT INTO reclassifications (interaction_id, from_category, to_category, reason, source, created_at)
         VALUES (?, ?, 'detractor', 'false_resolution', 'link', ?)`,
      ).run(f.id, f.category, at(f.day));
    }
  }
  return db;
}

const unresolved = (id: string, goal: string, over: Partial<Fx> = {}): Fx => ({
  id,
  category: 'detractor',
  out: { customer_goal: goal, resolved: 'no', evidence: `still broken (${id})` },
  ...over,
});

/** 4 refunds unresolved (12) + 1 false resolution (2) = 14; 3 router abandons = 9; 5 logins escalated = 5. */
const FIXTURES: Fx[] = [
  unresolved('r1', 'Get refund for duplicate charge', {
    out: {
      customer_goal: 'Get refund for duplicate charge',
      resolved: 'no',
      evidence: "I'm Maria Garcia and I still have no refund",
    },
  }),
  unresolved('r2', 'get refund for duplicate charge', { channel: 'human' }),
  unresolved('r3', 'Refund for a double charge'),
  unresolved('r4', 'Refund for a double charge', { flags: ['evidence_unverified'] }),
  {
    id: 'r5',
    category: 'promoter',
    falseResolution: true,
    out: {
      customer_goal: 'refund never arrived after double charge',
      resolved: 'yes',
      evidence: 'ok thanks',
    },
  },
  ...['t1', 't2', 't3'].map((id) =>
    unresolved(id, 'Set up new router', {
      line: 'tech_support',
      out: {
        customer_goal: 'Set up new router',
        resolved: 'partial',
        abandoned: true,
        evidence: 'which port?',
      },
    }),
  ),
  ...['l1', 'l2', 'l3', 'l4', 'l5'].map((id) => ({
    id,
    category: 'detractor' as const,
    channel: 'hybrid' as const,
    line: 'tech_support',
    out: {
      customer_goal: 'Log in to the app',
      resolved: 'partial' as const,
      asked_for_human: true,
      evidence: 'let me talk to a person',
    },
  })),
  // Not detractors, or nothing to cluster on:
  { id: 'p1', category: 'promoter', out: { customer_goal: 'Reset password' } },
  {
    id: 'p2',
    category: 'passive',
    out: { customer_goal: 'Update address', resolved: 'yes', effort: 2 },
  },
  { id: 'f1', category: 'failed' },
  { id: 'u1' },
  {
    id: 'outside',
    category: 'detractor',
    day: 1,
    out: { customer_goal: 'Out of period', resolved: 'no' },
  },
];

const LABELS = {
  refund: 'Refund for duplicate charge not received',
  router: 'Router setup abandoned',
  login: "Can't log in to the app",
};

/** Labels goals by keyword. Returns the refund label lowercased once it exists, to test folding. */
function labeler(params: Anthropic.MessageCreateParamsNonStreaming) {
  const text = params.messages[0]!.content as string;
  if (text.includes('<driver ')) {
    const ids = [...text.matchAll(/<driver id="(d\d+)">\nCluster: (.*)/g)];
    return fakeMessage(
      JSON.stringify({
        drivers: ids.map(([, id, label]) => ({
          id,
          driver: `Customers hit this problem: ${label}.`,
          suggested_fix: `Investigate and fix: ${label}.`,
          suggested_owner: label!.includes('Refund') ? 'Billing operations' : 'Support operations',
        })),
      }),
    );
  }
  const existing = text.split('Goals to label:')[0]!;
  const goals = [...text.matchAll(/^(g\d+): (.*)$/gm)];
  return fakeMessage(
    JSON.stringify({
      assignments: goals.map(([, id, goal]) => {
        const g = goal!.toLowerCase();
        const label = g.includes('refund')
          ? existing.includes(LABELS.refund)
            ? LABELS.refund.toLowerCase()
            : LABELS.refund
          : g.includes('router')
            ? LABELS.router
            : g.includes('log in')
              ? LABELS.login
              : `Other: ${goal}`;
        return { id, label };
      }),
    }),
  );
}

const opts: DriversOptions = {
  from: '2026-10-03',
  to: '2026-10-31',
  model: 'test-model',
  scorerPromptVersion: 'scorer.v1',
  clusterPrompt: loadPrompt(DEFAULT_CLUSTER_PROMPT_VERSION),
  suggestPrompt: loadPrompt(DEFAULT_SUGGEST_PROMPT_VERSION),
  backoff: { ...DEFAULT_BACKOFF, sleep: async () => {} },
};

// ───────────── tests ─────────────

describe('runDrivers', () => {
  it('takes all final-category detractors in the period', async () => {
    const { report } = await runDrivers(build(FIXTURES), fakeClient(labeler), opts, () => {});
    // 4 refunds + reclassified r5 + 3 router + 5 login + failed f1 = 14
    expect(report.counts).toEqual({
      detractors: 14,
      clustered: 13,
      unclusterable: 1,
      labelingFailed: 0,
      clusters: 3,
    });
  });

  it('ranks clusters by volume × severity', async () => {
    const { report } = await runDrivers(build(FIXTURES), fakeClient(labeler), opts, () => {});
    expect(report.top.map((d) => [d.label, d.volume, d.score])).toEqual([
      [LABELS.refund, 5, 14],
      [LABELS.router, 3, 9],
      [LABELS.login, 5, 5], // more volume than routers, but lowest severity
    ]);
    expect(report.top[0]!.severityMix).toEqual({
      unresolvedOrAbandoned: 4,
      falseResolution: 1,
      highEffort: 0,
    });
    expect(report.others).toEqual([]);
  });

  it('reports % of detractors and channel mix', async () => {
    const { report } = await runDrivers(build(FIXTURES), fakeClient(labeler), opts, () => {});
    const refund = report.top[0]!;
    expect(refund.pctOfDetractors).toBe(35.7); // 5 of 14
    expect(refund.channelMix).toEqual({
      ai_agent: { n: 4, pct: 80 },
      human: { n: 1, pct: 20 },
      hybrid: { n: 0, pct: 0 },
    });
    expect(refund.warning).toBe('low confidence');
  });

  it('picks a verified, redacted representative quote', async () => {
    const { report } = await runDrivers(build(FIXTURES), fakeClient(labeler), opts, () => {});
    const quote = report.top[0]!.representative!;
    expect(quote.interactionId).toBe('r1');
    expect(quote.quote).toBe("I'm [NAME] and I still have no refund");
  });

  it('marks fixes and owners as AI-suggested', async () => {
    const { report } = await runDrivers(build(FIXTURES), fakeClient(labeler), opts, () => {});
    for (const d of report.top) {
      expect(d.suggestedFix).toMatchObject({ source: 'AI-suggested' });
      expect(d.suggestedOwner).toMatchObject({ source: 'AI-suggested' });
      expect(d.driver).toMatch(/^Customers hit this problem/);
    }
    expect(report.top[0]!.suggestedOwner!.value).toBe('Billing operations');
  });

  it('saves a valid report to driver_runs with tokens and calls', async () => {
    const db = build(FIXTURES);
    const client = fakeClient(labeler);
    const { runId, report } = await runDrivers(db, client, opts, () => {});
    const row = db.prepare('SELECT * FROM driver_runs WHERE id = ?').get(runId) as Record<
      string,
      unknown
    >;
    expect(DriversReportSchema.parse(JSON.parse(row.report_json as string))).toEqual(report);
    expect(row).toMatchObject({
      detractors: 14,
      clusters: 3,
      llm_calls: 2,
      input_tokens: 2000,
      error: null,
    });
    expect(client.calls).toHaveLength(2); // one cluster batch + one suggestion call
  });

  it('batches up to 50 goals and carries labels forward, folding case', async () => {
    const db = build(FIXTURES);
    const client = fakeClient(labeler);
    const { report } = await runDrivers(db, client, { ...opts, batchSize: 2 }, () => {});
    const clusterCalls = client.calls.filter((c) =>
      (c.messages[0]!.content as string).includes('Goals to label'),
    );
    expect(clusterCalls.length).toBeGreaterThan(1);
    expect(clusterCalls.at(-1)!.messages[0]!.content).toContain(`- ${LABELS.refund}`);
    expect(report.counts.clusters).toBe(3); // the lowercased refund label folded into the first
  });

  it('sends no personal details', async () => {
    const client = fakeClient(labeler);
    await runDrivers(build(FIXTURES), client, opts, () => {});
    const sent = JSON.stringify(client.calls);
    expect(sent).not.toContain('Maria');
    expect(sent).toContain('[NAME]');
  });

  it('costs nothing on a re-run (cache)', async () => {
    const db = build(FIXTURES);
    const first = await runDrivers(db, fakeClient(labeler), opts, () => {});
    const again = fakeClient(labeler);
    const second = await runDrivers(db, again, opts, () => {});
    expect(again.calls).toHaveLength(0);
    expect(second.report).toEqual(first.report);
  });

  it('keeps drivers when the suggestion call fails, without fixes or owners', async () => {
    const client = fakeClient((p) =>
      (p.messages[0]!.content as string).includes('<driver ') ? fakeMessage('nope') : labeler(p),
    );
    const { report } = await runDrivers(build(FIXTURES), client, opts, () => {});
    expect(report.top).toHaveLength(3);
    expect(report.top[0]).toMatchObject({
      driver: LABELS.refund,
      suggestedFix: null,
      suggestedOwner: null,
    });
  });

  it('counts goals it could not label instead of guessing', async () => {
    const client = fakeClient((p) =>
      (p.messages[0]!.content as string).includes('Goals to label')
        ? fakeMessage('{"assignments": []}')
        : labeler(p),
    );
    const { report } = await runDrivers(build(FIXTURES), client, opts, () => {});
    expect(report.counts).toMatchObject({ clustered: 0, labelingFailed: 13, clusters: 0 });
    expect(report.top).toEqual([]);
  });

  it('makes no calls when there are no detractors', async () => {
    const client = fakeClient(labeler);
    const { report } = await runDrivers(
      build([{ id: 'p1', category: 'promoter' }]),
      client,
      opts,
      () => {},
    );
    expect(client.calls).toHaveLength(0);
    expect(report.top).toEqual([]);
    expect(report.counts.detractors).toBe(0);
  });

  it('logs the top drivers with AI-suggested labels', async () => {
    const logs: string[] = [];
    await runDrivers(build(FIXTURES), fakeClient(labeler), opts, (m) => logs.push(m));
    const out = logs.join('\n');
    expect(out).toContain(`#1 Customers hit this problem: ${LABELS.refund}.`);
    expect(out).toContain('fix (AI-suggested):');
    expect(out).toContain('owner (AI-suggested): Billing operations');
    expect(out).not.toContain('Maria');
  });

  it('aborts on an auth error and records it', async () => {
    const db = build(FIXTURES);
    const client = fakeClient(
      () => new Anthropic.AuthenticationError(401, undefined, 'bad key', new Headers()),
    );
    await expect(runDrivers(db, client, opts, () => {})).rejects.toBeInstanceOf(
      Anthropic.AuthenticationError,
    );
    expect(db.prepare('SELECT error, report_json FROM driver_runs').get()).toEqual({
      error: 'AuthenticationError 401',
      report_json: null,
    });
  });
});
