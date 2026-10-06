# ADR: Snapshot Ingestion and Artifact Identity

**Decision:** Artifact identity is `(repository_id, git_repository_path)`, where `git_repository_path` is the repository-relative path exactly as represented in Git's tree (`/` separators, no normalization, no case folding). Each snapshot holds one ArtifactVersion per included file, pointing at content identified by the SHA-256 of its normalized text. Snapshots are read from the local Git object database by commit id and committed atomically.
**Context:** The snapshot ADR requires temporal correctness. The earlier domain model made the content hash the Artifact identity, which leaves no stable object to follow across commits (a modified file would become an unrelated artifact).
**Alternatives:**
- *Artifact = content hash:* no cross-snapshot identity, and two paths with identical content collapse into one artifact.
- *Path identity with rename tracking (`git -M`):* more continuity, but it depends on git's similarity heuristics. Deferred until a retrieval need is demonstrated.
- *Checkout / worktree per commit:* writes to disk and is slower; object-level reads (`ls-tree`, `cat-file --batch`) need neither.
**Chosen approach:**
- **Model:** `artifact(repository_id, path)` is stable; the `path` column holds the `git_repository_path`. `artifact_version(snapshot, artifact)` records `content_sha256` and `git_blob_sha`. `content(sha256)` is stored once and shared everywhere. A rename produces a new artifact.
- **Exact commit:** only full 40/64-hex commit ids are accepted. Refs (`HEAD`, branch names) and tags are rejected, never resolved. The working tree, index and refs of the source repository are never read or written.
- **Atomicity:** content rows are written while blobs stream (immutable and content-addressed, so leftovers are harmless). The `ready` snapshot row, artifacts, versions and exclusions are then written in one synchronous transaction. Any failure after commit verification records a `failed` snapshot with a reason and no child rows. Re-ingesting a ready commit is a no-op; re-ingesting a failed one replaces it. `ready` means only that the exact commit was captured and its included ArtifactVersions and exclusion records were persisted atomically; it says nothing about analysis, embeddings or indexing.
- **Normalization:** strict UTF-8, leading BOM removed, CRLF/CR → LF. Nothing else is changed.
- **File policy** (`src/ingestion/file-policy.ts`), applied in order; every excluded entry is recorded in `excluded_entry` with its reason:
  1. symlinks (`120000`) → `symlink` (never followed); gitlinks (`160000`) → `submodule`
  2. any directory segment in `node_modules, dist, build, out, coverage, .next, .turbo`, npm/pnpm lockfiles, or `*.min.{js,mjs,cjs}` → `generated`
  3. extension not in `.ts .tsx .mts .cts .js .jsx .mjs .cjs` (code), `.md .mdx .txt` (document) or `.json .yaml .yml` (config) → `unsupported_type`
  4. blob larger than 1 MiB → `oversized` (checked before reading)
  5. contains a NUL byte → `binary`; invalid UTF-8 → `not_utf8`
- **Hard failures (not exclusions):** a missing or unreadable object, or a path that is not valid UTF-8, fails the snapshot. Skipping either would silently misrepresent the commit.
**Tradeoffs:**
- *Pros:* deterministic and auditable snapshots; partial state is never visible as ready; no disk checkout.
- *Cons:* renames break artifact continuity; `.gitignore`-style project rules and `.gitattributes` (e.g. `linguist-generated`) are not consulted; ingestion is a single in-process call with no `IngestionJob` progress or retry state yet.
