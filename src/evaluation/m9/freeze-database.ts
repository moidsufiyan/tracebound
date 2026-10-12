import { createHash } from 'node:crypto';
import { createReadStream, existsSync, rmSync, statSync } from 'node:fs';
import { backup, DatabaseSync } from 'node:sqlite';

// Freezing a SQLite database for evaluation: a consistent copy of the source made with SQLite's
// own backup API, folded into one self-contained file (no -wal/-shm), checked read-only, and
// described by size, SHA-256 and schema version. The source is opened read-only and its bytes are
// hashed before and after, so a run can show that it did not change.
//
// A file hash is an integrity check, not authentication: it shows these are the bytes that were
// recorded, not who recorded them.

export interface FileIdentity {
  bytes: number;
  sha256: string;
}

export interface DatabaseCheck {
  userVersion: number;
  journalMode: string;
  integrityCheck: string;
  foreignKeyViolations: number;
  pageSize: number;
  pageCount: number;
}

export interface FrozenDatabase {
  source: { before: FileIdentity; after: FileIdentity; unchanged: boolean };
  frozen: FileIdentity & DatabaseCheck;
  /** Per-table row counts and content digests of the frozen file, for comparison with other copies. */
  tables: TableDigest[];
}

export interface TableDigest {
  name: string;
  rows: number;
  sha256: string;
}

export async function fileIdentity(path: string): Promise<FileIdentity> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return { bytes: statSync(path).size, sha256: hash.digest('hex') };
}

/** Opens `path` read-only and reports the structural checks. Never writes. */
export function checkDatabase(path: string): DatabaseCheck {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const one = <T>(sql: string): T => db.prepare(sql).get() as T;
    return {
      userVersion: one<{ user_version: number }>('PRAGMA user_version').user_version,
      journalMode: one<{ journal_mode: string }>('PRAGMA journal_mode').journal_mode,
      integrityCheck: db
        .prepare('PRAGMA integrity_check')
        .all()
        .map((row) => String((row as { integrity_check: unknown }).integrity_check))
        .join('; '),
      foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all().length,
      pageSize: one<{ page_size: number }>('PRAGMA page_size').page_size,
      pageCount: one<{ page_count: number }>('PRAGMA page_count').page_count,
    };
  } finally {
    db.close();
  }
}

/**
 * A digest of every table's rows in primary-key order, read-only. Two databases with equal digests
 * for a table hold the same rows there regardless of file layout, which is how a re-created or
 * re-opened copy is shown to be the same data as the source.
 */
export function tableDigests(path: string): TableDigest[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    return names.map((name) => {
      const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; pk: number }[];
      const keys = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
      const order = (keys.length > 0 ? keys : columns).map((column) => `"${column.name}"`).join(', ');
      const hash = createHash('sha256');
      let rows = 0;
      for (const row of db.prepare(`SELECT * FROM "${name}" ORDER BY ${order}`).iterate()) {
        rows += 1;
        hash.update(JSON.stringify(row, rowReplacer));
        hash.update('\n');
      }
      return { name, rows, sha256: hash.digest('hex') };
    });
  } finally {
    db.close();
  }
}

function rowReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return `blob:${Buffer.from(value).toString('base64')}`;
  if (typeof value === 'bigint') return `int:${value}`;
  return value;
}

/**
 * Copies `sourcePath` to a new file `destinationPath` and returns the evidence that the copy is a
 * complete, intact, self-contained database. The destination must not exist. The source is never
 * written: it is opened read-only, and its byte hash before and after is reported (and a change is an error).
 */
export async function freezeDatabase(sourcePath: string, destinationPath: string): Promise<FrozenDatabase> {
  if (existsSync(destinationPath)) throw new Error(`Refusing to overwrite ${destinationPath}`);
  const before = await fileIdentity(sourcePath);

  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, destinationPath);
  } finally {
    source.close();
  }

  // Fold any write-ahead log into the main file and leave the copy in rollback-journal mode, so the
  // frozen artifact is a single file that reads the same way anywhere.
  const copy = new DatabaseSync(destinationPath);
  try {
    copy.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    copy.exec('PRAGMA journal_mode = DELETE');
  } finally {
    copy.close();
  }
  for (const suffix of ['-wal', '-shm']) rmSync(`${destinationPath}${suffix}`, { force: true });

  const after = await fileIdentity(sourcePath);
  const unchanged = before.sha256 === after.sha256 && before.bytes === after.bytes;
  if (!unchanged) throw new Error('The source database file changed while it was being frozen');

  const check = checkDatabase(destinationPath);
  if (check.integrityCheck !== 'ok') throw new Error(`integrity_check failed: ${check.integrityCheck}`);
  if (check.foreignKeyViolations !== 0) throw new Error(`${check.foreignKeyViolations} foreign key violations in the frozen copy`);
  if (check.journalMode !== 'delete') throw new Error(`The frozen copy is in ${check.journalMode} mode, not delete`);
  if (existsSync(`${destinationPath}-wal`) || existsSync(`${destinationPath}-shm`)) {
    throw new Error('The frozen copy has sidecar files');
  }

  const frozen = await fileIdentity(destinationPath);
  return { source: { before, after, unchanged }, frozen: { ...frozen, ...check }, tables: tableDigests(destinationPath) };
}
