# TB-0003 Ground-Truth Audit

**Date:** 2026-10-03
**Auditor:** Principal Evaluation Engineer
**Objective:** Independently audit the six non-ground-truth B1 structural candidates generated for TB-0003 to determine if they are genuine false positives or if the case is under-labeled.

---

## 1. Candidate Audits

All six structural candidates evaluated below were discovered via the `[Direct Import]` relationship. This means the changed artifacts (`index.ts` or `index.test.ts`) imported the candidate, not the other way around.

| Candidate | Relationship | Evidence | Relevance Judgement | Confidence | Rationale |
|-----------|-------------|----------|---------------------|------------|-----------|
| `src/compose.ts` | Direct Dependency | `import { compose } from '../../compose'` | `not-relevant` | High | `compose` is a dependency used only by the `every()` function in the module. The bug fix was explicitly scoped to the `some()` function. Modifying `some()` has absolutely zero impact on `compose.ts`. |
| `src/context.ts` | Direct Dependency (Type) | `import { Context } from '../../context'` | `not-relevant` | High | `Context` is a foundational type interface. The change altered runtime short-circuiting logic inside a specific middleware, not the structure of the request context. |
| `src/router.ts` | Direct Dependency | `import { METHOD_NAME_ALL } from '../../router'` | `not-relevant` | High | Used only by `except()` for path matching. Unaffected by and irrelevant to the fix in `some()`. |
| `src/router/trie-router/index.ts` | Direct Dependency | `import { TrieRouter } from '../../router/trie-router'` | `not-relevant` | High | Used only by `except()`. Unaffected by and irrelevant to the fix in `some()`. |
| `src/types.ts` | Direct Dependency (Type) | `import { MiddlewareHandler, Next } from '../../types'` | `not-relevant` | High | Similar to `context.ts`. These are core types. The fix did not change the middleware contract signature, it merely corrected the internal return logic to adhere to it. |
| `src/hono.ts` | Direct Dependency (Test framework) | `import { Hono } from '../../hono'` (in `index.test.ts`) | `not-relevant` | High | The test suite spins up a `Hono` app instance to verify the middleware. Modifying the test file to assert the bug fix does not endanger or necessitate investigating the core `Hono` application class. |

---

## 2. Methodological Findings

### Genuine False Positives vs. Missing Candidates
* **Number of genuine false positives:** 6
* **Number of potentially missing candidates:** 0

### Evaluation of the Ground Truth
**Finding:** The current ground truth for TB-0003 is **1. sufficiently complete**.

**Evidence:** 
The B1 structural baseline naively treated *outgoing* dependencies (`[Direct Import]`) identically to *incoming* dependents (`[Reverse Import]`). In software architecture, if Module A changes, Module B (which A depends on) is almost never broken by that change and rarely warrants investigation unless A's author needs to re-read B's API contract. However, Module C (which depends on A) is highly vulnerable and *must* be investigated.

In this historical snapshot, B1 found exactly one `[Reverse Import]` (incoming dependent): `index.test.ts`. This perfectly matches the ground truth. The 6 false positives were entirely outgoing dependencies that were completely insulated from the consequences of the bug fix.

### Conclusion on Evaluation Methodology
**Does case-003 require relabeling?** No.
**Does the current evaluation methodology handle this ambiguity adequately?** Yes. The `not-relevant` threshold correctly filters out artifacts that have structural proximity but no logical vulnerability to the change.

> **Answer:** Yes, B1's six additional candidates can and should reasonably be treated as genuine false positives under the current Tracebound evaluation definition. Their discovery exposes a limitation in naive B1 (treating all edges in a dependency graph equally) rather than a flaw in the evaluation dataset.
