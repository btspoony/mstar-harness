/**
 * Single source of truth for version-bearing surfaces.
 *
 * Consumed by `scripts/prepare-release.ts` (bump) and
 * `scripts/validate-release-version.ts` (gate). Keep these two tools reading
 * from ONE list so a release can never validate a surface it failed to bump.
 */

export type VersionSurface = { label: string; path: string };

/** Every manifest/package.json that must carry the harness release version. */
export const VERSION_SURFACES: readonly VersionSurface[] = [
  { label: "monorepo root", path: "package.json" },
  { label: "@mstar-harness/cli", path: "packages/cli/package.json" },
  { label: "@mstar-harness/opencode", path: "packages/opencode/package.json" },
  { label: "@mstar-harness/engine", path: "packages/engine/package.json" },
  { label: "Cursor plugin", path: ".cursor-plugin/plugin.json" },
  { label: "Codex plugin", path: ".codex-plugin/plugin.json" },
  { label: "Kimi plugin", path: ".kimi-plugin/plugin.json" },
  { label: "ZCode plugin", path: ".zcode-plugin/plugin.json" },
  { label: "omp plugin", path: ".omp-plugin/plugin.json" },
  { label: "Claude plugin", path: ".claude-plugin/plugin.json" },
  { label: "Agent Plugins manifest", path: "plugin.json" },
] as const;

/**
 * Changelogs that receive a new release section. Each root changelog carries a
 * version registry table in its head region (before `## [Unreleased]`) that
 * must be bumped; package changelogs have no such table.
 */
export type ChangelogTarget = {
  path: string;
  lang: "en" | "cn";
  pkg: "root" | "cli" | "opencode" | "engine";
  hasRegistryTable: boolean;
};

export const CHANGELOGS: readonly ChangelogTarget[] = [
  { path: "CHANGELOG.md", lang: "en", pkg: "root", hasRegistryTable: true },
  { path: "CHANGELOG_CN.md", lang: "cn", pkg: "root", hasRegistryTable: true },
  { path: "packages/cli/CHANGELOG.md", lang: "en", pkg: "cli", hasRegistryTable: false },
  { path: "packages/opencode/CHANGELOG.md", lang: "en", pkg: "opencode", hasRegistryTable: false },
  { path: "packages/engine/CHANGELOG.md", lang: "en", pkg: "engine", hasRegistryTable: false },
] as const;

/** INSTALL.md ZCode marketplace example carries a quoted version field. */
export const INSTALL_REF = { path: "INSTALL.md" } as const;

export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Release note: v2.0.0 first release attempt failed at install (engine runtime-dep 404);
// engine is now a build-time devDependency (consumers bundle it) — see git history.

// Trusted publishing for @mstar-harness/engine configured 2026-08-08 (registry API).
