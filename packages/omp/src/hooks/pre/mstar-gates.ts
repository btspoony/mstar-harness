/**
 * omp `tool_call` pre-hook for coordination writes and task dispatches. Hard
 * mode blocks engine-validated violations; soft dispatch findings are logged,
 * while authority refusals remain unconditional.
 *
 * Gate 1 protects execution-owned coordination paths and issue/catalog authority
 * paths. ACTIVE execution DB state is the only recognized authority: retired
 * file documents and project registers are refused, and missing, staged or
 * unreadable authority state fails closed rather than falling through to a
 * document validator.
 *
 * Target classification and write validation come from the shared
 * `@mstar-harness/engine` gates module. The local hook supplies event shape,
 * host paths and the `{ block, reason }` refusal channel.
 *
 * Gate 2 retains the Assignment-header hard-enforcement boundary and the
 * caller-scoped recursion constraints. No handler throws into omp.
 */
import { readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  assertStoreRuntimeSupported,
  detectStoreRuntime,
  eventTargetPaths,
  harnessDocKindOfTarget,
  isReadOnlyAssignmentRole,
  parseAssignmentFields,
  queryDashboard,
  resolveExecutionReadRoute,
  resolveHarnessDir,
  resolveProjectDir,
  resolveRepoEnforcement,
  resolveWorkflowDir,
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
 * Resolve the ACTIVE issue-store authority. An unavailable, missing or staged
 * store refuses; no document-backed fallback is admitted.
 */
type AuthorityRoute =
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
    return { kind: "unavailable", ...refusalOf(error) };
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

/** ACTIVE DB route of a coordination-document write; all other routes refuse. */
type ExecutionWriteRoute =
  | { kind: "active" }
  | { kind: "unavailable"; code: string; message: string };

async function readExecutionWriteRoute(harnessDir: string): Promise<ExecutionWriteRoute> {
  try {
    if ((await resolveExecutionReadRoute({ harnessDir })) === "execution") return { kind: "active" };
    return {
      kind: "unavailable",
      code: "execution.not-active",
      message: "this write requires the ACTIVE execution DB authority",
    };
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
 * Refuse writes to ACTIVE-owned authority paths unconditionally, resolve
 * execution-document targets through the ACTIVE DB route, then apply the
 * shared content validator only to eligible coordination documents.
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
    // Execution-owned document writes are refused under ACTIVE authority and
    // fail closed when the authority is absent or unreadable. Check both the
    // caller's path and its landed symlink destination.
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
    // Project-register aliases are checked against their ACTIVE DB authority.
    const registerDir =
      direct?.kind === "register"
        ? direct.harnessDir
        : (aliasedRegisterDir(resolved, landed) ??
          caseFoldedRegisterRoot(resolved) ??
          (landed !== resolved ? caseFoldedRegisterRoot(landed) : null));
    if (registerDir !== null) {
      const route = await readAuthorityRoute(registerDir);
      if (route.kind === "retired") return registerRetiredRefusal(route.storeRevision);
      return authorityUnavailableRefusal(route, "the issue authority", "register write");
    }
    continue;
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
 * opencode `validateDispatchAssignment` uses,
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
