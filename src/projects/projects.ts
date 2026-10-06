import { resolve } from 'node:path';
import type { Database } from '../db/database.js';
import { verifyGitRepository } from '../git/git.js';

export interface Project {
  id: number;
  name: string;
  createdAt: string;
}

export interface Repository {
  id: number;
  projectId: number;
  name: string;
  /** Absolute path of the local Git repository that snapshots are read from. */
  sourcePath: string;
  createdAt: string;
}

export class NotFoundError extends Error {
  constructor(entity: string, id: number) {
    super(`${entity} ${id} does not exist`);
    this.name = 'NotFoundError';
  }
}

interface ProjectRow {
  id: number;
  name: string;
  created_at: string;
}

interface RepositoryRow {
  id: number;
  project_id: number;
  name: string;
  source_path: string;
  created_at: string;
}

export function createProject(db: Database, name: string): Project {
  const row = db
    .prepare('INSERT INTO project (name, created_at) VALUES (?, ?) RETURNING *')
    .get(name.trim(), new Date().toISOString()) as unknown as ProjectRow;
  return toProject(row);
}

export function getProject(db: Database, id: number): Project | undefined {
  const row = db.prepare('SELECT * FROM project WHERE id = ?').get(id) as ProjectRow | undefined;
  return row && toProject(row);
}

/** Registers a local Git repository under a project. The repository is only ever read. */
export async function registerRepository(
  db: Database,
  input: { projectId: number; name: string; sourcePath: string },
): Promise<Repository> {
  const sourcePath = resolve(input.sourcePath);
  await verifyGitRepository(sourcePath);
  if (!getProject(db, input.projectId)) throw new NotFoundError('Project', input.projectId);

  const row = db
    .prepare('INSERT INTO repository (project_id, name, source_path, created_at) VALUES (?, ?, ?, ?) RETURNING *')
    .get(input.projectId, input.name.trim(), sourcePath, new Date().toISOString()) as unknown as RepositoryRow;
  return toRepository(row);
}

export function getRepository(db: Database, id: number): Repository | undefined {
  const row = db.prepare('SELECT * FROM repository WHERE id = ?').get(id) as RepositoryRow | undefined;
  return row && toRepository(row);
}

function toProject(row: ProjectRow): Project {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

function toRepository(row: RepositoryRow): Repository {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    sourcePath: row.source_path,
    createdAt: row.created_at,
  };
}
