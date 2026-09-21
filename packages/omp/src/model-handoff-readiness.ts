/**
 * E1/E2 — explicit workflow binding and read-only Phase 1 readiness for the
 * coordinator model handoff.
 *
 * E1 (`reserveHandoffBinding`) validates the explicit first-action assertion
 * (trusted PM input) against host/Git facts and resolves **paths**, never
 * lifecycle state: it creates nothing, adopts nothing and mutates no workflow,
 * session or settings document. The workflow id is validated as a single safe
 * path component *before* any shared-state read. The required structural mode
 * selects the branch: `reserve` reads the root register only to refuse an id
 * that is already a named workflow, while `attach` revalidates the named
 * active register row and its actual own snapshot. Ownership is never inferred
 * from rows (`workflows[0]`, latest-mtime or "the unique new row" are not
 * selection rules, and a sibling active workflow is not a refusal reason).
 *
 * E2 (`inspectPhase1Readiness`) re-reads the artifacts and Git facts the PM
 * asserted and refuses on any disagreement. Trust split (spec §E2): the PM
 * asserts that the named native returns are settled, ordered and accepted and
 * that the named plan sections complete Specify/Clarify/Plan; this module
 * mechanically checks receipt role/order/uniqueness, native reference shape,
 * canonical containment and current bytes of every named file, root/snapshot/
 * compass agreement, the locked compass, the live integration checkout and the
 * pushed remote tip. It never claims to verify historical review correctness,
 * never creates workflow state and never obtains a lease.
 *
 * A refusal is reported as the frozen broad gate code the callers already
 * depend on (`Phase1RefusalCode`) **plus** a typed `Phase1Diagnostic` that
 * names the prerequisite-contract §5 subreason, the subject (workflow, and the
 * plan for a path refusal), the safe label of the identity source, the public
 * ids already in play, the canonical base/target of a plan pointer and the next
 * supported operation. A bad plan pointer is therefore never rendered as an
 * unlocked compass: the pointer keeps its own `plan-pointer-invalid` /
 * `plan-identity-mismatch` detail and only a genuinely unlocked compass
 * produces `prepare-unlocked`. Identity and path resolution reuse the shared
 * seams — `resolveRegisteredPlanFile` for every row pointer and the engine's
 * own read-only `showPrepareCoordinatorRecovery` view for the recovery verdict
 * — so readiness, registration and the guarded Prepare correction agree. The
 * diagnostics render public ids, codes and canonical paths only: never an
 * envelope path, credential, session JSON or environment payload.
 *
 * `execution_policy.push_policy` is deliberately not consulted: it is
 * accepted-but-opaque engine data and supplies no push waiver — the remote tip
 * comes from read-only `git ls-remote` output, never from a cached tracking
 * ref, and the same query is repeated in the closing re-sample so a remote
 * advanced while the checkpoint runs cannot report ready. The coordinator
 * envelope is read only for this checkpoint and is never forwarded into another
 * input, notice or report.
 *
 * Every read is bounded to artifacts derived from the bound workflow: the bound
 * snapshot/compass paths are compared with the re-derived ones *before* the root
 * register or any artifact is opened. Each named artifact is then pinned on
 * three independent identities — the logical path with its lstat kind and raw
 * symlink target, the canonical target, and the content hash of the bytes read
 * through the logical path — and all three are re-checked before success, so a
 * retargeted symlink or a rewritten file inside the checkpoint window refuses
 * (`evidence-changed`, or the artifact's containment code when it escaped its
 * allowed roots).
 *
 * Read-only by construction: files are read, Git is probed with read-only
 * commands, and nothing is written anywhere.
 *
 * ## Execution authority (source readiness, plan S3)
 *
 * Every artifact this module consumes — the root register, the workflow
 * snapshot, the coordinator envelope — is retired as a persistence route while
 * the control harness's execution authority is ACTIVE (primary spec §4.3), and
 * the coordinator envelope is precisely the old session credential §5 keeps on
 * the file route until its consumer is migrated. Both E1 and E2 therefore ask
 * the engine's route (`resolveExecutionReadRoute`, plan S2) once the harness
 * root is established and, for an ACTIVE authority, refuse
 * `execution.consumer-not-ready` before any artifact is opened: no binding is
 * reserved, no receipt is fabricated and no readiness verdict is derived from
 * retired bytes. A store that exists and cannot be read throws that store's own
 * refusal (there is no verdict to give about either route then), and a harness
 * with no store at all keeps the unchanged file route — §2.1's absence is not
 * an authority verdict. The DB session-reference binding this consumer needs is
 * the explicit 2b obligation, not something this checkpoint invents.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import {
  PlanPathError,
  canonicalizeNearestExisting,
  isDistinctCheckout,
  parseCompassFrontmatter,
  probeCheckoutRoot,
  readMainWorktree,
  readSessionEnvelope,
  readWorkflowSnapshot,
  resolveExecutionReadRoute,
  resolveHarnessDir,
  resolveIterationDir,
  resolvePlanDir,
  resolveRegisteredPlanFile,
  resolveWorkflowDir,
  showPrepareCoordinatorRecovery,
  validateCompassFrontmatter,
  validateStatusV2,
  WORKFLOW_SNAPSHOT_FILE,
} from "@mstar-harness/engine";
import type { PrepareCoordinatorRecoveryView, WorkflowSnapshot } from "@mstar-harness/engine";

/** Root register file inside the harness dir (v2 `status.json`). */
const STATUS_FILE = "status.json";
/** Iteration compass file name inside `{ITERATION_DIR}/<iteration-id>/`. */
const COMPASS_FILE = "delivery-compass.md";
/** Frozen sequential Phase 1 specialist order (spec §Full Phase 1 handoff). */
const SPECIALIST_ROLES = ["product-manager", "architect", "writing-specialist"] as const;
/** A native completion reference — the only accepted `resultRef` shape. */
const NATIVE_RESULT_REF_RE = /^(?:agent|artifact):\/\/\S+$/;
/** Single safe path component (mirrors the engine's traversal guard). */
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;
/** Abbreviated-object-name shape of a probed HEAD. */
const SHA_RE = /^[0-9a-f]{40}$/;
/** Bound every Git probe so a hung remote cannot stall the checkpoint. */
const GIT_PROBE_TIMEOUT_MS = 10_000;
/** Git's own in-progress markers on a checkout. */
const IN_PROGRESS_FILES = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"] as const;
const IN_PROGRESS_DIRS = ["rebase-merge", "rebase-apply"] as const;

/** One canonical type guard for the JSON documents this module inspects. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Single safe path component: no "", ".", "..", "/", "\\" (engine guard semantics). */
function isSafePathComponent(value: unknown): value is string {
  return isNonEmptyString(value) && value !== "." && value !== ".." && SAFE_ID_RE.test(value);
}

