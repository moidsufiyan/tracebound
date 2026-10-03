# Evaluation Methodology

> **Status:** Revised draft — Phase 0.
> **This methodology must be validated before any implementation or metric selection.**
> Preliminary concepts are defined to enable structured thinking, not to constrain later decisions.
> Schema version: 0.2.1 (refined temporal boundary: explicit artifact content/state at cutoff, three-way temporal distinction, per-artifact version rules).

---

## Purpose

This document defines the preliminary evaluation framework for Tracebound. Its goal is to ensure that when retrieval strategies are compared, the comparison is meaningful, reproducible, and honest.

An evaluation methodology that is defined after implementation is designed to make the implementation look good. That is not acceptable here.

---

## Scope

This methodology applies to evaluating the following retrieval strategies (subject to revision):

| Strategy | Description |
|---------|-------------|
| Lexical search | Token-based text search over artifact content |
| Deterministic structural analysis | Import graph traversal, reference resolution, type dependencies |
| Historical signals | Co-change patterns from Git history |
| Semantic retrieval | Embedding-based similarity search |
| Hybrid retrieval | Combination of two or more of the above strategies |
| Reranking | Post-retrieval rescoring of a candidate set |

No strategy is assumed to be superior. Each will be evaluated against the same labeled cases.

---

## Core Concepts

These definitions are preliminary. They will be refined as evaluation cases are constructed.

### Evaluation Case

A single, labeled historical example consisting of:
- A specific software change (one or more modified files/symbols)
- A set of candidate artifacts from the same repository
- A relevance judgment for each candidate, with a documented rationale

An evaluation case is derived from a real repository at a real historical point in time. Synthetic cases are not used unless explicitly justified.

### Changed Artifact

A file, function, class, type, or symbol that was modified as part of the change being investigated. The changed artifact is the input to any retrieval strategy.

### Impacted / Relevant Artifact

A file, function, class, type, symbol, test, or documentation artifact that:
- Is directly or indirectly affected by the change, **or**
- Contains information a developer would need to review before submitting the change

Relevance is not limited to artifacts that break when the change is applied. It includes artifacts that a careful reviewer would inspect.

> **[Open question]** How is relevance judged? Who labels it? What is the labeling process? This is unresolved.

### Evidence

A traceable signal that supports the relevance judgment for a given artifact. Evidence may be:
- Structural (the artifact imports the changed file)
- Lexical (the artifact references the changed symbol by name)
- Historical (the artifact co-changed with the changed file in past commits)
- Semantic (the artifact is thematically related to the change)
- Human (an expert reviewer flagged the artifact as relevant)

Evidence must be strictly derivable from the artifact's content and repository state as they existed at the evaluation cutoff. Any signal derived from post-cutoff artifact revisions, subsequent commit history, or later discussions is contaminated by hindsight and is invalid. Evidence type and specific grounding must be recorded alongside relevance labels.

### Relationship

The specific connection between a changed artifact and a candidate artifact. Relationships are typed:

| Relationship Type | Example |
|------------------|---------|
| `direct-import` | Candidate file imports the changed module |
| `indirect-import` | Candidate file imports a file that imports the changed module |
| `test-of` | Candidate test exercises the changed function |
| `documents` | Candidate document describes the changed behavior |
| `co-changes-with` | Candidate file has historically changed with the changed file |
| `type-implements` | Candidate implements an interface modified in the change |
| `unknown` | Relevant but relationship is unclear |

### Relevance Categories (Conceptual)

Relevance is not yet defined as a binary or graded scheme. Instead, the following conceptual categories describe the kinds of relevance that exist. The final labeling scheme — and how these categories collapse or are preserved — will be determined during pilot case construction.

