/**
 * mstar_status_validate — validate a Morning Star harness v2 status.json
 * root or a workflow snapshot (`workflows/<id>/snapshot.json`) via the
 * engine's `validateStatus` / `validateWorkflowSnapshot` gates, and answer a
 * project register (`projects/<id>/residuals.json`) through the DB-aware
 * authority route (issue-governance cutover G4b).
 *
 * Defaults to `{harness}/status.json` resolved from the session cwd
 * (`resolveHarnessDir(pi.cwd)`); pass `path` to target another file.
 * Classification follows the Gate 1 layout rules (parity
 * with `harnessDocKindOfTarget` in ../hooks/pre/mstar-gates.ts and
 * packages/opencode/src/mstar.ts): a document is only validated when its
 * harness-relative location is canonical — `status.json` at the harness
 * root, `snapshot.json` under `workflows/<id>/`, `residuals.json` under
 * `projects/<id>/`. Anything else is an explicit error, never a basename-
 * only validator dispatch (a stray `/tmp/evil/snapshot.json` must not run
 * the snapshot validator).
 *
 * Register targets: the register's DOCUMENT SHAPE is no longer the answer
 * once the store is the authority. The DB-aware route reads the issue store
 * (`withStoreRead` over the `issues` view — one read envelope, no projection
 * refresh) and reports `project.register.retired` while an active store is
 * the findings authority, `store.authority-unavailable` when the authority
 * cannot be read at all (below-floor runtime, missing capability, corrupt,
 * drifted, busy), and only falls back to the register's own validator
 * (`validateProjectRegister`) for a workspace with no store or a staged one
 * — pre-activation, where the register IS still the live authority (issue
 * contract §7). The runtime floor is read from the ACTUAL runtime (engine
 * `detectStoreRuntime`: the Bun global first, never Bun's emulated
 * `process.versions.node`) and asserted in-process. A raw write target at
 * `{HARNESS_DIR}/store.db` (or its `-wal`/`-shm`) is refused outright — the
 * runtime owns those bytes.
 *
 * Authority classification is decided on the path a target really LANDS on
 * (S-G4b-03): a symlink alias that resolves to a harness-root `store.db` or
 * to a project register is refused and routed exactly like the file itself.
 * Only that decision is canonicalized — status.json / snapshot targets keep
 * the caller's path and the unchanged validator (aliases included).
 *
 * EXECUTION authority (source readiness, plan S3): the root register and the
 * workflow snapshots are retired as a persistence route while the control
 * harness's execution authority is ACTIVE (primary spec §4.3). The route is
 * asked first (`resolveExecutionReadRoute` — the ONE place a consumer decides
 * between the DB authority and the file route): the DEFAULT target then
 * validates the authority's OWN register through its own readers
 * (`readExecutionAuthority`) instead of the retired file, an explicitly named
 * status.json / snapshot.json refuses `execution.consumer-not-ready`, and a
 * store that exists and cannot be read keeps its own refusal — never a
 * fall-through to the retired bytes.
 *
 * The snapshot/register validators are P1-only engine exports absent from
 * the published floor `^2.0.2` — they come from a DYNAMIC engine import so
 * a stale engine yields an explicit upgrade error instead of a
 * module-link failure that silently drops the tool, and the S2 execution-read
 * exports are loaded the same way. No local rule logic — the engine is the single validator;
 * this module only locates the file and formats output.
 */
import { readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  assertStoreRuntimeSupported,
  detectStoreRuntime,
  queryDashboard,
  readJson,
  resolveHarnessDir,
  validateStatus,
  withStoreRead,
} from "@mstar-harness/engine";
import type { ExecutionRead, ExecutionState, StoreRuntimeInfo, ValidationResult } from "@mstar-harness/engine";
import type { AgentToolResult, CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent";

const STATUS_FILE = "status.json";
const SNAPSHOT_FILE = "snapshot.json";
const REGISTER_FILE = "residuals.json";

type DocKind = "status" | "snapshot" | "register";

type Params = { path?: string };

function violationLines(violations: readonly ValidationResult[]): string {
  return violations
    .map((v) => `[${v.severity}] ${v.code}: ${v.message}${v.fix ? ` (fix: ${v.fix})` : ""}`)
    .join("\n");
}

function result(text: string, details: unknown, isError: boolean): AgentToolResult {
  const out: AgentToolResult = { content: [{ type: "text", text }], details };
  if (isError) out.isError = true;
  return out;
}

/**
 * Directory/entry check (never throws — a missing or unreadable path is
 * simply not a marker).
 */
function hasEntry(dir: string, name: string): boolean {
  try {
    statSync(join(dir, name));
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `dir` carries the v2 coordination-document markers that make
 * it a harness root: a `status.json` root file plus BOTH layout dirs.
 * Default-layout fast path: the `workflows/` + `projects/` names). With the lazily-loaded engine dir resolvers, with the lazily-loaded engine dir resolvers, a
 * `.mstarc` custom `workflow_dir` / `project_dir` layout is recognized via
 * the resolved absolute dirs (stale engine -> resolvers null -> default
 * names only). Never throws — a missing/unreadable path is not a marker.
 */
function hasHarnessRootMarkers(dir: string): boolean {
  if (!hasEntry(dir, STATUS_FILE)) return false;
  if (hasEntry(dir, "workflows") && hasEntry(dir, "projects")) return true;
  const resolvers = classifyDirResolvers;
  if (resolvers === null) return false;
  try {
    return (
      hasEntry(resolvers.resolveWorkflowDir(dir, { harnessDir: dir }), "") &&
      hasEntry(resolvers.resolveProjectDir(dir, { harnessDir: dir }), "")
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the harness root containing `startDir` by marker probe (): the nearest ancestor holding the v2 coordination-document
 * markers — a `status.json` root file plus the layout directories — IS the
 * harness root. Unlike `resolveHarnessDir`'s rung-3 `plans/` probe, this
 * never mistakes the NESTED `{HARNESS_DIR}/plans` subdir of the default
 * `.mstar` layout for the root, so coordination docs inside a
 * default-layout root stay gated. Returns `null` when no ancestor carries
 * the markers — callers fall back to `resolveHarnessDir` for declared
 * roots (`.mstarc` `harness_dir` / `MSTAR_HARNESS_DIR`) that are not yet
 * populated with all three markers.
 */
function resolveHarnessRootOf(target: string): string | null {
  let dir = resolve(target);
  for (;;) {
    if (hasHarnessRootMarkers(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Classify `targetPath` as a canonical `{HARNESS_DIR}` coordination
 * document (Gate 1 layout parity, W-C / W-REV-1, Phase-5 F1):
 * basename is `status.json` at the harness root, `snapshot.json` under
 * `{WORKFLOW_DIR}/<id>/`, or `residuals.json` under `{PROJECT_DIR}/<id>/`
 * (harness-relative, one path component each), AND the harness root
 * resolves — marker probe first, `resolveHarnessDir` as the declared-root
 * fallback. The snapshot/register rel is computed against the RESOLVED
 * layout dirs (`.mstarc` `workflow_dir`/`project_dir` honored, defaults
 * `workflows`/`projects`), so a custom layout classifies at the same
 * location the runtime writes; on a stale engine (no dir resolvers) the
 * default names apply. Returns the harness dir + doc kind when canonical,
 * `null` otherwise.
 */
function harnessDocKindOfTarget(targetPath: string): { harnessDir: string; kind: DocKind } | null {
  const resolved = resolve(targetPath);
  const name = basename(resolved);
  if (name !== STATUS_FILE && name !== SNAPSHOT_FILE && name !== REGISTER_FILE) return null;
  const classify = (harnessDir: string): { harnessDir: string; kind: DocKind } | null => {
    const rel = relative(harnessDir, resolved);
    if (name === STATUS_FILE && rel === STATUS_FILE) return { harnessDir, kind: "status" };
    let workflowDir: string;
    let projectDir: string;
    const resolvers = classifyDirResolvers;
    if (resolvers !== null) {
      try {
        workflowDir = resolvers.resolveWorkflowDir(harnessDir, { harnessDir });
        projectDir = resolvers.resolveProjectDir(harnessDir, { harnessDir });
      } catch {
        workflowDir = join(harnessDir, "workflows");
        projectDir = join(harnessDir, "projects");
      }
    } else {
      workflowDir = join(harnessDir, "workflows");
      projectDir = join(harnessDir, "projects");
    }
    if (name === SNAPSHOT_FILE && /^[^/]+\/snapshot\.json$/.test(relative(workflowDir, resolved))) {
      return { harnessDir, kind: "snapshot" };
    }
    if (name === REGISTER_FILE && /^[^/]+\/residuals\.json$/.test(relative(projectDir, resolved))) {
      return { harnessDir, kind: "register" };
    }
    return null;
  };
  const probeRoot = resolveHarnessRootOf(dirname(resolved));
  const harnessDir = probeRoot ?? resolveHarnessDir(dirname(resolved));
  if (harnessDir === null) return null;
  const classified = classify(harnessDir);
  if (classified !== null) return classified;
 // W-REV-3: probe root hit but rel non-canonical — pathological double
 // harness (a nested sparse harness below a full-marker ancestor). Rebuild
 // rel against the declared-root resolution before giving up.
  if (probeRoot === null) return null;
  const fallbackDir = resolveHarnessDir(dirname(resolved));
  if (fallbackDir === null || fallbackDir === probeRoot) return null;
  return classify(fallbackDir);
}

/** Dynamic engine import guard for the P1-only snapshot/register validators
 * : missing → explicit upgrade error. */
async function loadNewValidators(): Promise<
  | { ok: true; validateWorkflowSnapshot: (doc: unknown) => { ok: boolean; violations: ValidationResult[] }; validateProjectRegister: (doc: unknown) => { ok: boolean; violations: ValidationResult[] } }
  | { ok: false; error: AgentToolResult }
> {
 // Dynamic import : static named imports of these exports
 // would fail at module link on published engines (^2.0.2 floor) and
 // silently drop the tool from /extensions.
  const engine = await import("@mstar-harness/engine");
  if (typeof engine.validateWorkflowSnapshot !== "function" || typeof engine.validateProjectRegister !== "function") {
    return {
      ok: false,
      error: result(
        "installed @mstar-harness/engine lacks validateWorkflowSnapshot/validateProjectRegister — upgrade the engine (next release); CLI fallback: mstar status validate",
        { ok: false },
        true,
      ),
    };
  }
  return { ok: true, validateWorkflowSnapshot: engine.validateWorkflowSnapshot, validateProjectRegister: engine.validateProjectRegister };
}

/** The P1-only v3 layout-dir resolvers (custom `.mstarc` `workflow_dir` /
 * `project_dir` support, Phase-5 F1) — same stale-engine rationale as the
 * validators above: dynamic import, `null` on missing exports / import
 * failure (classification falls back to the DEFAULT layout names). */
type DirResolvers = {
  resolveWorkflowDir: (startDir: string, opts?: { harnessDir?: string }) => string;
  resolveProjectDir: (startDir: string, opts?: { harnessDir?: string }) => string;
};

let cachedDirResolvers: Promise<DirResolvers | null> | null = null;

async function loadDirResolvers(): Promise<DirResolvers | null> {
  cachedDirResolvers ??= import("@mstar-harness/engine")
    .then((mod) =>
      typeof mod.resolveWorkflowDir === "function" && typeof mod.resolveProjectDir === "function"
        ? { resolveWorkflowDir: mod.resolveWorkflowDir, resolveProjectDir: mod.resolveProjectDir }
        : null,
    )
    .catch(() => null);
  return cachedDirResolvers;
}

/** Test seam (smoke scripts): replace `load` to simulate an engine build
 * without the P1 dir resolvers (null — default-layout classification). */
export const dirResolversLoader: { load: () => Promise<DirResolvers | null> } = {
  load: loadDirResolvers,
};

/** Sync slot for the loaded resolvers; `execute` awaits the loader before
 * classifying, so the slot is populated on that path. */
let classifyDirResolvers: DirResolvers | null = null;

// ---------------------------------------------------------------------------
// Gate 1b — issue/catalog authority paths (store.db + retired registers)
// ---------------------------------------------------------------------------

/** The authority database and its WAL sidecars, directly at a harness root. */
const STORE_DB_FILE = "store.db";
const STORE_AUTHORITY_FILES: readonly string[] = [STORE_DB_FILE, `${STORE_DB_FILE}-wal`, `${STORE_DB_FILE}-shm`];

/** Refusal codes for the authority paths (G4b), in the frozen store /
 * `project.register.*` vocabulary. */
const STORE_DIRECT_WRITE_CODE = "store.direct-write-refused";
const STORE_AUTHORITY_UNAVAILABLE_CODE = "store.authority-unavailable";
const REGISTER_RETIRED_CODE = "project.register.retired";
/** §5: a read whose input is a RETIRED execution document (root register /
 * workflow snapshot) while the execution authority is ACTIVE. */
const EXECUTION_CONSUMER_NOT_READY_CODE = "execution.consumer-not-ready";

/** A store whose absence positively identifies the PRE-activation state
 * (legacy register authority in force, issue contract §7): missing
 * (`store.not-initialized`) or staged (`store.not-active`). Every other
 * refusal — below-floor runtime, missing capability, corrupt, drifted, busy —
 * leaves the authority state UNKNOWN and is refused (dsh G4a
 * `catalogRegistrationRefusal` exclusion list, mirrored). */
const PRE_ACTIVATION_CODES: readonly string[] = ["store.not-initialized", "store.not-active"];

/**
 * Actual-runtime probe seam (test-injectable): the default reads the ACTUAL
 * runtime through the engine — the Bun global first, so a Bun process is
 * never judged by Bun's EMULATED `process.versions.node` (Bun 1.4.0 reports
 * "26.3.0" there). Bun-run omp gets the Bun floor; a native Node runner of
 * this bundle gets the Node floor — the invoked entrypoint's own runtime.
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

/** What the issue store says about a register target (G4b `retired` /
 * `unavailable` / pre-activation `legacy` — see ../hooks/pre/mstar-gates.ts
 * `readAuthorityRoute`, the same route in the omp write gate's dialect). */
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

/** §5 the engine's own execution-source route resolver and read adapter (plan
 * S2). P1-only exports: loaded dynamically so a stale engine yields an explicit
 * upgrade error instead of a module-link failure that drops the tool. */
type ExecutionRouteResolver = (context: { harnessDir: string }) => Promise<"execution" | "files">;
type ExecutionAuthorityReader = (context: { harnessDir: string }) => Promise<ExecutionRead<ExecutionState>>;

async function loadExecutionReadExports(): Promise<
  { ok: true; resolve: ExecutionRouteResolver; read: ExecutionAuthorityReader } | { ok: false; error: AgentToolResult }
> {
  const engine = await import("@mstar-harness/engine");
  const resolve = engine.resolveExecutionReadRoute as ExecutionRouteResolver | undefined;
  const read = engine.readExecutionAuthority as ExecutionAuthorityReader | undefined;
  if (typeof resolve !== "function" || typeof read !== "function") {
    return {
      ok: false,
      error: result(
        "installed @mstar-harness/engine lacks the execution read adapter (resolveExecutionReadRoute / readExecutionAuthority) — upgrade the engine (next release); CLI fallback: mstar status validate",
        { ok: false },
        true,
      ),
    };
  }
  return { ok: true, resolve, read };
}

/** What the control harness's execution authority says about a retired
 * root-register / snapshot read (primary spec §5): the file route answers
 * (`files`), the DB authority does (`active`), the authority exists and cannot
 * be read (`unavailable` — its own code, never a fall-through to files), or the
 * engine predates the route (`unsupported`). */
type ExecutionRouteVerdict =
  | { kind: "files" }
  | { kind: "active"; read: ExecutionAuthorityReader }
  | { kind: "unavailable"; code: string; message: string }
  | { kind: "unsupported"; error: AgentToolResult };

async function executionRouteOf(harnessDir: string): Promise<ExecutionRouteVerdict> {
  const loaded = await loadExecutionReadExports();
  if (!loaded.ok) return { kind: "unsupported", error: loaded.error };
  try {
    return (await loaded.resolve({ harnessDir })) === "execution"
      ? { kind: "active", read: loaded.read }
      : { kind: "files" };
  } catch (error) {
    return { kind: "unavailable", ...refusalOf(error) };
  }
}

/** True when `dir` itself is a harness root: the v2 markers this tool
 * classifies documents with (`status.json` + layout dirs), or the root the
 * engine resolves from the directory's PARENT (default `.mstar`-style and
 * `.mstarc harness_dir` roots — `resolveHarnessDir(dir)` probes *inside* a
 * directory, so it never answers for the root itself). */
function isHarnessRootDir(dir: string): boolean {
  if (hasHarnessRootMarkers(dir)) return true;
  const parentResolved = resolveHarnessDir(dirname(dir));
  return parentResolved !== null && resolve(parentResolved) === dir;
}

/** The path a write to `resolved` really lands on (S-G4b-03): authority
 * classification runs on the caller's own path first and on this one when the
 * target is an alias — a symlink outside the harness tree resolving to a
 * harness-root `store.db` / retired `residuals.json` IS that authority file.
 * A dangling symlink resolves to its would-be target: the file a write
 * through the link creates. One canonicalization per checked target (the
 * document lint keeps the caller's path), mirrored in the omp hook, the
 * OpenCode plugin and the ZCode write gate. */
function landedPathOf(resolved: string): string {
  try {
    return realpathSync(resolved);
  } catch {
    try {
      return resolve(dirname(resolved), readlinkSync(resolved));
    } catch {
      return resolved; // no such target yet (a fresh file) — the path itself decides
    }
  }
}

/** True when `target` (absolute) IS the authority database (or a WAL sidecar)
 * sitting directly at a harness root: the runtime's own store location for a
 * harness root is `<harness root>/store.db`, and hand-writing those bytes is
 * never a supported operation — hard vs soft, staged vs active, alias or not,
 * all the same. */
function isStoreAuthorityTarget(target: string): boolean {
  if (!STORE_AUTHORITY_FILES.includes(basename(target))) return false;
  return isHarnessRootDir(dirname(target));
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

/** One authority refusal as the tool's violation line + machine details. */
function authorityViolation(code: string, message: string): ValidationResult {
  return { ok: false, severity: "high", code, message };
}

export default function mstarStatusValidate(pi: CustomToolAPI): CustomTool {
  return {
    name: "mstar_status_validate",
    label: "Validate harness status.json / workflow snapshot / project register",
    description:
      "Validate a Morning Star harness v2 coordination document: the root status.json (version 2 + workflows[] with per-entry snapshot invariants) via the engine validateStatus gate, or a workflow snapshot (schema_version 1 + plan rows + lease shapes) via validateWorkflowSnapshot. " +
      "A project register target (projects/<id>/residuals.json) is answered through the DB-aware authority route: it reports project.register.retired while {HARNESS_DIR}/store.db is the active findings authority, store.authority-unavailable when that authority cannot be read (below-floor runtime, missing node:sqlite capability, corrupt, drifted, busy), and validates the register document itself (validateProjectRegister) only while no store exists or the store is still staged — the pre-activation window where the register is still the live authority. A direct target at {HARNESS_DIR}/store.db (or its -wal/-shm) is refused: the runtime owns that database. " +
      "The target must be a canonical harness location: {HARNESS_DIR}/status.json, {HARNESS_DIR}/workflows/<id>/snapshot.json, or {HARNESS_DIR}/projects/<id>/residuals.json (Gate 1 layout parity — non-canonical paths are rejected). " +
      "While the control harness's execution authority is ACTIVE the root register and the workflow snapshots are retired as a persistence route: the default target then validates the AUTHORITY's own register instead of the file, and an explicitly named status.json / snapshot.json refuses execution.consumer-not-ready (nothing is read, no file verdict is reported). " +
      "Defaults to {HARNESS_DIR}/status.json discovered from the session cwd; pass `path` to check another file. " +
      "Use after editing status.json / workflows/<id>/snapshot.json, before writable dispatch, or when workflow/plan state edits are reviewed. " +
      "Returns one line per violation as [severity] code: message (fix: …).",
    parameters: pi.zod.object({ path: pi.zod.string().optional() }).optional(),
    async execute(_toolCallId: string, params: Params, _onUpdate, _ctx, _signal): Promise<AgentToolResult> {
      try {
        let statusPath: string;
        let kind: DocKind;
        let harnessDir: string;
        if (params?.path) {
          statusPath = resolve(pi.cwd, params.path);
          // S-G4b-03: the AUTHORITY decision runs on the path the target
          // really lands on — a symlink alias of the store database or of a
          // project register IS that authority file. Nothing else is
          // canonicalized (a status.json/snapshot alias behaves as before).
          const landed = landedPathOf(statusPath);
          const storeTarget = isStoreAuthorityTarget(statusPath)
            ? statusPath
            : isStoreAuthorityTarget(landed)
              ? landed
              : null;
          if (storeTarget !== null) {
            return result(
              violationLines([
                authorityViolation(
                  STORE_DIRECT_WRITE_CODE,
                  `${storeTarget} is the issue/catalog authority database and is owned by the runtime — a direct ` +
                    "hand write is refused (the schema and its WAL are managed in-process). Schema changes go " +
                    "through `mstar store init|upgrade|migrate`, findings through `mstar issue add|close`, catalog " +
                    "rows through `mstar catalog register|update`",
                ),
              ]),
              { path: statusPath, kind: "store", ok: false },
              true,
            );
          }
 // Phase-5 F1: ensure the custom-layout dir resolvers are loaded
 // before classifying (stale engine -> null -> default names).
          classifyDirResolvers = await dirResolversLoader.load();
          const target = harnessDocKindOfTarget(statusPath);
          const registerDir = target?.kind === "register" ? target.harnessDir : aliasedRegisterDir(statusPath, landed);
          if (target !== null) {
            kind = target.kind;
            harnessDir = target.harnessDir;
          } else if (registerDir !== null) {
            kind = "register";
            harnessDir = registerDir;
          } else {
            return result(
              `mstar_status_validate: ${statusPath} is not a canonical harness coordination document — expected {HARNESS_DIR}/status.json, {HARNESS_DIR}/workflows/<id>/snapshot.json, or {HARNESS_DIR}/projects/<id>/residuals.json`,
              { path: statusPath, ok: false },
              true,
            );
          }
        } else {
          const resolvedHarnessDir = resolveHarnessDir(pi.cwd);
          if (resolvedHarnessDir === null) {
            return result(
              `no harness directory found from "${pi.cwd}" (looked for .mstar/ / .agents/ / .plans/ / plans/ walking up) — pass an explicit path`,
              { cwd: pi.cwd },
              true,
            );
          }
          harnessDir = resolvedHarnessDir;
          statusPath = join(harnessDir, STATUS_FILE);
          kind = "status";
        }

        // §5/§4.3: while the control harness's execution authority is ACTIVE the
        // root register and the workflow snapshots are RETIRED as a persistence
        // route, so neither is a gate input any more.
        //
        // - The DEFAULT target IS the root register: the authority answers by
        //   validating its OWN register through its own readers (membership and
        //   every stored row), exactly as `mstar status validate` does — the file
        //   document rules are NOT reused, because the file contract's
        //   `updated_at` is a date while the register's own timestamp is a UTC
        //   instant, and reusing them would report a false FAIL on a healthy
        //   authority.
        // - An explicitly named status.json / snapshot.json is a read of retired
        //   bytes: it refuses `execution.consumer-not-ready` rather than
        //   reporting a verdict nobody consults.
        // A store that EXISTS and cannot be read keeps its own refusal (never a
        // fall-through to the retired file route).
        if (kind !== "register") {
          const execution = await executionRouteOf(harnessDir);
          if (execution.kind === "unsupported") return execution.error;
          if (execution.kind === "unavailable") {
            return result(
              violationLines([
                authorityViolation(
                  STORE_AUTHORITY_UNAVAILABLE_CODE,
                  `the execution authority of ${harnessDir} could not be read ([${execution.code}] ${execution.message}) — ` +
                    "the root register and workflow snapshots are retired while that authority governs them, so no " +
                    "file-route verdict is available; no JSON fallback exists",
                ),
              ]),
              { path: statusPath, kind, ok: false, store: { code: execution.code, message: execution.message } },
              true,
            );
          }
          if (execution.kind === "active") {
            if (params?.path === undefined) {
              const authorityRead = await execution.read({ harnessDir });
              const workflows = authorityRead.data.workflows.length;
              return result(
                `status.json valid — answered by the execution authority (store ${authorityRead.storeId}, epoch ` +
                  `${authorityRead.epoch}, ${workflows} active workflow${workflows === 1 ? "" : "s"})`,
                {
                  path: statusPath,
                  kind,
                  route: "execution",
                  store_id: authorityRead.storeId,
                  epoch: authorityRead.epoch,
                  workflow_count: workflows,
                  ok: true,
                  violations: [],
                },
                false,
              );
            }
            return result(
              violationLines([
                authorityViolation(
                  EXECUTION_CONSUMER_NOT_READY_CODE,
                  `${statusPath} is retired as a persistence route while the execution authority of ${harnessDir} is ` +
                    "ACTIVE: the root register and the workflow snapshots live in the execution store, and these bytes " +
                    "are no longer consulted. Nothing was read — validate the authority instead (`mstar status validate` " +
                    "with no path, or the execution DB adapter); this consumer's document-read migration is deferred (2b)",
                ),
              ]),
              { path: statusPath, kind, ok: false, route: "execution" },
              true,
            );
          }
        }

        let gate: { ok: boolean; violations: ValidationResult[] };
        if (kind === "status") {
          gate = validateStatus(statusPath);
        } else if (kind === "register") {
          // G4b: the register's document shape is only meaningful while the
          // register IS the live authority. A store-backed workspace answers
          // through the DB-aware route instead — and when the authority
          // cannot be read at all, the tool refuses rather than shape-checking
          // a document nobody consults any more.
          const route = await readAuthorityRoute(harnessDir);
          if (route.kind === "retired") {
            return result(
              violationLines([
                authorityViolation(
                  REGISTER_RETIRED_CODE,
                  "project registers are retired migration history — the issue store " +
                    `({HARNESS_DIR}/store.db, revision ${route.storeRevision}) is the only findings authority; capture ` +
                    "and close through `mstar plan issue-add|issue-close` (plan-scoped) or `mstar issue add|close` " +
                    "(unscoped)",
                ),
              ]),
              { path: statusPath, kind, ok: false, retired: true, store_revision: route.storeRevision },
              true,
            );
          }
          if (route.kind === "unavailable") {
            return result(
              violationLines([
                authorityViolation(
                  STORE_AUTHORITY_UNAVAILABLE_CODE,
                  `the issue authority could not be read ([${route.code}] ${route.message}) — the register is only ` +
                    "validated while it is still the live authority; no older-runtime or JSON fallback exists",
                ),
              ]),
              { path: statusPath, kind, ok: false, store: { code: route.code, message: route.message } },
              true,
            );
          }
          // `legacy`: no store / staged store — pre-activation, the register is
          // still the findings authority, so its own validator applies.
          const registerValidators = await loadNewValidators();
          if (!registerValidators.ok) return registerValidators.error;
          let registerDoc: unknown;
          try {
            registerDoc = readJson(statusPath);
          } catch (error) {
            return result(`mstar_status_validate failed: ${(error as Error).message}`, { path: statusPath }, true);
          }
          gate = registerValidators.validateProjectRegister(registerDoc);
        } else {
          const validators = await loadNewValidators();
          if (!validators.ok) return validators.error;
          let doc: unknown;
          try {
            doc = readJson(statusPath);
          } catch (error) {
            return result(`mstar_status_validate failed: ${(error as Error).message}`, { path: statusPath }, true);
          }
          gate = validators.validateWorkflowSnapshot(doc);
        }
 // Row/workflow counts only when the gate passed: the validators
 // already proved the file parses, so the re-read cannot throw.
        let planCount: number | null = null;
        let workflowCount: number | null = null;
        let entryCount: number | null = null;
        if (gate.ok) {
          const doc = readJson(statusPath) as { plans?: unknown; workflows?: unknown; entries?: unknown };
          if (kind === "snapshot") {
            planCount = Array.isArray(doc.plans) ? doc.plans.length : 0;
          } else if (kind === "register") {
            entryCount = doc.entries !== null && typeof doc.entries === "object" && !Array.isArray(doc.entries)
              ? Object.keys(doc.entries).length
              : 0;
          } else {
            workflowCount = Array.isArray(doc.workflows) ? doc.workflows.length : 0;
          }
        }
        const label = kind === "snapshot" ? "snapshot" : kind === "register" ? "register" : "status.json";
        return result(
          gate.ok
            ? `${label} valid${planCount !== null ? ` (${planCount} plans)` : ""}${workflowCount !== null ? ` (${workflowCount} active workflows)` : ""}${entryCount !== null ? ` (${entryCount} plans with entries)` : ""}`
            : violationLines(gate.violations),
          { path: statusPath, kind, plan_count: planCount, workflow_count: workflowCount, entry_count: entryCount, ok: gate.ok, violations: gate.violations },
          !gate.ok,
        );
      } catch (error) {
        return result(`mstar_status_validate failed: ${(error as Error).message}`, {}, true);
      }
    },
  };
}
