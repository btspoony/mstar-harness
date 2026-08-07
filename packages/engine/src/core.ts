import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Severity levels used across harness validation results. Machine SSOT —
 * the skills describe the same values (see `mstar-plan-artifacts` § status
 * and residuals); order is defined by `SEVERITY_ORDER` in the Task 2 core.
 */
export type Severity = "critical" | "high" | "medium" | "low" | "nit";

/**
 * Result of one harness validation check.
 *
 * Placeholder for the Task 2 core module (full shape per
 * `mstar-skill-authoring` § ValidationResult: `{ ok, severity, code, message, fix? }`).
 * Task 2 replaces this module with the real implementation and adds
 * `GateResult`, `readJson`/`writeJson`, `resolveProjectRoot`.
 */
export type ValidationResult = {
  ok: boolean;
  severity: Severity;
  code: string;
  message: string;
  fix?: string;
};

/**
 * Locate the monorepo root `package.json` (`name: "morning-star"`) by walking
 * up from this module. Works from source and from any bundled output layout.
 * simplify: placeholder — Task 2 replaces this with the CLI implementation
 * moved from `packages/cli/src/utils.ts` (import.meta.url-based, then the CLI
 * re-exports it from the engine).
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
 * Read the harness version from the monorepo root `package.json`.
 * The single-version invariant keeps every surface (engine included)
 * aligned with this value.
 */
export function readHarnessVersion(): string {
  const root = findRootPackageJson(dirname(fileURLToPath(import.meta.url)));
  if (!root) return "0.0.0";
  try {
    const pkg = JSON.parse(readFileSync(root, "utf8")) as { version?: string };
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
