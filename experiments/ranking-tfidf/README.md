# B6.1 TF-IDF Ranking Experiment

This directory implements the B6.1 deterministic TF-IDF ranking experiment, designed to test whether corpus-derived term weighting can resolve lexical collisions without introducing semantic search or LLMs.

## Implementation Details

* **TF-IDF Formulation:** 
  * $N = 10000$ (A constant corpus size approximation. Relative IDF scaling makes exact corpus size irrelevant for sorting).
  * $DF(t)$ = Total number of retrieved B5 candidates containing term $t$ in either path or content. Computed statically over the historic evaluation cutoff state.
  * $TF(t)$ = 1 (Boolean presence) because B2 outputs do not emit intra-document occurrence counts.
  * $IDF(t) = \log(N / (DF(t) + 1))$.
* **Corpus Definition:** The exact universe of candidates retrieved by B2 at the `base_commit`. No future documents or unretrieved noise files were used to calculate IDF.
* **Precedence:** The B6 categorical tiers (Tier 1: Critical Structural, Tier 2: Strong Lexical, etc.) were strictly preserved. TF-IDF replaced raw term count (`lex_all_count`) as the primary sorting mechanism *within* each categorical tier.

---

## Results: B6 vs B6.1

### TB-0001 (Reservation Locks - WollyWay)
* **B6 Rank:** 12
* **B6.1 Rank:** 11
* **Analysis:** The 11-way lexical collision *was* broken, but not in favor of the ground truth. The ground-truth document (`checkout-lifecycle.md`) scored 40.78, while `CHECKOUT_STATE_MACHINE.md` scored 68.68 (Rank #1). 
* **Why:** The query contained rare, implementation-specific terms (`lua`, `script`, `release`, `guard`). The lower-level state machine matched these rare terms, receiving massive IDF boosts (e.g., `lua` IDF: 7.01). The high-level architectural ground truth naturally omitted implementation details, relying on broader domain terms (`checkout`, `update`, `service`), which TF-IDF penalized as common.

### TB-0002 (Order REFUNDED - WollyWay)
* **B6 Rank:** 1
* **B6.1 Rank:** 4
* **Analysis:** TF-IDF **degraded** performance. The ground truth (`order-lifecycle.md`) fell from Rank 1 to Rank 4.
* **Why:** The query term "order" is extremely common in the repository ($DF = 161$, IDF: 4.13), while "stale" ($DF = 14$, IDF: 6.57) and "remove" ($DF = 50$, IDF: 5.30) are rarer. The ground truth was heavily penalized for matching the common core domain term. A completely irrelevant document (`wishlist-lifecycle.md`) took Rank #1 simply because it happened to contain the rare words "stale" and "remove".

### TB-0003 (Combine Middleware - Hono)
* **B6 Rank:** 1
* **B6.1 Rank:** 1
* **Analysis:** Rank 1 was perfectly preserved because TF-IDF operates *beneath* the Tier 1 structural constraint (`[Test-to-Source Dependency]`).

---

## Failure Analysis

TF-IDF introduces a fundamental misalignment with software engineering traceability:

* **Lexical Abstraction Gap (Vocabulary Mismatch):** TF-IDF assumes that a document is relevant if it matches the *rarest* terms in the query. In software development, bug reports and PR descriptions are filled with highly specific, rare implementation details (e.g., "lua", "stale"). However, architectural documentation intentionally abstracts away implementation details, focusing instead on high-frequency domain concepts (e.g., "order", "checkout").
* **TF-IDF Penalty:** TF-IDF actively penalizes the core domain concepts because they appear in many files ($DF$ is high). It boosts the rare implementation details. As a result, TF-IDF systematically prefers low-level scripts and localized state machines over high-level conceptual documentation.

---

## Conclusion

> **Does TF-IDF provide enough deterministic improvement to justify keeping it in the ranking pipeline?**

**No. TF-IDF should be rejected.**

While TF-IDF successfully breaks domain-cluster ties, it breaks them in the wrong direction. It actively degrades the ranking of abstract architectural documentation (dropping TB-0002 from #1 to #4) by punishing core domain terms and heavily rewarding implementation-specific vocabulary that architectural documents naturally omit.

This experiment proves a critical conceptual ceiling for deterministic string matching: software change-impact requires resolving the **Lexical Abstraction Gap**. A developer making a change to a "lua script" needs to know that it impacts the "checkout lock lifecycle", even though the lifecycle document doesn't mention Lua. No stateless mathematical weighting of text tokens can infer that relationship. 

The deterministic baseline has now definitively exhausted its lexical capabilities. Tracebound is empirically justified in abandoning further token-based ranking experiments and transitioning to semantic retrieval.
