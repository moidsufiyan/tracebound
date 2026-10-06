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
];
