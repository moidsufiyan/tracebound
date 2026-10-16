# Getting started

This guide takes you from a fresh checkout to your first report. Tracebound is a research prototype, so read every candidate it reports as a lead to look at, not a finding that the change affects that file.

You will need a few minutes for setup and, on the first run against a repository, several more while Tracebound indexes it.

## 1. Prerequisites

| Requirement | Why | Check |
|---|---|---|
| Node.js 24 or later | The database uses the built-in `node:sqlite` module | `node --version` |
| Git on the `PATH` | Commits are read with `git` commands | `git --version` |
| [Ollama](https://ollama.com), running, with `nomic-embed-text:v1.5` | Every run embeds the change description, and the first run on a commit embeds the repository | `ollama list` shows `nomic-embed-text:v1.5` |
| A local Git repository to investigate | Tracebound reads a clone on disk; it does not fetch anything | `git -C <repo> log -1` |

What Tracebound reads: TypeScript and JavaScript files, Markdown and plain-text documents, and JSON and YAML files. Build output and dependencies (`node_modules`, `dist`, `build` and similar), lockfiles, minified files, symlinks and files over 1 MiB are left out. Import relationships are found only between TypeScript and JavaScript files. It has been evaluated on one JavaScript and TypeScript repository; nothing is known about how well it serves others.

## 2. Install

Tracebound is not published to npm. Run it from a checkout of this repository:

```sh
ollama pull nomic-embed-text:v1.5
npm install
npm run build
```

`npm run build` compiles to `dist/`, which `npm run investigate` runs. Rebuild after pulling new changes.

## 3. Check that everything is ready

```sh
node --version                      # v24 or later
ollama list                         # lists nomic-embed-text:v1.5
npm run investigate -- --help       # prints the help: the build works
```

There is no separate check command. An investigation checks Git, the repository, the commits and the Ollama server before it ingests anything, and stops with an `error:` line (and a `hint:` when there is a known fix) if one is missing. See [Troubleshooting](#7-troubleshooting).

Always put `--` after `npm run investigate`. Without it, npm takes the flags for itself and Tracebound receives only their values.

## 4. Run your first investigation

Tracebound names commits by their **full** SHA; branch names, tags and `HEAD` are refused, so a ref never silently moves under you. Resolve refs yourself with `git rev-parse`, as below, and pass the SHAs it prints. To look at one commit, use its parent as the base.

The examples look at the commit checked out in the target repository (`HEAD`). Replace `HEAD` with any commit, branch or tag to look at another one.

In Bash or another POSIX shell:

```sh
REPO=../my-repo
HEAD_SHA=$(git -C "$REPO" rev-parse HEAD)
BASE_SHA=$(git -C "$REPO" rev-parse "$HEAD_SHA^")

npm run investigate -- --db tracebound.sqlite --repo "$REPO" \
  --base "$BASE_SHA" --head "$HEAD_SHA" \
  --description "Retry failed uploads once before reporting an error" \
  --out report.md --json-out report.json
```

In PowerShell:

```powershell
$repo = '..\my-repo'
$head = git -C $repo rev-parse HEAD
$base = git -C $repo rev-parse "$head^"

npm run investigate -- --db tracebound.sqlite --repo $repo `
  --base $base --head $head `
  --description 'Retry failed uploads once before reporting an error' `
  --out report.md --json-out report.json
```

What each part does:

- `--db tracebound.sqlite`: a SQLite file, created if missing, that keeps snapshots and indexes. Its directory must already exist. Reuse the same file so later runs are fast.
- `--base` and `--head`: the change. The changed files are derived from Git, and candidates are judged in the base snapshot, the state before the change. The base must be an ancestor of the head.
- `--description`: what the change does and why. The rankings match against it, so a sentence naming the behavior and the components involved works much better than a short label. Quote it.
- `--out` and `--json-out`: the Markdown and the JSON report of the same run. Without `--out`, the report goes to standard output.

Progress goes to standard error. A first run on a commit prints lines like these (paths, ids and counts vary):

```
Derived 3 file changes from <base>..<head>
Registered repository /path/to/my-repo
Ingested snapshot 1 of <base>
Built the lexical index of snapshot 1
Built the structural index of snapshot 1
Building the semantic index of snapshot 1 with ollama:nomic-embed-text:v1.5@0a109f422b47 (embeds every included file)
Report written to report.md
JSON report written to report.json
```

**How long it takes.** The slow step is the semantic index: it embeds every included file through Ollama, so the first run on a base commit takes minutes, depending on the repository's size and your machine. Another investigation from the same base commit and `--db` reuses everything and needs only the description's embedding. A new base commit is ingested and indexed again.

Tracebound reads Git objects only. It never changes, or even reads, the repository's working tree, index or refs, so uncommitted work is ignored and safe.

`npm run investigate -- --help` lists every option, including the other two ways to name the change. The [README](../README.md#usage) explains those ways and the main options.

## 5. Read the report

**Markdown (`report.md`)** has these sections:

1. **How to read this report**: what the signals mean and do not mean.
2. **Changed files**: each changed path, how it changed, and whether it exists in the base snapshot. A file the change adds does not, so no import relationship can be found for it.
3. **Impact assessment**: "not requested" unless you ran the optional assessment (section 6).
4. **Candidates**: a table of the ranked files, then one section per candidate with:
   - *Evidence*: each fact with its evidence id, such as an import declaration with its file and line, matched terms, similarity and the fused rank.
   - *What this evidence cannot show*: for example, that an import does not prove the changed behavior is reached.
   - *Open questions*: what a reviewer still has to check.
5. **Limitations of this report**.

Start with candidates whose "Relationship to a changed file" column names one ("imports it", "imported by it", "tests it"), then read the others. A candidate whose column says "none found" (its section adds "No import relationship with a changed file") was surfaced by shared terms and similarity alone, and can be generic documentation or unrelated material.

**JSON (`report.json`)** holds the same run for scripts and tools. Its top-level fields are `snapshot`, `change`, `commitRange`, `changedFiles`, `retrieval` (model id, candidate counts, the limit), `reasoning` (the assessment status), `candidates` (each with `path`, `signals`, the complete `evidence` objects, `summary`, `limitations`, `openQuestions` and `assessment`) and `limitations`.

## 6. Optional: the LLM assessment

```sh
ollama pull <model>
npm run investigate -- ... --reasoning-model <model> --reasoning-max-input-chars <n>
```

A local model on the same Ollama server classifies each candidate (`likely_affected`, `potentially_affected`, `no_impact_indicated` or `insufficient_evidence`) from its evidence, and a deterministic validator checks the answer. It is experimental: its accuracy has not been measured, and in the one recorded run with a real local model the model did not reliably follow the caution rules ([case study](case-study.md)). `--reasoning-max-input-chars` is the largest request the model should get, so set it from the model's context size. The model name is checked before anything is ingested. If the answer is rejected or the model fails, the report keeps the evidence without classifications and the command still exits 0. `insufficient_evidence` never means a file is unaffected.

## 7. Troubleshooting

| You see | Cause and fix |
|---|---|
| npm prints its own `run` help, or `npm warn Unknown cli config "--db"` | `--` is missing after `npm run investigate`. |
| `Unexpected argument '…'. This command does not take positional arguments` | `--` is missing, or a value with spaces (usually `--description`) is not quoted. |
| `Cannot find module …dist/cli/investigate.js` | The build has not run. Run `npm run build`. |
| An error on start that mentions `node:sqlite`, or `npm warn EBADENGINE` during `npm install` | Node.js is probably older than 24. Check `node --version` and install Node 24 or later. |
| `error: InvalidCommitShaError: "HEAD~1" is not a full commit SHA` | A ref or short id was given. Use `git -C <repo> rev-parse <ref>` to print the full SHA. |
| `error: CommitNotFoundError: Commit … does not exist in the repository …` | The SHA is not in that clone. Check `--repo`; if the commit exists only on a remote, fetch it into your clone first. |
| `error: UnsupportedCommitRangeError: The base commit … is not an ancestor of the head commit …` | `--base` and `--head` are swapped or on unrelated branches. The base must be an older commit the head descends from. |
| `error: EmptyChangeSetError: No file differs between …` | The two commits have the same files. Pick a range that changes something. |
| `error: NotAGitRepositoryError: … is not a Git repository` | `--repo` does not point at a Git repository. |
| `error: EmbeddingProviderUnavailableError: Cannot reach Ollama at …` | Ollama is not running. Start it, or name another server with `--ollama <url>`. |
| `error: EmbeddingProviderError: Ollama at … does not have nomic-embed-text:v1.5 installed` | Run `ollama pull nomic-embed-text:v1.5`. |
| `error: ReasoningProviderError: … does not have the model "…" installed` | Check the name with `ollama list`, or `ollama pull` it. |
| `--db: the directory … does not exist` (or `--out: …`, `--json-out: …`) | Create the directory first. This is checked before any work starts. |

Exit codes: `0` report written, `1` error, `2` usage error (the message is followed by the usage text).

## Next

- [README](../README.md): the ways to name a change, the main options, what to expect from the ranking, and the evaluation results.
- [Case study](case-study.md): how it works and what is known about how well it works.
