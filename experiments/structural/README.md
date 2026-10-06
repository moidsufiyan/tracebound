# B1 Structural Analysis Baseline Experiment

## Purpose
This experiment establishes a pure deterministic structural analysis baseline for Tracebound. It retrieves candidates strictly via auditable module relationships (imports/exports), avoiding lexical noise, semantic search, and hindsight leakage.

## Scope & Constraints
- **Implementation:** Uses the `typescript` compiler API to parse ASTs and extract `ts.SyntaxKind.ImportDeclaration`.
- **Relationships Supported:**
  1. Direct imports (Changed file -> Candidate)
  2. Reverse imports (Candidate -> Changed file)
  3. Test-to-Source dependencies (Test file -> Changed file)
- **Relationships Deferred:** Deep transitive analysis, full call graph resolution, and framework-specific inference are deferred.
- **Temporal Constraint:** Analyzes exactly the files tracked in the repository at `base_commit`. Does not touch the current working tree.

## Usage
1. `cd experiments/structural`
2. `npm install`
3. `node index.js`

Outputs are saved to the `outputs/` directory.
