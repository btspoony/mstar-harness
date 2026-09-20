/**
 * @mstar-harness/engine — public entry (exports map `.` → `dist/engine.js`).
 *
 * Engine = importable library for deterministic harness checks; the CLI and
 * OpenCode plugin consume it in-process. `core` is the shared type/version
 * base, `path` implements harness path resolution + scaffold + gitignore
 * checks, `status` implements the status.json schema, residual lifecycle,
 * findings-cleanup gate and the tech-debt rollup port, `lease` implements
 * the execution/merge lease state machines + same-host status write lock,
 * `dispatch` implements the Assignment field contract, default-branch
 * gate, QC seat mapping and tri-identity/anti-recursion prechecks, `lint`
 * implements marker/TDD-triple/plan-quality/frontmatter/STRATEGY checks and
 * ephemeral/provenance citation discovery,
 * `design-md` validates DESIGN.md token frontmatter + light/dark parity +
 * completeness levels, `audit` validates audit Status blocks, redacts
 * secrets and scaffolds audit-<date>/ plan dirs, and `compound` validates
 * knowledge-doc schema, reference existence, index rows and the
 * compound-refresh scope. `roles` validates the role reference mapping +
 * parameter tables and the load-order contract, `prreview` implements the
 * PR-review tally/score/verdict arithmetic and the merge-class/verdict
 * constants (mstar-audit pr-review.md § Tally and derived score), `qcreview`
 * is the QC seat-report contract (frontmatter fields + verbatim verdict
 * vocabulary + body-verdict agreement + Summary/Findings count parity +
 * truncation/verdict coherence, `mstar-review-qc` SKILL.md § 席位预算与截断), `host`
 * detects the active
 * host from tool shapes, resolves skill roots and defines the type-only
 * `HostAdapter` contract, `gates` is the host-neutral coordination-write
 * gate core (target classification + content/edit validation + reason
 * formatting, shared by the omp and ZCode host gates), and `skill-authoring`
 * lints frontmatter +
 * 5-question bodies and resolves skill-relative asset paths, and
 * `cleanup` is the pure worktree/branch cleanup planner (immutable facts
 * in, stable `cleanup.*` remove/keep/refuse decisions out), and `evidence`
 * is the pure SDD test-evidence contract (record schema validation,
 * artifact verification, input fingerprinting and reuse assessment —
 * values in, decisions out).
 */
