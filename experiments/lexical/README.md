# B2 Lexical Retrieval Baseline Experiment

## Purpose
This experiment tests the ability of a deterministic Lexical Retrieval system (B2) to find investigation-worthy candidate artifacts based purely on the text of the source change (description, filenames, and modified symbols).

## Constraints Adherence
- **No AI:** Uses strict token normalization and `git grep`.
- **Temporal Boundary:** Searches the source repository strictly at `base_commit`. It does not rely on the current working tree state.
- **Candidate Exclusions:** Automatically ignores retrieving the exact files that were modified by the change (unless explicitly listed as ground-truth candidates in the evaluation cases), avoiding artificial metric inflation.

## Query Construction
The script parses the YAML case and constructs a search query based on:
1. `source_change.description`
2. `changed_artifacts[].path`
3. `changed_artifacts[].symbols[].name`

**Normalization Rules:**
- CamelCase and snake_case strings are split into distinct tokens.
- All tokens are lowercased.
- Non-alphanumeric characters are stripped.
- Common generic stop-words (and, or, the, a, etc.) and file extensions (ts, md) are filtered out.
- Tokens less than 3 characters are discarded (unless explicitly provided as a symbol name).

## Retrieval
- Content match: `git grep -l -i "<token>" <base_commit>`
- Path match: `git ls-tree -r --name-only <base_commit>` filtered by the token.

## Usage
1. `cd experiments/lexical`
2. `npm install`
3. `node index.js`

Outputs are saved in the `outputs/` directory.
