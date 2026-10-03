# Architectural Decision Records

This directory contains lightweight architectural decision records (ADRs) for the Tracebound project.

---

## Purpose

ADRs document significant decisions made during the project — what was decided, why, what alternatives were considered, and what tradeoffs were accepted. They are the permanent record that prevents decisions from being relitigated or forgotten.

A decision that is not recorded is a decision that will be made again, inconsistently, later.

---

## When to Write an ADR

Write an ADR when:

- A decision has meaningful alternatives that were considered and rejected
- A decision will be difficult or costly to reverse
- A future contributor would reasonably ask "why was this done this way?"
- A constraint was accepted that is not obvious from the code or structure

Do **not** write an ADR for:

- Decisions with no meaningful alternatives
- Trivial implementation choices
- Decisions that are clearly provisional and will be revisited

---

## Template

Copy this template when creating a new ADR. File naming: `NNN-short-title.md` (e.g., `001-evaluation-format.md`).

```markdown
# NNN — Decision Title

Date: YYYY-MM-DD
Status: Proposed | Accepted | Superseded by: NNN

---

## Decision

State the decision in one or two sentences.

## Context

What is the situation that requires this decision?
What constraints, goals, or observations are relevant?

## Alternatives

List the alternatives that were considered.
For each, note why it was not chosen.

- **Alternative A:** Description. Not chosen because: ...
- **Alternative B:** Description. Not chosen because: ...

## Chosen Approach

Describe what was decided and the primary reason.

## Tradeoffs

What does this decision cost? What does it defer or prevent?
Be honest about downsides.

## Status

Proposed | Accepted | Superseded by: NNN
```

---

## Current Decisions

*No decisions have been recorded yet. The project is in Phase 0.*

Decisions will be recorded here as they are made. The first decisions will likely concern:

- Evaluation case format and storage
- Repository selection criteria for evaluation
- Candidate generation methodology

These will be documented when they are actually resolved, not speculatively.

---

## Index

| # | Title | Status | Date |
|---|-------|--------|------|
| — | *None yet* | — | — |
