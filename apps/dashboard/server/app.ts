import { Hono } from 'hono';
import type { Db } from '@nrs/pipeline/db';

/** `getDb` returns null when the db hasn't been created yet (run `npm run seed`). */
export function createApp(getDb: () => Db | null) {
  const app = new Hono().basePath('/api');

  app.get('/health', (c) => {
    const db = getDb();
    return c.json({ ok: true, db: db ? 'ready' : 'missing' });
  });

  app.get('/runs', (c) => {
    const db = getDb();
    if (!db) return c.json({ runs: [] });
    const runs = db
      .prepare(
        'SELECT id, period_start AS periodStart, period_end AS periodEnd, created_at AS createdAt FROM runs ORDER BY id DESC LIMIT 50',
      )
      .all();
    return c.json({ runs });
  });

  return app;
}
