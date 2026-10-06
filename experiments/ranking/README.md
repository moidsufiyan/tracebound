# B6 Deterministic Candidate Ranking

This directory contains the B6 deterministic candidate ranking layer for Tracebound. It operates as a stateless post-processing filter over the B5 candidate union, scoring and sorting candidates using structural constraints and lexical density.

## Ranking Design

The core hypothesis of B6 is that deterministic evidence can be categorically sorted without arbitrary numerical weights (e.g., "import = 10, keyword = 2"). 

### Signals Used
1. **Structural Direction (B1):** Distinguishes between incoming dependents (tests, reverse imports) and outgoing dependencies.
2. **Lexical Density (B2):** Number of unique, distinct token matches (IDF proxy).
3. **Contextual Specificity:** Path-based lexical matches (filename similarity).

### Precedence Logic
Candidates are partitioned strictly into ordered, non-overlapping categories:
1. **Critical Structural:** Incoming dependent or test-to-source relationship (Tier 1 Code).
2. **Strong Lexical (Path + Multi-Content):** Candidate filename matches a query token AND contains $\ge 3$ unique query terms.
3. **Strong Lexical (High Content Density):** Candidate contains $\ge 5$ unique query terms.
4. **Weak Structural:** Outgoing dependency. Structurally sound, but directionally insulated from change.
5. **Moderate Lexical (Path Match Only):** Only filename matched.
6. **Moderate Lexical (Multiple Tokens):** Matches $\ge 2$ unique terms.
7. **Weak Lexical:** Single generic token match.

### Lexical Specificity Method
Lexical strength is calculated as the `Set` size of unique terms matched within the artifact. This naturally filters out documents that merely repeat the word "order" 50 times, prioritizing artifacts that contain a cluster of the relevant domain terms (e.g., "order", "refunded", "state").

### Tie-Breaking
If two candidates fall into the same category, they are tie-broken by:
1. Maximum number of unique content tokens matched.
2. Maximum number of unique path tokens matched.
3. Shorter path length (prioritizing foundational/root files).
4. Alphabetical sort (for deterministic reproducibility).

---

## Results: B5 vs B6

### TB-0001 (Reservation Locks - WollyWay)
* **B5 Union Rank:** Unknown (Lost in 242 false positives)
* **B6 Top-1:** False
* **B6 Top-3:** False
* **B6 Top-5:** False
* **B6 Top-10:** False
* **B6 Top-20:** **True (Rank #12)**
* *Comment:* The ground truth documentation file (`backend/docs/architecture/checkout-lifecycle.md`) successfully breached the Top-20. It lost tie-breakers to shorter files (e.g., `CHECKOUT_STATE_MACHINE.md`) that contained a similar dense overlap of domain terms.

### TB-0002 (Order REFUNDED - WollyWay)
* **B5 Union Rank:** Unknown (Lost in 243 false positives)
* **B6 Top-1:** **True (Rank #1)**
* **B6 Top-3:** True
* **B6 Top-5:** True
* **B6 Top-10:** True
* **B6 Top-20:** True
* *Comment:* Flawless retrieval. The ground truth `backend/docs/architecture/order-lifecycle.md` possessed the highest multi-term density across the repository for this change.

### TB-0003 (Combine Middleware - Hono)
* **B5 Union Rank:** Unknown (Mixed in 364 false positives)
* **B6 Top-1:** **True (Rank #1)**
* **B6 Top-3:** True
* **B6 Top-5:** True
* **B6 Top-10:** True
* **B6 Top-20:** True
* *Comment:* Flawless retrieval. The B1 `[Test-to-Source Dependency]` signal triggered the "Critical Structural" category, instantly forcing the test to Rank #1 ahead of 364 lexical false positives.

---

## Failure Analysis

What remains difficult after deterministic ranking?

1. **Lexical Tie-Breaker Collisions:** In TB-0001, the target documentation file ranked #12 because it shared the identical "Strong Lexical" tier with 11 other artifacts. When a developer makes a domain-heavy change, the entire domain module (APIs, schemas, services, locks) lights up with exact lexical overlap. Deterministic lexical metrics cannot reliably differentiate the "correct" concept file from a sibling file that simply shares the domain vocabulary.
2. **Missing Conceptual Links:** Lexical matching is purely token-based. If a document describes the architecture using synonymous but distinct phrasing from the code, it will fail to trigger the high-density thresholds and plummet to a Weak Lexical tier.

---

## Research Conclusion

> **Has deterministic ranking substantially solved the precision problem, or is there a residual class of relevant relationships that remains difficult despite good deterministic evidence?**

Deterministic ranking has **partially solved** the precision problem, but it has hit the theoretical ceiling of stateless string matching. 

By enforcing strict directional semantics (prioritizing incoming over outgoing dependencies) and calculating unique lexical density, B6 miraculously pushed the ground-truth candidate to **Rank 1 in two out of three cases**, and **Rank 12** in the third, out of hundreds of noisy candidates.

However, a **residual class of relevant relationships remains fundamentally difficult:** domain-cluster collisions. In large refactors, a high volume of artifacts will share identical vocabulary density (e.g., in TB-0001, 11 other files had the same dense overlap as the actual architectural document). Deterministic rules have no semantic awareness to differentiate *why* the terms overlap. 

To cross this final gap and reliably break lexical ties within dense domain clusters, Tracebound now has empirical justification to introduce **semantic retrieval or intelligent reranking**.
