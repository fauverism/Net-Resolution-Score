import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DrillResponseSchema,
  InteractionDetailSchema,
  MetaResponseSchema,
  SummaryResponseSchema,
  type GroundTruthLabel,
} from '@nrs/core';
import { DEFAULT_PROMPT_VERSION, loadConfig, migrate, openDb, type Db } from '@nrs/pipeline';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEMO_MODEL, writeDemoScores } from '../../../packages/pipeline/src/seed/demo.ts';
import {
  DEFAULT_GENERATE_OPTIONS,
  generate,
} from '../../../packages/pipeline/src/seed/generate.ts';
import { writeSeed } from '../../../packages/pipeline/src/seed/write.ts';
import { createApp } from './app.ts';

const settings = { model: DEMO_MODEL, promptVersion: DEFAULT_PROMPT_VERSION };
let db: Db;
let labels: GroundTruthLabel[];
let app: ReturnType<typeof createApp>;
const Q = 'from=2026-10-16&to=2026-11-14';

beforeAll(async () => {
  db = openDb(':memory:');
  migrate(db);
  const data = generate({ ...DEFAULT_GENERATE_OPTIONS, customers: 120, interactions: 700 });
  writeSeed(db, data, path.join(mkdtempSync(path.join(tmpdir(), 'nrs-dash-')), 'gt.json'));
  await writeDemoScores(db, data, loadConfig({}).returnWindow, () => {});
  labels = data.groundTruth.labels;
  app = createApp(() => db, settings);
});

const get = async (url: string) => {
  const res = await app.request(url);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe('GET /api/meta', () => {
  it('describes the data and flags demo scores', async () => {
    const { body } = await get('/api/meta');
    const m = MetaResponseSchema.parse(body);
    expect(m).toMatchObject({ demo: true, model: DEMO_MODEL, latestDate: '2026-11-14' });
    expect(m.businessLines).toEqual(['account_changes', 'billing', 'tech_support']);
  });
});

describe('GET /api/summary', () => {
  it('returns a valid summary with calibration, drivers and a weekly trend', async () => {
    const { status, body } = await get(`/api/summary?${Q}`);
    expect(status).toBe(200);
    const s = SummaryResponseSchema.parse(body);
    expect(s.report.overall.n).toBeGreaterThan(100);
    expect(s.calibration?.status).toBe('calibrating');
    expect(s.drivers?.matchesPeriod).toBe(true);
    expect(s.drivers?.top.length).toBeGreaterThan(0);
    expect(s.trend.length).toBeGreaterThan(3);
    expect(s.trend.at(-1)!.end).toBe('2026-11-15T00:00:00.000Z');
  });

  it('computes the AI-vs-human gap', async () => {
    const s = SummaryResponseSchema.parse((await get(`/api/summary?${Q}`)).body);
    expect(s.aiVsHuman.gap).toBeCloseTo(s.aiVsHuman.ai.nrs! - s.aiVsHuman.human.nrs!, 1);
  });

  it('filters by business line', async () => {
    const all = SummaryResponseSchema.parse((await get(`/api/summary?${Q}`)).body);
    const billing = SummaryResponseSchema.parse((await get(`/api/summary?${Q}&line=billing`)).body);
    expect(billing.report.overall.n).toBeLessThan(all.report.overall.n);
    expect(Object.keys(billing.report.byBusinessLine)).toEqual(['billing']);
  });

  it('rejects bad input with a 400', async () => {
    expect((await get('/api/summary?from=yesterday&to=2026-11-14')).status).toBe(400);
    expect((await get('/api/summary?from=2026-11-14&to=2026-10-01')).status).toBe(400);
    expect((await get(`/api/summary?${Q}&line=DROP%20TABLE`)).status).toBe(400);
  });
});

describe('GET /api/drill', () => {
  it('lists every interaction behind the headline number', async () => {
    const s = SummaryResponseSchema.parse((await get(`/api/summary?${Q}`)).body);
    const d = DrillResponseSchema.parse((await get(`/api/drill?${Q}`)).body);
    expect(d.items.filter((i) => i.category !== null)).toHaveLength(s.report.overall.n);
  });

  it('matches each rate numerator', async () => {
    const s = SummaryResponseSchema.parse((await get(`/api/summary?${Q}`)).body);
    const r = s.report.rates;
    const count = async (metric: string) =>
      DrillResponseSchema.parse((await get(`/api/drill?${Q}&metric=${metric}`)).body).total;
    expect(await count('escape')).toBe(r.escape.count);
    expect(await count('false_resolution')).toBe(r.falseResolution.overall.count);
    expect(await count('abandoned')).toBe(r.abandonment.overall.count);
  });

  it('filters by channel and category, with a plain-language title', async () => {
    const s = SummaryResponseSchema.parse((await get(`/api/summary?${Q}`)).body);
    const d = DrillResponseSchema.parse(
      (await get(`/api/drill?${Q}&channel=human&category=detractor`)).body,
    );
    expect(d.total).toBe(s.report.byChannel.human.detractors);
    expect(d.title).toBe('All conversations, handled by people, detractors only');
  });

  it("lists a driver's conversations", async () => {
    const s = SummaryResponseSchema.parse((await get(`/api/summary?${Q}`)).body);
    const top = s.drivers!.top[0]!;
    const d = DrillResponseSchema.parse(
      (await get(`/api/drill?${Q}&metric=driver&driverRun=${s.drivers!.runId}&driverRank=1`)).body,
    );
    expect(d.total).toBe(top.volume);
    expect(d.items.every((i) => i.category === 'detractor')).toBe(true);
  });

  it('404s an unknown driver', async () => {
    expect((await get(`/api/drill?${Q}&metric=driver&driverRun=999&driverRank=1`)).status).toBe(
      404,
    );
  });
});

describe('GET /api/interactions/:id', () => {
  it('returns the redacted transcript, score and reclassification with its reason', async () => {
    const fr = db
      .prepare(
        "SELECT interaction_id FROM reclassifications WHERE reason = 'false_resolution' LIMIT 1",
      )
      .pluck()
      .get() as string;
    const d = InteractionDetailSchema.parse((await get(`/api/interactions/${fr}`)).body);
    expect(d.finalCategory).toBe('detractor');
    expect(d.reclassifications[0]).toMatchObject({
      reason: 'false_resolution',
      toCategory: 'detractor',
    });
    expect(d.reclassifications[0]!.link?.otherInteractionId).toMatch(/^int_/);
    expect(d.reclassifications[0]!.link?.why).toBeTruthy();
    expect(d.score?.status).toBe('scored');
  });

  it('never returns personal details', async () => {
    for (const l of labels.slice(0, 40)) {
      const { body } = await get(`/api/interactions/${l.interactionId}`);
      const text = JSON.stringify(body);
      for (const p of l.pii.filter((x) => x.type === 'email' || x.type === 'phone')) {
        expect(text).not.toContain(p.value);
      }
    }
  });

  it('404s an unknown id and 400s a malformed one', async () => {
    expect((await get('/api/interactions/int_99999')).status).toBe(404);
    expect((await get('/api/interactions/..%2Fetc')).status).toBe(400);
  });
});

describe('without a database', () => {
  it('reports that there is no data yet', async () => {
    const empty = createApp(() => null, settings);
    expect((await empty.request('/api/health')).status).toBe(200);
    expect((await empty.request(`/api/summary?${Q}`)).status).toBe(503);
  });
});
