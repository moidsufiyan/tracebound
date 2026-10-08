# Retrieval Architecture

Tracebound utilizes a Hybrid Retrieval pipeline validated through empirical Phase 1 research. The architecture explicitly avoids complex heuristic tiering in favor of Reciprocal Rank Fusion (RRF).

## Pipeline Stages

### 1. Candidate Generation (H1 Union)
When a `Change` is submitted, two independent retrieval pipelines execute concurrently against the target `RepositorySnapshot`:

- **Deterministic Pipeline:** Traverses the persistent `Relationship` graph (AST imports, historical co-change, lexical overlap) to generate a ranked list of structured candidates.
- **Semantic Pipeline:** Compares the `Change` embedding against the `Artifact` vector index, surfacing conceptually related candidates via exact cosine similarity.

These two lists are combined into a mathematical union set.

Implemented so far: the deterministic pipeline's lexical and import-based structural signals, combined under the B6 category precedence into ordered candidates with 1-based ranks (`retrieveCandidates`); see [ADR: Lexical Retrieval](decisions/lexical-retrieval.md) and [ADR: Structural Signals](decisions/structural-signals.md). Historical co-change, the semantic pipeline and fusion are planned.

### 2. Candidate Fusion (H2 RRF)
The unified candidate list is scored statelessly using Reciprocal Rank Fusion:
- `Score = (DetFound ? 1 / (60 + DetRank) : 0) + (SemFound ? 1 / (60 + SemRank) : 0)`
- This organic fusion consistently elevates artifacts with dual-consensus while gracefully buffering semantic false-positives without requiring hard heuristics.

### 3. Evidence Collection
The top-K candidates output by RRF are passed to the Evidence Module.
Instead of passing raw rank scores to the LLM, the system materializes explicit `Evidence` objects by querying the Snapshot. 
- Example: "Candidate X is included because it explicitly imports the changed function `foo()` on line 42."

### 4. LLM Reasoning Boundary
The LLM is invoked with a heavily structured prompt containing:
1. The `Change` context.
2. The Top-K Candidates.
3. The concrete `Evidence` supporting each candidate.

The LLM is strictly constrained to reasoning over this provided evidence boundary, eliminating unbounded search hallucination.
