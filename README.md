# Tracebound

**Evidence-backed software change impact and traceability.**

---

## Current State

**Production foundation — first vertical slice**

Phase 0/1 research and retrieval experiments (`docs/`, `experiments/`) are complete enough to fix the architecture (`docs/architecture/`). The first production slice is implemented in `src/`: TypeScript on Node.js 24 with SQLite (`node:sqlite`). It covers Projects, Repositories and atomic historical snapshot ingestion (Artifact / ArtifactVersion / Content). A deterministic retrieval baseline over snapshots (lexical plus import-based structural signals, `src/retrieval/` and `src/analysis/`) is also implemented, along with an independent semantic candidate pipeline (`src/semantic/`, local Ollama embeddings). Their Reciprocal Rank Fusion (`searchHybrid`) is implemented too, along with typed, request-scoped evidence for the fused candidates (`constructEvidence`). An optional, validated LLM impact assessment over that evidence (`assessImpact`, local Ollama adapter) is implemented as well.

```
npm install
npm test          # vitest
npm run typecheck
npm run build     # emits dist/
```

### Investigate a change

`investigateChange` (library) and `npm run investigate` (command line, after `npm run build`) run the whole workflow for one change in one repository snapshot: hybrid retrieval, evidence for the best candidates, and, only if a reasoning model is named, the validated impact assessment. The report lists each candidate with its evidence and evidence ids, its retrieval signals, what that evidence cannot show and the questions it leaves open. It is useful without an assessment, and it never presents a rank, a score or an import as proof of impact.

```
npm run investigate -- --db tracebound.sqlite --repo ../my-repo --commit <full 40-character SHA> \
  --description "fix(combine): return a Response from a short-circuiting middleware in some()" \
  --changed src/middleware/combine/index.ts --symbol some [--limit 20] [--format json] [--out report.md]
```

To investigate the change between two commits without listing paths, name both commits instead of `--commit`; the changed paths are derived from `git diff-tree` (additions, modifications, deletions and renames), and the change is investigated in the base snapshot, the state before the change:

```
npm run investigate -- --db tracebound.sqlite --repo ../my-repo --base <full SHA> --head <full SHA> \
  --description "fix(combine): return a Response from a short-circuiting middleware in some()" [--symbol some]
```

The base must be an ancestor of the head and differ from it, both must be full commit SHAs (refs such as `HEAD` or branch names are refused), and at least one file must differ. `--changed` is not accepted in this mode. Each changed file is reported with how it changed; an added file, or the new name of a renamed one, is kept and reported as absent from the base snapshot.

With `--repo` and `--commit` the commit is registered, ingested and indexed if needed (the semantic index embeds the snapshot with the local Ollama `nomic-embed-text:v1.5`); `--snapshot <id>` uses an already ingested snapshot instead. Adding `--reasoning-model <name> --reasoning-max-input-chars <n>` requests the impact assessment; a rejected or failed assessment is reported and the evidence is still shown. Exit codes: 0 report written, 1 error, 2 usage.

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
│   ├── analysis/        # import extraction, module resolution, structural index
│   ├── retrieval/       # lexical tokenizer, derived index, ranking, search
│   └── semantic/        # chunking, embedding provider, vector storage, cosine search
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