| Category | Description |
|---------|-------------|
| `direct-impact` | The artifact is structurally or behaviorally coupled to the change: it imports the changed module, implements or calls the changed symbol, or is a test that directly exercises the changed behavior. A developer making this change should always inspect this artifact. |
| `investigation-worthy` | The artifact is not directly coupled but a careful developer would reasonably want to inspect it before submitting the change — e.g., documentation that describes the changed behavior, a sibling module with shared invariants, or a type that constrains the changed signature. |
| `contextual-historical` | The artifact has no direct structural connection but has historically co-changed with the changed artifact. Useful as a signal but not necessarily actionable on its own. |
| `not-relevant` | The artifact has no meaningful connection to the change. A developer would not need to inspect it. |
| `uncertain` | The connection is unclear or labelers disagree. Do not exclude these — record disagreement explicitly and resolve during review. |

**Key distinctions:**
- `direct-impact` and `investigation-worthy` are the categories that matter most for evaluating recall.
- `contextual-historical` is relevant for evaluating historical-signal strategies specifically.
- `uncertain` is not a catch-all — it signals a labeling problem that must be resolved, not deferred indefinitely.

> **[Deferred]** Whether the final scheme collapses these into binary labels, preserves all five, or uses a graded scale will be decided after labeling at least 10 pilot cases. The decision must be documented as an ADR.

---

## Temporal Evaluation Boundary

> **This section is critical for preventing evaluation contamination.** Read before constructing any case.

### The Problem: Hindsight Leakage

A retrieval strategy is evaluated against a historical change. The primary risk is that information created or modified *after* the change — new tests added to fix a regression, documentation updated in response to the change, follow-up commits, or post-incident issue discussions — is visible in the repository and inadvertently contaminates the evaluation. This is **hindsight leakage** (or hindsight bias).

Hindsight leakage occurs through two distinct mechanisms:
1. **Post-cutoff artifact creation:** An artifact that did not exist at the time of the change is included as a candidate or labeled as relevant (e.g., a regression test authored three days later).
2. **Post-cutoff artifact content drift and rewrites:** An artifact existed before the change, but its content was modified, rewritten, or expanded after the change (e.g., an existing documentation file rewritten weeks later to reflect the new architecture, or an existing test file updated with new test cases covering the change).

**An artifact being present before the evaluation cutoff is not sufficient.** For contemporaneous evaluation, both the artifact candidate and any evidence supporting its relevance must be evaluated strictly using the version and state that was available at the evaluation cutoff.

Evaluating a candidate using its current working tree (HEAD) or a later revision introduces severe hindsight leakage: the system or human labeler observes symbols, explanations, or dependencies that did not exist when the change was authored.

### Three Distinct Temporal Facets: Existence, Content/State, and Evidence

To prevent hindsight leakage, the evaluation methodology strictly distinguishes three facets that must never be conflated:

1. **Artifact existence at cutoff:** Did the artifact physically exist in the repository or tracker at or before `evaluation_cutoff`?
   - *Requirement:* If an artifact did not exist at `evaluation_cutoff`, it cannot enter the contemporaneous artifact universe. Existence is a necessary filter, but it is **not sufficient** on its own.
2. **Artifact content/state at cutoff:** What exact version, content, and structure did the artifact have at `evaluation_cutoff`?
   - *Requirement:* For any artifact that existed at cutoff, evaluation and labeling must inspect only the exact snapshot/blob present at `base_commit` (for version-controlled files) or activity posted prior to `evaluation_cutoff` (for issues and PRs). Any subsequent edit, rewrite, or expansion is strictly invisible.
3. **Evidence available at cutoff:** What signals and traceable facts can be derived strictly from the pre-cutoff content/state and pre-cutoff history?
   - *Requirement:* Evidence must be grounded exclusively in the artifact's pre-cutoff content and pre-cutoff repository signals (e.g., AST relations at `base_commit`, lexical matching over `base_commit` text, co-change frequency in commits prior to `evaluation_cutoff`). Signals derived from subsequent diffs, follow-up PR reviews, or later commits are inadmissible.

