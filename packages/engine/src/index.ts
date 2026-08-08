/**
 * @mstar-harness/engine — public entry (exports map `.` → `dist/engine.js`).
 *
 * Engine = importable library for deterministic harness checks; the CLI and
 * OpenCode plugin consume it in-process. `core` is the shared type/version
 * base, `path` implements harness path resolution + scaffold + gitignore
 * checks, `status` implements the status.json schema, residual lifecycle,
 * findings-cleanup gate and the tech-debt rollup port, `lease` implements
 * the execution/merge lease state machines + same-host status write lock,
 * and `dispatch` implements the Assignment field contract, default-branch
 * gate, QC seat mapping and tri-identity/anti-recursion prechecks.
 */
export type { GateResult, Severity, ValidationResult } from "./core.js";
export { SEVERITY_ORDER, readHarnessVersion, readJson, resolveProjectRoot, writeJson } from "./core.js";
export type { HarnessKind, ResolveHarnessDirOptions, ResolveSpecsDirOptions } from "./path.js";
export {
  assertPlanWritingPath,
  emitGitignoreSnippet,
  resolveHarnessDir,
  resolveIterationDir,
  resolvePlanDir,
  resolveSddDir,
  resolveSpecsDir,
  scaffoldHarness,
  validateGitignore,
} from "./path.js";
export type {
  ArchiveResult,
  FindingsCleanupMode,
  PlanRow,
  ResidualEntry,
  StatusDoc,
  TechDebtCheck,
  TechDebtRollup,
  TechDebtSummary,
} from "./status.js";
export {
  archiveResiduals,
  findingsCleanupGate,
  normalizeSeverity,
  techDebtRollup,
  validatePlanRow,
  validateResidual,
  validateStatus,
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
  AssignmentBranchForms,
  AssignmentFields,
  DefaultBranchOptions,
  ExecutionModeToNOptions,
  ExecutionModeToNResult,
  ValidateAssignmentFieldsOptions,
} from "./dispatch.js";
export {
  antiRecursionPrecheck,
  assertDefaultBranchProtected,
  assertTriIdentity,
  executionModeToN,
  isReadOnlyAssignmentRole,
  parseAssignmentBranchForms,
  parseAssignmentFields,
  parseBranchPolicyDirectOnBranch,
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
  pushCadenceProbe,
  validateCompassFrontmatter,
} from "./iteration.js";
export type {
  PlanQualityFinding,
  PlanQualityResult,
  SimplifyMarker,
  TemporaryMarker,
  TemporaryMarkerResult,
} from "./lint.js";
export {
  assertSddTddTriple,
  findSimplifyMarkers,
  findTemporaryMarkers,
  lintSkillFrontmatter,
  lintStrategySections,
  planQualityBar,
} from "./lint.js";
