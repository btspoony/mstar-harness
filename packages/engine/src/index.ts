/**
 * @mstar-harness/engine — public entry (exports map `.` → `dist/engine.js`).
 *
 * Engine = importable library for deterministic harness checks; the CLI and
 * OpenCode plugin consume it in-process. `status`, `lease` modules land in
 * later tasks of this slice; `core` is the shared type/version base and
 * `path` implements harness path resolution + scaffold + gitignore checks.
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
