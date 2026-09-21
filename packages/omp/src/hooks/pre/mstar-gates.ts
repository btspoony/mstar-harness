/**
 * mstar-gates — omp `tool_call` pre-hook: blocking enforcement gate for
 * harness coordination-document writes and task dispatches.
 *
 * Loaded by omp as a plugin extension module at session startup (one module,
 * one handler — registration order within a module is stable). The factory
 * registers exactly ONE `tool_call` handler; the handler returns
 * `{ block: true, reason }` when `Enforcement: hard` governs the event
 * (repo-level `.mstarc`/compass `enforcement: hard`, or the Assignment-header
 * `Enforcement: hard` per dispatch entry) AND engine validation produced
 * violations — or when the event targets an issue/catalog authority path or a
 * coordination document the execution authority has retired, which refuse
 * unconditionally (see Gate 1 below). Soft-mode dispatch
 * violations are warn-logged through the
 * extension logger (opencode parity — the pre-#156 silent drop is why the
 * self-type/empty-binding pincer stayed latent for five iterations); soft
 * coordination-write violations stay a silent pass. Everything else returns
 * `undefined`.
 *
 * Gate 1 (writes) targets the three v3 coordination documents (compass
 * ruling 7 — hard cutover): the v2 root `{HARNESS_DIR}/status.json`,
 * workflow snapshots `{HARNESS_DIR}/workflows/<id>/snapshot.json` and
 * project registers `{HARNESS_DIR}/projects/<id>/residuals.json`.
 *
 * Gate 1 additionally protects the issue/catalog AUTHORITY paths (G4b):
 * a raw write to `{HARNESS_DIR}/store.db` (or its `-wal`/`-shm`) is
 * refused outright — the runtime owns those bytes — and a write to a
 * project register is routed through the DB-aware authority check
 * (`readAuthorityRoute`): a store-backed workspace has retired the
 * register (`project.register.retired`), an unreadable authority refuses
 * fail-closed (`store.authority-unavailable`), and only a workspace whose
 * store is missing or still staged — pre-activation, legacy authority in
 * force — falls through to the register's document validator
 * (`project.validateProjectRegister`). Both authority refusals are
 * unconditional: they are an authority invariant, not the document-validity
 * axis the hard/soft enforcement flag governs (dsh `catalogRegistrationVeto`
 * precedent). The runtime floor is read from the ACTUAL runtime
 * (engine `detectStoreRuntime` — the Bun global first, never Bun's emulated
 * `process.versions.node`) and asserted in-process through the engine
 * before the store is touched.
 *
 * Gate 1 ALSO refuses a write to a coordination document the EXECUTION
 * authority has retired (source readiness, plan S3): while
 * `{HARNESS_DIR}/store.db` records an ACTIVE execution authority, the root
 * `status.json` and the workflow snapshots are no longer a persistence route
 * (primary spec §4.3), so persisting them — valid bytes or not — is refused
 * `execution.direct-write-refused`, and a store that exists and cannot be read
 * refuses fail-closed. The decision is the engine's own route
 * (`resolveExecutionReadRoute`, plan S2), never a second authority probe; the
 * project register keeps its issue-domain route above, and a harness with no
 * store at all keeps the unchanged file path (§2.1: absence is not an
 * authority verdict).
 *
 * Authority classification is decided on the path a write really LANDS on
 * (S-G4b-03): the caller's path first, then its canonical
 * (symlink-resolved) form — an alias outside the harness tree resolving to a
 * harness-root `store.db` or a retired `residuals.json` is refused like the
 * file itself. Only those two authority decisions are canonicalized; the
 * document lint and every non-authority target keep the caller's path — the
 * execution-retirement refusal belongs to the document lint's own target set,
 * so it follows the caller's path as well, while the engine's own file writers
 * are guarded independently of the path they were handed
 * (`assertExecutionFileWriteAllowed`, primary spec §4.3).
 *
 * Gate-1 core lives in the engine (`@mstar-harness/engine` `gates` module
 * — target classification, content/edit validation, reason formatting;
 * cross-host hooks contract D1): omp imports the shared
 * glue, and so does the ZCode write gate — one classification path, no
 * per-host hand copies. The engine is INLINED into this bundle at build
 * (no bare `@mstar-harness/engine` import survives; asserted by the
 * bundle smoke), so the former lazy loaders for the P1 validators and dir
 * resolvers are removed: a stale engine dist now FAILS the omp build
 * instead of silently degrading (versioned divergence, changelogged) — a
 * strictly safer failure.
 *
 * Hard invariant — NEVER throw, NEVER block on failure: omp fails CLOSED
 * (`{ block: true, reason: "Extension <path> failed: …" }`) when a handler
 * throws or times out, so the handler catches every unexpected error and
 * degrades to a silent pass. A broken engine import or a malformed event
 * passes — hard-gate opt-in is per compass / Assignment, never global, and
 * Invalid JSON
 * in write content is NOT a silent pass: Gate 1 reports it as
 * `status.invalid-json` (same shape as the engine's own unparseable-file
 * violation), which can block under a hard compass. A content-less write to
 * a gated document that does not exist yet (fresh scaffold/init) passes
 * silently, mirroring opencode `validateStatusWrite`'s existsSync guard.
 * Size guard ( extended per S-d): content strings beyond
 * ~2MB AND on-disk gated documents beyond ~2MB (the edit path, which carries
 * no content string) are skipped without parsing — a pathologically large
 * write must not approach omp's 30s handler timeout (fail-CLOSED in soft
 * mode); the oversized write/edit passes silently (documented degradation,
 * same as other content-glue limits).
 *
 * No semantic fork: every rule check is an engine call (the gates module's
 * shared classification/validation/reason-formatting path,
 * dispatch.composeDispatchGate —
 * the single shared host dispatch-gate composition —
 * status.resolveRepoEnforcement …). Local
 * code is shape-guards (task wire-shape
 * extraction) and the host-supplied skill pointer — the same composition
 * `packages/opencode/src/mstar.ts`
 * `validateStatusWrite` / `validateDispatchAssignment` uses, with omp's
 * `{ block, reason }` refusal channel instead of the log channel.
 */
import { readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  assertStoreRuntimeSupported,
  detectStoreRuntime,
  eventTargetPaths,
  formatStatusWriteBlockReason,
  harnessDocKindOfTarget,
  isReadOnlyAssignmentRole,
  parseAssignmentFields,
  queryDashboard,
  resolveExecutionReadRoute,
  resolveHarnessDir,
  resolveProjectDir,
  resolveRepoEnforcement,
  resolveWorkflowDir,
  validateStatusWriteDoc,
  violationLine,
  withStoreRead,
} from "@mstar-harness/engine";
import type { StoreRuntimeInfo, ValidationResult } from "@mstar-harness/engine";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const STATUS_SKILL_POINTER = "skill: mstar-artifacts/references/status-and-residuals.md";
const DISPATCH_SKILL_POINTER = "skill: mstar-dispatch-gates";

// ---------------------------------------------------------------------------
// Dispatch wire shapes (spike Q3): flat `{name?, agent?, task?, …}` AND batch
// `{context, tasks: [{name?, agent?, task?, …}]}` — both handled.
// ---------------------------------------------------------------------------

type DispatchEntry = { name: string; agent: string; task: string };

/** Extract dispatch entries from a `task` tool event input (both wire shapes). */
function taskDispatchEntries(input: unknown): DispatchEntry[] {
  if (typeof input !== "object" || input === null) return [];
  const record = input as Record<string, unknown>;
  const toEntry = (raw: unknown): DispatchEntry | null => {
    if (typeof raw !== "object" || raw === null) return null;
    const entry = raw as Record<string, unknown>;
    return {
      name: typeof entry.name === "string" ? entry.name : "",
      agent: typeof entry.agent === "string" ? entry.agent : "",
      task: typeof entry.task === "string" ? entry.task : "",
    };
  };
  if (Array.isArray(record.tasks)) {
    const entries: DispatchEntry[] = [];
    for (const raw of record.tasks) {
      const entry = toEntry(raw);
      if (entry !== null) entries.push(entry);
    }
    return entries;
  }
 // Flat form: the input itself is the entry (`input.task` single string).
  const flat = toEntry(record);
  return flat !== null && flat.task !== "" ? [flat] : [];
}

// ---------------------------------------------------------------------------
// Gate 1b — issue/catalog authority paths (store.db + retired registers)
// ---------------------------------------------------------------------------

/** The authority database and its WAL sidecars, directly at a harness root. */
const STORE_DB_FILE = "store.db";
const STORE_AUTHORITY_FILES: readonly string[] = [STORE_DB_FILE, `${STORE_DB_FILE}-wal`, `${STORE_DB_FILE}-shm`];

/** Case-folded authority-name matching (plan QC fix wave FW-3, dsh/ZCode
 * parity): on a case-insensitive volume (Darwin/APFS) a case-variant basename
 * (`Store.db`) lands on the same authority bytes, so the match never hinges
 * on byte case. */
