import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import {
  DEFAULT_PROMPT_VERSION,
  loadConfig,
  loadDotEnv,
  openDb,
  requireModel,
  type Db,
} from '@nrs/pipeline';
import { createApp } from './app.ts';

loadDotEnv();
const config = loadConfig();
// The dashboard shows scores for ANTHROPIC_MODEL (demo: ANTHROPIC_MODEL=demo-answer-key).
const settings = { model: requireModel(config), promptVersion: DEFAULT_PROMPT_VERSION };
const port = Number(process.env.NRS_API_PORT ?? 5151);

let db: Db | null = null;
function getDb(): Db | null {
  if (!db && existsSync(config.dbPath)) db = openDb(config.dbPath, { readonly: true });
  return db;
}

serve({ fetch: createApp(getDb, settings).fetch, port }, () => {
  console.log(`API on http://localhost:${port}/api (model ${settings.model}, db ${config.dbPath})`);
});
