// Builds the M9 release: freezes the evaluation database, runs the production M6 hybrid search once
// per case against the frozen file, constructs the complete M7 evidence packages from those same
// runs, and writes rankings, blinded review packets and the release manifest.
//
//   node scripts/m9-export.mjs --source <bench.sqlite> --out <new release dir> [--ollama <url>]
//
// Needs a built tree (`npm run build`) and a running Ollama with nomic-embed-text:v1.5 for the
// query embeddings only. It never reads or writes the source repositories, runs no reasoning model,
// generates no corpus embeddings and never writes to the source database or the frozen copy.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (path) => import(pathToFileURL(join(root, 'dist', path)).href);
const { digestOf } = await dist('evaluation/m9/canonical.js');
const { fileIdentity, freezeDatabase, tableDigests } = await dist('evaluation/m9/freeze-database.js');
const art = await dist('evaluation/m9/artifacts.js');
const { applyReleaseGate } = await dist('evaluation/m9/gate.js');
const { writeRelease } = await dist('evaluation/m9/release.js');
const { searchHybridDetailed, constructEvidence, createOllamaEmbeddingProvider } = await dist('index.js');
const { load } = await import(pathToFileURL(join(root, 'node_modules', 'js-yaml', 'dist', 'js-yaml.mjs')).href);

const EXPORTER_VERSION = '1.0.0';
const MODEL_NAME = 'nomic-embed-text:v1.5';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const sourcePath = argument('source');
const outDir = argument('out');
const endpoint = argument('ollama', 'http://127.0.0.1:11434');
if (!sourcePath || !outDir) throw new Error('Usage: m9-export.mjs --source <bench.sqlite> --out <new release dir> [--ollama <url>]');
if (existsSync(outDir)) throw new Error(`Refusing to write into an existing directory: ${outDir}`);

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const candidateManifestPath = join(root, 'docs', 'evaluation', 'm9', 'candidate-manifest.json');
const candidateManifest = JSON.parse(readFileSync(candidateManifestPath, 'utf8'));
const candidateManifestDigest = digestOf(candidateManifest);

// 1. The source must be the database the selection was frozen from.
const source = await fileIdentity(sourcePath);
if (source.sha256 !== candidateManifest.database.originSha256) {
  throw new Error(`The source database is ${source.sha256}, not the frozen origin ${candidateManifest.database.originSha256}`);
}

// 2. Freeze it (the source is only read) and show the copy holds the same rows.
mkdirSync(join(outDir, 'database'), { recursive: true });
const databaseFile = 'database/tracebound-m9.sqlite';
const frozen = await freezeDatabase(sourcePath, join(outDir, 'database', 'tracebound-m9.sqlite'));
const sourceTables = tableDigests(sourcePath);
const sameRows = JSON.stringify(sourceTables) === JSON.stringify(frozen.tables);
if (!sameRows) throw new Error('The frozen database does not hold the same rows as the source');
console.log(`frozen database ${frozen.frozen.bytes} bytes sha256 ${frozen.frozen.sha256}`);

// 3. The embedding model: installed weights, verified identity.
const tags = await (await fetch(`${endpoint}/api/tags`)).json();
const installed = tags.models.find((model) => model.name === MODEL_NAME);
if (!installed) throw new Error(`${MODEL_NAME} is not installed; this export downloads no models`);
const provider = await createOllamaEmbeddingProvider({ endpoint });
const original = candidateManifest.selection.originalRun;
if (provider.modelId !== original.embeddingModelId || installed.digest !== original.embeddingWeightsDigest) {
  throw new Error(`The embedding model is ${provider.modelId} (${installed.digest}), not the one the selection was made with`);
}
const embedding = { modelId: provider.modelId, weightsDigest: installed.digest, dimensions: provider.dimensions, maxInputChars: provider.maxInputChars };

// 4. Provenance of this run.
const generatedAt = new Date().toISOString();
const traceboundCommit = git('rev-parse', 'HEAD');
const retrievalSourcesMatchCommit = git('status', '--porcelain', '--', 'src', ':!src/evaluation') === '';
const provenance = {
  runId: `m9-evidence-${generatedAt.replace(/[-:.]/g, '')}`,
  generatedAt,
  runKind: 'new-evidence-generation-run',
  traceboundCommit,
  retrievalSourcesMatchCommit,
  exporterVersion: EXPORTER_VERSION,
  database: { sha256: frozen.frozen.sha256, bytes: frozen.frozen.bytes, userVersion: frozen.frozen.userVersion },
};

