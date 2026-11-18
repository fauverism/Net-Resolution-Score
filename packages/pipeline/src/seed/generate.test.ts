import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  breakdown,
  GroundTruthFileSchema,
  InteractionSchema,
  SurveyResponseSchema,
  type GroundTruthLabel,
} from '@nrs/core';
import { migrate, openDb } from '../db.ts';
import { DEFAULT_GENERATE_OPTIONS, experienceScore, generate, type SeedData } from './generate.ts';
import { MAX_TURNS, MIN_TURNS } from './transcript.ts';
import { writeSeed } from './write.ts';

let data: SeedData;
let labels: GroundTruthLabel[];
const DAY = 86_400_000;
const share = (xs: readonly unknown[], of: readonly unknown[]) => xs.length / of.length;

beforeAll(() => {
  data = generate();
  labels = data.groundTruth.labels;
});

describe('generate: shape', () => {
  it('is reproducible for a seed and changes with the seed', () => {
    const again = generate();
    expect(JSON.stringify(again)).toBe(JSON.stringify(data));
    const other = generate({ ...DEFAULT_GENERATE_OPTIONS, seed: 7 });
    expect(other.interactions[0]!.transcript).not.toBe(data.interactions[0]!.transcript);
  });

  it('produces 500 customers and ~3,000 interactions inside the 60-day period', () => {
    expect(data.customers).toHaveLength(500);
    expect(data.interactions.length).toBeGreaterThanOrEqual(3000);
    expect(data.interactions.length).toBeLessThan(3010);
    const start = new Date(data.groundTruth.periodStart).getTime();
    const end = new Date(data.groundTruth.periodEnd).getTime();
    expect(end - start).toBe(60 * DAY);
    for (const i of data.interactions) {
      const t = new Date(i.startedAt).getTime();
      expect(t).toBeGreaterThanOrEqual(start);
      expect(t).toBeLessThan(end);
    }
  });

  it('passes the core Zod schemas', () => {
    for (const i of data.interactions) InteractionSchema.parse(i);
    for (const s of data.surveys) SurveyResponseSchema.parse(s);
    GroundTruthFileSchema.parse(data.groundTruth);
  });

  it('labels every interaction exactly once', () => {
    expect(labels.map((l) => l.interactionId)).toEqual(data.interactions.map((i) => i.id));
  });

  it('mixes channels ~55/30/15', () => {
    const by = (c: string) =>
      share(
        labels.filter((l) => l.channel === c),
        labels,
      );
    expect(by('ai_agent')).toBeCloseTo(0.55, 1);
    expect(by('human')).toBeCloseTo(0.3, 1);
    expect(by('hybrid')).toBeCloseTo(0.15, 1);
  });

  it('covers all three business lines', () => {
    expect(new Set(labels.map((l) => l.businessLine))).toEqual(
      new Set(['billing', 'tech_support', 'account_changes']),
    );
  });
});

describe('generate: transcripts', () => {
  it(`alternates Customer/Agent turns, starting with Customer, ${MIN_TURNS}–${MAX_TURNS} turns`, () => {
    for (const { transcript } of data.interactions) {
      const lines = transcript.split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(MIN_TURNS);
      expect(lines.length).toBeLessThanOrEqual(MAX_TURNS);
      lines.forEach((line, i) => {
        expect(line.startsWith(i % 2 === 0 ? 'Customer: ' : 'Agent: ')).toBe(true);
      });
    }
  });

  it('ends abandoned conversations on an unanswered agent turn', () => {
    const abandoned = labels.filter((l) => l.abandoned);
    expect(abandoned.length).toBeGreaterThan(0);
    const byId = new Map(data.interactions.map((i) => [i.id, i.transcript]));
    for (const l of abandoned) {
      expect(byId.get(l.interactionId)!.split('\n').at(-1)!.startsWith('Agent: ')).toBe(true);
    }
  });
});

