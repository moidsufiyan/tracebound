// Ordered schema migrations. Index i upgrades the database from user_version i to i + 1.
// Never edit an applied migration; append a new one instead.
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE project (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE repository (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES project (id),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    source_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (project_id, name)
  ) STRICT;

  -- One row per (repository, commit). A 'ready' row is only ever written in the same
  -- transaction as all of its artifact versions, so it is never observable half-built.
  CREATE TABLE repository_snapshot (
    id INTEGER PRIMARY KEY,
    repository_id INTEGER NOT NULL REFERENCES repository (id),
    commit_sha TEXT NOT NULL CHECK (length(commit_sha) IN (40, 64)),
    tree_sha TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ready', 'failed')),
    failure_reason TEXT,
    recorded_at TEXT NOT NULL,
    UNIQUE (repository_id, commit_sha),
    UNIQUE (repository_id, id),
    CHECK ((status = 'failed') = (failure_reason IS NOT NULL))
  ) STRICT;

  -- Content-addressed, immutable, shared across artifacts, snapshots and repositories.
  CREATE TABLE content (
    sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
    text TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0)
  ) STRICT;

  -- The logical repository object: stable across snapshots, identified by its path.
  CREATE TABLE artifact (
    id INTEGER PRIMARY KEY,
    repository_id INTEGER NOT NULL REFERENCES repository (id),
    path TEXT NOT NULL CHECK (length(path) > 0),
    kind TEXT NOT NULL CHECK (kind IN ('code', 'document', 'config')),
    UNIQUE (repository_id, path),
    UNIQUE (repository_id, id)
  ) STRICT;

  -- An artifact as it exists at one snapshot. The composite foreign keys guarantee the
  -- artifact and the snapshot belong to the same repository.
  CREATE TABLE artifact_version (
    id INTEGER PRIMARY KEY,
    repository_id INTEGER NOT NULL,
    artifact_id INTEGER NOT NULL,
    snapshot_id INTEGER NOT NULL,
    content_sha256 TEXT NOT NULL REFERENCES content (sha256),
    git_blob_sha TEXT NOT NULL,
    UNIQUE (snapshot_id, artifact_id),
    FOREIGN KEY (repository_id, artifact_id) REFERENCES artifact (repository_id, id),
    FOREIGN KEY (repository_id, snapshot_id) REFERENCES repository_snapshot (repository_id, id)
  ) STRICT;

  CREATE INDEX artifact_version_artifact_idx ON artifact_version (artifact_id);
  CREATE INDEX artifact_version_content_idx ON artifact_version (content_sha256);

  -- Tree entries deliberately left out of a snapshot, so exclusion is auditable rather than silent.
  CREATE TABLE excluded_entry (
    snapshot_id INTEGER NOT NULL REFERENCES repository_snapshot (id),
    path TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (
      reason IN ('symlink', 'submodule', 'generated', 'unsupported_type', 'oversized', 'binary', 'not_utf8')
    ),
    PRIMARY KEY (snapshot_id, path)
  ) STRICT, WITHOUT ROWID;
  `,
  // Derived lexical retrieval index. Nothing here is canonical: every row can be rebuilt from
  // content.text and artifact.path, and none of it is part of what makes a snapshot 'ready'.
  `
  -- Distinct tokens of one content text. Keyed by content so identical text shared by many
  -- artifacts and snapshots is tokenized and stored once.
  CREATE TABLE content_token (
    token TEXT NOT NULL,
    content_sha256 TEXT NOT NULL REFERENCES content (sha256),
    PRIMARY KEY (token, content_sha256)
  ) STRICT, WITHOUT ROWID;

  -- Marks content whose tokens are complete, including content that has no tokens at all.
  CREATE TABLE lexical_indexed_content (
    content_sha256 TEXT PRIMARY KEY REFERENCES content (sha256)
  ) STRICT, WITHOUT ROWID;

  -- Distinct tokens of one artifact's Git path. A path always yields at least one token, so an
  -- artifact with no rows here has not been indexed yet.
  CREATE TABLE artifact_path_token (
    artifact_id INTEGER NOT NULL REFERENCES artifact (id),
    token TEXT NOT NULL,
    PRIMARY KEY (artifact_id, token)
  ) STRICT, WITHOUT ROWID;
  `,
  // Derived structural index. Import facts depend only on content (and the parse dialect), so they
  // are shared by every snapshot and repository containing that text; relationships are resolved
  // per snapshot against that snapshot's own artifacts. None of it affects what 'ready' means.
  `
  -- Records that a content text was parsed in a dialect, including texts that have no imports and
  -- texts the parser rejected. A rejected text yields no import facts.
  CREATE TABLE structural_parsed_content (
    content_sha256 TEXT NOT NULL REFERENCES content (sha256),
    dialect TEXT NOT NULL CHECK (dialect IN ('typescript', 'typescript-jsx')),
    status TEXT NOT NULL CHECK (status IN ('parsed', 'syntax_error')),
    PRIMARY KEY (content_sha256, dialect)
  ) STRICT, WITHOUT ROWID;

  -- Module specifiers of the import declarations in one content text, exactly as written.
  CREATE TABLE content_import (
    content_sha256 TEXT NOT NULL,
    dialect TEXT NOT NULL,
    specifier TEXT NOT NULL,
    PRIMARY KEY (content_sha256, dialect, specifier),
    FOREIGN KEY (content_sha256, dialect) REFERENCES structural_parsed_content (content_sha256, dialect)
  ) STRICT, WITHOUT ROWID;

  -- A resolved relationship between two artifacts of one snapshot, stored once in the direction
  -- source -> target (the source imports the target). 'test-to-source' is stored in addition to
  -- 'imports' when the source path is a test file. Reverse lookups query target_artifact_id.
  CREATE TABLE snapshot_relationship (
    snapshot_id INTEGER NOT NULL,
    source_artifact_id INTEGER NOT NULL,
    target_artifact_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('imports', 'test-to-source')),
    PRIMARY KEY (snapshot_id, source_artifact_id, target_artifact_id, kind),
    FOREIGN KEY (snapshot_id, source_artifact_id) REFERENCES artifact_version (snapshot_id, artifact_id),
    FOREIGN KEY (snapshot_id, target_artifact_id) REFERENCES artifact_version (snapshot_id, artifact_id),
    CHECK (source_artifact_id <> target_artifact_id)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX snapshot_relationship_target_idx ON snapshot_relationship (snapshot_id, target_artifact_id);

  -- Marks snapshots whose relationships are complete, including snapshots that have none.
  CREATE TABLE structurally_indexed_snapshot (
    snapshot_id INTEGER PRIMARY KEY REFERENCES repository_snapshot (id)
  ) STRICT, WITHOUT ROWID;
  `,
  // Derived semantic index. An embedding belongs to one model and to the exact text that was sent to
  // it (which includes the file path), so it is shared by every snapshot and repository that
  // produces the same text. Which chunks make up a snapshot is recorded per model, and a snapshot
  // counts as indexed for a model only through its marker row. None of it affects 'ready'.
  `
  -- Vectors are little-endian float32, dimensions * 4 bytes.
  CREATE TABLE semantic_embedding (
    id INTEGER PRIMARY KEY,
    model_id TEXT NOT NULL CHECK (length(model_id) > 0),
    input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
    dimensions INTEGER NOT NULL CHECK (dimensions > 0),
    vector BLOB NOT NULL,
    UNIQUE (model_id, input_hash),
    CHECK (length(vector) = dimensions * 4)
  ) STRICT;

  -- The chunks of one artifact version, for one model. The composite foreign keys tie a chunk to a
  -- version that exists in the snapshot and to an embedding of the same model.
  CREATE TABLE semantic_chunk (
    model_id TEXT NOT NULL,
    snapshot_id INTEGER NOT NULL,
    artifact_id INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    input_hash TEXT NOT NULL,
    PRIMARY KEY (model_id, snapshot_id, artifact_id, chunk_index),
    FOREIGN KEY (model_id, input_hash) REFERENCES semantic_embedding (model_id, input_hash),
    FOREIGN KEY (snapshot_id, artifact_id) REFERENCES artifact_version (snapshot_id, artifact_id)
  ) STRICT, WITHOUT ROWID;

  -- Written in the same transaction as the snapshot's chunks, after every embedding exists.
  CREATE TABLE semantic_indexed_snapshot (
    model_id TEXT NOT NULL,
    snapshot_id INTEGER NOT NULL REFERENCES repository_snapshot (id),
    dimensions INTEGER NOT NULL CHECK (dimensions > 0),
    max_input_chars INTEGER NOT NULL CHECK (max_input_chars > 0),
    PRIMARY KEY (model_id, snapshot_id)
  ) STRICT, WITHOUT ROWID;
  `,
];
