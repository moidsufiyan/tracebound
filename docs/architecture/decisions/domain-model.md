# ADR: Artifact Domain Model

**Decision:** Use a Hybrid Artifact Model (Core `Artifact` entity with domain-specific metadata/extensions).
**Context:** Tracebound analyzes diverse entities: source code, tests, markdown documentation, GitHub issues, and pull requests. The retrieval system needs a unified way to rank and index these, but structural analysis requires strongly-typed properties (e.g., AST nodes for code, hierarchy for docs).
**Alternatives:** 
- A fully generalized `Artifact` with unstructured JSON metadata.
- Completely disparate domain entities (e.g., `SourceFile`, `Issue`, `Document`).
**Chosen approach:** A Hybrid Model. A foundational `Artifact` entity represents the universal concepts (identity as repository + `git_repository_path`, with versions pointing at content-hashed text; embeddings are derived, per model and input text, see the semantic retrieval ADR) required for the unified retrieval layer. Sub-modules (like the AST analyzer) project specific, strongly-typed views (like `CodeEntity`) mapped to the core `Artifact` ID.
**Tradeoffs:** 
- *Pros:* Decouples the unified hybrid retrieval pipeline from the complexities of language-specific parsers. Ensures semantic embeddings and deterministic ranks can target a single identity.
- *Cons:* Requires a mapping layer between the structural relationship graph and the core retrieval index.