export type { GateResult, Severity, ValidationResult } from "./core.js";
export { DSH_LLM_FALLBACKS_VERSION, SEVERITY_ORDER, applyEnforcement, readHarnessVersion, readJson, resolveProjectRoot, writeJson } from "./core.js";
export type {
  HarnessKind,
  ResolveHarnessDirOptions,
  ResolveSpecsDirOptions,
} from "./path.js";
export type { MstarcConfig } from "./mstarc.js";
export {
  MSTARC_FILE,
  MSTARC_HARNESS_DIR_KEY,
  MSTARC_PROJECT_DIR_KEY,
  MSTARC_SECTION,
  MSTARC_WORKFLOW_DIR_KEY,
  findMstarc,
  parseMstarc,
} from "./mstarc.js";
export {
  assertPlanWritingPath,
  canonicalizeNearestExisting,
  detectHarnessKind,
  emitGitignoreSnippet,
  resolveHarnessDir,
  resolveIterationDir,
  resolveKnowledgeDir,
  resolvePlanDir,
  resolveProjectDir,
  resolveScaffoldDirs,
  resolveSddDir,
  resolveSpecsDir,
  resolveWorkflowDir,
  scaffoldHarness,
  validateGitignore,
} from "./path.js";
export type {
  PlanRow,
  ResidualEntry,
  StatusDoc,
  StatusV2Doc,
  WorkflowEntry,
} from "./status.js";
export {
  normalizeSeverity,
  registerWorkflow,
  resolveCompassEnforcement,
  resolveMstarcEnforcement,
  resolveRepoEnforcement,
  unregisterWorkflow,
  validatePlanRow,
  validateResidual,
  validateStatus,
  validateStatusV2,
  validateWorkflowEntry,
} from "./status.js";
export type {
  ClaimLeaseFields,
  ExecutionLease,
  ExecutionLeaseLocations,
  IntegrationMergeLease,
  LeaseTransition,
  LeaseVerifyResult,
} from "./lease.js";
export {
  canSteal,
  claimLease,
  planExecutionLeaseLocations,
  releaseLease,
  sameHolderResume,
  validateExecutionLease,
  validateIntegrationMergeLease,
  verifyPlanExecutionLease,
  withStatusWriteLock,
} from "./lease.js";
export type {
  CloseWorkflowOptions,
  DeclareWorkflowDeliveryKindOptions,
  DeliveryRegistrationEvidence,
  RecordWorkflowDeliveryOptions,
  RecordWorkflowDeliveryResult,
  RegisterIterationWorkflowOptions,
  RegisterIterationWorkflowResult,
  RegisterPlanWorkflowOptions,
  RegisterPlanWorkflowResult,
  WorkflowBranchAnchors,
  WorkflowCompoundOutcome,
  WorkflowDeliveryEvidence,
  WorkflowDeliveryKind,
  WorkflowExecutionPolicy,
  WorkflowLifecycleStatus,
  WorkflowLifecycleType,
  WorkflowSnapshot,
  WorkflowSnapshotRead,
} from "./workflow.js";
export {
  assertDeliveryRegistrationCoherence,
  closeWorkflow,
  consultDeliveryEvidence,
  declareWorkflowDeliveryKind,
  isTerminalSnapshot,
  LEGACY_WORKTREE_PATH_CODE,
  recordWorkflowDelivery,
  registerIterationWorkflow,
  registerPlanWorkflow,
  WORKFLOW_COMPOUND_OUTCOMES,
  WORKFLOW_DELIVERY_KINDS,
  WORKFLOW_LIFECYCLE_STATUSES,
  WORKFLOW_LIFECYCLE_TYPES,
  WORKFLOW_SNAPSHOT_FILE,
  WORKFLOW_TERMINAL_STATUSES,
  readWorkflowSnapshot,
  validateWorkflowSnapshot,
  writeWorkflowSnapshot,
} from "./workflow.js";
export type {
  CleanupDecision,
  CleanupFacts,
  CleanupTarget,
  CleanupTargetKind,
} from "./cleanup.js";
export { planWorktreeCleanup } from "./cleanup.js";
export type {
  EvidenceArtifactFact,
  EvidenceAssessment,
  EvidenceCaptureRequest,
  EvidenceCoverage,
  EvidenceEnvironmentKey,
  EvidenceExpectation,
  EvidenceInputEntry,
  EvidenceInputSnapshot,
  EvidenceInputSpec,
  EvidenceLimits,
  EvidenceLog,
  EvidenceOutcome,
  EvidenceToolFingerprint,
  SddEvidenceRecord,
} from "./evidence.js";
export {
  assessSddEvidenceReuse,
  evidenceInputDigest,
  validateSddEvidenceRecord,
  verifySddEvidence,
} from "./evidence.js";
export type {
  AssignmentBranchForms,
  AssignmentFields,
  ComposeDispatchGateOptions,
  ComposeDispatchGateResult,
  DefaultBranchOptions,
  EnforcementFlag,
  EnforcementSource,
  ExecutionModeToNOptions,
  ExecutionModeToNResult,
  ValidateAssignmentFieldsOptions,
} from "./dispatch.js";
export {
  antiRecursionPrecheck,
  assertDefaultBranchProtected,
  assertTriIdentity,
  assignmentHeaderRegion,
  composeDispatchGate,
  executionModeToN,
  isReadOnlyAssignmentRole,
  parseAssignmentBranchForms,
  parseAssignmentFields,
  parseBranchPolicyDirectOnBranch,
  parseEnforcementFlag,
  validateAssignmentFields,
} from "./dispatch.js";
export type {
  BranchProbeOptions,
  L1PreDispatchInput,
  L2PreDispatchInput,
  MainWorktreeInfo,
  QcAlignmentAssignment,
  QcSnapshotAssignment,
  WorktreeTrack,
} from "./worktree.js";
export {
  assertBranchAlignment,
  assertControlVsFeaturePath,
  assertMainWorktreeResidency,
  assertQcAlignment,
  isDistinctCheckout,
  l1PreDispatchCheck,
  l2PreDispatchCheck,
  probeCheckoutRoot,
  readMainWorktree,
  singleReviewSnapshot,
} from "./worktree.js";
export type {
  ImplementerSessionLedger,
  ReviewPackageOptions,
  SddAction,
  SddActionKind,
  SddExecutionContext,
  SddWorkspaceOptions,
  StickyRulesInput,
  StickyRulesResult,
  TaskBriefOptions,
} from "./sdd.js";
export {
  GIT_CAPTURE_MAX_BYTES,
  SddScriptError,
  assertBaseSha,
  checkSddAction,
  implementerSessionStickyRules,
  readProgressLedger,
  resolveSddExecutionContext,
  reviewPackage,
  runInSddContext,
  sddWorkspace,
  taskBrief,
  taskReportExists,
} from "./sdd.js";
export type {
  CatalogCompletenessGap,
  CatalogCompletenessReport,
  CatalogCompletenessRoot,
  CompassDoc,
  PhaseGateOptions,
  PhaseGateResult,
  PhaseTransition,
  SnapshotDoc,
} from "./iteration.js";
export {
  assertCatalogCompleteness,
  evaluatePhaseGate,
  evaluatePostMergeClose,
  parseCompassFrontmatter,
  parseCompassFrontmatterText,
  pushCadenceProbe,
  readCatalogCompleteness,
  validateCompassFrontmatter,
} from "./iteration.js";
export type {
  FindingsCleanupMode,
  ProjectRegisterDoc,
  ProjectRegisterEntry,
  RoadmapFrontmatter,
  RoadmapStatus,
  RoadmapValidation,
} from "./project.js";
export {
  PROJECT_REFERENCES_DIR,
  PROJECT_REGISTER_FILE,
  PROJECT_ROADMAP_FILE,
  ROADMAP_STATUSES,
  _DEFAULT_PROJECT,
  findingsCleanupGate,
  listProjectReferenceFiles,
  validateProjectRegister,
  validateRoadmap,
} from "./project.js";
export type { HarnessDocKind, ValidateStatusWriteDocOptions } from "./gates.js";
export {
  MAX_STATUS_CONTENT_LENGTH,
  eventTargetPaths,
  formatStatusWriteBlockReason,
  harnessDocKindOfTarget,
  validateStatusWriteDoc,
  violationLine,
} from "./gates.js";
export type {
  MigrateNotesFile,
  MigrateOptions,
  MigratePlan,
  MigrateRegister,
  MigrateResult,
  MigrateRoadmap,
  MigrateRootV2,
  MigrateSnapshot,
  MigrateStep,
} from "./migrate.js";
export {
  ARCHIVED_STATUS_V1_FILE,
  MIGRATE_STATUS_FILE,
  NOTES_LEDGER_FILE,
  applyMigratePlan,
  migrateHarnessTree,
} from "./migrate.js";
export type {
  CompletenessItem,
  CompletenessLevel,
  CompletenessPlaceholder,
  CompletenessResult,
  DesignFrontmatter,
} from "./design-md.js";
export {
  assertLightDarkParity,
  completenessLevel,
  parseDesignFrontmatter,
  validateDesignTokenFrontmatter,
} from "./design-md.js";
export type {
  AuditCategory,
  AuditConfidence,
  AuditEffort,
  AuditEvidence,
  AuditFinding,
  AuditPriority,
  AuditRisk,
  AuditSeverity,
  AuditSeverityRank,
  AuditTraceKind,
  AuditTraceStep,
  PromoteAuditPlansOptions,
  RedactResult,
  ScaffoldAuditPlanOptions,
  ScaffoldAuditPlanResult,
  ScannedSecret,
  SecretFinding,
  SupplyChainFinding,
  SupplyChainFindingKind,
  SupplyChainResult,
} from "./audit.js";
export {
  AUDIT_CATEGORIES,
  AUDIT_CONFIDENCES,
  AUDIT_EFFORTS,
  AUDIT_PRIORITIES,
  AUDIT_RISKS,
  promoteAuditPlans,
  scaffoldAuditPlan,
  scanSecrets,
  supplyChainChecks,
  validateAuditFindingGates,
  validateAuditStatusBlocks,
} from "./audit.js";
export {
  KNOWLEDGE_BUG_PROBLEM_TYPES,
  KNOWLEDGE_CATEGORY_MAP,
  KNOWLEDGE_KNOWLEDGE_PROBLEM_TYPES,
  KNOWLEDGE_PROBLEM_TYPES,
  KNOWLEDGE_REQUIRED_FIELDS,
  KNOWLEDGE_RESOLUTION_TYPES,
  KNOWLEDGE_SEVERITIES,
  assertIndexRows,
  assertKnowledgeCatalogCompleteness,
  compoundRefreshScope,
  referenceExists,
  scopeGuard,
  validateSchemaYaml,
} from "./compound.js";
export type { ReferenceCheckResult } from "./compound.js";

