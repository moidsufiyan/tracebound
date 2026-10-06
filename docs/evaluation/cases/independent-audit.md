# Independent Evaluation Audit Report

**Date:** 2026-10-03
**Auditor:** Independent Review Agent
**Objective:** Audit cases TB-0001, TB-0002, and TB-0003 for temporal validity, label defensibility, and methodological bias according to Phase 0 constraints.

---

## Case TB-0001 (WollyWay: checkout.service.ts & inventory.service.ts)

### Historical Validity
* **Commit Identifiers & Identity:** Verified. `a0885a13` was committed on 2026-09-05. Base commit `bc84e844` is correct.

### Temporal Validity
* **Status:** **FAILED (Hindsight Leakage)**
* **Details:** The case claims structural evidence: *"inventory.service.ts was modified to import and depend on checkoutService from checkout.service.ts"*. This dependency did **not** exist at the `base_commit` (`bc84e844`). It was introduced by the change itself (`a0885a13`). Relying on the diff of the target change as evidence is textbook hindsight leakage. 

### Candidate-Label Audit
* **Candidate:** `checkout.service.ts`
* **Claimed Relationship:** `co-changes-with` / `direct-impact`
* **Disputed Points:** The label `direct-impact` is defended using structural evidence that didn't exist prior to the change. At `base_commit`, `inventory.service.ts` and `checkout.service.ts` had no direct import graph connection in either direction. 
* **Corrected View:** The relationship at `base_commit` was purely semantic/domain-level (both dealt with inventory allocation concepts) and potentially historical, but absolutely not structural.

### Difficulty & Deterministic vs Semantic Characterization
* **Difficulty:** Very Difficult (deterministically). 
* **Characterization:** Requires semantic reasoning (understanding that "stock reduction" and "checkout locks" are functionally intertwined for race conditions) because deterministic structural links were absent before the fix.

---

## Case TB-0002 (WollyWay: order-lifecycle.md)

### Historical Validity
* **Commit Identifiers & Identity:** Verified. `b80220d9` was committed on 2026-09-06. Base commit `42f74535` is correct.

### Temporal Validity
* **Status:** **PASSED**
* **Details:** The architectural documentation (`backend/docs/architecture/order-lifecycle.md`) explicitly diagrammed the `REFUNDED` state (e.g. `DELIVERED --> REFUNDED : Returned & Refunded (Admin - Phase 4.5)`) at the `base_commit`. The evidence was available at the cutoff.

### Candidate-Label Audit
* **Candidate:** `backend/docs/architecture/order-lifecycle.md`
* **Claimed Relationship:** `documents` / `direct-impact`
* **Disputed Points:** None. The label is defensible. A developer changing global state constants must update architectural documents representing those states to prevent system rot.

### Difficulty & Deterministic vs Semantic Characterization
* **Difficulty:** Moderate.
* **Characterization:** Lexical/Semantic. A deterministic structural parser (like tsserver) cannot find this relationship. Lexical search for the string "REFUNDED" or semantic search for order state transitions would succeed.

---

## Case TB-0003 (Hono: combine middleware test)

### Historical Validity
* **Commit Identifiers & Identity:** Verified. `afb2068c` was committed on 2026-09-30. Base commit `e5bb2062` is correct.

### Temporal Validity
* **Status:** **PASSED**
* **Details:** The test file (`src/middleware/combine/index.test.ts`) existed, was colocated, and explicitly imported the `some` function at `base_commit`. 

### Candidate-Label Audit
* **Candidate:** `src/middleware/combine/index.test.ts`
* **Claimed Relationship:** `test-of` / `direct-impact`
* **Disputed Points:** None. This is a canonical, undeniable test-to-source relationship.

### Difficulty & Deterministic vs Semantic Characterization
* **Difficulty:** Easy.
* **Characterization:** Structural. Deterministic tools (like AST parsers or tsserver) will trivially resolve the import path `import { some } from '.'` inside the colocated test file.

---

## Cross-Case Findings

### Strengths
* **Diversity of Types:** The pilot cases cover a good spread: cross-domain logic (TB-0001), architectural documentation (TB-0002), and collocated unit tests (TB-0003). 
* **Rigorous Schema:** The use of `content_hash_at_base` successfully allowed me to audit the exact state of files at the cutoff, making it easy to catch the methodological failure in TB-0001.

### Weaknesses & Methodological Problems
* **Hindsight Bias:** TB-0001 proves that even with strict schema rules, human/agent labelers easily conflate "what the fix was" with "what evidence was available before the fix."
* **Triviality Risk:** TB-0003 is almost too easy. Any basic IDE "find references" tool would discover it immediately. While necessary as a baseline sanity check, a dataset of exclusively TB-0003-like cases would be useless for evaluating advanced traceability tools.

### Selection Bias & Missing Case Types
* **Overrepresentation:** 2 of 3 cases rely heavily on lexical or structural links (TB-0002, TB-0003).
* **Missing:** We lack a case featuring a transitive structural dependency (A uses B, B uses C -> developer changes C and breaks A). We also lack an `investigation-worthy` case where the developer *should* inspect a file, but ultimately doesn't change it. All current candidates are files that were actually modified in the source commit (`changed_artifacts`). This biases the dataset toward files that *did* change, rather than files that *needed to be checked*.

### Critical Research Question Answer
> Do these three cases provide evidence that conventional structural and lexical analysis may be insufficient?

**Yes.** Even discarding the hindsight error in TB-0001, if we treat TB-0001 purely from the `base_commit` state, a deterministic structural tool would fail to connect `inventory.service.ts` to `checkout.service.ts`. Finding that connection requires understanding the distributed architectural design of the application (e.g. knowing that inventory reduction relies on checkout locks). TB-0002 also proves that structural analysis is entirely blind to architectural documentation synchronization.

---

## Final Recommendation

**2. Repair existing cases first**

**Rationale:** TB-0001 contains a severe methodological violation (hindsight leakage) in its evidence claims. It must be rewritten to remove the post-cutoff structural evidence and rely solely on the semantic/historical evidence available at `base_commit`, or be excluded. Furthermore, the dataset currently lacks candidates that were investigated but *not* changed. We must address these issues before designing the baseline to ensure the evaluation framework is actually rigorous.

---
**Validation Notes:**
* Commands: `git -C <repo> show <base_commit>:<path>`, `git log -S`, `Select-String`.
* Repositories: `moidsufiyan/wollyway`, `honojs/hono`.
* Temporal inconsistency found in TB-0001 (import added in `a0885a13` was claimed as evidence).
