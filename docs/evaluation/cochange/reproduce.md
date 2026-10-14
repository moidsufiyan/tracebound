# Reproducing the co-change manifest

`manifest.json` is the frozen held-out dataset of the co-change evaluation (protocol 1.0.0, [protocol.md](protocol.md)). It was produced by the deterministic selector alone; no snapshot, index, database, embedding or model was involved.

## Pinned input

| | |
|---|---|
| Repository | `sindresorhus/got`, `https://github.com/sindresorhus/got.git` |
| Head | `05b4476913da39a47dd8e20d29e250f28b0a6dca` (commit "16.1.0", committed 2026-10-13) |
| Lower bound | none: the whole history of the head |
| Manifest | 46,373 bytes, SHA-256 `d179d992f28b201b558e9c5c97db3e9b0ac39f18544b2463d73f317b865eb361` |
| Counts | 1,788 reachable, 603 eligible, 50 selected; rejected: root 1, merge 73, design_case 0, too_many_changes 94, no_changes 0, no_source_input 782, no_target 235 |

## Steps

1. Build Tracebound at the commit that holds this manifest: `npm ci && npm run build`. The runner uses `dist/` as it is and never rebuilds.
2. Make a **full, non-shallow** clone outside this repository (a shallow clone is refused). A checkout is not needed:

   ```sh
   git clone --no-checkout https://github.com/sindresorhus/got.git <clone>
   ```

3. Run the selector, writing to a new file (an existing file is never overwritten):

   ```sh
   node scripts/evaluation/cochange/select.mjs --repo <clone> --name sindresorhus/got --head 05b4476913da39a47dd8e20d29e250f28b0a6dca --out <new file>
   ```

   It prints the counts, the byte size and the SHA-256 of what it wrote. Selection reads about 1,800 commits through Git and takes a few minutes.

4. Compare the bytes with the committed manifest, for example `cmp <new file> docs/evaluation/cochange/manifest.json`, or compare the SHA-256 above. The manifest is RFC 8785 canonical JSON on a single line with no trailing newline; it records neither the clone path nor any timestamp, so any clone of the pinned head gives the same bytes.

The pinned head must still be fetchable from the remote; if it ever is not, the manifest stays the record of the dataset and the selection cannot be repeated from that remote.

## Notes on the selection

- **Rejection precedence.** The protocol fixes the order of the eligibility checks but not which of "no source input" and "no target" is recorded when a commit has neither. The selector checks `no_source_input` first. This is an implementation detail: it changes only how those two rejection counts split, never which commits are eligible.
- **Classification limitations seen in the sample.** The frozen rules (protocol section 3) classify by path only, and inspecting the selected commits showed where they misjudge got's layout. The rules are not changed because of these observations.
  - got's early history (2014) keeps its tests in a root-level `test.js`. Having no `.test.`/`.spec.` marker and no test directory, it is classified as **source**, so it is an input of the oldest selected commit (`2112168…`) rather than a target.
  - JavaScript examples under `documentation/examples/` (for example `advanced-creation.js`) are code outside a test directory and so are classified as **source** inputs.
  - The other gaps the protocol lists (type tests, `.e2e.` files, `spec/` and `__mocks__/` code as source; fixtures under `test/` as tests) apply as well wherever such paths occur.