Conflating these facets produces insidious evaluation failures. For example, verifying only *artifact existence* while inspecting *current HEAD content* allows a rewritten documentation file to be retrieved via search keywords that were only authored in the rewrite.

### Concrete Examples of Hindsight Leakage

#### Example 1: Post-Cutoff Artifact Creation (Tests)
Suppose the change under investigation is commit `abc123`, which modifies `src/auth/tokenValidator.ts`. Three days later, in commit `def456`, a developer adds `tests/auth/tokenValidator.regression.test.ts` to prevent reintroduction of the bug that `abc123` fixed.

If an evaluator labels `tests/auth/tokenValidator.regression.test.ts` as `direct-impact` and includes it in the case, they are using post-change knowledge to construct the ground truth. No strategy could have surfaced this test at the time `abc123` was authored — it did not exist. Including it inflates the apparent difficulty of the task and produces misleading recall metrics.

#### Example 2: Post-Cutoff Content Rewrite (Documentation)
Suppose `docs/architecture/auth-flow.md` existed two years prior to commit `abc123`. At the time `abc123` was authored, `docs/architecture/auth-flow.md` described an older cookie-based authentication mechanism and contained zero mentions of `tokenValidator` or bearer tokens. Two weeks after `abc123`, a developer completely rewrote `docs/architecture/auth-flow.md` to document the new token validation architecture.

If an evaluation system searches over HEAD or an evaluator reads the current version of `docs/architecture/auth-flow.md`, lexical and semantic retrieval will effortlessly rank it highly, and an evaluator might label it `investigation-worthy` or `direct-impact` under the justification that "it documents token validation." This is hindsight leakage. At the time of `abc123`, the file contained no such explanation. Contemporaneous evaluation must evaluate `docs/architecture/auth-flow.md` using its pre-rewrite content at `base_commit`, where it would only be relevant if the pre-existing content warranted inspection (or judged `not-relevant` if completely decoupled).

#### Example 3: Post-Cutoff Test Modification (Existing Test File)
Suppose `tests/auth/authService.test.ts` existed at `base_commit`, containing tests solely for username/password authentication. In a subsequent commit `ghi789`, a developer added 50 lines of new test cases specifically asserting behavior for `tokenValidator`.

The file existed at cutoff, but the assertions relating to the change did not. If a retrieval strategy or labeler examines the post-cutoff state of `tests/auth/authService.test.ts`, they are relying on assertions that did not exist when `abc123` was created. Relevance judgments and structural/lexical matching must evaluate only the test cases present at `base_commit`.

### Repository State Model

Every evaluation case must be anchored to a precise temporal model:

```
[base state]  ───── change ─────>  [post-change state]
    ^                                     ^
    │                                     │
  base_commit                      change_commit
 (evaluation                     (repository state
  input state:                    AFTER the change
  both existence                  — NOT for labeling
  AND content)                    or candidate state)
                  ^
                  │
          evaluation_cutoff
   (= change_timestamp:
    max timestamp for
    artifacts, content states,
    and historical evidence)
```

- **`base_commit`**: The commit SHA immediately before the change. This is the repository state as the developer saw it when beginning their investigation. The artifact universe and the exact content/state of all versioned files are drawn strictly from this tree.
- **`change_commit`**: The commit SHA that introduces the change. This defines the changed artifacts.
- **`change_timestamp`**: The author timestamp of `change_commit` (ISO 8601). This is the **evaluation knowledge cutoff** — no artifact, artifact modification, or historical evidence created after this timestamp may be used when labeling or evaluating the case.
- **`evaluation_cutoff`**: Explicitly recorded as the `change_timestamp`. Must be stored in the case file and cross-checked during review.

### Contemporaneous vs. Retrospective Evaluation

