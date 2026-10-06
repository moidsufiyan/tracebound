# Tracebound Deterministic Baseline Design

> **Status:** Phase 1 Design
> **Constraint:** This baseline strictly prohibits embeddings, LLMs, vector databases, semantic reranking, or agentic reasoning. Its purpose is to establish the strongest reasonable non-AI baseline against which later retrieval methods can be rigorously evaluated.

---

## 1. Objective & First Principles

**Objective:** Design a deterministic system to answer: *"Given a historical software change, which other artifacts should a developer investigate?"*

**First Principle:** Retrieval is a pipeline, not a monolith. The baseline must cleanly separate these stages so that failures can be precisely isolated:
1. **Artifact universe definition:** What is the set of all possible artifacts?
2. **Candidate generation:** How do we filter the universe down to potentially relevant artifacts?
3. **Evidence collection:** What signals support an artifact's relevance?
4. **Candidate ranking:** How do we sort the candidates?
5. **Top-K result:** What is actually shown to the developer?
6. **Evaluation:** How does the output compare to ground truth?

---

## 2. Baseline Retrieval Surfaces

The baseline is composed of independent signal generators. Each generator evaluates the `changed_artifacts` and extracts a set of candidates with supporting evidence.

### B1 — Structural Analysis
Retrieves candidates based on deterministic programmatic coupling.
* **Signals:** 
  * Direct dependencies (A imports B)
  * Reverse dependencies (B imports A)
  * Symbol reference graph (function calls, type implementations, class inheritance)
  * Co-located test detection (e.g., `foo.ts` -> `foo.test.ts`)
* **Requirements:** 
  * Requires an AST parser or language server equivalent for the target language (e.g., `tsserver` for TypeScript) capable of resolving module paths and symbol references.
  * Must operate on the repository state strictly at `base_commit`.

### B2 — Lexical Retrieval
Retrieves candidates based on exact textual overlaps.
* **Signals:**
  * Exact symbol name matches (e.g., searching for `ORDER_STATUS`)
  * Identifier boundary matches
  * File name and path token overlap (e.g., `checkout.service.ts` -> `checkout-api.md`)
  * Textual overlap between change issue/description and candidate content
* **Requirements:**
  * Requires a fast, indexed text search mechanism (e.g., `ripgrep` or a deterministic inverted index like Lucene).
  * Requires standard token normalization (case folding, camelCase/snake_case splitting, stemming).
  * Excludes generic stop-words to prevent universe explosion.

### B3 — Historical Signals
Retrieves candidates based on Git history and evolutionary coupling.
* **Signals:**
  * Co-change frequency: Files that were modified in the same commits as the `changed_artifacts` in the past.
  * Historical adjacency: Files frequently modified by the same author in the same temporal window.
* **Requirements:**
  * Relies entirely on the Git commit graph.
  * **Strict Temporal Constraint:** Must only analyze commits where `author_timestamp < evaluation_cutoff`. Any commit at or after the cutoff must be completely invisible to prevent hindsight leakage.

### B4 — Explicit Development Relationships
Retrieves candidates based on explicitly linked project management metadata.
* **Signals:**
  * Issue ↔ PR linkage (e.g., "Fixes #123")
  * Commit ↔ PR linkage
  * Explicit mentions (e.g., "@username" or linking to another issue/artifact in a comment)
* **Requirements:**
  * Requires parsing structured metadata (e.g., GitHub API payloads).
  * **Strict Temporal Constraint:** Must only index issues, PRs, and comments authored prior to `evaluation_cutoff`.

### B5 — Combined Deterministic Baseline
Acts as an aggregator for B1–B4.
* Merges the candidate streams from all four generators.
* **Preserves Provenance:** Instead of collapsing evidence into a single opaque score, B5 collects all signals. If an artifact was found via structural import (B1) and historical co-change (B3), B5 records both distinct pieces of evidence.

---

## 3. Candidate Generation & Representation

### Artifact Universe
Before generation, the baseline defines the exact universe of search. For the current pilot, this is defined as **all version-controlled files present in the Git tree at `base_commit`**.

### Inclusion & Deduplication
* **Generation:** Each B-surface (B1-B4) emits a stream of candidate records.
* **Deduplication:** Candidates are deduplicated by their unique identity (typically the file path at `base_commit`).
* **Evidence Aggregation:** When multiple B-surfaces emit the same artifact, their evidence arrays are concatenated. The artifact is recorded *once*, but its evidence grows.

### Conceptual Candidate Representation
```typescript
interface BaselineCandidate {
  // Identity
  path: string;                    // e.g., "backend/docs/architecture/checkout-lifecycle.md"
  artifact_type: string;           // "source" | "test" | "documentation"
  
  // Provenance & Evidence
  found_by: string[];              // e.g., ["B1_STRUCTURAL", "B2_LEXICAL"]
  evidence: Array<{
    generator: string;             // e.g., "B2_LEXICAL"
    signal_type: string;           // e.g., "exact_symbol_match"
    description: string;           // e.g., "Found exact token 'REFUNDED'"
    location: string | null;       // Line number or symbol location if applicable
  }>;
  
  // Ranking
  rank_score: number;              // Determined by the ranking strategy
  tier: string;                    // If using tier-based ranking
}
```

---

## 4. Ranking

Ranking orders the generated candidates so a developer isn't overwhelmed. Since we cannot use semantic rerankers, we evaluate two deterministic approaches:

