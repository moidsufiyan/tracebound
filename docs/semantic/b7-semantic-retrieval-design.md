# B7 Semantic Retrieval Design

## Problem being tested

The deterministic baselines (B1-B6) have reached a verifiable theoretical ceiling on the Tracebound evaluation dataset. Specifically, they fail to bridge the **Lexical Abstraction Gap**. 
When a historical change modifies implementation logic, the most highly relevant investigation-worthy artifacts (like architectural documentation or cross-domain frontend mappings) often use domain-level conceptual vocabulary rather than the exact strings modified in the code. Furthermore, relying on explicit Git metadata (like `#123` issue tagging) proved too brittle for general discovery.

The core hypothesis B7 will test is:
> Can semantic retrieval (using dense vector embeddings) bridge the Lexical Abstraction Gap and recover relevant artifacts that the deterministic baseline misses or ranks poorly, without introducing unmanageable false-positive noise?

## Candidate Models

We researched three primary families of embedding models suitable for code and technical text.

### 1. OpenAI (text-embedding-3 series)
*   **text-embedding-3-small**: 8,191 token context limit, default 1536 dimensions (adjustable). Very low cost ($0.02/1M tokens). Excellent baseline for general text/code mix.
*   **text-embedding-3-large**: 8,191 token context limit, default 3072 dimensions (adjustable). Higher cost ($0.13/1M tokens). Better precision on nuanced domain concepts.
*   *Suitability*: Highly reliable cloud APIs. Matryoshka learning allows for dimension truncation without re-embedding. Strong general retrieval orientation.

### 2. Voyage AI (voyage-code-4)
*   **voyage-code-4**: 32,000 token context limit, default 1024 dimensions (adjustable). Cost: $0.12/1M tokens.
*   *Suitability*: Purpose-built specifically for agentic coding and code retrieval. Dramatically outperforms generalist models on code-specific benchmarks. The large context window allows for embedding entire large source files without chunking.

### 3. Open-Source/Self-Hosted (Nomic Embed Text v1.5)
*   **nomic-embed-text-v1.5**: 8,192 token context limit, variable dimensions (up to 768). Cost: Free (Apache 2.0 license) + compute overhead.
*   *Suitability*: Easily self-hosted via Ollama. Lightweight (137M parameters). Excellent choice if data privacy strictly prevents using cloud APIs.

**Recommended Comparison Array:**
We recommend comparing exactly three models to capture the cost/quality/privacy frontier:
1.  **text-embedding-3-small** (The low-cost, generalist baseline)
2.  **voyage-code-4** (The high-end, code-specific champion)
3.  **nomic-embed-text-v1.5** (The private, self-hosted alternative)

## Retrieval Unit

The retrieval unit dictates what text is embedded into a vector.

*Alternatives Considered:*
*   **Whole artifact embeddings:** Embed the entire file. Easy to implement, preserves global context, but risks diluting the semantic signal for very large files.
*   **Structure-aware units:** Embed individual functions, classes, or Markdown sections. Maximizes semantic density but requires complex AST parsing and complicates the definition of a "candidate" (is the candidate the function or the file?).
*   **Hybrid (Metadata + Content):** Prepend file paths and artifact types to the text.

**Decision for B7:**
For the first experiment, we will use **Whole Artifact Embeddings with Path Prepending**.
*Format:* `File: <filepath>\n\n<file_content>`
*Why:* We must minimize confounding factors. If we introduce AST chunking, we won't know if a failure is due to the embedding model or a bad chunking heuristic. The context windows of our chosen models (8K - 32K) comfortably fit the vast majority of files in our pilot repositories without truncation.

## Query Representation

The query is the representation of the "historical change" being evaluated.

*Alternatives Considered:*
*   Raw unified diff
*   Commit message
*   Changed artifact full content

