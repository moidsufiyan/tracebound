# Demo script (about six minutes)

A live walkthrough that uses only commands and artifacts in this repository. Tracebound's suggestions are leads to investigate, never findings that a file is affected; say so at the start and the end.

## What was executed, and what was not

On 2026-10-16, on the author's Windows machine (Git Bash, Node.js v24.20.0, local Ollama with `nomic-embed-text:v1.5`), these were executed and their output read:

- The investigation in step 2 on the range below, from an empty database: exit 0 in 239 s. An immediate rerun against the same database took 2.4 s and produced a byte-identical Markdown report.
- The report contents named in step 3 and the evidence ids named in step 4, taken from that run.
- The refusal in step 5 (exit 1, with the hint shown).
- `sha256sum` of `docs/evaluation/cochange/results.json` in step 6, which equals the hash printed in `report.md`.
- `--help` and `--version` (step 1) and the CLI test suites (optional step), earlier on the same day.

**Not executed:** the script as one continuous timed rehearsal; the PowerShell form of this range (the PowerShell block in [getting-started.md](getting-started.md) was executed on a different, small repository); and the optional reasoning model against this range. Ranks and similarity scores below come from one run and can differ with another Ollama build or description, so rehearse and re-read the report before presenting.

## Before the audience arrives

1. **A checkout that has the CLI onboarding changes.** `--help`, `--version` and the up-front `--db` check were not committed when this was written. Commit `7ea9064` has none of them, so step 1 fails on it.
2. **Ollama running** with the embedding model: `ollama list` shows `nomic-embed-text:v1.5`. If it is missing, run `ollama pull nomic-embed-text:v1.5`.
3. **Build:** `npm install`, then `npm run build`.
4. **Pre-warm (expensive, do this once, about 4 minutes measured).** The first run on a base commit ingests the repository and embeds every included file through Ollama (about 250 files for this range). Do not run it live.

   ```sh
   DEMO="$HOME/tb-demo"; mkdir -p "$DEMO"     # an existing directory outside the checkout; not run in exactly this form
   BASE_SHA=$(git rev-parse d5bd4c1)
   HEAD_SHA=$(git rev-parse 424837c)

   npm run investigate -- --db "$DEMO/tracebound.sqlite" --repo . --base "$BASE_SHA" --head "$HEAD_SHA" \
     --description "Add deterministic grounding guards to the impact-reasoning validator, including directional import checks, and release reasoning instructions version 1.3.0" \
     --out "$DEMO/report.md" --json-out "$DEMO/report.json"
   ```

   The database and reports are not git-ignored, so keep them outside the checkout. Run from the repository root (`--repo .`). The range is `d5bd4c1` to `424837c` ("feat(reasoning): enforce directional grounding guards and instructions v1.3.0"). `d5bd4c1` is an ancestor of `424837c` (checked with `git merge-base --is-ancestor`), and the range changes 9 files.

## The six minutes

**0:00 Frame it (30 s).** "Given two commits, it ranks files that may deserve a second look and shows the evidence for each. It is a research prototype. I measured retrieval of co-changed files, not impact accuracy."

**0:30 Step 1: the CLI states its own contract (30 s).**

```sh
npm run investigate -- --version
npm run investigate -- --help
```

Point at: the three ways to name a change, "Commits are named by full SHA; refs … are refused", the line about the first run taking minutes, and the LLM assessment marked experimental with accuracy unmeasured.

**1:00 Step 2: the warmed run (45 s).** Run the same command as the pre-warm. Expect progress on stderr ending with `Using snapshot 1 of d5bd4c1…`, then `Report written to …`, in a few seconds. Say what is happening: "Same base and database, so the three indexes are reused; the cold run was about four minutes."

**1:45 Step 3: read the report (90 s).** Open `"$DEMO/report.md"` and show, in order:

