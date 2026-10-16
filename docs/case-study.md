# Tracebound: case study

> **Status:** Portfolio write-up of a research prototype, not a production system. Numbers come from the committed evaluation artifacts or from commands run in this repository; sources are linked. Where a claim could not be checked, it says so.

## At a glance

- **What it is.** A local command-line tool. Given two commits of a Git repository, it ranks the files that may deserve a second look (tests, documentation, importing modules) and shows the evidence for each.
- **How it was built.** One developer, with AI coding assistance (section 8). TypeScript on Node.js 24, SQLite, a local embedding model. About 11,000 lines in `src/` and 12,000 in `test/`, in 22 commits between 2026-10-03 and 2026-10-16.
- **How it was evaluated.** A pre-registered experiment on 50 commits of one repository outside the design. Under the rules fixed in advance, the outcome is **Supported**.
- **What that outcome does not mean.** The baseline it beat returned no results. Hybrid retrieval was not shown to beat semantic-only retrieval. Dropping the commit subject cut Recall@10 from 0.7642 to 0.2996. It covers one repository and measures co-changed files, not impact accuracy.
- **Not shown:** that developers find it useful, or that its suggestions are correct about what a change affects.

**Code state.** This study was written against the review snapshot `77710e3`, and in this document "committed" means the code at that commit. Sections 2 to 7 describe it: `npm test` gave 1,013 passed, 43 skipped on a clean tree (the skipped tests are opt-in benchmarks needing external repositories and Ollama). At that time the CLI refinements were **uncommitted working-tree changes** on top of `77710e3`: `--json-out <file>`, an up-front output-path check and `hint:` lines, plus 3 tests and a README quickstart. With those changes the suite gave 1,016 passed, 43 skipped. One earlier run of that tree had 2 failures in `test/cochange-prepare.test.ts` while a demo ran concurrently; the file passed alone and the full rerun was clean, but the messages were not captured, so the cause is unconfirmed. The evaluation ran on `34c4d41`, before any of those changes.

## 1. Overview

A developer changing a repository they do not know well has to work out what else the change might touch: dependents, tests, documentation. Today that is manual (find-references, grep, `git log`, asking a colleague). Tracebound asks: *given this change, which other files should I look at, and why?*

The working target user ([target-user.md](problem/target-user.md)) is a developer or maintainer changing an unfamiliar TypeScript or JavaScript repository. That persona and the [problem statement](problem/problem-statement.md) are marked as Phase 0 hypotheses ("Requires validation"). **No user research or usage data exist in the repository;** the pain points motivated the project and are not findings.

For each candidate the report says why it was surfaced, what that evidence cannot show, and what questions remain. It never presents a rank as proof of impact.

## 2. Developer workflow