describe('generate: planted patterns', () => {
  const ai = () => labels.filter((l) => l.channel === 'ai_agent');

  it('has false resolutions in ~12% of AI interactions', () => {
    expect(
      share(
        ai().filter((l) => l.falseResolution),
        ai(),
      ),
    ).toBeGreaterThan(0.09);
    expect(
      share(
        ai().filter((l) => l.falseResolution),
        ai(),
      ),
    ).toBeLessThan(0.15);
  });

  it('brings false resolutions back about the same goal 1–6 days later', () => {
    const byId = new Map(labels.map((l) => [l.interactionId, l]));
    const returned = ai().filter((l) => l.falseResolution && l.returnInteractionId);
    expect(returned.length).toBeGreaterThan(100);
    for (const l of returned) {
      const next = byId.get(l.returnInteractionId!)!;
      expect(next.customerId).toBe(l.customerId);
      expect(next.goalId).toBe(l.goalId);
      expect(next.previousInteractionId).toBe(l.interactionId);
      expect(next.firstContact).toBe(false);
      expect(l.returnAfterDays).toBeGreaterThanOrEqual(1);
      expect(l.returnAfterDays).toBeLessThanOrEqual(6.5); // 6 days, nudged into staffed hours
      expect(l.visiblyResolved).toBe(true);
      expect(l.resolved).toBe(false);
      expect(l.trueCategory).toBe('detractor');
    }
  });

  it('has customers asking for a human in ~15% of AI chats', () => {
    expect(
      share(
        ai().filter((l) => l.escalated),
        ai(),
      ),
    ).toBeGreaterThan(0.12);
    expect(
      share(
        ai().filter((l) => l.escalated),
        ai(),
      ),
    ).toBeLessThan(0.18);
  });

  it('makes AI noticeably worse than humans on billing only', () => {
    const nrs = (line: string, channel: string) =>
      breakdown(
        labels
          .filter((l) => l.businessLine === line && l.channel === channel)
          .map((l) => l.trueCategory),
      ).nrs!;
    expect(nrs('billing', 'human') - nrs('billing', 'ai_agent')).toBeGreaterThan(40);
    for (const line of ['tech_support', 'account_changes']) {
      expect(Math.abs(nrs(line, 'human') - nrs(line, 'ai_agent'))).toBeLessThan(20);
    }
  });

  it('includes some returns outside the default window, for window-config tests', () => {
    expect(labels.some((l) => l.returnAfterDays !== null && l.returnAfterDays > 7)).toBe(true);
  });
});

describe('generate: fake PII', () => {
  it('records PII that really appears in each transcript', () => {
    const byId = new Map(data.interactions.map((i) => [i.id, i.transcript]));
    for (const l of labels) {
      for (const p of l.pii) expect(byId.get(l.interactionId)).toContain(p.value);
    }
    const types = new Set(labels.flatMap((l) => l.pii.map((p) => p.type)));
    for (const t of [
      'name',
      'email',
      'phone',
      'account_number',
      'card_last4',
      'address',
      'agent_name',
    ]) {
      expect(types).toContain(t);
    }
  });

  it('only uses reserved example domains and fictional 555-01xx numbers', () => {
    for (const p of labels.flatMap((l) => l.pii)) {
      if (p.type === 'email') expect(p.value).toMatch(/@(mail\.)?example\.(com|net|org)$/);
      if (p.type === 'phone') expect(p.value).toMatch(/^\(\d{3}\) 555-01\d{2}$/);
    }
  });
});

describe('generate: surveys', () => {
  it('surveys ~20% of customers', () => {
    expect(data.surveys.length / data.customers.length).toBeGreaterThan(0.14);
    expect(data.surveys.length / data.customers.length).toBeLessThan(0.26);
  });

  it('correlates NPS with true experience, with noise', () => {
    const byCustomer = Map.groupBy(labels, (l) => l.customerId);
    const xs = data.surveys.map((s) => experienceScore(byCustomer.get(s.customerId)!));
    const ys = data.surveys.map((s) => s.npsScore);
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const [mx, my] = [mean(xs), mean(ys)];
    const cov = mean(xs.map((x, i) => (x - mx) * (ys[i]! - my)));
    const sd = (a: number[], m: number) => Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
    const r = cov / (sd(xs, mx) * sd(ys, my));
    expect(r).toBeGreaterThan(0.3); // correlated…
    expect(r).toBeLessThan(0.95); // …but noisy
  });

  it('responds after the customer’s last interaction', () => {
    const last = new Map<string, string>();
    for (const l of labels) last.set(l.customerId, l.startedAt);
    for (const s of data.surveys) expect(s.respondedAt > last.get(s.customerId)!).toBe(true);
  });
});

describe('writeSeed', () => {
  it('fills the db, keeps labels out of it, and writes the ground-truth file', () => {
    const small = generate({ ...DEFAULT_GENERATE_OPTIONS, customers: 20, interactions: 60 });
    const db = openDb(':memory:');
    migrate(db);
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'nrs-')), 'fixtures', 'gt.json');
    writeSeed(db, small, file);
    writeSeed(db, small, file); // idempotent: replaces, doesn't duplicate

    const count = (t: string) => db.prepare(`SELECT count(*) FROM ${t}`).pluck().get() as number;
    expect(count('customers')).toBe(20);
    expect(count('interactions')).toBe(small.interactions.length);
    expect(count('surveys')).toBe(small.surveys.length);

    const columns = db.prepare('SELECT name FROM pragma_table_info(?)').pluck().all('interactions');
    expect(columns).not.toContain('true_category');
    const written = GroundTruthFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    expect(written.labels).toHaveLength(small.interactions.length);
  });
});
