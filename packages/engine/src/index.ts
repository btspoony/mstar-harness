/**
 * @mstar-harness/engine — public entry (exports map `.` → `dist/engine.js`).
 *
 * Engine = importable library for deterministic harness checks; the CLI and
 * OpenCode plugin consume it in-process. `core` grows in Task 2 (path,
 * status, lease modules land in later tasks of this slice).
 */
export type { Severity, ValidationResult } from "./core.js";
export { readHarnessVersion } from "./core.js";
