# Post-evaluation interpretation note

**This note was written after the results were known and published. It is not part of the pre-registered report and it changes nothing in it.** The frozen outcome, [results.json](results.json), [report.md](report.md), [protocol.md](protocol.md) and [manifest.json](manifest.json) are as published. No metric is recalculated here; every number is copied from the published artifacts, or is marked as coming from the local journal.

It explains four things a reader of the report alone could miss: what the baseline comparison does and does not show, the semantic-only comparison, the dependence on the commit subject, and the scope of the evidence.

## Where each claim can be checked

| Tag | Source | Available to a reader of this repository |
|---|---|---|
| **[A]** | The published artifacts: `results.json` (SHA-256 `22f044c703377728cde800c7492a009c8cdf92bff43bf9ccb8b548a921a46c87`) and `report.md` (SHA-256 `0cca03a4fe7562522927e5500b282b60f5c4e2fe5edc054a9bd6083979b6728f`) | Yes |
| **[B]** | Other committed or public inputs: `manifest.json`, `protocol.md`, and the `sindresorhus/got` repository at commit `05b4476913da39a47dd8e20d29e250f28b0a6dca` | Yes |
| **[C]** | The evaluation journal `evaluation.jsonl`, SHA-256 `8b46c1024293639e756be56c2f84b5e8994424dfed2cf0d243b6293168b24e4d`, in the local work directory of the run | **No.** It is not part of the published release. The published results record its hash (`provenance.evaluationJournalSha256`) but not its contents. |

## 1. The frozen outcome

**Supported**, by rule `supported` of protocol section 6. **[A]** 50 commits were evaluated; 47 had a test target (the minimum is 20). On those 47, hybrid's macro Recall@10 was **0.7642** (95% interval 0.6436 to 0.8723). Comparisons are hybrid minus the baseline, on macro Recall@10 over test targets:

| Baseline | Baseline Recall@10 | Difference | 95% interval | Role |
|---|---|---|---|---|
| Sibling-test heuristic | 0.0000 | 0.7642 | [0.6436, 0.8723] | confirmatory |
| Deterministic only | 0.5780 | 0.1862 | [0.0691, 0.3085] | exploratory |
| Semantic only | 0.7092 | 0.0550 | [-0.0514, 0.1684] | exploratory |

The rule was met: the sibling difference is at least 0.10 with its interval strictly above zero, and neither single-source baseline outperformed hybrid materially. That is the whole meaning of the outcome. Sections 2 to 4 qualify how it should be read; none of them changes it.

## 2. The sibling baseline did not function in this repository

This is the most important qualification.

- **[A] What the published artifacts show.** The sibling heuristic is recorded as having run on all 50 commits, and none of the targets appears in its ranking for any commit. Its Recall and MRR are 0.0000 in every table, and the Cases table reads "none" in its column on all 50 rows. The report does not say why. A non-empty ranking that missed every target would look identical in these artifacts.
- **[C] What the local journal shows.** The sibling ranking (`evidence.rankings.siblingPaths`) is **empty, with zero candidates, in all 50 of 50 records**.
- **[B] Why.** Every tier of the sibling heuristic (protocol section 4) requires a file name with `.test.` or `.spec.` after the stem, or a `__tests__` directory. In `got` at the pinned commit, 66 of its 137 tracked files are under `test/`, and none has `.test.` or `.spec.` in its name or sits under `__tests__`. The manifest's 68 test targets (in 47 commits) follow the same pattern; they are named like `test/test-post.js` and `test/server.js`. The heuristic was applied as pre-registered and was not altered.

**Consequence.** Because the sibling scores 0.0000 everywhere, the confirmatory difference is simply hybrid's own Recall@10 (0.7642). The result shows that hybrid retrieved test files better than a heuristic that returned nothing for this repository. **It does not demonstrate superiority over a functioning sibling baseline.** No functioning sibling run exists, so this note makes no estimate of how one would have compared. The protocol anticipated this kind of dependence: its limitations say the repository's conventions "shape all methods, the sibling heuristic most" (section 7).

## 3. Hybrid versus semantic-only

**[A]** Hybrid's point estimate was higher (difference 0.0550), but the 95% interval [-0.0514, 0.1684] includes zero, so **superiority over semantic-only was not established**. Nor did semantic-only outperform hybrid materially, so there was no downgrade of the outcome. Under the protocol this comparison is exploratory and can only downgrade, never support.

For context, strata other than the primary are descriptive only. In the documentation stratum (19 commits), semantic-only's Recall@10 point estimate (0.8421) was higher than hybrid's (0.7632). **[A]**

## 4. Dependence on the commit subject

**[A]** In the no-description sensitivity arm, which uses the same inputs with an empty description, hybrid's test-stratum Recall@10 fell from **0.7642** to **0.2996** (95% interval 0.1791 to 0.4291). The paired difference is 0.4645 [0.3262, 0.6028]. MRR@20 fell from 0.3624 to 0.1347. The common population was all 50 commits, with the same 47-commit test stratum.

This indicates substantial dependence on information in the commit subject. The protocol names the cause as a limitation: the subject is written after the change and can name the files or features being predicted (section 7, "Subject leakage"). The arm does not remove all such leakage, because the input paths are still given as `changedPaths`, so 0.2996 is not a leakage-free floor. The arm is descriptive, uses a separate random generator, and plays no part in the decision, which it does not change.

## 5. Scope and other limitations

From protocol section 7, as they apply to the published result:

- **One repository.** All results are for `sindresorhus/got`, a JavaScript/TypeScript repository. They say nothing about other repositories or languages.
- **Co-change is a proxy, not ground truth.** Files changed in the same commit are a biased, incomplete subset of what a change affects. The results speak to retrieval of co-changed files, not to impact accuracy; the repository has no impact-level labels.
- **Selection.** Commits are single-parent, have between 1 and 10 change records, and have at least one source input and one test or documentation target.
- **Independence.** The ancestry check against the design cases is a safeguard, not proof that the repository is unrelated to them.
- **Classification.** Files are classified by fixed path rules with known gaps (for example, fixtures under `test/` count as tests).
- **Statistics.** Percentile intervals from at most 50 commits of one repository are approximate, and the commits are not independent draws.
- **Single run.** The registered rules were applied once and nothing was tuned.

## 6. What this note does not do

It does not change the frozen outcome, recompute any value, or add any analysis. It does not say how hybrid would compare with a working sibling heuristic or with no description in practice. Any such comparison would be a separate experiment that needs its own authorization, and would be a distinct run, not a continuation of this one.
