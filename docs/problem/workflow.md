# Change-Investigation Workflow

> **Status:** Hypothesis — Phase 0. This workflow has not been validated against real developer behavior.
> Every step below is a working assumption. Do not treat this as a confirmed sequence.

---

## Purpose

This document describes the hypothesized workflow a developer follows when investigating the potential impact of a proposed change. It is the primary workflow that Tracebound intends to support.

Understanding and validating this workflow is a prerequisite to designing the system.

---

## Hypothesized Workflow

The following steps represent a working hypothesis about how a developer investigates a change before submitting it. **This workflow must be validated through research.** Steps may be skipped, reordered, or found to be non-standard in practice.

---

### Step 1 — Identify Changed Code

The developer identifies which files, functions, classes, or symbols they have modified (or intend to modify). This is usually clear from their editor or diff view.

**Hypothesis:** This step is nearly always explicit and unambiguous from the developer's perspective.

**Open questions:**
- Does the developer think in terms of files, symbols, or behaviors?
- Are there cases where the "changed code" is not clearly bounded (e.g., configuration changes, schema migrations)?

---

### Step 2 — Inspect References and Dependencies

The developer examines what directly depends on the changed code.

Typical actions:
- IDE "find references" / "find usages" on modified symbols
- Inspecting import/export chains
- Checking which modules call the modified function or implement the modified interface

**Hypothesis:** This step is commonly performed but often incomplete — it surfaces direct callers but not transitive dependents.

**Open questions:**
- How deep do developers trace dependencies in practice?
- Do they stop at the first level, or follow the chain?

---

### Step 3 — Find Relevant Tests

The developer locates test files that exercise the changed behavior.

Typical actions:
- Looking for test files co-located with the modified module
- Searching for test names that reference the modified symbol
- Running a known test suite and observing which tests fail

**Hypothesis:** Test discovery is frequently incomplete, particularly when tests are organized by feature or integration scenario rather than by module.

**Open questions:**
- How are tests structured in the target repository types?
- Do developers rely on CI to find missing test coverage, rather than actively searching?

---

### Step 4 — Search Documentation

The developer searches for documentation that describes or references the changed behavior.

Typical actions:
- Searching READMEs and markdown files for the modified symbol or module name
- Checking inline JSDoc/TSDoc comments
- Searching external documentation if it exists

**Hypothesis:** Documentation search is often skipped due to friction, leading to stale documentation going unnoticed.

**Open questions:**
- Is documentation search actually part of the typical investigation workflow?
- What forms of documentation are present in the target repositories?

---

### Step 5 — Inspect Git History

The developer reviews the commit history of the changed files or symbols to understand prior changes.

Typical actions:
- `git log --follow <file>`
- `git blame <file>`
- Reading commit messages for context on past changes

**Hypothesis:** Git history is consulted, but primarily to understand *why* the code exists, not to discover *what else changes when this code changes*.

**Open questions:**
- Do developers use `git log` to discover co-changing files?
- Is `git log` output approachable enough that developers read it reliably?

---

### Step 6 — Inspect Related Issues and Pull Requests

The developer reads linked or related issues and pull requests to understand the historical context of the modified area.

Typical actions:
- Following linked issues from commit messages
- Searching the issue tracker for references to the modified symbol or area
- Reading the PR that originally introduced the code

**Hypothesis:** This step is frequently skipped due to friction. Most developers do not have a systematic way to surface related historical PRs for a given file or symbol.

**Open questions:**
- How often do commit messages actually link to issues?
- Is there enough structured history in typical repositories to make this step useful?

---

### Step 7 — Determine Which Artifacts Require Investigation

The developer synthesizes the above signals and decides which artifacts to inspect in depth before submitting the change.

**Hypothesis:** This decision is currently made implicitly, with no systematic record, and its quality is highly dependent on the developer's familiarity with the codebase.

**Open questions:**
- What makes a developer confident they have found enough?
- What is the cost of under-investigation versus over-investigation?

---

## What Is Not Modeled Here

- Post-submission impact (CI failures, reviewer feedback)
- Runtime/production impact analysis
- Security or performance analysis
- Multi-repository impact

---

## Validation Plan

This workflow must be validated before any design decisions are made based on it. Possible validation approaches:

- [ ] Observation of developers working in unfamiliar codebases
- [ ] Retrospective interviews: "Walk me through how you investigated your last non-trivial change"
- [ ] Analysis of historical PRs: what files were modified together, which regressions were introduced, what the review process surfaced

> **Reminder:** A workflow that is plausible is not necessarily one that is real. Validate before building.
