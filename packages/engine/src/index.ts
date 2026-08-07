/**
 * @mstar-harness/engine — public entry (exports map `.` → `dist/engine.js`).
 *
 * Engine = importable library for deterministic harness checks; the CLI and
 * OpenCode plugin consume it in-process. `path`, `status`, `lease` modules
 * land in later tasks of this slice; `core` is the shared type/version base.
 */
export type { GateResult, Severity, ValidationResult } from "./core.js";
export { SEVERITY_ORDER, readHarnessVersion, readJson, resolveProjectRoot, writeJson } from "./core.js";
