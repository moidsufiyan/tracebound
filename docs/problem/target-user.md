# Target User

> **Status:** Working Persona — Phase 0. This is a focused, intentional constraint, not a market definition.
> Do not generalize this into a "developer productivity" persona without deliberate justification.

---

## Current Working Persona

**Software developer or maintainer making changes to an unfamiliar or moderately complex TypeScript/JavaScript repository.**

---

## Situation

The developer is working in a codebase they do not fully own or have not worked in extensively. The repository may be:

- A shared service maintained by a team, where the developer is not the primary author of the affected area
- An open-source dependency or internal library they are contributing to or patching
- A legacy codebase with limited documentation and high coupling
- A codebase they inherited or are onboarding into

The developer is not necessarily junior. They may be highly experienced but simply unfamiliar with *this specific repository's* structure, conventions, or history.

---

## Goal

Before completing or submitting a change, the developer wants to understand:

> *"What else in this repository might be affected by what I just changed?"*

They want enough coverage to be reasonably confident they are not introducing a regression or breaking a contract they were unaware of.

---

## Current Workflow

<!-- PLACEHOLDER: Validate through user research. The following is a working hypothesis only. -->

In the absence of a dedicated tool, the developer likely:

1. Checks direct callers of the modified function/module using IDE "find references"
2. Looks for test files co-located with, or named after, the modified file
3. Searches for string occurrences of the modified symbol or filename
4. Skims `git log` or `git blame` on the modified file for context
5. Asks a colleague who knows the area better
6. Relies on CI to surface failures after the fact

> **[Hypothesis]** Steps 5 and 6 are common fallbacks precisely because steps 1–4 are incomplete or expensive to execute thoroughly. This requires validation.

---

## Information They Need

The developer needs to locate:

| Information Type | Description |
|-----------------|-------------|
| **Direct dependents** | Files, modules, or functions that import or call the modified symbol |
| **Tests** | Test files that exercise the modified behavior (not just co-located tests) |
| **Documentation** | Docs, READMEs, or inline comments that describe the changed behavior |
| **Historical co-changes** | Files that have changed together with the modified files in the past |
| **Linked issues/PRs** | Context about *why* the area was previously changed |
| **Type contracts** | Interfaces, types, or API shapes that the changed code implements or depends on |

> **[Open question]** Which of these matter most? Which are most frequently missed? This is not yet known.

---

## Likely Failure Points

<!-- PLACEHOLDER: Validate through user research and case study analysis. These are hypotheses. -->

| Failure Point | Hypothesis | Validation Needed |
|--------------|-----------|------------------|
| Indirect dependents missed | "Find references" only catches direct callers; transitive consumers are not surfaced | Case study analysis |
| Tests not co-located | Test files structured by feature or behavior rather than by module are easily missed | Repository survey |
| Documentation staleness not visible | Modified behavior has associated documentation the developer is unaware of | Case study analysis |
| Historical context ignored | Relevant patterns in Git history are not consulted due to friction | User research |
| No single entry point | Relevant artifacts exist across multiple systems (repo, issues, docs) with no unified view | User research |

---

## What This Persona Is Not

- Not a DevOps engineer concerned with deployment impact
- Not a product manager tracking feature coverage
- Not a security auditor performing threat modeling
- Not a "general developer" — the unfamiliarity constraint is central to the problem

---

## Open Questions

- [ ] Is the persona more accurately described as "unfamiliar" or "infrequent contributor"?
- [ ] Does repository size significantly change the problem? At what scale?
- [ ] Is TypeScript-specific structure (module resolution, type exports) meaningfully different from JavaScript for this problem?
- [ ] Do developers in this situation want a dedicated tool, or better integration into existing workflows?