### Option A: Deterministic Precedence (Tier Ranking)
Candidates are sorted into discrete tiers based on the *type* of signal, prioritizing high-precision signals over low-precision ones.
* **Tier 1 (Direct Impact):** Structural dependencies (A imports B), colocated tests.
* **Tier 2 (High Lexical/Historical):** Exact symbol matches in documentation, >80% historical co-change frequency.
* **Tier 3 (Weak Lexical):** Token overlap, filename similarity.
* *Tradeoff:* Highly interpretable. Easy to implement. Cannot easily distinguish between two candidates in the same tier.

### Option B: Feature-Based Scoring (Heuristic Weights)
Assigns numerical weights to signals and sums them (e.g., Structural Import = 10pts, Co-change = 5pts, Lexical Token = 1pt).
* *Tradeoff:* Allows fine-grained sorting, but introduces arbitrary "magic numbers" that are easily overfitted to a small evaluation dataset. Hides the true reason an artifact was ranked high behind a math equation.

### Recommendation
**Use Option A (Deterministic Precedence / Tier Ranking) for the first experiment.** 
At this stage, we want to evaluate *what* deterministic signals can discover, not how well we can tune arbitrary weights. Tier ranking keeps the evaluation honest and highly interpretable. 

---

## 5. Evidence and Audibility

For a baseline to be trusted, it must be fully auditable.
Every candidate outputted by B5 must expose:
1. **Which generator found it** (B1, B2, B3, B4).
2. **The exact condition that triggered it** (e.g., "AST parsed an import statement at line 14").
3. **Temporal validity assertion** (e.g., "Co-change history evaluated up to commit X").

If a user asks "Why did you suggest this file?", the baseline must be able to return the exact `description` from the candidate's `evidence` array.

---

## 6. Failure Taxonomy

When the baseline fails to match the ground truth (the Tracebound pilot cases), the failure must be categorized strictly:

1. **Artifact Universe Failure:** The ground-truth artifact was not in the baseline's searchable pool (e.g., baseline only searched `.ts` files, but the artifact was `.md`).
2. **Candidate Generation Failure (Hard False Negative):** The artifact was in the universe, but no baseline generator (B1-B4) emitted a signal for it. It was completely missed.
3. **Evidence Extraction Failure:** A generator *should* have found it (e.g., it was imported), but the specific implementation failed (e.g., parser error, syntax unsupported).
4. **Ranking Failure:** The candidate was successfully generated and contained valid evidence, but was ranked too low to appear in the Top-K results.
5. **Temporal Leakage (System Error):** The baseline accidentally used post-cutoff information (e.g., it grepped the working tree instead of the `base_commit` tree).
6. **Unsupported Ground-Truth Relationship:** The ground truth relies on an implicit, semantic domain concept that simply cannot be expressed structurally, lexically, or historically (e.g., the debunked semantic link in TB-0001).

---

## 7. Evaluation Interface

The baseline output will be compared against the YAML case files. The evaluation harness must support:
* **Recall Analysis:** Did the baseline find the candidates listed in `case-001.yaml`?
* **Changed vs Unchanged Segregation:** How well does the baseline find unmodified investigation-worthy artifacts (like `checkout-lifecycle.md` in TB-0001) versus modified artifacts?
* **Per-Signal Attribution:** Which generator (B1, B2, etc.) is responsible for the true positives? Which generators produce the most false positives?

---

## 8. Experiment Structure

### Running B1-B5 Against Pilot Cases
The experiment will execute B1 through B5 against TB-0001, TB-0002, and TB-0003.
* **TB-0001 (Reservation Locks):** Tests if **B2 (Lexical)** can successfully retrieve `checkout-lifecycle.md` based on "reservation" or "lock" keywords derived from the change intent, and proves that **B1 (Structural)** correctly misses the unsupported source-to-source link.
* **TB-0002 (Order REFUNDED):** Tests if **B2 (Lexical)** can retrieve the heavily affected architecture documents and frontend components based on the exact symbol "REFUNDED". Proves that **B1 (Structural)** is blind to markdown documents.
* **TB-0003 (Hono Combine Test):** Tests if **B1 (Structural)** can flawlessly and effortlessly retrieve colocated unit tests via import graphs. 

### The Semantic Hypothesis Test (Research Constraint)
**We do not assume semantic retrieval (embeddings/LLMs) is necessary.**
Instead, the deterministic baseline is the test apparatus. 
*If* B5 (the combined baseline) achieves high recall on investigation-worthy artifacts across a larger suite of cases without overwhelming the user with noise, then semantic retrieval is unnecessary. 
*If and only if* error analysis reveals a persistent pattern of "Candidate Generation Failures" for valid, temporally sound, implicit conceptual relationships (where A and B share no keywords, no history, and no imports), *then* we have empirical justification to introduce semantic retrieval.

---

## 9. Non-Goals and Constraints

To prevent premature optimization and architecture bloat, this baseline design explicitly **prohibits**:
* Selecting or provisioning a production database (no PostgreSQL, no pgvector).
* Selecting an embedding model (no OpenAI, no local models).
* Using LLMs for summarization, reasoning, or query expansion.
* Building a vector database or using LangChain/LlamaIndex frameworks.
* Implementing microservices, REST APIs, or frontend web applications.

The immediate next step is to implement the bare minimum script/CLI harnessing `tsserver`, `ripgrep`, and `git` to populate the `BaselineCandidate` representation for the three pilot cases.