function isUnder(child: string, parent: string): boolean {
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child === parent || child.startsWith(prefix);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ E1 ---- */

export type HandoffEntry = "iteration-start" | "iteration-loop" | "skill-start";

export type HandoffBindingInput = Readonly<{
  workflowId: string;
  entry: HandoffEntry;
  intent: "new-iteration";
  authority: "coordinator";
}>;

export type HandoffBinding = Readonly<{
  sessionId: string;
  workflowId: string;
  controlRoot: string;
  harnessRoot: string;
  snapshotPath: string;
  compassPath: string;
}>;

type HandoffRefusalCode =
  | "not-coordinator"
  | "already-bound"
  | "invalid-workflow"
  | "invalid-root"
  | "execution.consumer-not-ready";

export type HandoffBindingResult =
  | { ok: true; binding: HandoffBinding }
  | { ok: false; code: HandoffRefusalCode; message: string };

const HANDOFF_ENTRIES: readonly HandoffEntry[] = ["iteration-start", "iteration-loop", "skill-start"];

function bindingRefusal(code: HandoffRefusalCode, message: string): HandoffBindingResult {
  return { ok: false, code, message };
}

/**
 * Structural route selection for the explicit first-action binding. Pure
 * structure: the returned paths are the *derived* locations of the named
 * workflow, never validated lifecycle ownership (adoption authority lives
 * solely in the adapter's `deriveStartAuthority`; E2 checks the live
 * artifacts against the coordinator envelope).
 *
 * - `"reserve"` — the unregistered path: the root register is read only to
 *   reject an already-named id, and existing snapshot/compass artifacts are
 *   refusals. An absent register permits the session reservation only.
 * - `"attach"` — the registered path: the named active register row and its
 *   actual own snapshot are revalidated; an existing own snapshot/compass is
 *   expected, not a refusal. Absent/mismatched registration or snapshot
 *   refuses `invalid-root`; there is no fallback into reservation.
 *
 * The mode is a structural selector derived by the adapter from the validated
 * register — never public tool input and never proof of authority. No row or
 * envelope is ever used to infer ownership.
 */
export async function reserveHandoffBinding(
  input: HandoffBindingInput,
  host: Readonly<{ sessionId: string; cwd: string; taskSession: boolean }>,
  mode: "reserve" | "attach",
): Promise<HandoffBindingResult> {
  // Trusted PM assertions first (spec §E1): intent, role and the new-start
  // entry are asserted, and the host facts a native task session cannot supply
  // are checked here.
  if (input.authority !== "coordinator") {
    return bindingRefusal(
      "not-coordinator",
      `handoff start requires authority "coordinator", received ${JSON.stringify(input.authority)}`,
    );
  }
  if (input.intent !== "new-iteration") {
    return bindingRefusal(
      "not-coordinator",
      `handoff start requires intent "new-iteration", received ${JSON.stringify(input.intent)}`,
    );
  }
  if (!HANDOFF_ENTRIES.includes(input.entry)) {
    return bindingRefusal("not-coordinator", `handoff start requires entry one of ${HANDOFF_ENTRIES.join(" | ")}`);
  }
  if (host.taskSession === true) {
    return bindingRefusal("not-coordinator", "a native task/focused-agent session never owns a coordinator binding");
  }
  if (!isNonEmptyString(host.sessionId)) {
    return bindingRefusal("not-coordinator", "the host session id is missing");
  }

  // Safe ID before any shared-state read: it becomes a path segment.
  const workflowId = input.workflowId;
  if (!isSafePathComponent(workflowId)) {
    return bindingRefusal(
      "invalid-workflow",
      `workflowId must be a single safe path component ([A-Za-z0-9._-]+; not "", ".", ".." or containing "/" or "\\") — got ${JSON.stringify(workflowId)}`,
    );
  }

  if (!isNonEmptyString(host.cwd) || !isAbsolute(host.cwd)) {
    return bindingRefusal("invalid-root", "the host cwd must be an absolute path");
  }
  const main = readMainWorktree(host.cwd);
  if (main === null || !isNonEmptyString(main.root)) {
    return bindingRefusal("invalid-root", `cannot resolve the Git main worktree of ${host.cwd}`);
  }
  let cwdReal: string;
  try {
    cwdReal = realpathSync(host.cwd);
  } catch {
    return bindingRefusal("invalid-root", `the host cwd is not readable: ${host.cwd}`);
  }
  // Canonical main-checkout residency: the coordinator's own checkout root must
  // BE the main worktree. A linked worktree (even one nested under the main
  // checkout) and a plain subdirectory alias are refused, while a symlink alias
  // of the main checkout resolves to the same root and passes.
  const controlRoot = main.root;
  if (probeCheckoutRoot(cwdReal) !== controlRoot) {
    return bindingRefusal(
      "invalid-root",
      `the coordinator must run in the canonical main checkout ${controlRoot}; ${host.cwd} is a different checkout`,
    );
  }

  let resolvedHarness: string | null;
  try {
    resolvedHarness = resolveHarnessDir(controlRoot);
  } catch {
    resolvedHarness = null;
  }
  if (resolvedHarness === null) {
    return bindingRefusal("invalid-root", `no harness dir resolves from the main checkout ${controlRoot}`);
  }
  const harnessRoot = canonicalizeNearestExisting(resolvedHarness);
  if (!isDirectory(harnessRoot)) {
    return bindingRefusal("invalid-root", `the resolved harness dir does not exist: ${harnessRoot}`);
  }
  // §5: this binding is a FILE address (snapshot + compass + the coordinator
  // envelope E2 re-validates), and the root register it classifies against is
  // retired as a persistence route while the control harness's execution
  // authority is ACTIVE (primary spec §4.3). Reading those bytes would be the
  // forbidden fallback, and materializing a DB session binding is the session
  // -file invention §5's STOP line forbids — so the binding reports not-ready
  // and its DB session-reference migration stays an explicit 2b obligation. A
  // store that exists and cannot be read throws that store's own refusal: this
  // checkpoint then has no verdict to give about either route.
  if ((await resolveExecutionReadRoute({ harnessDir: harnessRoot })) === "execution") {
    return bindingRefusal(
      "execution.consumer-not-ready",
      `the execution authority of ${harnessRoot} is ACTIVE, so the root register, the workflow snapshots and the ` +
        "coordinator envelopes of this binding are retired as a route. No binding was reserved: this file binding has " +
        "no DB session reference yet (deferred, 2b), and reading the retired documents would be exactly the fallback " +
        "the execution contract forbids",
    );
  }

  // Engine path resolvers with the explicit harness override (never a
  // `dirname(harnessRoot)` layout assumption).
  let snapshotPath: string;
  let compassPath: string;
  try {
    const workflowDir = resolveWorkflowDir(controlRoot, { harnessDir: harnessRoot });
    const iterationDir = resolveIterationDir(harnessRoot);
    snapshotPath = canonicalizeNearestExisting(join(workflowDir, workflowId, WORKFLOW_SNAPSHOT_FILE));
    compassPath = canonicalizeNearestExisting(join(iterationDir, workflowId, COMPASS_FILE));
  } catch (error) {
    return bindingRefusal("invalid-root", `cannot resolve the workflow/iteration paths: ${String(error)}`);
  }

  // The root register is validated and read for the mode's structural branch:
  // `reserve` rejects an already-named id, `attach` revalidates the named row.
  // Malformed register data refuses in both modes, and no row is ever used to
  // infer ownership.
  const statusPath = join(harnessRoot, STATUS_FILE);
  if (!existsSync(statusPath)) {
    if (mode === "attach") {
      return bindingRefusal("invalid-root", `attach requires a registered workflow and the root register is absent: ${statusPath}`);
    }
  } else {
    const gate = validateStatusV2(statusPath);
    if (!gate.ok) {
      return bindingRefusal(
        "invalid-root",
        `the root register is not a valid v2 status document: ${gate.violations[0]?.code ?? "invalid"}`,
      );
    }
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(statusPath, "utf8"));
    } catch {
      return bindingRefusal("invalid-root", `the root register is not readable: ${statusPath}`);
    }
    const entries = isPlainObject(doc) && Array.isArray(doc.workflows) ? doc.workflows : [];
    const own = entries.filter((entry) => isPlainObject(entry) && entry.id === workflowId);
    if (mode === "reserve") {
      if (own.length > 0) {
        return bindingRefusal(
          "already-bound",
          `workflow ${workflowId} is already registered in the root register — a new start never adopts it`,
        );
      }
    } else {
      // Attach revalidates the named active register row rather than trusting
      // the adapter's earlier classification: the row must exist and its
      // registered directory must canonically resolve to the derived snapshot.
      const row = own.length === 1 ? own[0]! : null;
      const rowDir = row !== null && isNonEmptyString(row.dir) ? row.dir : null;
      if (row === null || rowDir === null) {
        return bindingRefusal("invalid-root", `attach requires exactly one active register row for workflow ${workflowId}`);
      }
      const listedSnapshot = canonicalizeNearestExisting(join(harnessRoot, rowDir, WORKFLOW_SNAPSHOT_FILE));
      if (listedSnapshot !== snapshotPath) {
        return bindingRefusal(
          "invalid-root",
          `the register row for workflow ${workflowId} does not resolve to its own snapshot: ${rowDir}`,
        );
      }
    }
  }

  if (mode === "reserve") {
    if (existsSync(snapshotPath)) {
      return bindingRefusal("already-bound", `a workflow snapshot already exists at ${snapshotPath}`);
    }
    if (existsSync(compassPath)) {
      return bindingRefusal("already-bound", `an iteration compass already exists at ${compassPath}`);
    }
  } else {
    // Attach expects the workflow's own snapshot to actually exist and to name
    // this workflow; a vanished or mismatched snapshot is never adopted. The
    // existing own snapshot/compass is not itself a refusal — authority is
    // decided solely by the adapter's `deriveStartAuthority`.
    if (!existsSync(snapshotPath)) {
      return bindingRefusal("invalid-root", `attach requires the registered workflow snapshot and it is missing: ${snapshotPath}`);
    }
    try {
      const snapshot = readWorkflowSnapshot(dirname(snapshotPath)).snapshot;
      if (snapshot.id !== workflowId) {
        return bindingRefusal("invalid-root", `the workflow snapshot at ${snapshotPath} does not name workflow ${workflowId}`);
      }
      // Attachment requires an actually active iteration: a terminal or
      // non-iteration workflow is never adopted as a structural candidate
      // (the running-iteration check must not wait for Phase-1 readiness).
      if (snapshot.status !== "running" || snapshot.type !== "iteration") {
        return bindingRefusal(
          "invalid-root",
          `workflow ${workflowId} snapshot at ${snapshotPath} is not a running iteration (status ${snapshot.status}, type ${snapshot.type})`,
        );
      }
    } catch {
      return bindingRefusal("invalid-root", `the workflow snapshot is not readable: ${snapshotPath}`);
    }
  }

  return {
    ok: true,
    binding: { sessionId: host.sessionId, workflowId, controlRoot, harnessRoot, snapshotPath, compassPath },
  };
}

