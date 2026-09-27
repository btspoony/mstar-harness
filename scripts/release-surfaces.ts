/**
 * Single source of truth for version-bearing surfaces.
 *
 * Consumed by `scripts/prepare-release.ts` (bump) and
 * `scripts/validate-release-version.ts` (gate). Keep these two tools reading
 * from ONE list so a release can never validate a surface it failed to bump.
 */

export type VersionSurface = {
  label: string;
  path: string;
  /**
   * Dotted locator to the version field inside the JSON document
   * (array indices as numeric segments, e.g. `"plugins.0.version"`).
   * Defaults to `"version"` (root-level) when omitted.
   */
  versionPath?: string;
};

/** Default version locator when a surface omits `versionPath`. */
export const DEFAULT_VERSION_PATH = "version";

/**
 * Read the version at a dotted locator path (`"a.b.0.c"`; array indices are
 * numeric segments). Returns `undefined` when any segment is missing or the
 * leaf is not a non-empty string. Single definition site shared by the
 * prepare bump and the validate gate.
 */
export function readVersionAt(json: unknown, versionPath: string): string | undefined {
  let node: unknown = json;
  for (const seg of versionPath.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return typeof node === "string" && node !== "" ? node : undefined;
}

// --- raw-text locator (bump side of readVersionAt) -------------------------
// These helpers walk raw JSON text that callers have already JSON.parse-
// validated, so structural malformation is impossible by contract; only the
// locator resolution itself can fail (returning -1 / undefined).

function skipWs(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/** Index just past the JSON string literal opening at `i` (`"` required); -1 when unterminated. */
function skipString(text: string, i: number): number {
  i++;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i++;
  }
  return -1;
}

/** Index just past the complete JSON value opening at `i`; -1 when malformed. */
function skipValue(text: string, i: number): number {
  const c = text[i];
  if (c === '"') return skipString(text, i);
  if (c !== "{" && c !== "[") {
    const m = /^[^,}\]\s]+/.exec(text.slice(i));
    return m ? i + m[0].length : -1;
  }
  let depth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = skipString(text, i);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      i++;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * Locate the exact string-literal span (`[start, end)`, quotes included) of
 * `versionPath` in raw JSON text — the bump-side counterpart of
 * `readVersionAt`. Structural walk (string- and escape-aware), so a
 * coincidental `"version": "<oldV>"` inside a string value or under an
 * earlier key can never match. Returns `undefined` when any segment is
 * missing, out of range, or the leaf is not a JSON string; callers fail loud.
 */
export function locateVersionSpan(text: string, versionPath: string): [number, number] | undefined {
  let i = skipWs(text, 0);
  const segs = versionPath.split(".");
  for (let s = 0; s < segs.length; s++) {
    const last = s === segs.length - 1;
    if (/^\d+$/.test(segs[s])) {
      // array index segment
      if (text[i] !== "[") return undefined;
      i = skipWs(text, i + 1);
      const want = parseInt(segs[s], 10);
      for (let k = 0; k < want; k++) {
        if (text[i] === "]") return undefined; // fewer elements than the index
        const after = skipValue(text, i);
        if (after === -1) return undefined;
        i = skipWs(text, after);
        if (text[i] !== ",") return undefined;
        i = skipWs(text, i + 1);
      }
      if (text[i] === "]") return undefined; // index out of range
    } else {
      // object key segment
      if (text[i] !== "{") return undefined;
      i = skipWs(text, i + 1);
      for (;;) {
        if (text[i] === "}") return undefined; // key absent
        if (text[i] !== '"') return undefined;
        const keyEnd = skipString(text, i);
        if (keyEnd === -1) return undefined;
        let key: unknown;
        try {
          key = JSON.parse(text.slice(i, keyEnd));
        } catch {
          return undefined;
        }
        i = skipWs(text, keyEnd);
        if (text[i] !== ":") return undefined;
        i = skipWs(text, i + 1);
        if (key === segs[s]) break;
        const after = skipValue(text, i);
        if (after === -1) return undefined;
        i = skipWs(text, after);
        if (text[i] !== ",") return undefined;
        i = skipWs(text, i + 1);
      }
    }
    if (last) {
      if (text[i] !== '"') return undefined; // leaf must be a JSON string
      const end = skipString(text, i);
      if (end === -1) return undefined;
      return [i, end];
    }
    // more segments remain: the value must be a container to descend into
    if (text[i] !== "{" && text[i] !== "[") return undefined;
  }
  return undefined;
}

/** Every manifest/package.json that must carry the harness release version. */
export const VERSION_SURFACES: readonly VersionSurface[] = [
  { label: "monorepo root", path: "package.json" },
  { label: "@mstar-harness/cli", path: "packages/cli/package.json" },
  { label: "@mstar-harness/opencode", path: "packages/opencode/package.json" },
  { label: "@mstar-harness/engine", path: "packages/engine/package.json" },
  { label: "@mstar-harness/commands", path: "packages/commands/package.json" },
  { label: "@mstar-harness/mcp", path: "packages/mcp/package.json" },
  { label: "@mstar-harness/dsh", path: "packages/dsh/package.json" },
  { label: "@mstar-harness/omp", path: "packages/omp/package.json" },
  { label: "Cursor plugin", path: ".cursor-plugin/plugin.json" },
  { label: "Codex plugin", path: ".codex-plugin/plugin.json" },
  { label: "Kimi plugin", path: ".kimi-plugin/plugin.json" },
  { label: "ZCode plugin", path: ".zcode-plugin/plugin.json" },
  { label: "omp plugin", path: ".omp-plugin/plugin.json" },
  { label: "Claude plugin", path: ".claude-plugin/plugin.json" },
  { label: "Agent Plugins manifest", path: "plugin.json" },
  { label: "Claude marketplace manifest", path: ".claude-plugin/marketplace.json", versionPath: "plugins.0.version" },
  { label: "ZCode marketplace manifest", path: "marketplace.json", versionPath: "plugins.0.version" },
] as const;

/**
 * Changelogs that receive a new release section.
 */
export type ChangelogTarget = {
  path: string;
  lang: "en" | "cn";
  pkg: "root" | "cli" | "opencode" | "engine" | "commands" | "mcp" | "dsh" | "omp";
};

export const CHANGELOGS: readonly ChangelogTarget[] = [
  { path: "CHANGELOG.md", lang: "en", pkg: "root" },
  { path: "CHANGELOG_CN.md", lang: "cn", pkg: "root" },
  { path: "packages/cli/CHANGELOG.md", lang: "en", pkg: "cli" },
  { path: "packages/opencode/CHANGELOG.md", lang: "en", pkg: "opencode" },
  { path: "packages/engine/CHANGELOG.md", lang: "en", pkg: "engine" },
  { path: "packages/commands/CHANGELOG.md", lang: "en", pkg: "commands" },
  { path: "packages/mcp/CHANGELOG.md", lang: "en", pkg: "mcp" },
  { path: "packages/dsh/CHANGELOG.md", lang: "en", pkg: "dsh" },
  { path: "packages/omp/CHANGELOG.md", lang: "en", pkg: "omp" },
] as const;

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
