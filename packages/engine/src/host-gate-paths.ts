/**
 * `host-gate-paths` — the single-sourced gate path glue every host write gate
 * used to hand-copy (issue #442): the landing-path resolver and the
 * authority-naming sets for the two runtime-owned databases (the execution
 * store at a harness root and the user-level collaboration store).
 *
 * The copies had drifted. opencode-v1, omp, dsh and the ZCode hook resolved
 * ONE symlink hop (realpath, else a single `readlinkSync`), while opencode-v2
 * followed the chain — and that drift was a real bypass (#438): a two-link
 * alias chain landed on `store.db` without a refusal in the one-hop hosts.
 * The chained resolver (v2's, the strongest shipped semantics) is therefore
 * the ONE implementation here, and every host imports it.
 *
 * Case-insensitivity is engine policy (plan QC fix wave FW-3): on a
 * case-insensitive volume (Darwin/APFS) a case-variant basename IS the same
 * authority file, so neither the authority-name match nor the
 * coordination-document shape match hinges on byte case.
 *
 * Never throws except {@link landedPathOf}'s deliberate
 * {@link SymlinkResolutionError} on a symlink cycle/overflow — hosts translate
 * that into their own refusal envelope. Enforcement decisions stay with the
 * host; this module only resolves paths and classifies names.
 */
import { readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isHarnessRootDir, type HarnessDocKind } from "./gates.js";
import { resolveProjectDir, resolveWorkflowDir } from "./path.js";

/** The issue/catalog authority database and its SQLite sidecars, directly at a
 * harness root. The rollback journal is included: it is the same bytes under
 * the same names. */
export const STORE_AUTHORITY_FILES: readonly string[] = [
  "store.db",
  "store.db-wal",
  "store.db-shm",
  "store.db-journal",
];

/** The same authority names case-folded — the match never hinges on byte case
 * (FW-3). */
export const STORE_AUTHORITY_NAMES: readonly string[] = STORE_AUTHORITY_FILES.map((name) => name.toLowerCase());

/** The refusal code a host reports when {@link landedPathOf} refuses a symlink
 * chain. Engine-owned so all hosts name the same failure. */
export const SYMLINK_RESOLUTION_REFUSED_CODE = "write.symlink-resolution-refused";

/** Symlink hops followed before refusing a cycle/overflow. */
export const MAX_SYMLINK_HOPS = 8;

const SYMLINK_RESOLUTION_REFUSED_MESSAGE =
  "Unable to resolve the write target because its symlink chain exceeds the supported limit; no write was authorized.";

/** Fail-closed refusal raised by {@link landedPathOf}: the symlink chain is a
 * cycle or exceeds {@link MAX_SYMLINK_HOPS}. Carries the engine code so a host
 * can map it onto its own envelope without importing this class. */
export class SymlinkResolutionError extends Error {
  readonly code = SYMLINK_RESOLUTION_REFUSED_CODE;
  constructor(message: string = SYMLINK_RESOLUTION_REFUSED_MESSAGE) {
    super(message);
    this.name = "SymlinkResolutionError";
  }
}

/** True when `name` (a basename) names the authority database or one of its
 * sidecars, case-insensitively (FW-3). */
export function isStoreAuthorityName(name: string): boolean {
  return STORE_AUTHORITY_NAMES.includes(name.toLowerCase());
}

/** The canonical coordination-document shapes, matched case-insensitively
 * (FW-3). The status rel is against the harness root, the other two against
 * their resolved layout dirs. */
const CASE_FOLDED_SHAPES: Record<HarnessDocKind, RegExp> = {
  status: /^status\.json$/i,
  snapshot: /^[^/]+\/snapshot\.json$/i,
  register: /^[^/]+\/residuals\.json$/i,
};

/** The doc kind a coordination-document basename names, case-insensitively
 * (FW-3), or `null` for anything else. */
function caseFoldedKindOf(name: string): HarnessDocKind | null {
  const folded = name.toLowerCase();
  if (folded === "status.json") return "status";
  if (folded === "snapshot.json") return "snapshot";
  if (folded === "residuals.json") return "register";
  return null;
}

