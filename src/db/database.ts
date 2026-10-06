import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations.js';

export type Database = DatabaseSync;

/** Opens (or creates) a database at `location` and brings its schema up to date. */
export function openDatabase(location: string): Database {
  const db = new DatabaseSync(location);
  db.exec('PRAGMA foreign_keys = ON');
  if (location !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema version ${current} is newer than this build supports (${MIGRATIONS.length})`);
  }
  for (const [index, sql] of MIGRATIONS.entries()) {
    if (index < current) continue;
    inTransaction(db, () => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${index + 1}`);
    });
  }
}

/**
 * Runs `work` inside a write transaction. `work` must be synchronous: an awaited
 * transaction on a shared connection would absorb unrelated writes made meanwhile.
 */
export function inTransaction<T>(db: Database, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
