# Research Notes

> **Status:** Active log — Phase 0. Append entries as research is conducted. Do not back-fill fabricated entries.
> All findings must be tied to a verifiable source. Confidence levels are subjective and must be re-evaluated as more evidence accumulates.

---

## Format

Each entry follows this structure:

```
---
Date: YYYY-MM-DD
Question: The specific question being investigated
Source: URL, paper citation, direct observation, interview, etc.
Finding: What was actually found — be precise, not interpretive
Confidence: Low | Medium | High (with brief justification)
Implication: What this means for the project, if anything — may be "unclear"
Follow-up: Next question or action this finding generates
---
```

**Rules:**
- One entry per question-source pair
- Do not combine multiple findings into one entry
- Mark entries `[Superseded by: #N]` if a later entry contradicts or refines them
- Confidence is not a measure of importance — a low-confidence finding is still worth recording

---

## Log

---
Date: 2026-10-03
Question: What TypeScript/JavaScript repositories would be good evaluation targets? What properties matter? (Q3)
Source: Direct observation of `moidsufiyan/wollyway` and `honojs/hono` commit histories during pilot case construction (TB-0001, TB-0002, TB-0003).
Finding: Both repositories offer distinct, valuable evaluation properties. WollyWay provides excellent examples of cross-domain full-stack couplings (e.g., frontend React components, backend models, and architectural markdown documentation all co-changing). Hono provides a modular, highly tested framework structure where bug fixes frequently involve tightly coupled colocated unit tests.
Confidence: High. 3 real, structurally diverse cases were successfully generated from these repositories, demonstrating their viability.
Implication: Tracebound must handle diverse relationship types: structural (co-located tests), semantic/lexical (architectural documentation), and cross-domain references.
Follow-up: How reliably can deterministic tools (like tsserver) extract cross-domain relationships compared to co-change history?
---
---
Date: 2026-10-03
Question: Are unchanged artifacts well-represented in evaluating change impact?
Source: Independent evaluation audit of TB-0001, TB-0002, and TB-0003.
Finding: The initial pilot cases were biased entirely toward artifacts that were modified (changed artifacts). The repair process successfully identified an unchanged, investigation-worthy architectural document for TB-0001 (`checkout-lifecycle.md`). However, TB-0002 and TB-0003 could not defensibly support unchanged candidates based on their historical change boundaries.
Confidence: High for these specific commits, but remains unverified as a general pattern across all commits.
Implication: Finding defensible unchanged candidates that developers *should* have investigated requires careful selection. The dataset repair suggests that relying solely on what actually changed introduces severe evaluation bias, artificially inflating recall if the ground truth ignores missed dependencies.
Follow-up: How do we systematically source investigation-worthy unchanged candidates for future evaluation cases?
---

<!-- No entries yet. Add the first entry when research begins. -->

---
Date: 2026-10-03
Question: Can the deterministic baseline retrieve abstraction-gap and lexically misleading relationships?
Source: Tracebound evaluation dataset expansion (TB-0006, TB-0007).
Finding: Observed that deterministic retrieval fails on Abstraction Gap cases. For instance, in TB-0006 (Wollyway), code implementation drifted from correct domain architectural documents. A lexical search for terms like 'inventory' yields hundreds of false positives, while structural and metadata signals yield nothing. 
Confidence: High. Real historical commits were successfully identified that demonstrate this exact failure mode without fabricating the relationship.
Implication: The expanded benchmark successfully proves that deterministic retrieval ceilings are not merely a result of a small dataset, but a fundamental limitation when handling semantic conceptual mismatches (the Lexical Abstraction Gap).
Follow-up: Execute a semantic retrieval experiment against these exact cases.
---

---
Date: 2026-10-03
Question: How resistant are deterministic baselines to negative cases?
Source: Tracebound evaluation dataset expansion (TB-0009).
Finding: Observed that structural baselines are highly vulnerable to negative false-positive cases. In TB-0009 (Hono utils/stream internal fix), an internal implementation detail was patched. Structural analysis flags all dependents (e.g., helper/stream.ts) as candidates, even though the external API contract didn't change and investigation is not warranted.
Confidence: High.
Implication: Structural analysis is necessary for code dependency tracking but insufficient for determining *relevance*.
Follow-up: Can semantic retrieval prune these structural false positives by understanding the intent of the change?
---
Date: 2026-10-04
Question: How should corrupted or inaccessible historical checkout states be handled during benchmark evaluation?
Source: TB-0009 Historical Checkout Repair (Hono `utils/stream` PR #5274).
Finding: The `case-009.yaml` contained a corrupted commit identifier (`5e5b83d6a858e24c2ed28e932ec79b291d9b32e0`) where only the first 8 characters matched the correct SHA. The verified canonical commit is `5e5b83d6ed963a2bc7d8384002e1c953648253b1`. Fixing this requires updating the evaluation case file directly rather than hardcoding a workaround/alias in the experiment script (`index.js`).
Confidence: High. Hardcoded aliases hide data integrity defects inside implementation logic.
Implication: This is a benchmark integrity correction, not an experiment change. The benchmark must explicitly define the exact, valid state of the repository without relying on the implementation script to "fix" it.
Follow-up: Ensure no other case-specific overrides exist in the semantic experiment runner.
---

<!-- Example entry (do not treat as real data):
---
Date: 2026-10-03
Question: Does tsserver expose a programmatic API for finding all references to a symbol?
Source: https://github.com/microsoft/TypeScript/wiki/Using-the-Language-Service-API
Finding: [PLACEHOLDER — investigate and record actual finding]
Confidence: [PLACEHOLDER]
Implication: [PLACEHOLDER]
Follow-up: [PLACEHOLDER]
---
-->

---

## Research Backlog

Questions pending investigation. Move to the log when addressed.

| # | Question | Priority | Assigned To | Added |
|---|---------|----------|------------|-------|
| Q1 | Can tsserver's find-references be invoked programmatically without a running IDE? | High | — | 2026-10-03 |
| Q2 | Is there academic literature on co-change analysis (co-evolution, change coupling) applicable to this problem? | High | — | 2026-10-03 |
| Q3 | What TypeScript/JavaScript repositories would be good evaluation targets? What properties matter? | High | — | 2026-10-03 |
| Q4 | Does Sourcegraph expose a graph API for references that could be queried externally? | Medium | — | 2026-10-03 |
| Q5 | What is the quality and consistency of issue-to-commit linkage across representative open-source repositories? | Medium | — | 2026-10-03 |
| Q6 | Are there existing labeled datasets for change-impact or code traceability evaluation? | High | — | 2026-10-03 |
| Q7 | What fraction of regression bugs in open-source TypeScript projects can be attributed to incomplete impact analysis? | Low | — | 2026-10-03 |
| Q8 | Does madge produce a reliable module dependency graph for monorepos? | Medium | — | 2026-10-03 |