export type {
  EphemeralCitation,
  PlanQualityFinding,
  PlanQualityResult,
  ProvenanceCitation,
  SimplifyMarker,
  TemporaryMarker,
  TemporaryMarkerResult,
} from "./lint.js";
export {
  assertSddTddTriple,
  findEphemeralCitations,
  findProvenanceCitations,
  findSimplifyMarkers,
  findTemporaryMarkers,
  lintSkillFrontmatter,
  lintStrategySections,
  planQualityBar,
} from "./lint.js";
export type {
  DevTrackParam,
  QcReviewerParam,
  RoleFamily,
  RoleMappingEntry,
  RoleMappingOptions,
} from "./roles.js";
export {
  DEV_TRACK_PARAMS,
  QC_REVIEWER_PARAMS,
  ROLE_MAPPING,
  SHARED_FAMILIES,
  lintLoadOrder,
  validateRoleMapping,
} from "./roles.js";
export type { DetectResult, HostAdapter, HostId, SkillRootPaths, ToolSignal } from "./host.js";
export { detectHost, resolveSkillRoot } from "./host.js";
export type { FiveQuestionMode, FiveQuestionSection, SkillLintKind, SkillLintProfile } from "./skill-authoring.js";
export {
  classifySkillLint,
  FIVE_QUESTION_SECTIONS,
  RUNTIME_HEADING_ALIASES,
  lintFiveQuestion,
  lintFrontmatter,
  resolveAssetPath,
  stripFrontmatter,
} from "./skill-authoring.js";
export type {
  MergeClass,
  MstarReviewFinding,
  MstarReviewV1,
  PrReportTarget,
  PrReviewSeatPromptOptions,
  PrReviewSizing,
  PrReviewTier,
  PrTierKeyword,
  PrSizeBand,
  PrTallyInput,
  PrTallyResult,
  PrVerdict,
  ResolvePrReviewTierInput,
  ReviewChangesetMode,
  ReviewInlineComment,
  ReviewPostPlan,
  ValidateFindingDocOptions,
} from "./prreview.js";
export {
  MERGE_CLASSES,
  PR_REVIEW_TIER_BUDGETS,
  PR_VERDICTS,
  REVIEW_EMOJI,
  computePrTally,
  pickReviewBranchName,
  planReviewPost,
  preflightChangeset,
  prReviewReportPath,
  prReviewSeatPrompt,
  prReviewSizing,
  resolvePrReviewTier,
  synthesizeReview,
  validateFindingDoc,
  validateMstarReviewV1,
  validatePrReviewReport,
} from "./prreview.js";
export type { QcVerdict } from "./qcreview.js";
export { QC_VERDICTS, validateQcReport } from "./qcreview.js";
export type { ArtifactDoc, ArtifactKind, ArtifactRef, ArtifactStore } from "./store.js";
export { assertFsStorePath, createFsStore, getArtifactStore, loadStoreModule, resolveArtifactPath, setArtifactStore } from "./store.js";