const STORE_AUTHORITY_NAMES: readonly string[] = STORE_AUTHORITY_FILES.map((file) => file.toLowerCase());

/** The register file's basename, matched case-insensitively (FW-3). */
const REGISTER_BASENAME = /residuals\.json/i;
/** The canonical register shape under the resolved project dir — one project
 * component + the register file — with the file name folded (FW-3). */
const REGISTER_SHAPE = /^[^/]+\/residuals\.json$/i;

/** Default v2 layout names of a marker-complete harness root. */
const STATUS_FILE = "status.json";
const WORKFLOW_DIR_NAME = "workflows";
const PROJECT_DIR_NAME = "projects";

/** Refusal codes for the authority paths (G4b). Their vocabulary mirrors the
 * frozen store/register families: `store.*` for the authority database,
 * `project.register.*` for the retired register document. */
const STORE_DIRECT_WRITE_CODE = "store.direct-write-refused";
const STORE_AUTHORITY_UNAVAILABLE_CODE = "store.authority-unavailable";
const REGISTER_RETIRED_CODE = "project.register.retired";

/** A store whose absence positively identifies the PRE-activation state
 * (legacy register authority still in force, issue contract §7): a missing
 * store (`store.not-initialized`) or a staged one (`store.not-active`). Every
 * other refusal — below-floor runtime, missing capability, corrupt, drifted,
 * busy — means the authority state is UNKNOWN and the write is refused
 * (dsh G4a `catalogRegistrationRefusal` exclusion list, mirrored). */
const PRE_ACTIVATION_CODES: readonly string[] = ["store.not-initialized", "store.not-active"];

/**
 * Actual-runtime probe seam (test-injectable, same holder pattern as
 * `dispatchGateLoader`): the default reads the ACTUAL runtime through the
 * engine — the Bun global first, so a Bun process is never judged by Bun's
 * EMULATED `process.versions.node` (Bun 1.4.0 reports "26.3.0" there, which
 * would pass a naive Node-floor check while the store's floor is Bun
 * >=1.4.0). Bun-run omp therefore gets the Bun floor; a native Node runner of
 * this bundle gets the Node floor — the invoked entrypoint's own runtime,
 * never both.
 */
export const storeRuntimeProbe: { info: () => StoreRuntimeInfo } = { info: detectStoreRuntime };

/** Stable code + message of a thrown refusal (engine `StoreError` /
 * `StoreReadError` carry `code`; anything else is reported as itself). */
function refusalOf(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  return { code: code === "" ? "store.authority-unreadable" : code, message };
}

/**
 * The DB-aware authority route for a register write (G4b): what the issue
 * store says about the retired register path.
 *
 * - `retired` — an active store answered: the register is migration history,
 *   the write is refused.
 * - `legacy` — NO store, or a staged one: pre-activation, the register is
 *   still the live findings authority, so the write keeps its document
 *   validator (issue contract §7: "before activation, new captures stay in
 *   the current register").
 * - `unavailable` — the authority could not be read (below-floor runtime /
 *   missing capability / corrupt / drifted / busy / unexpected): refused
 *   fail-closed. A write against an unreadable authority cannot be validated,
 *   so it is never silently applied.
 *
 * One read envelope (`withStoreRead` + the `issues` view: no projection
 * refresh, no source I/O) is the whole probe; nothing here re-implements a
 * floor or a refusal the engine already owns.
 */
type AuthorityRoute =
  | { kind: "legacy" }
  | { kind: "retired"; storeRevision: number }
  | { kind: "unavailable"; code: string; message: string };

async function readAuthorityRoute(harnessDir: string): Promise<AuthorityRoute> {
  try {
    assertStoreRuntimeSupported(storeRuntimeProbe.info());
  } catch (error) {
    return { kind: "unavailable", ...refusalOf(error) };
  }
  try {
    const envelope = await withStoreRead({ harnessDir }, queryDashboard("issues", { limit: 1 }));
    return { kind: "retired", storeRevision: envelope.storeRevision };
  } catch (error) {
    const refusal = refusalOf(error);
    return PRE_ACTIVATION_CODES.includes(refusal.code)
      ? { kind: "legacy" }
      : { kind: "unavailable", ...refusal };
  }
}

/** Directory/entry check (never throws — a missing or unreadable path is
 * simply not a marker). */
function hasEntry(dir: string, name: string): boolean {
  try {
    statSync(join(dir, name));
    return true;
  } catch {
    return false;
  }
}

