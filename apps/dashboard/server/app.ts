import {
  DrillQuerySchema,
  DrillResponseSchema,
  InteractionDetailSchema,
  MetaResponseSchema,
  PeriodQuerySchema,
  SummaryResponseSchema,
} from '@nrs/core';
import type { Db } from '@nrs/pipeline';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { drill, HttpError, interaction, meta, summary, type Settings } from './data.ts';

/**
 * Read-only API for the dashboard. Every request is validated with Zod, and every
 * response is validated against the shared schema before it's sent.
 * `getDb` returns null until the db exists (run `npm run seed`).
 */
export function createApp(getDb: () => Db | null, settings: Settings) {
  const app = new Hono().basePath('/api');

  const withDb = (c: Context, fn: (db: Db) => unknown) => {
    const db = getDb();
    if (!db) return c.json({ error: 'No data yet. Run `npm run seed`.' }, 503);
    try {
      return c.json(fn(db));
    } catch (err) {
      if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
      if (err instanceof z.ZodError) return c.json({ error: z.prettifyError(err) }, 400);
      if (err instanceof Error && /--from|--to|YYYY-MM-DD/.test(err.message)) {
        return c.json({ error: err.message.replace(/--/g, '') }, 400);
      }
      throw err;
    }
  };

  app.get('/health', (c) => c.json({ ok: true, db: getDb() ? 'ready' : 'missing' }));

  app.get('/meta', (c) => withDb(c, (db) => MetaResponseSchema.parse(meta(db, settings))));

  app.get('/summary', (c) =>
    withDb(c, (db) =>
      SummaryResponseSchema.parse(summary(db, settings, PeriodQuerySchema.parse(c.req.query()))),
    ),
  );

  app.get('/drill', (c) =>
    withDb(c, (db) =>
      DrillResponseSchema.parse(drill(db, settings, DrillQuerySchema.parse(c.req.query()))),
    ),
  );

  app.get('/interactions/:id', (c) =>
    withDb(c, (db) => {
      const id = z
        .string()
        .regex(/^[A-Za-z0-9_:-]{1,64}$/)
        .parse(c.req.param('id'));
      return InteractionDetailSchema.parse(interaction(db, settings, id));
    }),
  );

  return app;
}