- **Changed files:** 9 changes. Two files are marked "not in this snapshot" (`src/reasoning/grounding.ts` and `test/impact-grounding.test.ts`) because the change adds them and candidates are judged in the base snapshot, so they cannot anchor an import relationship.
- **Candidates table:** 20 described. In the 2026-10-16 run, ranks 6 and 7 (`test/ollama-reasoning-provider.test.ts`, `test/benchmark/reasoning-benchmark.test.ts`) are "tests it", two more are "imported by it", and **16 of 20 are "none found"** (for example `README.md`, `AGENTS.md`). Say plainly that those 16 were surfaced by shared terms and similarity only.
- **Candidate 6:** its evidence lines (each with an id), then "What this evidence cannot show" ("An import is a file-level relationship…") and "Open questions".

**3:15 Step 4: the same evidence in JSON (45 s).**

```sh
node -e "const r=require(process.argv[1]);const c=r.candidates[0];console.log(c.rank,c.path);console.log(c.evidence.map(e=>e.id).join('\n'))" "$DEMO/report.json"
```

Expected from the 2026-10-16 run: `6 test/ollama-reasoning-provider.test.ts`, then four ids (`structural:test-to-source:…`, `lexical:…`, `semantic:…`, `fusion:…:k60`). They match the ids in the Markdown. "Every claim in the report points at a typed fact; the evidence is rebuilt from the snapshot and a mismatch fails the run."

**4:00 Step 5: it refuses unsafe input (30 s).**

```sh
npm run investigate -- --db "$DEMO/guard.sqlite" --repo . --base HEAD~1 --head "$HEAD_SHA" --description x
```

Expected (executed): `error: InvalidCommitShaError: "HEAD~1" is not a full commit SHA; refs such as branch names or HEAD are not accepted`, a `hint:` line, exit 1. "Snapshots are addressed by full SHA, so a moving ref cannot change what was analysed."

**4:30 Step 6: the evaluation, and its caveats (60 s).**

```sh
sha256sum docs/evaluation/cochange/results.json
sed -n 5p docs/evaluation/cochange/report.md
```

The hash printed first should equal the one in the second line (`22f044c7…a46c87`). In PowerShell, `Get-FileHash docs\evaluation\cochange\results.json -Algorithm SHA256` gives the same value in capitals (not executed). Then show the outcome table in `docs/evaluation/cochange/report.md`: hybrid Recall@10 **0.7642** (95% interval 0.6436 to 0.8723) on **47** commits with a test target, on one repository (`sindresorhus/got`). Say these in the same breath:

- The sibling-test baseline returned nothing (0.0000), so the result does not show superiority over a working baseline ([interpretation note](evaluation/cochange/interpretation.md), section 2).
- Hybrid versus semantic-only is inconclusive: +0.0550, interval [-0.0514, 0.1684].
- Without a description, Recall@10 fell to 0.2996.
- This is retrieval of files changed in the same commit, not impact accuracy. No impact labels exist.
- The protocol was committed in Git before the results, but there is no external time-stamp.

**5:30 Close (30 s).** "Unproven: whether developers find it useful (no user study), whether a suggested file is actually affected, anything outside this one repository, and the accuracy of the optional LLM stage."

## Optional, outside the six minutes

- **CLI tests:** `npx vitest run test/investigation.test.ts test/investigate-git.test.ts`. These two suites took about 38 s when run on 2026-10-16. Do not run the full suite live; it took 5 to 7 minutes.
- **Optional LLM assessment (do not present as validated).** It needs a model installed in the same Ollama server and both flags: `--reasoning-model <name> --reasoning-max-input-chars <n>`. A mistyped model name is rejected before any indexing (executed). It was not run against this range. In the one recorded run with a real local model (`qwen2.5-coder:7b`, four cases) the model followed the schema but did not reliably follow the caution rules, and the validator could not catch that ([ADR](architecture/decisions/impact-reasoning.md)). If the answer is rejected, the report keeps the evidence and the command still exits 0.

## If something goes wrong

| Symptom | Likely cause and fix |
|---|---|
| `Cannot reach Ollama` | Ollama is not running. Start it, then rerun. |
| Step 2 takes minutes | The pre-warm was skipped or a different database was used. Wait, or use the pre-warmed `--db`. |
| `Unknown option '--help'` | The checkout predates the onboarding changes (see "Before the audience arrives"). |
| `--db: the directory … does not exist` | Create the directory first. |
| Ranks differ from the numbers above | Normal across Ollama builds and descriptions. Describe what the report shows, not these numbers. |
