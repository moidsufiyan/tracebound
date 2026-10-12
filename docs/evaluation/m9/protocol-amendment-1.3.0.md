# Protocol Amendment 1.3.0 — Production M6 Candidate Selection

> **Status:** Adopted by the evaluation owner for the Phase 1 annotation pilot.
> **Amends:** evaluation protocol v1.2.0 as named by the evaluation owner. The text of v1.2.0 is not stored in this repository, so this amendment states what it changes and nothing else; it must be reconciled with v1.2.0 where that document lives.
> **Machine-readable record:** [`candidate-manifest.json`](candidate-manifest.json).

## Decision

The pilot's candidates are the **production M6 hybrid ranking** (`searchHybridDetailed`, Reciprocal Rank Fusion with K = 60 over the complete deterministic and semantic rankings), taken per case after removing the case's changed paths. Three candidates per case are annotated: the three best *eligible* ranks.

This **supersedes the H2-derived selection**, which came from the research script's ranking. That selection is **preserved unchanged** in the candidate manifest (`historicalSelection`) as historical context. It is not authoritative and the production system does not reproduce it.

## Selection rule

| Item | Value |
|---|---|
| Selection source | production M6 `searchHybridDetailed` |
| RRF constant | K = 60 |
| Candidates per case | 3 |
| Changed-path policy | A candidate whose Git repository path is exactly equal (string equality, no normalization, no case folding) to a changed path of the case is **ineligible**. The production API excludes nothing; this exclusion is the evaluation's own, applied at the evaluation boundary. |
| Fused rank | the candidate's position in the complete production ranking, unchanged |
| Eligible rank | the candidate's position once the ineligible candidates are removed; the three lowest eligible ranks are selected |
| Ties | as production: score, deterministic category, path (code units), artifact id |

## Frozen selection

Ranks are those of the production M6 run recorded in `provenance/m6-verification-run.json` and reproduced by the new evidence-generation run (below). Ids are rows of the frozen database (see *Identity scope*).

| Case | Snapshot (base commit) | # | Candidate | Fused | Eligible | Artifact / Version |
|---|---|---|---|---|---|---|
| TB-0001 | 1 `bc84e844…` | 1 | `backend/docs/cart-checkout-contract.md` | 2 | 1 | 49 / 49 |
| | | 2 | `CHECKOUT_STATE_MACHINE.md` | 3 | 2 | 3 / 3 |
| | | 3 | `backend/src/routes/inventory.routes.ts` | 4 | 3 | 121 / 121 |
| TB-0004 | 4 `c437d756…` | 1 | `src/middleware/etag/index.test.ts` | 1 | 1 | 727 / 1587 |
| | | 2 | `src/middleware/compress/index.test.ts` | 3 | 2 | 717 / 1577 |
| | | 3 | `src/middleware/secure-headers/index.test.ts` | 4 | 3 | 756 / 1616 |
| TB-0008 | 8 `deff5296…` | 1 | `src/context.ts` | 1 | 1 | 611 / 3093 |
| | | 2 | `.github/pull_request_template.md` | 3 | 2 | 325 / 2807 |
| | | 3 | `src/utils/headers.ts` | 4 | 3 | 828 / 3310 |
| TB-0009 | 9 `241ae4c7…` | 1 | `src/utils/stream.test.ts` | 1 | 1 | 844 / 3773 |
| | | 2 | `src/helper/streaming/stream.ts` | 3 | 2 | 647 / 3576 |
| | | 3 | `src/helper/streaming/stream.test.ts` | 4 | 3 | 646 / 3575 |

The changed file sits at fused rank 1 (and the second changed file at 15) in TB-0001, and at fused rank 2 in TB-0004, TB-0008 and TB-0009; that is why fused ranks skip a value. Content SHA-256 and Git blob SHA of every candidate are in the manifest.

## Run identity and provenance

