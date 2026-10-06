# Benchmark Expansion Candidate Pool and Selection Notes (v2)

This document tracks the expanded candidate pool of historical software changes across the WollyWay (Dataset A) and Hono (Dataset B) repositories, detailing the selection criteria and bias control for the expanded 8-10 case evaluation benchmark.

## Candidate Pool Review

We reviewed approximately 30 historical changes across the two repositories.

### WollyWay (Dataset A)
1. `f28d322` - fix(security): harden login throttling and api rate limits. (Category: Security, Abstraction Gap).
2. `99c2e13` - fix(security): protect cookie auth endpoints from csrf.
3. `42f7453` - fix(cart): preserve unrelated items during order completion.
4. `2111fa3` - fix(order): close remaining stage 2 lookup and wishlist transaction gaps. (Transitive Structural).
5. `a2a57f5` - fix(checkout): attach verified address to active sessions.
6. `bdb5fae` - fix(wishlist): enforce item uniqueness and correct pagination.
7. `cfd8793` - fix(catalog): correct inventory discovery and category archive checks. (Lexically misleading, Abstraction Gap).
8. `aeab296` - fix(mongoose): remove duplicate schema index definitions.
9. `bb80f34` - fix(order): explicit mapping for CONFIRMED and REFUNDED states in frontend. (Negative Case / Transitive).
10. `adcaa7d` - fix(docker): update npm ci flag for Node 20 compatibility.
11. `ea445fc` - fix(types): resolve TypeScript compilation errors in frontend and backend.

### Hono (Dataset B)
12. `afb2068c` - fix(combine): return a Response from a short-circuiting middleware in some() (Already TB-0003).
13. `c3053ccf` - fix(etag): correctly match mixed-case header name in retainedHeader option. (Category: Test Relationship).
14. `be1f7498` - fix(build): keep internal types private in bundled d.ts.
15. `1e1207ca` - test(serve-static): fix the test.
16. `90d02fb1` - fix(types): allow returning a Blob as a response body.
17. `de310ac0` - fix(lambda-edge): sync content type detection with aws-lambda.
18. `28e8572c` - fix(aws-lambda): preserve empty query parameters.
19. `00ee8757` - fix(linear-router): don't match an empty path segment as a param.
20. `e8c8c212` - perf(jsx/dom): optimize matching-head child lookup.
21. `f147de5e` - fix(accepts, language): skip accept entries with quality 0 when matching.
22. `90e1b948` - fix(aws-lambda): respect backpressure when streaming the response body.
23. `5e5b83d6` - fix(utils/stream): do not let abort listeners crash abort().
24. `4b44abe1` - perf(router): share null object creation.
25. `a1946287` - fix(pattern-router/linear-router): prevent prefix overmatch on wildcard routes.
26. `546eca0c` - fix(etag): avoid skipping headers when filtering 304 response headers.
27. `c91ec9b6` - fix(utils/ipaddr): avoid truncation on embedded IPv4 addresses in expandIPv6. (Direct / Transitive Structural).
28. `6d73a74f` - docs(request): fix jsdoc comments for some getters. (Documentation).

---

## Selected Cases

### TB-0004 (Hono ETag Match Fix)
* **Change:** `c3053ccf` (fix(etag): correctly match mixed-case header name in retainedHeader option)
* **Primary Category:** Test relationship (Category 2)
* **Rationale:** Clean, isolated change in an implementation file (`src/middleware/etag/index.ts`) that requires checking and updating its test file (`src/middleware/etag/index.test.ts`).

### TB-0005 (Hono IPv6 Utilities Fix)
* **Change:** `c91ec9b6` (fix(utils/ipaddr): avoid truncation on embedded IPv4 addresses in expandIPv6)
* **Primary Category:** Direct Structural (Category 1) / Transitive Structural (Category 4)
* **Rationale:** A core utility file (`src/utils/ipaddr.ts`) is fixed. Any consumer of this utility (e.g., `src/middleware/ip-restriction/index.ts`) must be investigated for changes in IP parsing behavior.

