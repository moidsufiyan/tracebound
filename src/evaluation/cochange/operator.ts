import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createOllamaEmbeddingProvider, type OllamaEmbeddingProvider } from '../../semantic/ollama-provider.js';
import { EmbeddingProviderError } from '../../semantic/provider.js';
import { EMBEDDING_PIN, matchEmbeddingPin, validateEmbeddingPin, type EmbeddingPin } from './embedding-pin.js';
import { runEvaluation, type EvaluationDependencies, type EvaluationResult } from './evaluate.js';
import { validateHeader } from './journal.js';
import type { LockAcquisition } from './lock.js';
import { canonicalPath, checkPublicationSource, isWithin, WORK_FILES, type PreflightDependencies, type PreflightResult } from './preflight.js';
import { runPreparation, type PreparationDependencies, type PreparationResult } from './prepare.js';
import { publishResults, type PublishDependencies, type PublishResult } from './publish.js';

// The operator entry point of the co-change evaluation (scripts/evaluation/cochange/run.mjs): one
// command per phase, each a call of the phase's production function with explicit configuration.
// It adds only what the phases cannot know themselves: the paths and endpoint given on the command
// line, checked before anything is created; the embedding pin (embedding-pin.ts), checked against
// the installed model before a preparation or evaluation starts; and, before publishing, that the
// checkout is still the commit and build the evaluation ran with. Readiness, locking, journal
// recovery and the no-overwrite rules are the phases' own. See docs/evaluation/cochange/operate.md.

export const EXIT_CODES = Object.freeze({
  done: 0,
  // 1 is left to Node: an uncaught error.
  usage: 2,
  refused: 3,
  locked: 4,
  stopped: 5,
  invalid: 6,
});

const COMMANDS = {
  prepare: ['repo', 'work', 'ollama'],
  evaluate: ['repo', 'work', 'ollama'],
  publish: ['repo', 'work', 'out'],
} as const;
type Command = keyof typeof COMMANDS;
type Option = (typeof COMMANDS)[Command][number];

export const USAGE = `Usage: npm run cochange -- <command> <options>

Commands, in this order; each refuses to run before the previous one has finished:
  prepare   --repo <got clone> --work <work directory> --ollama <url>
            Ingests and indexes every base snapshot, then freezes the database. Rerun to resume.
  evaluate  --repo <got clone> --work <work directory> --ollama <url>
            Records every method's rankings for every selected commit. Rerun to resume.
  publish   --repo <got clone> --work <work directory> --out <existing directory>
            Writes results.json and report.md for a complete evaluation; never overwrites.

Exit codes: 0 done; 1 internal error; 2 usage or configuration error; 3 refused, nothing done;
4 work directory locked; 5 stopped before finishing; 6 the recorded evaluation is invalid.
Guide: docs/evaluation/cochange/operate.md`;

