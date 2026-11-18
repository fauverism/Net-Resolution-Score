import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../db.ts';
import type { SeedData } from './generate.ts';

/** Replaces all data in the db with the seed set and writes the hidden labels to `groundTruthPath`. */
export function writeSeed(db: Db, data: SeedData, groundTruthPath: string): void {
  db.transaction(() => {
    for (const t of [
      'scores',
      'reclassifications',
      'surveys',
      'runs',
      'interactions',
      'customers',
    ]) {
      db.prepare(`DELETE FROM ${t}`).run();
    }
    const customer = db.prepare('INSERT INTO customers (id, created_at) VALUES (?, ?)');
    for (const c of data.customers) customer.run(c.id, c.createdAt);

    const interaction = db.prepare(
      `INSERT INTO interactions (id, customer_id, channel, started_at, transcript, business_line)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const i of data.interactions) {
      interaction.run(i.id, i.customerId, i.channel, i.startedAt, i.transcript, i.businessLine);
    }

    const survey = db.prepare(
      'INSERT INTO surveys (customer_id, nps_score, responded_at) VALUES (?, ?, ?)',
    );
    for (const s of data.surveys) survey.run(s.customerId, s.npsScore, s.respondedAt);
  })();

  mkdirSync(path.dirname(groundTruthPath), { recursive: true });
  writeFileSync(groundTruthPath, `${JSON.stringify(data.groundTruth, null, 1)}\n`);
}