**Decision for B7:**
We will use a **Concatenated Change Summary**.
*Format:*
```text
Change Description: <historical_change_description>
Files Modified:
- <file1_path>
- <file2_path>
```
*Why:* Sending a raw unified diff introduces heavy syntax noise (e.g., `@@ -12,4 +13,5 @@`) which embeddings are not traditionally trained to optimize for (unless it's `voyage-code-4`). The `change_description` provided in the evaluation case schemas accurately simulates the developer's intent at the time. **We will strictly avoid using LLMs to rewrite or summarize the query in B7** to isolate the embedding model's raw capability.

## Search Strategy

**Decision:** Exact K-Nearest Neighbors (KNN) using **Cosine Similarity**.
*Why:* The artifact universe for a given evaluation case at `base_commit` is small (typically a few thousand files). Introducing approximate nearest neighbor (ANN) indexes like HNSW would introduce unnecessary recall loss and infrastructure complexity. We will load the embeddings into memory and compute exact cosine similarity arrays, preserving the precise mathematical score.

## Evaluation Methodology

The evaluation will be strictly contemporaneous, grounded at the `base_commit` of each of the 9 pilot cases. No future knowledge, tests, or PR comments will be included in the artifact universe or the query.

We will compare B7 against the B5 (Combined Deterministic) and B6 (Deterministic Ranking) baselines.

**Metrics:**
*   **Deterministic vs Semantic Retrieval:** Does B7 retrieve the ground-truth candidates in the Top-1, Top-3, Top-5, Top-10, or Top-20?
*   **Complementarity:** We will calculate the Candidate Union (B6 + B7) to see if semantic retrieval captures the Abstraction Gap cases (TB-0006, TB-0007) that B6 completely misses.
*   **Noise Analysis:** We will measure the degradation of Top-K precision compared to B1 (Structural). For negative cases like TB-0009, does semantic retrieval successfully ignore the change, or does it hallucinate false positives?

## Risks

1.  **Context Truncation:** If a file exceeds the model's context window (e.g., >8k tokens for `text-embedding-3-small`), it will be truncated. The relevant semantic signal might exist in the truncated portion.
2.  **Vocabulary Mismatch:** The query description might be too short to adequately activate the latent space overlapping with the architectural documentation.
3.  **Data Contamination:** The embedding models might have been trained on the very GitHub repositories we are testing (Hono), potentially artificially inflating performance on our benchmark via memorization. We rely on the contemporaneous constraint (testing historical commits) to mitigate this.

## Failure Analysis

Semantic retrieval failures must be strictly classified to understand *why* the abstraction gap wasn't bridged:

1.  **Query Representation Failure:** The historical change description was too brief or vague to activate the relevant semantic domain.
2.  **Embedding Representation Failure:** The target artifact was truncated, or its domain vocabulary didn't meaningfully align with the embedding model's latent space.
3.  **Retrieval-Unit Failure:** The artifact was too large, diluting the specific relevant section in an average of irrelevant tokens.
4.  **Semantic False Positive:** High cosine similarity retrieved a candidate that shares conceptual vocabulary but is mathematically or logically unrelated to the change.
5.  **Semantic False Negative:** Low cosine similarity for a ground-truth candidate due to severe vocabulary drift.
6.  **Temporal Contamination:** A candidate was retrieved based on text that was added *after* the evaluation cutoff (must be actively audited against).
7.  **Artifact-Type Mismatch:** The model heavily biases toward retrieving similar file types (e.g., retrieving only `.ts` files and ignoring `.md` files).

## Recommended First Implementation Slice

The smallest scientifically useful implementation:
1.  **Model:** Implement only `text-embedding-3-small` using the OpenAI API.
2.  **Corpus:** Extract the artifact universe for TB-0001 using `git archive` at `base_commit`.
3.  **Embed:** Map each file to a vector using `File: <path>\n\n<content>`.
4.  **Query:** Embed the `change_description`.
5.  **Search:** Calculate exact cosine similarity using a simple Node.js array map/sort.
6.  **Report:** Output a JSON ranked list and compare it directly to TB-0001's deterministic output.

Do not build a database. Save embeddings to a local `.json` or `.bin` cache file keyed by file hash to avoid re-fetching during iteration.