/** The path a write to `filePath` really LANDS on. Existing aliases and
 * dangling symlink chains are followed hop by hop, then the nearest EXISTING
 * ancestor is canonicalized and the missing suffix rejoined (a fresh target
 * under a symlinked ancestor dir lands at the alias destination; a path with
 * no existing ancestor at all keeps the caller's path). A chain longer than
 * {@link MAX_SYMLINK_HOPS} (a cycle) refuses fail-closed instead of hanging or
 * silently landing somewhere unclassified.
 *
 * Exactly one canonicalization per checked target: the document lint keeps
 * the caller's path, only the authority classification follows the alias. */
export function landedPathOf(filePath: string): string {
  let probe = resolve(filePath);
  const suffix: string[] = [];
  let symlinkHops = 0;
  for (;;) {
    try {
      return resolve(realpathSync(probe), ...suffix);
    } catch {
      let linkTarget: string;
      try {
        linkTarget = readlinkSync(probe);
      } catch {
        const parent = dirname(probe);
        if (parent === probe) return resolve(filePath);
        suffix.unshift(basename(probe));
        probe = parent;
        continue;
      }
      if (symlinkHops >= MAX_SYMLINK_HOPS) throw new SymlinkResolutionError();
      symlinkHops++;
      probe = resolve(dirname(probe), linkTarget);
    }
  }
}

/** The user-level collaboration database and its SQLite sidecars. They are
 * authority bytes only inside the canonical `<home>/.mstar/repos` namespace. */
const COLLABORATION_AUTHORITY_NAMES: readonly string[] = [
  "collaboration.db",
  "collaboration.db-wal",
  "collaboration.db-shm",
  "collaboration.db-journal",
];

