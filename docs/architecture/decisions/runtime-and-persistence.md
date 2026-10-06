# ADR: Runtime and Persistence

**Decision:** TypeScript on Node.js 24 (ESM), persisting to SQLite through the built-in `node:sqlite` module, with Vitest for tests.
**Context:** The first production slice (Project → Repository → RepositorySnapshot → Artifact → ArtifactVersion) needed a stack. The target ecosystem and every Phase 1 experiment are TypeScript/JavaScript. The development machine has no PostgreSQL or Docker, and a solo developer benefits from zero-infrastructure tests.
**Alternatives:**
- *TypeScript + PostgreSQL:* the eventual server-grade option, but it requires provisioning before any integration test can run.
- *Python + SQLAlchemy:* breaks with the TS/JS tooling the analysis modules will need (tsserver, ts-morph).
- *An ORM or query builder:* adds a dependency and an abstraction layer for a handful of tables.
**Chosen approach:** Plain SQL behind small module-level functions (`src/<module>/*.ts`) that take a `Database` handle. Ordered migrations live in `src/db/migrations.ts` and are tracked with `PRAGMA user_version`. Tables use `STRICT`, foreign keys are enforced, and file databases run in WAL mode. Transactions are synchronous (`inTransaction`), so an awaited operation can never absorb unrelated writes on the shared connection.
**Tradeoffs:**
- *Pros:* no external services; every test runs against the real schema; the SQL is portable to PostgreSQL if concurrency or vector needs demand it.
- *Cons:* single writer; `node:sqlite` is newer than mature drivers; moving to PostgreSQL means porting migrations and swapping the `Database` handle (repositories are plain functions, so the blast radius is small).
