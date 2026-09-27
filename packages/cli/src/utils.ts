export { joinWithinRoot, resolveCliPath, resolveProjectRoot } from "@mstar-harness/commands";

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

