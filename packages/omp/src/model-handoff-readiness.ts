/**
 * ACTIVE-only coordinator model-handoff binding and read-only Phase 1 readiness.
 * The execution DB supplies lifecycle, coordinator and plan facts; Git and
 * artifact witnesses are rechecked before a readiness receipt is returned.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import {
  PlanPathError,
  canonicalizeNearestExisting,
  executionContextFor,
  isDistinctCheckout,
  parseCompassFrontmatter,
  probeCheckoutRoot,
  readExecutionAuthority,
  readMainWorktree,
  resolveHarnessDir,
  resolveIterationDir,
  resolvePlanDir,
  resolveRegisteredPlanFile,
  resumeExecutionSession,
  resolveWorkflowDir,
  validateCompassFrontmatter,
} from "@mstar-harness/engine";
import type {
  ExecutionBinding,
  ExecutionIdentity,
  ExecutionPlanView,
  ExecutionRead,
  ExecutionState,
} from "@mstar-harness/engine";
// The one reviewed host-side constructor of the §3.1 binding value a durable
// record persists (coordinator-identity.ts). E1 reuses it instead of declaring a
// second constructor for the same value.
import { executionBindingOf } from "./coordinator-identity";

/** Iteration compass file name inside `{ITERATION_DIR}/<iteration-id>/`. */
const COMPASS_FILE = "delivery-compass.md";
/** Valid Phase 1 reviewer order; optional product/architecture reviews precede the required writer. */
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
  compassPath: string;
  executionBinding: ExecutionBinding;
}>;

/**
 * The host facts E1 derives its answer from (`cwd`, native session id, leaf
 * scope) plus — on the ACTIVE route only — the DB session binding this host
 * adopted for the named workflow. Model input never reaches this object.
 */
