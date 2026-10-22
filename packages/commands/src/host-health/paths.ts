import fs from "node:fs";
import path from "node:path";
import { resolveProjectRoot as engineResolveProjectRoot } from "@mstar-harness/engine";

/** Resolve the project root for CLI operations, preserving its environment precedence. */
export function resolveProjectRoot(): string {
  const candidate = process.env.MSTAR_CLI_PROJECT_ROOT || process.env.INIT_CWD || process.env.PWD;
  if (candidate && candidate.trim()) return path.resolve(candidate);
  return engineResolveProjectRoot();
}

/** Resolve derived paths under a lexical root; symlink containment remains the caller's responsibility. */
export function joinWithinRoot(root: string, ...segments: string[]): string {
  const base = path.resolve(root);
  const resolved = path.resolve(base, ...segments);
  const withinRoot =
    resolved === base ||
    resolved.startsWith(base + path.sep) ||
    (base.endsWith(path.sep) && resolved.startsWith(base));
  if (!withinRoot) throw new Error(`path escapes ${base}: ${segments.join(path.sep)}`);
  return resolved;
}

function findUpPackageRoot(startDir: string, predicate: (manifest: Record<string, unknown>) => boolean): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    try {
      const manifest = JSON.parse(fs.readFileSync(joinWithinRoot(dir, "package.json"), "utf8")) as Record<string, unknown>;
      if (predicate(manifest)) return dir;
    } catch {
      // No parseable package.json at this level; continue to the parent.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function declaresWorkspaces(manifest: Record<string, unknown>): boolean {
  return (
    Array.isArray(manifest.workspaces) ||
    typeof manifest.workspaces === "string" ||
    (manifest.workspaces !== undefined && manifest.workspaces !== null && typeof manifest.workspaces === "object")
  );
}

/** The project root discovered by walking up from one START directory. */
function projectRootFrom(startDir: string): string {
  const monorepoRoot = findUpPackageRoot(startDir, declaresWorkspaces);
  if (monorepoRoot) return monorepoRoot;
  const packageRoot = findUpPackageRoot(startDir, () => true);
  if (packageRoot) return packageRoot;
  return path.resolve(startDir);
}

function resolveCliProjectRoot(): string {
  const override = process.env.MSTAR_CLI_PROJECT_ROOT;
  if (override && override.trim()) return path.resolve(override);
  return projectRootFrom(process.cwd());
}

/**
 * Resolve a relative CLI path argument from the project root; absolute arguments
 * pass through unchanged.
 *
 * `base` is the invocation WORKSPACE: a transport serving another directory (an
 * MCP server launched with `--workspace`, or pinned to a root whose parent
 * anchors the workspace) passes it, so a relative argument is discovered from
 * that checkout instead of this process's own. The CLI passes it too — its
 * `context.cwd` already carries the `MSTAR_CLI_PROJECT_ROOT` override — so the
 * environment pin is read only on the process-global route.
 */
export function resolveCliPath(userPath: string, base?: string): string {
  if (path.isAbsolute(userPath)) return userPath;
  const root = base === undefined ? resolveCliProjectRoot() : projectRootFrom(base);
  return root.endsWith(path.sep) ? root + userPath : root + path.sep + userPath;
}
