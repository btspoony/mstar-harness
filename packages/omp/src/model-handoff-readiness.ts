/**
 * E1/E2 — explicit workflow binding and read-only Phase 1 readiness for the
 * coordinator model handoff.
 *
 * E1 (`reserveHandoffBinding`) validates the explicit first-action assertion
 * (trusted PM input) against host/Git facts and reserves **paths**, never
 * lifecycle state: it creates nothing, adopts nothing and mutates no workflow,
 * session or settings document. The workflow id is validated as a single safe
 * path component *before* any shared-state read, and the root register is read
 * for exactly one purpose — refusing an id that is already a named workflow.
 * Ownership is never inferred from rows (`workflows[0]`, latest-mtime or "the
 * unique new row" are not selection rules, and a sibling active workflow is
 * not a refusal reason).
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
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import {
  canonicalizeNearestExisting,
  isDistinctCheckout,
  parseCompassFrontmatter,
  probeCheckoutRoot,
  readMainWorktree,
  readSessionEnvelope,
  readWorkflowSnapshot,
  resolveHarnessDir,
  resolveIterationDir,
  resolvePlanDir,
  resolveWorkflowDir,
  validateCompassFrontmatter,
  validateStatusV2,
  WORKFLOW_SNAPSHOT_FILE,
} from "@mstar-harness/engine";
import type { WorkflowSnapshot } from "@mstar-harness/engine";

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

type HandoffRefusalCode = "not-coordinator" | "already-bound" | "invalid-workflow" | "invalid-root";

export type HandoffBindingResult =
  | { ok: true; binding: HandoffBinding }
  | { ok: false; code: HandoffRefusalCode; message: string };

const HANDOFF_ENTRIES: readonly HandoffEntry[] = ["iteration-start", "iteration-loop", "skill-start"];

function bindingRefusal(code: HandoffRefusalCode, message: string): HandoffBindingResult {
  return { ok: false, code, message };
}

/**
 * Reserve the binding for one explicitly named new iteration. Pure reservation:
 * the returned paths are the *derived* locations a lawful workflow creation is
 * expected to fill, not validated lifecycle ownership (E2 checks that against
 * the coordinator envelope and the live artifacts).
 */
