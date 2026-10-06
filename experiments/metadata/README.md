# B4 Explicit Git Metadata Experiment

This directory implements the B4 Explicit Git Metadata baseline. It retrieves candidates by identifying explicitly documented relationships in Git history (e.g., commit messages mentioning "Issue/PR #123"), and grouping all files that historically shared that explicit reference.

## Implementation Details

* **Relationships Supported:** Sibling commits referencing the same Issue/PR number (e.g., `#123`).
* **Temporal Isolation:** The script strictly parses `git log` prior to the evaluation `base_commit`. No future commits, issues, or PRs are used.
* **Evidence:** Candidates are aggregated by path. Evidence is the number of distinct Issue/PR linkages (`relationship_count`).
* **Offline Execution:** Executed purely via local Git without requiring external GitHub API access, guaranteeing exactly reproducible historical state without API rate limits or pagination drift.

---

## Results

### TB-0001 & TB-0002 (WollyWay)
* **Candidates Retrieved:** 0
* **Relevant Candidates Found:** 0
* **Analysis:** The WollyWay repositories are private, simulated histories for the pilot evaluation. The specific commits historically modifying the target source files did not contain explicit `#PR` or `#Issue` linkages. Therefore, metadata retrieval yields zero candidates. This demonstrates the fragility of metadata retrieval: it silently fails when developers do not strictly follow conventional commit tagging.

### TB-0003 (Combine Middleware - Hono)
* **Candidates Retrieved:** 124
* **Relevant Candidates Found:** 1 (`src/middleware/combine/index.test.ts`)
* **Rank:** **1**
* **Evidence:** Connected across 5 distinct historical PRs/Issues (`#3905`, `#3663`, `#3441`, `#3393`, `#2941`).
* **Overlap:** Already discovered perfectly by B1 (Structural) and B3 (Co-Change).
* **False Positives:** 123 false positives. Central project files like `eslint.config.mjs` and `package.json` cluster heavily because massive repository-wide PRs (like `#3393` and `#4781`) modified them alongside the evaluated source file.

---

## Research Conclusion

> **Does B4 add materially useful information to the deterministic baseline?**

**No.**

Explicit Git Metadata (B4) suffers from the exact same polarized failure modes as Historical Co-Change (B3):

1. **Brittle & Sparse:** B4 relies entirely on humans manually typing `#123` into commit messages. When this convention is absent (as seen in TB-0001 and TB-0002), the signal disappears entirely, offering 0 candidates.
2. **Redundant for Code/Tests:** Where metadata is rich (TB-0003), B4 perfectly retrieves the test file (Rank 1). However, **B1 Structural Analysis already guarantees test discovery natively**. B4 merely replicates B1's success.
3. **Noisy:** B4 clusters completely unrelated files together merely because they happened to be bundled in the same large feature PR (e.g., modifying `combine/index.ts` and `package.json` for a release), introducing massive false positive noise.

Because B4 fails completely on architectural documentation (TB-0001/0002) and merely duplicates structural analysis for tests (TB-0003), it adds no new capability to the baseline. Tracebound is now empirically justified in abandoning further deterministic metadata mining and transitioning to semantic retrieval to bridge the Lexical Abstraction Gap.
