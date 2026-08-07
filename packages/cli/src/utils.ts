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
 * rewritten (e.g. `bun run --cwd …`, see adapters/codex.ts). Without an env
 * override, fall back to the engine's walk-up resolution (nearest ancestor
 * containing `package.json` or `bun.lock`).
 */
export function resolveProjectRoot() {
  const candidate = process.env.MSTAR_CLI_PROJECT_ROOT || process.env.INIT_CWD || process.env.PWD;
  if (candidate && candidate.trim()) return path.resolve(candidate);
  return engineResolveProjectRoot();
}
