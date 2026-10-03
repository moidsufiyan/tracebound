# Case Schema

> **Status:** Revised — Phase 0. This schema is lightweight and designed to be revised.
> Do not treat it as a production data model or database schema.
> Iterate on this schema as the first real cases are constructed.
> Schema version: 0.2.1 (refined temporal boundary: explicit artifact content/state at cutoff, three-way temporal distinction, content_hash_at_base).

---

## Purpose

This document defines the schema for a single evaluation case used in the Tracebound evaluation framework.

A case represents one historical software change in a real repository, with labeled candidate artifacts and documented rationale for each label. Cases are the ground truth against which retrieval strategies are compared.

---

## Schema

Cases are stored as YAML or JSON files in `docs/evaluation/cases/`. Each file represents one case.

### Top-Level Fields

```yaml
# ── Identity ─────────────────────────────────────────────────────────────────
case_id: string
  # Unique identifier for this case. Format: TB-NNNN (e.g., TB-0001)

version: string
  # Schema version this case conforms to. Current: "0.1"

created: YYYY-MM-DD
  # Date the case was created (ISO 8601)

status: "draft" | "labeled" | "reviewed" | "excluded"
  # draft: case constructed, labeling not complete
  # labeled: relevance labels assigned
  # reviewed: labels verified by a second reviewer
  # excluded: case removed from active evaluation set (with reason)

exclusion_reason: string | null
  # If status is "excluded", brief explanation

# ── Repository ───────────────────────────────────────────────────────────────
repository:
  name: string           # e.g., "microsoft/vscode"
  url: string            # Canonical URL (GitHub, GitLab, etc.)
  language: string       # Primary language, e.g., "TypeScript"
  base_commit: string
    # The commit SHA immediately before the change.
    # This is the repository state the developer worked from.
    # Anchors the artifact universe, exact artifact content states, and all labeling.
    # MUST be the parent commit of source_change.commit.

# ── Source Change ────────────────────────────────────────────────────────────
source_change:
  commit: string         # Commit SHA of the change being investigated
  pr_url: string | null  # Pull request URL, if available
  description: string    # Brief description of what the change does
  change_type:           # One or more of:
    - "feature" | "bugfix" | "refactor" | "dependency-update" | "documentation" | "other"
  change_timestamp: string
    # Author timestamp of source_change.commit (ISO 8601, e.g., "2024-03-15T14:22:00Z").
    # This is the evaluation knowledge cutoff.
    # No artifact or evidence created after this timestamp may be included in labeling.
  evaluation_cutoff: string
    # Must equal change_timestamp. Recorded explicitly so that case reviewers
    # can verify the cutoff without recomputing it from git.
    # Enforces the temporal boundary across three distinct facets:
    # 1. Artifact existence: artifact must exist at or before this cutoff.
    # 2. Artifact content/state: artifact must be evaluated at the version present at cutoff (e.g., base_commit content for git files, pre-cutoff body/comments for issues).
    # 3. Evidence available: only signals derivable prior to this cutoff are admissible.
  evaluation_mode: "contemporaneous" | "retrospective"
    # contemporaneous: existence, content/state, and evidence restricted to base_commit / pre-cutoff state (default, required for primary benchmark)
    # retrospective:   evidence may include post-change artifacts or post-cutoff content (label explicitly; exclude from primary metrics)

# ── Changed Artifacts ────────────────────────────────────────────────────────
changed_artifacts:
  - path: string         # Relative path to the changed file
    symbols:             # Modified symbols within the file (may be empty if unknown)
      - name: string     # Symbol name (function, class, type, variable)
        kind: "function" | "class" | "interface" | "type" | "variable" | "other"

# ── Artifact Universe ────────────────────────────────────────────────────────
artifact_universe:
  definition: string
    # Human-readable description of what constitutes the candidate pool for this case.
    # Both artifact existence and artifact content/state are bounded at base_commit.
    # Examples:
    #   "All files tracked by git at base_commit"
    #   "All .ts and .test.ts files under src/ and tests/ at base_commit"
    #   "All files reachable via import graph from changed_artifacts, depth <= 3 at base_commit"
  size: integer | null
    # Number of artifacts in the universe, if known at case construction time.
    # Null is acceptable; fill in before running evaluations.
  notes: string | null
    # Any constraints or exclusions applied (e.g., "node_modules excluded", "generated files excluded")

# ── Candidate Artifacts ──────────────────────────────────────────────────────
candidates:
  - artifact_id: string  # Unique ID within this case, e.g., "C01"
    path: string         # Relative path to the candidate artifact at base_commit
    content_hash_at_base: string | null
      # Optional: Git blob SHA (e.g. from `git rev-parse base_commit:path`) or content hash
      # at base_commit. Enables automated auditability that evaluation used the pre-change
      # content state rather than a subsequent rewrite or HEAD.
    artifact_type:       # One of:
      "source" | "test" | "documentation" | "configuration" | "schema" | "other"

    # ── Relationship ─────────────────────────────────────────────────────────
    relationship: string
      # Primary relationship type. See methodology.md for full type list.
      # Examples: "direct-import", "test-of", "co-changes-with", "documents", "unknown"

    # ── Evidence ─────────────────────────────────────────────────────────────
    evidence:
      - type: "structural" | "lexical" | "historical" | "semantic" | "human"
        description: string
        # Brief description of the specific evidence.
        # MUST be grounded strictly in the artifact's content/state at base_commit (or pre-cutoff issue/PR state).
        # Must not reference post-cutoff revisions, subsequent comments, or later rewrites.
        # For structural: "imports changed module at line 12 of base_commit content"
        # For historical: "co-changed in 4 of last 10 commits strictly prior to cutoff"
        # For human: "reviewer noted this file should be inspected based on base_commit architecture"

    # ── Relevance Label ──────────────────────────────────────────────────────
    relevance: "direct-impact" | "investigation-worthy" | "contextual-historical" | "not-relevant" | "uncertain"
      # direct-impact:        structurally or behaviorally coupled; always inspect
      # investigation-worthy: not directly coupled but a careful developer would inspect
      # contextual-historical: historically co-changed; useful signal, not always actionable
      # not-relevant:         no meaningful connection
      # uncertain:            labeler disagreement or unclear — resolve during review, do not leave indefinitely
      #
      # NOTE: The final binary/graded labeling scheme has not been selected.
      # These five categories will be collapsed or preserved based on pilot case findings.
      # See methodology.md § Relevance Categories (Conceptual) for full definitions.

    labeling_rationale: string
      # Why was this label assigned? Be specific.
      # Required for all non-obvious labels.
      # MUST be grounded strictly in the candidate's content/state at base_commit.
      # If the artifact was rewritten after the change, the rationale must reflect the pre-rewrite state.
      # For "uncertain": describe what makes it unclear and what evidence points in each direction.

    ambiguity_notes: string | null
      # If relevance is "uncertain", describe what makes it unclear.
      # If there is reviewer disagreement, record each reviewer's position here.

    label_confidence: "high" | "medium" | "low"
      # Labeler's confidence in the assigned relevance label.
      # high:   clear relationship, unambiguous evidence
      # medium: some uncertainty; reasonable reviewers would likely agree
      # low:    significant uncertainty; may be revisited; contributes to ambiguity analysis

    labeled_by: string   # e.g., "author", "reviewer-1", "consensus"
    labeled_at: YYYY-MM-DD

# ── Case-Level Notes ─────────────────────────────────────────────────────────
notes: string | null
  # Any additional context about this case that doesn't fit elsewhere
```