/* ------------------------------------------------------------------ E2 ---- */

export type SpecialistReceipt<Role extends string> = Readonly<{
  role: Role;
  agentId: string;
  resultRef: string;
  reportPath: string;
}>;

export type Phase1CompletionInput = Readonly<{
  workflowId: string;
  coordinatorSessionPath: string;
  mainWorktreeBranch: string;
  reviews: readonly [
    SpecialistReceipt<"product-manager">,
    SpecialistReceipt<"architect">,
    SpecialistReceipt<"writing-specialist">,
  ];
  plans: readonly Readonly<{
    planId: string;
    planPath: string;
    prepareEvidencePath: string;
  }>[];
}>;

export type Phase1Receipt = Readonly<{
  input: Phase1CompletionInput;
  binding: HandoffBinding;
  artifactVersions: readonly Readonly<{ path: string; version: string }>[];
}>;

export type Phase1RefusalCode =
  | "binding-invalid"
  | "review-evidence-missing"
  | "prepare-not-locked"
  | "worktree-invalid"
  | "branch-mismatch"
  | "push-unverified"
  | "evidence-changed"
  | "execution.consumer-not-ready";

/** Reporting order — the frozen code union order. */
const CODE_ORDER: readonly Phase1RefusalCode[] = [
  "binding-invalid",
  "review-evidence-missing",
  "prepare-not-locked",
  "worktree-invalid",
  "branch-mismatch",
  "push-unverified",
  "evidence-changed",
  "execution.consumer-not-ready",
];

/**
 * The identity subreasons of prerequisite contract §5. They refine the broad
 * `binding-invalid` gate rather than replacing it: an acquisition that carries
 * no id is `identity-missing`, a value that does not address the scope it was
 * checked against is `identity-mismatch`, a recorded owner whose proof this
 * session does not hold is `foreign-owner`, and the three `recovery-*` values
 * say why the narrow JSON Prepare repair is **not** currently admitted.
 */
export type Phase1IdentityDetail =
  | "identity-missing"
  | "identity-mismatch"
  | "foreign-owner"
  | "recovery-not-prepare"
  | "recovery-stale"
  | "recovery-unauthorized";

/**
 * The path subreasons of §5: a pointer that is not the canonical registered
 * plan file (`plan-pointer-invalid`), a pointer that resolves to a file whose
 * own declared `plan_id` disagrees (`plan-identity-mismatch`), and a compass
 * that is genuinely not locked (`prepare-unlocked`).
 */
export type Phase1PathDetail = "plan-pointer-invalid" | "plan-identity-mismatch" | "prepare-unlocked";

/**
 * Safe §4 classification of the *form* a refused plan pointer was received in
 * — the axis the shared resolver accepts (a canonical absolute path or a
 * normalized harness-relative one). It is a classification only: the pointer's
 * own value is never projected, because a stored row may hold any string at all
 * (an envelope, credential or session path included).
 */
