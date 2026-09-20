/**
 * Store-authority route (issue-governance cutover G4b; plan QC fix wave FW-1)
 * — the dsh copy of the authority classification the omp `tool_call` gate
 * (`packages/omp/src/hooks/pre/mstar-gates.ts` Gate 1b) and the ZCode
 * PreToolUse write gate (`hooks/src/mstar-write-gate.ts`) implement. Residual
 * R4 documents the deliberate triplication of this route: the three host
 * entries are separate copies by design (this wave does NOT consolidate them
 * into one home) and MUST keep implementing the same classification
 * semantics.
 *
 * Refusals (UNCONDITIONAL — an authority invariant, not the document-validity
 * axis the hard/soft enforcement flag governs, the dsh
 * `catalogRegistrationVeto` precedent):
 * - `store.direct-write-refused` — a hand write of `{HARNESS_DIR}/store.db`
 *   (or its `-wal`/`-shm` sidecars) directly at a harness root: those bytes
 *   are owned by the runtime;
 * - `project.register.retired` — a register write while an ACTIVE store
 *   answers: the register is migration history;
 * - `store.authority-unavailable` — a register write while the authority
 *   cannot be read at all (below-floor runtime / missing `node:sqlite`
 *   capability / corrupt / drifted / busy): fail-closed, never silently
 *   applied.
 *
 * A register write while the store is missing (`store.not-initialized`) or
 * staged (`store.not-active`) is PRE-activation (issue contract §7): legacy
 * authority is still in force, so the write falls through to the register's
 * document validator — the route returns no refusal for it. This mirrors the
 * dsh G4a fix-round boundary: authority-class refusals are refused outright,
 * readable-authority findings keep the existing repair escape.
 *
 * Authority classification is decided on the path a write really LANDS on
 * (S-G4b-03, omp/ZCode parity): the caller's own path first, then its
 * canonical (symlink-resolved) form — an alias outside the harness tree
 * resolving to a harness-root `store.db` or a retired `residuals.json` is
 * refused like the file itself. Only those two authority decisions are
 * canonicalized; the document lint keeps the caller's path.
 *
 * Authority-NAME matching is CASE-INSENSITIVE (plan QC fix wave FW-3, omp/
 * ZCode parity): on a case-insensitive volume (Darwin/APFS) a case-variant
 * basename (`Store.db`, `RESIDUALS.json`) lands on the same authority bytes
 * and must not bypass the store/register predicates `realpath` does not
 * fold. The document lint keeps its exact-case classification.
 *
 * Module boundary: no barrel and no gates-module cycle — the caller passes
 * its own direct classification (the status gate's `harnessDocKindOfTarget`
 * answer for the session's resolved harness root); this module only reaches
 * the engine's marker-probe classifier for an alias landing outside it. One
 * read envelope (`withStoreRead` + the `issues` view: no projection refresh,
 * no source I/O) is the whole store probe; nothing here re-implements a floor
 * or a refusal the engine already owns. The runtime floor is read from the
 * ACTUAL runtime (engine `detectStoreRuntime` — the Bun global first, never
 * Bun's emulated `process.versions.node`).
 */
import { readlinkSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import {
  assertStoreRuntimeSupported,
  detectStoreRuntime,
  harnessDocKindOfTarget,
  queryDashboard,
  resolveHarnessDir,
  resolveProjectDir,
  resolveWorkflowDir,
  withStoreRead,
} from '@mstar-harness/engine'
import type { StoreRuntimeInfo, ValidationResult } from '@mstar-harness/engine'
import { STATUS_FILE, STORE_DB_FILE } from './_shared.ts'

/** The authority database's WAL sidecars, directly at a harness root. */
const STORE_AUTHORITY_FILES: readonly string[] = [STORE_DB_FILE, `${STORE_DB_FILE}-wal`, `${STORE_DB_FILE}-shm`]

/** Case-folded authority-name matching (FW-3): a case-variant basename of an
 * authority file IS the authority on a case-insensitive volume, so the match
 * never hinges on byte case (mirrored in the omp and ZCode copies). */
const STORE_AUTHORITY_NAMES: readonly string[] = STORE_AUTHORITY_FILES.map((file) => file.toLowerCase())

/** The register file's basename, matched case-insensitively (FW-3). */
const REGISTER_BASENAME = /residuals\.json/i
/** The canonical register shape under the resolved project dir — one project
 * component + the register file — with the file name folded (FW-3). */
const REGISTER_SHAPE = /^[^/]+\/residuals\.json$/i

/** Default v2 layout names of a marker-complete harness root. */
const WORKFLOW_DIR_NAME = 'workflows'
const PROJECT_DIR_NAME = 'projects'

/** Refusal codes (G4b), in the frozen store / `project.register.*` vocabulary. */
export const STORE_DIRECT_WRITE_CODE = 'store.direct-write-refused'
export const STORE_AUTHORITY_UNAVAILABLE_CODE = 'store.authority-unavailable'
export const REGISTER_RETIRED_CODE = 'project.register.retired'

/** A store whose absence positively identifies the PRE-activation state
 * (legacy register authority in force, issue contract §7): missing
 * (`store.not-initialized`) or staged (`store.not-active`). Every other
 * refusal leaves the authority state UNKNOWN and is refused fail-closed. */
const PRE_ACTIVATION_CODES: readonly string[] = ['store.not-initialized', 'store.not-active']

/**
 * Actual-runtime probe seam (test-injectable, omp/ZCode holder pattern): the
 * default reads the ACTUAL runtime through the engine — the Bun global first,
 * so a Bun process is never judged by Bun's EMULATED
 * `process.versions.node`. The invoked entrypoint's own runtime decides.
 */
export const storeRuntimeProbe: { info: () => StoreRuntimeInfo } = { info: detectStoreRuntime }

/** Stable code + message of a thrown refusal (engine `StoreError` /
 * `StoreReadError` carry `code`; anything else is reported as itself). */
function refusalOf(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : ''
  return { code: code === '' ? 'store.authority-unreadable' : code, message }
}

/** What the issue store says about a register target (G4b): `retired` =
 * active store (the register is migration history), `legacy` = no store /
 * staged store (pre-activation, the register is still the live authority),
 * `unavailable` = the authority could not be read and the write fails closed. */
type AuthorityRoute =
  | { kind: 'legacy' }
  | { kind: 'retired'; storeRevision: number }
  | { kind: 'unavailable'; code: string; message: string }

async function readAuthorityRoute(harnessDir: string): Promise<AuthorityRoute> {
  try {
    assertStoreRuntimeSupported(storeRuntimeProbe.info())
  } catch (error) {
    return { kind: 'unavailable', ...refusalOf(error) }
  }
  try {
    const envelope = await withStoreRead({ harnessDir }, queryDashboard('issues', { limit: 1 }))
    return { kind: 'retired', storeRevision: envelope.storeRevision }
  } catch (error) {
    const refusal = refusalOf(error)
    return PRE_ACTIVATION_CODES.includes(refusal.code)
      ? { kind: 'legacy' }
      : { kind: 'unavailable', ...refusal }
  }
}

/** Directory/entry check (never throws — a missing or unreadable path is
 * simply not a marker). */
function hasEntry(dir: string, name: string): boolean {
  try {
    statSync(join(dir, name))
    return true
  } catch {
    return false
  }
}

/** True when `dir` itself is a harness root: the v2 coordination-document
 * markers the gates classify documents with (`status.json` + the layout dirs,
 * custom `.mstarc` dirs honored), or the root the engine resolves from the
 * directory's PARENT (default `.mstar`-style and `.mstarc harness_dir` roots —
 * `resolveHarnessDir(dir)` probes *inside* a directory, so it never answers
 * for the root itself). omp/ZCode `isHarnessRootDir` parity. */
function isHarnessRootDir(dir: string): boolean {
  if (hasEntry(dir, STATUS_FILE)) {
    if (hasEntry(dir, WORKFLOW_DIR_NAME) && hasEntry(dir, PROJECT_DIR_NAME)) return true
    try {
      if (
        hasEntry(resolveWorkflowDir(dir, { harnessDir: dir }), '') &&
        hasEntry(resolveProjectDir(dir, { harnessDir: dir }), '')
      ) {
        return true
      }
    } catch {
      // unreadable layout config — fall through to the parent resolution
    }
  }
  const parentResolved = resolveHarnessDir(dirname(dir))
  return parentResolved !== null && resolve(parentResolved) === dir
}

/** The path a write to `resolved` really lands on (S-G4b-03): authority
 * classification runs on the caller's own path first and on this one when the
 * target is an alias — a symlink outside the harness tree resolving to a
 * harness-root `store.db` / retired `residuals.json` IS that authority file.
 * A dangling symlink resolves to its would-be target: the file a write
 * through the link creates. A fresh (absent) target canonicalizes through its
 * nearest EXISTING ancestor: an ancestor directory symlinked into a harness
 * tree lands the write at the protected destination even though no marker is
 * visible on the textual path, so the classification follows the filesystem
 * there too. One canonicalization per write target (the document lint keeps
 * the caller's path), mirrored in the omp entries and the ZCode hook. */
function landedPathOf(resolved: string): string {
  try {
    return realpathSync(resolved)
  } catch {
    try {
      return resolve(dirname(resolved), readlinkSync(resolved))
    } catch {
      // The target does not exist yet and is not itself a dangling link — but
      // a missing FINAL component can still sit under a symlinked ANCESTOR,
      // and the filesystem lands the write at the canonical destination
      // through that alias. Canonicalize the nearest EXISTING ancestor and
      // rejoin the missing suffix; only a path with no existing ancestor at
      // all keeps the caller's path (a plain fresh file — the path itself
      // decides).
      let dir = dirname(resolved)
      for (;;) {
        try {
          return join(realpathSync(dir), relative(dir, resolved))
        } catch {
          const parent = dirname(dir)
          if (parent === dir) return resolved
          dir = parent
        }
      }
    }
  }
}

/** True when `target` (absolute) IS the authority database (or a WAL sidecar)
 * sitting directly at a harness root: the runtime's own store location for a
 * harness root is `<harness root>/store.db`, and hand-writing those bytes is
 * never a supported operation — hard vs soft, staged vs active, alias or not,
 * all the same. The name match is case-insensitive (FW-3). */
function isStoreAuthorityTarget(target: string): boolean {
  if (!STORE_AUTHORITY_NAMES.includes(basename(target).toLowerCase())) return false
  return isHarnessRootDir(dirname(target))
}

/**
 * The harness root of a register target the exact-case classifiers MISS
 * because its basename is a case variant (`RESIDUALS.json`, FW-3): the
 * canonical register shape (one project component + the register file under
 * the resolved project dir) is matched case-insensitively from the nearest
 * harness root up the tree — the same walk the engine's marker probe runs for
 * exact-case names, so a case-variant register is authority-classified like
 * the file itself. `null` when the basename is not a register name or no
 * ancestor root holds the shape (omp/ZCode parity).
 */
function caseFoldedRegisterRoot(candidate: string): string | null {
  const target = resolve(candidate)
  if (!REGISTER_BASENAME.test(basename(target))) return null
  let dir = dirname(target)
  for (;;) {
    if (isHarnessRootDir(dir)) {
      let projectDir: string
      try {
        projectDir = resolveProjectDir(dir, { harnessDir: dir })
      } catch {
        projectDir = join(dir, PROJECT_DIR_NAME)
      }
      if (REGISTER_SHAPE.test(relative(projectDir, target))) return dir
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** The harness root of the register a write LANDS on through a symlink alias
 * (stricter-wins veto): the landed destination of an alias is itself an
 * authority candidate even when the caller's own path already classified as a
 * register elsewhere — classified by the exact-case marker probe first, then
 * the FW-3 folded shape walk. `null` when the write is not an alias or does
 * not land on a register. */
function landedRegisterDirOf(resolved: string, landed: string): string | null {
  if (landed === resolved) return null
  const aliased = harnessDocKindOfTarget(landed)
  if (aliased?.kind === 'register') return aliased.harnessDir
  return caseFoldedRegisterRoot(landed)
}

/** One refusal as the engine violation shape (the same
 * `[severity] code: message (fix: …)` dialect the engine validators emit). */
function authorityViolation(code: string, message: string): ValidationResult {
  return { ok: false, severity: 'high', code, message }
}

function storeDirectWriteRefusal(targetPath: string): ValidationResult {
  return authorityViolation(
    STORE_DIRECT_WRITE_CODE,
    `${targetPath} is the issue/catalog authority database and is owned by the runtime — a direct ` +
      'hand write is refused (the schema and its WAL are managed in-process). Schema changes go through ' +
      '`mstar store init|upgrade|migrate`, findings through `mstar issue add|close`, catalog rows through ' +
      '`mstar catalog register|update`',
  )
}

function registerRetiredRefusal(storeRevision: number): ValidationResult {
  return authorityViolation(
    REGISTER_RETIRED_CODE,
    'project registers are retired migration history — the issue store ({HARNESS_DIR}/store.db, revision ' +
      `${storeRevision}) is the only findings authority; capture and close through \`mstar plan ` +
      'issue-add|issue-close` (plan-scoped) or `mstar issue add|close` (unscoped). This write is refused',
  )
}

function authorityUnavailableRefusal(route: { code: string; message: string }): ValidationResult {
  return authorityViolation(
    STORE_AUTHORITY_UNAVAILABLE_CODE,
    `the issue authority could not be read ([${route.code}] ${route.message}) — the register write is refused ` +
      'rather than applied against an unreadable authority; no older-runtime or JSON fallback exists',
  )
}

/** Inputs for {@link storeAuthorityRefusals}. */
export interface StoreAuthorityInput {
  /** The session's resolved `{HARNESS_DIR}` (null when the resolver found none). */
  readonly resolvedHarnessDir: string | null
  /**
   * The caller's OWN direct classification of the target against the session's
   * resolved harness root (the status gate's `harnessDocKindOfTarget` answer).
   * A `register` kind routes the write through the DB-aware authority check.
   */
  readonly directKind: 'status' | 'snapshot' | 'register' | null
  /** The raw target path of the write/edit intent. */
  readonly rawPath: string
}

/**
 * The store-authority refusals for ONE fs write/edit target, decided before
 * any document validation (FW-1). Returns the unconditional refusals — the
 * caller vetoes/refuses on any non-empty result in BOTH enforcement modes —
 * or `[]` when the target is not an authority path (including the
 * pre-activation legacy register route, which keeps its document validator).
 *
 * A register reached ONLY through a symlink alias (the landed path differs
 * from the caller's own and the direct classification missed) is classified
 * by the engine's marker probe on the landed path — omp/ZCode parity.
 */
export async function storeAuthorityRefusals(input: StoreAuthorityInput): Promise<ValidationResult[]> {
  const resolved = resolve(input.rawPath)
  const landed = landedPathOf(resolved)
  const storeTarget = isStoreAuthorityTarget(resolved) ? resolved : isStoreAuthorityTarget(landed) ? landed : null
  if (storeTarget !== null) return [storeDirectWriteRefusal(storeTarget)]

  let registerDir: string | null = null
  if (input.directKind === 'register') {
    registerDir = input.resolvedHarnessDir
  } else if (landed !== resolved) {
    const aliased = harnessDocKindOfTarget(landed)
    if (aliased?.kind === 'register') registerDir = aliased.harnessDir
  }
  if (registerDir === null) {
    // FW-3: a case-variant register basename bypasses the exact-case
    // classifiers above — the authority route must not.
    registerDir = caseFoldedRegisterRoot(resolved) ?? (landed !== resolved ? caseFoldedRegisterRoot(landed) : null)
  }
  if (registerDir === null) return []

  const route = await readAuthorityRoute(registerDir)
  if (route.kind === 'retired') return [registerRetiredRefusal(route.storeRevision)]
  if (route.kind === 'unavailable') return [authorityUnavailableRefusal(route)]
  // Stricter-wins veto (RV-2): a legacy fall-through may still LAND on another
  // harness's register through a symlink alias while only the source authority
  // was checked — classify the landed destination too, and its authority
  // refusals veto the legacy fall-through. Both contexts pre-activation keep
  // the legacy route (issue contract §7); the landed store database is already
  // refused by the S-G4b-03 store check above.
  if (route.kind === 'legacy') {
    const landedDir = landedRegisterDirOf(resolved, landed)
    if (landedDir !== null && landedDir !== registerDir) {
      const landedRoute = await readAuthorityRoute(landedDir)
      if (landedRoute.kind === 'retired') return [registerRetiredRefusal(landedRoute.storeRevision)]
      if (landedRoute.kind === 'unavailable') return [authorityUnavailableRefusal(landedRoute)]
    }
  }
  return [] // legacy: pre-activation — the register keeps its document validator
}
