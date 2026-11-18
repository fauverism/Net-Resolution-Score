import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '@nrs/pipeline/db';
import { createApp } from './app.ts';

describe('api', () => {
  it('reports a missing db without failing', async () => {
    const res = await createApp(() => null).request('/api/health');
    expect(await res.json()).toEqual({ ok: true, db: 'missing' });
  });

  it('lists runs from an empty db', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const res = await createApp(() => db).request('/api/runs');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runs: [] });
  });
});
