import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS_DIR } from './paths.ts';

export type Db = Database.Database;

export function openDb(dbPath: string, opts: { readonly?: boolean } = {}): Db {
  if (dbPath !== ':memory:' && !opts.readonly) mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, {
    readonly: opts.readonly ?? false,
    fileMustExist: opts.readonly ?? false,
  });
  if (!opts.readonly) db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Applies any unapplied migrations/*.sql in filename order. Returns the names applied. */
export function migrate(db: Db, dir: string = MIGRATIONS_DIR): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').pluck().all() as string[],
  );
  const pending = readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && !applied.has(f))
    .sort();
  const record = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)');
  for (const name of pending) {
    db.transaction(() => {
      db.exec(readFileSync(path.join(dir, name), 'utf8'));
      record.run(name);
    })();
  }
  return pending;
}
