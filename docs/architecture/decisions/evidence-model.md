# ADR: Evidence as a First-Class Object

**Decision:** Materialize `Evidence` as a distinct, first-class domain concept.
**Context:** Retrieval simply returns a ranked list of candidate artifacts. However, Tracebound's core value proposition is "evidence-backed impact analysis." The LLM reasoning layer must base its conclusions on verifiable facts, not opaque retrieval scores.
**Alternatives:** 
- Pass raw retrieval scores and artifact text directly into the LLM prompt.
- Deduce the relationship implicitly inside the LLM.
**Chosen approach:** A dedicated Evidence Collection phase executes *after* retrieval and *before* reasoning. For a given candidate, the system generates an `Evidence` object explicitly documenting the relationship (e.g., "Exact AST Import", "Historical Co-change Rate: 80%", "Lexical Overlap: 5 terms"). The LLM receives this structured evidence.
**Implementation:** see [ADR: Evidence Construction](evidence-construction.md): evidence is built on demand from one retrieval run and the snapshot, is not persisted, and records why a candidate was retrieved without concluding impact. The examples above that need data Tracebound does not yet have (for example co-change rates) are not produced.
**Tradeoffs:** 
- *Pros:* Enforces deterministic boundaries on the LLM; prevents hallucinated relationships; enables UI features where users can inspect exactly *why* a file was flagged.
- *Cons:* Requires additional post-retrieval processing logic to extract precise evidence snippets (e.g., mapping an AST relationship back to a specific line number).