| Dimension | Contemporaneous Evaluation (Primary Benchmark) | Retrospective Evaluation (Secondary Analysis) |
|---|---|---|
| **Primary Goal** | Simulates the real developer experience at the moment of change authoring | Analyzes what was missed, follow-up defect fixes, and subsequent documentation evolution |
| **Artifact Existence** | Restricted strictly to artifacts existing at or before `evaluation_cutoff` | May include artifacts created after `evaluation_cutoff` (e.g., follow-up regression tests) |
| **Artifact Content / State** | Restricted strictly to content state at `base_commit` (or pre-cutoff issue/PR snapshot) | May examine post-cutoff content state (e.g., rewritten documentation, added assertions) |
| **Evidence Admissibility** | Derived strictly from pre-cutoff content, ASTs, and pre-cutoff git history | May use post-cutoff git commits, post-incident comments, and follow-up PR discussions |
| **Metric Role** | **Primary benchmark** — all strategy comparisons and official metrics use this mode | Exploratory only — used to understand technical debt and downstream impact; never mixed with contemporaneous scores |

**The primary benchmark is always contemporaneous.** Retrospective analysis is a separate, explicitly labeled investigation and must never be mixed with contemporaneous results.

### Artifact State and Content at Cutoff by Artifact Type

Different artifact types have different versioning mechanisms. To prevent hindsight leakage, each artifact type must adhere to explicit cutoff rules:

| Artifact Type | Version Source | Cutoff Rule for Content and State | Inadmissible Post-Cutoff Information (Hindsight Leakage) |
|---|---|---|---|
| **Source files** | Git tree at `base_commit` | Evaluated strictly at the exact git blob at `base_commit` (`git show base_commit:<path>`). AST, symbol definitions, exported types, and import graphs must match `base_commit`. | Any edits, renamed symbols, new functions, refactorings, or deletions made in `change_commit` or subsequent commits. |
| **Tests** | Git tree at `base_commit` | Evaluated strictly at the exact git blob at `base_commit`. Only test suites, test cases, and assertions present at `base_commit` are visible. | New test cases or assertions added to existing test files after `base_commit`, even if the test file already existed. |
| **Documentation** | Git tree at `base_commit` | Evaluated strictly at the exact git blob at `base_commit`. Prose, architecture diagrams, docstrings, and API specs must reflect the pre-change state. | Documentation rewrites, clarifications, or updates made after `base_commit` to explain or reflect the change. |
| **Issues** | Issue tracker snapshot at `evaluation_cutoff` | Only the initial issue description and comments/activity posted strictly before `evaluation_cutoff` are visible. | Comments posted after cutoff, post-mortem notes, status transitions (e.g., closed after fix), milestone changes, and retrospective labels. |
| **Pull requests** | Git / PR tracker snapshot at `evaluation_cutoff` | Only the PR description and review comments posted strictly before `evaluation_cutoff` are visible. | Post-cutoff review discussions, code review approvals, CI run logs, post-merge comments, and subsequent commits pushed to the branch. |
| **Commit history** | Git commit graph / DAG | Only commits where both `author_timestamp` and `committer_timestamp` are strictly prior to `change_timestamp` are visible. | Follow-up commits, regression fix commits, reverts, merge commits, or co-change patterns occurring at or after `change_timestamp`. |
| **Other versioned artifacts** (schemas, configs, build scripts) | Git tree at `base_commit` | Evaluated strictly at the exact git blob at `base_commit` (e.g., `package.json`, `tsconfig.json`, `schema.sql`, `Dockerfile`, CI manifests). | Configuration updates, dependency version bumps, or schema migrations introduced after `base_commit`. |

### Labeling Constraints

When constructing cases and assigning relevance labels:

