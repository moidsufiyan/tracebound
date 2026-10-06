# Tracebound — agent notes

Source of truth for architecture: `docs/architecture/` (ADRs in `docs/architecture/decisions/`). Update the relevant doc or ADR when a change alters a decision recorded there.

## Commands
- `npm test` (Vitest), `npm run typecheck`, `npm run build`. No linter is configured.
- Node >= 24 is required (`node:sqlite`). Tests create throwaway Git repos in the OS temp dir.

## Layout
- `src/<module>/` follows the modular monolith: `db`, `git`, `projects`, `snapshots`, `artifacts`, `ingestion`. Persistence is plain SQL in module functions taking a `Database`; there is no ORM.
- Schema changes: append a new entry to `src/db/migrations.ts`. Never edit an applied migration.
- `experiments/` holds standalone Phase 1 research scripts. Do not import from them or refactor them as part of production work.

## Invariants to preserve
- Snapshots are addressed by full commit SHA only. Never resolve refs/HEAD, and never touch the source repo's working tree, index or refs.
- `inTransaction` work must be synchronous. A `ready` snapshot row is written in the same transaction as all of its versions.
- Artifact = (repository_id, git_repository_path), the path exactly as in Git's tree (no path normalization); ArtifactVersion = (artifact, snapshot); Content = sha256 of normalized text. Do not merge these.
- File inclusion rules live only in `src/ingestion/file-policy.ts`; exclusions are recorded, never silent.
- Windows dev machine: avoid reserved file names (`nul`, `con`, `aux`, …) in test fixtures.
