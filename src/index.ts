export { openDatabase, type Database } from './db/database.js';
export {
  createProject,
  getProject,
  registerRepository,
  getRepository,
  NotFoundError,
  type Project,
  type Repository,
} from './projects/projects.js';
export {
  findSnapshot,
  getSnapshot,
  requireReadySnapshot,
  SnapshotNotReadyError,
  type RepositorySnapshot,
  type SnapshotStatus,
} from './snapshots/snapshots.js';
export {
  compareSnapshots,
  SnapshotRepositoryMismatchError,
  type ArtifactChange,
  type ComparedVersion,
} from './snapshots/compare-snapshots.js';
export {
  findArtifactAtSnapshot,
  listSnapshotArtifacts,
  readContent,
  type ArtifactKind,
  type SnapshotArtifact,
} from './artifacts/artifacts.js';
export { ingestSnapshot, listExcludedEntries, type IngestionResult, type ExcludedEntry } from './ingestion/ingest-snapshot.js';
export { CommitNotFoundError, GitCommandError, InvalidCommitShaError, NotAGitRepositoryError } from './git/git.js';
export {
  indexSnapshotLexically,
  isSnapshotLexicallyIndexed,
  LexicalIndexNotBuiltError,
  type LexicalIndexingResult,
} from './retrieval/lexical-index.js';
export { searchLexical, type LexicalCandidate, type LexicalQuery } from './retrieval/lexical-search.js';
export { LEXICAL_CATEGORIES, type LexicalCategory } from './retrieval/lexical-ranking.js';
export { queryTerms, tokenize } from './retrieval/tokenizer.js';
export {
  indexSnapshotStructurally,
  isSnapshotStructurallyIndexed,
  StructuralIndexNotBuiltError,
  type StructuralIndexingResult,
} from './analysis/structural-index.js';
export {
  findIncomingRelationships,
  findOutgoingRelationships,
  type RelationshipEnd,
  type RelationshipKind,
  type SnapshotRelationship,
} from './analysis/relationships.js';
export {
  retrieveCandidates,
  type DeterministicCandidate,
  type DeterministicQuery,
  type StructuralSignal,
} from './retrieval/deterministic-retrieval.js';
export {
  DETERMINISTIC_CATEGORIES,
  STRUCTURAL_SIGNAL_KINDS,
  type DeterministicCategory,
  type StructuralSignalKind,
} from './retrieval/deterministic-ranking.js';
export {
  indexSnapshotSemantically,
  isSnapshotSemanticallyIndexed,
  SemanticIndexIncompatibleError,
  SemanticIndexNotBuiltError,
  type SemanticIndexingResult,
} from './semantic/semantic-index.js';
export { searchSemantic, type SemanticCandidate, type SemanticQuery } from './semantic/semantic-search.js';
export { createOllamaEmbeddingProvider, type OllamaOptions } from './semantic/ollama-provider.js';
export { EmbeddingInputTooLongError, EmbeddingProviderError, type EmbeddingProvider } from './semantic/provider.js';
export { EmbeddingResponseError } from './semantic/vectors.js';
export {
  DEFAULT_RRF_K,
  fuseRrf,
  InconsistentCandidateError,
  type FusedCandidate,
  type RankedCandidate,
  type RankedDeterministicCandidate,
  type RrfOptions,
} from './retrieval/rrf.js';
export { searchHybrid, searchHybridDetailed, type HybridQuery, type HybridSearchResult } from './retrieval/hybrid-search.js';
export {
  constructEvidence,
  DEFAULT_EVIDENCE_LIMIT,
  type ChangedPathFacts,
  type Evidence,
  type EvidenceBundle,
  type EvidenceCandidate,
  type EvidenceOptions,
  type FusionEvidence,
  type LexicalEvidence,
  type SemanticEvidence,
  type SourceExcerpt,
  type StructuralEvidence,
} from './retrieval/evidence.js';
export {
  assessImpact,
  IMPACT_REASONING_INSTRUCTIONS,
  IMPACT_REASONING_INSTRUCTIONS_VERSION,
  planReasoningBatches,
  ReasoningInputTooLargeError,
  type ImpactRequest,
} from './reasoning/impact-reasoning.js';
export {
  IMPACT_CLASSIFICATIONS,
  IMPACT_OUTPUT_SCHEMA,
  InvalidReasoningOutputError,
  validateImpactOutput,
  type CandidateAssessment,
  type Finding,
  type ImpactClassification,
  type ImpactReport,
} from './reasoning/impact-report.js';
export {
  ReasoningProviderError,
  ReasoningProviderTimeoutError,
  serializeReasoningInput,
  type ReasoningCandidate,
  type ReasoningInput,
  type ReasoningProvider,
  type ReasoningRequest,
} from './reasoning/provider.js';
export { createOllamaReasoningProvider, type OllamaReasoningOptions } from './reasoning/ollama-reasoning-provider.js';
export {
  describeEvidence,
  investigateChange,
  type ChangedFile,
  type EvidenceLine,
  type InvestigationCandidate,
  type InvestigationOptions,
  type InvestigationReport,
  type ReasoningStatus,
  type RetrievalSignals,
} from './investigation/investigate.js';
export { renderInvestigationMarkdown } from './investigation/render.js';