export { collectActiveLifecycleBranches, scanActiveLifecycleBranches, type ActiveLifecycleScan } from "./lifecycle-branches.js";

export { WorkflowSnapshotValidationError } from "./workflow.js";

export {
  CoordinationError,
  EXECUTION_PIN_CONFLICT_CODE,
  ExecutionPinConflictError,
  amendPrepareWorkflow,
  assertExecutionCatalogPin,
  bindPlanSession,
  executionInputHash,
  mutatePlanCoordination,
  readCoordinatedArtifact,
  readExecutionCatalogPin,
  readPlanCoordination,
  readSessionEnvelope,
  replaceCoordinatedArtifact,
  resolvePlanScope,
  resolveProcessHarnessDir,
  showPrepareWorkflow,
} from "./coordination.js";
export type {
  BindPlanSessionInput,
  CatalogExecutionPin,
  CatalogPinAbsence,
  CoordinatedReplacement,
  CoordinationRequest,
  CoordinationResult,
  CoordinationRole,
  CoordinationSession,
  ExecutionCatalogPinState,
  HandoffEvidence,
  PlanCoordinationOperation,
  PlanCoordinationView,
  PlanScopeInput,
  PrepareCoordinationRequest,
  PreparePlanAppend,
  PrepareWorkflowPatch,
  PrepareWorkflowResult,
  PrepareWorkflowView,
  ProgressCoordinationRequest,
  ResidualAddCoordinationRequest,
  ResidualCloseCoordinationRequest,
  ResidualInput,
  ResolvedPlanScope,
  VersionedArtifact,
} from "./coordination.js";
export type { StoreContext, StoreErrorCode, StoreHandle, StoreRuntimeInfo, StoreDb } from "./store-db.js";
// Issue-store boundary: lazily acquires
// `node:sqlite` — importing this index never loads the driver or opens a DB.
export {
  MIGRATION_2_SQL,
  MIGRATIONS,
  MIN_BUN_VERSION,
  MIN_NODE_VERSION,
  SCHEMA_VERSION_TABLE_SQL,
  StoreError,
  assertStoreRuntimeSupported,
  compareVersions,
  detectStoreRuntime,
  initializeStore,
  migrationChecksum,
  openStore,
  storeDbPath,
  upgradeStore,
} from "./store-db.js";
// Execution authority: the canonical value form and `exec-v1` version tokens
// (§3.1), the one-transaction ownership boundary, the create-only empty
// execution initializer (§3/§4.1) and the create-only workflow/registry/sealed
// input verb (§3), plus C4's session surface — the trusted-caller
// coordinator/plan-pm bind and the session-authorized plan read (§2.3/§3).
// ADDITIVE export and the ONLY reachable surface for consumers: the token
// grammar and the transaction primitive stay module-scoped for the domain
// modules that compose with them, and no coordination-mutation, registration
// or coordinator-recovery verb is defined here.
export type {
  ExecutionCaller,
  ExecutionContext,
  ExecutionErrorCode,
  ExecutionKind,
  ExecutionPlanView,
  ExecutionRead,
  ExecutionReceipt,
  ExecutionSessionRef,
  ExecutionState,
  ExecutionToken,
} from "./execution-store.js";
export {
  ExecutionError,
  bindExecutionSession,
  createExecutionWorkflow,
  initializeExecutionAuthority,
  readExecutionPlan,
  readExecutionState,
  serializeExecutionValue,
} from "./execution-store.js";
// §3 the DB plan-operation surface: ONE entry point for the whole closed
// `CoordinationOperation` union — prepare, progress, residual-add,
// residual-close, handoff, accept, return, integration-start,
// integration-accept, complete and reconcile — each with exactly one DB
// transition behind it. Published only once the union was complete, so nothing
// here is a stub: the legacy-only `repair-delivery-source` is refused, and no
// registration API is part of this surface.
// ADDITIVE export and the ONLY reachable surface for consumers: the internal
// dispatch frame and the individual transition bodies stay module-scoped.
export type { CoordinationOperation } from "./execution-coordination.js";
export { mutateExecutionPlan } from "./execution-coordination.js";
// §3 the WORKFLOW-level surface: the closed `WorkflowExecutionOperation` union
// (phase, lifecycle, execution-policy, integration-worktree, delivery) plus the
// explicit coordinator recovery bootstrap — the one transition that replaces a
// crashed/imported/revoked coordinator identity by named stop evidence instead
// of an old credential. Both consume the §3.1 envelope (operation id, session
// reference, exact token) and are exported only once complete.
// ADDITIVE export: the per-kind transition bodies and the pinned-witness
// helpers stay module-scoped.
export type { WorkflowExecutionOperation } from "./execution-workflow.js";
export { mutateExecutionWorkflow, recoverExecutionCoordinator } from "./execution-workflow.js";
export type {
  CaptureInput,
  ClosureEvidence,
  Disposition,
  IssueDetail,
  IssueErrorCode,
  IssueFilter,
  IssueKind,
  IssueLink,
  IssuePage,
  IssueReceipt,
  IssueTriage,
  MutationContext,
  OccurrenceInput,
  TerminalDisposition,
} from "./issue.js";
export {
  IssueError,
  appendOccurrence,
  captureIssue,
  closeIssue,
  getIssue,
  linkIssue,
  listIssues,
  triageIssue,
} from "./issue.js";
// Catalog authority: catalog metadata is
// the DB authority for project/iteration/plan/document identity, locations,
// relations and archived/superseded lifecycle. No execution status, no
// projection, no Markdown index.
export type {
  CatalogDetail,
  CatalogDocumentKind,
  CatalogEntity,
  CatalogEntityInput,
  CatalogEntityKind,
  CatalogEntityPatch,
  CatalogErrorCode,
  CatalogFilter,
  CatalogKey,
  CatalogLifecycle,
  CatalogLink,
  CatalogLinkInput,
  CatalogOperation,
  CatalogPage,
  CatalogReceipt,
  CatalogRelation,
  CatalogRootKind,
} from "./catalog.js";
export {
  CatalogError,
  catalogRootDir,
  getCatalog,
  linkCatalogEntities,
  listCatalog,
  registerCatalogEntity,
  updateCatalogEntity,
} from "./catalog.js";
// Catalog import/discovery/portability: discovery is a read-only proposal,
// import applies a reviewed plan through the catalog domain verbs, export is
// versioned transport. The CLI family
// (contract §2 `mstar catalog ...`) consumes exactly this surface.
export type {
  CatalogExport,
  CatalogImportConflict,
  CatalogImportDrift,
  CatalogImportEntityMapping,
  CatalogImportEntityProposal,
  CatalogImportErrorCode,
  CatalogImportEvidence,
  CatalogImportInput,
  CatalogImportLinkProposal,
  CatalogImportPartialState,
  CatalogImportPlan,
  CatalogImportProvenance,
  CatalogImportReceipt,
  CatalogImportReviewedLink,
  CatalogImportRetirementSection,
  CatalogImportSourceDigest,
  CatalogImportUnknown,
  CatalogImportUnknownCode,
  CatalogImportVerification,
} from "./catalog-import.js";
export {
  CATALOG_EXPORT_VERSION,
  CATALOG_IMPORT_PLAN_VERSION,
  CatalogImportError,
  catalogExportToInputs,
  discoverCatalog,
  exportCatalog,
  importCatalog,
  planCatalogImport,
  verifyCatalogImport,
} from "./catalog-import.js";
// Catalog execution registration journal: the ONE service that registers an
// execution (snapshot + root entry) together with its catalog rows, publishes
// the catalog delta only after the execution registration matches, and
// recovers or visibly refuses a half-written registration (`mstar catalog
// reconcile`). ADDITIVE export: the engine package's exports map is the only
// reachable surface for the CLI transport and for the readers that must
// refuse a pending operation.
export type {
  CatalogExecutionAbort,
  CatalogExecutionBinding,
  CatalogExecutionBindingKind,
  CatalogExecutionCatalogDelta,
  CatalogExecutionKind,
  CatalogExecutionPhase,
  CatalogExecutionReceipt,
  CatalogExecutionRequest,
  CatalogExecutionWorkflow,
  CatalogRegistrationErrorCode,
  CatalogRegistrationState,
  CatalogRevisions,
  PendingCatalogRegistration,
} from "./catalog-registration.js";
export {
  CATALOG_REGISTRATION_JOURNAL_VERSION,
  CatalogRegistrationError,
  abortCatalogExecution,
  assertCatalogExecutionCommitted,
  listPendingCatalogRegistrations,
  readCatalogRevisions,
  reconcileCatalogExecution,
  registerCatalogExecution,
  registerShippedCatalogExecution,
  resolveCatalogRegistrationState,
} from "./catalog-registration.js";
// Disposable execution/roadmap projections: the ONE source-I/O boundary
// (`refreshProjections`) over the JSON execution authority, plus its two
// halves -- the pure validated capture and the atomic publication/last-good
// path. ADDITIVE export: the engine package's exports map is the only
// reachable surface for the store read boundary and for the CLI/dashboard
// transport.
export type {
  ProjectedCompass,
  ProjectedLease,
  ProjectedPlan,
  ProjectedRoadmap,
  ProjectedWorkflow,
  ProjectionCapture,
  ProjectionErrorCode,
  ProjectionFreshness,
  ProjectionMetadata,
  ProjectionRows,
  ProjectionSourceDigest,
  ProjectionSourceKind,
  ProjectionSourceLocation,
  ProjectionSourceState,
  RefreshReport,
  SourceDiagnostic,
} from "./projection.js";
export {
  PROJECTION_FORMAT_VERSION,
  PROJECTION_ROOT_FILE,
  ProjectionError,
  captureProjectionSources,
  publishProjectionCapture,
  refreshProjections,
} from "./projection.js";
// Issue-store read boundary: the ONE read entry for dashboard and rollup
// consumers -- one handle per request, every view query in one read
// transaction, and an honest projection disclosure in the envelope. ADDITIVE
// export: the engine package's exports map is the only reachable surface for
// the CLI transport (`packages/cli/src/store-read.ts`) and for the dashboard
// consumers; no producer surface is changed.
export type {
  CatalogIdentityDTO,
  CompassDTO,
  DashboardBadge,
  DashboardFilters,
  DashboardView,
  DashboardViewData,
  GoalDTO,
  IssueFlow,
  IssueFlowBucket,
  IterationDTO,
  IterationListDTO,
  IterationPlanDTO,
  LeaseDTO,
  MilestoneDTO,
  ReadEnvelope,
  ReadProjection,
  RoadmapDTO,
  StoreReadErrorCode,
  StoreReadQuery,
  WorkflowDTO,
  WorkflowListDTO,
  WorkflowPlanDTO,
} from "./store-read.js";
export { StoreReadError, queryDashboard, queryIssueFlow, withStoreRead } from "./store-read.js";
// Read-only migration planner plus the staged apply/receipt/replay half: the
// migration transport of the store migration protocol (issue contract §7). It
// enumerates the legacy residual registers through the configured project
// resolver, classifies every row against the declared legacy vocabulary,
// embeds the catalog dry-run inventory, and applies a reviewed manifest in one
// transaction with a persistent ID mapping. Preview creates no DB and no
// receipt; retiring the legacy sources is a separate, authorized step.
// ADDITIVE export: the engine package's exports map is the only reachable
// surface for the CLI transport.
export type {
  MigrationEntryMapping,
  MigrationHistoryRow,
  MigrationIdMapping,
  MigrationManifest,
  MigrationReceipt,
  MigrationRetirement,
  MigrationSourceFile,
  MigrationSourceIdentity,
  MigrationUnknown,
  MigrationVocabulary,
  StoreMigrationErrorCode,
} from "./store-migrate.js";
export {
  MIGRATION_MANIFEST_VERSION,
  MIGRATION_VOCABULARY,
  applyStoreMigration,
  migrationManifestHash,
  planStoreMigration,
  StoreMigrationError,
} from "./store-migrate.js";
// Activation barrier, legacy-source retirement and the consistent backup: the
// second half of the §7 protocol (apply≠activate≠retire, D19). `activateStore`
// flips the authority generation atomically against a strict installed-consumer
// attestation, `retireStoreSources` moves exact reviewed bytes under a
// resumable ledger, and `backupStore` records a quiesced `VACUUM INTO` recovery
// point with its identity. ADDITIVE export: the engine package's exports map is
// the only reachable surface for the CLI transport (`packages/cli/`), and the
// migrated verbs are exercised live only in G6's authorized ops window.
export type {
  ActivationAttestation,
  ActivationReceipt,
  AttestationConsumerKind,
  AttestationDisposition,
  BackupExecutionMeta,
  BackupReceipt,
  InstalledConsumerAttestation,
  RetiredRegister,
  RetiredSection,
  RetirementReceipt,
  ReviewedBackupAuthority,
  StoppedSessionAttestation,
  StoreActivationErrorCode,
  StoreAuthorityHandle,
} from "./store-activation.js";
export {
  ACTIVATION_PROTOCOL_VERSION,
  activateStore,
  activationReceiptFor,
  appliedReceiptFor,
  assertAuthorityCurrent,
  assertBackupDescribesStore,
  backupStore,
  currentAuthorityHandle,
  retireStoreSources,
  StoreActivationError,
  validateActivationAttestation,
} from "./store-activation.js";
// Execution migration: the §6 preview and staged apply (plan
// `20260920-activation-migration-recovery`, R1). `previewExecutionMigration`
// reads the legacy workspace as evidence and returns the canonical,
// content-addressed manifest; `applyExecutionMigration` stages every core row
// plus the manifest record in one transaction against a verified recovery
// point. `apply` never activates: staged reads refuse and the JSON route stays
// the sole live execution authority. `executionManifestHash` is exported so a
// caller can hand the reviewed hash back verbatim. ADDITIVE export — the
// engine package's exports map is the only reachable surface for consumers.
export type {
  ExecutionDeferredSurface,
  ExecutionManifest,
  ExecutionMigrationApplyInput,
  ExecutionMigrationInput,
  ExecutionMigrationReceipt,
  ExecutionSourceWitness,
} from "./execution-migrate.js";
export {
  applyExecutionMigration,
  EXECUTION_MIGRATION_MANIFEST_VERSION,
  executionManifestHash,
  previewExecutionMigration,
} from "./execution-migrate.js";
