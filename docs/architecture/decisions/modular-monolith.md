# ADR: Modular Monolith Architecture

**Decision:** Use a Modular Monolith architecture for the Tracebound production system.
**Context:** Tracebound is being developed by a single engineer prioritizing correctness, learning value, and steady iteration over premature scaling complexity. The system requires orchestrating repository ingestion, structural/semantic analysis, hybrid retrieval, and LLM reasoning.
**Alternatives:** 
- Microservices (e.g., separate ingestion, embedding, and API services)
- Serverless functions
**Chosen approach:** A Modular Monolith. The codebase will be organized into strictly bounded modules (e.g., `ingestion`, `analysis`, `retrieval`, `reasoning`) that communicate via in-memory interfaces rather than network calls.
**Tradeoffs:** 
- *Pros:* Drastically simplified deployment and operational overhead; eliminates network latency between components; simplifies transactional consistency during ingestion.
- *Cons:* Scaling a specific bottleneck (like embedding generation) requires scaling the entire application instance. This will be mitigated by implementing internal background worker queues within the monolith.
