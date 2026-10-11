/**
 * `host-gate-paths` — the single-sourced gate path glue every host write gate
 * used to hand-copy (issue #442): the landing-path resolver and the
 * case-folded issue/catalog authority naming sets.
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
import { readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { isHarnessRootDir, type HarnessDocKind } from "./gates.js";
import { resolveProjectDir, resolveWorkflowDir } from "./path.js";

/** The issue/catalog authority database and its WAL sidecars, directly at a
 * harness root. */
export const STORE_AUTHORITY_FILES: readonly string[] = ["store.db", "store.db-wal", "store.db-shm"];

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

/** True when `target` (absolute) IS the authority database (or a WAL sidecar)
 * sitting directly at a harness root: the runtime's own store location for a
 * harness root is `<harness root>/store.db`, and hand-writing those bytes is
 * never a supported operation — hard vs soft, staged vs active, alias or not,
 * all the same. */
export function isStoreAuthorityTarget(target: string): boolean {
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