export type Phase1PointerForm = "canonical-absolute" | "harness-relative";

/** Safe label of where an observed identity or pointer value came from. */
export type Phase1DiagnosticSource =
  | "host-session"
  | "snapshot-coordinator"
  | "session-envelope"
  | "recovery-view"
  | "plan-row";

/**
 * One typed refinement of a broad refusal code (§5). It carries the subject,
 * the safe source label, the public ids already in play, the canonical
 * base/target of a plan pointer and the next supported operation — never an
 * envelope path, credential, session JSON or environment payload.
 */
export type Phase1Diagnostic = Readonly<{
  /** The broad gate code this detail refines; always also present in `codes`. */
  code: Phase1RefusalCode;
  detail: Phase1IdentityDetail | Phase1PathDetail;
  workflowId: string;
  /** The plan this detail addresses, for a row-level path refusal. */
  planId?: string;
  source?: Phase1DiagnosticSource;
  /** A public id/pointer that is already in play (never a credential). */
  expected?: string;
  /** The observed public id that disagreed with `expected` (never a path value). */
  current?: string;
  /** Safe received-form classification of a refused plan pointer — never its value. */
  received?: Phase1PointerForm;
  /** Canonical plan root a pointer was resolved against. */
  base?: string;
  /** Canonical registered plan file the pointer was expected to name. */
  target?: string;
  /** The next supported operation. */
  next: string;
}>;

/** The named next steps a diagnostic offers instead of a bare refusal. */
const NEXT_BIND =
  'call `mstar_coordinator` with {operation:"bind", workflowId} from this workflow\'s coordinator session';
const NEXT_RECOVER =
  'call `mstar_coordinator` with {operation:"recover", …} from this session, naming the recorded holder in stoppedSessionIds';
const NEXT_RECOVERY_VIEW =
  'call `mstar_coordinator` with {operation:"show-recovery", workflowId} to read the current recovery verdict';
const NEXT_COORDINATOR_EVIDENCE =
  "re-run this checkpoint with the workflow's recorded coordinator envelope and the ordered specialist returns";
const NEXT_REGISTERED_PLAN =
  "register the row through `mstar iteration register`, or repair it with the guarded Prepare plan-file correction";
const NEXT_LOCK_COMPASS = "lock the reviewed delivery compass, then re-run this checkpoint";

/**
 * §5 classification of one engine recovery-admission blocker into the shared
 * identity-detail vocabulary. The engine's own reason union is the input
 * (`packages/engine/src/coordination.ts`), so the readiness diagnostic and the
 * `mstar_coordinator` view never disagree about the same blocker.
 */
export function identityDetailOfRecoveryBlocker(code: string): Phase1IdentityDetail {
  if (code === "unauthorized") return "recovery-unauthorized";
  if (code === "stale") return "recovery-stale";
  if (code === "foreign-owner") return "foreign-owner";
  return "recovery-not-prepare";
}

/** Whether the narrow JSON Prepare repair is admitted, and what to do next. */
type RecoveryVerdict = Readonly<{ detail: Phase1IdentityDetail | null; next: string }>;

/**
 * The recovery verdict of one workflow, read through the engine's own read-only
 * §3.3 view — the same view `mstar_coordinator {operation:"show-recovery"}`
 * projects. A readable, admitted verdict names the recovery operation as the
 * next step; an inadmissible lifecycle contributes its typed `recovery-*`
 * detail instead. The view is read-only and never throws past this boundary: an
 * unreadable verdict says so rather than turning into an identity verdict.
 */
async function recoveryVerdict(controlRoot: string, harnessRoot: string, workflowId: string): Promise<RecoveryVerdict> {
  let view: PrepareCoordinatorRecoveryView;
  try {
    view = await showPrepareCoordinatorRecovery({ cwd: controlRoot, harnessDir: harnessRoot, workflowId });
  } catch {
    return { detail: null, next: NEXT_RECOVERY_VIEW };
  }
  if (view.allowed) return { detail: null, next: NEXT_RECOVER };
  const blocker = view.blockers[0];
  if (blocker === undefined) return { detail: "recovery-not-prepare", next: NEXT_RECOVERY_VIEW };
  return { detail: identityDetailOfRecoveryBlocker(blocker.code), next: NEXT_RECOVERY_VIEW };
}

export type Phase1Readiness =
  | { ready: true; binding: HandoffBinding; integrationHead: string; receipt: Phase1Receipt }
  | { ready: false; codes: readonly Phase1RefusalCode[]; diagnostics: readonly Phase1Diagnostic[] };

/**
 * One sampled artifact, pinned on three independent identities so a change
 * made during the checkpoint cannot slip past the final re-sample: the
 * **logical** path exactly as named by the caller (with its own lstat kind and,
 * when it is a symlink, the raw link target), the **canonical** path it resolves
 * to, and the **content** hash of the bytes read through the logical path.
 */
type ArtifactPin = {
  logical: string;
  link: string | null;
  real: string;
  bytes: Buffer;
  size: number;
  version: string;
  /** Refusal code when this artifact escapes its allowed roots. */
  containment: Phase1RefusalCode;
  /** Canonical roots this artifact must stay inside. */
  roots: readonly string[];
};

/** What `pinArtifact` observes: the three identities plus the size. */
type ArtifactObservation = Omit<ArtifactPin, "containment" | "roots">;

/** `sha256:<64 hex>` — the engine's artifact version form. */
function versionOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Observe an absolute path without losing its logical identity: `null` when it
 * is relative, missing, dangling, not a regular file or unreadable. Bytes are
 * read through the logical path (so a retargeted symlink is observed as what it
 * now is) and the canonical target is recorded for containment checks.
 */
function pinArtifact(path: unknown): ArtifactObservation | null {
  if (!isNonEmptyString(path) || !isAbsolute(path)) return null;
  let link: string | null = null;
  let real: string;
  try {
    if (lstatSync(path).isSymbolicLink()) link = readlinkSync(path);
    if (!statSync(path).isFile()) return null;
    real = realpathSync(path);
  } catch {
    return null;
  }
  try {
    const bytes = readFileSync(path);
    return { logical: path, link, real, bytes, size: bytes.byteLength, version: versionOf(bytes) };
  } catch {
    return null;
  }
}

type GitProbe = { ok: true; stdout: string } | { ok: false };

/** Read-only Git probe with a bounded timeout; every failure is fail-closed. */
function git(args: readonly string[], cwd: string): GitProbe {
  try {
    const stdout = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_PROBE_TIMEOUT_MS,
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false };
  }
}

function gitLine(args: readonly string[], cwd: string): string | null {
  const probe = git(args, cwd);
  if (!probe.ok) return null;
  const value = probe.stdout.trim();
  return value === "" ? null : value;
}

