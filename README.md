# Tracebound

**Evidence-backed software change impact and traceability.**

Given two commits of a local Git repository, Tracebound ranks the files that may deserve a second look (importing modules, tests, documentation) and shows the evidence behind each suggestion. It is a command-line research prototype for JavaScript and TypeScript repositories.

> **Status:** research prototype, not a production system. A candidate is a *suggestion to investigate*, never a prediction that a change affects it. There is no user research or usage data behind the intended-user description below, and the evaluation measures retrieval of co-changed files, not impact accuracy (see [Evaluation](#evaluation)).

## The problem and intended users

A developer changing a repository they do not know well has to work out what else the change might touch. Today that is manual: find-references, grep, `git log`, asking a colleague. Tracebound's working hypothesis is that deterministic signals (imports, shared terms) combined with embedding similarity can shortlist those files, with the reason for each.

The intended user is a developer or maintainer changing an unfamiliar or moderately complex TypeScript or JavaScript repository ([target-user.md](docs/problem/target-user.md)). That persona and the [problem statement](docs/problem/problem-statement.md) are Phase 0 hypotheses, marked "Requires validation" in those documents. They have not been validated with users.

## Capabilities

| Status | What |
|---|---|
| **Implemented** | Read-only ingestion of a Git commit as a snapshot, named by full SHA (refs are refused). Lexical, import-based structural and embedding-based semantic indexes. Hybrid ranking by Reciprocal Rank Fusion. Typed, verified evidence for each candidate. The `investigate` command, with Markdown and JSON reports. Covered by the test suite. |
| **Experimental** | Optional LLM impact assessment (`--reasoning-model`): a local model classifies candidates from their evidence and a deterministic validator checks its answer. Its accuracy has not been measured. The frozen [co-change evaluation](#evaluation) tooling and the M9 evidence-freezing tooling. |
| **Planned, not implemented** | GitHub and issue or pull-request linking; Git-history signals in retrieval; symbol-level and transitive analysis; use of the diff content; incremental ingestion; a user interface; languages other than JavaScript and TypeScript. |

## Quickstart

Prerequisites: **Node.js 24 or later** (it uses the built-in `node:sqlite`), **Git**, and a local **[Ollama](https://ollama.com)** server with the embedding model. Ollama is needed for every run: the change description is always embedded for the similarity ranking, and a missing semantic index is built with the same model.

```sh
ollama pull nomic-embed-text:v1.5
npm install
npm run build
```

Then investigate a change between two commits of a local repository. To analyze one commit, use its parent as the base:

```sh
REPO=../my-repo
HEAD_SHA=$(git -C "$REPO" rev-parse <commit or ref>)
BASE_SHA=$(git -C "$REPO" rev-parse "$HEAD_SHA^")

npm run investigate -- --db tracebound.sqlite --repo "$REPO" --base "$BASE_SHA" --head "$HEAD_SHA" \
  --description "$(git -C "$REPO" log -1 --format=%s "$HEAD_SHA")" \
  --out impact.md --json-out impact.json
```

In PowerShell, set `$head = git -C $repo rev-parse <commit>` and `$base = git -C $repo rev-parse "$head^"`, and pass them to the same `npm run investigate -- ...` arguments.

The first run on a commit ingests it and builds its three indexes into the SQLite file named by `--db`, with progress on standard error. The semantic index embeds every included file, so this takes minutes (about five for one 250-file repository on the author's machine, a single timing). Later runs against the same base reuse the stored data. Tracebound reads only Git objects: the repository's working tree, index and refs are never read or changed. Running the command with no arguments prints the usage text (there is no `--help`).

## Usage

**Inputs.** Name the change in one of three ways:

| Form | Meaning |
|---|---|
| `--repo <path> --base <full SHA> --head <full SHA>` | The change between two commits. The changed files are derived with `git diff-tree` (additions, modifications, deletions, renames), and the base must be an ancestor of the head. Candidates are judged in the **base** snapshot, the state before the change. |
| `--repo <path> --commit <full SHA> [--changed <path>]...` | The commit's snapshot, with the changed paths you name (the flag is repeatable; they are not derived). |
| `--snapshot <id> [--changed <path>]...` | An already ingested snapshot in `--db`. |

`--db` and `--description` are always required. The description is the text the term and similarity rankings match against: the commit subject works, or a sentence naming the changed behavior. Optional flags: `--symbol <name>` (extra names to match, repeatable), `--limit <n>` (candidates described, default 20), `--ollama <url>` (another Ollama server), `--format markdown|json` (default Markdown), `--out <file>` (write the report to a file, otherwise standard output) and `--json-out <file>` (also write the JSON report from the same run).

**Outputs.** The Markdown report lists the changed files, a candidate table, and for each candidate its evidence with evidence ids, its retrieval signals, what that evidence cannot show, and the open questions it leaves. The JSON report holds the same information with the complete evidence objects. The optional assessment adds a classification per candidate; `insufficient_evidence` is not a finding that a file is unaffected.

**Exit codes and errors.** `0` report written, `1` error, `2` usage error. Errors print as `error: <name>: <message>`, with a `hint:` line when there is a known fix:

```
error: InvalidCommitShaError: "HEAD~1" is not a full commit SHA; refs such as branch names or HEAD are not accepted
hint: name commits by their full id: `git -C <repo> rev-parse <ref>` prints it, and `git -C <repo> rev-parse <sha>^` prints the parent of a commit.
```

Invalid repositories, unknown, reversed or identical commits, and empty diffs fail before anything is ingested. A missing output directory is a usage error raised before any work starts. If an optional assessment is rejected or fails, the report still shows the evidence and the command exits 0.

## Example output

Trimmed from a real report: Tracebound's own history, base `d5bd4c1` to head `424837c`, no reasoning model. This is one illustrative run. It shows why files were surfaced; I did not assess whether they are truly affected.

```markdown
20 described of 250 ranked (128 by lexical and structural signals, 250 by similarity with `ollama:nomic-embed-text:v1.5@0a109f422b47`; RRF K = 60).

| Rank | File | Relationship to a changed file | Matched terms | Similarity | Assessment |
|---|---|---|---|---|---|
| 6 | `test/ollama-reasoning-provider.test.ts` | tests it | 4 (in content 4, in path 1) | 0.683 | - |
| 7 | `src/retrieval/evidence.ts` | imported by it | 1 (in content 1, in path 0) | 0.674 | - |
| 10 | `AGENTS.md` | none found | 5 (in content 5, in path 0) | 0.665 | - |

### 6. `test/ollama-reasoning-provider.test.ts` (code)

Evidence:
- `structural:test-to-source:241>191`: File-level import: this file is a test that imports the changed file src/reasoning/impact-report.ts; test/ollama-reasoning-provider.test.ts:2 ("../src/reasoning/impact-report.js").
- `fusion:241:k60`: Fused rank 6 (RRF score 0.0297, K = 60; lexical/structural rank 4, semantic rank 11).

What this evidence cannot show:
- An import is a file-level relationship: it does not show which symbols are used or whether the changed behavior is reached.
```

Ranks start at 6 because the changed files hold ranks 1 to 5, 8 and 9 and are listed separately. Rank 10 has no import relationship: it was surfaced by shared terms and similarity alone, and the report says so.

## How it works

```
local Git repo (read-only, full SHAs) -> ingestion -> SQLite snapshot (artifacts, content by SHA-256)
   -> lexical + structural + semantic indexes
   -> deterministic ranking + semantic ranking -> Reciprocal Rank Fusion (K = 60)
   -> evidence construction (typed, verified facts) -> [optional] LLM assessment -> report
```

A modular monolith in TypeScript on Node.js 24, with plain SQL on `node:sqlite` and a local Ollama embedding model. For the data flow, design decisions and their trade-offs, read the **[case study](docs/case-study.md)**; the architecture decision records are in [docs/architecture/decisions/](docs/architecture/decisions/).

## Evaluation

A pre-registered, held-out experiment: 50 commits of `sindresorhus/got`, scored on how well each method ranked the test and documentation files the same commit also changed (a weak proxy for impact). The frozen decision rule returned **Supported**: on test files, hybrid's Recall@10 was 0.7642 (95% interval 0.6436 to 0.8723; 47 commits had a test target).

**Read these caveats with it:**

- **The sibling-test baseline was empty.** The [interpretation note](docs/evaluation/cochange/interpretation.md) reports that it returned no candidates on any of the 50 commits. That comes from a local evaluation journal that is not part of the published release; the published results show only that its scores were 0.0000. The confirmatory comparison was therefore against a heuristic that found nothing, and the result does not show superiority over a working sibling baseline.
- **Superiority over semantic-only retrieval is not established.** Hybrid's Recall@10 was higher by 0.0550, with an interval of -0.0514 to 0.1684 that includes zero. Semantic-only had the higher MRR@20.
- **It depends heavily on the commit subject.** With an empty description, hybrid's Recall@10 fell from 0.7642 to 0.2996.
- **One repository.** Nothing is claimed for other repositories or languages, and co-change is not impact accuracy.

Published records: [report](docs/evaluation/cochange/report.md), [machine-readable results](docs/evaluation/cochange/results.json), [interpretation note](docs/evaluation/cochange/interpretation.md), [protocol](docs/evaluation/cochange/protocol.md), [manifest](docs/evaluation/cochange/manifest.json), and how to [reproduce the dataset](docs/evaluation/cochange/reproduce.md) or [run the evaluation](docs/evaluation/cochange/operate.md).

## Project status

**Usable now:** the `investigate` command on a local JavaScript or TypeScript repository, with Ollama running; the library functions behind it; and the test suite.

**Unproven:** whether the suggestions help developers (no user study); whether any suggested file is actually affected (no impact labels); the accuracy of the optional LLM assessment; hybrid's advantage over semantic-only retrieval; behavior on other repositories. The package is marked `private` and has not been released, and nothing here is production-ready. No adoption or usage data exists.

## Development

```sh
npm test            # Vitest; benchmark suites that need external repositories and Ollama are skipped by default
npm run typecheck
npm run build       # emits dist/, which npm run investigate runs
```

The full suite takes several minutes and creates throwaway Git repositories in the OS temp directory. There is no linter. Project conventions and invariants for contributors and coding agents are in [CLAUDE.md](CLAUDE.md) and [AGENTS.md](AGENTS.md).

## Repository layout

```
src/            production code: db, git, projects, snapshots, artifacts, ingestion, analysis,
                retrieval, semantic, reasoning, investigation, cli, evaluation
test/           Vitest suites and benchmarks
scripts/        evaluation runners
experiments/    Phase 1 research scripts (standalone; not production code)
docs/           architecture and ADRs, problem framing, research, evaluation records, case study
```

## Further reading

- [Case study](docs/case-study.md): architecture, engineering decisions, evaluation and limitations in depth
- [System overview](docs/architecture/system-overview.md), [retrieval architecture](docs/architecture/retrieval-architecture.md), [domain model](docs/architecture/domain-model.md)
- [Architecture decision records](docs/architecture/decisions/), starting with the [investigation report](docs/architecture/decisions/investigation-report.md)
- [Problem statement](docs/problem/problem-statement.md), [target user](docs/problem/target-user.md), [workflow](docs/problem/workflow.md)
- [Evaluation methodology](docs/evaluation/methodology.md) and the [co-change evaluation](docs/evaluation/cochange/report.md)
