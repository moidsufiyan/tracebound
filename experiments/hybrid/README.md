# Hybrid Retrieval v1: Experiment Design

## Context & Research Question
Tracebound has exhaustively evaluated Deterministic Retrieval (B1-B6) and Semantic Retrieval (B7). 
* **Deterministic retrieval** provides robust structural dependency mapping but is blind to conceptual/abstraction-gap changes.
* **Semantic retrieval** bridges the abstraction gap effectively but is imprecise, suffering from semantic false positives (e.g., TB-0009) and neighborhood clustering.

**Research Question:** Can combining deterministic and semantic evidence improve useful Top-K impact candidates beyond either approach individually, without making one approach a hard filter for the other?

## Objective
Design and evaluate a stateless Hybrid Retrieval system that fuses deterministic and semantic evidence. This experiment compares deterministic-only, semantic-only, and hybrid ranking approaches over the established 9-case benchmark.

---

## Core Architecture
```
Change (TB-XXXX)
       │
       ├──────────────┐
       ▼              ▼
┌──────────────┐ ┌──────────────┐
│ Deterministic│ │ Semantic     │
│ Retrieval    │ │ Retrieval    │
│ (B5 / B6)    │ │ (B7.1)       │
└──────┬───────┘ └──────┬───────┘
       │                │
       ▼                ▼
   ┌────────────────────────┐
   │    Candidate Union     │ (Artifact Deduplication)
   └──────────┬─────────────┘
              │
              ▼
   ┌────────────────────────┐
   │    Evidence Fusion     │ (Preserve distinct evidence sources)
   └──────────┬─────────────┘
              │
              ▼
   ┌────────────────────────┐
   │     Hybrid Ranking     │ (H1, H2, H3 models)
   └──────────┬─────────────┘
              │
              ▼
   ┌────────────────────────┐
   │ Evidence-Backed Output │ (Top-K candidates)
   └────────────────────────┘
```

---

## Candidate Identity & Evidence Model
Candidate identity is defined by the **canonical artifact path** relative to the repository root.

The system will generate a unified JSON object per artifact that preserves both deterministic and semantic evidence independently. It will never collapse these into an opaque score.

**Example Evidence Model:**
```json
{
  "artifact": "backend/docs/architecture/order-lifecycle.md",
  "deterministic_evidence": {
    "found": false,
    "rank": null,
    "signals": []
  },
  "semantic_evidence": {
    "found": true,
    "rank": 5,
    "similarity": 0.698,
    "matched_chunk": "Order States"
  },
  "hybrid_evidence": {
    "source": "semantic-only"
  }
}
```

---

## Fusion Experiments

The experiment will compare three distinct fusion strategies. The first step for all strategies is `UNION(Deterministic Candidates, Semantic Candidates)`.

### H1 — Candidate Union Without Reranking (Control)
* **Design**: Interleave or group the candidates without altering their original rankings from B6 or B7.1.
* **Purpose**: Serves as the baseline hybrid approach to measure raw recall (coverage) improvements before tuning ranking mechanisms.

### H2 — Reciprocal Rank Fusion (RRF)
* **Design**: Standard rank fusion formula used to combine sets with different scoring scales (cosine similarity vs TF-IDF/structural weight).
* **Formula**: `Score = ( 1 / (K + rank_det) ) + ( 1 / (K + rank_sem) )`
* **Parameters**: `K = 60` (standard constant). If an artifact is missing from one retrieval method, its rank for that method is considered infinity (score = 0).
* **Purpose**: Test if rank consensus naturally floats the most relevant artifacts to the Top 3.

### H3 — Evidence-Aware Precedence
* **Design**: Rule-based tiering where specific, high-confidence deterministic evidence acts as a stronger explanatory signal than raw semantic similarity. 
* **Rules / Precedence Classes**:
  1. **Tier 1 (High Confidence Both)**: Direct reverse-import/test relationship (Deterministic) AND high semantic similarity (Top 10 Semantic).
  2. **Tier 2 (High Confidence Deterministic)**: Exact symbol relationship (Deterministic), regardless of semantic score.
  3. **Tier 3 (Semantic Abstraction)**: High semantic similarity (Top 5) but NO deterministic evidence (bridges the abstraction gap).
  4. **Tier 4 (Weak Consensus)**: Low-rank deterministic + Low-rank semantic.
* **Purpose**: Test whether explicitly trusting exact structural signals prevents semantic false positives (like TB-0009) while allowing semantic signals to rule when structural signals are absent (TB-0006/0007).

---

## Evaluation Methodology

The Hybrid experiments will be run across all 9 cases and evaluated against the existing ground-truth labels. No fusion parameters will be tuned case-by-case.

### 1. Metrics to Compare (Deterministic vs Semantic vs H1/H2/H3)
- **Recall / Coverage**: Total relevant artifacts found.
- **Top-K Precision**: Hits in Top-1, Top-3, Top-5, Top-10, Top-20.
- **Complementarity**:
  - `deterministic-only` wins
  - `semantic-only` wins
  - `both`
  - `missed-by-both`
  - `newly-recovered` (by hybrid synergy)

### 2. False Positive Analysis
Specifically inspect:
- **TB-0009**: Did H2/H3 mitigate the semantic false positive (Rank 3) by observing the lack of external API change structurally?
- **TB-0001**: Did hybrid fusion reduce the noise of semantic neighborhood collisions?
- **Evidence Conflict**: How did the system rank artifacts found by both methods but with wildly conflicting ranks?

### 3. Failure Taxonomy
Hybrid failures will be categorized as:
- **Candidate generation failure**: Both methods failed to recall the artifact.
- **Semantic false positive**: Imprecise semantic matching pushed an irrelevant artifact too high.
- **Deterministic false positive**: Structural mapping pushed a noisy, irrelevant dependency too high.
- **Ranking failure**: Found by both, but fusion pushed it out of the Top-K.
- **Evidence conflict**: H3 precedence rules incorrectly demoted a valid artifact.
- **Temporal issue**: Grounding errors in historical state.

---

## Technical Implementation Plan
- **Directory**: `experiments/hybrid/`
- **Inputs**: Stateless consumption of existing `experiments/ranking/outputs/` (Deterministic) and `experiments/semantic/outputs/` (Semantic).
- **Tooling**: Node.js script (`index.js`). No new vector databases, LLM cross-encoders, or learned rerankers will be introduced in this phase.