/** True when `dir` itself is a harness root: the v2 coordination-document
 * markers the gates classify documents with (`status.json` + the layout dirs,
 * custom `.mstarc` dirs honored), or the root the engine resolves from the
 * directory's PARENT (default `.mstar`-style and `.mstarc harness_dir`
 * roots — `resolveHarnessDir(dir)` probes *inside* a directory, so it never
 * answers for the root itself). */
function isHarnessRootDir(dir: string): boolean {
  if (hasEntry(dir, STATUS_FILE)) {
    if (hasEntry(dir, WORKFLOW_DIR_NAME) && hasEntry(dir, PROJECT_DIR_NAME)) return true;
    try {
      if (
        hasEntry(resolveWorkflowDir(dir, { harnessDir: dir }), "") &&
        hasEntry(resolveProjectDir(dir, { harnessDir: dir }), "")
      ) {
        return true;
      }
    } catch {
      // unreadable layout config — fall through to the parent resolution
    }
  }
  const parentResolved = resolveHarnessDir(dirname(dir));
  return parentResolved !== null && resolve(parentResolved) === dir;
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
 * there too. One canonicalization per write target (the document lint below
 * keeps the caller's path), mirrored in the OpenCode and ZCode entries. */
function landedPathOf(resolved: string): string {
  try {
    return realpathSync(resolved);
  } catch {
    try {
      return resolve(dirname(resolved), readlinkSync(resolved));
    } catch {
      // The target does not exist yet and is not itself a dangling link — but
      // a missing FINAL component can still sit under a symlinked ANCESTOR,
      // and the filesystem lands the write at the canonical destination
      // through that alias. Canonicalize the nearest EXISTING ancestor and
      // rejoin the missing suffix; only a path with no existing ancestor at
      // all keeps the caller's path (a plain fresh file — the path itself
      // decides).
      let dir = dirname(resolved);
      for (;;) {
        try {
          return join(realpathSync(dir), relative(dir, resolved));
        } catch {
          const parent = dirname(dir);
          if (parent === dir) return resolved;
          dir = parent;
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
  if (!STORE_AUTHORITY_NAMES.includes(basename(target).toLowerCase())) return false;
  return isHarnessRootDir(dirname(target));
}

/** The harness root of a register target the exact-case classifiers MISS
 * because its basename is a case variant (`RESIDUALS.json`, FW-3): the
 * canonical register shape (one project component + the register file under
 * the resolved project dir) is matched case-insensitively from the nearest
 * harness root up the tree — the same walk the engine's marker probe runs for
 * exact-case names, so a case-variant register is authority-classified like
 * the file itself. `null` when the basename is not a register name or no
 * ancestor root holds the shape (dsh/ZCode parity). */
function caseFoldedRegisterRoot(candidate: string): string | null {
  const target = resolve(candidate);
  if (!REGISTER_BASENAME.test(basename(target))) return null;
  let dir = dirname(target);
  for (;;) {
    if (isHarnessRootDir(dir)) {
      let projectDir: string;
      try {
        projectDir = resolveProjectDir(dir, { harnessDir: dir });
      } catch {
        projectDir = join(dir, PROJECT_DIR_NAME);
      }
      if (REGISTER_SHAPE.test(relative(projectDir, target))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The harness root of a project register this write reaches ONLY through a
 * symlink alias (`landed` differs from the caller's own `resolved` path): the
 * register is an authority document, so its route is decided on the path the
 * write really lands on. `null` when the target is not an alias, or does not
 * land on a register (S-G4b-03). */
function aliasedRegisterDir(resolved: string, landed: string): string | null {
  if (landed === resolved) return null;
  const aliased = harnessDocKindOfTarget(landed);
  return aliased?.kind === "register" ? aliased.harnessDir : null;
}

/** The harness root of the register a write LANDS on through a symlink alias
 * (stricter-wins veto): the landed destination of an alias is itself an
 * authority candidate even when the caller's own path already classified as a
 * register elsewhere — classified by the exact-case marker probe first, then
 * the FW-3 folded shape walk. `null` when the write is not an alias or does
 * not land on a register. */
function landedRegisterDirOf(resolved: string, landed: string): string | null {
  if (landed === resolved) return null;
  const aliased = harnessDocKindOfTarget(landed);
  if (aliased?.kind === "register") return aliased.harnessDir;
  return caseFoldedRegisterRoot(landed);
}

/** One refusal as the hook's block-reason line (same `[severity] code:
 * message (fix: …)` + skill-pointer dialect the document violations use). */
function authorityRefusal(code: string, message: string): { block: true; reason: string } {
  const violation: ValidationResult = { ok: false, severity: "high", code, message };
  return { block: true, reason: `${violationLine(violation)} (${STATUS_SKILL_POINTER})` };
}

function storeDirectWriteRefusal(rawPath: string): { block: true; reason: string } {
  return authorityRefusal(
    STORE_DIRECT_WRITE_CODE,
    `${resolve(rawPath)} is the issue/catalog authority database and is owned by the runtime — a direct ` +
      "hand write is refused (the schema and its WAL are managed in-process). Schema changes go through " +
      "`mstar store init|upgrade|migrate`, findings through `mstar issue add|close`, catalog rows through " +
      "`mstar catalog register|update`",
  );
}

function registerRetiredRefusal(storeRevision: number): { block: true; reason: string } {
  return authorityRefusal(
    REGISTER_RETIRED_CODE,
    "project registers are retired migration history — the issue store ({HARNESS_DIR}/store.db, revision " +
      `${storeRevision}) is the only findings authority; capture and close through \`mstar plan ` +
      "issue-add|issue-close` (plan-scoped) or `mstar issue add|close` (unscoped). This write is refused",
  );
}

function authorityUnavailableRefusal(
  route: { code: string; message: string },
  authority: string,
  write: string,
): { block: true; reason: string } {
  return authorityRefusal(
    STORE_AUTHORITY_UNAVAILABLE_CODE,
    `${authority} could not be read ([${route.code}] ${route.message}) — the ${write} is refused ` +
      "rather than applied against an unreadable authority; no older-runtime or JSON fallback exists",
  );
}

// ---------------------------------------------------------------------------
// Gate 1c — execution authority: retired coordination documents (source
// readiness, plan S3)
// ---------------------------------------------------------------------------

/** §4.3/§5: a write to a coordination document that the EXECUTION authority
 * retired as a persistence route (`root status.json`, `workflows/<id>/snapshot.json`)
 * while that authority is ACTIVE. */
const EXECUTION_DIRECT_WRITE_CODE = "execution.direct-write-refused";

/**
 * What the control harness's EXECUTION authority says about a coordination-
 * document write. `resolveExecutionReadRoute` (plan S2) is the ONE place a
 * consumer decides between the DB authority and the file route; a store that
 * EXISTS and cannot be read is a refusal here too (§5: "no protected mutation"
 * while the authority cannot be established) and never a fall-through to the
 * file route. A harness with no store at all keeps the file route — absence is
 * not an authority verdict (§2.1), so the pre-activation write path is
 * unchanged.
 */
type ExecutionWriteRoute =
  | { kind: "files" }
  | { kind: "active" }
  | { kind: "unavailable"; code: string; message: string };

async function readExecutionWriteRoute(harnessDir: string): Promise<ExecutionWriteRoute> {
  try {
    return (await resolveExecutionReadRoute({ harnessDir })) === "execution" ? { kind: "active" } : { kind: "files" };
  } catch (error) {
    return { kind: "unavailable", ...refusalOf(error) };
  }
}

/** §4.3: root status and workflow snapshots are no longer a persistence route
 * once the execution authority is ACTIVE — persisting them would create a
 * second authority, so the write is refused even when its bytes are valid. */
function executionDirectWriteRefusal(target: string): { block: true; reason: string } {
  return authorityRefusal(
    EXECUTION_DIRECT_WRITE_CODE,
    `${resolve(target)} is retired as a persistence route while the control harness's execution authority is ACTIVE — ` +
      "the root status and the workflow snapshots live in the execution store ({HARNESS_DIR}/store.db, owned by the " +
      "runtime). Nothing was written: use the execution DB route (the coordination verbs), not a file writer. This " +
      "write is refused",
  );
}

// ---------------------------------------------------------------------------
// Gate 1 — coordination-document writes (engine gates module)
// ---------------------------------------------------------------------------

/**
 * Block a `write`/`edit` tool_call when it targets a canonical
 * `{HARNESS_DIR}` coordination document (v2 root status.json / workflow
 * snapshot / project register) with violations and the harness compass
 * declares `enforcement: hard`. Soft (or no compass) → silent pass.
 *
 * Authority paths (G4b) are decided BEFORE the document path: a store
 * database write is refused unconditionally, and a register write is decided
 * by the DB-aware authority route — refused when the store is active or
 * unreadable, and only shape-validated while the register is still the live
 * authority (no store / staged store). The EXECUTION authority's retired
 * documents (root status / workflow snapshot, plan S3) take the same shape: an
 * ACTIVE execution authority refuses `execution.direct-write-refused`
 * unconditionally, and an unreadable authority refuses fail-closed. None of
 * those refusals is gated by the compass flag (an authority invariant, not
 * document validity).
 *
 * Classification + validation run through the shared engine `gates`
 * module (contract D1) — the same path the ZCode write gate consumes.
 */
async function gateStatusWrite(eventInput: unknown): Promise<{ block: true; reason: string } | undefined> {
  const input = eventInput as Record<string, unknown>;
  for (const rawPath of eventTargetPaths(input)) {
    const resolved = resolve(rawPath);
    // S-G4b-03: the AUTHORITY decision is made on the path the write really
    // lands on, so a symlink alias is refused like the authority file itself.
    const landed = landedPathOf(resolved);
    const storeTarget = isStoreAuthorityTarget(resolved) ? resolved : isStoreAuthorityTarget(landed) ? landed : null;
    if (storeTarget !== null) return storeDirectWriteRefusal(storeTarget); // authority bytes — never writable
    const direct = harnessDocKindOfTarget(resolved);
    // §4.3/§5: a write to a coordination document the EXECUTION authority has
    // retired — the root register or a workflow snapshot — is refused
    // unconditionally while that authority is ACTIVE, and refused fail-closed
    // when the authority exists and cannot be read. It is an authority
    // invariant, not the document-validity axis the hard/soft compass flag
    // governs (same shape as the store-bytes and retired-register refusals).
    // The classification covers the caller's own path AND the path the write
    // really lands on (S-G4b-03) — and it covers BOTH harness roots: a
    // status/snapshot symlinked into ANOTHER harness's tree lands on THAT
    // harness's document, so EITHER root's verdict (ACTIVE or UNAVAILABLE)
    // vetoes the write. A single-root probe would let a pre-activation
    // harness's alias bypass the authority the bytes really belong to (an
    // identical landed root costs no second probe). §4.3's canonical target
    // check for the old protected artifact paths; the register keeps its own
    // issue-domain route below.
    const landedTarget = landed === resolved ? null : harnessDocKindOfTarget(landed);
    const executionDirs: string[] = [];
    if (direct !== null && direct.kind !== "register") executionDirs.push(direct.harnessDir);
    if (
      landedTarget !== null &&
      landedTarget.kind !== "register" &&
      !executionDirs.includes(landedTarget.harnessDir)
    ) {
      executionDirs.push(landedTarget.harnessDir);
    }
    for (const executionDir of executionDirs) {
      const executionRoute = await readExecutionWriteRoute(executionDir);
      if (executionRoute.kind === "active") return executionDirectWriteRefusal(resolved);
      if (executionRoute.kind === "unavailable") {
        return authorityUnavailableRefusal(
          executionRoute,
          "the harness's execution authority",
          "coordination-document write",
        );
      }
    }
    // A project register is an authority document too — reached through an
    // alias it takes the same route (status/snapshot aliases are untouched).
    // A case-variant register basename (FW-3) bypasses both exact-case
    // classifications and is classified by the folded shape walk instead.
    const registerDir =
      direct?.kind === "register"
        ? direct.harnessDir
        : (aliasedRegisterDir(resolved, landed) ??
          caseFoldedRegisterRoot(resolved) ??
          (landed !== resolved ? caseFoldedRegisterRoot(landed) : null));
    if (registerDir !== null) {
      const route = await readAuthorityRoute(registerDir);
      if (route.kind === "retired") return registerRetiredRefusal(route.storeRevision);
      if (route.kind === "unavailable") return authorityUnavailableRefusal(route, "the issue authority", "register write");
      // `legacy`: pre-activation — the register is still the authority, so the
      // write keeps its document validator (no store probe touched it).
      // Stricter-wins veto: the write may LAND on another harness's register
      // through a symlink alias while only the source authority was checked
      // — classify the landed destination too, and its authority refusals
      // veto the legacy fall-through. Both contexts pre-activation keep the
      // legacy path (issue contract §7); the landed store database is already
      // refused by the S-G4b-03 store check above.
      if (route.kind === "legacy") {
        const landedDir = landedRegisterDirOf(resolved, landed);
        if (landedDir !== null && landedDir !== registerDir) {
          const landedRoute = await readAuthorityRoute(landedDir);
          if (landedRoute.kind === "retired") return registerRetiredRefusal(landedRoute.storeRevision);
          if (landedRoute.kind === "unavailable") return authorityUnavailableRefusal(landedRoute, "the issue authority", "register write");
        }
      }
    }
    const target = direct ?? (registerDir === null ? null : { harnessDir: registerDir, kind: "register" as const });
    if (target === null) continue; // not a gated coordination write — silent pass
    const violations = validateStatusWriteDoc(input.content, resolved, target.kind);
    if (violations.length === 0) continue;
    const enforcement = resolveRepoEnforcement(target.harnessDir);
    if (!enforcement.hard) continue; // soft mode — silent pass
    return { block: true, reason: formatStatusWriteBlockReason(violations, STATUS_SKILL_POINTER) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Gate 2 — task dispatch
// ---------------------------------------------------------------------------

/**
 * Engine-version compat: `composeDispatchGate` postdates the engine release
 * containing it (published floor `^2.0.2` lacks it) — a static named import
 * would fail at module link on older engines and drop the WHOLE hook (both
 * gates), so it is loaded lazily and cached (module-level cached dynamic
 * import). The loader returns a DISCRIMINATED result so
 * a missing export (`missing`) is never conflated with a real import
 * failure (`error`): Gate 2 skips itself either way (see `gateTaskDispatch`),
 * but the two produce different one-time warnings.
 */
type DispatchGateFn = (text: string, options?: { caller?: string; callerRequired?: boolean; writable?: boolean }) => {
  ok: boolean;
  shaped: boolean;
  enforcement: { hard: boolean };
  violations: ValidationResult[];
};

type ComposeDispatchGateLoad =
  | { status: "ok"; gate: DispatchGateFn }
  | { status: "missing" }
  | { status: "error"; error: unknown };

let cachedDispatchGate: Promise<ComposeDispatchGateLoad> | null = null;

export function loadComposeDispatchGate(): Promise<ComposeDispatchGateLoad> {
  cachedDispatchGate ??= import("@mstar-harness/engine")
    .then((mod) =>
      typeof mod.composeDispatchGate === "function"
        ? ({ status: "ok", gate: mod.composeDispatchGate as DispatchGateFn } as const)
        : ({ status: "missing" } as const),
    )
    .catch((error: unknown) => ({ status: "error", error } as const));
  return cachedDispatchGate;
}

/**
 * Test seam for the degradation path: smoke scripts replace `load` to
 * simulate an engine build without `composeDispatchGate` (missing) or a
 * broken engine import (error) — ESM namespace bindings are read-only, so
 * the holder indirection is what makes the degrade cases stub-able.
 * Runtime default is the cached loader.
 */
export const dispatchGateLoader: { load: () => Promise<ComposeDispatchGateLoad> } = {
  load: loadComposeDispatchGate,
};

/** One-time degradation warnings (module-level flags): emitted via the
 * extension logger on the first task event while Gate 2 is unavailable —
 * one message for a missing `composeDispatchGate` export (upgrade hint), a
 * DIFFERENT one for a real engine import failure (no upgrade claim — the
 * module itself is broken). Defensive — the logger may be absent, and the
 * degrade path must never throw (optional chaining + local try/catch). */
let dispatchGateWarned = false;
let dispatchGateImportErrorWarned = false;

function warnDispatchGateDegraded(logger: unknown, reason: "missing" | "error", error?: unknown): void {
  if (reason === "missing") {
    if (dispatchGateWarned) return;
    dispatchGateWarned = true;
  } else {
    if (dispatchGateImportErrorWarned) return;
    dispatchGateImportErrorWarned = true;
  }
  const message =
    reason === "missing"
      ? "mstar-gates: installed engine lacks composeDispatchGate — task dispatch gate (Gate 2) disabled; status gate unaffected; upgrade the engine (next release)"
      : `mstar-gates: task dispatch gate (Gate 2) disabled: engine import failed — ${error instanceof Error ? error.message : String(error)}; status gate unaffected`;
  try {
    (
      logger as
        | { warn?: (message: string, context?: Record<string, unknown>) => void }
        | undefined
    )?.warn?.(message);
  } catch {
 // degrade path must never throw
  }
}

/**
 * Validate one dispatch entry via the engine's single shared composition
 * `dispatch.composeDispatchGate` (the same composition
 * opencode `validateDispatchAssignment` and `mstar_dispatch_validate` use,
 * incl. the `$MSTAR_WORKING_BRANCH` env fallback /
 * ): field validation with `writable: false` for read-only roles,
 * and the default-branch gate for writable roles. NO anti-recursion leg on
 * omp (issue #156): `entry.agent` is the spawn TARGET, and omp's
 * `tool_call` event carries no caller identity (ToolCallEvent =
 * { toolName, toolCallId, input }), so the precheck cannot run soundly —
 * target == `Execute as` is the documented C5 pattern, not recursion. The
 * NEVER red line stays prompt-level on this host. Returns the entry's
 * violations and its OWN header enforcement flag (an example
 * `**Enforcement**: hard` line in the task body never hardens).
 */
function validateDispatchEntry(
  entry: DispatchEntry,
  composeDispatchGate: DispatchGateFn,
): { violations: ValidationResult[]; hard: boolean } {
  const text = entry.task;
 // Read-only roles (scout/explore) skip the branch-form/default-branch gates.
  const writable = isReadOnlyAssignmentRole(parseAssignmentFields(text).executeAs ?? "") ? false : undefined;
  const composed = composeDispatchGate(text, { writable });
  return { violations: composed.violations, hard: composed.enforcement.hard };
}

/**
 * Block a `task` tool_call when any Assignment-shaped entry has violations
 * AND hard enforcement governs it: the entry's OWN header
 * `Enforcement: hard`, or the repo-level setting (`.mstarc` → compass via
 * `resolveRepoEnforcement`, resolved once per event from the session cwd —
 * Gate 1 and dsh `resolveDispatchHard` parity; the pre-#156 header-only
 * read let a hard compass leave Gate 2 unhardened). Soft-governed
 * violations never block but ARE warn-logged through `logSoft` (opencode
 * warn-channel parity — silent drops hide gate/model drift).
 *
 * When the engine build lacks `composeDispatchGate` (predating the export)
 * or the engine import itself fails, Gate 2 is SKIPPED entirely — no
 * blocking, no violations — with a one-time warning; Gate 1 (status) keeps
 * working (engine-version compatibility).
 */
async function gateTaskDispatch(
  eventInput: unknown,
  warnDegraded: (reason: "missing" | "error", error?: unknown) => void,
  logSoft: (line: string) => void,
): Promise<{ block: true; reason: string } | undefined> {
  const load = await dispatchGateLoader.load();
  if (load.status !== "ok") {
    warnDegraded(load.status, load.status === "error" ? load.error : undefined);
    return undefined;
  }
  const composeDispatchGate = load.gate;
 // Repo-level hard (`.mstarc` wins, else compass) hardens flag-less
 // entries — same source Gate 1 uses for coordination writes.
  const harnessDir = resolveHarnessDir();
  const repoHard = harnessDir !== null && resolveRepoEnforcement(harnessDir).hard;
  const blocked: string[] = [];
  for (const entry of taskDispatchEntries(eventInput)) {
    const { violations, hard } = validateDispatchEntry(entry, composeDispatchGate);
    if (violations.length === 0) continue;
    const label = entry.name !== "" ? `"${entry.name}"` : entry.agent !== "" ? `agent "${entry.agent}"` : "(unnamed)";
    if (!hard && !repoHard) {
 // Soft mode: never block, but surface the violations (opencode parity).
      for (const violation of violations) {
        logSoft(`task dispatch entry ${label}: ${violationLine(violation)} (${DISPATCH_SKILL_POINTER})`);
      }
      continue;
    }
    for (const violation of violations) {
      blocked.push(`task dispatch entry ${label}: ${violationLine(violation)} (${DISPATCH_SKILL_POINTER})`);
    }
  }
  if (blocked.length === 0) return undefined;
  return { block: true, reason: blocked.join("\n") };
}

// ---------------------------------------------------------------------------
// Factory: one module, one handler
// ---------------------------------------------------------------------------

export default function mstarGates(pi: ExtensionAPI): void {
  const warnDegraded = (reason: "missing" | "error", error?: unknown): void =>
    warnDispatchGateDegraded(pi.logger, reason, error);
  pi.on("tool_call", async (event) => {
    try {
      const toolName = event?.toolName ?? "";
      let block: { block: true; reason: string } | undefined;
      if (toolName === "write" || toolName === "edit") {
        block = await gateStatusWrite(event?.input);
      } else if (toolName === "task") {
        block = await gateTaskDispatch(event?.input, warnDegraded, (line) => {
          try {
            (
              pi.logger as
                | { warn?: (message: string, context?: Record<string, unknown>) => void }
                | undefined
            )?.warn?.(line);
          } catch {
 // the warn channel must never throw into the fail-closed host path
          }
        });
      }
      return block;
    } catch {
 // NEVER throw, NEVER block on unexpected errors: omp fails CLOSED when
 // a handler throws — every unexpected failure degrades to silent pass.
      return undefined;
    }
  });
}
