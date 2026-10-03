# Tracebound

**Evidence-backed software change impact and traceability.**

---

## Current State

**Phase 0 — Problem Validation & Evaluation Design**

The project is currently in problem validation. No application code has been written. No final technology stack has been selected. The work at this stage is research, documentation, and evaluation design.

---

## Objective

Investigate a proposed software change and surface potentially related artifacts — tests, documentation, dependent modules, historical commits, and linked issues — using deterministic software relationships, Git history, and lexical retrieval. Semantic retrieval may be incorporated later, after deterministic approaches are evaluated.

---

## What This Is Not (Yet)

- Not a finished product
- Not a production system
- Not a tool with a selected stack
- Not a system with proven effectiveness

The gap between the objective and a working system is the entire problem. Closing that gap responsibly is the project.

---

## Non-Goals (Current Phase)

- Building a UI
- Integrating with LLMs
- Supporting all languages or ecosystems
- Generalizing beyond the initial research scope
- Optimizing performance before correctness is established

---

## Development Philosophy

1. **Evidence over assumptions.** No design decision is made without a documented reason grounded in observed behavior or research.
2. **Deterministic analysis before probabilistic reasoning.** Structural and lexical signals are understood and evaluated before semantic or ML-based approaches are introduced.
3. **Evaluation before optimization.** An evaluation methodology and labeled test cases must exist before any retrieval strategy is tuned or compared.
4. **Explicit uncertainty.** Open questions are recorded and visible. Fabricated conclusions are not acceptable.

---

## Repository Structure

```
tracebound/
├── README.md
├── .gitignore
└── docs/
    ├── problem/
    │   ├── problem-statement.md
    │   ├── target-user.md
    │   └── workflow.md
    ├── research/
    │   ├── existing-tools.md
    │   └── research-notes.md
    ├── evaluation/
    │   ├── methodology.md
    │   ├── case-schema.md
    │   └── cases/
    └── decisions/
        └── README.md
```

---

## Future Direction

Future phases may include: a working prototype, an evaluation harness, integration of additional retrieval strategies, and expansion to additional languages or repository types. These are aspirational and subject to findings from the current phase.

---

*This document will be updated as the project advances through phases.*
