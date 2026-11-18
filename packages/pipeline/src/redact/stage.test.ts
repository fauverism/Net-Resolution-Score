import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../db.ts';
import { loadScoringInputs } from '../score/inputs.ts';
import { DEFAULT_GENERATE_OPTIONS, generate } from '../seed/generate.ts';
import { writeSeed } from '../seed/write.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runRedaction } from './stage.ts';

function seededDb() {
  const data = generate({ ...DEFAULT_GENERATE_OPTIONS, customers: 40, interactions: 150 });
  const db = openDb(':memory:');
  migrate(db);
  writeSeed(db, data, path.join(mkdtempSync(path.join(tmpdir(), 'nrs-')), 'gt.json'));
  const values = data.groundTruth.labels.flatMap((l) => l.pii.map((p) => p.value));
  return { db, data, values };
}

describe('runRedaction', () => {
  it('redacts every interaction once, and logs counts but no values', () => {
    const { db, data, values } = seededDb();
    const logs: string[] = [];
    const first = runRedaction(db, (m) => logs.push(m));
    expect(first.redacted).toBe(data.interactions.length);
    expect(first.counts.EMAIL + first.counts.NAME).toBeGreaterThan(0);

    const second = runRedaction(db, (m) => logs.push(m));
    expect(second).toMatchObject({ redacted: 0, alreadyCurrent: data.interactions.length });

    const logged = logs.join('\n');
    expect(logged).toMatch(/EMAIL \d+, PHONE \d+, ACCOUNT \d+, ADDRESS \d+, NAME \d+/);
    for (const v of values) expect(logged).not.toContain(v);
  });

  it('stores counts, not values', () => {
    const { db } = seededDb();
    runRedaction(db, () => {});
    const json = db.prepare('SELECT counts_json FROM redacted_transcripts LIMIT 1').pluck().get();
    expect(Object.keys(JSON.parse(json as string)).sort()).toEqual([
      'ACCOUNT',
      'ADDRESS',
      'EMAIL',
      'NAME',
      'PHONE',
    ]);
  });
});

describe('loadScoringInputs', () => {
  it('returns nothing until transcripts are redacted (never falls back to raw)', () => {
    const { db } = seededDb();
    expect(loadScoringInputs(db)).toEqual([]);
  });

  it('only ever returns redacted transcripts', () => {
    const { db, data, values } = seededDb();
    runRedaction(db, () => {});
    const inputs = loadScoringInputs(db);
    expect(inputs).toHaveLength(data.interactions.length);
    const all = inputs.map((i) => i.transcript).join('\n');
    expect(all).toContain('[EMAIL]');
    for (const v of values) {
      expect(all).not.toMatch(
        new RegExp(`(?<![A-Za-z0-9])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`),
      );
    }
  });

  it('re-redacts stored text, so a raw row slipped into the table still cannot leak', () => {
    const { db, data } = seededDb();
    runRedaction(db, () => {});
    const victim = data.interactions[0]!;
    db.prepare('UPDATE redacted_transcripts SET transcript = ? WHERE interaction_id = ?').run(
      'Customer: I am Maria Garcia, maria@example.com, (415) 555-0123',
      victim.id,
    );
    const input = loadScoringInputs(db).find((i) => i.interactionId === victim.id)!;
    expect(input.transcript).toBe('Customer: I am [NAME], [EMAIL], [PHONE]');
  });
});