---

## Example Case (Empty Template)

```yaml
case_id: TB-0001
version: "0.2"
created: YYYY-MM-DD
status: draft
exclusion_reason: null

repository:
  name: ""
  url: ""
  language: TypeScript
  base_commit: ""

source_change:
  commit: ""
  pr_url: null
  description: ""
  change_type:
    - refactor
  change_timestamp: ""
  evaluation_cutoff: ""   # Must equal change_timestamp
  evaluation_mode: contemporaneous

changed_artifacts:
  - path: ""
    symbols:
      - name: ""
        kind: function

artifact_universe:
  definition: "All files tracked by git at base_commit under src/ and tests/"
  size: null
  notes: null

candidates:
  - artifact_id: C01
    path: ""
    content_hash_at_base: null  # Optional git blob SHA at base_commit
    artifact_type: test
    relationship: test-of
    evidence:
      - type: structural
        description: ""
    relevance: direct-impact
    labeling_rationale: ""
    ambiguity_notes: null
    label_confidence: high
    labeled_by: author
    labeled_at: YYYY-MM-DD

notes: null
```

---

## Design Decisions

| Decision | Rationale |
|---------|-----------|
| YAML format | Human-readable, easy to edit without tooling |
| Lightweight schema | The schema should not block case creation; add fields when needed |
| Separate `ambiguity_notes` | Preserves disagreement instead of hiding it in the label |
| `version` field | Enables schema evolution without breaking existing cases |
| `status` field | Tracks labeling progress without requiring a separate tracking system |
| `base_commit` (replaces `snapshot_commit`) | Precisely defines the repository state used for evaluation; anchors both artifact existence and exact content state; prevents off-by-one with change_commit |
| `change_timestamp` + `evaluation_cutoff` | Makes the temporal boundary explicit and auditable; enforces the 3-facet boundary (existence, content/state, evidence) without recomputing from git |
| `content_hash_at_base` | Optional git blob SHA allowing automated verification that the evaluated content matches the pre-change cutoff state rather than a subsequent rewrite |
| `evaluation_mode` | Distinguishes contemporaneous from retrospective cases so they are never silently mixed |
| `artifact_universe` block | Makes candidate generation reproducible; required for cross-case metric consistency |
| `label_confidence` | Enables filtering unstable labels from primary metric computation; surfaces labeling difficulty |
| Five relevance categories (not binary) | Defers the binary/graded decision until pilot data exists; preserves information that would be lost by premature collapse |

---

## What This Schema Is Not

- Not a production database schema
- Not an API contract
- Not a final format — expect revisions as the first real cases are constructed

---

## Open Questions

- [ ] Should `candidates` be exhaustive (all files in the artifact universe) or selective (pre-filtered by a nomination strategy)? How is this recorded and reproduced?
- [ ] Should the schema include explicit negative-example fields, or is the `not-relevant` label sufficient?
- [ ] Is the `evidence` field granular enough, or should it link to specific line numbers?
- [ ] Should retrieval strategy outputs be stored in the case file, or in a separate results directory keyed by case_id?
- [ ] Is `label_confidence` sufficient to capture inter-rater disagreement, or do we need to store per-reviewer label vectors?
- [ ] How will the `artifact_universe.size` field be populated and verified? Manual count or automated tooling?
- [ ] Should there be a machine-verifiable constraint that `evaluation_cutoff == change_timestamp`?
- [ ] How can automated tooling enforce content verification (e.g., verifying git blob SHAs of candidates against `base_commit`) to guarantee that no post-cutoff content drift leaked into labeling or retrieval?
- [ ] When the final relevance scheme is selected, how will schema version migration be handled for existing cases?