1. **Working tree grounding:** The labeler must work exclusively from the repository checked out at `base_commit`, never from the current HEAD or any intermediate post-cutoff commit.
2. **Artifact existence constraint:** Any artifact that did not exist at `base_commit` (or before `evaluation_cutoff` for issue tracker artifacts) must not be included in the candidate set or labeled as relevant.
3. **Artifact content/state constraint:** For any candidate artifact that existed at `base_commit`, the labeler must evaluate its relevance solely based on the content and state of the artifact at `base_commit`. If an artifact was subsequently rewritten or modified, the labeler must judge the pre-rewrite version: *Based on what this artifact contained at `base_commit`, should a developer making this change have inspected it?*
4. **Issue and PR temporal truncation:** For issues or PRs used as context or candidates, all comments, labels, and status changes timestamped after `evaluation_cutoff` must be excised before labeling.
5. **Historical evidence boundary:** Git commit history used as evidence (e.g., co-change frequencies or author overlap) is restricted strictly to commits authored prior to `evaluation_cutoff`.
6. **Evidence auditability:** Any documented evidence supporting a relevance label must cite specific symbols, lines, text, or dependencies that are verifiable in the `base_commit` content state. Citing post-cutoff text or changes is grounds for invalidating the case.

---

## Artifact Universe, Candidate Generation, Ranking, and Top-K

These are four distinct concepts that must be evaluated separately. Conflating them produces misleading results.

### Artifact Universe

The complete set of artifacts that *could* be returned as relevant for a given case. Defined at `base_commit`. The artifact universe is bounded and explicit — it is not "all files that will ever exist" but "all files that existed when the developer made the change."

The artifact universe definition must be recorded in the case file. Common definitions:
- All source files tracked by git at `base_commit`
- All files matching a given path pattern (e.g., `src/**/*.ts`, `tests/**/*`)
- All symbols exported by the changed module's dependents

The choice of universe affects what recall means. A strategy that retrieves 10 out of 10 relevant artifacts from a universe of 20 is very different from one that retrieves 10 out of 10 from a universe of 10,000.

### Candidate Generation

The process by which a strategy narrows the artifact universe to a set of candidates it considers potentially relevant. This is the primary filtering step.

Candidate generation must be evaluated independently of ranking. A strategy with poor candidate generation cannot be rescued by good ranking — the relevant artifact is simply not in the candidate set. This is a **hard recall failure**, distinct from a ranking failure.

**What to measure at this stage:** Does the candidate set contain the relevant artifacts? What fraction of the universe is retained?

### Candidate Ranking

Once a candidate set is produced, a strategy may assign scores or ranks to candidates. The question at this stage is not whether relevant artifacts are present but whether they are ranked high enough to be actionable.

**What to measure at this stage:** Where do relevant artifacts appear in the ranked list? Are they concentrated at the top?

### Top-K Result

The final set of artifacts presented to the developer, derived from the ranked candidates by applying a cutoff (top-K or threshold). This is what the developer actually sees.

**What to measure at this stage:** Of the K artifacts shown, how many are relevant? How many relevant artifacts are absent?

### Why Evaluate Separately

If evaluation collapses all four stages into a single recall number:
- It is impossible to distinguish a strategy that generates poor candidates from one that generates good candidates but ranks them badly.
- Improvements to candidate generation and improvements to ranking require different interventions and should be credited separately.
- Debugging a strategy requires knowing *where* it fails, not just *that* it fails.

> **[Design constraint]** The case schema must support recording which stage a failure occurred at. This is not the same as storing retrieval strategy output in the case file — strategy outputs are stored separately. The case file records ground truth only.

---

## Evaluation Approach

### What Will Be Measured

Metrics have **not** been selected yet. The following dimensions are candidates:

- **Coverage / Recall** — what fraction of relevant artifacts does a strategy surface?
- **Precision** — what fraction of surfaced artifacts are actually relevant?
- **Rank quality** — are relevant artifacts ranked higher than irrelevant ones?
- **False-negative rate** — what does the strategy miss, and why?

> **[Decision needed]** Metric selection must be grounded in what matters to the target user, not what is easiest to compute. This requires user research to inform.

### What Will Not Be Measured (Yet)

- Latency / performance
- Cost of indexing
- User satisfaction
- End-to-end task completion

