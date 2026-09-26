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

function resolveCliProjectRoot(): string {
  const override = process.env.MSTAR_CLI_PROJECT_ROOT;
  if (override && override.trim()) return path.resolve(override);
  const monorepoRoot = findUpPackageRoot(process.cwd(), declaresWorkspaces);
  if (monorepoRoot) return monorepoRoot;
  const packageRoot = findUpPackageRoot(process.cwd(), () => true);
  if (packageRoot) return packageRoot;
  return process.cwd();
}

/** Resolve a relative CLI path argument from the project root; absolute arguments pass through unchanged. */
export function resolveCliPath(userPath: string): string {
  if (path.isAbsolute(userPath)) return userPath;
  const root = resolveCliProjectRoot();
  return root.endsWith(path.sep) ? root + userPath : root + path.sep + userPath;
}