### TB-0006 (WollyWay Catalog/Inventory Abstraction Gap)
* **Change:** `cfd8793` (fix(catalog): correct inventory discovery and category archive checks)
* **Primary Category:** Lexically Misleading (Category 7) / Abstraction Gap (Category 8)
* **Rationale:** Fixes a query in `inventory.repository.ts` to respect `trackInventory: false`, and `category.controller.ts` to check `visibility` instead of `status`. This aligns the code with the existing architecture documents (`inventory-domain.md` and `product-domain.md`). Running a lexical search for "inventory" or "category" would produce massive false positive noise (Category 7). Identifying the domain docs requires conceptual mapping (Category 8).

### TB-0007 (WollyWay Frontend Mapping Stale State)
* **Change:** `b80220d` (fix(order): remove stale refunded state) -> evaluated from the frontend's perspective.
* **Wait**, let's use `bb80f34` instead: `fix(order): explicit mapping for CONFIRMED and REFUNDED states in frontend`.
* **Primary Category:** Negative Case / Investigation-worthy (Category 9)
* **Rationale:** The frontend mappings change heavily in `src/views/OrderTracking.tsx`. If we evaluate this change, the backend `order-lifecycle.md` should conceptually match these explicit states.

### TB-0008 (Hono JSDoc Update)
* **Change:** `6d73a74f` (docs(request): fix jsdoc comments for some getters)
* **Primary Category:** Documentation relationship (Category 5)
* **Rationale:** A documentation-only change to `src/request.ts` JSDoc comments.

---

## Rejected Cases

* **WollyWay `aeab296` (mongoose duplicate indexes):** Rejected because it was a pure infrastructure configuration change with limited architectural ripple effect.
* **Hono `afb2068c`:** Rejected because it is already used in the pilot benchmark as TB-0003.
* **Hono `90e1b948` (aws-lambda backpressure):** Rejected because it was highly localized and difficult to establish a robust independent ground truth without deep domain knowledge of AWS Lambda streaming quirks.
* **WollyWay `2111fa3`:** Rejected to avoid overloading the benchmark with complex multi-file transaction fixes that are difficult to evaluate cleanly.

## Selection Bias Assessment

The selection intentionally targets the requested categories. To prevent "easy explanation" bias, we selected TB-0006 (Wollyway Catalog/Inventory), which generates immense lexical noise and requires resolving an abstraction gap (code was broken, docs were correct). The test and structural relationships (TB-0004, TB-0005) are included as control cases to ensure the benchmark can validate deterministic baselines successfully where they *should* work.

---

## Corrections

### TB-0009 Commit Hash Repair (2026-10-04)

**Problem:** The commit SHA recorded in `case-009.yaml` was `5e5b83d6a858e24c2ed28e932ec79b291d9b32e0`. This hash does not exist on GitHub or in a full local clone of `honojs/hono`. The first 8 hex characters (`5e5b83d6`) matched the correct commit, but the remaining 32 characters were corrupted during initial case creation.

**Discovery:** The B7.0 semantic retrieval experiment reported `0 text files` for TB-0009 because `git ls-tree` silently returned empty for the nonexistent object.

**Verification:**
- Fetched `refs/pull/5274/head` to locate the original PR branch commits.
- Identified the merge commit: `5e5b83d6ed963a2bc7d8384002e1c953648253b1`.
- Confirmed commit message: `fix(utils/stream): do not let abort listeners crash abort() (#5274)`.
- Confirmed commit timestamp: `2026-08-23T13:04:05+05:30`.
- Verified the parent tree (`~1`) is fully accessible and contains the expected artifact universe.

**Repair:** Updated `case-009.yaml` fields `base_commit` and `commit` to the canonical SHA `5e5b83d6ed963a2bc7d8384002e1c953648253b1`. No other case fields were changed. The evaluation cutoff, relevance labels, and ground truth are unaffected.
