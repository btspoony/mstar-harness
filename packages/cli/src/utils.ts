import fs from "node:fs";
import path from "node:path";
import { resolveProjectRoot as engineResolveProjectRoot } from "@mstar-harness/engine";

// Moved to `@mstar-harness/engine` core (roadmap §8.2 / §8.5 C6) — re-exported
// unchanged so existing adapter callers keep working:
// - readHarnessVersion: single source for the harness version (root morning-star
//   package.json); zcode.ts marketplace entry generation depends on it.
// - readJson / writeJson: same contract as the previous local helpers; writeJson
//   now writes atomically (temp + rename).
export { readHarnessVersion, readJson, writeJson } from "@mstar-harness/engine";

export function normalizeModelList(raw: string) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseCsv(raw?: string) {
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function ensureObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

/**
 * Resolve the project root for CLI operations.
 *
 * Env-var precedence is CLI-specific and preserved from the previous local
 * implementation: `MSTAR_CLI_PROJECT_ROOT` is set by the root `cli:dev` script,
 * and npm sets `INIT_CWD` to the invocation directory when the process cwd is
 * rewritten (e.g. `npm run --prefix …`); bun never sets `INIT_CWD` — `bun run
 * --cwd …` rewrites `PWD` to the package dir instead, so under bun the chain
 * bottoms out at `PWD` (see adapters/codex.ts). Without an env override, fall
 * back to the engine's walk-up resolution (nearest ancestor containing
 * `package.json` or `bun.lock`).
 */
export function resolveProjectRoot() {
  const candidate = process.env.MSTAR_CLI_PROJECT_ROOT || process.env.INIT_CWD || process.env.PWD;
  if (candidate && candidate.trim()) return path.resolve(candidate);
  return engineResolveProjectRoot();
}

/**
 * Nearest ancestor of `startDir` whose `package.json` parses and matches
 * `predicate`, or null when no ancestor has a parseable manifest (up to the
 * filesystem root).
 */
function findUpPackageRoot(startDir: string, predicate: (manifest: Record<string, unknown>) => boolean): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>;
      if (predicate(manifest)) return dir;
    } catch {
      // no parseable package.json at this level — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** True for a manifest that declares a `workspaces` field (array, string, or object). */
function declaresWorkspaces(manifest: Record<string, unknown>): boolean {
  return (
    Array.isArray(manifest.workspaces) ||
    typeof manifest.workspaces === "string" ||
    (manifest.workspaces !== undefined && manifest.workspaces !== null && typeof manifest.workspaces === "object")
  );
}

/**
 * Workspace/project root for relative CLI path args.
 *
 * Contract (plan 002-cli-project-root-paths, PM amendment 2026-08-16):
 *   1. `MSTAR_CLI_PROJECT_ROOT` env override (set by the root `cli:dev`
 *      wrapper), else
 *   2. nearest ancestor `package.json` declaring `workspaces` (monorepo root
 *      marker), else
 *   3. nearest ancestor `package.json` (single-package project root), else
 *   4. process cwd (cwd-relative terminal fallback outside any
 *      package.json tree).
 * The earlier env-chain `INIT_CWD`/`PWD` intermediates are deliberately
 * absent: bun never sets `INIT_CWD` (an npm convention) and `bun run
 * --cwd <pkg>` rewrites `PWD` to the package dir, so those intermediates
 * cannot distinguish root-wrapper from nested-package invocation.
 */
function resolveCliProjectRoot(): string {
  const override = process.env.MSTAR_CLI_PROJECT_ROOT;
  if (override && override.trim()) return path.resolve(override);
  const monorepoRoot = findUpPackageRoot(process.cwd(), declaresWorkspaces);
  if (monorepoRoot) return monorepoRoot;
  const packageRoot = findUpPackageRoot(process.cwd(), () => true);
  if (packageRoot) return packageRoot;
  return process.cwd();
}

/**
 * Resolve a user-supplied CLI path argument against the workspace/project
 * root (see `resolveCliProjectRoot`), so documented dev-command path args
 * (e.g. `skill lint skills/mstar-audit`) work from any process cwd, not
 * only the repo root (audit-002 CLI project-root paths). Absolute paths are
 * returned unchanged.
 */
export function resolveCliPath(userPath: string) {
  if (path.isAbsolute(userPath)) return userPath;
  return path.resolve(resolveCliProjectRoot(), userPath);
}
