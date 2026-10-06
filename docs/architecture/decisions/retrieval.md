# ADR: Hybrid Retrieval Strategy

**Decision:** Implement Candidate Union + Reciprocal Rank Fusion (RRF, K=60) without an initial learned reranker.
**Context:** Phase 1 experiments evaluated deterministic ranking (B6), semantic retrieval (B7), and three hybrid fusion strategies (H1, H2, H3). The audit proved that H3's heuristic tiering was brittle and functionally identical to H2 (RRF), while H2 organically suppressed semantic false positives and elevated true artifacts.
**Alternatives:** 
- Heuristic-based evidence tiering (H3)
- LLM Cross-Encoder Reranker
- Pure semantic retrieval
**Chosen approach:** Deterministic and semantic pipelines will independently generate candidate lists (H1 Candidate Union). These lists are merged using a stateless Reciprocal Rank Fusion (RRF) algorithm with the standard constant `K=60`. 
**Tradeoffs:** 
- *Pros:* Extreme performance, parameter-free, strictly isolated from ground-truth leakage, and proven empirically on the Tracebound benchmark to effectively balance abstraction-gap recall with structural precision.
- *Cons:* Top-1 precision may be slightly lower than a heavy cross-encoder, but the reasoning layer operates on Top-10 candidates where RRF excels.
