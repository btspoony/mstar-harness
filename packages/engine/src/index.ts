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
  hasHarnessRootDeclaration,
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
// The one registered-plan path contract (prerequisite contract §4): iteration
// registration, the catalog registration preflight, the Prepare append and the
// readiness readers import THIS resolver instead of restating the
// `{PLAN_DIR}/<plan-id>.md` convention — one parser, one refusal type.
export type { PlanPathRefusalCode, RegisteredPlanFile, RegisteredPlanFileInput } from "./plan-path.js";
export { PlanPathError, planDeclaredHeaders, resolveRegisteredPlanFile } from "./plan-path.js";
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

// Adapter-only execution identity (prerequisite contract §3.1): one shared
// tuple + scope validator every adapter and later DB consumer imports instead
// of declaring a second shape.
export type { ExecutionIdentity, ExecutionIdentityRole, ExecutionIdentityScope } from "./session-identity.js";
export { SESSION_ID_MAX_LENGTH, assertSafeSessionId, validateExecutionIdentity } from "./session-identity.js";

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
  recoverPrepareCoordinator,
  showPrepareCoordinatorRecovery,
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
  PrepareCoordinatorRecoveryBlocker,
  PrepareCoordinatorRecoveryReceipt,
  PrepareCoordinatorRecoveryView,
  PreparePlanAppend,
  PreparePlanFileCorrection,
  PrepareWorkflowPatch,
  PrepareWorkflowResult,
  PrepareWorkflowView,
  ProgressCoordinationRequest,
  RecoverPrepareCoordinatorResult,
  ResidualAddCoordinationRequest,
  ResidualCloseCoordinationRequest,
  ResidualInput,
  ResolvedPlanScope,
  VersionedArtifact,
} from "./coordination.js";
export type { StoreContext, StoreErrorCode, StoreHandle, StoreRuntimeInfo, StoreDb } from "./store-db.js";
// Issue-store boundary: lazily acquires
// `node:sqlite` — importing this index never loads the driver or opens a DB.
//
// `assertExecutionFileReadAllowed` is the §4.3 paired READ guard, exported
// ADDITIVELY (its write sibling stays module-scoped): a consumer whose source
// read is synchronous (a gate that cannot become async) must be able to refuse
// in place — the primary spec §4.3 contract "legacy root/snapshot authority
// readers must call it; no overlooked source reader may return stale leftover
// JSON as authoritative success". Re-exporting the ONE implementation is what
// keeps a caller from writing a second, drifting authority probe.
export {
  MIGRATION_2_SQL,
  MIGRATIONS,
  MIN_BUN_VERSION,
  MIN_NODE_VERSION,
  SCHEMA_VERSION_TABLE_SQL,
  StoreError,
  assertExecutionFileReadAllowed,
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
export type { ExecutionBinding } from "./execution-session.js";
export {
  assertExecutionSessionCurrent,
  createLocalExecutionIdentity,
  decodeExecutionSessionRef,
  encodeExecutionSessionRef,
  executionContextFor,
  resumeExecutionSession,
} from "./execution-session.js";
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
  IssuePayloadName,
  PayloadFieldSchema,
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
  ISSUE_PAYLOAD_SCHEMAS,
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
// §7 the ACTIVE registration route: the ONE verb that publishes a reviewed
// catalog delta together with the execution lifecycle it registers. It is the
// DB-transport sibling of `registerCatalogExecution` and shares every reviewed
// derivation with it (`resolveCatalogExecutionPlan`, the workflow entry, the
// catalog domain's handle-taking verbs); what differs is the boundary — one
// `BEGIN IMMEDIATE` transaction over the workflow header, registry membership,
// plan rows, sealed inputs, catalog delta, binding and committed receipt, with
// no JSON registration file and no intermediate `prepared` phase ever written.
// ADDITIVE export: the composed admission frame stays module-scoped, and the
// legacy journal remains the only file-route entry point.
export { commitExecutionRegistration } from "./execution-registration.js";
// §5 the single source READ adapter: one read transaction, an exact
// workflow/plan address and the token of the scope that was actually read
// (root / workflow / plan). `legacy` and `staged` keep the unchanged file
// route — which the route helper below reports — while a store that exists and
// cannot answer (corrupt, drifted, busy, unsupported) is always a refusal.
// ADDITIVE export: the DB adapter, the consumer route decision and the
// selection type are the whole published surface; the stored-row assembly and
// the token grammar stay module-scoped in `execution-store.ts`.
export type { ExecutionReadSelection } from "./execution-read.js";
export { readExecutionAuthority } from "./execution-read.js";
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
// transaction, and an honest projection disclosure in the envelope. It also
// carries the §5 execution-SOURCE route decision (`resolveExecutionReadRoute` /
// `readExecutionSource`): the DB adapter answers an ACTIVE authority, the
// pre-activation file route stays file-authoritative, and a store that exists
// and cannot answer refuses instead of falling back. ADDITIVE export: the engine
// package's exports map is the only reachable surface for the CLI transport
// (`packages/cli/src/store-read.ts`) and for the dashboard consumers; no
// producer surface is changed.
export type {
  CatalogIdentityDTO,
  CompassDTO,
  DashboardBadge,
  DashboardFilters,
  DashboardView,
  DashboardViewData,
  ExecutionReadRoute,
  ExecutionSourceRead,
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
export {
  StoreReadError,
  queryDashboard,
  queryIssueFlow,
  readExecutionSource,
  resolveExecutionReadRoute,
  withStoreRead,
} from "./store-read.js";
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
// Execution migration: the executable §6 protocol (stages R1-R3). R1 landed
// the read-only preview and the staged apply: `previewExecutionMigration` reads
// the legacy workspace as evidence (plus the explicit operator inventory named
// by `inventoryPath`) and returns the canonical, content-addressed version 2
// manifest with its exact per-surface source assignment;
// `applyExecutionMigration` stages every core row plus the manifest record and
// the validated coverage in one transaction against a verified recovery point,
// and never activates. R2 adds the three separate crash-safe steps:
// `activateExecutionMigration` takes the §4.2 maintenance → root → workflow lock
// ladder and RECOMPUTES the coverage from the named bytes, requiring it to equal
// BOTH the digest the operator approved and the set recorded at staging, before
// it performs the single store-wide all-or-nothing cutover (one epoch advance,
// imported references revoked, held ownership represented); a deferred (2b)
// surface is diagnostic evidence only and is never an activation
// precondition. `retireExecutionSources` moves the exact core sources and the
// `retire`-disposition session envelopes into manifest-addressed history under a
// resumable, fsynced per-item ledger, and `abortExecutionMigration` returns a
// STAGED manifest to legacy without touching active data.
// `collectExecutionCoverage` is the read-only coverage collector,
// `executionManifestHash` is exported so a caller can hand the reviewed hash
// back verbatim. ADDITIVE export - the engine package's exports map is the only
// reachable surface for consumers.
export type {
  ExecutionDeferredSurface,
  ExecutionManifest,
  ExecutionManifestDocument,
  ExecutionManifestSurface,
  ExecutionMigrationAbortInput,
  ExecutionMigrationActivationInput,
  ExecutionMigrationApplyInput,
  ExecutionMigrationCoverageInput,
  ExecutionMigrationHostSession,
  ExecutionMigrationInput,
  ExecutionMigrationInventory,
  ExecutionMigrationReceipt,
  ExecutionMigrationRetireInput,
  ExecutionMigrationRoots,
  ExecutionSourceWitness,
  HostDiscoveryProof,
} from "./execution-migrate.js";
export {
  abortExecutionMigration,
  activateExecutionMigration,
  applyExecutionMigration,
  collectExecutionCoverage,
  EXECUTION_MIGRATION_INVENTORY_VERSION,
  EXECUTION_MIGRATION_LEGACY_MANIFEST_VERSION,
  EXECUTION_MIGRATION_MANIFEST_VERSION,
  executionManifestHash,
  previewExecutionMigration,
  retireExecutionSources,
} from "./execution-migrate.js";
// §4.1/§4.2 the pure coverage substrate (C2): the closed 18-surface inventory,
// the canonical receipt/codec table, the producer entry point C3 builds its
// receipts with and the one validator every boundary closes through. ADDITIVE
// export — the engine package's exports map is the only reachable surface for
// the migration transport (`collectExecutionCoverage`) and for consumers that
// must recompute a receipt.
export type {
  ConsumerDiscoveryProof,
  CoverageWitness,
  ExecutionCoverageEvidence,
  ExecutionCoverageManifest,
  ExecutionCoverageReceipt,
  ExecutionCoverageSet,
  ExecutionSurface,
} from "./execution-coverage.js";
export {
  EXECUTION_COVERAGE_SURFACES,
  buildExecutionCoverageReceipt,
  coverageWitnessKey,
  executionCoverageDigest,
  executionCoverageSurfaceScope,
  validateExecutionCoverage,
} from "./execution-coverage.js";
// §5 F1 the retained workflow-notes ledger: the append-only accepted-record
// writer plus its pure coverage normalizer. ADDITIVE export — the accepted
// record shape, its receipt and the coverage facts are the whole published
// surface, and the write path stays behind the engine's own authorization.
export type {
  WorkflowNote,
  WorkflowNoteAcceptedRecord,
  WorkflowNoteAppendReceipt,
  WorkflowNoteHistoricalRecord,
  WorkflowNotesCoverageFacts,
} from "./execution-ledgers.js";
export {
  ExecutionLedgerError,
  EXECUTION_LEDGER_ERROR_CODES,
  appendWorkflowNote,
  normalizeWorkflowNotesCoverage,
  workflowNotesLedgerPath,
} from "./execution-ledgers.js";
// Execution recovery: the consistent whole-store backup, the explicit-loss
// atomic restore and the diagnostic export (primary spec §8, R3 of the
// migration protocol). `previewExecutionRestore` is the
// read-only loss inventory whose canonical `lossDigest` an operator approves;
// `restoreExecutionBackup` is the whole-store replacement that requires that
// exact digest, a quiesced store, a current pre-restore recovery point and a
// verified sibling image before it renames anything; `exportExecutionState` is
// canonical diagnostic data with every session identity, CAS token and
// credential path removed and no import verb. `inspectBackupCopy` and
// `BackupInspection` are the ONE §8 copy verdict the backup, migration and
// restore paths share. ADDITIVE export — the engine package's exports map is
// the only reachable surface for consumers.
export type { BackupInspection } from "./store-activation.js";
export type {
  ExecutionDiagnosticExport,
  ExecutionRecoveryAuthorityDifference,
  ExecutionRecoveryErrorCode,
  ExecutionRecoveryPreview,
  ExecutionRestoreReceipt,
} from "./execution-recovery.js";
export {
  ExecutionRecoveryError,
  EXECUTION_RECOVERY_PROTOCOL_VERSION,
  exportExecutionState,
  previewExecutionRestore,
  restoreExecutionBackup,
} from "./execution-recovery.js";
