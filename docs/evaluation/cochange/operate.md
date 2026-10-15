# Running the co-change evaluation

How to run the registered evaluation ([protocol.md](protocol.md), [manifest.json](manifest.json)) with the operator command, and how to recover when a run is interrupted. The command calls the production phase functions in `src/evaluation/cochange/`; it adds path checks, the embedding pin and the publication identity check, and nothing else.

## Prerequisites

- Node 24 or later, and `npm ci && npm run build` at the commit you will run. The runner uses `dist/` as it is and never rebuilds; the phases refuse a `dist/` that is not the build of the checked-out source.
- A full, non-shallow, non-partial clone of `sindresorhus/got` that holds the pinned head (see [reproduce.md](reproduce.md), step 2). It is only read.
- A local Ollama server with `nomic-embed-text:v1.5` installed at the pinned weights digest. Nothing is ever pulled or substituted.
- A work directory on a local disk, outside the Tracebound checkout and the clone. `prepare` creates it; it must hold nothing but the files the phases write.

## Configuration

Reviewed and tracked, so part of the evaluation identity:

- The dataset registration (`REGISTERED` in `src/evaluation/cochange/preflight.ts`): manifest SHA-256, repository and head.
- The embedding pin (`EMBEDDING_PIN` in `src/evaluation/cochange/embedding-pin.ts`): model id `ollama:nomic-embed-text:v1.5@0a109f422b47` and weights digest `0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`, the build recorded for the M6/M9 runs in `docs/evaluation/m9/candidate-manifest.json`. Before `prepare` or `evaluate` starts, the model id and the **full** digest that Ollama reports for the installed model must equal the pin; two builds can share the 12-character id. Without a pin the commands refuse (exit 2).

Given on every command, never stored in results: `--repo` (the clone), `--work` (the work directory), `--ollama` (the server URL, for `prepare` and `evaluate`) and `--out` (an existing directory for `publish`, normally `docs/evaluation/cochange`). Relative paths are resolved against the current directory.

## Lifecycle

1. **Commit first.** Commit the implementation and configuration, then `npm ci && npm run build`. The phases refuse uncommitted, untracked or ignored files under `src`, `scripts`, `docs/evaluation/cochange`, `package.json`, `package-lock.json` and the `tsconfig` files.
2. **Prepare** until it reports `Preparation complete`. It writes the frozen database and its durable identity (`frozen.identity.json`); nothing is handed over in memory.
3. **Evaluate** until it reports `Evaluation complete`, from the same commit, build, Node version and embedding model. The journals and the freeze identity bind all four, and evaluation refuses any change.
4. **Publish** last. It refuses unless the evaluation journal is complete, and unless the checkout is still the evaluated commit and build on the same Node version.
5. **Commit the results separately.** Publishing writes `results.json` and `report.md` into the checkout, which changes its Git state on purpose. The commit that adds them is a later source commit and so a different evaluation identity: a run from it, or from any later commit, needs a new work directory.

```sh
npm run cochange -- prepare  --repo <clone> --work <work dir> --ollama http://127.0.0.1:11434
npm run cochange -- evaluate --repo <clone> --work <work dir> --ollama http://127.0.0.1:11434
npm run cochange -- publish  --repo <clone> --work <work dir> --out docs/evaluation/cochange
```

`prepare` and `evaluate` resume where they stopped when run again: recorded bases and commits, succeeded or failed, are never run again. Running a phase that has finished is safe: `prepare` refuses (exit 3, "already finished"), `evaluate` records nothing and reports completion again, and `publish` finds identical files and reports them `unchanged`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | The phase finished (or had already finished). |
| 1 | Internal error (an uncaught exception); report it with its output. |
| 2 | Usage or configuration error: arguments, paths, endpoint or embedding pin. Nothing was started. |
| 3 | Refused: the work directory, inputs, phase order, source identity, embedding model or an existing output file does not allow the phase. Nothing was recorded. |
| 4 | The work directory is locked by another run, or a lock was left behind. Nothing in it was read or changed. |
| 5 | Stopped before finishing. Records already written stay; the message says whether to rerun. |
| 6 | The evaluation journal is complete but does not verify against its inputs. It is not a result and cannot be published. |

## Completion and outcome

A **complete** evaluation journal is one with a record for every selected commit. That includes commits where a method failed: failures are recorded, never retried, replaced or dropped. A complete journal is published whatever it contains:

- If hybrid, deterministic-only, semantic-only or the sibling heuristic failed on any commit (including commits whose base failed preparation), the results are `primary-incomplete`, no primary estimate is computed, and the outcome is **Inconclusive** by protocol section 6, rule 1. `evaluate` already says so when it finishes.
- Otherwise the results are `complete` and the outcome (Supported, Mixed, Negative or Inconclusive) follows the decision rules.