/** Canonical Git common dir — shared by every worktree of one repository. */
function gitCommonDir(path: string): string | null {
  const raw = gitLine(["rev-parse", "--git-common-dir"], path);
  if (raw === null) return null;
  try {
    return realpathSync(isAbsolute(raw) ? raw : join(path, raw));
  } catch {
    return null;
  }
}

/** Absolute path of a per-checkout Git metadata entry (`--git-path`). */
function gitPath(cwd: string, name: string): string | null {
  const raw = gitLine(["rev-parse", "--git-path", name], cwd);
  if (raw === null) return null;
  return isAbsolute(raw) ? raw : join(cwd, raw);
}

/** Id of a snapshot plan row (`id`, else the legacy `plan_id`). */
function rowId(row: unknown): string | null {
  if (!isPlainObject(row)) return null;
  return isNonEmptyString(row.id) ? row.id : isNonEmptyString(row.plan_id) ? row.plan_id : null;
}

function orderedCodes(codes: Set<Phase1RefusalCode>): readonly Phase1RefusalCode[] {
  return CODE_ORDER.filter((code) => codes.has(code));
}

/**
 * The read-only Phase 1 checkpoint. Returns the fresh receipt (input, binding
 * and byte-computed artifact versions) plus the live integration HEAD only when
 * the whole conjunction holds; otherwise the frozen refusal codes. Never
 * writes, never retries, never fabricates a receipt and never consults
 * `execution_policy`.
 */
