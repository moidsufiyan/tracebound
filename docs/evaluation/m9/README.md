# M9 — Evidence Freezing and Annotation Packages

Tooling and records that freeze one production retrieval run per case into verifiable artifacts for human annotation. It reads M1–M8 and changes none of them; the code is `src/evaluation/m9/` and is not exported from the package index.

| File | What it is |
|---|---|
| [`protocol-amendment-1.3.0.md`](protocol-amendment-1.3.0.md) | The decision to select candidates from production M6 rankings, the frozen table, and the run provenance |
| [`candidate-manifest.json`](candidate-manifest.json) | The same selection, machine-readable (identities, fused and eligible ranks, original run, superseded H2 list) |
| `provenance/` | The saved records of the original production run and of the H2 comparison, copied unchanged |

## Release layout (not in Git)

The release is written to `release/m9/<name>/`, which is git-ignored because it holds a 35 MB database and the source text of the candidates.

```
release-manifest.json        files, sizes, hashes, digests, database facts, run provenance
release-manifest.sha256      digest of the manifest payload (kept outside the payload)
candidate-manifest.json      the frozen selection, canonical form
database/tracebound-m9.sqlite
packages/<case>.evidence-package.json     complete M7 package (archival)
rankings/<case>.production-ranking.json   complete fused ranking with eligible ranks
review-packets/<case>.review-packet.json  blinded packet for annotators, with schema 1.1.0 records
superseded/                  packets and manifest replaced by a reconciliation (audit only)
```

## Commands

```
npm run build
# Needs a running Ollama with nomic-embed-text:v1.5 (query embeddings only); writes a NEW directory.
node scripts/m9-export.mjs --source <bench.sqlite> --out release/m9/<name>
# Offline: no Ollama, no model, no Git repository.
node scripts/m9-verify.mjs release/m9/<name> [--expect-manifest-digest <sha256>]
# Rebuild only the review packets of an existing release (database and evidence packages untouched), then re-run the gate.
node scripts/m9-reconcile.mjs release/m9/<name> --reason "<why>"
```

The export refuses to run unless the source database is the one the selection was frozen from, never writes to it (its hash is compared before and after), runs the production search once per case against the frozen copy opened read-only, and stops if any rank, identity or count differs from the candidate manifest.

## What the verifier checks

Manifest digest and `.sha256`; every listed file's size, file hash, canonical digest and canonical form; no absolute paths; the database's size, hash, schema version, journal mode, `integrity_check`, `foreign_key_check`, no sidecar files and per-table row digests; every frozen candidate's identity (snapshot, artifact, version, path, kind, content SHA-256, Git blob SHA) against the database, and the content text against its hash; each package's snapshot, K = 60, completeness, exclusion of the changed paths, evidence-id ownership and the frozen ranks; each ranking's consistency; each packet's derivation digests, three candidates, source hashes, evidence equal to the package's, annotation contract and per-candidate blank records equal to what the frozen identities produce (schema 1.1.0), and absence of leaked keys; and that each snapshot was committed before its cutoff.

It cannot establish authenticity (who produced the release), that evidence statements are true beyond what `constructEvidence` verified, or that the Git blob SHA matches the normalized content (the database stores normalized text, so the blob SHA is checked only as recorded).

## Distribution status

The release manifest records `distribution.status`. `applyReleaseGate` sets `RELEASED` only if the verifier passes the manifest as written, and `BLOCKED` (with the failed checks) otherwise; the verifier reports the recorded status but does not decide it.
