# Evaluation Case Selection Notes (Phase 0 Pilot)

This document outlines the selection process for the initial 3 pilot cases (`TB-0001`, `TB-0002`, `TB-0003`) used to validate the Tracebound evaluation methodology.

## Objectives
1. Validate the robustness of the 3-facet temporal boundary rules (existence, content/state, evidence).
2. Ensure cases represent real-world developer investigations involving multi-file or cross-domain dependencies.
3. Use a mix of our controlled repository (`moidsufiyan/wollyway`) and a well-known open-source repository (`honojs/hono`).

## Pool Generation & Screening

We examined candidate commits from the histories of both WollyWay and Hono, filtering for changes that involved multiple domains, layers, or tests, rather than isolated cosmetic fixes.

### WollyWay Candidates Evaluated
1. `42f7453 fix(cart): preserve unrelated items during order completion`
   * *Status*: Excluded. The commit mixed business logic fixes for cart state with an unrelated archived category check in `product.service.ts`. This dual-purpose change would confuse the ground truth labeling.
2. `a0885a1 fix(inventory): protect reservations and release checkout locks`
   * *Status*: **Selected (TB-0001)**. A clean cross-domain bugfix. The inventory service was modified to import and depend on a method from the checkout service. This is an excellent case for evaluating structural and logical dependency retrieval.
3. `b80220d fix(order): remove stale refunded state`
   * *Status*: **Selected (TB-0002)**. A massive cross-cutting change across models, validators, APIs, React components, and architecture documentation (`order-lifecycle.md`). This case tests if code changes can successfully pull in related architectural documentation using semantic and structural evidence.
4. `cfd8793 fix(catalog): correct inventory discovery and category archive checks`
   * *Status*: Excluded. Good candidate, but TB-0001 and TB-0002 already provided better structural and documentation coverage for WollyWay.

### Hono Candidates Evaluated
1. `afb2068c fix(combine): return a Response from a short-circuiting middleware in some()`
   * *Status*: **Selected (TB-0003)**. Fixes a bug in a core middleware module and updates the colocated test file (`index.test.ts`). This serves as a textbook "test-of" relationship evaluation, testing the system's ability to retrieve closely coupled test artifacts for a source file change.
2. `f23b146a fix(jsx): allow JSXNode function component results`
   * *Status*: Excluded. A good candidate for JSX typings, but TB-0003 provided a cleaner short-circuiting middleware logic fix.

## Methodological Adherence

For all selected cases:
* The `base_commit` was explicitly captured to define the exact state of the repository before the change was made.
* The `evaluation_cutoff` was tied to the author timestamp of the source change, ensuring strict adherence to the contemporaneous evaluation mode.
* The `content_hash_at_base` for candidate artifacts was recorded using `git ls-tree <base_commit> <path>`, ensuring that future evaluators can audit and enforce that they are retrieving the exact pre-change artifact state, not a subsequent rewrite or HEAD version.
