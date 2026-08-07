/**
 * @mstar-harness/engine — public entry (exports map `.` → `dist/engine.js`).
 *
 * Engine = importable library for deterministic harness checks; the CLI and
 * OpenCode plugin consume it in-process. `core` is the shared type/version
 * base, `path` implements harness path resolution + scaffold + gitignore
 * checks, `status` implements the status.json schema, residual lifecycle,
 * findings-cleanup gate and the tech-debt rollup port, and `lease` implements
 * the execution/merge lease state machines + same-host status write lock.
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