/** True when `dir` is strictly below `root` (both absolute). */
function isBelow(root: string, dir: string): boolean {
  const rel = relative(root, dir);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The landed location of `candidate`, or `null` when its symlink chain refuses;
 * that target already earns a fail-closed refusal from the host's own landed
 * resolution, so classification only drops the unusable spelling here. */
function landedOrNull(candidate: string): string | null {
  try {
    return landedPathOf(candidate);
  } catch {
    return null;
  }
}

/** Deepest entry mapped below the namespace. Depth counts the namespace as 1, so
 * `<host>/<owner...>/<repo>` is depth 4 and the bound allows three nested owner
 * segments. */
const MAX_NAMESPACE_DEPTH = 6;

/** Entries one reverse-index walk visits before it stops. */
const MAX_NAMESPACE_SCAN_ENTRIES = 512;

/** Physical repository directories of the canonical namespace. A repository
 * directory is `<host>/<owner...>/<repo>`, so every entry at that depth belongs
 * to some repository's physical extent; a symlinked entry is mapped at its
 * landed target, which is exactly where a physical-path write would land. The
 * walk never leaves the namespace, stops on depth and entry budget, and a
 * visited set makes a symlink cycle terminate.
 *
 * simplify: repository directories deeper than MAX_NAMESPACE_DEPTH are not
 * mapped; widen the bound when a nested-owner layout exceeds it. */
function namespaceRepositoryDirs(userHome: string): string[] {
  const namespace = landedOrNull(resolve(userHome, ".mstar", "repos"));
  if (namespace === null) return [];
  const found: string[] = [];
  const visited = new Set<string>();
  let budget = MAX_NAMESPACE_SCAN_ENTRIES;
  const walk = (dir: string, depth: number, host: string | null): void => {
    if (depth > MAX_NAMESPACE_DEPTH || budget <= 0 || visited.has(dir)) return;
    visited.add(dir);
    if (depth >= 4 || (depth === 3 && host === "_id")) found.push(dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    budget -= entries.length;
    for (const entry of entries) {
      const child = join(dir, entry.name);
      const childHost = depth === 1 ? entry.name : host;
      if (entry.isDirectory()) {
        walk(child, depth + 1, childHost);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      const landed = landedOrNull(child);
      if (landed === null) continue;
      try {
        if (!statSync(landed).isDirectory()) continue;
      } catch {
        continue;
      }
      walk(landed, depth + 1, childHost);
    }
  };
  walk(namespace, 1, null);
  return found;
}

/** True when `dir` lands on a namespace repository directory. Without this a
 * repository directory symlinked out of the namespace would be writable through
 * its physical-only path, which no spelling of the namespace covers. */
function isReverseMappedRepository(dir: string, userHome: string): boolean {
  const physical = landedOrNull(dir);
  if (physical === null) return false;
  return namespaceRepositoryDirs(userHome).includes(physical);
}

/** True when `dir` names a location inside the canonical collaboration
 * namespace. The namespace itself is reachable through symlinks — a user home,
 * `~/.mstar` or `repos` moved elsewhere — so the configured
 * `<home>/.mstar/repos` spelling and its landed twin both count, and the target
 * is judged in both spellings too (callers pass requested and landed paths
 * alike). A repository directory below the namespace that is a symlink is also
 * mapped back from its physical path. A same-named file outside every spelling
 * — a checkout's own `.mstar`, or `repos-archive/` beside the namespace — is not
 * authority bytes. */
function isInCollaborationNamespace(dir: string, userHome: string): boolean {
  const configured = resolve(userHome, ".mstar", "repos");
  const landedNamespace = landedOrNull(configured);
  const landedDir = landedOrNull(dir);
  const roots =
    landedNamespace === null || landedNamespace === configured ? [configured] : [configured, landedNamespace];
  const targets = landedDir === null || landedDir === dir ? [dir] : [dir, landedDir];
  return roots.some((root) => targets.some((target) => isBelow(root, target))) || isReverseMappedRepository(dir, userHome);
}

/** True when `target` is the collaboration database (or one of its sidecars)
 * inside the canonical user-level namespace. */
function isCollaborationAuthorityTarget(target: string, userHome: string): boolean {
  if (!COLLABORATION_AUTHORITY_NAMES.includes(basename(target).toLowerCase())) return false;
  return isInCollaborationNamespace(resolve(dirname(target)), userHome);
}

/** True when `target` (absolute) IS runtime-owned database bytes: the execution
 * authority database (or a SQLite sidecar) sitting directly at a harness root —
 * the runtime's own store location for a harness root is `<harness root>/store.db`
 * — or the user-level collaboration database inside the canonical
 * `<home>/.mstar/repos` namespace, however that namespace is symlinked. Hand-
 * writing either is never a supported operation — hard vs soft, staged vs
 * active, alias or not, all the same. */
export function isStoreAuthorityTarget(target: string): boolean {
  if (isCollaborationAuthorityTarget(target, homedir())) return true;
  if (!isStoreAuthorityName(basename(target))) return false;
  return isHarnessRootDir(dirname(target));
}

/** The case-folded coordination-document classification the exact-case
 * `harnessDocKindOfTarget` misses because a basename is a case variant
 * (`STATUS.json` / `RESIDUALS.json`, FW-3): the canonical shape is matched
 * against the nearest ancestor harness root up the tree — the same walk the
 * engine's exact-case marker probe runs — so a case-variant document is
 * classified like the file itself. `null` when the basename is not a
 * coordination document or no ancestor root holds the shape. */
export function caseFoldedDocKind(candidate: string): { harnessDir: string; kind: HarnessDocKind } | null {
  const target = resolve(candidate);
  const name = basename(target);
  const kind = caseFoldedKindOf(name);
  if (kind === null) return null;
  let dir = dirname(target);
  for (;;) {
    if (isHarnessRootDir(dir)) {
      let base = dir;
      if (kind !== "status") {
        try {
          base =
            kind === "snapshot"
              ? resolveWorkflowDir(dir, { harnessDir: dir })
              : resolveProjectDir(dir, { harnessDir: dir });
        } catch {
          base = resolve(dir, kind === "snapshot" ? "workflows" : "projects");
        }
      }
      if (CASE_FOLDED_SHAPES[kind].test(relative(base, target))) return { harnessDir: dir, kind };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The harness root of a case-variant register the exact-case classifiers miss
 * (FW-3) — {@link caseFoldedDocKind} restricted to the register kind. `null`
 * when the basename is not a register name or no ancestor root holds the
 * canonical register shape. */
export function caseFoldedRegisterRoot(candidate: string): string | null {
  const doc = caseFoldedDocKind(candidate);
  return doc?.kind === "register" ? doc.harnessDir : null;
}
