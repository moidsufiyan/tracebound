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

<!-- No entries yet. Add the first entry when research begins. -->

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