export type HandoffHostFacts = Readonly<{
  sessionId: string;
  cwd: string;
  taskSession: boolean;
  executionBinding?: ExecutionBinding | null;
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
 * One ACTIVE DB workflow view carries the authoritative lifecycle, plan views
 * and session holding the coordinator seat.
 */
type ActiveWorkflowView = ExecutionState["workflows"][number];

/**
 * Structural guard for the §3.1 binding value a host supplies or a record
 * persists. Its rules are the engine's own reference shape
 * (`execution-session.ts` `assertRefShape`): the workflow's coordinator seat,
 * with no per-plan scope — so a value admitted here is one the engine could
 * accept, never a shape it must refuse later.
 */
function isExecutionBindingValue(value: unknown): value is ExecutionBinding {
  if (!isPlainObject(value) || value.version !== 1 || !isNonEmptyString(value.harnessRoot)) return false;
  const session = value.session;
  if (!isPlainObject(session)) return false;
  if (!isNonEmptyString(session.storeId) || !isNonEmptyString(session.sessionId) || !isNonEmptyString(session.workflowId)) {
    return false;
  }
  if (session.role !== "coordinator") return false;
  return typeof session.epoch === "number" && Number.isSafeInteger(session.epoch) && session.epoch > 0;
}

/**
 * Adopt the session binding for the named workflow under the ACTIVE DB
 * authority. The binding must match this host session, canonical control root,
 * workflow and coordinator role; it is re-resumed against the current store.
 */
async function adoptActiveHandoffBinding(
  input: HandoffBindingInput,
  host: HandoffHostFacts,
  roots: Readonly<{ controlRoot: string; harnessRoot: string }>,
  adopted: ExecutionBinding,
): Promise<HandoffBindingResult> {
  const { controlRoot, harnessRoot } = roots;
  const workflowId = input.workflowId;
  if (!isExecutionBindingValue(adopted)) {
    return bindingRefusal(
      "not-coordinator",
      "the adopted execution binding is not a §3.1 value the engine could accept (its harness root, session reference, " +
        "role/plan pairing or epoch is unusable), so it never describes this coordinator",
    );
  }
  if (canonicalizeNearestExisting(adopted.harnessRoot) !== harnessRoot) {
    return bindingRefusal(
      "invalid-root",
      `the adopted execution binding must carry the canonical control harness root ${harnessRoot}; a foreign root is ` +
        "refused before any store is read",
    );
  }
  const session = adopted.session;
  if (
    session.workflowId !== workflowId ||
    session.role !== "coordinator" ||
    session.sessionId !== host.sessionId
  ) {
    return bindingRefusal(
      "not-coordinator",
      `the adopted execution binding describes session ${session.sessionId}/${session.role} of workflow ` +
        `${session.workflowId}, not this coordinator session ${host.sessionId} for workflow ${workflowId}`,
    );
  }

  const identity: ExecutionIdentity = {
    source: "host",
    sessionId: host.sessionId,
    workflowId,
    role: "coordinator",
  };
  const context = { harnessDir: harnessRoot };
  try {
    await resumeExecutionSession(executionContextFor(context, identity), session);
  } catch (error) {
    return bindingRefusal(
      "not-coordinator",
      `the adopted execution binding no longer authorizes this call: ${String(error)}`,
    );
  }

  let workflow: ActiveWorkflowView | undefined;
  try {
    const read = await readExecutionAuthority(context, { workflowId });
    workflow = "workflows" in read.data ? read.data.workflows[0] : undefined;
  } catch (error) {
    return bindingRefusal(
      "invalid-root",
      `the execution authority of ${harnessRoot} cannot serve workflow ${workflowId}: ${String(error)}`,
    );
  }
  if (workflow === undefined) {
    return bindingRefusal(
      "invalid-root",
      `the execution authority of ${harnessRoot} holds no ACTIVE lifecycle ${JSON.stringify(workflowId)}; this arm ` +
        "addresses the DB's own workflow view and never reserves an unregistered id",
    );
  }
  const coordinator = workflow.coordinator;
  // The seat must be exactly the stored row this binding addresses — the same
  // store, epoch, workflow, role, session and plan — not merely the same
  // session id.
  if (
    coordinator === null ||
    coordinator.storeId !== session.storeId ||
    coordinator.epoch !== session.epoch ||
    coordinator.workflowId !== session.workflowId ||
    coordinator.role !== "coordinator" ||
    coordinator.sessionId !== session.sessionId
  ) {
    return bindingRefusal(
      "not-coordinator",
      `workflow ${workflowId} is bound to coordinator session ${coordinator?.sessionId ?? "(none)"}, not to this ` +
        `session ${host.sessionId}`,
    );
  }
  if (workflow.state.status !== "running" || workflow.state.type !== "iteration") {
    return bindingRefusal(
      "invalid-root",
      `workflow ${workflowId} is ${workflow.state.status} (type ${workflow.state.type}), not a running iteration`,
    );
  }

  let compassPath: string;
  try {
    compassPath = canonicalizeNearestExisting(join(resolveIterationDir(harnessRoot), workflowId, COMPASS_FILE));
  } catch (error) {
    return bindingRefusal("invalid-root", `cannot resolve the iteration path: ${String(error)}`);
  }
  return {
    ok: true,
    binding: {
      sessionId: host.sessionId,
      workflowId,
      controlRoot,
      harnessRoot,
      compassPath,
      executionBinding: executionBindingOf(harnessRoot, session),
    },
  };
}
export async function reserveHandoffBinding(
  input: HandoffBindingInput,
  host: HandoffHostFacts,
): Promise<HandoffBindingResult> {
  if (input.authority !== "coordinator" || input.intent !== "new-iteration" || !HANDOFF_ENTRIES.includes(input.entry)) {
    return bindingRefusal("not-coordinator", "handoff start requires a coordinator new-iteration entry");
  }
  if (host.taskSession === true) {
    return bindingRefusal("not-coordinator", "a native task/focused-agent session never owns a coordinator binding");
  }
  if (!isNonEmptyString(host.sessionId)) return bindingRefusal("not-coordinator", "the host session id is missing");

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
  const controlRoot = main.root;
  if (probeCheckoutRoot(cwdReal) !== controlRoot) {
    return bindingRefusal("invalid-root", `the coordinator must run in the canonical main checkout ${controlRoot}; ${host.cwd} is a different checkout`);
  }
  let resolvedHarness: string | null;
  try {
    resolvedHarness = resolveHarnessDir(controlRoot);
  } catch {
    resolvedHarness = null;
  }
  if (resolvedHarness === null) return bindingRefusal("invalid-root", `no harness dir resolves from the main checkout ${controlRoot}`);
  const harnessRoot = canonicalizeNearestExisting(resolvedHarness);
  if (!isDirectory(harnessRoot)) return bindingRefusal("invalid-root", `the resolved harness dir does not exist: ${harnessRoot}`);
  if (host.executionBinding == null) {
    return bindingRefusal("execution.consumer-not-ready", "this operation requires the ACTIVE coordinator DB binding");
  }
  return adoptActiveHandoffBinding(input, host, { controlRoot, harnessRoot }, host.executionBinding);
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
  mainWorktreeBranch: string;
  reviews: readonly (
    | SpecialistReceipt<"product-manager">
    | SpecialistReceipt<"architect">
    | SpecialistReceipt<"writing-specialist">
  )[];
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

/** Safe identity subreasons refining the broad `binding-invalid` gate. */
export type Phase1IdentityDetail = "identity-missing" | "identity-mismatch" | "foreign-owner";

/** Safe plan-path and compass subreasons. */
export type Phase1PathDetail = "plan-pointer-invalid" | "plan-identity-mismatch" | "prepare-unlocked";

/** Safe pointer-form classification; the stored path value is never projected. */
export type Phase1PointerForm = "canonical-absolute" | "harness-relative";

/** Safe source label for an observed identity or plan pointer. */
export type Phase1DiagnosticSource = "host-session" | "plan-row" | "execution-authority";

/**
 * One typed refinement of a broad refusal code. It carries safe source labels,
 * public ids, canonical plan paths and the next supported operation.
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
const NEXT_ACTIVE_RECOVER =
  'call `mstar_coordinator` with {operation:"recover", workflowId, …} under the current store authority from this session';
const NEXT_COORDINATOR_EVIDENCE =
  "re-run this checkpoint with the ordered specialist returns and bound plan evidence";
const NEXT_REGISTERED_PLAN =
"register the plan row through `mstar iteration register` under ACTIVE execution authority";
const NEXT_LOCK_COMPASS = "lock the reviewed delivery compass, then re-run this checkpoint";


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

/** Id of a registered ACTIVE plan row. */
function rowId(row: unknown): string | null {
  if (!isPlainObject(row)) return null;
  return isNonEmptyString(row.id) ? row.id : null;
}

function orderedCodes(codes: Set<Phase1RefusalCode>): readonly Phase1RefusalCode[] {
  return CODE_ORDER.filter((code) => codes.has(code));
}

/**
 * The ACTIVE-only Phase 1 checkpoint. It returns a fresh receipt and live
 * integration HEAD only when the bound DB facts and current artifact witnesses
 * satisfy the complete readiness conjunction.
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

  // --- item 1: ACTIVE binding identity and root -----------------------------
  if (!isPlainObject(binding) || !isSafePathComponent(binding.workflowId)) {
    fail("binding-invalid");
    return verdict();
  }
  if (!isNonEmptyString(binding.sessionId)) {
    fail("binding-invalid");
    return verdict();
  }
  const adopted: unknown = binding.executionBinding;
  if (
    !isExecutionBindingValue(adopted) ||
    adopted.session.sessionId !== binding.sessionId ||
    adopted.session.workflowId !== binding.workflowId ||
    adopted.session.role !== "coordinator"
  ) {
    fail("binding-invalid");
    diagnose({
      code: "binding-invalid",
      detail: "identity-mismatch",
      workflowId: binding.workflowId,
      source: "execution-authority",
      expected: binding.sessionId,
      next: NEXT_BIND,
    });
    return verdict();
  }
  if (!isNonEmptyString(binding.harnessRoot) || !isNonEmptyString(binding.compassPath)) fail("binding-invalid");
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
  const expectedCompass = canonicalizeNearestExisting(join(iterationDir, binding.workflowId, COMPASS_FILE));
  let anchors: Readonly<{ base: string; integration: string }> | null = null;
  let integrationWorktree: string | null = null;
  let rows: readonly unknown[] = [];
  let compassRef: string | null = null;
  // The bound paths were re-derived from the Git-derived control root above.
  const session = adopted.session;
    const identity: ExecutionIdentity = {
      source: "host",
      sessionId: binding.sessionId,
      workflowId: binding.workflowId,
      role: "coordinator",
    };
    const context = { harnessDir: harnessRoot };
    try {
      await resumeExecutionSession(executionContextFor(context, identity), session);
    } catch {
      // The host binding is stale or no longer belongs to this session.
      fail("binding-invalid");
      diagnose({
        code: "binding-invalid",
        detail: "identity-mismatch",
        workflowId: binding.workflowId,
        source: "execution-authority",
        expected: binding.sessionId,
        current: session.sessionId,
        next: NEXT_BIND,
      });
      return verdict();
    }

    let authorityRead: ExecutionRead<ExecutionState | ExecutionPlanView> | null = null;
    try {
      authorityRead = await readExecutionAuthority(context, { workflowId: binding.workflowId });
    } catch {
      // The ACTIVE authority cannot serve this checkpoint; its evidence is
      // unavailable, never inferred from retired document bytes.
      fail("execution.consumer-not-ready");
      return verdict();
    }
    if (authorityRead === null) {
      fail("binding-invalid");
      return verdict();
    }
    const authorityData = authorityRead.data;
    if (!("workflows" in authorityData)) {
      fail("binding-invalid");
      return verdict();
    }
    const stateRead: ExecutionState = authorityData;
    const workflow = stateRead.workflows[0];
    if (workflow === undefined) {
      fail("binding-invalid");
      return verdict();
    }
    if (
      workflow.state.id !== binding.workflowId ||
      workflow.state.type !== "iteration" ||
      workflow.state.status !== "running"
    ) {
      fail("binding-invalid");
    }
    // Root view: the register row this workflow owns must exist exactly once and
    // resolve to the workflow directory derived from the control root.
    const rootRows = stateRead.root.workflows;
    const own = rootRows.filter((row) => row.id === binding.workflowId);
    const listedDir =
      own.length === 1 && isNonEmptyString(own[0]!.dir)
        ? canonicalizeNearestExisting(join(harnessRoot, own[0]!.dir))
        : null;
    if (listedDir !== canonicalizeNearestExisting(join(workflowDir, binding.workflowId))) fail("binding-invalid");

    // The coordinator seat is the DB's own record of the owner. It must be this
    // session, and the stored row must be exactly the binding this checkpoint
    // resumed (store, epoch, role and plan included).
    const seat = workflow.coordinator;
    if (seat === null || seat.sessionId !== binding.sessionId) {
      fail("binding-invalid");
      diagnose({
        code: "binding-invalid",
        detail: seat === null ? "identity-missing" : "foreign-owner",
        workflowId: binding.workflowId,
        source: "execution-authority",
        expected: seat?.sessionId,
        current: binding.sessionId,
        next: seat === null ? NEXT_BIND : NEXT_ACTIVE_RECOVER,
      });
    } else if (
      seat.storeId !== session.storeId ||
      seat.epoch !== session.epoch ||
      seat.workflowId !== session.workflowId ||
      seat.role !== "coordinator" ||
      seat.sessionId !== session.sessionId
    ) {
      fail("binding-invalid");
      diagnose({
        code: "binding-invalid",
        detail: "identity-mismatch",
        workflowId: binding.workflowId,
        source: "execution-authority",
        expected: seat.sessionId,
        current: binding.sessionId,
        next: NEXT_BIND,
      });
    }

    const stateAnchors = workflow.state.branch;
    anchors =
      isPlainObject(stateAnchors) && isNonEmptyString(stateAnchors.base) && isNonEmptyString(stateAnchors.integration)
        ? { base: stateAnchors.base, integration: stateAnchors.integration }
        : null;
    integrationWorktree = isNonEmptyString(workflow.state.integration_worktree_path)
      ? workflow.state.integration_worktree_path
      : null;
    rows = workflow.plans.map((view) => view.plan);
    compassRef = isNonEmptyString(workflow.state.compass_ref) ? workflow.state.compass_ref : null;

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
  // The lifecycle's `compass_ref` is canonically harness-root relative (the
  // engine's amendment reader requires exactly that); an absolute pointer is
  // still accepted here as long as it resolves to the *bound* compass path, so
  // this checkpoint never refuses a self-consistent document whose form the
  // writer chose.
  if (
    compassRef === null ||
    canonicalizeNearestExisting(isAbsolute(compassRef) ? compassRef : join(harnessRoot, compassRef)) !== compassFile.real
  ) {
    fail("binding-invalid");
  }

  // Branch anchors: the lifecycle and the compass must describe the same
  // iteration.
  if (
    anchors === null ||
    compass.iteration_base_branch !== anchors.base ||
    compass.spec_integration_branch !== anchors.integration
  ) {
    fail("binding-invalid");
  }
  const compassWorktree = isNonEmptyString(compass.integration_worktree_path) ? compass.integration_worktree_path : null;
  if (
    integrationWorktree === null ||
    compassWorktree === null ||
    canonicalizeNearestExisting(integrationWorktree) !== canonicalizeNearestExisting(compassWorktree)
  ) {
    fail("binding-invalid");
  }

  // Compass registration and ACTIVE lifecycle plan rows must agree exactly.
  const registered = Array.isArray(compass.plans) ? compass.plans.filter(isNonEmptyString) : [];
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
    // Resolve the registered plan path through the configured plan root.
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
            // The stored pointer is arbitrary text and may include private path
            // data, so only its received form is projected.
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

  // The selected reviewers may omit either specialist, but the writing
  // specialist is required and final. Enforce membership, order and uniqueness
  // before inspecting any receipt fields or report artifacts.
  const reviews = input.reviews;
  if (
    !Array.isArray(reviews) ||
    reviews.length === 0 ||
    reviews.length > SPECIALIST_ROLES.length ||
    reviews.at(-1)?.role !== "writing-specialist"
  ) {
    fail("review-evidence-missing");
  } else {
    const tuples = new Set<string>();
    const reports = new Set<string>();
    let previousIndex = -1;
    reviews.forEach((review) => {
      if (!isPlainObject(review)) {
        fail("review-evidence-missing");
        return;
      }
      const index = SPECIALIST_ROLES.indexOf(review.role as (typeof SPECIALIST_ROLES)[number]);
      if (index < 0 || index <= previousIndex) {
        fail("review-evidence-missing");
        return;
      }
      previousIndex = index;
      if (
        !isNonEmptyString(review.agentId) ||
        !isNonEmptyString(review.resultRef) ||
        !NATIVE_RESULT_REF_RE.test(review.resultRef)
      ) {
        fail("review-evidence-missing");
        return;
      }
      const tuple = `${review.role}\u0000${review.agentId}\u0000${review.resultRef}`;
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
  if (integrationWorktree === null) {
    fail("worktree-invalid");
  } else {
    try {
      integrationPath = realpathSync(integrationWorktree);
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
