import { describe, expect, it } from 'vitest';
import { migrate, openDb } from './db.ts';

describe('migrate', () => {
  it('creates the initial schema and is idempotent', () => {
    const db = openDb(':memory:');
    expect(migrate(db)).toEqual([
      '001_init.sql',
      '002_redacted_transcripts.sql',
      '003_scoring.sql',
      '004_linking.sql',
      '005_drivers.sql',
      '006_repeat_contacts.sql',
    ]);
    expect(migrate(db)).toEqual([]);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .pluck()
      .all();
    expect(tables).toEqual(
      expect.arrayContaining([
        'customers',
        'interactions',
        'scores',
        'reclassifications',
        'surveys',
        'runs',
        'redacted_transcripts',
      ]),
    );
  });

  it('rejects an unknown channel', () => {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare("INSERT INTO customers VALUES ('c1', '2026-11-01T00:00:00Z')").run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO interactions VALUES ('i1', 'c1', 'email', '2026-11-01T00:00:00Z', '', 'billing')",
        )
        .run(),
    ).toThrow(/CHECK constraint/);
  });
});
