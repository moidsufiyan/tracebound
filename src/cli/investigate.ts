import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { indexSnapshotStructurally, isSnapshotStructurallyIndexed } from '../analysis/structural-index.js';
import { openDatabase, type Database } from '../db/database.js';
import { InvalidCommitShaError } from '../git/git.js';
import { ingestSnapshot } from '../ingestion/ingest-snapshot.js';
import { changedPathsOf, resolveCommitRange } from '../investigation/change-set.js';
import { investigateChange } from '../investigation/investigate.js';
import { renderInvestigationMarkdown } from '../investigation/render.js';
import { createProject, registerRepository } from '../projects/projects.js';
import { createOllamaReasoningProvider } from '../reasoning/ollama-reasoning-provider.js';
import type { ReasoningProvider } from '../reasoning/provider.js';
import { indexSnapshotLexically, isSnapshotLexicallyIndexed } from '../retrieval/lexical-index.js';
import { createOllamaEmbeddingProvider } from '../semantic/ollama-provider.js';
import { EmbeddingInputTooLongError, EmbeddingProviderError, type EmbeddingProvider } from '../semantic/provider.js';
import { indexSnapshotSemantically, isSnapshotSemanticallyIndexed } from '../semantic/semantic-index.js';

// `tracebound-investigate`: investigate one change in one repository snapshot and print the report.
//
//   node dist/cli/investigate.js --db <file> --description <text>
//     ( --snapshot <id> [--changed <path>]...
//     | --repo <path> --commit <full sha> [--changed <path>]...
//     | --repo <path> --base <full sha> --head <full sha> )
//     [--symbol <name>]... [--limit <n>]
//     [--format markdown|json] [--out <file>] [--json-out <file>] [--ollama <url>]
//     [--reasoning-model <name> --reasoning-max-input-chars <n> [--reasoning-context-tokens <n>] [--reasoning-timeout-ms <n>]]
//
// With --repo and --commit the commit is ingested and indexed if it is not already (commits are
// named by full SHA only; refs are never resolved). With --repo, --base and --head the changed
// paths are derived from the diff of the two commits (the base must be an ancestor of the head),
// and the change is investigated in the base snapshot, the state before the change. Missing indexes are built, which for the
// semantic index embeds the whole snapshot. The impact assessment runs only when a reasoning model
// is named; without one, the report describes the evidence alone. --json-out also writes the JSON
// report of the same run, so the Markdown and the JSON always describe one retrieval.

export const USAGE = `Usage: tracebound-investigate --db <file> --description <text>
  (--snapshot <id> [--changed <path>]... | --repo <path> --commit <full sha> [--changed <path>]... | --repo <path> --base <full sha> --head <full sha>)
  [--symbol <name>]... [--limit <n>] [--format markdown|json] [--out <file>] [--json-out <file>]
  [--ollama <url>] [--reasoning-model <name> --reasoning-max-input-chars <n> [--reasoning-context-tokens <n>] [--reasoning-timeout-ms <n>]]`;

