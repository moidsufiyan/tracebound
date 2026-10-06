# B3 Historical Co-Change Experiment

This directory implements the B3 historical co-change baseline for Tracebound. It retrieves candidates that historically changed in the same commits as the currently modified artifacts, strictly bounded by the `base_commit` evaluation cutoff.

## Implementation Details

* **Temporal Isolation:** The script uses `git log <base_commit> -- <file>` to extract exactly the history prior to the evaluated change. It ensures the change itself, and any subsequent future commits, are fully excluded.
* **Evidence:** Candidates are aggregated by path. Evidence consists of the total number of historical co-commits (`co_change_count`), the timestamps, and the specific commit hashes.
* **Ranking:** Deterministically ordered by `co_change_count` (descending), then `latest_timestamp` (descending), then alphabetically.

---

## Results

### TB-0001 (Reservation Locks - WollyWay)
* **B3 Candidates Retrieved:** 121
* **Relevant Candidates Found:** 1 (`backend/docs/architecture/checkout-lifecycle.md`)
* **Rank:** **111**
* **Evidence:** Co-changed exactly 1 time in history.
* **Overlap:** Already discovered by B2/B6.
* **False Positives:** God-files completely dominate. `backend/src/app.ts` (count: 4), `backend/src/constants/index.ts` (count: 3), and `CHANGELOG.md` (count: 3) occupy the top ranks because they are modified in almost every feature PR.

### TB-0002 (Order REFUNDED - WollyWay)
* **B3 Candidates Retrieved:** 135
* **Relevant Candidates Found:** 1 (`backend/docs/architecture/order-lifecycle.md`)
* **Rank:** **75**
* **Evidence:** Co-changed exactly 1 time in history.
* **Overlap:** Already discovered by B2/B6 (where it ranked #1).
* **False Positives:** Again, God-files dominate. `app.ts` co-changed 9 times and took Rank #1.

### TB-0003 (Combine Middleware - Hono)
* **B3 Candidates Retrieved:** 125
* **Relevant Candidates Found:** 1 (`src/middleware/combine/index.test.ts`)
* **Rank:** **1**
* **Evidence:** Co-changed 5 times in history.
* **Overlap:** Already discovered perfectly by B1 (Structural).
* **False Positives:** Linter configs (`eslint.config.mjs`) and package definitions (`package.json`) clutter the top 10 due to dependency bumps spanning the repository.

---

## Research Conclusion

> **Does historical co-change materially improve the deterministic baseline?**

**No.**

Historical co-change behaves in a highly polarized manner that perfectly shadows the existing B1 and B6 baselines without adding any new capability:

1. **For Documentation (TB-0001, TB-0002):** B3 fails to elevate architectural documentation. Documents are rarely updated in the exact same git commit as localized bug fixes. Consequently, the ground-truth documents receive an extremely weak signal (co-change count = 1) and plummet to ranks 75 and 111. The B6 lexical method is exponentially better at retrieving documentation.
2. **For Code/Tests (TB-0003):** B3 brilliantly elevates the test file to Rank 1 (count = 5), proving that tests historically co-change with their source files. However, **B1 Structural Analysis already guarantees test discovery natively**. B3 merely replicates B1's success while adding 123 false-positive noise candidates (God-files, linters, package.jsons).

Because B3 fails where B6 struggles, and merely duplicates where B1 succeeds, historical co-change does not justify inclusion in the final retrieval pipeline. Tracebound has definitively exhausted deterministic retrieval methods. The only remaining path to resolve the lexical abstraction gap identified in B6/B6.1 is semantic retrieval.
