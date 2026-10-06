# Data Lifecycle

## Snapshot Ready Semantics

`RepositorySnapshot.ready` means: **the exact Git commit has been successfully captured and its complete included ArtifactVersions/exclusion records have been persisted atomically.**

It does not mean structural analysis, relationship extraction, embeddings, semantic indexing or any other Tracebound intelligence has run. Those stages are planned (see below) and, when added, will track their own state rather than redefine `ready`.

## Snapshot Ingestion Lifecycle (Implemented)

A single in-process call, `ingestSnapshot(repository, commit SHA)`. There is no `IngestionJob` and no intermediate persisted state; the only persisted states are `ready` and `failed`.

1. **Commit verification:** The contract is: registered local repository → explicitly requested full commit SHA → immutable snapshot. The requested commit (a full SHA, never a ref) must exist as a commit object in the registered local repository's Git object database.
2. **Deterministic tree enumeration:** The commit's tree is listed recursively and sorted by path (code-unit order, locale-independent).
3. **File policy:** Each entry is included or excluded by the rules in [ADR: Snapshot Ingestion](decisions/snapshot-ingestion.md). Every exclusion is recorded with a reason.
4. **Normalization:** Included files are decoded as strict UTF-8, BOM removed, line endings converted to LF.
5. **Content hashing/storage:** The SHA-256 of the normalized text identifies a `Content` row, stored once and shared.
6. **Artifact creation/reuse:** The `Artifact` for `(repository_id, git_repository_path)` is created on first sight and reused afterwards.
7. **ArtifactVersion creation:** One `ArtifactVersion` per included file links `(artifact_id, snapshot_id)` to `content_sha256` and `git_blob_sha`.
8. **Atomic snapshot publication:** The `ready` snapshot row, artifacts, versions and exclusion records are written in one transaction.
9. **Outcome:** `ready`, or `failed` with a reason and no ArtifactVersions or exclusion records.

Re-ingesting a ready commit returns the existing snapshot unchanged; re-ingesting a failed commit replaces the failed record.

## Planned Stages (Not Implemented)

Unless marked implemented, none of the following exists yet. They run against ready snapshots.

- **Lexical index (implemented, derived):** `indexSnapshotLexically` builds the token index for a ready snapshot as a separate, idempotent step; see [ADR: Lexical Retrieval](decisions/lexical-retrieval.md). It is not part of snapshot capture and `ready` does not imply it has run.
- **Structural Analysis:** AST parsers and Git history analyzers process the Artifacts, generating directed `Relationships` bound to the Snapshot.
- **Semantic Indexing:** Documents and code are chunked; unseen chunks are sent to the embedding model.
- **Retrieval, Evidence and Reasoning:** see the retrieval, evidence and system overview documents.
- **IngestionJob:** A planned entity to track multi-stage, retryable processing (e.g., Queued, Extracting, Parsing, Embedding, Complete, Failed). It is not part of the current model.
- **Branch tracking / new-commit discovery:** Automatic detection of new commits is undecided future work; today a commit is ingested only when explicitly requested.
- **GitHub acquisition:** Cloning or downloading from GitHub in place of a local repository.
- **Issues** as artifacts.

## Snapshot-to-Snapshot Semantics (Implemented)

Each commit is ingested as an independent full snapshot; previous snapshots are never modified. Compared with an earlier snapshot of the same repository, the identity model gives:

- **New path:** a new `Artifact`, with a version in the new snapshot.
- **Existing path, changed content:** the same `Artifact`, a new `ArtifactVersion` with a different `content_sha256`.
- **Existing path, unchanged content:** the same `Artifact`, a new `ArtifactVersion` sharing the same `Content`.
- **Deleted path:** no `ArtifactVersion` for that path in the new snapshot. The `Artifact` and its earlier versions remain.
- **Rename:** a new `Artifact` for the new path. Rename continuity is future work.

## Incremental Update Lifecycle (Planned)

Not implemented. Today every commit is ingested in full, and unchanged files are cheap only because `Content` is deduplicated by hash. Planned: when a new commit is discovered (how, e.g. branch tracking, is an undecided future decision), a diff identifies added, modified and deleted paths so that later analysis stages (not snapshot capture) process only changed Artifacts, updating `Relationships` and marking old edges invalid in the new `RepositorySnapshot`. The previous snapshot is retained intact for historical reproducibility and evaluation benchmark consistency.

## Failure Handling

**Implemented:** snapshot capture is atomic. A missing or unreadable Git object, or a path that is not valid UTF-8, fails the snapshot; it is recorded as `failed` with a reason and none of its artifact versions are visible. A failed snapshot is never `ready`.

**Planned** (applies once the later stages exist):
- **Partial Ingestion:** An `IngestionJob` would track sub-states. If the embedding API rate-limits, the job would pause in a `Failed_Retryable` state.
- **Parser Failure:** If an AST parser encounters malformed code, the specific `Artifact` would be flagged `Analysis_Failed` while the overall ingestion proceeds, and deterministic retrieval would degrade gracefully for that artifact.
- **Stale Index:** If ingestion fails terminally, queries would fall back to the last known-good `RepositorySnapshot` with an "Out of Sync" warning in the UI.
