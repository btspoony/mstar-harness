import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Severity levels used across harness validation results.
 *
 * Machine SSOT — `mstar-plan-artifacts/references/status-and-residuals.md`
 * § "Residual findings: `severity` (SSOT, machine field)" defines the same
 * five lowercase-English values; `warning` / `Major` / any other value are
 * forbidden in JSON severity fields.
 */
export type Severity = "critical" | "high" | "medium" | "low" | "nit";

/**
 * Total order, heavy → light (spec: status-and-residuals.md § severity):
 * `critical` > `high` > `medium` > `low` > `nit`. `nit` is always lighter
 * than `low` — never invert or equate.
 */
export const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low", "nit"];

/**
 * Result of one harness validation check.
 *
 * Shape per roadmap §8.5 C4:
 * `{ ok: boolean, severity, code, message, fix? }`. v1 enforcement is
 * non-blocking: callers (CLI output readers, host hooks) surface it as a
 * warning, never a hard stop.
 */
export type ValidationResult = {
  ok: boolean;
  severity: Severity;
  code: string;
  message: string;
  fix?: string;
  /**
   * Backward-compat alias codes for the same violation, emitted by the
   * engine's single parser (e.g. the Slice-2 `assignment.presence.*`
   * namespace kept as aliases on the three core Assignment field
   * violations — see `dispatch.requireField`). Consumers keyed off either
   * namespace see exactly ONE violation per missing field.
   */
  aliases?: readonly string[];
};

/**
 * Aggregate of validation checks for one gate (spec: roadmap §8.2 core row).
 * `ok` is the gate verdict over `violations` — a gate with any violation
 * does not pass.
 *
 * `hardBlocked` (Slice 5 / roadmap §8.5 C4 + D2) is the hard-enforcement
 * overlay: `true` when the gate has violations AND the caller requested hard
 * mode via `applyEnforcement`. Absent/`false` means warn-only — the caller
 * may proceed with a warning. A caller that can refuse an action MUST refuse
 * when `hardBlocked === true`.
 */
export type GateResult = {
  ok: boolean;
  violations: ValidationResult[];
  hardBlocked?: boolean;
};

/**
 * Apply hard-enforcement semantics to a gate result (roadmap §8.5 C4/D2):
 * `hardBlocked` is `true` exactly when `hard` is requested AND the gate has
 * violations. `ok` and `violations` are preserved — enforcement is an
 * overlay on the verdict, never a re-validation. When `hard` is false
 * (flag absent/unset) the result is warn-only (`hardBlocked: false`), so
 * rollback is simply unsetting the flag. Returns a NEW result; the input
 * gate is not mutated.
 */
export function applyEnforcement(gate: GateResult, opts: { hard: boolean }): GateResult {
  return { ...gate, hardBlocked: opts.hard && gate.violations.length > 0 };
}

/**
 * Read and parse a JSON document. Missing or empty files read as `{}`
 * (same contract as the CLI helper this consolidates); malformed JSON
 * throws with the file path in the message.
 */
export function readJson(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, "utf8").trim();
  if (!content) return {};
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${(error as Error).message}`);
  }
}

/**
 * Serialize `value` as pretty JSON with a trailing newline and write it
 * atomically: temp file in the same directory, then rename over the target.
 * Creates parent directories as needed; on failure the temp file is removed
 * and the error rethrown, so the target is never partially written.
 *
 * Durability note (qc2 F-013): no fsync before the rename — atomicity (no
 * partial file) is guaranteed by the same-dir temp + rename, but a power
 * loss immediately after rename may lose the write. Acceptable for
 * coordination files (status.json) whose writers re-read + verify the
 * stored state; revisit if the harness moves to a filesystem without
 * rename-atomicity guarantees.
 */
export function writeJson(filePath: string, value: Record<string, unknown>): void {
  const parent = dirname(filePath);
  mkdirSync(parent, { recursive: true });
  const tmp = join(parent, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // temp file already renamed away or never created — nothing to clean
    }
    throw error;
  }
}

/**
 * Resolve the project root by walking up from `startDir` (default: cwd) to
 * the nearest ancestor containing `package.json` or `bun.lock`. Falls back
 * to the resolved `startDir` when no marker exists up to the filesystem root.
 */
export function resolveProjectRoot(startDir: string = process.cwd()): string {
  const start = resolve(startDir);
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "package.json")) || existsSync(join(dir, "bun.lock"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/**
 * Locate the monorepo root `package.json` (`name: "morning-star"`) by walking
 * up from a start directory. Works from source and from any bundled output
 * layout (`import.meta.url` anchors the walk at the module's own location).
 */
function findRootPackageJson(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = resolve(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string };
      if (pkg.name === "morning-star") return candidate;
    } catch {
      // not a parseable manifest — keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the harness version from a module directory: the module's OWN
 * manifest first (`<moduleDir>/../package.json` — always shipped by npm,
 * e.g. `node_modules/@mstar-harness/engine/package.json` next to
 * `dist/engine.js`, or the CLI/opencode package.json next to their bundles),
 * falling back to the monorepo root `morning-star` `package.json` walk.
 * The single-version invariant makes both equivalent in-repo; the
 * own-manifest-first order fixes published installs, where no
 * `morning-star` manifest exists anywhere above `node_modules` and the walk
 * alone would regress to `"0.0.0"` (qc3 F-1).
 */
export function harnessVersionFrom(moduleDir: string): string {
  const ownManifest = join(moduleDir, "..", "package.json");
  try {
    const pkg = JSON.parse(readFileSync(ownManifest, "utf8")) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version !== "") return pkg.version;
  } catch {
    // no own manifest (e.g. source layout without package.json) — fall through
  }
  const root = findRootPackageJson(moduleDir);
  if (!root) return "0.0.0";
  try {
    const pkg = JSON.parse(readFileSync(root, "utf8")) as { version?: string };
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Read the harness version (own-manifest first — see `harnessVersionFrom`).
 *
 * Single source for the harness version inside TS (roadmap §8.5 C6, moved
 * from `packages/cli/src/utils.ts`); the CLI re-exports it unchanged. The
 * single-version invariant keeps root, engine, cli and opencode aligned.
 */
export function readHarnessVersion(): string {
  return harnessVersionFrom(dirname(fileURLToPath(import.meta.url)));
}