Prerequisites: Node.js 24+, Git, and a local [Ollama](https://ollama.com) server with `ollama pull nomic-embed-text:v1.5`; then `npm install` and `npm run build`. The committed command, from the [README](../README.md):

```sh
npm run investigate -- --db tracebound.sqlite --repo ../my-repo --base <full SHA> --head <full SHA> \
  --description "fix(combine): return a Response from a short-circuiting middleware in some()" \
  [--symbol some] [--limit 20] [--format json] [--out report.md]
```

`--db` is a SQLite file where snapshots and indexes are reused between runs. `--base` and `--head` are **full** commit SHAs (refs such as `HEAD` are refused), and the base must be an ancestor of the head. `--description` is required: it is the text the term and similarity rankings match against (the commit subject works). `--format` selects Markdown (default) or JSON; `--out` writes to a file. Adding `--reasoning-model` turns on an optional LLM assessment (section 3).

The changed files come from `git diff-tree` between the commits, and candidates are judged in the **base** snapshot, the state before the change. Exit codes: 0 report written, 1 error, 2 usage. Invalid repositories, unknown or reversed commits and empty diffs fail before anything is ingested ([tests](../test/investigate-git.test.ts)).

### An actual report

One run on Tracebound's own history, base `d5bd4c1`, head `424837c` ("feat(reasoning): enforce directional grounding guards and instructions v1.3.0"), no reasoning model, produced by the committed CLI (a later run with the working-tree CLI gave byte-identical Markdown). Building the three indexes for 250 files took about 5 minutes on the development machine, a single timing and not a benchmark. Trimmed:

```markdown
## Candidates

20 described of 250 ranked (128 by lexical and structural signals, 250 by similarity with `ollama:nomic-embed-text:v1.5@0a109f422b47`; RRF K = 60).

| Rank | File | Relationship to a changed file | Matched terms | Similarity | Assessment |
|---|---|---|---|---|---|
| 6 | `test/ollama-reasoning-provider.test.ts` | tests it | 4 (in content 4, in path 1) | 0.683 | - |

### 6. `test/ollama-reasoning-provider.test.ts` (code)

Retrieval signals: fused rank 6, RRF score 0.0297, lexical/structural rank 4 (critical-structural), semantic rank 11.

Evidence:
- `structural:test-to-source:241>191`: File-level import: this file is a test that imports the changed file src/reasoning/impact-report.ts; test/ollama-reasoning-provider.test.ts:2 ("../src/reasoning/impact-report.js").
- `lexical:241`: Matched 4 distinct query terms: impact, instructions, reasoning, report (4 found in the content, 1 in the path; a term can be in both).
- `semantic:241:ollama:nomic-embed-text:v1.5@0a109f422b47:0`: Similarity 0.683 between the change and chunk 1 of 4 (excerpt of 1000 of 1064 characters).
- `fusion:241:k60`: Fused rank 6 (RRF score 0.0297, K = 60; lexical/structural rank 4, semantic rank 11).

What this evidence cannot show:
- An import is a file-level relationship: it does not show which symbols are used or whether the changed behavior is reached.
```

Ranks start at 6 because the changed files hold ranks 1 to 5, 8 and 9 and are listed separately. The JSON form holds the complete evidence objects. I did not assess whether these suggestions are correct.

## 3. Architecture

A modular monolith: one process, modules in `src/` (`git`, `ingestion`, `snapshots`, `artifacts`, `analysis`, `retrieval`, `semantic`, `reasoning`, `investigation`, `cli`, `evaluation`) calling each other through plain functions that take a database handle. Persistence is plain SQL on Node's built-in `node:sqlite`, with no ORM.

```
local Git repository (read-only, commits named by full SHA)
        |  git plumbing: ls-tree, cat-file, diff-tree, merge-base
        v
ingestion: file policy + normalization, one atomic transaction per snapshot
        v
SQLite: snapshot -> artifact versions -> content (keyed by SHA-256)
        +-- lexical index     inverted index of tokens
        +-- structural index  import graph (Babel parser)
        +-- semantic index    chunks embedded by a local Ollama model
        v
deterministic ranking (lexical + structural) --+
                                               +--> Reciprocal Rank Fusion, K = 60
semantic ranking (exact cosine similarity) ----+
        v
evidence construction: typed facts per candidate, verified against the snapshot
        v
[optional] impact reasoning: local LLM, answer checked by a deterministic validator
        v
investigation report: Markdown / JSON
```

- **Retrieval.** The deterministic ranking combines term matches with import relationships in a fixed category order ([ADR](architecture/decisions/structural-signals.md)). The semantic ranking scores file chunks by cosine similarity with the description. Reciprocal Rank Fusion (RRF) adds `1/(60 + rank)` from each list, with no tuned weights ([ADR](architecture/decisions/hybrid-retrieval.md)).
- **Provenance.** Snapshots are Git commits by full SHA; content is keyed by the SHA-256 of normalized text. The report records the snapshot, commit range, embedding model identity and, when used, the reasoning model and instruction version. Evidence ids are composed from identity fields (for example `structural:test-to-source:241>191`), so a repeated run against the same database and inputs gives the same ids. The ids contain database row ids, so a different database can give different ids.
- **Evidence versus inference.** Evidence is a typed fact (an import with file, line and specifier, matched terms, a similarity score with its chunk, or the fusion arithmetic), verified against the snapshot; a mismatch fails the run instead of being dropped ([ADR](architecture/decisions/evidence-construction.md)). Limitations and open questions come from fixed rules, not a model, and evidence never states that a file is impacted.
- **Optional reasoning.** A named model classifies each candidate from its evidence and must cite evidence ids; a deterministic validator rejects malformed answers, foreign citations and a few explicit mismatches such as reversed import direction ([ADR](architecture/decisions/impact-reasoning.md)). This stage played no part in the evaluation.

## 4. Engineering decisions

Each is recorded in an [ADR](architecture/decisions/) with its alternatives.

- **Snapshots by full SHA; HEAD is never read.** Analysing a past change must reflect that time. Refs are rejected before Git runs and every Git call addresses objects by id, so the source repository's working tree, index and refs are never touched. Cost: users supply full SHAs.
- **SQLite with plain SQL.** No PostgreSQL or Docker was available, and tests run against the real schema. Cost: a single writer and a newer built-in driver.
- **Deterministic signals first, then untuned fusion.** Each retrieval stage was benchmarked on the development cases before fusion. Cost: RRF only reorders what the pipelines find, so it inherits their errors, such as an internal change whose importer both rankings place near the top.
- **No silent truncation in embeddings.** The research code let Ollama cut long inputs to 2,048 tokens without an error. Production sends `truncate: false`, re-chunks on refusal, and puts the weights digest in the model id so a re-pulled model cannot mix vector spaces ([ADR](architecture/decisions/semantic-retrieval.md)). Cost: a slow first index.
- **Evidence is rebuilt per request, never stored.** It is a function of immutable inputs, so storing it would add a second source of truth that could go stale. The M9 module freezes one run per case for annotation ([ADR](architecture/decisions/evaluation-evidence-freezing.md)).
- **A deliberately limited reasoning stage.** The validator rejects `no_impact_indicated` outright, because no current evidence can show a file is unaffected, and any invalid batch fails the whole analysis. Cost: a lower completion rate, which the ADR says is unmeasured.

## 5. Evaluation: the frozen co-change experiment

**Question.** Does hybrid retrieval surface the test and documentation files that the same commit also changed, better than simple baselines? Co-change is a weak proxy for impact: files that should have changed but did not are invisible ([protocol](evaluation/cochange/protocol.md)).

**Dataset.** `sindresorhus/got`, pinned at `05b4476913da39a47dd8e20d29e250f28b0a6dca`. Of 1,788 reachable commits, 603 were eligible (single parent, 1 to 10 file changes, at least one source file and one test or documentation file changed) and 50 were taken evenly spaced by position in chronological order. The selector refuses a repository if any design-case commit is an ancestor of its head. The [manifest](evaluation/cochange/manifest.json) (SHA-256 `d179d992…b361`) can be regenerated byte for byte ([reproduce.md](evaluation/cochange/reproduce.md)).

**Methods.** Each runs on a snapshot of the commit's parent, with the changed source files and the commit subject as input; changed files are removed and the first 20 results scored. They are hybrid (the production ranking), deterministic only, semantic only, an untuned sibling-test heuristic (`foo.ts` to `foo.test.ts`), and a descriptive arm, hybrid with an empty description.

**Metrics.** Recall@K is the share of a commit's actual test files found in the top K, averaged over commits; MRR@20 averages 1 over the rank of the first correct file. The primary outcome is Recall@10 on test files, with 95% intervals from a paired percentile bootstrap over commits (10,000 replicates, seeds 20261014 and 2667729199).

**Decision rule, fixed before results.** *Supported* requires hybrid to beat the sibling heuristic by at least 0.10 Recall@10 with the interval entirely above zero, and no single-source baseline to outperform hybrid materially. Only the sibling comparison is confirmatory; the deterministic-only and semantic-only comparisons are exploratory, unadjusted, and can only downgrade the outcome.

**Safeguards** ([operate.md](evaluation/cochange/operate.md)). The protocol was committed before the manifest, pipeline and results (`d0b2b9a`, `1e24d61`, `34c4d41`, `77710e3`); the run was done once and nothing was tuned. The runner refuses uncommitted source and a stale build, and journals bind the commit, build hash, Node version and embedding model. Results are assembled only from a complete, verified journal; failures are recorded, never retried or dropped. The [report](evaluation/cochange/report.md) is rendered from `results.json` alone.

**What verified the embedding model.** Three different kinds of evidence:

- *By design.* Before `prepare` or `evaluate` starts, the command reads the installed model's id and full weights digest from Ollama and refuses to start unless both equal a tracked pin (`0a109f42…e59f`); it prints that they match (`src/evaluation/cochange/operator.ts`). The digest is read once, when the provider is created, and the code does not re-check it per embedding request.
- *Operator's run report.* It states that the installed model's full digest matched the expected pin before preparation and before evaluation. The underlying run records are not included in the published repository artifacts, so an independent reader cannot verify the runtime digest, and the available server-log excerpt does not establish that the model was not reloaded or replaced during the run.
- *Published artifacts alone.* They record only the configured id `ollama:nomic-embed-text:v1.5@0a109f422b47`, which is a configured id and not a verified runtime digest. The report says it does not show that the model was reachable, that its weights were verified, or that the rankings came from the real model, so a reader cannot confirm the check from the artifacts.

## 6. Results

**Outcome: Supported.** 50 commits were evaluated, 47 with a test target (minimum 20); no method failed on any commit. Sources: [results.json](evaluation/cochange/results.json) (SHA-256 `22f044c7…6c87`, re-computed and matching) and [report.md](evaluation/cochange/report.md).

Test files, 47 commits:

| Method | Recall@3 | Recall@5 | Recall@10 | Recall@20 | MRR@20 |
|---|---|---|---|---|---|
| Hybrid | 0.4238 | 0.5266 | **0.7642** | 0.8972 | 0.3624 |
| Deterministic only | 0.3085 | 0.4043 | 0.5780 | 0.7110 | 0.3135 |
| Semantic only | 0.3918 | 0.5514 | 0.7092 | 0.8642 | 0.3922 |
| Sibling-test heuristic | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0000 |

Recall@10, hybrid minus each method:

| Baseline | Difference | 95% interval | Role |
|---|---|---|---|
| Sibling-test heuristic | 0.7642 | [0.6436, 0.8723] | confirmatory |
| Deterministic only | 0.1862 | [0.0691, 0.3085] | exploratory |
| Semantic only | 0.0550 | [-0.0514, 0.1684] | exploratory |

Descriptive findings from the same run:

- **Without a description,** hybrid's Recall@10 on test files fell from 0.7642 to 0.2996 (95% interval 0.1791 to 0.4291), a paired drop of 0.4645 [0.3262, 0.6028].
- **With a structural link** (11 commits) hybrid and deterministic-only both reached 1.0000 and semantic-only 0.7273; **without one** (37 commits) hybrid scored 0.6959 and semantic-only 0.7072.
- **Documentation targets** (19 commits): hybrid 0.7632, semantic-only 0.8421.

## 7. Limitations

The first four matter most for reading the result. The [interpretation note](evaluation/cochange/interpretation.md), written after the results were known, explains them without changing any published value.

1. **The sibling baseline was empty.** It returned no candidates for any of the 50 commits, so its Recall and MRR are 0.0000 everywhere. Its rules need `.test.` or `.spec.` in a file name or a `__tests__` directory; in `got` at the pinned commit, 66 of 137 tracked files are under `test/` and none uses those conventions. The confirmatory difference is therefore just hybrid's own Recall@10. **The result does not show superiority over a working sibling baseline,** and no such comparison exists. That the ranking was empty on all 50 commits comes from a local journal outside the published release; the published artifacts alone cannot tell an empty ranking from one that missed every target.
2. **Superiority over semantic-only is not established.** Hybrid's point estimate is higher (+0.0550) but the interval includes zero. Semantic-only had the higher MRR@20 (0.3922 against 0.3624) and the higher Recall@10 on documentation targets. The advantage over deterministic-only is exploratory and unadjusted for multiple comparisons.
3. **Strong dependence on the commit subject.** Without it, Recall@10 fell from 0.7642 to 0.2996. Subjects are written after the change and can name the files being predicted, and the arm is not a leakage-free floor because the changed paths are still given.
4. **One repository.** Everything is for `sindresorhus/got`, a JavaScript and TypeScript project, and selection favours small single-parent commits that touch tests or documentation.
5. **Co-change is a proxy, with no impact labels.** The results speak to retrieval of co-changed files, not to whether a file is affected, and no accuracy is claimed for the reasoning stage.
6. **Method limits.** Files are classified by fixed path rules with known gaps (fixtures under `test/` count as tests); intervals from at most 50 commits of one repository are approximate; independence from the design cases is a safeguard (no shared commits), not proof; and the model's identity during the run is not established by the artifacts (section 5).

System limits: in the one opt-in run with a real local model (`qwen2.5-coder:7b`, four cases) the ADR reports the model did not reliably follow the caution rules and validation could not catch that, so reasoning accuracy is unmeasured. Structural evidence is file-level imports only, with no symbol, transitive or Git-history signals, and only changed paths are used, not diff content. The nine hand-built development cases (`moidsufiyan/wollyway`, `honojs/hono`) are too few for statistical claims and are not held-out; hybrid found 6 of 7 labelled files in its top 10 against 4 of 7 for each single ranking ([ADR](architecture/decisions/hybrid-retrieval.md)).

## 8. My engineering contribution and use of AI assistance

**What the history shows.** 22 commits under one author identity; the architecture ADR describes a single-engineer project. The history contains snapshot ingestion (`2aa87b1`, `5d40327`); lexical, structural and semantic retrieval and fusion (`38c36d8`, `391286c`, `be17f24`, `3e84bce`); evidence, validated impact assessment and grounding guards (`9e628e8`, `aec7f39`, `424837c`); the `investigate` command (`9731475`); research, design cases and M9 evidence freezing (`dbec42b`, `01fc8c3`, `6990947`); and the pre-registered protocol, pipeline, results and interpretation note (`d0b2b9a`, `1e24d61`, `34c4d41`, `77710e3`). Each major decision has an ADR.

**AI-assisted development.** Coding agents were used in this project: the repository carries [AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md) as standing instructions for them, and this case study was itself drafted with an AI assistant (Claude Code) from the repository's records. I do not present the code as unaided work.

- *Documented division of responsibility* (`AGENTS.md`): the developer owns the code, and architecture, scope and consequential decisions stay with the developer (line 116); the developer approves phase gates and approves or corrects an agent's plan for multi-file work; the developer must be able to explain every line of a diff (line 256); agents do not commit or push unless told to (line 298).
- *Limits of that evidence.* It states intended practice. It was committed on 2026-10-14 (`d5bd4c1`), after the retrieval, evidence, reasoning and M9 commits, so it does not show what applied earlier or how any specific change was produced.
- *Attribution.* `AGENTS.md` tells agents not to add attribution trailers unless wanted (line 253), so their absence from the history says nothing either way. Line-by-line authorship percentages were not tracked, and I give none or any claim about the share written by an agent or by me.

The repository records no team size beyond the above, and no users, adoption, deployments or performance-improvement measurements. None are claimed.

## 9. Current status and future direction

**Usable now** (verified by running the command and the suite): the `investigate` command on a local JavaScript or TypeScript Git repository with Ollama, producing Markdown or JSON reports; the library functions behind it; and the evaluation tooling. The package is marked `private` and has not been released.

**Implemented but unproven:** whether the suggestions help a developer or any file is actually affected; the accuracy of the LLM assessment; hybrid's advantage over semantic-only retrieval or over a working sibling baseline; behaviour on any other repository or language.

**Planned or not implemented** (per the [system overview](architecture/system-overview.md) and ADR "Deferred" sections): a GitHub module and issue or pull-request linking; Git-history signals in production retrieval; symbol-level and transitive analysis, use of diff content, deriving the description from commit messages; incremental ingestion and any interface beyond the command. A comparison with a working sibling baseline would be a new experiment under its own protocol, not a continuation of the frozen run.
