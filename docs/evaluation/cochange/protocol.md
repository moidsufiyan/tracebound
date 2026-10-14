# Co-Change Evaluation Protocol (pre-registered)

> **Version:** 1.0.0. Written and committed before any repository is selected, any manifest is produced or any result exists. Nothing in sections 2 to 6 may change once a manifest exists; a change needs a new protocol version and a new run. The clarifications made before any manifest existed (outcome precedence, interval conditions, the reference generator, the no-description sensitivity arm, the empty-directory sibling rule, the handling of failed runs) are part of 1.0.0 and change no threshold, seed, sample size or confirmatory comparison.

**Ordering of strings.** Wherever this protocol orders paths or other strings, it means JavaScript's UTF-16 code-unit order: strings are compared by the numeric value of their code units from the first, and a proper prefix sorts first (`a < b` on strings in JavaScript; no locale, case folding or normalization).

## 1. Question

When a developer changes source files, does Tracebound's investigation (hybrid retrieval, M6) surface the test and documentation files that the same commit also changed, better than simple baselines? This is measured on a repository that played no part in Tracebound's design.

**Co-change is a weak proxy for impact.** A test or document changed in the same commit was judged worth touching by the commit's author; it is not proof that the change affects it, and files that should have changed but did not are invisible. Results speak to retrieval of co-changed files, not to impact accuracy.

## 2. Repository

- One repository not represented in the nine design cases (`docs/evaluation/cases/`, repositories `moidsufiyan/wollyway` and `honojs/hono`) or in earlier development work. It is chosen by the developer before the selector runs, and its name and pinned full head SHA are recorded in the manifest.
- Independence is checked mechanically against the **whole history of the pinned head**: if any of the nine design-case commits (section 3) is an ancestor of the head, the selector refuses the repository (`not_independent`), whatever lower bound `since` is given. A design-case SHA the repository does not contain as a commit is skipped; any other Git failure stops the selector rather than counting as independence. Hono is never substituted.
- This check is a safeguard, not proof of independence: a repository that shares no commit with the design cases can still share their conventions, code (a vendored copy, a rewritten fork) or authors, and the developer's choice of repository remains the real independence decision.
- The repository must be a **full clone**. A shallow clone is refused (`ShallowRepositoryError`), because a truncated history cannot show that no design-case commit is an ancestor of the head and turns cut-off commits into apparent roots.
- The repository must be a JavaScript/TypeScript code base, matching the current implementation: ingestion treats `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs` as code, `.md`, `.mdx` and `.txt` as documents, and `.json`, `.yaml`, `.yml` as configuration (`src/ingestion/file-policy.ts`); the structural index parses imports only in `.ts`, `.tsx`, `.js` and `.jsx` files (`src/analysis/import-extraction.ts`). A repository in another language yields no eligible commit.
- History is the commits reachable from the pinned head, optionally bounded below by a pinned full-SHA ancestor (`since`, exclusive). `since` only limits which commits are candidates; it never limits the independence check. No refs, branch names or `HEAD` are accepted.

## 3. Commit selection

A commit is **eligible** when all of the following hold, checked in this order (the first failure is recorded as the reason):

