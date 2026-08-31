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
  { label: "@mstar-harness/dsh", path: "packages/dsh/package.json" },
  { label: "Cursor plugin", path: ".cursor-plugin/plugin.json" },
  { label: "Codex plugin", path: ".codex-plugin/plugin.json" },
  { label: "Kimi plugin", path: ".kimi-plugin/plugin.json" },
  { label: "ZCode plugin", path: ".zcode-plugin/plugin.json" },
  { label: "omp plugin", path: ".omp-plugin/plugin.json" },
  { label: "Claude plugin", path: ".claude-plugin/plugin.json" },
  { label: "Agent Plugins manifest", path: "plugin.json" },
] as const;

/**
 * Changelogs that receive a new release section.
 */
export type ChangelogTarget = {
  path: string;
  lang: "en" | "cn";
  pkg: "root" | "cli" | "opencode" | "engine" | "dsh";
};

export const CHANGELOGS: readonly ChangelogTarget[] = [
  { path: "CHANGELOG.md", lang: "en", pkg: "root" },
  { path: "CHANGELOG_CN.md", lang: "cn", pkg: "root" },
  { path: "packages/cli/CHANGELOG.md", lang: "en", pkg: "cli" },
  { path: "packages/opencode/CHANGELOG.md", lang: "en", pkg: "opencode" },
  { path: "packages/engine/CHANGELOG.md", lang: "en", pkg: "engine" },
  { path: "packages/dsh/CHANGELOG.md", lang: "en", pkg: "dsh" },
] as const;

/** INSTALL.md ZCode marketplace example carries a quoted version field. */
export const INSTALL_REF = { path: "INSTALL.md" } as const;

/**
 * Release version regex — `X.Y.Z` with an optional semver prerelease suffix
 * (`-alpha.1`). Anchored; no `+build` metadata support (not needed for
 * releases). Shared by prepare (version gate) and validate (tag gate).
 *
 * Prerelease identifiers follow semver 2.0.0 §9: dot-separated, each either
 * a numeric identifier without leading zeros (`0` or `[1-9]\d*`) or an
 * alphanumeric identifier containing at least one non-digit. Empty
 * identifiers (`alpha..1`), leading-zero numerics (`alpha.01`), and
 * identifiers starting with `.` (`-.alpha`) are rejected.
 */
export const RELEASE_VERSION_RE =
  /^\d+\.\d+\.\d+(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

/** True iff the version carries a prerelease suffix (contains `-`). */
export function isPrereleaseVersion(v: string): boolean {
  return v.includes("-");
}

export function compareSemver(a: string, b: string): number {
  const [coreA, preA] = splitVersion(a);
  const [coreB, preB] = splitVersion(b);
  const coreDiff = compareCore(coreA, coreB);
  if (coreDiff !== 0) return coreDiff;
  return comparePrerelease(preA, preB);
}

/** Split `X.Y.Z[-pre]` into its core and optional prerelease parts. */
function splitVersion(v: string): [string, string | undefined] {
  const dash = v.indexOf("-");
  if (dash === -1) return [v, undefined];
  return [v.slice(0, dash), v.slice(dash + 1)];
}

function compareCore(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Semver 2.0.0 §11 prerelease precedence: identifiers compared left-to-right,
 * numeric numerically, alphanumeric ASCII-lexically, numeric < alphanumeric,
 * shorter identifier list < longer with the same prefix. A version without a
 * prerelease outranks any prerelease of the same core.
 */
function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const ia = a.split(".");
  const ib = b.split(".");
  const n = Math.min(ia.length, ib.length);
  for (let i = 0; i < n; i++) {
    const d = compareIdentifier(ia[i], ib[i]);
    if (d !== 0) return d;
  }
  return ia.length - ib.length;
}

function compareIdentifier(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const na = BigInt(a);
    const nb = BigInt(b);
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  if (aNum) return -1; // numeric identifiers sort before alphanumeric
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0; // ASCII lexicographic
}

// Release note: v2.0.0 first release attempt failed at install (engine runtime-dep 404);
// engine is now a build-time devDependency (consumers bundle it) — see git history.

// Trusted publishing for @mstar-harness/engine configured 2026-08-08 (registry API).
