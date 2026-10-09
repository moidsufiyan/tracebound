# Tracebound System Overview

## Architecture Style
Tracebound follows a **Modular Monolith** architecture. As a system heavily dependent on complex data ingestion, relational processing, and AI orchestration, a modular monolith minimizes network latency, deployment overhead, and transactional complexity for a solo developer while maintaining strict internal boundaries.

## Core Modules

Only part of this list exists today: snapshot ingestion (within Ingestion), Artifacts, the Project/Repository registration part of Projects, import extraction and snapshot relationships (the import part of Code-Analysis and Relationships), the Embeddings module (chunking, an Ollama provider, stored vectors) and Retrieval (deterministic, semantic and the Reciprocal Rank Fusion of the two). The GitHub module, the remainder of Code-Analysis and Relationships (history, co-change), Evidence, Reasoning and Evaluation modules, and Projects' ingestion schedules, are planned.

1. **Projects Module**
   - Manages user workspace context, repository configuration, and ingestion schedules.
2. **GitHub Module**
   - Handles external synchronization, rate-limiting, and webhook processing for incremental updates.
3. **Ingestion Module**
   - Implemented: snapshot ingestion (commit verification, tree enumeration, file policy, normalization, artifact extraction). Planned: a multi-stage state machine (`IngestionJob`) covering parsing and later stages.
4. **Artifacts Module**
   - Maintains Artifacts (`repository_id` + `git_repository_path`), their per-snapshot ArtifactVersions, and the content-addressed `Content` store (SHA-256 of normalized text). Code, Docs and Config share the common entity; Issues are planned.
5. **Code-Analysis Module**
   - Houses the AST parsers, extractors, and historical Git log processors to generate the deterministic relationship graph.
6. **Relationships Module**
   - Persists the directed graph of deterministic edges (e.g., `imports`, `co-changed-with`) bound by temporal snapshots.
7. **Embeddings Module**
   - Manages chunking algorithms, interfacing with vector models, and caching embedding representations of artifacts.
8. **Retrieval Module**
   - Executes the Hybrid v1 Retrieval (Candidate Union + Reciprocal Rank Fusion) across deterministic and semantic dimensions.
9. **Evidence Module**
   - Re-contextualizes retrieved candidates by materializing concrete `Evidence` objects (e.g., extracting exact AST line ranges).
10. **Reasoning Module**
    - Orchestrates LLM prompt construction, injecting explicit evidence bounds to produce the final grounded impact analysis.
11. **Evaluation Module**
    - Internally embeds the 9-case historical benchmark to automatically validate regression performance across any structural or retrieval changes.

## Persistence Boundary
- **Persisted:** Repository metadata, snapshots, artifacts and versions, content (by hash) and snapshot exclusion records. Derived and rebuildable: the lexical token index the structural index (content import facts and per-snapshot relationships), and the semantic index (embeddings per model and input text, and per-snapshot chunks). Planned: ingestion job state.
- **Derived/On-the-fly:** RRF calculations, candidate lists, short-lived Evidence structures, and LLM context prompts.

## Security Boundaries
- **GitHub Access:** Isolated credential stores; incremental processing must never persist unencrypted tokens.
- **LLM Egress:** Strict prompt-templating barriers. The LLM cannot execute arbitrary code or unbounded vector searches; it operates exclusively on pre-verified Evidence objects.
