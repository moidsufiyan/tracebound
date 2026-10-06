# ADR: Temporal Snapshot Model

**Decision:** Implement a Content-Addressable Snapshot Model.
**Context:** Tracebound's core premise requires analyzing historical changes. The system must never assume the current repository `HEAD` is the authoritative state for past analyses. Temporal correctness is a first-class requirement.
**Alternatives:** 
- Store only the latest repository state and re-clone/checkout dynamically when querying history.
- Store a complete copy of the database for every commit.
**Chosen approach:** A content-addressable architecture mirroring Git's object model. A `RepositorySnapshot` (mapping to a Git commit SHA) references immutable `ArtifactVersion`s, each pointing at content identified by its hash. Artifacts themselves are identified by (`repository_id`, `git_repository_path`); see [ADR: Snapshot Ingestion](snapshot-ingestion.md). Relationships (e.g., imports) are stamped with the `RepositorySnapshot` context in which they are valid.
**Tradeoffs:** 
- *Pros:* Guarantees perfect temporal reproducibility. Content is stored once per hash, and future incremental analysis can skip unchanged content hashes (incremental ingestion itself is planned, not implemented).
- *Cons:* Increased complexity in querying relationships, as the retrieval layer must explicitly filter by snapshot validity rather than just querying a flat "current" graph.
