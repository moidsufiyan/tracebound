# ADR: Hybrid Retrieval (H2 Reciprocal Rank Fusion)

**Decision:** Fuse the deterministic ranking (lexical and structural signals, M4) and the semantic ranking (M5) with Reciprocal Rank Fusion, K = 60, on demand, over the artifact versions of one explicitly supplied ready snapshot. This implements the approved H2 design from the [retrieval ADR](retrieval.md); the formula, the constant and the absence of a reranker are unchanged.
**Context:** The Phase 1 H2 run (`experiments/hybrid/index.js`, audited in `docs/evaluation/hybrid-independent-audit.md`) fused the complete B6 and B7.1 rankings with `score = 1/(60 + detRank) + 1/(60 + semRank)`, a missing ranking contributing 0. Reading the code rather than the audit shows the details production has to settle:
- Ties were broken by the leading digit of the deterministic tier (B6 tier 1 to 7, no tier = 99), then by `localeCompare` on the path. The deterministic *rank* was not a tie-breaker.
- Its inputs were asymmetric: the deterministic ranking had the changed files removed (unless labelled), while B7's semantic ranking ranked every artifact, changed files included.
- Candidates were merged by path.
**Chosen approach:**
- **Fusion** (`src/retrieval/rrf.ts`): `fuseRrf(deterministic, semantic, { k? })` is pure. It reads no database and removes nothing. K defaults to 60 and must be a positive integer (`RangeError` otherwise). Both rankings are used whole. The result is the union, merged by `versionId`, each candidate carrying `rank` (1-based, consecutive), `artifactId`, `versionId`, `path`, `kind`, `rrfScore`, `deterministicRank`, `semanticRank` and `deterministicCategory` (null when the deterministic ranking did not find it). Scores are computed on demand, deterministic term first, as H2 summed them; nothing is persisted.
- **Order:** score descending; then deterministic category precedence (the seven B6 categories, candidates the deterministic ranking did not find last); then path in UTF-16 code unit order; then `artifactId`. The deterministic rank is deliberately not a tie-breaker. Equal scores arise when two candidates swap their ranks across the lists, so the category is what separates them.
- **Validation** (`InconsistentCandidateError`): ranks must be positive integers in strictly increasing order (gaps are allowed, since a rank is a fact the caller gives); no version or path may repeat within a list; a version in both lists must have the same artifact, path and kind; one path or artifact must not stand for different versions across the lists.
- **Orchestration** (`src/retrieval/hybrid-search.ts`): `searchHybrid(db, snapshotId, provider, { description, changedPaths, symbols? })` requires a ready snapshot and the lexical index, the structural index and the semantic index for the provider's model, using the existing `requireReadySnapshot` and `isSnapshot…Indexed` checks. A missing index fails with its existing error (`LexicalIndexNotBuiltError`, `StructuralIndexNotBuiltError`, `SemanticIndexNotBuiltError`, `SemanticIndexIncompatibleError`) before any provider call. It then runs both pipelines and fuses them. The query maps as the research built it: lexical text is the description followed by the changed files' base names, with the symbols as explicit identifiers and the changed paths as structural seeds; the semantic query is the description and the changed paths.
- **Changed files:** the production API removes nothing, so the changed files are ordinary candidates. Callers filter the result themselves.
**Differences from H2, and why:**
- *Inputs are M4 and M5, not B6 and B7.1*, so fused ranks are not expected to equal H2's.
- *Merge by `versionId`, not path*, validated against path and artifact identity, because versions identify artifacts within a snapshot.
- *Path ties in code-unit order*, not `localeCompare`, so the order does not depend on the host locale; an `artifactId` fallback is added (unreachable for valid input, since paths are unique within a snapshot).
- *Semantic universe:* M5 ranks every ingested artifact, so the fused universe is that snapshot's artifacts (317 to 541 in the benchmark).
**Benchmark** (`test/benchmark/hybrid-benchmark.test.ts`, real Ollama; base-commit snapshots; historical protocol: deterministic list with the changed files removed and renumbered, semantic list unfiltered). Recall over the 7 positive cases at K = 1, 3, 5, 10, 20:

| Ranking | Top-1 | Top-3 | Top-5 | Top-10 | Top-20 |
|---|---|---|---|---|---|
| Deterministic (M4) | 2 | 3 | 3 | 4 | 6 |
| Semantic (M5) | 0 | 4 | 4 | 4 | 7 |
| **Hybrid (RRF)** | **2** | **3** | **4** | **6** | **7** |
| Historical H2 | 3 | 5 | 6 | 7 | 7 |

| Case | Deterministic | Semantic | Hybrid | Hybrid, changed files removed from both | Production API, nothing removed | Historical H2 |
|---|---|---|---|---|---|---|
| TB-0001 | 7 | 13 | 6 | 6 | 7 | 6 |
| TB-0002 | 35 | 2 | 4 | 4 | 4 | 1 |
| TB-0003 | 1 | 2 | 1 | 1 | 1 | 1 |
| TB-0004 | 1 | 2 | 1 | 1 | 1 | 1 |
| TB-0005 | 2 | 3 | 2 | 2 | 3 | 2 |
| TB-0006 | 20 | 18 | 15 | 14 | 16 | 5 |
| TB-0007 | 11 | 13 | 9 | 9 | 10 | 8 |
| TB-0009 (negative) | 3 | 3 | 2 | 2 | 3 | 1 |

- Hybrid is at least as good as the better of its two inputs for 6 of the 7 positives (TB-0002 is the exception: 4 against semantic's 2), puts every labelled candidate in the top 20, and puts 6 of 7 in the top 10 where deterministic and semantic retrieval alone put 4.
- The deterministic rank of TB-0002 is 35 (B6: 1) because M4 resolves `.js` imports and ranks 34 importers above the documentation; semantic retrieval (2) brings it to 4.
- TB-0006 and TB-0007 stay retrievable but rank lower than in H2 (15 and 9 against 5 and 8): the chunked semantic ranking places them at 18 and 13 where B7.1 had 9 and 5 (see the semantic ADR).
- TB-0009: the negative is found by both modalities (3 and 3) and fused to 2: the consensus false positive remains, as documented in the audit, and RRF does not suppress it.
- Removing the changed files from both lists moves a labelled rank by at most one, and so does leaving them in, as the production API does.
**Tradeoffs:**
- *Pros:* parameter-free, stateless, auditable (both input ranks and the fused score are exposed), no schema, no new dependency.
- *Cons:* it can only reorder what the two pipelines find, so it inherits their weaknesses (TB-0009's consensus false positive; M5's chunked ranks); it needs all three indexes and an embedding provider at query time; fusing the full lists costs a sort of every artifact of the snapshot.
