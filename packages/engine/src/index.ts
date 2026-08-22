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
 * implements marker/TDD-triple/plan-quality/frontmatter/STRATEGY checks,
 * `design-md` validates DESIGN.md token frontmatter + light/dark parity +
 * completeness levels, `audit` validates audit Status blocks, redacts
 * secrets and scaffolds audit-<date>/ plan dirs, and `compound` validates
 * knowledge-doc schema, reference existence, index rows and the
 * compound-refresh scope. `roles` validates the role reference mapping +
 * parameter tables and the load-order contract, `host` detects the active
 * host from tool shapes, resolves skill roots and defines the type-only
 * `HostAdapter` contract, and `skill-authoring` lints frontmatter +
 * 5-question bodies and resolves skill-relative asset paths.
 */
export type { GateResult, Severity, ValidationResult } from "./core.js";
export { SEVERITY_ORDER, applyEnforcement, readHarnessVersion, readJson, resolveProjectRoot, writeJson } from "./core.js";
export type { HarnessKind, ResolveHarnessDirOptions, ResolveSpecsDirOptions } from "./path.js";
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
  emitGitignoreSnippet,
  resolveHarnessDir,
  resolveIterationDir,
  resolveKnowledgeDir,
  resolvePlanDir,
  resolveProjectDir,
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
  WorkflowBranchAnchors,
  WorkflowExecutionPolicy,
  WorkflowLifecycleStatus,
  WorkflowLifecycleType,
  WorkflowSnapshot,
} from "./workflow.js";
export {
  WORKFLOW_LIFECYCLE_STATUSES,
  WORKFLOW_LIFECYCLE_TYPES,
  WORKFLOW_SNAPSHOT_FILE,
  WORKFLOW_TERMINAL_STATUSES,
  validateWorkflowSnapshot,
  writeWorkflowSnapshot,
} from "./workflow.js";
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
  QcAlignmentAssignment,
  QcSnapshotAssignment,
  WorktreeTrack,
} from "./worktree.js";
export {
  assertBranchAlignment,
  assertControlVsFeaturePath,
  assertQcAlignment,
  l1PreDispatchCheck,
  l2PreDispatchCheck,
  singleReviewSnapshot,
} from "./worktree.js";
export type {
  ImplementerSessionLedger,
  ReviewPackageOptions,
  SddWorkspaceOptions,
  StickyRulesInput,
  StickyRulesResult,
  TaskBriefOptions,
} from "./sdd.js";
export {
  SddScriptError,
  assertBaseSha,
  implementerSessionStickyRules,
  readProgressLedger,
  reviewPackage,
  sddWorkspace,
  taskBrief,
  taskReportExists,
} from "./sdd.js";
export type {
  CompassDoc,
  PhaseGateOptions,
  PhaseGateResult,
  PhaseTransition,
} from "./iteration.js";
export {
  assertIndexRowObligations,
  evaluatePhaseGate,
  parseCompassFrontmatter,
  parseCompassFrontmatterText,
  pushCadenceProbe,
  validateCompassFrontmatter,
} from "./iteration.js";
export type {
  FindingsCleanupMode,
  ProjectRegisterDoc,
  ProjectRegisterEntry,
  RoadmapFrontmatter,
  RoadmapStatus,
  RoadmapValidation,
  TechDebtCheck,
  TechDebtRollup,
  TechDebtSummary,
} from "./project.js";
export {
  PROJECT_REFERENCES_DIR,
  PROJECT_REGISTER_FILE,
  PROJECT_ROADMAP_FILE,
  ROADMAP_STATUSES,
  _DEFAULT_PROJECT,
  findingsCleanupGate,
  listProjectReferenceFiles,
  techDebtRollup,
  validateProjectRegister,
  validateRoadmap,
} from "./project.js";
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
  AuditEffort,
  AuditFinding,
  AuditPriority,
  AuditRisk,
  PromoteAuditPlansOptions,
  RedactResult,
  ScaffoldAuditPlanOptions,
  ScaffoldAuditPlanResult,
  SecretFinding,
} from "./audit.js";
export {
  AUDIT_CATEGORIES,
  AUDIT_EFFORTS,
  AUDIT_PRIORITIES,
  AUDIT_RISKS,
  promoteAuditPlans,
  scaffoldAuditPlan,
  validateAuditStatusBlocks,
} from "./audit.js";
export type { ReferenceCheckResult } from "./compound.js";
export {
  KNOWLEDGE_BUG_PROBLEM_TYPES,
  KNOWLEDGE_CATEGORY_MAP,
  KNOWLEDGE_KNOWLEDGE_PROBLEM_TYPES,
  KNOWLEDGE_PROBLEM_TYPES,
  KNOWLEDGE_REQUIRED_FIELDS,
  KNOWLEDGE_RESOLUTION_TYPES,
  KNOWLEDGE_SEVERITIES,
  assertIndexRows,
  compoundRefreshScope,
  referenceExists,
  scopeGuard,
  validateSchemaYaml,
} from "./compound.js";

export type {
  EphemeralCitation,
  PlanQualityFinding,
  PlanQualityResult,
  SimplifyMarker,
  TemporaryMarker,
  TemporaryMarkerResult,
} from "./lint.js";
export {
  assertSddTddTriple,
  findEphemeralCitations,
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
export type { FiveQuestionMode, FiveQuestionSection } from "./skill-authoring.js";
export {
  FIVE_QUESTION_SECTIONS,
  RUNTIME_HEADING_ALIASES,
  lintFiveQuestion,
  lintFrontmatter,
  resolveAssetPath,
  stripFrontmatter,
} from "./skill-authoring.js";
