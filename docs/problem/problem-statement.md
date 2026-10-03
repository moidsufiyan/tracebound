# Problem Statement

> **Status:** Draft — Phase 0. Placeholders indicate areas requiring investigation or validation.
> Do not treat any section as settled until it is marked **[Validated]**.

---

## Problem Definition

<!-- PLACEHOLDER: Refine after user research and workflow observation. -->

When a developer makes a change to an unfamiliar or moderately complex codebase, they must determine which other parts of the system are potentially affected. This investigation is largely manual, distributed across multiple disconnected tools (editor, terminal, browser), and relies heavily on the developer's prior familiarity with the codebase.

**Core hypothesis:** The relevant artifacts for a given change are discoverable through a combination of deterministic structural relationships, lexical signals, and historical co-change patterns — but current tools do not surface them in a unified, change-scoped context.

> **[Requires validation]** The degree to which this is true, and which signal types are most predictive, is unknown.

---

## Affected Users

<!-- PLACEHOLDER: Narrow or expand based on target-user research. See docs/problem/target-user.md. -->

Primary: Software developers/maintainers making changes to TypeScript or JavaScript repositories they do not fully own or are not deeply familiar with.

Secondary: Not defined in this phase.

---

## Triggering Workflow

<!-- PLACEHOLDER: Validate against actual developer behavior. See docs/problem/workflow.md. -->

A developer begins modifying one or more files in a repository. Before completing or submitting the change, they need to understand what else might be affected. This investigation is the triggering context.

---

## Current Investigation Process

<!-- PLACEHOLDER: Observe and document actual developer behavior — do not invent. -->

Developers likely use some combination of:

- IDE "find references" / "go to definition"
- `git log` on relevant files
- Manual grep / text search
- Reading test file names and directory structure
- Asking teammates
- Reading linked issues or PR descriptions

> **[Requires validation]** Which of these steps are most commonly skipped? Which produce the most false negatives?

---

## Pain Points

<!-- PLACEHOLDER: Do not invent pain points. Document only those confirmed through research or direct observation. -->

Hypothesized pain points (not confirmed):

- Incomplete coverage — developers miss relevant tests or dependent modules
- High cognitive load — investigation requires context-switching across many tools
- No persistent record — investigation is ephemeral and not reusable
- Inconsistent behavior — thoroughness depends heavily on the individual developer's familiarity

> **[Unconfirmed]** These are hypotheses. Each requires evidence before being treated as design inputs.

---

## Assumptions

| # | Assumption | Confidence | Validation Method |
|---|-----------|-----------|------------------|
| A1 | Developers regularly make changes to code they do not fully understand | Low | User research, observation |
| A2 | The set of relevant artifacts for a change is bounded and recoverable | Low | Case study analysis |
| A3 | Deterministic signals (imports, references, test paths) identify a meaningful subset of relevant artifacts | Low | Evaluation against labeled cases |
| A4 | Developers experience friction during the investigation phase before submitting a change | Low | User research |

---

## Hypotheses

| # | Hypothesis | Testable? | How |
|---|-----------|-----------|-----|
| H1 | Static dependency traversal recovers a non-trivial fraction of truly affected artifacts | Yes | Evaluation against labeled cases |
| H2 | Historical co-change patterns improve recall over structural analysis alone | Yes | Evaluation against labeled cases |
| H3 | Combining structural + lexical signals outperforms either alone | Yes | Evaluation against labeled cases |
| H4 | Developers who use a tool like Tracebound make fewer regression-inducing changes | Unknown | Requires deployed prototype and longitudinal study |

---

## Non-Goals

- Automatic code fix generation
- CI/CD integration (this phase)
- Multi-language support beyond TypeScript/JavaScript (this phase)
- Predicting semantic equivalence of changes
- Replacing code review

---

## Open Questions

<!-- Add new questions as they arise. Do not delete resolved questions — mark them instead. -->

- [ ] What does a "relevant artifact" mean precisely, and who decides?
- [ ] Is relevance binary or graded? Should the system return ranked results?
- [ ] What is the acceptable false-negative rate for a useful tool?
- [ ] Do developers actually want a tool, or do they want better IDE integration?
- [ ] At what repository size does the investigation problem become acute?
- [ ] Are there existing academic datasets for change-impact analysis we can use?
