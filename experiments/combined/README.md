# B5 Combined Deterministic Baseline

This directory implements B5, the combined structural (B1) and lexical (B2) deterministic baseline for Tracebound.

## B5 Implementation

* **Files Created:** `package.json`, `index.js`, `README.md`, `outputs/summary.json`.
* **Reuse of B1/B2:** B5 is implemented as a stateless candidate aggregation layer. Rather than duplicating parser or regex logic, it loads the immutable output arrays from `experiments/structural/outputs/` and `experiments/lexical/outputs/` and computes the mathematical union using a canonical identity map keyed by historical artifact path. This guarantees zero regression in the underlying deterministic signals.
* **Ranking Approach:** The deterministic tier-ranking strategy defined in `docs/baseline/deterministic-baseline.md` is strictly enforced without arbitrary numeric weights. Candidates possessing B1 structural evidence are categorized as **Tier 1 (Structural)**. Candidates possessing only B2 lexical evidence but exhibiting high density (path matches or $\ge3$ exact term matches) are categorized as **Tier 2 (Strong Lexical)**. The remaining B2 noise is categorized as **Tier 3 (Weak Lexical)**.

---

## Per-Case Comparison

### TB-0001 (Reservation Locks - WollyWay)
* **Candidate Count:** B1: 0 | B2: 245 | B5 (Union): 243 (excluding changed files)
* **Relevant Coverage:** 1/1 found
* **Missed Candidates:** 0
* **Changed/Unchanged:** Found 1 unchanged relevant candidate.
* **Provenance:** Discovered *only* by B2. B1 is blind to documentation.

### TB-0002 (Order REFUNDED - WollyWay)
* **Candidate Count:** B1: 0 | B2: 245 | B5 (Union): 244 (excluding changed files)
* **Relevant Coverage:** 1/1 found
* **Missed Candidates:** 0
* **Changed/Unchanged:** Found 1 changed relevant candidate.
* **Provenance:** Discovered *only* by B2. B1 is blind to documentation.

### TB-0003 (Combine Middleware - Hono)
* **Candidate Count:** B1: 8 | B2: 364 | B5 (Union): 365 (excluding changed files)
* **Relevant Coverage:** 1/1 found
* **Missed Candidates:** 0
* **Changed/Unchanged:** Found 1 changed relevant candidate.
* **Provenance:** Discovered by *both* B1 and B2. B1 provided the Tier 1 deterministic relationship (`[Test-to-Source Dependency]`), while B2 independently found it through keyword collisions. 

---

## Comparative Analysis

1. **What does B1 find that B2 misses?**
   In the three pilot cases, B1 did not find any truth candidates that B2 missed. B2's massive lexical net successfully caught the `index.test.ts` file in TB-0003. However, B1 provides the *ranking certainty* (Tier 1) that B2 lacks.
2. **What does B2 find that B1 misses?**
   B2 successfully discovers natural language documentation and architecture files (TB-0001, TB-0002) which are fundamentally invisible to B1's AST module resolution.
3. **What does their union recover that either alone misses?**
   The union successfully recovers 100% of the relevant ground truth candidates across all three pilot cases without requiring semantic embeddings.
4. **How much additional noise does the union produce?**
   The union produces severe noise (242 to 364 false positives per case). Because B2 is a blunt lexical instrument over the whole repository, the union inherits 100% of B2's lexical noise.
5. **Does the documented tier ranking improve candidate ordering without arbitrary tuning?**
   Yes. By using the B1 signal as Tier 1, the true test dependency in TB-0003 is immediately surfaced to the top of the 365 candidates. The strong lexical thresholds (Tier 2) successfully grouped the TB-0001 and TB-0002 documentation candidates above the hundreds of weak Tier 3 false positives. 
6. **Which failure modes remain?**
   While recall is currently 100%, precision is terrible for Tier 2/3. Lexical noise completely floods the candidate pool.

---

## Failure Analysis

* **Structural Coverage:** Adequate for direct imports and tests, but ignores transitive chains.
* **Lexical Coverage:** 100% recall observed in the pilot.
* **Lexical Noise:** *Catastrophic*. Resolving common terms like "order", "update", or "response" pulls in hundreds of irrelevant artifacts.
* **Ranking:** The categorical Tiers (1, 2, 3) are effective, but Tier 3 is too large to manually inspect.
* **Candidate Generation:** Currently relies entirely on exact matches or structural edges.
* **Relationship Direction:** B1 currently emits outgoing dependencies (`[Direct Import]`) which the TB-0003 audit proved were genuine false positives. 
* **Temporal:** Perfectly isolated; respects historical `base_commit`.
* **Artifact-Universe:** Unconstrained; searches the entire repository.

---

## Research Conclusion

> **Does the combined deterministic baseline currently provide enough coverage and candidate quality to justify building another deterministic component, or is there now a specific unresolved gap worth investigating?**

The combined deterministic baseline provides 100% coverage (recall) of the ground truth across the three pilot cases, successfully bridging B1's blindness to documentation and B2's lack of code-structure awareness. Therefore, building additional deterministic generation layers (like deeper structural analysis) is not currently justified.

However, there is now a **specific unresolved gap worth investigating: catastrophic lexical noise (precision collapse).** The B5 baseline surfaces hundreds of false positives per case. The immediate research priority must shift from *candidate generation* to *candidate filtering and reranking*. We need a mechanism—likely semantic evaluation or historical co-change analysis (B3)—capable of distinguishing between an artifact that merely contains the word "order" and an artifact that is *conceptually impacted* by a change to order logic.