1. It has exactly one parent (root and merge commits are excluded). The parent is the **base**.
2. It is not one of the nine design-case commits (an exact-SHA exclusion; it can matter only when a design-case commit is inside the considered range, and then the refusal of section 2 takes precedence, so no manifest is produced): `a0885a13d3d17eb6eeace9acb681b8b6c0e851a5`, `b80220d9c21a2a47a6c32ae1ad81eff3ec49bc9f`, `afb2068c1c53a530528ac5f237e245793dd03c07`, `c3053ccf14f1c4c70a0c2888eed6121b9f6c8f95`, `c91ec9b60df18c76a3feb47533ce097d02f7fe6c`, `cfd8793c89cfb29c5e885b6ac768e41d22f8927f`, `bb80f345c868e13a475f7f7a5ad3200dd593e604`, `6d73a74f9757ed65d6103c0e8375097fa20873c4`, `5e5b83d6ed963a2bc7d8384002e1c953648253b1`.
3. Its diff against the base (`git diff-tree -r -M`, Git's default 50% rename similarity) has between 1 and **10 change records**; a rename is one record.
4. It has at least one **input** and at least one **target** (below).

**Usable in the base snapshot.** A path is usable when it exists in the base commit's tree and the ingestion file policy (`classifyTreeEntry`: no symlink, submodule, generated path, unsupported extension or oversized file) includes it. Content checks the policy applies only when reading a blob (binary, not UTF-8) are not applied by the selector; a target later excluded on those grounds is reported, not dropped.

**Classification** of a usable path, fixed before selection:
- **test**: kind `code` and either B1's heuristic (`.test.` or `.spec.` in the path, `isTestPath`) or a directory segment equal to `test`, `tests` or `__tests__`;
- **doc**: kind `document` (`.md`, `.mdx`, `.txt`), except release bookkeeping, which is **ignored**: a base name starting with `CHANGELOG`, `CHANGES` or `HISTORY` (case-insensitive), or a path under `.changeset/`;
- **source**: kind `code` and not a test;
- **ignored**: everything else (configuration files, ignored documents).

**Which side of a change counts.** For a modified, deleted or type-changed file the path is its base path. For a rename it is the **base-side (old) path**. An added file does not exist in the base, so it is never an input or a target.

- **Inputs**: changed source paths usable in the base.
- **Targets**: changed test and doc paths usable in the base. Deleted test and doc files count; added ones do not.
- Inputs and targets are disjoint by construction, and the selector asserts it.
- Change records are stored sorted by head-side path, then base-side path, in code-unit order, independent of the order Git prints them in.

**Known classification gaps** (consequences of the fixed rules above, not corrected for): type tests (`x.test-d.ts`), end-to-end files (`x.e2e.ts`), and code under `spec/` or `__mocks__/` without a `.test.`/`.spec.` marker are classified as **source**, so they can become inputs; fixtures and helpers under `test/`, `tests/` or `__tests__/` are classified as **tests**, so they can become targets; any `.txt` or `.md` file outside the bookkeeping exclusions, such as `requirements.txt`, issue or pull-request templates and READMEs, is a **doc**.

**Description**: the commit subject exactly as Git's `%s` gives it (the first paragraph of the message, line breaks joined by spaces).

**Sample size**: target **50**, minimum **30**. Eligible commits are ordered chronologically by committer timestamp, ties broken by full SHA. With fewer than 30 eligible commits the selector stops (`insufficient`) and the evaluation does not run; the rules are not relaxed. With 30 to 50, all are used. With n > 50, the commits at positions `floor(i × n / 50)` for i = 0..49 are taken (even spacing from the oldest; position 0, the oldest eligible commit, is always taken, and the newest is never taken when n > 50). Selection never looks at retrieval or any outcome.

## 4. Running the methods

Each selected commit is evaluated in a snapshot of its base, ingested and indexed with the production code (lexical, structural, semantic with `nomic-embed-text:v1.5`). No reasoning model is used. The query is the description, the input paths as `changedPaths`, and no symbols. Each method returns a ranked list; the input paths are removed from it (exact path equality, order kept) and the first **20** remaining entries are scored. Targets are never inputs, so they are never removed.

- **Hybrid**: `searchHybridDetailed(...).fused`, the ranking the investigation report uses.
- **Deterministic only**: the `deterministic` ranking of the same run (lexical and structural, M4).
- **Semantic only**: the `semantic` ranking of the same run (M5).
- **No-description hybrid arm** (sensitivity only): hybrid run on the same commit, the same inputs as `changedPaths`, the same base snapshot, indexes and retrieval configuration, with the description set to the empty string. Everything else in this section applies unchanged (input removal, first 20 entries). It is a descriptive arm, not a baseline: it takes no part in any decision rule (section 6) and never triggers tuning, a rerun or a change of method. If the production query refuses an empty description, the arm is reported as not run with the error, and no substitute text is used.
- **Sibling-test heuristic**, defined here and not tuned. For each input `d/s.e` (directory `d`, empty for a file in the repository root; stem `s` = base name before its last extension), the candidates are the usable **test** paths of the base snapshot (section 3 classification) that match:
  - **tier 1**: directory exactly `d`, base name starting with `s.test.` or `s.spec.`;
  - **tier 2**: directory exactly `d/__tests__` (exactly `__tests__` when `d` is empty), base name starting with `s.`;
  - **tier 3**: any directory, base name starting with `s.test.` or `s.spec.`; when `s` is `index` and `d` is not empty, a base name starting with `n.test.` or `n.spec.`, where `n` is the last segment of `d`, also matches at tier 3.

  The literal stem `s` is used at all three tiers, including `index` (so `src/foo/index.ts` matches `src/foo/index.test.ts` at tier 1); the directory-name match for `index` is an additional tier-3 rule. A path matching at several tiers or for several inputs keeps its best (lowest) tier and, within it, the earliest input. Candidates are ordered by (tier, input position in the sorted input list, path in UTF-16 code-unit order) and cut at 20. Prefix comparisons are case-sensitive. The heuristic proposes only tests, so it never finds doc targets.

The structural-link stratum is computed from the structural index of the base snapshot: a target has a link when an `imports` or `test-to-source` relationship joins it to any input in either direction.

## 5. Metrics

- Per commit and per stratum: **Recall@K** for K = 3, 5, 10, 20 (targets of the stratum found in the first K, divided by the stratum's targets) and **MRR@20** (1 / rank of the first target found in the first 20, else 0).
- **Macro averages over commits**, counting only commits with at least one target in the stratum.
- **Strata**: test targets (primary), doc targets, and test targets with and without a structural link.
- **Primary outcome**: macro Recall@10 over test targets.
- **Uncertainty**: a paired percentile bootstrap over commits, specified exactly so that it has no free choices:
  - **Generator**: Mulberry32 seeded once with **20261014**. The reference algorithm, in JavaScript; the state `a` is an unsigned 32-bit integer, intermediate values are reduced by JavaScript's 32-bit operators, and only the final `>>> 0` makes the output unsigned:
    ```js
    function mulberry32(seed) {
      let a = seed >>> 0;
      return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    ```
    The constants are `0x6D2B79F5` (the state increment), shifts 15, 7 and 14, the OR constants 1 and 61, and the divisor 2^32 = 4294967296. Each call returns u = (unsigned 32-bit output) / 2^32, so u is in [0, 1) and never 1. The first three values for seed 20261014 are 0.19576451717875898, 0.89535868098028 and 0.07554438407532871. Two generator instances are used, both created with this seed and algorithm and each never reseeded: the **main generator**, created before the first main stratum, for the bootstrap of the methods of section 6 (this section's Resampling rule); and the **sensitivity generator**, created before the first sensitivity stratum, for the no-description comparison only (Sensitivity bootstrap below). Keeping them apart makes the sensitivity draws independent of the main strata sizes and of any failure, and leaves the main draws exactly as they would be without the arm.
  - **Replicates**: B = **10,000**. Each stratum is bootstrapped separately, in the fixed order primary test stratum, doc stratum, test-with-link, test-without-link, each consuming the main generator from where the previous stratum stopped (exactly B × m values for a stratum of m commits). A stratum with no commits consumes nothing.
  - **Resampling**: for a stratum, let the population be its m commits (those contributing at least one target to it), listed in manifest order. Replicate r = 0..B−1 draws m indices with replacement, index = floor(u × m), one fresh u per draw, in order. The draws of a replicate are made once per stratum and **shared by every method, every metric (Recall@3, 5, 10, 20 and MRR@20) and every paired difference** of that stratum, so all comparisons of the methods of section 6 are paired. The no-description arm does not use these draws. A replicate's statistic is the mean over the drawn commits (duplicates counted as drawn) of the per-commit value of the method (or of the paired difference) for that metric. The point estimate reported beside an interval is the macro average over the population itself, not a bootstrap statistic.
  - **Failed runs**: a failure of any method on a commit (ingestion, indexing, embedding or retrieval error) is recorded with its error and is never retried, replaced or dropped. If hybrid, deterministic-only or semantic-only fails on any selected commit, the evaluation is incomplete and its outcome is Inconclusive (section 6, rule 1); the completed commits are reported descriptively. The no-description arm may fail on some commits without that effect, and its failures are never retried, replaced or dropped from the failure record.
  - **Sensitivity bootstrap** (no-description arm; descriptive). Let **C** be the selected commits with a valid result from both ordinary hybrid and the no-description arm (a result is valid when the method ran to completion on the commit, without error); the size |C|, the number of commits where ordinary hybrid failed and the number where the no-description arm failed, each failed commit with its error, are reported with the results. For each stratum s in the order of the main bootstrap (primary test, doc, test-with-link, test-without-link), the **common population** C_s is the commits of C that contribute at least one target to s, in manifest order, and m_s = |C_s|. If m_s = 0, or the arm was not run (empty description refused), the stratum's sensitivity results are reported as **unavailable** and no metric is computed or imputed; it consumes nothing from the sensitivity generator. Otherwise, replicate r = 0..B−1 draws **exactly m_s** indices with replacement from C_s, index = floor(u × m_s) with one fresh u per draw from the sensitivity generator, B = 10,000, so the stratum consumes exactly B × m_s values and strata follow one another on the same stream. A replicate never skips a draw and never has another size. In each replicate the resampled commits are the **same identities** for ordinary hybrid and the no-description arm, for every metric (Recall@3, 5, 10, 20 and MRR@20): each statistic is the mean over the m_s drawn commits (duplicates counted) of that arm's per-commit value, and the paired difference (ordinary hybrid minus the arm) is the mean of the per-commit differences over the same draws. The point estimate beside an interval is the macro average over C_s. Intervals follow the Intervals rule below with all B replicates present.
  - **Intervals**: for each statistic, sort its B replicate values ascending (numeric order) as v[0..B−1] (B = 10,000) and take percentile p at position x = (B − 1) × p (zero-based) by linear interpolation: with k = floor(x) and f = x − k, the value is v[k] + f × (v[k+1] − v[k]) (v[k] when f = 0). The 95% interval is the values at p = 0.025 (lower endpoint) and p = 0.975 (upper endpoint).
- **Interval conditions** (used by every rule in section 6): an interval is **strictly above zero** only when its lower endpoint is greater than zero; it is **strictly below zero** only when its upper endpoint is less than zero. An endpoint equal to zero satisfies neither. An interval that contains zero (lower endpoint ≤ 0 ≤ upper endpoint) establishes no directional difference.
- **Confirmatory and exploratory comparisons**: hybrid versus the sibling heuristic on the primary outcome is the **sole confirmatory comparison**. Hybrid versus the deterministic-only and semantic-only rankings are **exploratory**: they use the same unadjusted 95% intervals (no multiplicity adjustment), make no independent claim, and can only downgrade the outcome (section 6), never establish support. Strata, the no-description arm and the other metrics are descriptive.
- **No-description sensitivity report**: for the primary stratum and each other stratum, report the no-description arm's metrics and the paired per-commit differences (ordinary hybrid minus no-description arm) with the sensitivity bootstrap above, on the common population of each stratum. Ordinary hybrid's values in this report are those on the common population, so they can differ from its main-bootstrap values when the arm failed on some commits; both are reported and labelled. This is descriptive and changes no outcome.

## 6. Decision rules (fixed before results)

Let D(X) = macro Recall@10 on test targets of hybrid minus method X, as observed on the selected commits (the point estimate), with its paired 95% interval (section 5). Interval conditions are those of section 5: "above 0" means strictly above zero (lower endpoint > 0) and "below 0" means strictly below zero (upper endpoint < 0); an interval containing zero establishes no direction.

**Precedence.** The rules are applied in this order and the first that applies decides the outcome:
1. **Inconclusive (incomplete run or minimum test targets)**: hybrid, deterministic-only or semantic-only failed on a selected commit (section 5, failed runs), or fewer than 20 selected commits contribute at least one test target (the size of the primary stratum is below 20). This overrides every other rule, whatever the intervals show.
2. **Negative**, 3. **Supported**, 4. **Mixed**, 5. **Inconclusive (otherwise)**, as defined below. Negative, Supported and Mixed are mutually exclusive by construction, so the order among them does not change any result.

| Outcome | Rule |
|---|---|
| **Supported** | D(sibling) ≥ 0.10 with the interval above 0, and neither single-source baseline outperforms hybrid materially. |
| **Mixed** | Hybrid beats sibling (D(sibling)'s interval above 0) but D(sibling) < 0.10; or D(sibling) ≥ 0.10 with the interval above 0 while a single-source baseline outperforms hybrid materially. |
| **Negative** | The sibling heuristic outperforms hybrid materially; or a single-source baseline does so while hybrid does not beat sibling (D(sibling)'s interval is not above 0). |
| **Inconclusive** | Rule 1 above, or none of the other rules applies. |

*Hybrid beats sibling*: the interval of D(sibling) is strictly above 0. *Materially outperforms*: for a method X (the sibling heuristic or a single-source baseline), D(X) ≤ −0.05 (X's macro Recall@10 exceeds hybrid's by at least 0.05) and the interval of D(X) is strictly below 0. The no-description arm is not a baseline and appears in no rule. A negative outcome means the current hybrid approach shows insufficient evidence of differentiation over a trivial heuristic on this repository. Secondary metrics and strata are reported descriptively and never change the outcome. The run is done once; nothing is tuned or rerun with changed rules within this milestone.

## 7. Limitations

- **Label validity**: co-change is a weak, incomplete proxy; tests and docs updated in a commit are a biased subset of what the change touches.
- **Selection bias**: commits with tests or docs, of at most 10 records, single-parent, in one repository; squash-merge or monorepo workflows behave differently.
- **Independence**: the ancestry check (section 2) only rules out shared commits; it cannot show that the repository is unrelated to the design cases. One repository; its conventions (test layout, doc habits) shape all methods, the sibling heuristic most.
- **Subject leakage**: the description is the real commit subject, written after the change, and it can name the very files or features being predicted (for example "fix router tests" or "update docs/api.md"). This favours the semantic and hybrid rankings over the sibling heuristic, which ignores the description. The subject is not redacted, because any redaction rule would be a tuned choice; results must be read with this advantage in mind. The no-description hybrid arm (section 4) measures how sensitive hybrid is to the description; it does not remove all query-label leakage: the input paths are still given as `changedPaths`, and files that co-change with them in a commit are often named alike or sit nearby, so the query can still point at the targets. The arm is descriptive and decides nothing.
- **Classification gaps**: the fixed rules of section 3 misclassify some files (type tests, `.e2e.` files, `spec/` and `__mocks__/` code as source; fixtures under `test/` as tests; `requirements.txt` and issue or pull-request templates as docs). They are kept so that selection stays mechanical; their effect depends on the chosen repository's layout.
- **Language and clone**: the evaluation applies only to a JavaScript/TypeScript repository available as a full, non-shallow clone (section 2); results say nothing about other languages.
- **Inputs**: added source files are not inputs (they do not exist in the base); a commit that mainly adds code is represented only by what it modified.
- **Indexing cost**: up to 50 base snapshots are ingested and embedded locally; content-addressed embeddings are shared across snapshots, but the total time is not known in advance.
- **Bootstrap**: percentile intervals from at most 50 commits are approximate; commits of one repository are not independent draws.

## 8. Artifacts

The selector (`src/evaluation/cochange/`) writes a manifest serialized as RFC 8785 canonical JSON: repository name, pinned head (and `since`), the rules above (including the independence and change-order rules), the design-case exclusions, rejection counts and, per selected commit, its SHA, base SHA, subject, change records (sorted as in section 3), inputs and targets. The selector refuses a shallow repository and returns `not_independent`, without a manifest, when a design-case commit is an ancestor of the head. It contains no timestamps or machine paths, and the same inputs give the same bytes. No manifest, database or result is produced until this protocol and the selector are reviewed and committed.