export interface OperatorEnvironment {
  /** The Tracebound checkout whose build is running. */
  traceboundRoot: string;
  /** Relative paths are resolved against it; the process's working directory by default. */
  cwd?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export interface OperatorDependencies extends PreflightDependencies {
  /** For tests: the fetch the Ollama provider uses. */
  fetch?: typeof fetch;
  /** For tests: replaces the tracked pin. */
  pin?: EmbeddingPin | null;
  /** For tests: hooks and replacements passed to one phase. */
  preparation?: Omit<PreparationDependencies, keyof PreflightDependencies>;
  evaluation?: Omit<EvaluationDependencies, keyof PreflightDependencies>;
  publication?: Pick<PublishDependencies, 'beforeLink'>;
}

class UsageError extends Error {}

interface Configuration {
  command: Command;
  repo: string;
  work: string;
  ollama?: string;
  out?: string;
}

/** Runs one operator command and returns the process exit code. */
export async function runOperator(argv: readonly string[], environment: OperatorEnvironment, dependencies: OperatorDependencies = {}): Promise<number> {
  const out = environment.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = environment.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (argv.includes('--help') || argv.includes('-h')) {
    out(USAGE);
    return EXIT_CODES.done;
  }
  let config: Configuration;
  try {
    config = configure(argv, environment);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(error.message);
    err('Run with --help for usage.');
    return EXIT_CODES.usage;
  }

  const { fetch: fetchImpl, pin, preparation, evaluation, publication, ...preflight } = dependencies;
  const root = environment.traceboundRoot;
  if (config.command === 'publish') return publish(config, root, { ...preflight, ...publication }, out, err);

  const pinned = await pinnedProvider(config.ollama!, pin === undefined ? EMBEDDING_PIN : pin, fetchImpl, out, err);
  if (typeof pinned === 'number') return pinned;
  // The phases compare the provider with this expected id again; it comes from the pin, never from the provider.
  const request = { traceboundRoot: root, repositoryPath: config.repo, workDirectory: config.work, embeddingModelId: pinned.pin.modelId, provider: pinned.provider };
  if (config.command === 'prepare') return reportPreparation(await runPreparation(request, { ...preflight, ...preparation }), out, err);
  return reportEvaluation(await runEvaluation(request, { ...preflight, ...evaluation }), out, err);
}

// ---------------------------------------------------------------------------------------------
// Configuration

function configure(argv: readonly string[], environment: OperatorEnvironment): Configuration {
  const [command, ...rest] = argv;
  if (command === undefined) throw new UsageError('No command given.');
  if (!Object.hasOwn(COMMANDS, command)) throw new UsageError(`Unknown command ${JSON.stringify(command)}.`);
  const wanted: readonly Option[] = COMMANDS[command as Command];
  const options = new Map<Option, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    const name = flag.slice(2) as Option;
    if (!flag.startsWith('--') || !wanted.includes(name)) throw new UsageError(`${command} does not take ${JSON.stringify(flag)}; it takes ${wanted.map((o) => `--${o}`).join(', ')}.`);
    if (options.has(name)) throw new UsageError(`${flag} is given twice.`);
    const value = rest[i + 1];
    if (value === undefined || value.length === 0 || value.startsWith('--')) throw new UsageError(`${flag} needs a value.`);
    options.set(name, value);
  }
  const missing = wanted.filter((o) => !options.has(o));
  if (missing.length > 0) throw new UsageError(`${command} needs ${missing.map((o) => `--${o}`).join(', ')}.`);

  const cwd = environment.cwd ?? process.cwd();
  const path = (name: Option) => resolve(cwd, options.get(name)!);
  const config: Configuration = { command: command as Command, repo: path('repo'), work: path('work') };
  // Checked on the resolved text, before any filesystem access: a network path can block for a long time.
  if (config.work.startsWith('\\\\') || config.work.startsWith('//')) throw new UsageError(`The work directory ${config.work} is a network path; it must be on a local disk, where the run lock is reliable.`);
  if (!existsSync(config.repo) || !statSync(config.repo).isDirectory()) throw new UsageError(`The repository ${config.repo} is not a directory.`);
  if (existsSync(config.work) && !statSync(config.work).isDirectory()) throw new UsageError(`The work directory ${config.work} is not a directory.`);
  const work = canonicalPath(config.work);
  for (const [label, other] of [
    ['the Tracebound checkout', environment.traceboundRoot],
    ['the dataset repository', config.repo],
  ] as const) {
    const canonical = canonicalPath(other);
    if (isWithin(work, canonical) || isWithin(canonical, work)) throw new UsageError(`The work directory ${work} and ${label} ${canonical} must not contain one another.`);
  }
  if (options.has('out')) config.out = path('out');
  if (options.has('ollama')) {
    const url = URL.canParse(options.get('ollama')!) ? new URL(options.get('ollama')!) : null;
    if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) throw new UsageError(`--ollama must be an http or https URL, got ${JSON.stringify(options.get('ollama'))}.`);
    config.ollama = options.get('ollama')!;
  }
  return config;
}

