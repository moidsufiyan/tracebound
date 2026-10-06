# Independent Re-audit & Ground-Truth Verification Report

**Date:** 2026-10-03
**Auditor:** Principal Evaluation Engineer
**Objective:** Re-audit the repaired Tracebound pilot dataset (TB-0001, TB-0002, TB-0003) to verify temporal validity, candidate defensibility, and deterministic discoverability, and determine readiness for baseline experiments.

---

## 1. Case Validations

### TB-0001 (WollyWay: Reservation Locks)
* **Identity & Commits:** Correct. Base commit is `bc84e844`.
* **Artifact Existence & State at Cutoff:** Verified. `backend/docs/architecture/checkout-lifecycle.md` existed at cutoff with the exact documented content.
* **Special Focus - Semantic Relationship between Source Files:** The previous audit removed the structural dependency claim between `inventory.service.ts` and `checkout.service.ts`. However, I audited the claim that they share a pre-change semantic/domain relationship. 
  * **Finding:** **UNSUPPORTED.** At `base_commit`, `inventory.service.ts` had no semantic awareness of reservations or checkout locks; it only initialized a unused `reserved: 0` field. The concept of checking checkout reservations before stock deduction was introduced entirely *by the change commit itself*. Therefore, any claim that these two files had a discoverable semantic relationship prior to the change is a hallucination of hindsight. They were functionally and lexically siloed.
* **Special Focus - Unchanged Candidate (`checkout-lifecycle.md`):** 
  * **Finding:** **SUPPORTED.** The architectural document explicitly details the 15-minute lock expiry mechanism that the Lua script bug in `checkout.service.ts` was failing to honor. A developer modifying this lock logic must investigate the architecture document to ensure the system invariants match the implementation. This relationship is highly defensible and valid at cutoff.
* **Difficulty:** Moderate to Difficult.
* **Deterministic Discoverability:** Lexical search (for "lock" or "reservation") from the context of `checkout.service.ts` would find it. Structural traversal would completely fail.
* **Hindsight Leakage:** None in the repaired candidate list.

### TB-0002 (WollyWay: Order REFUNDED State)
* **Identity & Commits:** Correct. Base commit is `42f74535`.
* **Artifact Existence & State at Cutoff:** Verified. `backend/docs/architecture/order-lifecycle.md` existed and explicitly contained the word "REFUNDED" and its state transition.
* **Label Defensibility:** `direct-impact` is defensible. Removing a global state necessitates removing its documentation.
* **Difficulty:** Easy to Moderate.
* **Deterministic Discoverability:** Purely lexical search (grepping for "REFUNDED" or "ORDER_STATUS") easily discovers this. Structural traversal (AST, imports) fails completely because markdown isn't structurally linked to TypeScript enums.
* **Hindsight Leakage:** None.

### TB-0003 (Hono: Combine Middleware Test)
* **Identity & Commits:** Correct. Base commit is `e5bb2062`.
* **Artifact Existence & State at Cutoff:** Verified. `src/middleware/combine/index.test.ts` existed and directly imported `some` from `index.ts`.
* **Label Defensibility:** `direct-impact` is undeniable. It is a colocated test exercising the modified behavior.
* **Difficulty:** Trivial / Easy.
* **Deterministic Discoverability:** Direct reference / structural dependency (TypeScript import statement), plus co-location (same directory).
* **Hindsight Leakage:** None.

---

## 2. Special Focus: Changed vs Unchanged

The repaired dataset correctly distinguishes the candidates:
* **TB-0001:** Features an excellent **unchanged** `investigation-worthy` candidate (`checkout-lifecycle.md`). 
* **TB-0002 & TB-0003:** The candidates are **changed** artifacts (they were modified in the commit). While valid for testing if a system can find all parts of a known change, a dataset consisting solely of modified artifacts fails to test the core value proposition of an impact analysis tool: finding the things a developer *forgot* to change but should have looked at. 
* *Status:* The dataset now has 1 unchanged candidate out of 3 cases. This is acceptable for a pilot, but must be expanded.

---

## 3. Evaluate Research Bias

The three cases currently **overrepresent**:
1. **Modified artifacts:** 2 out of 3 candidates are artifacts that actually changed.
2. **Obvious textual relationships:** Both documentation candidates (TB-0001 and TB-0002) share explicit, exact keywords ("lock", "reservation", "REFUNDED") with the source code or the issue intent.
3. **Direct dependencies / Colocated tests:** TB-0003 is a trivial direct import in the same directory.

The dataset **misses**:
1. **Transitive structural dependencies:** (e.g., A calls B, B calls C. Changing C breaks A. Neither A nor B shares obvious lexical terms with C).
2. **Implicit semantic dependencies:** An unchanged candidate that requires inspection but does NOT share exact keyword matches with the changed code.
3. **Historical (co-change) dependencies:** A candidate found purely because it co-evolved with the changed file in past commits.

---

## 4. Readiness Decision

**1. Ready for deterministic baseline experiments**

**Rationale:** 
Despite the dataset's biases and small size, the individual cases are now temporally sound, defensible, and free of hindsight leakage. The purpose of Phase 0 is to validate the methodology and design the baseline. 
We have a trivial structural case (TB-0003) to prove the baseline works. We have lexical/semantic cases (TB-0001, TB-0002) to prove the baseline's limitations. This three-case set perfectly establishes the "floor" for deterministic baseline experiments (e.g., configuring `tsserver` or `ripgrep`). We do not need a perfect dataset to build the *baseline mechanism*; we need a temporally flawless dataset, which this now is. Expanding the dataset to reduce bias should occur concurrently with or immediately after the baseline implementation.

---
**Validation:**
* **Repositories inspected:** `moidsufiyan/wollyway` (local), `honojs/hono` (scratch).
* **Commits inspected:** `bc84e844`, `42f74535`, `e5bb2062` (Base states).
* **Temporal leakage:** None detected in the current candidates.
* **Unsupported claims:** The semantic relationship between `inventory.service.ts` and `checkout.service.ts` at `base_commit` was thoroughly debunked.
