import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkDatabase, fileIdentity, freezeDatabase, tableDigests } from '../src/evaluation/m9/freeze-database.js';
import { openDatabase } from '../src/db/database.js';
import { createProject } from '../src/projects/projects.js';

let dir: string;
let source: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tracebound-m9-freeze-'));
  source = join(dir, 'source.sqlite');
  // A WAL-mode database with committed data that may still live in the -wal file.
  const db = openDatabase(source);
  createProject(db, 'pilot');
  createProject(db, 'second');
  db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('freezeDatabase', () => {
  it('copies a WAL-mode source into one self-contained, checked file and leaves the source bytes alone', async () => {
    const before = await fileIdentity(source);
    const destination = join(dir, 'frozen.sqlite');
    const result = await freezeDatabase(source, destination);

    expect(result.source.unchanged).toBe(true);
    expect((await fileIdentity(source)).sha256).toBe(before.sha256);
    expect(result.frozen.journalMode).toBe('delete');
    expect(result.frozen.integrityCheck).toBe('ok');
    expect(result.frozen.foreignKeyViolations).toBe(0);
    expect(result.frozen.userVersion).toBeGreaterThan(0);
    expect(existsSync(`${destination}-wal`)).toBe(false);
    expect(existsSync(`${destination}-shm`)).toBe(false);
    expect(result.frozen.sha256).toBe((await fileIdentity(destination)).sha256);
    expect(result.frozen.bytes).toBe(readFileSync(destination).length);

    // The same rows, table by table, even though the files are laid out differently.
    expect(result.tables).toEqual(tableDigests(source));
    expect(result.tables.find((table) => table.name === 'project')?.rows).toBe(2);
  });

  it('refuses to overwrite an existing destination', async () => {
    const destination = join(dir, 'frozen.sqlite');
    writeFileSync(destination, 'occupied');
    await expect(freezeDatabase(source, destination)).rejects.toThrow(/overwrite/);
    expect(readFileSync(destination, 'utf8')).toBe('occupied');
  });

  it('gives different table digests when a row differs', async () => {
    const destination = join(dir, 'frozen.sqlite');
    const { tables } = await freezeDatabase(source, destination);
    const edit = new DatabaseSync(destination);
    edit.exec("UPDATE project SET name = 'renamed' WHERE id = 1");
    edit.close();
    const changed = tableDigests(destination);
    expect(changed.find((table) => table.name === 'project')?.sha256).not.toBe(tables.find((table) => table.name === 'project')?.sha256);
    expect(changed.find((table) => table.name === 'repository')?.sha256).toBe(tables.find((table) => table.name === 'repository')?.sha256);
  });

  it('reports a corrupt file instead of passing it', () => {
    const bad = join(dir, 'bad.sqlite');
    writeFileSync(bad, Buffer.alloc(8192, 7));
    expect(() => checkDatabase(bad)).toThrow();
  });
});