/** The Ollama provider, once its installed model is shown to be the pinned build; otherwise the exit code. */
async function pinnedProvider(
  endpoint: string,
  configured: EmbeddingPin | null,
  fetchImpl: typeof fetch | undefined,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<{ pin: EmbeddingPin; provider: OllamaEmbeddingProvider } | number> {
  const pin = validateEmbeddingPin(configured);
  if (pin.status !== 'valid') {
    err(`Configuration: ${pin.detail}. Nothing was started.`);
    return EXIT_CODES.usage;
  }
  let provider: OllamaEmbeddingProvider;
  try {
    provider = await createOllamaEmbeddingProvider({ endpoint, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  } catch (error) {
    if (!(error instanceof EmbeddingProviderError)) throw error;
    err(`The embedding provider cannot be used: ${error.message}. Nothing was started.`);
    return EXIT_CODES.refused;
  }
  const match = matchEmbeddingPin(pin.pin, provider);
  if (match.status !== 'verified') {
    err(`${match.detail}. Nothing was started; no other model is ever substituted.`);
    return EXIT_CODES.refused;
  }
  out(`Embedding model ${provider.modelId} matches the pinned weights digest.`);
  return { pin: pin.pin, provider };
}

// ---------------------------------------------------------------------------------------------
// Phases

function reportPreparation(result: PreparationResult, out: (line: string) => void, err: (line: string) => void): number {
  switch (result.status) {
    case 'prepared':
      out(`Preparation complete: ${result.bases} bases, ${result.succeeded} succeeded, ${result.failed} failed; ${result.recordedThisRun} recorded by this run${result.recoveredTornTail ? ' after recovering a torn journal tail' : ''}.`);
      out(`Frozen database SHA-256 ${result.frozen.sha256}; ${result.frozen.identityFile} SHA-256 ${result.frozen.identitySha256}.`);
      if (result.failed > 0) out(`The commits of the ${result.failed} failed bases will have their primary methods recorded as failed; the outcome will be Inconclusive (protocol section 6, rule 1).`);
      out('Next: evaluate.');
      return EXIT_CODES.done;
    case 'locked':
      return reportLock(result.lock, err);
    case 'refused':
      if (result.reason === 'frozen-database-exists') {
        err(`Preparation has already finished in this work directory (${WORK_FILES.frozenDatabase} and ${WORK_FILES.freezeIdentity} exist); it is never run again. Next: evaluate, which verifies both.`);
        return EXIT_CODES.refused;
      }
      err(`Preparation refused (${result.reason}): ${result.detail}`);
      if (result.frozenInspection) {
        const f = result.frozenInspection;
        err(`  ${WORK_FILES.frozenDatabase}: SHA-256 ${f.sha256}, ${f.bytes} bytes, integrity ${f.integrityCheck ?? 'not checked'}, same rows as the working database: ${f.sameRowsAsWorkingDatabase ?? 'unknown'}${f.error ? `, error: ${f.error}` : ''}`);
      }
      reportPreflight(result.preflight, err);
      return EXIT_CODES.refused;
    case 'stopped':
      err(`Preparation stopped (${result.reason}) after recording ${result.recordedThisRun} bases: ${result.detail}`);
      if (result.reason === 'provider-unavailable') err('Recorded bases are never prepared again; run prepare again to continue with the rest.');
      return EXIT_CODES.stopped;
  }
}

function reportEvaluation(result: EvaluationResult, out: (line: string) => void, err: (line: string) => void): number {
  switch (result.status) {
    case 'executed-complete':
    case 'executed-primary-incomplete':
      out(`Evaluation complete: ${result.commits} commits recorded, ${result.recordedThisRun} by this run${result.recoveredTornTail ? ' after recovering a torn journal tail' : ''}.`);
      if (result.status === 'executed-complete') out('Every primary method and the sibling heuristic ran on every commit.');
      else {
        const failed = [...new Set([...result.primaryFailedCommits, ...result.siblingFailedCommits])];
        out(`A primary method or the sibling heuristic failed on ${failed.length} commits (${abbreviate(failed)}); the outcome will be Inconclusive (protocol section 6, rule 1). Failures are never retried.`);
      }
      if (result.sensitivityFailedCommits.length > 0) out(`The no-description arm failed on ${result.sensitivityFailedCommits.length} commits (descriptive only).`);
      out(`Evaluation journal SHA-256 ${result.journalSha256}. Next: publish.`);
      return EXIT_CODES.done;
    case 'locked':
      return reportLock(result.lock, err);
    case 'refused':
      err(`Evaluation refused (${result.reason}): ${result.detail}`);
      reportPreflight(result.preflight, err);
      return EXIT_CODES.refused;
    case 'stopped':
      err(`Evaluation stopped (${result.reason}) after recording ${result.recordedThisRun} commits: ${result.detail}`);
      if (result.reason === 'provider-unavailable') err('Recorded commits are never evaluated again; run evaluate again to continue with the rest.');
      return EXIT_CODES.stopped;
    case 'invalid':
      err(`The evaluation journal does not verify: ${result.detail}. It is not a result and cannot be published.`);
      return EXIT_CODES.invalid;
  }
}

async function publish(config: Configuration, root: string, dependencies: PreflightDependencies & PublishDependencies, out: (line: string) => void, err: (line: string) => void): Promise<number> {
  const changed = await sourceChangedSinceEvaluation(root, config.work, dependencies);
  if (changed.length > 0) {
    err('Publication refused: the checkout is not what the evaluation ran with.');
    for (const line of changed) err(`  ${line}`);
    err('Publish from the evaluated commit and build. A different commit is a different evaluation identity: it needs a new work directory and a new run.');
    return EXIT_CODES.refused;
  }
  const result: PublishResult = await publishResults(
    { workDirectory: config.work, repositoryPath: config.repo, outputDirectory: config.out!, manifestPath: join(root, 'docs', 'evaluation', 'cochange', 'manifest.json') },
    dependencies,
  );
  switch (result.status) {
    case 'published':
      out(`Published: outcome ${result.outcome}, results ${result.resultsStatus}.`);
      for (const a of result.artifacts) out(`  ${a.name}: ${a.action}, ${a.bytes} bytes, SHA-256 ${a.sha256}`);
      return EXIT_CODES.done;
    case 'locked':
      return reportLock(result.lock, err);
    case 'refused':
      err(`Publication refused (${result.reason}): ${result.detail}`);
      if (result.reason === 'evaluation-incomplete' || result.reason === 'evaluation-journal-missing' || result.reason === 'evaluation-journal-interrupted') {
        err('Run evaluate until it reports the evaluation complete, then publish.');
      }
      return EXIT_CODES.refused;
  }
}

/**
 * What differs between the checkout and the identity in the evaluation journal's header: commit, build and
 * Node version. Empty when they agree, and also when there is no readable header, which the publication
 * itself then refuses.
 */
async function sourceChangedSinceEvaluation(root: string, workDirectory: string, dependencies: PreflightDependencies): Promise<string[]> {
  const journal = join(canonicalPath(workDirectory), WORK_FILES.evaluationJournal);
  if (!existsSync(journal)) return [];
  let header: ReturnType<typeof validateHeader>;
  try {
    header = validateHeader(JSON.parse(readFileSync(journal, 'utf8').split('\n', 1)[0]!));
  } catch {
    return [];
  }
  if (header.phase !== 'evaluation') return [];
  const source = await checkPublicationSource(root, dependencies);
  if (source.status === 'refused') return source.problems.map((p) => `${p.code}: ${p.detail}`);
  const nodeVersion = dependencies.nodeVersion ?? process.version;
  return [
    ...(source.commit === header.tracebound.commit ? [] : [`commit ${source.commit} is checked out; the evaluation ran at ${header.tracebound.commit}`]),
    ...(source.buildSha256 === header.tracebound.buildSha256 ? [] : [`build ${source.buildSha256} is not the evaluated build ${header.tracebound.buildSha256}`]),
    ...(nodeVersion === header.nodeVersion ? [] : [`Node ${nodeVersion} is running; the evaluation ran on ${header.nodeVersion}`]),
  ];
}

// ---------------------------------------------------------------------------------------------
// Diagnostics

function reportLock(lock: Exclude<LockAcquisition, { status: 'acquired' }>, err: (line: string) => void): number {
  if (lock.status === 'held') {
    const o = lock.owner;
    err(`${lock.path} is held by "${o.purpose}" (process ${o.pid} on ${o.hostname}, since ${o.startedAt}); that process is ${lock.ownerProcess === 'unknown' ? 'on another host or unknown' : lock.ownerProcess}.`);
  } else {
    err(`${lock.path} is not a lock record this tool wrote: ${lock.detail}.`);
  }
  err('Nothing in the work directory was read or changed. A lock is never removed automatically: once no process is running a phase on this directory (on any host), delete run.lock by hand and run the command again.');
  return EXIT_CODES.locked;
}

function reportPreflight(preflight: PreflightResult | undefined, err: (line: string) => void): void {
  if (!preflight || (preflight.status !== 'refused' && preflight.status !== 'invalid')) return;
  for (const problem of preflight.problems) err(`  ${problem.code}: ${problem.detail}`);
}

function abbreviate(commits: readonly string[]): string {
  const shown = commits.slice(0, 5).map((sha) => sha.slice(0, 12));
  return commits.length > 5 ? `${shown.join(', ')} and ${commits.length - 5} more` : shown.join(', ');
}
