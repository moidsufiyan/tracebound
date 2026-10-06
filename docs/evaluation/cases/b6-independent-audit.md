# B6 Independent Ranking Audit

**Date:** 2026-10-03
**Auditor:** Principal Search Engineer
**Objective:** Independently audit the B6 deterministic ranking baseline for methodological validity, leakage, tuning, and theoretical limits.

---

## 1. Ranking Model

I independently inspected `experiments/ranking/index.js`. The B6 implementation uses the following ranking signals and precedence logic:

### Categories (Strict Precedence)
1. **Critical Structural:** Artifact has a `[Reverse Import]` or `[Test-to-Source Dependency]` edge from the B1 baseline.
2. **Strong Lexical (Path + Multi-Content):** Artifact has $\ge 1$ path token match AND $\ge 3$ unique content token matches from B2.
3. **Strong Lexical (High Content Density):** Artifact has $\ge 5$ unique content token matches.
4. **Weak Structural:** Artifact has a `[Direct Import]` edge from B1 (an outgoing dependency).
5. **Moderate Lexical (Path Match Only):** Artifact has $\ge 1$ path token match.
6. **Moderate Lexical (Multiple Tokens):** Artifact has $\ge 2$ unique content matches.
7. **Weak Lexical:** Artifact has exactly 1 unique content match.

### Tie-Breakers (In Order)
If candidates share a category, they are sorted by:
1. `lex_all_count`: Total unique query terms matched (descending).
2. `lex_path_count`: Total unique path terms matched (descending).
3. `path.length`: Length of the filepath string (shorter = better).
4. `path.localeCompare()`: Alphabetical sorting for absolute determinism.

---

## 2. Leakage Audit

**Finding:** B6 is completely independent and contains NO ground-truth leakage.
* The evaluation labels (the `relevant_found` subset) are extracted strictly to calculate evaluation metrics (Top-K) *after* the entire candidate universe is deterministically sorted.
* The ranking function `rankCandidates()` has no access to the `truthCandidate` or any evaluation labels.

---

## 3. Reproducibility

**Finding:** Results reproduce exactly.
* Command executed: `node index.js` inside `experiments/ranking/`.
* The `path.localeCompare()` tie-breaker guarantees that equivalent lexical matches will always sort in the same order regardless of filesystem traversal order or OS.

---

## 4. Tuning Audit

**Finding:** There is NO evidence of malicious case-specific tuning or overfitting.
* The thresholds (3 unique terms, 5 unique terms) are round heuristic numbers, not hyper-fitted exact values.
* The tie-breaker `path.length` (shorter paths first) actively **penalized** the TB-0001 ground-truth document (`backend/docs/architecture/checkout-lifecycle.md`), forcing it down to Rank 12 beneath shorter paths like `CHECKOUT_STATE_MACHINE.md`. If the author had tuned B6 for the pilot cases, they would have reversed this tie-breaker.
* TB-0002 ranked #1 because it genuinely had the absolute highest `lex_all_count` in the repository for its query.
* TB-0003 ranked #1 because it legitimately possessed the only incoming structural edge (`[Test-to-Source Dependency]`).

---

## 5. Pilot-Case Audit

### TB-0001 (WollyWay)
* **Current Rank:** 12
* **Strongest Competing Candidates:** `CHECKOUT_STATE_MACHINE.md`, `backend/scripts/verify-order-domain.ts`, `backend/docs/checkout-order-contract.md`.
* **Why they ranked above:** All shared the exact same Category (Tier 2) and identical lexical density. They won purely on the generic tie-breaker (shorter path lengths). 
* **Defensibility:** Highly defensible. Lexically, these documents are indistinguishable from the ground truth because they share the exact same domain vocabulary ("checkout", "state", "order").

### TB-0002 (WollyWay)
* **Current Rank:** 1
* **Why it ranked #1:** Achieved the highest unique token overlap ("order", "lifecycle", "refunded", "state", "status").
* **Defensibility:** Completely justified by TF principles. It was the most topically dense document for the query.

### TB-0003 (Hono)
* **Current Rank:** 1
* **Why it ranked #1:** Triggered Category 1 (Critical Structural).
* **Defensibility:** Flawless. Tests of modified files are universally high-priority impact candidates.

---

## 6. Remaining Deterministic Opportunities

B6 successfully implemented *Boolean Term Overlap* and *Directed Edges*, but it entirely ignored several standard deterministic IR features:

1. **TF-IDF (Term Frequency-Inverse Document Frequency):** B6 treats the generic word "update" as carrying the exact same mathematical weight as the highly specific function name "inventoryservice.updatestock". This is the primary reason TB-0001 suffered a 11-way tie.
2. **Historical Co-Change (B3):** Files that frequently appear in the same git commits.
3. **Term Proximity:** Checking if query terms appear in the same paragraph vs. opposite ends of a 5,000-line file.
4. **Code-to-Docs AST Mapping:** Parsing code blocks *inside* Markdown files to find exact symbol matches against the B1 structural graph.

---

## 7. Research Conclusion

> **Does B6 provide credible evidence that deterministic ranking has reached a meaningful limitation, or are there still obvious deterministic ranking improvements that should be tested before introducing semantic retrieval?**

B6 proves that categorical deterministic rules are highly effective (achieving Rank #1 and Rank #12 natively), but it does **not** prove that deterministic ranking has reached its limit. The lexical precision collapse observed in TB-0001 (an 11-way tie) is an artificial limitation caused by omitting term-weighting (IDF) and historical commit graphs (B3).

### Final Recommendation

**3. Add specific deterministic ranking improvements before expanding benchmark.**

Before introducing expensive semantic embeddings or LLMs, Tracebound must implement a basic term-weighting mechanism (e.g., IDF) to penalize generic vocabulary, and introduce the B3 Historical Co-Change baseline. Only when these mathematically sound deterministic signals fail to break ties should semantic evaluation be introduced.