export async function inspectPhase1Readiness(
  binding: HandoffBinding,
  input: Phase1CompletionInput,
): Promise<Phase1Readiness> {
  const codes = new Set<Phase1RefusalCode>();
  const fail = (code: Phase1RefusalCode): void => {
    codes.add(code);
  };
  // §5 typed refinements of those broad codes. Every refusal keeps its frozen
  // code; the diagnostics say which prerequisite actually failed and what the
  // next supported operation is.
  const diagnostics: Phase1Diagnostic[] = [];
  const diagnose = (entry: Phase1Diagnostic): void => {
    diagnostics.push(entry);
  };
  const verdict = (): Phase1Readiness => ({ ready: false, codes: orderedCodes(codes), diagnostics });

  // Pinned artifact identity (spec items 2 and 5). Each artifact keeps its
  // logical path, its raw link target, its canonical target and a content hash,
  // so a retargeted symlink cannot hide a change from the final re-sample.
  const samples = new Map<string, ArtifactPin>();
  const sample = (path: unknown, containment: Phase1RefusalCode, roots: readonly string[]): ArtifactPin | null => {
    const observed = pinArtifact(path);
    if (observed === null) return null;
    const existing = samples.get(observed.logical);
    if (existing !== undefined) return existing;
    const pin: ArtifactPin = { ...observed, containment, roots };
    samples.set(pin.logical, pin);
    return pin;
  };
  /** `null` when the artifact is unchanged; otherwise the code to refuse with. */
  const driftOf = (pin: ArtifactPin): Phase1RefusalCode | null => {
    const fresh = pinArtifact(pin.logical);
    if (fresh === null) return "evidence-changed";
    if (fresh.link !== pin.link || fresh.real !== pin.real) {
      // The logical name now resolves somewhere else. When the new target is
      // outside this artifact's allowed roots the containment class applies
      // (frozen code union — no new code); otherwise it is a changed artifact.
      return pin.roots.some((root) => isUnder(fresh.real, root)) ? "evidence-changed" : pin.containment;
    }
    return fresh.version === pin.version ? null : "evidence-changed";
  };
  const facts: Readonly<{ expected: string | null; probe: () => string | null }>[] = [];
  const record = (probe: () => string | null): string | null => {
    const value = probe();
    facts.push({ expected: value, probe });
    return value;
  };

  // --- item 1: binding identity, root entry, snapshot, compass --------------
  if (!isPlainObject(binding) || !isSafePathComponent(binding.workflowId)) {
    fail("binding-invalid");
    return verdict();
  }
  if (!isNonEmptyString(input?.workflowId) || input.workflowId !== binding.workflowId) fail("binding-invalid");
  if (!isNonEmptyString(binding.sessionId)) {
    fail("binding-invalid");
    // The host adapter acquired no session id: nothing can be authenticated,
    // and the engine never generates a coordinator identity. The remaining
    // shape checks still run, so the set of broad codes is unchanged.
    diagnose({
      code: "binding-invalid",
      detail: "identity-missing",
      workflowId: binding.workflowId,
      source: "host-session",
      expected: binding.workflowId,
      next: NEXT_BIND,
    });
  }
  if (!isNonEmptyString(binding.controlRoot) || !isAbsolute(binding.controlRoot)) fail("binding-invalid");
  if (
    !isNonEmptyString(binding.harnessRoot) ||
    !isNonEmptyString(binding.snapshotPath) ||
    !isNonEmptyString(binding.compassPath)
  ) {
    fail("binding-invalid");
  }
  if (!isNonEmptyString(input?.coordinatorSessionPath) || !isAbsolute(input.coordinatorSessionPath)) {
    fail("binding-invalid");
  }
  if (!isNonEmptyString(input?.mainWorktreeBranch)) fail("branch-mismatch");

  let controlRoot: string | null = null;
  try {
    controlRoot = realpathSync(binding.controlRoot);
  } catch {
    controlRoot = null;
  }
  // Git-derived control root: the binding's control root must itself be the
  // main worktree of its own repository.
  const main = isNonEmptyString(binding.controlRoot) ? readMainWorktree(binding.controlRoot) : null;
  if (controlRoot === null || !isDirectory(controlRoot) || main === null || main.root !== controlRoot) {
    fail("binding-invalid");
  }
  if (controlRoot === null || codes.size > 0) return verdict();

  // Every binding path is re-derived from that control root; a binding whose
  // paths no longer follow from these roots (tampered, stale or foreign) is
  // refused before any artifact read.
  let harnessRoot: string | null = null;
  try {
    const resolved = resolveHarnessDir(controlRoot);
    harnessRoot = resolved === null ? null : canonicalizeNearestExisting(resolved);
  } catch {
    harnessRoot = null;
  }
  if (
    harnessRoot === null ||
    !isDirectory(harnessRoot) ||
    canonicalizeNearestExisting(binding.harnessRoot) !== harnessRoot
  ) {
    fail("binding-invalid");
    return verdict();
  }
  // §5: the checkpoint below reads the root register, the snapshot, the
  // coordinator ENVELOPE and the compass — every one of them retired as a
  // persistence route while the control harness's execution authority is ACTIVE
  // (primary spec §4.3). The gate reports not-ready rather than reading them:
  // its coordinator session consumer is not migrated (2b), and fabricating a
  // receipt or a binding from retired bytes is what §5 forbids. A store that
  // exists and cannot be read throws that store's own refusal, since this
  // checkpoint then has no verdict to give about either route.
  if ((await resolveExecutionReadRoute({ harnessDir: harnessRoot })) === "execution") {
    // The engine's own authority verdict, captured separately from any identity
    // refusal: no file-route identity check ran at all here.
    fail("execution.consumer-not-ready");
    return verdict();
  }
  let workflowDir: string;
  let iterationDir: string;
  let planArea: string;
  try {
    workflowDir = resolveWorkflowDir(controlRoot, { harnessDir: harnessRoot });
    iterationDir = resolveIterationDir(harnessRoot);
    planArea = resolvePlanDir(harnessRoot);
  } catch {
    fail("binding-invalid");
    return verdict();
  }
  const iterationArea = join(iterationDir, binding.workflowId);
  const expectedSnapshot = canonicalizeNearestExisting(join(workflowDir, binding.workflowId, WORKFLOW_SNAPSHOT_FILE));
  const expectedCompass = canonicalizeNearestExisting(join(iterationDir, binding.workflowId, COMPASS_FILE));
  // Ownership before any artifact read: the bound paths must be exactly the ones
  // that follow from the Git-derived control root and the explicitly named
  // workflow. A binding that names any other location is refused here, before
  // the root register, the snapshot or the compass is even opened.
  if (
    canonicalizeNearestExisting(binding.snapshotPath) !== expectedSnapshot ||
    canonicalizeNearestExisting(binding.compassPath) !== expectedCompass
  ) {
    fail("binding-invalid");
    return verdict();
  }

  // From here every read is bounded to artifacts derived from that binding.
  const statusPath = join(harnessRoot, STATUS_FILE);
  const statusFile = sample(statusPath, "binding-invalid", [harnessRoot]);
  const snapshotFile = sample(binding.snapshotPath, "binding-invalid", [workflowDir]);
  if (statusFile === null || snapshotFile === null) {
    fail("binding-invalid");
  } else {
    if (!validateStatusV2(statusPath).ok) fail("binding-invalid");
    let doc: unknown = null;
    try {
      doc = JSON.parse(statusFile.bytes.toString("utf8"));
    } catch {
      doc = null;
    }
    const entries = isPlainObject(doc) && Array.isArray(doc.workflows) ? doc.workflows : [];
    const own = entries.filter((entry) => isPlainObject(entry) && entry.id === binding.workflowId);
    const listed =
      own.length === 1 && isNonEmptyString(own[0]!.dir)
        ? canonicalizeNearestExisting(join(harnessRoot, own[0]!.dir, WORKFLOW_SNAPSHOT_FILE))
        : null;
    if (listed !== snapshotFile.real) fail("binding-invalid");
  }
  if (codes.size > 0 || snapshotFile === null) return verdict();

  let snapshot: WorkflowSnapshot;
  try {
    // Read through the bound logical path, so the validated document is exactly
    // the pinned artifact.
    snapshot = readWorkflowSnapshot(dirname(snapshotFile.logical)).snapshot;
  } catch {
    fail("binding-invalid");
    return verdict();
  }
  if (snapshot.id !== binding.workflowId || snapshot.type !== "iteration" || snapshot.status !== "running") {
    fail("binding-invalid");
  }

  const coordinator = snapshot.coordination?.coordinator;
  const recordedCoordinatorId =
    isPlainObject(coordinator) && isNonEmptyString(coordinator.session_id) ? coordinator.session_id : null;
  if (recordedCoordinatorId === null) {
    // A workflow that records no coordinator has no owner to authenticate, and
    // the §3.3 recovery replaces a recorded binding — it never creates one — so
    // the explicit bind is the only supported next operation here.
    fail("binding-invalid");
    diagnose({
      code: "binding-invalid",
      detail: "identity-missing",
      workflowId: binding.workflowId,
      source: "snapshot-coordinator",
      current: binding.sessionId,
      next: NEXT_BIND,
    });
  } else if (recordedCoordinatorId !== binding.sessionId) {
    // The workflow records an owner this host session is not. Whether that is
    // repairable is the engine's own Prepare admission, read through the shared
    // §3.3 view rather than guessed here.
    fail("binding-invalid");
    const recovery = await recoveryVerdict(controlRoot, harnessRoot, binding.workflowId);
    diagnose({
      code: "binding-invalid",
      detail: "foreign-owner",
      workflowId: binding.workflowId,
      source: "snapshot-coordinator",
      expected: recordedCoordinatorId,
      current: binding.sessionId,
      next: recovery.next,
    });
    if (recovery.detail !== null) {
      // Why no recovery is currently admitted, in the shared §5 vocabulary.
      diagnose({
        code: "binding-invalid",
        detail: recovery.detail,
        workflowId: binding.workflowId,
        source: "recovery-view",
        expected: recordedCoordinatorId,
        current: binding.sessionId,
        next: NEXT_RECOVERY_VIEW,
      });
    }
  }
  const listedEnvelope = isPlainObject(coordinator) && isNonEmptyString(coordinator.session_file) ? coordinator.session_file : null;
  if (
    listedEnvelope === null ||
    canonicalizeNearestExisting(listedEnvelope) !== canonicalizeNearestExisting(input.coordinatorSessionPath)
  ) {
    // The stored binding and the checkpoint's envelope pointer disagree. The
    // envelope path itself is coordinator-owned transport: it is never rendered
    // into a diagnostic.
    fail("binding-invalid");
    diagnose({
      code: "binding-invalid",
      detail: "identity-mismatch",
      workflowId: binding.workflowId,
      source: "snapshot-coordinator",
      expected: recordedCoordinatorId ?? binding.workflowId,
      current: binding.sessionId,
      next: NEXT_COORDINATOR_EVIDENCE,
    });
  }
  const envelopeFile = sample(input.coordinatorSessionPath, "binding-invalid", [harnessRoot]);
  if (envelopeFile === null) {
    fail("binding-invalid");
  } else {
    // The coordinator envelope is read for this checkpoint only; its path and
    // contents are never forwarded into another input, notice or report.
    try {
      const envelope = readSessionEnvelope(input.coordinatorSessionPath);
      if (
        envelope.role !== "coordinator" ||
        envelope.session_id !== binding.sessionId ||
        envelope.workflow_id !== binding.workflowId ||
        canonicalizeNearestExisting(envelope.harness_root) !== harnessRoot
      ) {
        fail("binding-invalid");
        diagnose({
          code: "binding-invalid",
          detail: "identity-mismatch",
          workflowId: binding.workflowId,
          source: "session-envelope",
          expected: binding.sessionId,
          current: envelope.session_id,
          next: NEXT_COORDINATOR_EVIDENCE,
        });
      }
    } catch {
      fail("binding-invalid");
      diagnose({
        code: "binding-invalid",
        detail: "identity-mismatch",
        workflowId: binding.workflowId,
        source: "session-envelope",
        expected: binding.sessionId,
        next: NEXT_COORDINATOR_EVIDENCE,
      });
    }
  }

  const compassFile = sample(binding.compassPath, "binding-invalid", [iterationDir]);
  if (compassFile === null) {
    fail("binding-invalid");
    return verdict();
  }
  let compass: Record<string, unknown> = {};
  try {
    compass = parseCompassFrontmatter(compassFile.logical);
  } catch {
    fail("binding-invalid");
  }
  if (!validateCompassFrontmatter(compass).ok) fail("binding-invalid");
  if (compass.iteration_id !== binding.workflowId) fail("binding-invalid");
  // `snapshot.compass_ref` is canonically harness-root relative (the engine's
  // amendment reader requires exactly that); an absolute pointer is still accepted
  // here as long as it resolves to the *bound* compass path, so this checkpoint
  // never refuses a self-consistent snapshot whose form the writer chose.
  if (
    !isNonEmptyString(snapshot.compass_ref) ||
    canonicalizeNearestExisting(
      isAbsolute(snapshot.compass_ref) ? snapshot.compass_ref : join(harnessRoot, snapshot.compass_ref),
    ) !== compassFile.real
  ) {
    fail("binding-invalid");
  }

  // Branch anchors: snapshot and compass must describe the same iteration.
  const anchors = snapshot.branch;
  if (
    !isPlainObject(anchors) ||
    !isNonEmptyString(anchors.base) ||
    !isNonEmptyString(anchors.integration) ||
    compass.iteration_base_branch !== anchors.base ||
    compass.spec_integration_branch !== anchors.integration
  ) {
    fail("binding-invalid");
  }
  const snapshotWorktree = isNonEmptyString(snapshot.integration_worktree_path) ? snapshot.integration_worktree_path : null;
  const compassWorktree = isNonEmptyString(compass.integration_worktree_path) ? compass.integration_worktree_path : null;
  if (
    snapshotWorktree === null ||
    compassWorktree === null ||
    canonicalizeNearestExisting(snapshotWorktree) !== canonicalizeNearestExisting(compassWorktree)
  ) {
    fail("binding-invalid");
  }

  // Registered plans: compass registration and snapshot rows agree exactly.
  const registered = Array.isArray(compass.plans) ? compass.plans.filter(isNonEmptyString) : [];
  const rows = Array.isArray(snapshot.plans) ? snapshot.plans : [];
  const rowIds = rows.map(rowId).filter((id): id is string => id !== null);
  if (
    registered.length === 0 ||
    new Set(registered).size !== registered.length ||
    rowIds.length !== rows.length ||
    new Set(rowIds).size !== rowIds.length ||
    registered.length !== rowIds.length ||
    registered.some((id) => !rowIds.includes(id))
  ) {
    fail("binding-invalid");
  }
  if (codes.size > 0) return verdict();

  // --- item 2: Prepare evidence, then the ordered review returns ------------
  if (compass.status !== "locked") {
    // The broad refusal code is frozen, but its §5 detail is not: only a valid
    // `active` Prepare is genuinely "unlocked" and gets the lock-compass next
    // operation. A `completed` (or otherwise non-Prepare) compass is classified
    // as itself through the code alone — never labelled an unlocked Prepare —
    // and an invalid frontmatter already refused as `binding-invalid` above.
    fail("prepare-not-locked");
    if (compass.status === "active") {
      diagnose({
        code: "prepare-not-locked",
        detail: "prepare-unlocked",
        workflowId: binding.workflowId,
        current: "active",
        next: NEXT_LOCK_COMPASS,
      });
    }
  }

  const receiptPlans = Array.isArray(input.plans) ? input.plans : [];
  const receiptPlanIds = receiptPlans.map((plan) => (isPlainObject(plan) && isNonEmptyString(plan.planId) ? plan.planId : null));
  const plansComplete =
    receiptPlanIds.every((id): id is string => id !== null) &&
    new Set(receiptPlanIds).size === receiptPlanIds.length &&
    receiptPlanIds.length === registered.length &&
    registered.every((id) => receiptPlanIds.includes(id));
  if (!plansComplete) fail("prepare-not-locked");

  if (plansComplete) {
    // The canonical plan root the resolver owns — the same one registration and
    // the guarded Prepare correction resolve against, including a `.mstarc`
    // declared or external `{PLAN_DIR}`.
    const planBase = canonicalizeNearestExisting(planArea);
    for (const plan of receiptPlans) {
      const row = rows.find((candidate) => rowId(candidate) === plan.planId);
      const registeredFile = isPlainObject(row) && isNonEmptyString(row.file) ? row.file : null;
      // §4: the ONE registered-plan path contract resolves every row pointer.
      // Readiness never normalizes or repairs a stored row — a stale spelling is
      // a readable refusal carrying its own §5 path detail, and the guarded
      // Prepare correction is the operation that repairs it. The accepted file
      // must be exactly the canonical configured `{PLAN_DIR}/<plan-id>.md` with
      // an unambiguous matching declared `plan_id`.
      let resolvedPlanPath: string | null = null;
      if (registeredFile === null) {
        fail("prepare-not-locked");
        diagnose({
          code: "prepare-not-locked",
          detail: "plan-pointer-invalid",
          workflowId: binding.workflowId,
          planId: plan.planId,
          source: "plan-row",
          base: planBase,
          target: join(planBase, `${plan.planId}.md`),
          next: NEXT_REGISTERED_PLAN,
        });
      } else {
        try {
          resolvedPlanPath = resolveRegisteredPlanFile({
            harnessRoot,
            planId: plan.planId,
            file: registeredFile,
          }).planPath;
        } catch (error) {
          fail("prepare-not-locked");
          const mismatched =
            error instanceof PlanPathError &&
            (error.code === "plan-path.identity-mismatch" || error.code === "plan-path.conflicting-declaration");
          diagnose({
            code: "prepare-not-locked",
            detail: mismatched ? "plan-identity-mismatch" : "plan-pointer-invalid",
            workflowId: binding.workflowId,
            planId: plan.planId,
            source: "plan-row",
            // §5 safe rendering: the stored row pointer is arbitrary text — it
            // may be an envelope, credential or session path — so only its
            // received *form* (§4's accepted axis) is projected, never the value
            // it held. The canonical base/target name the file it should have
            // registered.
            received: isAbsolute(registeredFile) ? "canonical-absolute" : "harness-relative",
            base: planBase,
            target: join(planBase, `${plan.planId}.md`),
            next: NEXT_REGISTERED_PLAN,
          });
        }
      }
      const planFile = sample(plan.planPath, "prepare-not-locked", [planArea]);
      const evidenceFile = sample(plan.prepareEvidencePath, "prepare-not-locked", [iterationArea, planArea]);
      // Each plan occurs exactly once (checked above), with its registered file.
      if (resolvedPlanPath === null || planFile === null || !isUnder(planFile.real, planArea)) {
        fail("prepare-not-locked");
      } else if (canonicalizeNearestExisting(resolvedPlanPath) !== planFile.real) {
        // The row registers one document and the receipt names another: the two
        // disagree about the plan's own file. Only canonical expectations are
        // projected — the receipt's own path is caller-supplied and is never
        // echoed back in a public diagnostic (§5 safe rendering).
        fail("prepare-not-locked");
        diagnose({
          code: "prepare-not-locked",
          detail: "plan-identity-mismatch",
          workflowId: binding.workflowId,
          planId: plan.planId,
          source: "plan-row",
          expected: resolvedPlanPath,
          base: planBase,
          target: join(planBase, `${plan.planId}.md`),
          next: NEXT_REGISTERED_PLAN,
        });
      }
      // Prepare evidence is the plan/package section evidence (never the engine
      // `plan prepare` seal) inside this iteration's area or the plan area.
      if (
        evidenceFile === null ||
        evidenceFile.size === 0 ||
        !(isUnder(evidenceFile.real, iterationArea) || isUnder(evidenceFile.real, planArea))
      ) {
        fail("prepare-not-locked");
      }
    }
  }

  // Review returns: frozen order, unique role/agent/reference tuple, native
  // reference, present non-empty report copy inside this iteration's area.
  const reviews = input.reviews;
  if (!Array.isArray(reviews) || reviews.length !== SPECIALIST_ROLES.length) {
    fail("review-evidence-missing");
  } else {
    const tuples = new Set<string>();
    const reports = new Set<string>();
    reviews.forEach((review, index) => {
      const role = SPECIALIST_ROLES[index]!;
      if (!isPlainObject(review) || review.role !== role) {
        fail("review-evidence-missing");
        return;
      }
      if (
        !isNonEmptyString(review.agentId) ||
        !isNonEmptyString(review.resultRef) ||
        !NATIVE_RESULT_REF_RE.test(review.resultRef)
      ) {
        fail("review-evidence-missing");
        return;
      }
      const tuple = `${role}\u0000${review.agentId}\u0000${review.resultRef}`;
      if (tuples.has(tuple)) fail("review-evidence-missing");
      tuples.add(tuple);
      const report = sample(review.reportPath, "review-evidence-missing", [iterationArea]);
      if (report === null || report.size === 0 || !isUnder(report.real, iterationArea) || reports.has(report.real)) {
        fail("review-evidence-missing");
        return;
      }
      reports.add(report.real);
    });
  }
  if (codes.size > 0) return verdict();

  // --- item 3: integration checkout, branch and main residency --------------
  const integrationBranch = anchors!.integration as string;
  const mainBranch = record(() => readMainWorktree(controlRoot!)?.branch ?? null);
  if (mainBranch === null || mainBranch !== input.mainWorktreeBranch) fail("branch-mismatch");

  let integrationPath: string | null = null;
  if (snapshotWorktree === null) {
    fail("worktree-invalid");
  } else {
    try {
      integrationPath = realpathSync(snapshotWorktree);
    } catch {
      integrationPath = null;
    }
    if (integrationPath === null || !isDirectory(integrationPath)) {
      fail("worktree-invalid");
      integrationPath = null;
    }
  }

  let head: string | null = null;
  if (integrationPath !== null) {
    const controlCommon = gitCommonDir(controlRoot!);
    const integrationCommon = record(() => gitCommonDir(integrationPath!));
    // Distinct, same-Git-common-repository: a different repository, the control
    // checkout itself and a symlink/plain-directory alias of it all refuse.
    if (
      controlCommon === null ||
      integrationCommon === null ||
      integrationCommon !== controlCommon ||
      !isDistinctCheckout(controlRoot!, integrationPath)
    ) {
      fail("worktree-invalid");
    }
    const liveBranch = record(() => gitLine(["symbolic-ref", "--short", "-q", "HEAD"], integrationPath!));
    if (liveBranch === null || liveBranch !== integrationBranch) fail("branch-mismatch");

    const statusProbe = git(["status", "--porcelain"], integrationPath);
    if (!statusProbe.ok || statusProbe.stdout.trim() !== "") fail("worktree-invalid");
    for (const marker of IN_PROGRESS_FILES) {
      const path = gitPath(integrationPath, marker);
      if (path !== null && existsSync(path)) fail("worktree-invalid");
    }
    for (const marker of IN_PROGRESS_DIRS) {
      const path = gitPath(integrationPath, marker);
      if (path !== null && isDirectory(path)) fail("worktree-invalid");
    }

    head = record(() => {
      const value = gitLine(["rev-parse", "HEAD"], integrationPath!);
      return value !== null && SHA_RE.test(value) ? value : null;
    });
    if (head === null) fail("worktree-invalid");
  }

  // --- item 4: the required push (remote tip equals the live HEAD) ----------
  // A missing checkout or unreadable HEAD already refused as `worktree-invalid`.
  // The remote query is kept as a re-probeable fact so the closing re-sample
  // repeats it (item 5) — a remote advanced while the checkpoint runs must not
  // report ready.
  let remoteTip: (() => string | null) | null = null;
  if (integrationPath !== null && head !== null) {
    const upstream = gitLine(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], integrationPath);
    const remote = gitLine(["config", "--get", `branch.${integrationBranch}.remote`], integrationPath);
    const ref = gitLine(["config", "--get", `branch.${integrationBranch}.merge`], integrationPath);
    if (upstream === null || remote === null || ref === null || !ref.startsWith("refs/heads/")) {
      fail("push-unverified");
    } else {
      remoteTip = () => {
        const probe = git(["ls-remote", "--exit-code", remote, ref], integrationPath!);
        if (!probe.ok) return null;
        const line = probe.stdout
          .split("\n")
          .map((entry) => entry.trim())
          .find((entry) => entry !== "");
        return line === undefined ? null : (line.split(/\s+/)[0] ?? null);
      };
      const tip = record(remoteTip);
      if (tip === null || tip !== head) fail("push-unverified");
    }
  }

  // --- item 5: re-sample the sampled identity, the Git facts and the remote --
  // Every pinned artifact must still have the same logical identity (kind and
  // raw link target), the same canonical target inside the same allowed roots
  // and the same content hash; any difference refuses.
  for (const pin of samples.values()) {
    const drift = driftOf(pin);
    if (drift !== null) fail(drift);
  }
  for (const fact of facts) {
    if (fact.probe() !== fact.expected) fail("evidence-changed");
  }
  if (remoteTip !== null) {
    // Same closing step as the artifact re-sample: query the remote again and
    // require the tip to still equal the live HEAD (`head` was itself re-probed
    // by the fact loop above, so a local move already refused as changed).
    const tip = remoteTip();
    const liveHead = gitLine(["rev-parse", "HEAD"], integrationPath!);
    if (tip === null || liveHead === null || tip !== liveHead) fail("push-unverified");
  }

  if (codes.size > 0 || head === null) return verdict();
  const artifactVersions: { path: string; version: string }[] = [];
  for (const pin of samples.values()) {
    if (!artifactVersions.some((row) => row.path === pin.real)) {
      artifactVersions.push({ path: pin.real, version: pin.version });
    }
  }
  return {
    ready: true,
    binding,
    integrationHead: head,
    receipt: { input, binding, artifactVersions },
  };
}
