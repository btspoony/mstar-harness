import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The CLI package whose manifest owns the values these readers expose. */
export const CLI_PACKAGE_NAME = "@mstar-harness/cli";

/** The CLI manifest's own namespaced metadata map. */
const CLI_METADATA_KEY = "mstar";

/**
 * CLI manifests a bundled consumer can see, most specific first: the manifest
 * beside this module's published layout (the CLI inlines this package into its
 * own bundle, so `dist/…` sits under the CLI package root), then every ancestor
 * directory — which covers a repo checkout (`packages/commands/src/…` and
 * `packages/commands/dist`) and a test process with no CLI on disk.
 */
export function cliManifestCandidates(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [];
  let dir = moduleDir;
  for (let depth = 0; depth < 8; depth += 1) {
    // A published layout puts the CLI manifest at the package root (one level up
    // from `dist`); a checkout keeps it beside this package (`packages/cli`).
    candidates.push(
      path.join(dir, "..", "package.json"),
      path.join(dir, "package.json"),
      path.join(dir, "cli", "package.json"),
    );
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...new Set(candidates)];
}

/**
 * A value under the CLI manifest's `mstar` map, read at runtime and never
 * compiled in. `null` when no visible manifest declares the key: a packaging
 * context that copies the built artifact alone has no manifest beside it, and
 * the caller reports what it could not resolve instead of inventing a value.
 */
export function readCliManifestField(key: string): string | null {
  for (const manifestPath of cliManifestCandidates()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      continue; // unreadable or unparseable manifest — try the next candidate
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const manifest = parsed as Record<string, unknown>; // parsed JSON; every read below is narrowed
    if (manifest["name"] !== CLI_PACKAGE_NAME) continue;
    const metadata = manifest[CLI_METADATA_KEY];
    if (metadata === null || typeof metadata !== "object" || !(key in metadata)) continue;
    const value = (metadata as Record<string, unknown>)[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}