An **incomplete** journal (commits never evaluated, or a torn tail) is never published.

## After an embedding-provider outage

`prepare` and `evaluate` stop with exit 5 when the provider becomes unavailable. The failure of the base or commit that met the outage is recorded; the entries after it are not.

- Once the provider is back, run the same command again on the **same work directory**. It processes the unrecorded entries only.
- A recorded failure is terminal. It is never retried in that run, not even when the outage that caused it is over.
- If a primary method or the sibling heuristic failed on any commit, primary completeness is lost: the results are `primary-incomplete` and the outcome stays **Inconclusive** (protocol section 6, rule 1). Resuming does not change that.
- Do not start a new work directory just to erase or replace that outcome. The recorded run stands, and it is published as it is.
- A further experiment needs its own authorization. It is a distinct run with its own work directory and its own results, never a continuation of the interrupted run, and it does not replace the outcome of the interrupted one.

## Line endings of published files

`.gitattributes` keeps `docs/evaluation/cochange/*.md` at LF on every checkout, so `report.md` keeps the SHA-256 `publish` printed even where Git converts line endings (Git for Windows' default `core.autocrlf=true`). `results.json` is single-line canonical JSON and has no line endings to convert. To check a checkout: `git ls-files --eol docs/evaluation/cochange/report.md` shows `i/lf w/lf attr/text eol=lf`, and the file's SHA-256 (`sha256sum`, or `Get-FileHash` in PowerShell) equals the one `publish` printed. `test/cochange-report-eol.test.ts` checks this through a checkout and a clone, against a control without the rule.

## Recovery

The commands never repair anything on their own beyond the documented journal recovery. They inspect, refuse and report; the steps below are for the operator.

**Stale `run.lock` after a crash.** Exit 4 names the owner (purpose, process, host, start time) and, on the same host, whether that process still runs. Make sure no process is running a phase on this work directory on any host that can see it, then delete `<work>/run.lock` by hand and run the same command again. It repeats every check under a fresh lock and recovers a torn journal tail if there is one.

**Interrupted preparation or evaluation.** Run the same command again. A journal that ends in a partly written line is recovered under the lock: the torn bytes are kept in `<journal>.torn` (leave that file in place) and the complete records stand. The base or commit that was in progress when the run stopped has no record and is run again; nothing recorded is. A provider outage records the failure of the base or commit it hit, then stops (exit 5) so the rest are not failed by the same outage.

**Frozen database without its identity.** A crash between freezing and publishing the identity leaves `frozen.sqlite` without `frozen.identity.json`. `prepare` refuses it (`frozen-database-without-identity`) and reports its SHA-256, integrity and whether its rows equal the working database's; `evaluate` refuses it too. It is never adopted. Remove `frozen.sqlite` by hand (move it out of the work directory if you want to keep it) and run `prepare` again: with every base recorded, it verifies the working database, freezes a new copy and publishes its identity. Never write or copy an identity file by hand.

**Leftover temporary files.** `.frozen.identity.json.<id>.tmp` in the work directory is refused as an unexpected entry; with no run holding the lock, delete it and rerun. `.results.json.<id>.tmp` or `.report.md.<id>.tmp` in the output directory can only be left by a killed process; delete them, since they make `docs/evaluation/cochange` untracked-dirty for the next run's checks.

**Partial publication.** If `publish` stopped after writing one file, run it again. The file already written is accepted only when its bytes are identical (`unchanged`), and the missing one is written.

**Conflicting output file.** If `results.json` or `report.md` exists with other bytes, `publish` refuses (`artifact-conflict`) before writing either and leaves the file as it is. Find out where it came from: a hand edit, an earlier run's results, or a line-ending conversion on checkout. Restore the published bytes from Git, or move the file away if it belongs to another run. A published file is never edited.

**Changed source commit, build or Node version between phases.** `evaluate` refuses a work directory whose journals or freeze identity were written under another commit, build, Node version or embedding model (`header-mismatch`, `freeze-identity-mismatch`); `publish` refuses a checkout other than the evaluated commit and build, or another Node version. Either check out the commit recorded in the journal header (`tracebound.commit`), run `npm ci && npm run build` on the recorded Node version and continue, or start a new run from the new commit in a new work directory. A work directory is never moved to another identity.

**Database without a journal, or other refused work-directory contents.** `prepare` refuses a `preparation.sqlite` without `preparation.jsonl`, unknown files, and journals or databases that do not match each other. Their contents cannot be accounted for, so they are not reused: start a new run in a new work directory and keep the old one for inspection.