export interface CliDependencies {
  createEmbedder: (endpoint: string | undefined) => Promise<EmbeddingProvider>;
  createReasoner: (options: { model: string; maxInputChars: number; endpoint?: string; contextTokens?: number; timeoutMs?: number }) => Promise<ReasoningProvider>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const DEFAULT_DEPENDENCIES: CliDependencies = {
  createEmbedder: (endpoint) => createOllamaEmbeddingProvider(endpoint ? { endpoint } : {}),
  createReasoner: (options) => createOllamaReasoningProvider(options),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

class UsageError extends Error {}

/** Runs the command and returns its exit code: 0 for a report, 1 for an error, 2 for a usage error. */
export async function runInvestigateCli(argv: readonly string[], dependencies: Partial<CliDependencies> = {}): Promise<number> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  let db: Database | undefined;
  try {
    const args = parse(argv);
    db = openDatabase(args.db);
    const embedder = await deps.createEmbedder(args.ollama);
    // A commit range is validated and diffed before anything is ingested.
    const range = args.base !== undefined ? await resolveCommitRange(resolve(args.repo!), args.base, args.head!) : undefined;
    if (range) deps.stderr(`Derived ${range.changes.length} file change${range.changes.length === 1 ? '' : 's'} from ${range.base}..${range.head}
`);
    const changedPaths = range ? changedPathsOf(range) : args.changed;
    const snapshotId = args.snapshot ?? (await ingest(db, args.repo!, range ? range.base : args.commit!, args.project, deps.stderr));
    await ensureIndexes(db, snapshotId, embedder, deps.stderr);
    const reasoning = args.reasoningModel
      ? await deps.createReasoner({
          model: args.reasoningModel,
          maxInputChars: args.reasoningMaxInputChars!,
          ...(args.ollama ? { endpoint: args.ollama } : {}),
          ...(args.reasoningContextTokens !== undefined ? { contextTokens: args.reasoningContextTokens } : {}),
          ...(args.reasoningTimeoutMs !== undefined ? { timeoutMs: args.reasoningTimeoutMs } : {}),
        })
      : undefined;
    const report = await investigateChange(
      db,
      snapshotId,
      embedder,
      { description: args.description, changedPaths, ...(args.symbols.length ? { symbols: args.symbols } : {}) },
      { ...(args.limit !== undefined ? { limit: args.limit } : {}), ...(reasoning ? { reasoning } : {}), ...(range ? { commitRange: range } : {}) },
    );
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const text = args.format === 'json' ? json : renderInvestigationMarkdown(report);
    if (args.out) {
      writeFileSync(args.out, text);
      deps.stderr(`Report written to ${args.out}\n`);
    } else {
      deps.stdout(text);
    }
    if (args.jsonOut) {
      writeFileSync(args.jsonOut, json);
      deps.stderr(`JSON report written to ${args.jsonOut}\n`);
    }
    if (report.reasoning.status === 'rejected' || report.reasoning.status === 'failed') {
      deps.stderr(`Impact assessment ${report.reasoning.status}; the report shows the evidence without classifications.\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`${error.message}\n${USAGE}\n`);
      return 2;
    }
    deps.stderr(`error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
    const hint = hintFor(error);
    if (hint) deps.stderr(`hint: ${hint}\n`);
    return 1;
  } finally {
    db?.close();
  }
}

interface Args {
  db: string;
  snapshot: number | undefined;
  repo: string | undefined;
  commit: string | undefined;
  base: string | undefined;
  head: string | undefined;
  project: string;
  description: string;
  changed: string[];
  symbols: string[];
  limit: number | undefined;
  format: 'markdown' | 'json';
  out: string | undefined;
  jsonOut: string | undefined;
  ollama: string | undefined;
  reasoningModel: string | undefined;
  reasoningMaxInputChars: number | undefined;
  reasoningContextTokens: number | undefined;
  reasoningTimeoutMs: number | undefined;
}

function parse(argv: readonly string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        db: { type: 'string' },
        snapshot: { type: 'string' },
        repo: { type: 'string' },
        commit: { type: 'string' },
        base: { type: 'string' },
        head: { type: 'string' },
        project: { type: 'string' },
        description: { type: 'string' },
        changed: { type: 'string', multiple: true },
        symbol: { type: 'string', multiple: true },
        limit: { type: 'string' },
        format: { type: 'string' },
        out: { type: 'string' },
        'json-out': { type: 'string' },
        ollama: { type: 'string' },
        'reasoning-model': { type: 'string' },
        'reasoning-max-input-chars': { type: 'string' },
        'reasoning-context-tokens': { type: 'string' },
        'reasoning-timeout-ms': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (!values.db) throw new UsageError('--db is required');
  if (!values.description || values.description.trim() === '') throw new UsageError('--description is required');
  // Exactly one way of naming the snapshot: --snapshot; --repo with --commit; or --repo with --base and --head.
  const bySnapshot = values.snapshot !== undefined;
  const byCommit = values.commit !== undefined;
  const byRange = values.base !== undefined || values.head !== undefined;
  if ([bySnapshot, byCommit, byRange].filter(Boolean).length !== 1) {
    throw new UsageError('Give exactly one of: --snapshot; --repo with --commit; --repo with --base and --head');
  }
  if (bySnapshot && values.repo !== undefined) throw new UsageError('--repo cannot be used with --snapshot');
  if ((byCommit || byRange) && values.repo === undefined) throw new UsageError(`--repo is required with ${byCommit ? '--commit' : '--base and --head'}`);
  if (byRange && (values.base === undefined || values.head === undefined)) throw new UsageError('--base and --head go together');
  if (byRange && values.changed !== undefined) throw new UsageError('--changed cannot be used with --base and --head: the changed paths are derived from the commits');
  const format = values.format ?? 'markdown';
  if (format !== 'markdown' && format !== 'json') throw new UsageError('--format must be markdown or json');
  const model = values['reasoning-model'];
  const budget = positiveInteger(values['reasoning-max-input-chars'], '--reasoning-max-input-chars');
  if ((model === undefined) !== (budget === undefined)) throw new UsageError('--reasoning-model and --reasoning-max-input-chars go together');
  const jsonOut = values['json-out'];
  if (values.out !== undefined && jsonOut !== undefined && resolve(values.out) === resolve(jsonOut)) throw new UsageError('--out and --json-out must name different files');
  // Checked before anything runs: building the semantic index of a new snapshot can take minutes.
  for (const [flag, file] of [['--out', values.out], ['--json-out', jsonOut]] as const) {
    if (file !== undefined && !existsSync(dirname(resolve(file)))) throw new UsageError(`${flag}: the directory ${dirname(resolve(file))} does not exist`);
  }
  return {
    db: values.db,
    snapshot: positiveInteger(values.snapshot, '--snapshot'),
    repo: values.repo,
    commit: values.commit,
    base: values.base,
    head: values.head,
    project: values.project ?? 'default',
    description: values.description,
    changed: values.changed ?? [],
    symbols: values.symbol ?? [],
    limit: positiveInteger(values.limit, '--limit'),
    format,
    out: values.out,
    jsonOut,
    ollama: values.ollama,
    reasoningModel: model,
    reasoningMaxInputChars: budget,
    reasoningContextTokens: positiveInteger(values['reasoning-context-tokens'], '--reasoning-context-tokens'),
    reasoningTimeoutMs: positiveInteger(values['reasoning-timeout-ms'], '--reasoning-timeout-ms'),
  };
}

function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${name} must be a positive integer`);
  return n;
}

/** What the user can do about an error whose message alone does not say. */
function hintFor(error: unknown): string | undefined {
  if (error instanceof InvalidCommitShaError) {
    return 'name commits by their full id: `git -C <repo> rev-parse <ref>` prints it, and `git -C <repo> rev-parse <sha>^` prints the parent of a commit.';
  }
  if (error instanceof EmbeddingProviderError && !(error instanceof EmbeddingInputTooLongError)) {
    return 'the semantic index needs a local Ollama server with nomic-embed-text:v1.5: start Ollama, run `ollama pull nomic-embed-text:v1.5`, or name the server with --ollama <url>.';
  }
  return undefined;
}

/** The ready snapshot of `commit` in the repository at `repoPath`, registering and ingesting as needed. */
async function ingest(db: Database, repoPath: string, commit: string, projectName: string, log: (text: string) => void): Promise<number> {
  const sourcePath = resolve(repoPath);
  let repositoryId = (db.prepare('SELECT id FROM repository WHERE source_path = ?').get(sourcePath) as { id: number } | undefined)?.id;
  if (repositoryId === undefined) {
    const project = (db.prepare('SELECT id FROM project WHERE name = ?').get(projectName) as { id: number } | undefined)?.id ?? createProject(db, projectName).id;
    repositoryId = (await registerRepository(db, { projectId: project, name: basename(sourcePath), sourcePath })).id;
    log(`Registered repository ${sourcePath}\n`);
  }
  const result = await ingestSnapshot(db, repositoryId, commit);
  log(`${result.created ? 'Ingested' : 'Using'} snapshot ${result.snapshot.id} of ${result.snapshot.commitSha}\n`);
  return result.snapshot.id;
}

async function ensureIndexes(db: Database, snapshotId: number, embedder: EmbeddingProvider, log: (text: string) => void): Promise<void> {
  if (!isSnapshotLexicallyIndexed(db, snapshotId)) {
    indexSnapshotLexically(db, snapshotId);
    log(`Built the lexical index of snapshot ${snapshotId}\n`);
  }
  if (!isSnapshotStructurallyIndexed(db, snapshotId)) {
    indexSnapshotStructurally(db, snapshotId);
    log(`Built the structural index of snapshot ${snapshotId}\n`);
  }
  if (!isSnapshotSemanticallyIndexed(db, snapshotId, embedder)) {
    log(`Building the semantic index of snapshot ${snapshotId} with ${embedder.modelId} (embeds every included file)\n`);
    await indexSnapshotSemantically(db, snapshotId, embedder);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runInvestigateCli(process.argv.slice(2));
}
