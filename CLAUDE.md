# Tracebound — agent notes

Source of truth for architecture: `docs/architecture/` (ADRs in `docs/architecture/decisions/`). Update the relevant doc or ADR when a change alters a decision recorded there.

## Commands
- `npm test` (Vitest), `npm run typecheck`, `npm run build`. No linter is configured.
- Node >= 24 is required (`node:sqlite`). Tests create throwaway Git repos in the OS temp dir.

## Layout
- `src/<module>/` follows the modular monolith: `db`, `git`, `projects`, `snapshots`, `artifacts`, `ingestion`, `analysis`, `retrieval`, `semantic`. Persistence is plain SQL in module functions taking a `Database`; there is no ORM.
- Schema changes: append a new entry to `src/db/migrations.ts`. Never edit an applied migration.
- `experiments/` holds standalone Phase 1 research scripts. Do not import from them or refactor them as part of production work.

## Invariants to preserve
- Snapshots are addressed by full commit SHA only. Never resolve refs/HEAD, and never touch the source repo's working tree, index or refs.
- `inTransaction` work must be synchronous. A `ready` snapshot row is written in the same transaction as all of its versions.
- Artifact = (repository_id, git_repository_path), the path exactly as in Git's tree (no path normalization); ArtifactVersion = (artifact, snapshot); Content = sha256 of normalized text. Do not merge these.
- Retrieval is always against an explicit ready snapshot id, never HEAD, the working tree or an implicit latest. The lexical and structural indexes are derived data (`indexSnapshotLexically`, `indexSnapshotStructurally`), not part of `ready`; retrieval refuses snapshots missing either. The semantic index (`indexSnapshotSemantically`, needs an `EmbeddingProvider`) is derived the same way and is keyed by model id: never read or mix vectors of another model, and never truncate an embedding input.
- Hybrid search (`searchHybrid`, `fuseRrf`) is RRF with K = 60 over the complete deterministic and semantic rankings and requires all three indexes. `fuseRrf` is pure and removes nothing; the production API does not exclude changed files (benchmarks do, at their own boundary). Ties: score, then deterministic category, then path, then artifact id.
- Structural analysis follows B1 exactly (import declarations only, relative specifiers, B1's suffix order, `.test.`/`.spec.` heuristic). The one recorded extension is a relative `.js` specifier falling back to `.ts` then `.tsx` when no exact target exists. Do not add other substitutions, aliases, `require` or re-exports without a decision recorded in `docs/architecture/decisions/structural-signals.md`.
- Benchmark tests (`test/benchmark`) need `TRACEBOUND_WOLLYWAY_REPO` and `TRACEBOUND_HONO_REPO`; the semantic and hybrid ones also need a running Ollama with `nomic-embed-text:v1.5` named by `TRACEBOUND_OLLAMA_URL` (and can keep embeddings in the SQLite file named by `TRACEBOUND_BENCHMARK_DB`). Normal tests use a fake provider and never need Ollama. The pinned ranks in these tests are measurements, never ground-truth edits.
- File inclusion rules live only in `src/ingestion/file-policy.ts`; exclusions are recorded, never silent.
- Windows dev machine: avoid reserved file names (`nul`, `con`, `aux`, …) in test fixtures.