// 5. One production run per case against the frozen file, opened read-only.
const db = new DatabaseSync(join(outDir, 'database', 'tracebound-m9.sqlite'), { readOnly: true });
const releaseCases = [];
if (candidateManifest.cases.length !== 4) throw new Error('The candidate manifest must freeze four cases');

for (const frozenCase of candidateManifest.cases) {
  const caseId = frozenCase.caseId;
  const parsed = load(readFileSync(join(root, 'docs', 'evaluation', 'cases', `case-${caseId.slice(4)}.yaml`), 'utf8'));
  const spec = art.caseSpecFromParsed(parsed);
  if (spec.caseId !== caseId || JSON.stringify(spec.changedPaths) !== JSON.stringify(frozenCase.changedPaths)) {
    throw new Error(`${caseId}: the case file disagrees with the candidate manifest`);
  }

  const run = await searchHybridDetailed(db, frozenCase.snapshot.id, provider, { description: spec.description, changedPaths: spec.changedPaths, symbols: spec.symbols });
  const bundle = constructEvidence(db, frozenCase.snapshot.id, provider, run);

  // The new run must reproduce the frozen selection exactly, or nothing is written for review.
  const entries = art.rankingEntries(run);
  if (run.rrfK !== 60) throw new Error(`${caseId}: rrfK is ${run.rrfK}`);
  if (run.fused.length !== frozenCase.rankedCandidateCount) throw new Error(`${caseId}: ${run.fused.length} ranked candidates, expected ${frozenCase.rankedCandidateCount}`);
  const eligible = entries.filter((entry) => entry.eligibleRank !== null).slice(0, 3);
  frozenCase.candidates.forEach((expected, index) => {
    const actual = eligible[index];
    const same = actual && actual.path === expected.path && actual.artifactId === expected.artifactId && actual.versionId === expected.versionId && actual.rank === expected.fusedRank && actual.eligibleRank === expected.eligibleRank && actual.deterministicRank === expected.deterministicRank && actual.semanticRank === expected.semanticRank;
    if (!same) throw new Error(`${caseId} #${index + 1}: production run gives ${JSON.stringify(actual)}, frozen ${JSON.stringify(expected)}`);
  });
  console.log(`${caseId}: production run reproduces the frozen selection (${run.fused.length} ranked)`);

  const context = { db, spec, snapshotId: frozenCase.snapshot.id, run, bundle, embedding, provenance };
  const evidencePackage = art.buildEvidencePackage(context);
  const packageDigest = digestOf(evidencePackage);
  const ranking = art.buildProductionRanking(context);
  const packet = art.buildReviewPacket({ db, evidencePackage, evidencePackageDigest: packageDigest, candidateManifestDigest, frozen: { caseId, snapshotId: frozenCase.snapshot.id, baseCommitSha: frozenCase.snapshot.baseCommitSha, candidates: frozenCase.candidates } });
  releaseCases.push({ caseId, evidencePackage, ranking, packet });
}
db.close();

// 6. Nothing may have changed the source or the frozen file.
const sourceAfter = await fileIdentity(sourcePath);
const frozenAfter = await fileIdentity(join(outDir, 'database', 'tracebound-m9.sqlite'));
if (sourceAfter.sha256 !== source.sha256) throw new Error('The source database changed during the export');
if (frozenAfter.sha256 !== frozen.frozen.sha256) throw new Error('The frozen database changed during the export');
const { manifestDigest } = await writeRelease({ outDir, databaseFile, frozen, source, sourceAfter, sourceSameRows: sameRows, candidateManifest, cases: releaseCases, provenance, embedding, generatedAt });
const gate = await applyReleaseGate(outDir, new Date().toISOString());
for (const entry of gate.report.checks.filter((check) => !check.ok)) console.log(`FAILED: ${entry.name} ${entry.detail ?? ''}`);
console.log(`verifier: ${gate.report.checks.filter((check) => check.ok).length}/${gate.report.checks.length} checks passed`);
console.log(`distribution status: ${gate.status}; release manifest digest ${gate.manifestDigest}`);
process.exitCode = gate.status === 'RELEASED' ? 0 : 1;
