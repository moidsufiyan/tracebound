# Existing Tools — Comparison Framework

> **Status:** Framework only — Phase 0. No conclusions have been drawn.
> Capability assessments below reflect publicly stated features or reasonable inferences from documentation.
> **Do not treat any entry as authoritative without verifying against the primary source.**
> Cells marked `[Unverified]` require direct investigation before being used as design inputs.

---

## Purpose

This document is a structured framework for investigating how existing tools address (or fail to address) the change-impact investigation problem. It is not a feature comparison for marketing purposes. It is a research input.

---

## Evaluation Dimensions

For each tool, investigate:

1. **Capabilities relevant to our problem** — what signals does the tool surface when a developer modifies code?
2. **Evidence / source** — where is this capability documented or demonstrated?
3. **Limitations relevant to our problem** — what does the tool not do that we care about?
4. **Unresolved questions** — what must be investigated directly?

---

## GitHub

### Capabilities to Investigate

| Capability | Description | Evidence / Source | Status |
|-----------|-------------|------------------|--------|
| Code search | Full-text search across repository | [docs.github.com](https://docs.github.com/en/search-github/searching-on-github/searching-code) | Public documentation |
| Blame view | Per-line commit attribution | GitHub UI | Public documentation |
| PR linked issues | Issues linked to PRs via keywords | GitHub docs | Public documentation |
| File history | Commit history per file | GitHub UI / git | Public documentation |
| Dependency graph | Package-level dependency visualization | [docs.github.com](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/about-the-dependency-graph) | Public documentation |
| Code owners | CODEOWNERS file support | GitHub docs | Public documentation |

### Limitations Relevant to Our Problem

<!-- PLACEHOLDER: Validate these through direct testing or research. -->

- Dependency graph is package-level, not symbol-level
- Code search is not change-scoped — you must formulate the query yourself
- No automatic surfacing of co-changing artifacts given a diff
- PR/issue linkage depends on commit message discipline, which varies by team

### Unresolved Questions

- [ ] Does GitHub's code search API expose enough to build structured queries from a diff?
- [ ] Are there GitHub Actions or Apps that partially address this problem?
- [ ] What is the practical recall of linked issues across representative repositories?

---

## Sourcegraph

### Capabilities to Investigate

| Capability | Description | Evidence / Source | Status |
|-----------|-------------|------------------|--------|
| Code intelligence | Cross-repository "find references" | [sourcegraph.com/docs](https://sourcegraph.com/docs) | Public documentation |
| Precise code intelligence | LSIF/SCIP-based precise references | Sourcegraph docs | Public documentation |
| Batch changes | Automated multi-repo changes | Sourcegraph docs | Public documentation |
| Code insights | Aggregate metrics over time | Sourcegraph docs | Public documentation |
| Notebooks | Code-linked documentation | Sourcegraph docs | Public documentation |

### Limitations Relevant to Our Problem

<!-- PLACEHOLDER: Validate through direct testing or documentation review. -->

- Primarily a search and navigation product; does not proactively surface impact given a change
- Requires SCIP/LSIF index generation for precise intelligence
- Cross-repository linkage requires all repositories to be indexed
- No explicit "given this diff, what else is affected?" workflow

### Unresolved Questions

- [ ] Does Sourcegraph expose its reference graph via API in a way we could leverage?
- [ ] What is the setup cost for precise code intelligence in a typical TypeScript repository?
- [ ] Does Sourcegraph have any change-impact or diff-awareness features?

---

## Augment

### Capabilities to Investigate

| Capability | Description | Evidence / Source | Status |
|-----------|-------------|------------------|--------|
| Codebase context | AI-assisted code understanding | [augmentcode.com](https://augmentcode.com) | Public website |
| Repository indexing | Semantic indexing of codebase | Augment docs/website | [Unverified — requires investigation] |
| Change awareness | Diff-scoped suggestions | [Unverified] | Requires direct testing |

### Limitations Relevant to Our Problem

<!-- PLACEHOLDER: Requires direct investigation. -->

- Relies on semantic/embedding-based retrieval — deterministic signal quality unknown
- Black-box retrieval makes evaluation of coverage difficult
- Requires access to product for testing

### Unresolved Questions

- [ ] What retrieval strategies does Augment use under the hood?
- [ ] Does it explicitly surface "what is affected by this change" or is it implicit in suggestions?
- [ ] How does it perform on large, unfamiliar repositories?
- [ ] What evidence exists for its effectiveness beyond marketing claims?

---

## Static / Code Analysis Tools

### Tools to Investigate

- **TypeScript Language Server (tsserver)** — provides references, definitions, type information
- **ESLint** — static analysis for JS/TS; limited to single-file/project scope by default
- **ts-morph** — TypeScript AST manipulation library for programmatic analysis
- **tree-sitter** — language-agnostic parser used in many code intelligence tools
- **madge** — CommonJS/ESM module dependency graph tool for JavaScript

### Capabilities to Investigate

| Tool | Capability | Relevant to Problem | Status |
|------|-----------|--------------------|----|
| TypeScript Language Server | Find all references to a symbol | High — symbol-level dependents | Public documentation |
| TypeScript Language Server | Type-aware analysis across project | High — catches type contract changes | Public documentation |
| ts-morph | Programmatic AST traversal | High — usable for building our own analysis | Public documentation |
| madge | Module-level dependency graph | Medium — file-level only, not symbol-level | Public documentation |
| tree-sitter | Syntax parsing (language-agnostic) | Medium — requires additional analysis layer | Public documentation |

### Limitations Relevant to Our Problem

- tsserver operates within a project boundary (tsconfig); cross-project analysis requires additional tooling
- madge resolves imports but does not understand type relationships
- Static analysis does not capture runtime or dynamic dependencies
- None of these tools provide a "given this diff" interface natively

### Unresolved Questions

- [ ] Can tsserver's reference graph be extracted programmatically without a running IDE?
- [ ] How does tree-sitter compare to tsserver for TypeScript symbol analysis?
- [ ] Are there existing libraries that combine AST analysis with git history?

---

## Git History Tooling

### Tools to Investigate

- **git log** — commit history per file or symbol
- **git blame** — per-line attribution
- **git diff** — structural diff between commits
- **git log --follow** — file rename tracking
- **gitpython / nodegit / isomorphic-git** — programmatic git access

### Capabilities to Investigate

| Tool | Capability | Relevant to Problem | Status |
|------|-----------|--------------------|----|
| git log | Per-file commit history | Medium — context, not impact prediction | Standard git |
| git log (multi-file) | Commits that touched multiple files together | High — co-change signal | Standard git |
| git shortlog / pickaxe | History search by symbol or string | High — semantic history search | Standard git |
| isomorphic-git | Programmatic git access in Node.js | High — if implementation is JS-based | Public documentation |

### Limitations Relevant to Our Problem

- Co-change patterns are correlational, not causal — noise is a concern
- Effective co-change analysis requires a meaningful commit history; shallow clones are problematic
- Rename detection is imperfect; refactors can break file-level history

### Unresolved Questions

- [ ] What is the quality of co-change signals in practice? Are there existing studies?
- [ ] What is the minimum commit history depth required for a useful signal?
- [ ] How should co-change be defined — same commit? Same PR? Same sprint?

---

## Requirements and Traceability Tools

### Tools to Investigate

- **IBM DOORS** — requirements management with traceability links
- **Jama Connect** — requirements and traceability for regulated industries
- **Helix ALM (Perforce)** — ALM with traceability
- **PlantUML / Mermaid traceability diagrams** — lightweight diagramming
- **GitHub Issues + Projects** — lightweight issue tracking with PR linkage

### Capabilities to Investigate

| Tool | Capability | Relevant to Problem | Status |
|------|-----------|--------------------|----|
| IBM DOORS | Formal requirements to code traceability | Low-Medium — heavyweight, enterprise-focused | [Unverified] |
| GitHub Issues | Code–issue linkage via commit messages | Medium — dependent on team discipline | Public documentation |
| General traceability tools | Artifact relationship graphs | Medium — conceptually relevant | [Unverified] |

### Limitations Relevant to Our Problem

- Enterprise traceability tools are heavyweight and require upfront schema design
- These tools are generally requirements → code; not code → impact
- GitHub Issues linkage is post-hoc and inconsistent without team conventions

### Unresolved Questions

- [ ] Is there prior academic work on automatic code–requirements traceability that is applicable here?
- [ ] Are there lightweight traceability tools specifically for open-source repositories?

---

## Summary

| Tool Category | Covers Direct Dependents | Covers Tests | Covers Docs | Covers History | Change-Scoped? |
|--------------|--------------------------|-------------|-------------|----------------|----------------|
| GitHub | Partial (package-level) | No | No | Yes (file) | No |
| Sourcegraph | Yes (with indexing) | No | No | Limited | No |
| Augment | Unknown | Unknown | Unknown | Unknown | Partial? |
| Static analysis | Yes (symbol-level) | No | No | No | No |
| Git tooling | No | No | No | Yes | No |
| Traceability tools | No | No | Partial | No | No |

> **[Unverified]** All entries in this summary table should be validated against primary sources before being treated as factual.

---

## Research Actions

- [ ] Direct testing of Sourcegraph code intelligence on a representative TypeScript repository
- [ ] Review of tsserver/ts-morph API for programmatic reference extraction
- [ ] Literature search: co-change analysis and change-impact prediction
- [ ] Direct testing of Augment (requires access)
- [ ] Survey of GitHub issues linkage quality across several open-source repositories