- **Original run** (selection): a production M6 verification run on a disposable backup copy of `bench.sqlite`, with `ollama:nomic-embed-text:v1.5@0a109f422b47` (weights digest `0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f…`). Two production runs gave identical rank order and bitwise-identical semantic scores. That record held only the top candidates, so it could not feed evidence construction.
- **Evidence-generation run** (this amendment's archival packages): a **new** run of the same production code, once per case, against the frozen database opened read-only, with the same query construction and the same installed model. It is recorded as a new run (`runKind: new-evidence-generation-run`, with its own run id and time) and is **not** the original run relabelled. Its ranks, candidate identities and ranked-candidate counts were checked against the frozen selection before anything was written; any difference stops the export.
- The disposable copy used by the original run and the frozen database hold the same rows in all 17 tables (per-table digests are recorded in the release manifest); their bytes differ only in file layout.

## Evidence packages

One complete M7 package per case, built by `constructEvidence` from the same production run that produced the ranking, with the normal limit (20 candidates after removing the changed paths). It is not cut down to the three annotated candidates. A separate production-ranking record holds the complete fused ranking with eligible ranks.

## Identity scope

Artifact ids, version ids and the M7 evidence ids that embed them are SQLite row ids. They are **database-scoped**: valid in the frozen database of this release and meaningless in another database populated separately. Content SHA-256 and Git blob SHA identify content across databases; row ids do not.

## Canonical form and digests

Artifacts are JSON, serialized with the RFC 8785 JSON Canonicalization Scheme (`canonicalize` 5.1.0) and identified by the SHA-256 of those bytes. A digest never appears inside the payload it covers: the release manifest lists each artifact's digest, a review packet records the digests of the package and the candidate manifest it derives from, and the release manifest's own digest is stored beside it in `release-manifest.sha256`. Times are UTC with milliseconds; paths are repository-relative POSIX paths exactly as in Git's tree; no absolute or machine-specific path appears in any artifact.

`committed_at` (the Git commit time) and `recorded_at` (when Tracebound ingested the snapshot) are different facts and are both kept; neither is the evaluation cutoff, which comes from the case file. Every snapshot's commit time precedes its case's cutoff.

## Reviewer packets

Each packet holds the change description, changed paths, evaluation cutoff, base commit, exactly three candidates with their source text (checked against the recorded content hash) and exactly the M7 evidence of those candidates with its ids, and one blank annotation record per candidate in annotation schema 1.1.0 (below). It holds no M8 output, no reasoning-model identity, no relevance label and no candidate other than the three. The M7 evidence itself names the *embedding* model in its semantic items; that is retrieval evidence, unchanged.

## Annotation schema 1.1.0

The record format is versioned separately from this protocol (`schema_version: "1.1.0"`, `annotation_phase: "phase_1_blinded_evidence_judgment"`). Each annotator (`REV-01` or `REV-02`) completes one record per candidate: `annotator_id`, `annotated_at` (UTC, `YYYY-MM-DDTHH:MM:SSZ`) and an `evaluation_record` with the candidate's identity (case id, path, artifact id, version id, content SHA-256 — pre-populated from the frozen manifest), a `reference_assessment` (`classification`, `primary_rationale`, `cited_evidence_ids`, `evidence_sufficiency` of `fully_sufficient`/`partially_sufficient`/`completely_inadequate`, `perceived_ambiguity` with `has_contract_ambiguity` and `ambiguity_explanation`, `unresolved_uncertainty`) and a `blinding_verification` of three booleans (`reviewed_diffs_or_hindsight`, `reviewed_other_annotator`, `reviewed_model_outputs`). The packet carries the blank record for each of its three candidates; the judgments are empty and no blinding violation is claimed.

A completed record is valid only if it cites evidence ids of its own candidate and all three blinding booleans are `false`; a record that claims otherwise is not an independent blinded judgment and is excluded (`validateCompletedAnnotation`). Two annotators judge independently; neither sees the other's record, earlier annotations or any M8 output before their initial assessment is sealed. These are rules of the process; the packet and verifier cannot enforce them.

The contract was reconciled field by field against the schema supplied by the evaluation owner for this step; the v1.2.0 protocol text is still not in this repository.

## Limits

A hash shows integrity (these are the recorded bytes), not authenticity (who recorded them). Rankings and evidence say why a file was retrieved, not that it is impacted, and no impact-level labels exist, so nothing here measures classification accuracy. The selection is a pilot sample of three per case from four cases, not a benchmark result.