export async function reserveHandoffBinding(
  input: HandoffBindingInput,
  host: Readonly<{ sessionId: string; cwd: string; taskSession: boolean }>,
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

  // The root register is read only to reject an already-named id. An absent
  // register permits the session reservation only; malformed register data
  // refuses, and no row is ever used to infer ownership.
  const statusPath = join(harnessRoot, STATUS_FILE);
  if (existsSync(statusPath)) {
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
    if (entries.some((entry) => isPlainObject(entry) && entry.id === workflowId)) {
      return bindingRefusal(
        "already-bound",
        `workflow ${workflowId} is already registered in the root register — a new start never adopts it`,
      );
    }
  }

  if (existsSync(snapshotPath)) {
    return bindingRefusal("already-bound", `a workflow snapshot already exists at ${snapshotPath}`);
  }
  if (existsSync(compassPath)) {
    return bindingRefusal("already-bound", `an iteration compass already exists at ${compassPath}`);
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

type Phase1RefusalCode =
  | "binding-invalid"
  | "review-evidence-missing"
  | "prepare-not-locked"
  | "worktree-invalid"
  | "branch-mismatch"
  | "push-unverified"
  | "evidence-changed";

/** Reporting order — the frozen code union order. */
const CODE_ORDER: readonly Phase1RefusalCode[] = [
  "binding-invalid",
  "review-evidence-missing",
  "prepare-not-locked",
  "worktree-invalid",
  "branch-mismatch",
  "push-unverified",
  "evidence-changed",
];

export type Phase1Readiness =
  | { ready: true; binding: HandoffBinding; integrationHead: string; receipt: Phase1Receipt }
  | { ready: false; codes: readonly Phase1RefusalCode[] };

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
    return { ready: false, codes: ["binding-invalid"] };
  }
  if (!isNonEmptyString(input?.workflowId) || input.workflowId !== binding.workflowId) fail("binding-invalid");
  if (!isNonEmptyString(binding.sessionId)) fail("binding-invalid");
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
  if (controlRoot === null || codes.size > 0) return { ready: false, codes: orderedCodes(codes) };

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
    return { ready: false, codes: orderedCodes(codes) };
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
    return { ready: false, codes: orderedCodes(codes) };
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
    return { ready: false, codes: ["binding-invalid"] };
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
  if (codes.size > 0 || snapshotFile === null) return { ready: false, codes: orderedCodes(codes) };

  let snapshot: WorkflowSnapshot;
  try {
    // Read through the bound logical path, so the validated document is exactly
    // the pinned artifact.
    snapshot = readWorkflowSnapshot(dirname(snapshotFile.logical)).snapshot;
  } catch {
    return { ready: false, codes: ["binding-invalid"] };
  }
  if (snapshot.id !== binding.workflowId || snapshot.type !== "iteration" || snapshot.status !== "running") {
    fail("binding-invalid");
  }

  const coordinator = snapshot.coordination?.coordinator;
  if (!isPlainObject(coordinator) || !isNonEmptyString(coordinator.session_id) || coordinator.session_id !== binding.sessionId) {
    fail("binding-invalid");
  }
  const listedEnvelope = isPlainObject(coordinator) && isNonEmptyString(coordinator.session_file) ? coordinator.session_file : null;
  if (
    listedEnvelope === null ||
    canonicalizeNearestExisting(listedEnvelope) !== canonicalizeNearestExisting(input.coordinatorSessionPath)
  ) {
    fail("binding-invalid");
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
      }
    } catch {
      fail("binding-invalid");
    }
  }

  const compassFile = sample(binding.compassPath, "binding-invalid", [iterationDir]);
  if (compassFile === null) {
    fail("binding-invalid");
    return { ready: false, codes: orderedCodes(codes) };
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
  if (codes.size > 0) return { ready: false, codes: orderedCodes(codes) };

  // --- item 2: Prepare evidence, then the ordered review returns ------------
  if (compass.status !== "locked") fail("prepare-not-locked");

  const receiptPlans = Array.isArray(input.plans) ? input.plans : [];
  const receiptPlanIds = receiptPlans.map((plan) => (isPlainObject(plan) && isNonEmptyString(plan.planId) ? plan.planId : null));
  const plansComplete =
    receiptPlanIds.every((id): id is string => id !== null) &&
    new Set(receiptPlanIds).size === receiptPlanIds.length &&
    receiptPlanIds.length === registered.length &&
    registered.every((id) => receiptPlanIds.includes(id));
  if (!plansComplete) fail("prepare-not-locked");

  if (plansComplete) {
    for (const plan of receiptPlans) {
      const row = rows.find((candidate) => rowId(candidate) === plan.planId);
      const registeredFile = isPlainObject(row) && isNonEmptyString(row.file) ? row.file : null;
      // Relative snapshot pointer values are resolved against the **harness root**,
      // which is the snapshot's own documented convention — the engine's amendment
      // reader requires `compass_ref` to be relative and resolves it as
      // `join(harnessRoot, ref)` under a harness-root containment check
      // (`packages/engine/src/coordination.ts` `readPrepareCompass`), and its
      // migration writes snapshot pointers harness-relative (`migrate.ts`). Never
      // against `process.cwd()`, which is unrelated to the bound control root.
      // Absolute values are taken as written; containment below still decides.
      const registeredFileAbs =
        registeredFile === null || isAbsolute(registeredFile) ? registeredFile : join(harnessRoot, registeredFile);
      const planFile = sample(plan.planPath, "prepare-not-locked", [planArea]);
      const evidenceFile = sample(plan.prepareEvidencePath, "prepare-not-locked", [iterationArea, planArea]);
      // Each plan occurs exactly once (checked above), with its registered file.
      if (
        registeredFileAbs === null ||
        planFile === null ||
        canonicalizeNearestExisting(registeredFileAbs) !== planFile.real ||
        !isUnder(planFile.real, planArea)
      ) {
        fail("prepare-not-locked");
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
  if (codes.size > 0) return { ready: false, codes: orderedCodes(codes) };

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

  if (codes.size > 0 || head === null) return { ready: false, codes: orderedCodes(codes) };
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