These are real concerns but are premature before correctness is established.

---

## Evaluation Process (Proposed)

The following process is a working proposal and may change:

1. **Case construction:** Select representative repositories and historical changes. Construct evaluation cases per the case schema (`case-schema.md`).
2. **Labeling:** Assign relevance labels to candidate artifacts. Document rationale. Record uncertainty.
3. **Baseline construction:** Define a naive baseline (e.g., co-located test discovery, direct import traversal only) to compare against.
4. **Strategy evaluation:** Run each retrieval strategy against the case set. Record retrieved artifacts and scores.
5. **Metric computation:** Compute agreed-upon metrics. Disaggregate by case type, repository, and artifact type.
6. **Error analysis:** Inspect false negatives and false positives. Understand failure modes, not just aggregate scores.
7. **Iteration:** Refine the case set, labels, and strategies based on findings.

---

## Risks and Assumptions

| Risk | Mitigation |
|------|-----------|
| Labeling is subjective and inconsistent | Document labeling rationale per case; use multiple reviewers where possible |
| Evaluation cases are unrepresentative | Diversify across repository size, domain, and change type |
| Metrics optimize for the wrong thing | Ground metric selection in user research before finalizing |
| Small case set leads to unstable metrics | Track variance; grow the case set incrementally |
| **Hindsight bias contaminates labels or retrieval** | Enforce evaluation_cutoff discipline across all three facets: labelers work from base_commit only; post-change artifacts are excluded from the candidate set; pre-existing artifacts are evaluated strictly using their base_commit content state to prevent leakage from subsequent rewrites or test additions |
| **Artifact universe is undefined or inconsistent** | Record artifact_universe_definition explicitly in each case file; verify consistency across cases before computing cross-case metrics |
| **Candidate generation and ranking failures are conflated** | Evaluate each pipeline stage independently; record stage-level failure reasons during error analysis |

---

## Validation of This Methodology

This methodology must itself be validated before it is used to make design decisions. Specifically:

- [ ] Can independent reviewers apply the relevance categories consistently? Test with at least 3 pilot cases before proceeding.
- [ ] Are the relationship types sufficient to cover real cases encountered during pilot construction?
- [ ] Does the evaluation_cutoff discipline hold in practice? Audit the first 5 cases for post-change artifact contamination, verifying both artifact existence and content/state fidelity (e.g., verifying audited file blobs match base_commit exactly and do not reflect subsequent rewrites).
- [ ] Is the artifact universe definition consistent across cases? Can it be reproduced from the case file alone?
- [ ] Do the proposed metrics align with what the target user actually cares about? (Requires user research.)
- [ ] Is the distinction between contemporaneous and retrospective evaluation maintainable? Does it require tooling?
- [ ] Can the five relevance categories be collapsed into a final scheme after 10 pilot cases? What does the distribution look like?

---

## Open Questions

- [ ] How will the artifact universe be defined consistently? All tracked files at base_commit? Files reachable from the changed artifact's dependency graph?
- [ ] How large should the evaluation case set be to produce stable metrics? What is the minimum for meaningful stratification?
- [ ] Should cases be stratified by change size, repository size, change type, or artifact type?
- [ ] Should strategy evaluation be conducted blind (evaluators do not know labels until after retrieval is run)?
- [ ] Are there existing labeled datasets for change-impact or traceability research that can be adapted?
- [ ] What is the practical cost of enforcing evaluation_cutoff? Does it require automated tooling to check out base_commit before labeling, or tooling to extract exact blob states (e.g., `git cat-file`) to guarantee content fidelity?
- [ ] How should issue tracker and PR historical states be captured and verified at evaluation_cutoff without relying on manual comment redaction?
- [ ] Should contemporaneous and retrospective results always be reported separately, or only when they diverge?
- [ ] At what point should the artifact pipeline (universe → candidates → ranking → top-K) stages be decomposed into separate measurements?
