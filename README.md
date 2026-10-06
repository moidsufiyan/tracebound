# Tracebound

**Evidence-backed software change impact and traceability.**

---

## Current State

**Production foundation — first vertical slice**

Phase 0/1 research and retrieval experiments (`docs/`, `experiments/`) are complete enough to fix the architecture (`docs/architecture/`). The first production slice is implemented in `src/`: TypeScript on Node.js 24 with SQLite (`node:sqlite`). It covers Projects, Repositories and atomic historical snapshot ingestion (Artifact / ArtifactVersion / Content). A deterministic lexical retrieval baseline over snapshots is also implemented (`src/retrieval/`). Semantic retrieval, fusion, evidence and reasoning are not built yet.

```
npm install
npm test          # vitest
npm run typecheck
npm run build     # emits dist/
```

---

## Objective

Investigate a proposed software change and surface potentially related artifacts — tests, documentation, dependent modules, historical commits, and linked issues — using deterministic software relationships, Git history, and lexical retrieval. Semantic retrieval may be incorporated later, after deterministic approaches are evaluated.

---

## What This Is Not (Yet)

- Not a finished product
- Not a production system
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
├── src/                 # production code (modular monolith)
│   ├── db/              # connection, migrations, transactions
│   ├── git/             # read-only Git object access
│   ├── projects/        # Project, Repository
│   ├── snapshots/       # RepositorySnapshot
│   ├── artifacts/       # Artifact, ArtifactVersion, Content
│   ├── ingestion/       # file policy, normalization, snapshot ingestion
│   └── retrieval/       # lexical tokenizer, derived index, ranking, search
├── test/
├── experiments/         # Phase 1 retrieval experiments (standalone scripts)
└── docs/
    ├── architecture/    # system overview, domain model, ADRs
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
