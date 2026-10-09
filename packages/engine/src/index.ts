/**
 * @mstar-harness/engine — public entry (exports map `.` → `dist/engine.js`).
 *
 * Engine = importable library for deterministic harness checks; the CLI and
 * OpenCode plugin consume it in-process. `core` is the shared type/version
 * base, `path` implements harness path resolution + scaffold + gitignore
 * checks, `status` implements the status.json schema, residual lifecycle,
 * findings-cleanup gate and the tech-debt rollup port, `lease` implements the
 * workflow integration merge mutex + same-host status write lock, `dispatch`
 * implements the Assignment field contract, default-branch
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
export type {
  RoadmapContent,
  RoadmapExpected,
  RoadmapImportReview,
  RoadmapRecord,
  RoadmapRead,
  RoadmapWriteReceipt,
  RoadmapOperation,
} from "./roadmap-store.js";
export {
  RoadmapError,
  importRoadmapAuthority,
  listRoadmapAuthority,
  readRoadmapAuthority,
  readRoadmapAuthorityOn,
  replaceRoadmapAuthority,
  reviewRoadmapImport,
} from "./roadmap-store.js";
export { parseRoadmapContent } from "./roadmap-content.js";
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
export { STATUS_V2_PAYLOAD_SCHEMA } from "./status.js";

export {
  normalizeSeverity,
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
export type { IntegrationMergeLease } from "./lease.js";
export { validateIntegrationMergeLease, withStatusWriteLock } from "./lease.js";
export type {
  DeliveryRegistrationEvidence,
  RegisterIterationWorkflowOptions,
  RegisterPlanWorkflowOptions,
  WorkflowCompoundOutcome,
  WorkflowDeliveryEvidence,
  WorkflowDeliveryKind,
  WorkflowExecutionPolicy,
  WorkflowLifecycleStatus,
  WorkflowLifecycleType,
  WorkflowSnapshot,
} from "./workflow.js";
export {
  assertDeliveryRegistrationCoherence,
  consultDeliveryEvidence,
  isTerminalSnapshot,
  LEGACY_WORKTREE_PATH_CODE,
  deliveryEvidenceViolations,
  normalizeIterationCompassRef,
  WORKFLOW_DELIVERY_KINDS,
  WORKFLOW_LIFECYCLE_STATUSES,
  WORKFLOW_LIFECYCLE_TYPES,
  WORKFLOW_SNAPSHOT_FILE,
  WORKFLOW_TERMINAL_STATUSES,
  validateWorkflowSnapshot,
} from "./workflow.js";
export { WORKFLOW_SNAPSHOT_PAYLOAD_SCHEMA } from "./workflow.js";

// Lifecycle-phase derivation (S3/E06a) and the terminal outcome a close records
// (S3/E12b): the three phase labels a document's own facts derive to, the code
// of the reader's derived-phase diagnostic, the ONE derivation the file
// producer, the catalog journal and the derived Prepare view share, and the
// outcome a caller names on a close. Re-exported so T03/T09 consume the sparse
// registration intent and the derived phase instead of re-deriving either, and
// so a transport can type the terminal outcome it passes. ADDITIVE export.
export type { CloseWorkflowOutcome, DerivedPlanRegistration, LifecyclePhaseDerivation } from "./workflow.js";
export {
  CLOSE_PHASE,
  DERIVED_PHASE_CODE,
  EXECUTE_PHASE,
  PREPARE_PHASE,
  deriveLifecyclePhase,
  derivePlanRegistration,
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
  evaluatePostMergeCloseFromExecutionAuthority,
  readRegisteredWorkflowFromExecutionAuthority,
  parseCompassFrontmatter,
  parseCompassFrontmatterText,
  pushCadenceProbe,
  readCatalogCompleteness,
  validateCompassFrontmatter,
} from "./iteration.js";
export type {
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
  listAuditPlanIds,
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
export { MSTAR_REVIEW_V1_PAYLOAD_SCHEMA } from "./qcreview.js";

export type { ArtifactDoc, ArtifactKind, ArtifactRef, ArtifactStore } from "./store.js";
export { persistPayloadContracts, PERSIST_PAYLOAD_CONTRACTS } from "./coordination.js";

export { assertFsStorePath, createFsStore, getArtifactStore, guardInjectedStore, loadStoreModule, resolveArtifactPath, setArtifactStore } from "./store.js";

export { activeLifecyclePlanId, collectActiveLifecycleBranches } from "./lifecycle-branches.js";
export type { ActiveLifecycleBranch } from "./lifecycle-branches.js";

export { WorkflowSnapshotValidationError } from "./workflow.js";

// Adapter-only execution identity (prerequisite contract §3.1): one shared
// tuple + scope validator every adapter and later DB consumer imports instead
// of declaring a second shape.
export type { ExecutionIdentity, ExecutionIdentityOptions, ExecutionIdentityRole, ExecutionIdentityScope } from "./session-identity.js";
export { SESSION_ID_MAX_LENGTH, assertSafeSessionId, validateExecutionIdentity } from "./session-identity.js";

export {
  CoordinationError,
  EXECUTION_PIN_CONFLICT_CODE,
  ExecutionPinConflictError,
  executionInputHash,
  readCoordinatedArtifact,
  readExecutionCatalogPin,
  replaceCoordinatedArtifact,
  resolveProcessHarnessDir,
} from "./coordination.js";
export type {
  CatalogExecutionPin,
  CatalogPinAbsence,
  CoordinationRole,
  CoordinatedReplacement,
  ExecutionCatalogPinState,
  PlanCoordinationOperation,
  ResidualInput,
  VersionedArtifact,
} from "./coordination.js";
// The retired FILE route's envelope bytes: the migration importer and the
// not-yet-cut issue-domain authorization read them as import sources, never as
// authority. The shape + one byte-witness reader live in `coordination-envelope`.
export { readSessionEnvelope } from "./coordination-envelope.js";
export type { CoordinationSession } from "./coordination-envelope.js";
export type {
  CompletionEvidence,
  CompletionRecord,
  IntegrationResultInput,
  PlanPrepareConfig,
  PlanProgress,
  PreparedCoordination,
  RowCoordination,
  QaGate,
  FindingsCleanupMode,
} from "./coordination-write.js";
export type { RootAssociation } from "./coordination.js";
export { resolveIntentRoot, resolveIntentTarget } from "./coordination.js";
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
export { rowValidationRoute } from "./workflow.js";
export { upgradeStoreMinimal, type MinimalStoreUpgradeResult } from "./store-upgrade-minimal.js";
// Coordinator-only execution authority: version tokens, registration,
// current coordinator binding and required workflow/plan reads.
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
  adoptTerminalWorkflow,
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
// Coordinator-only direct plan operation union and transition entrypoint.
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
export { mutateExecutionWorkflow, recoverExecutionCoordinator, workflowExecutionPolicyViolations } from "./execution-workflow.js";
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
  IssueReopen,
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
  assertIssueLinkVocabulary,
  assertIssueTriageVocabulary,
  captureIssue,
  closeIssue,
  getIssue,
  linkIssue,
  listIssues,
  reopenIssue,
  reopenIssueOn,
  triageIssue,
  assignIssueMilestone,
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
  PendingCatalogRegistration,
  PurgeCatalogRegistrationReceipt,
} from "./catalog-registration.js";
export {
  CATALOG_REGISTRATION_JOURNAL_VERSION,
  CatalogRegistrationError,
  abortCatalogExecution,
  listPendingCatalogRegistrations,
  readCatalogRevisions,
  purgeCatalogRegistration,
} from "./catalog-registration.js";
export { registerShippedCatalogExecution } from "./execution-registration.js";
// §7 the ACTIVE registration route: the ONE verb that publishes a reviewed
// catalog delta together with the execution lifecycle it registers.
// `registerShippedCatalogExecution` (execution-registration.ts) composes onto
// the atomic `commitExecutionRegistration`, deriving the root creation token
// and catalog revision internally; identity is transport-resolved. The
// journaled file-registration route and its `prepared` phase are retired —
// recovery for legacy journals is `catalog reconcile --abort` /
// `catalog purge-registration`, never adoption.
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
export { readExecutionAuthority, readExecutionCleanupState } from "./execution-read.js";
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
  ProjectedWorkflow,
  ProjectionCapture,
  ProjectionErrorCode,
  ProjectionFreshness,
  ProjectionMetadata,
  ProjectionRows,
  ProjectionSourceDigest,
  ProjectionSourceKind,
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
// and cannot answer refuses instead of falling back. `resolveCurrentAuthority`
// is that route decision as a value (S2/E02): the durable authority generation
// a DB-route caller re-asserts before it commits. ADDITIVE export: the engine
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
  IssueFlow,
  IssueFlowBucket,
  IterationDTO,
  IterationListDTO,
  IterationPlanDTO,
  LeaseDTO,
  MilestoneDTO,
  ProjectListDTO,
  ProjectListItem,
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
  resolveCurrentAuthority,
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
  CONSUMER_KINDS,
  DISPOSITIONS,
  SESSION_STATES,
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
// Execution disaster recovery: standalone store-backup inspection, explicit
// whole-store restore from that image, and live-state diagnostic export.
// `previewExecutionRestore` is read-only; `restoreExecutionBackup` verifies
// the operator-approved loss digest and backup before replacing the store;
// `exportExecutionState` emits canonical reporting data without session
// identity or credential paths. `inspectBackupCopy` is shared by backup and
// restore validation. The package export map is the public surface.
export type { BackupInspection } from "./store-activation.js";
export type {
  ProjectMilestoneStatus,
  ProjectMilestoneDTO,
  MilestoneAssignment,
  MilestoneAdd,
  MilestonePatch,
  MilestoneMutation,
  MilestoneReceipt,
  MilestoneIssueDTO,
  MilestoneRead,
} from "./milestone-store.js";
export {
  MilestoneError,
  addMilestone,
  updateMilestone,
  readMilestonesOn,
  queryMilestones,
} from "./milestone-store.js";
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
// Recovery-first intent contract (S1): the sparse `IntentContext` a public
// lifecycle operation accepts, the `RecoveryProblem`/`RecoveryDetails`
// sidecar it reports (`recovery` on success, `error.details.recoveryFacts` on a
// refusal) and the shared per-operation semantic selections
// (`PLAN_OPERATION_SEMANTICS` / `WORKFLOW_OPERATION_SEMANTICS`,
// `selectSemanticFields`) the freshness/replay frames compare instead of
// whole-document hashes. The same module carries the resolution vocabulary a
// sparse caller reads back — `RootResolution` / `TargetResolution` /
// `AuthorityVerdict` and the `resolvedFrom` / `warnings` element shapes (S2/E02)
// — while `unresolvedRecovery` stays module-scoped: only the engine constructs
// that sidecar, a consumer reads it. Types and the selection table land here
// before any caller widens; ADDITIVE export — the engine package's exports map
// is the only reachable surface for consumers.
export type {
  AuthorityRoute,
  AuthorityVerdict,
  IntentContext,
  RecoveryDetails,
  RecoveryProblem,
  ResolutionSource,
  ResolutionWarning,
  RootResolution,
  SemanticSelection,
  TargetResolution,
} from "./recovery-intent.js";
export {
  PLAN_OPERATION_SEMANTICS,
  selectSemanticFields,
  WORKFLOW_OPERATION_SEMANTICS,
} from "./recovery-intent.js";
