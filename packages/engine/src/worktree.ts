/**
 * Engine worktree module — main-worktree discovery + residency, L1/L2
 * pre-dispatch checklists, main/integration/feature checkout identity,
 * git branch alignment probe, QC/QA field alignment.
 *
 * Spec sources (semantic SSOT — the skills stay authoritative; this module
 * implements their deterministic rules without forking semantics):
 * - L1/L2 layer split + stacking — main control root + dedicated
 *   integration checkout + per-plan feature worktrees recorded in row
 *   metadata; within-plan parallel writable tracks need their own distinct
 *   worktrees and L1 does not replace L2:
 *   `mstar-branch-worktree` SKILL.md § "Worktree isolation layers (L1 vs L2)"
 *   § "Stacking rules".
 * - Main control root — the process-SSOT holder is the Git-derived MAIN
 *   worktree (first `git worktree list --porcelain -z` record); the
 *   dedicated integration checkout (`integration_worktree_path` on
 *   `branch.integration`) is the sole merge cwd and MUST be distinct from
 *   main; the row metadata worktree MUST be a distinct checkout from main
 *   and never holds product edits in main:
 *   SKILL.md § "Control worktree vs feature worktree (iteration / L1)" +
 *   iteration spec worktree-write-model § "Three domains" / § "Field
 *   semantics" / § "Primary residency".
 * - Primary residency — the expected main branch is the value RECORDED at
 *   lifecycle start (or the explicit `branch.base` fallback), never the
 *   branch observed at check time as its own expected value; main on any
 *   active lifecycle-owned branch is refused; detached/unresolved main
 *   fails closed.
 * - L2 pre-dispatch checklist — per-track worktree dirs exist, `worktreePath`
 *   values are absolute and distinct (one Worktree per track; N parallel
 *   invokes ≠ isolation) and `git -C <path> branch --show-current` matches
 *   the Assignment Working branch before the first concurrent writable
 *   dispatch; emit zero until ready:
 *   `mstar-branch-worktree` `references/parallel-writable-pre-dispatch.md`
 *   § "Pre-dispatch checklist (HARD)".
 * - QC/QA alignment — `plan_id` + `Review range`/`Diff basis` byte-identical
 *   (逐字相同) across the QC tri + QA assignments; single review snapshot
 *   precondition (all reviewable commits on ONE Working branch HEAD before
 *   QC tri + QA):
 *   SKILL.md § "QC / QA 检出对齐与多 worktree 门禁衔接" § 对齐字段契约 +
 *   § "单一待审 Git 快照（派 QC 前置条件）".
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { GateResult, ValidationResult, Severity } from "./core.js";
import type { ActiveLifecycleBranch } from "./lifecycle-branches.js";
import type { WorkflowLifecycleType } from "./workflow.js";
import { validateIntegrationMergeLease } from "./lease.js";

/**
 * Git probe timeout — bounded so a hung git (dead NFS mount, pathological
 * repo, stray hook) cannot block `mstar worktree check` or engine callers
 * indefinitely . Default 10s; override via the
 * `MSTAR_GIT_PROBE_TIMEOUT_MS` env var or a per-call `timeoutMs`.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export function gitProbeTimeoutMs(): number {
  const raw = process.env.MSTAR_GIT_PROBE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PROBE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROBE_TIMEOUT_MS;
}

/** One L2 parallel implement track (mstar-branch-worktree L2 table). */
export type WorktreeTrack = {
  /** Absolute worktree checkout path for the track. */
  worktreePath: string;
  /** PM-approved Working branch checked out in that worktree. */
  workingBranch: string;
};

/** The Git-derived main worktree of the repository containing a cwd. */
export type MainWorktreeInfo = {
  /** Absolute (realpath'd) main-worktree checkout root. */
  root: string;
  /** Branch checked out at the main worktree (`""` when detached). */
  branch: string;
};

/**
 * Parse the first record of `git worktree list --porcelain -z` (NUL form —
 * preserves spaces/newlines in paths). The first record is always the MAIN
 * worktree; `refs/heads/` is stripped; `detached` yields `branch: ""`.
 * Bare repositories, malformed output (no worktree/branch attribute), or an
 * inaccessible root yield `null` — never a guess.
 */
function parseMainWorktree(out: string): MainWorktreeInfo | null {
  const tokens = out.split("\0");
  const first = tokens.findIndex((t) => t.startsWith("worktree "));
  if (first === -1) return null;
  const rawPath = tokens[first]!.slice("worktree ".length);
  if (rawPath.trim() === "") return null;
  let branch: string | null = null;
  let detached = false;
  for (let i = first + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith("worktree ")) break; // second record begins — the main record ended
    if (token === "bare") return null;
    if (token === "detached") detached = true;
    else if (token.startsWith("branch ")) {
      const ref = token.slice("branch ".length).trim();
      if (ref === "") return null;
      branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
  }
  if (detached) branch = "";
  if (branch === null) return null; // malformed main record — no branch attribute and not detached
  try {
    return { root: realpathSync(rawPath), branch };
  } catch {
    return null; // inaccessible root
  }
}

/**
 * Discover the main worktree of the repository containing `cwd` (default
 * `process.cwd()`): the FIRST record of `git worktree list --porcelain -z`,
 * never the first attached branch or a name-matched path. Bounded by the
 * shared probe timeout; unavailable Git, a hung git, a bare repository,
 * malformed output, or an inaccessible root yield `null` — callers fail
 * closed (`worktree.main.unresolved`), never fall through.
 */
export function readMainWorktree(cwd?: string): MainWorktreeInfo | null {
  const start = cwd ?? process.cwd();
  try {
    const stdout = execFileSync("git", ["-C", start, "worktree", "list", "--porcelain", "-z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: gitProbeTimeoutMs(),
    });
    return parseMainWorktree(stdout);
  } catch {
    return null;
  }
}

/**
 * Primary-residency equality primitive: the main worktree must be on the
 * branch RECORDED at lifecycle start (`expectedBranch` — callers transport
 * the recorded value or the explicit `branch.base` fallback, never the
 * branch observed at check time as its own expected value). Detached main
 * (`branch: ""`) and any mismatch are `worktree.main.residency-switched`
 * (high). Never switch main to satisfy this check.
 */
export function assertMainWorktreeResidency(main: MainWorktreeInfo, expectedBranch: string): GateResult {
  const violations: ValidationResult[] = [];
  if (main.branch === "") {
    violations.push(
      violation(
        "high",
        "worktree.main.residency-switched",
        `main worktree "${main.root}" is detached (no branch checked out) \u2014 residency cannot match the recorded expectation ${JSON.stringify(expectedBranch)}`,
        `Inspect \`git -C ${shellQuote(main.root)} status --short\`; after resolving local changes, run \`git -C ${shellQuote(main.root)} checkout ${shellQuote(expectedBranch)}\` to restore the recorded main branch.`,
      ),
    );
  } else if (main.branch !== expectedBranch) {
    violations.push(
      violation(
        "high",
        "worktree.main.residency-switched",
        `main worktree "${main.root}" is on branch "${main.branch}", expected the recorded branch "${expectedBranch}" \u2014 residency is checked against the value recorded at lifecycle start, never re-pointed at the observed branch`,
        `Inspect \`git -C ${shellQuote(main.root)} status --short\`; after resolving local changes, run \`git -C ${shellQuote(main.root)} checkout ${shellQuote(expectedBranch)}\` to restore the recorded main branch.`,
      ),
    );
  }
  return gate(violations);
}

/**
 * L1 pre-dispatch checklist input — the three-domain topology: the
 * Git-derived main worktree (process-SSOT holder), the governing snapshot's
 * dedicated integration checkout, and the plan's feature worktree
 * (`plans[].metadata.worktree_path` / `metadata.working_branch`). Callers carry the actual snapshot type and
 * resolve the recorded residency expectation + active lifecycle branches
 * from the governing snapshots.
 */
export type L1PreDispatchInput = {
  /** Governing snapshot lifecycle type — `plan` standalone or `iteration`. */
  workflowType: WorkflowLifecycleType;
  /**
   * `integration_worktree_path` — the dedicated integration checkout, on
   * `branch.integration`. A standalone plan without integration passes `""`
   * (both fields empty); if either field is supplied, both and the full
   * checks are required.
   */
  integrationWorktreePath: string;
  /** `branch.integration` — the branch that must be checked out at the integration worktree (`""` for a standalone plan without integration). */
  integrationBranch: string;
  /** Git-derived main worktree (`readMainWorktree`); `null` = unresolved — a failure, never a skipped row. */
  mainWorktree: MainWorktreeInfo | null;
  /** Recorded main-worktree branch (plan header) or the explicit `branch.base` fallback — never the branch observed at check time. */
  expectedMainBranch: string;
  /** Active lifecycle owner claims; the expected main branch is sanctioned residency. */
  lifecycleBranches: readonly ActiveLifecycleBranch[];
  /** `plans[].metadata.worktree_path` — the plan's feature worktree. */
  rowWorktreePath: string;
  /** `plans[].metadata.working_branch` — the plan's Working branch. */
  rowWorkingBranch: string;
  /** Workflow id for a direct coordinator `plan prepare` recovery instruction. */
  workflowId?: string;
  /** Plan id (`status.json.plans[].id` / `{SDD_DIR}` segment) — message context. */
  planId: string;
};

/** L2 pre-dispatch checklist input — the plan's parallel writable tracks. */
export type L2PreDispatchInput = {
  tracks: readonly WorktreeTrack[];
};

/** Git branch probe options — keep checks pure by precomputing probe inputs. */
export type BranchProbeOptions = {
  /** git executable to invoke (default `git`). */
  gitPath?: string;
  /**
   * Precomputed branch lookup keyed by absolute worktree path; return
   * `undefined` to fall back to a real `git -C <path> branch --show-current`
   * probe. Lets callers (tests, host hooks) inject probe inputs without a
   * subprocess.
   */
  branchOf?: (worktreePath: string) => string | undefined;
  /** Precomputed output of `git status --porcelain`; undefined uses git. */
  statusOf?: (worktreePath: string) => string | undefined;
  /**
   * Git probe timeout in ms (default 10s; `MSTAR_GIT_PROBE_TIMEOUT_MS` env
   * overrides; per-call value wins). On timeout the probe fails closed into
   * `branch-probe-failed` — never hangs, never guesses a branch.
   */
  timeoutMs?: number;
};

export type WorkflowEntryPreDispatchInput = {
  workflowId: string;
  branch: { base?: string; target?: string; integration?: string };
  integrationWorktreePath?: string;
  mainWorktree: MainWorktreeInfo | null;
  lifecycleBranches: readonly ActiveLifecycleBranch[];
  integrationLease?: unknown;
};

export type WorkflowEntryPreDispatchResult = GateResult & {
  lease: { claimed: boolean; lease?: unknown };
  scope: "engine-enforced workflow-entry facts only";
};

function probeStatus(worktreePath: string, opts: BranchProbeOptions): { status: string } | { error: string } {
  const precomputed = opts.statusOf?.(worktreePath);
  if (precomputed !== undefined) return { status: precomputed };
  const timeout = opts.timeoutMs ?? gitProbeTimeoutMs();
  try {
    return { status: execFileSync(opts.gitPath ?? "git", ["-C", worktreePath, "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout }) };
  } catch (error) {
    return { error: (error as { message?: string }).message ?? "git status probe failed" };
  }
}

/** Engine-enforced workflow-entry subset; this does not clear the full pre-dispatch checklist. */
export function workflowEntryPreDispatchCheck(input: WorkflowEntryPreDispatchInput, opts: BranchProbeOptions = {}): WorkflowEntryPreDispatchResult {
  const violations: ValidationResult[] = [];
  const { base = "", target = "", integration = "" } = input.branch;
  for (const [key, value] of [["base", base], ["target", target], ["integration", integration]] as const) {
    if (value.trim() === "") violations.push(violation("high", `worktree.entry.branch-${key}-missing`, `workflow "${input.workflowId}" has no registered branch.${key}`, `Workflow "${input.workflowId}" has incomplete branch anchors and cannot be repaired in place while active. Close it through the supported lifecycle operation: mstar workflow lifecycle --workflow ${input.workflowId} --status failed --reason "<blocker>". Then register a replacement workflow with an explicitly new workflow id and complete branch.base, branch.target, and branch.integration anchors (standalone: mstar workflow register with its branch options; iteration: mstar iteration register with its branch options), and rerun mstar worktree check --workflow <new-id> --entry.`));
  }
  if (input.mainWorktree === null) {
    violations.push(violation("high", "worktree.main.unresolved", `main worktree identity cannot be proved for workflow "${input.workflowId}"`, "Run git worktree list --porcelain from an accessible repository checkout, then rerun mstar worktree check --workflow <id> --entry."));
  } else {
    const expected = base.trim();
    if (expected === "") violations.push(violation("high", "worktree.main.expected-branch-missing", `workflow "${input.workflowId}" has no recorded main branch expectation`, `Workflow "${input.workflowId}" has incomplete branch anchors and cannot be repaired in place while active. Close it through the supported lifecycle operation: mstar workflow lifecycle --workflow ${input.workflowId} --status failed --reason "<blocker>". Then register a replacement workflow with an explicitly new workflow id and complete branch.base, branch.target, and branch.integration anchors (standalone: mstar workflow register with its branch options; iteration: mstar iteration register with its branch options), and rerun mstar worktree check --workflow <new-id> --entry.`));
    else violations.push(...assertMainWorktreeResidency(input.mainWorktree, expected).violations);
    const owner = input.lifecycleBranches.find((entry) => entry.branch === input.mainWorktree!.branch && entry.branch !== expected);
    if (owner) {
      const recovery = owner.workflowId === null
        ? `Run mstar status validate to identify the active lifecycle owner of branch "${owner.branch}", then coordinate its supported close process before switching branches.`
        : `Coordinate with workflow ${owner.workflowId}'s coordinator; if its lifecycle is ready to close, run mstar status workflow-close --workflow ${owner.workflowId} --reason <reason>, verify ownership is released with mstar status validate, then restore the recorded branch using git -C ${shellQuote(input.mainWorktree.root)} checkout ${shellQuote(expected)}.`;
      violations.push(violation("high", "worktree.main.residency-switched", `main worktree branch "${owner.branch}" is owned by workflow ${owner.workflowId ?? "unknown"}`, recovery));
    }
  }
  const integrationPath = input.integrationWorktreePath?.trim() ?? "";
  if (integrationPath === "") {
    violations.push(violation("high", "worktree.entry.integration-path-missing", `workflow "${input.workflowId}" has no recorded integration_worktree_path`, `Create a dedicated checkout with \`git worktree add <absolute-path> ${shellQuote(integration)}\`, then register it through \`mstar workflow integration-worktree --workflow ${shellQuote(input.workflowId)} --path <absolute-path>\`.`));
  } else if (!existsSync(integrationPath)) {
    violations.push(violation("high", "worktree.entry.integration-missing", `integration worktree "${integrationPath}" does not exist`, `Create the recorded checkout with \`git worktree add ${shellQuote(integrationPath)} ${shellQuote(integration)}\`, then register or verify it with \`mstar workflow integration-worktree --workflow ${shellQuote(input.workflowId)} --path ${shellQuote(integrationPath)}\`.`));
  } else {
    const probe = probeBranch(integrationPath, opts);
    if ("error" in probe) violations.push(violation("high", "worktree.entry.integration-branch-probe-failed", `cannot probe integration branch: ${probe.error}`, `Inspect \`git -C ${shellQuote(integrationPath)} rev-parse --show-toplevel\` and \`git -C ${shellQuote(integrationPath)} branch --show-current\`; restore the accessible recorded checkout before rerunning mstar worktree check --workflow ${shellQuote(input.workflowId)} --entry.`));
    else if (probe.branch !== integration) violations.push(violation("high", "worktree.entry.integration-branch-mismatch", `integration worktree is on "${probe.branch}", expected branch.integration "${integration}"`, `Inspect \`git -C ${shellQuote(integrationPath)} status --short\`; after resolving local changes, run \`git -C ${shellQuote(integrationPath)} checkout ${shellQuote(integration)}\` to restore recorded branch.integration.`));
    const status = probeStatus(integrationPath, opts);
    if ("error" in status) violations.push(violation("high", "worktree.entry.integration-status-probe-failed", `cannot inspect integration worktree status: ${status.error}`, `Inspect \`git -C ${shellQuote(integrationPath)} rev-parse --show-toplevel\`, then run \`git -C ${shellQuote(integrationPath)} status --short\` once the checkout is accessible.`));
    else if (status.status.trim() !== "") violations.push(violation("high", "worktree.entry.integration-dirty", "integration worktree has uncommitted changes", `Inspect \`git -C ${shellQuote(integrationPath)} status --short\`; commit intended changes or explicitly restore only changes you own, then rerun mstar worktree check --workflow ${shellQuote(input.workflowId)} --entry. Do not use git clean or reset as automatic cleanup.`));
  }
  const lease = input.integrationLease == null ? { claimed: false } : { claimed: true, lease: input.integrationLease };
  if (lease.claimed) {
    const result = validateIntegrationMergeLease(lease.lease);
    violations.push(...result.violations);
  }
  return { ok: violations.length === 0, violations, lease, scope: "engine-enforced workflow-entry facts only" };
}

/**
 * QC/QA alignment fields — `plan_id` + `Review range`/`Diff basis` must be
 * byte-identical across the QC tri + QA assignments (逐字相同).
 */
export type QcAlignmentAssignment = {
  planId: string;
  reviewRange: string;
  diffBasis: string;
};

/** `singleReviewSnapshot` input — alignment fields plus a precomputed review HEAD. */
export type QcSnapshotAssignment = QcAlignmentAssignment & {
  /** Precomputed review HEAD (full SHA preferred) for that assignment. */
  head?: string;
};

type BranchProbe = { branch: string } | { error: string };

function violation(severity: Severity, code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
}

function gate(violations: ValidationResult[]): GateResult {
  return { ok: violations.length === 0, violations };
}

/**
 * Probe the checked-out branch of a worktree via
 * `git -C <path> branch --show-current` (parallel-writable-pre-dispatch
 * checklist step 4). `opts.branchOf` precomputes the answer and skips the
 * subprocess entirely (purity); the probe fails closed — a non-repo path or
 * a detached HEAD (empty stdout) is an error, never a branch match.
 */
function probeBranch(worktreePath: string, opts: BranchProbeOptions): BranchProbe {
  const precomputed = opts.branchOf?.(worktreePath);
  if (precomputed !== undefined) return { branch: precomputed };
  const timeout = opts.timeoutMs ?? gitProbeTimeoutMs();
  try {
    const stdout = execFileSync(opts.gitPath ?? "git", ["-C", worktreePath, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });
    const branch = stdout.trim();
    if (branch === "") return { error: `no branch checked out (detached HEAD?) at "${worktreePath}"` };
    return { branch };
  } catch (err) {
    const e = err as { message?: string; stderr?: string | Buffer; status?: number; killed?: boolean; signal?: string };
    // execFileSync throws with killed=true + SIGTERM when the timeout fires —
        // fail closed with an explicit timeout error.
    if (e.killed === true || e.signal !== undefined) {
      return { error: `git probe timed out after ${timeout}ms (killed by ${e.signal ?? "SIGTERM"})` };
    }
    const detail = (e.stderr !== undefined ? e.stderr.toString().trim() : "") || e.message || "git probe failed";
    return { error: detail };
  }
}

/**
 * Probe the per-worktree git dir of a checkout via
 * `git -C <path> rev-parse --git-dir` — bounded exactly like `probeBranch`
 * (same timeout policy, same fail-closed shape). The resolved + realpath'd
 * git dir is the checkout's identity: a linked worktree from
 * `git worktree add` has its own git dir under the common dir, while a
 * plain subdirectory or a symlink alias of a checkout resolves to that
 * checkout's git dir. A non-repo path, a hung git, or an unresolvable git
 * dir is an error — never an identity.
 */
type CheckoutProbe = { gitDir: string } | { error: string };

function probeCheckout(worktreePath: string, opts: BranchProbeOptions): CheckoutProbe {
  const timeout = opts.timeoutMs ?? gitProbeTimeoutMs();
  try {
    const stdout = execFileSync(opts.gitPath ?? "git", ["-C", worktreePath, "rev-parse", "--git-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });
    const raw = stdout.trim();
    if (raw === "") return { error: `no git dir reported at "${worktreePath}"` };
    // git prints the git dir relative to the probed cwd (`.git` at the
    // checkout top, `../.git` from a subdirectory) or absolute (linked
    // worktrees); resolve against the probed path, then realpath so a
    // symlink alias of a checkout compares equal to the checkout itself.
    const abs = isAbsolute(raw) ? raw : join(worktreePath, raw);
    return { gitDir: realpathSync(abs) };
  } catch (err) {
    const e = err as { message?: string; stderr?: string | Buffer; status?: number; killed?: boolean; signal?: string };
    if (e.killed === true || e.signal !== undefined) {
      return { error: `git probe timed out after ${timeout}ms (killed by ${e.signal ?? "SIGTERM"})` };
    }
    const detail = (e.stderr !== undefined ? e.stderr.toString().trim() : "") || e.message || "git probe failed";
    return { error: detail };
  }
}

/**
 * True when `candidatePath` is a Git checkout DISTINCT from `controlPath` —
 * the canonical per-worktree git dirs differ. A linked worktree from
 * `git worktree add` (nested inside the control checkout or a sibling) has
 * its own git dir and is distinct; the same checkout, a plain subdirectory
 * of it, or a symlink alias of it resolves to the same git dir and is NOT
 * distinct. Everything unprovable — a non-repo path or a probe failure —
 * is NOT distinct: fail closed, never guess an identity.
 */
export function isDistinctCheckout(controlPath: string, candidatePath: string, opts: BranchProbeOptions = {}): boolean {
  const control = probeCheckout(controlPath, opts);
  const candidate = probeCheckout(candidatePath, opts);
  if ("error" in control || "error" in candidate) return false;
  return control.gitDir !== candidate.gitDir;
}

/**
 * Probe the repository top-level (worktree root) of a checkout via
 * `git -C <path> rev-parse --show-toplevel` — bounded exactly like
 * `probeBranch` / `probeCheckout`, fail-closed (null on any failure). The
 * canonical top-level is the checkout root regardless of where inside it
 * the probed path sits — a `.mstarc`-declared nested harness dir like
 * `<control>/state/.mstar` included — so callers never infer the checkout
 * root from `dirname(harness)` (a layout assumption that only holds when
 * the harness sits directly under the checkout).
 */
export function probeCheckoutRoot(path: string, opts: BranchProbeOptions = {}): string | null {
  const timeout = opts.timeoutMs ?? gitProbeTimeoutMs();
  try {
    const stdout = execFileSync(opts.gitPath ?? "git", ["-C", path, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });
    const raw = stdout.trim();
    if (raw === "") return null;
    return realpathSync(raw);
  } catch {
    return null;
  }
}

/**
 * L1 cross-plan pre-dispatch checklist (mstar-branch-worktree L1 table +
 * iteration spec worktree-write-model § "Locked interfaces (P1 engine)"):
 * main residency against the recorded expectation + non-ownership of any
 * active lifecycle branch, integration presence/alignment (iterations
 * require both integration fields; a standalone plan without integration
 * checks main vs feature only), pairwise main/integration/feature
 * Git-checkout identity, and the existing feature/lease checks. Null main
 * discovery is a failure (`worktree.main.unresolved`), never a skipped row.
 */
export function l1PreDispatchCheck(input: L1PreDispatchInput, opts: BranchProbeOptions = {}): GateResult {
  const violations: ValidationResult[] = [];
  // Invocation-local identity memo: each checkout is probed once across all pairs.
  const checkoutCache = new Map<string, CheckoutProbe>();
  const checkout = (path: string): CheckoutProbe => {
    const key = resolve(path);
    if (!checkoutCache.has(key)) checkoutCache.set(key, probeCheckout(path, opts));
    return checkoutCache.get(key)!;
  };
  const {
    workflowType,
    integrationWorktreePath,
    integrationBranch,
    mainWorktree,
    expectedMainBranch,
    lifecycleBranches,
    rowWorktreePath,
    rowWorkingBranch,
    planId,
  } = input;

  // Main residency row — never skipped. Null discovery is itself a failure.
  if (mainWorktree === null) {
    violations.push(
      violation(
        "high",
        "worktree.main.unresolved",
        `main worktree identity cannot be proved for plan "${planId}" (git worktree discovery failed or unavailable) \u2014 L1 refuses instead of skipping the residency row`,
        "run from inside the repository (or pass a resolvable cwd) so the main worktree can be discovered",
      ),
    );
  } else {
    if (expectedMainBranch.trim() === "") {
      violations.push(
        violation(
          "high",
          "worktree.main.expected-branch-missing",
          `neither a recorded main-worktree branch nor an explicit branch.base is available for plan "${planId}" \u2014 the expectation is never the branch observed at check time`,
          "record the main worktree branch at lifecycle start (plan header / --main-branch) or carry the explicit branch.base",
        ),
      );
    } else {
      violations.push(...assertMainWorktreeResidency(mainWorktree, expectedMainBranch).violations);
    }
    const owner = lifecycleBranches.find((entry) => entry.branch === mainWorktree.branch && entry.branch !== expectedMainBranch);
    if (mainWorktree.branch !== "" && owner) {
      const ownerLabel = owner.workflowId === null ? "an active lifecycle with no recorded workflow id" : `workflow ${owner.workflowId}`;
      const ownerRecovery =
        owner.workflowId === null
          ? "wait for the owning lifecycle to finish and close through its documented lifecycle verbs"
          : `wait for workflow ${owner.workflowId} to finish and close through its documented lifecycle verbs`;
      violations.push(
        violation(
          "high",
          "worktree.main.residency-switched",
          `main worktree "${mainWorktree.root}" is on branch "${mainWorktree.branch}", owned by ${ownerLabel}${owner.planId ? ` plan ${owner.planId}` : ""}`,
          `${ownerRecovery}, or have its coordinator correct the row via mstar plan prepare`,
        ),
      );
    }
  }

  // Integration inputs: iterations require both fields; a standalone plan
  // without integration passes empty strings (main vs feature only); if
  // either field is supplied, both and the full checks are required.
  const integrationRequired =
    workflowType === "iteration" || integrationWorktreePath.trim() !== "" || integrationBranch.trim() !== "";
  if (integrationRequired && (integrationWorktreePath.trim() === "" || integrationBranch.trim() === "")) {
    violations.push(
      violation(
        "high",
        "worktree.l1.integration-missing",
        `integration worktree path and branch are both required (workflow type "${workflowType}") for plan "${planId}" \u2014 got path ${JSON.stringify(integrationWorktreePath)}, branch ${JSON.stringify(integrationBranch)}`,
        "record snapshot integration_worktree_path + branch.integration (the dedicated integration checkout), or pass both empty for a standalone plan",
      ),
    );
  }

  if (rowWorktreePath.trim() === "") {
    violations.push(
      violation(
        "high",
        "worktree.l1.feature-scope-missing",
        `metadata.worktree_path is empty for plan "${planId}" \u2014 no registered feature worktree to dispatch against`,
        `Run \`mstar plan prepare --workflow ${input.workflowId ?? "<workflow-id>"} --plan ${planId} --worktree-path <absolute-feature-worktree> --working-branch ${rowWorkingBranch.trim() === "" ? "<feature-branch>" : JSON.stringify(rowWorkingBranch)}\` to record the missing worktree path`,
      ),
    );
  }
  if (rowWorkingBranch.trim() === "") {
    violations.push(
      violation(
        "high",
        "worktree.l1.feature-branch-missing",
        `metadata.working_branch is empty for plan "${planId}"`,
        `Run \`mstar plan prepare --workflow ${input.workflowId ?? "<workflow-id>"} --plan ${planId} --worktree-path ${rowWorktreePath.trim() === "" ? "<absolute-feature-worktree>" : JSON.stringify(rowWorktreePath)} --working-branch <feature-branch>\` to record the missing feature branch`,
      ),
    );
  }

  // Integration checkout existence + branch alignment (only when fully
  // supplied; the generic branch codes cover their unchanged conditions).
  if (integrationRequired && integrationWorktreePath.trim() !== "" && integrationBranch.trim() !== "") {
    if (!existsSync(integrationWorktreePath)) {
      violations.push(
        violation(
          "high",
          "worktree.l1.integration-missing",
          `integration worktree "${integrationWorktreePath}" does not exist for plan "${planId}" \u2014 the integration checkout must exist before dispatch`,
          `create it before dispatch: git worktree add ${shellQuote(integrationWorktreePath)} ${shellQuote(integrationBranch)}`,
        ),
      );
    } else {
      const probe = probeBranch(integrationWorktreePath, opts);
      if ("error" in probe) {
        violations.push(
          violation(
            "high",
            "worktree.branch-probe-failed",
            `cannot probe branch at the integration worktree "${integrationWorktreePath}" for plan "${planId}": ${probe.error}`,
            "verify the path is a git worktree checkout on the integration branch (not detached)",
          ),
        );
      } else if (probe.branch !== integrationBranch) {
        violations.push(
          violation(
            "high",
            "worktree.branch-mismatch",
            `integration worktree "${integrationWorktreePath}" is on branch "${probe.branch}", expected branch.integration "${integrationBranch}" (plan "${planId}")`,
            `checkout ${shellQuote(integrationBranch)} in the integration worktree`,
          ),
        );
      }
    }
  }

  /**
   * Pairwise Git-checkout identity: normalized path equality is the same
   * checkout (no probe); otherwise both paths must exist and their
   * canonical per-worktree git dirs must differ. A probe failure is
   * `worktree.l1.checkout-probe-failed` (fail closed, never an identity).
   */
  const identityViolation = (
    aPath: string,
    bPath: string,
    code: string,
    describe: string,
    fix: string,
  ): ValidationResult | null => {
    if (resolve(aPath) === resolve(bPath)) {
      return violation(
        "critical",
        code,
        `${describe} \u2014 the same checkout (normalized path equality) is not isolation`,
        fix,
      );
    }
    if (!existsSync(aPath) || !existsSync(bPath)) return null; // absence is reported by its own check
    const a = checkout(aPath);
    const b = checkout(bPath);
    if ("error" in a) {
      return violation(
        "high",
        "worktree.l1.checkout-probe-failed",
        `cannot establish the Git-checkout identity of "${aPath}" for plan "${planId}": ${a.error}`,
        "verify the path is a git checkout",
      );
    }
    if ("error" in b) {
      return violation(
        "high",
        "worktree.l1.checkout-probe-failed",
        `cannot establish the Git-checkout identity of "${bPath}" for plan "${planId}": ${b.error}`,
        "verify the path is a git checkout",
      );
    }
    if (a.gitDir === b.gitDir) {
      return violation(
        "critical",
        code,
        `${describe} \u2014 a plain subdirectory or symlink alias of the other checkout is not isolation (canonical per-worktree git dirs match)`,
        fix,
      );
    }
    return null;
  };

  // Feature worktree vs MAIN worktree.
  if (mainWorktree !== null && rowWorktreePath.trim() !== "") {
    const v = identityViolation(
      mainWorktree.root,
      rowWorktreePath,
      "worktree.l1.feature-equals-main",
      `row metadata worktree "${rowWorktreePath}" is the same Git checkout as the main worktree "${mainWorktree.root}" (plan "${planId}")`,
      "use a distinct feature worktree for the plan (git worktree add <path> <branch>)",
    );
    if (v !== null) violations.push(v);
  }
  // integration checkout vs MAIN worktree.
  if (mainWorktree !== null && integrationRequired && integrationWorktreePath.trim() !== "") {
    const v = identityViolation(
      mainWorktree.root,
      integrationWorktreePath,
      "worktree.l1.integration-equals-main",
      `integration worktree "${integrationWorktreePath}" is the same Git checkout as the main worktree "${mainWorktree.root}" (plan "${planId}") \u2014 the integration checkout is the sole merge cwd and must be dedicated`,
      "use a dedicated integration checkout on branch.integration (git worktree add <path> <integration-branch>) and record it as integration_worktree_path",
    );
    if (v !== null) violations.push(v);
  }
  // Feature worktree vs integration checkout.
  if (integrationRequired && integrationWorktreePath.trim() !== "" && rowWorktreePath.trim() !== "") {
    const v = identityViolation(
      integrationWorktreePath,
      rowWorktreePath,
      "worktree.l1.feature-equals-integration",
      `row metadata worktree "${rowWorktreePath}" is the same Git checkout as the integration worktree "${integrationWorktreePath}" (plan "${planId}") \u2014 the feature worktree must be distinct from both main and integration`,
      "use a distinct feature worktree for the plan (git worktree add <path> <working-branch>)",
    );
    if (v !== null) violations.push(v);
  }

  if (rowWorktreePath.trim() !== "" && !existsSync(rowWorktreePath)) {
    violations.push(
      violation(
        "high",
        "worktree.l1.feature-missing",
        `feature worktree directory "${rowWorktreePath}" does not exist for plan "${planId}"`,
        `create it before dispatch: git worktree add ${shellQuote(rowWorktreePath)} <working-branch>`,
      ),
    );
  } else if (rowWorktreePath.trim() !== "" && rowWorkingBranch.trim() !== "") {
    const probe = probeBranch(rowWorktreePath, opts);
    if ("error" in probe) {
      violations.push(
        violation(
          "high",
          "worktree.l1.branch-probe-failed",
          `cannot probe branch at "${rowWorktreePath}" for plan "${planId}": ${probe.error}`,
          "verify the path is a git worktree checkout on the recorded working branch (not detached)",
        ),
      );
    } else if (probe.branch !== rowWorkingBranch) {
      violations.push(
        violation(
          "high",
          "worktree.l1.branch-mismatch",
          `feature worktree "${rowWorktreePath}" is on branch "${probe.branch}", expected metadata.working_branch "${rowWorkingBranch}" (plan "${planId}")`,
          `checkout ${shellQuote(rowWorkingBranch)} in the feature worktree`,
        ),
      );
    }
  }

  return gate(violations);
}

/**
 * L2 within-plan pre-dispatch checklist (parallel-writable-pre-dispatch.md):
 * every parallel writable track's `worktreePath` must be absolute and
 * distinct (one Worktree per track — N parallel invokes ≠ isolation), the
 * worktree dir must exist, and `git -C <path> branch --show-current` must
 * match its Working branch — before the first concurrent writable dispatch.
 * Fewer than one track is itself a violation (the checklist needs something
 * to verify).
 */
export function l2PreDispatchCheck(input: L2PreDispatchInput, opts: BranchProbeOptions = {}): GateResult {
  const violations: ValidationResult[] = [];
  const tracks = input.tracks ?? [];
  const seenPaths = new Set<string>();

  if (tracks.length < 1) {
    violations.push(
      violation(
        "high",
        "worktree.l2.no-tracks",
        "no parallel writable tracks \u2014 the L2 pre-dispatch checklist requires at least one track with an absolute worktreePath and Working branch",
        "pass each track's absolute Worktree path and PM-approved Working branch",
      ),
    );
  }

  tracks.forEach((track, index) => {
    if (track.worktreePath.trim() === "" || track.workingBranch.trim() === "") {
      violations.push(
        violation(
          "high",
          "worktree.l2.track-invalid",
          `track ${index + 1} is missing worktreePath and/or workingBranch`,
          "fill both fields for every track",
        ),
      );
      return;
    }
    if (!isAbsolute(track.worktreePath)) {
      violations.push(
        violation(
          "high",
          "worktree.l2.track-path-relative",
          `track ${index + 1} worktreePath "${track.worktreePath}" is not an absolute path \u2014 L2 tracks MUST use absolute worktree checkout paths (consistent with the lease validator's absolute worktree_path enforcement)`,
          `use an absolute path for track ${index + 1} (e.g. /Users/<you>/worktrees/<branch>)`,
        ),
      );
      return;
    }
    // Normalized collision check : '/a/b/' and '/a/b/../b' alias the
    // same directory as '/a/b' — resolve before the seen-set comparison.
    const normalized = resolve(track.worktreePath);
    if (seenPaths.has(normalized)) {
      violations.push(
        violation(
          "high",
          "worktree.l2.track-path-collision",
          `duplicate worktreePath "${track.worktreePath}" across parallel tracks \u2014 L2 parallel-writable isolation requires a distinct absolute Worktree path per track (N parallel invokes \u2260 isolation)`,
          "give every parallel track its own git worktree checkout",
        ),
      );
      return;
    }
    seenPaths.add(normalized);
    if (!existsSync(track.worktreePath)) {
      violations.push(
        violation(
          "high",
          "worktree.l2.track-missing",
          `track worktree directory "${track.worktreePath}" does not exist`,
          `create it before dispatch: git worktree add ${track.worktreePath} ${track.workingBranch}`,
        ),
      );
      return;
    }
    const probe = probeBranch(track.worktreePath, opts);
    if ("error" in probe) {
      violations.push(
        violation(
          "high",
          "worktree.l2.branch-probe-failed",
          `cannot probe branch at "${track.worktreePath}": ${probe.error}`,
          "verify the path is a git worktree checkout on its Working branch (not detached)",
        ),
      );
    } else if (probe.branch !== track.workingBranch) {
      violations.push(
        violation(
          "high",
          "worktree.l2.branch-mismatch",
          `track worktree "${track.worktreePath}" is on branch "${probe.branch}", expected Working branch "${track.workingBranch}"`,
          `checkout ${track.workingBranch} in that worktree`,
        ),
      );
    }
  });

  return gate(violations);
}

/**
 * L1 hard rule (main control root vs feature): the path recorded in
 * `plans[].metadata.worktree_path` MUST be a Git checkout DISTINCT from the
 * MAIN worktree (the process-SSOT control root). Same checkout, subdirectory
 * and symlink aliases fail closed. Both-empty is invalid; one empty leaves
 * comparison to the metadata/scope validator.
 */
export function assertControlVsFeaturePath(
  controlWorktreePath: string,
  featureWorktreePath: string,
  opts: BranchProbeOptions = {},
): GateResult {
  const violations: ValidationResult[] = [];
  if (controlWorktreePath === "" && featureWorktreePath === "") {
    violations.push(
      violation(
        "critical",
        "worktree.control-feature.same",
        `main control root and feature worktree path are both empty \u2014 metadata.worktree_path MUST be a distinct checkout from the main worktree`,
        "record a distinct feature worktree path",
      ),
    );
    return gate(violations);
  }
  if (controlWorktreePath === "" || featureWorktreePath === "") {
    return gate(violations); // one empty — nothing to compare (retained contract)
  }
  if (!isDistinctCheckout(controlWorktreePath, featureWorktreePath, opts)) {
    violations.push(
      violation(
        "critical",
        "worktree.control-feature.same",
        `main control root "${controlWorktreePath}" and feature worktree path "${featureWorktreePath}" are not distinct Git checkouts \u2014 a plain subdirectory or symlink alias of the main checkout is not isolation; metadata.worktree_path MUST be a distinct checkout`,
        "use a distinct feature worktree for the plan's product edits (git worktree add <path> <branch>)",
      ),
    );
  }
  return gate(violations);
}

/**
 * Assert the branch checked out at `worktreePath` matches `expectedBranch`
 * (the Assignment Working branch). Probe = `git -C <path> branch
 * --show-current`; precompute via `opts.branchOf` for purity. Fail-closed on
 * probe errors and detached HEAD.
 */
export function assertBranchAlignment(worktreePath: string, expectedBranch: string, opts: BranchProbeOptions = {}): GateResult {
  const violations: ValidationResult[] = [];
  const probe = probeBranch(worktreePath, opts);
  if ("error" in probe) {
    violations.push(
      violation(
        "high",
        "worktree.branch-probe-failed",
        `cannot probe branch at "${worktreePath}": ${probe.error}`,
        "verify the path is a git worktree checkout on the expected branch (not detached)",
      ),
    );
  } else if (probe.branch !== expectedBranch) {
    violations.push(
      violation(
        "high",
        "worktree.branch-mismatch",
        `worktree "${worktreePath}" is on branch "${probe.branch}", expected "${expectedBranch}" (Assignment Working branch)`,
        `checkout ${expectedBranch} in that worktree`,
      ),
    );
  }
  return gate(violations);
}

const QC_ALIGNMENT_FIELDS: ReadonlyArray<{ key: keyof QcAlignmentAssignment; label: string }> = [
  { key: "planId", label: "plan_id" },
  { key: "reviewRange", label: "Review range" },
  { key: "diffBasis", label: "Diff basis" },
];

/**
 * QC/QA 对齐字段契约: `plan_id` + `Review range`/`Diff basis` must be
 * byte-identical (逐字相同 — no trimming, no normalization) across every
 * assignment in the set, so the QC tri + QA review the same plan/feature and
 * the same diff range. One violation per field that differs.
 */
export function assertQcAlignment(assignments: readonly QcAlignmentAssignment[]): GateResult {
  const violations: ValidationResult[] = [];
  const list = assignments ?? [];

  for (const { key, label } of QC_ALIGNMENT_FIELDS) {
    const distinct = [...new Set(list.map((a) => a[key]))];
    if (distinct.length > 1) {
      violations.push(
        violation(
          "high",
          "qc.alignment.mismatch",
          `QC/QA alignment field "${label}" is not byte-identical across ${list.length} assignments: ${distinct
            .map((v) => `"${v}"`)
            .join(" vs ")}`,
          `copy the same ${label} value verbatim into every QC tri and QA Assignment`,
        ),
      );
    }
  }
  return gate(violations);
}

/**
 * Single review snapshot precondition (派 QC 前置条件): all reviewable
 * commits must sit on ONE Working branch HEAD before the QC tri + QA are
 * dispatched. `head` is precomputed per assignment (full SHA preferred);
 * different heads → violation; a missing head cannot confirm the snapshot →
 * violation (fail-closed).
 */
export function singleReviewSnapshot(assignments: readonly QcSnapshotAssignment[]): GateResult {
  const violations: ValidationResult[] = [];
  const list = assignments ?? [];

  list.forEach((a, index) => {
    if ((a.head ?? "").trim() === "") {
      violations.push(
        violation(
          "high",
          "qc.alignment.snapshot-missing",
          `review head not provided for assignment ${index + 1} (plan_id "${a.planId}") \u2014 cannot confirm the single review snapshot precondition`,
          "precompute and pass the review HEAD (full SHA) for every assignment",
        ),
      );
    }
  });

  const distinct = [...new Set(list.map((a) => a.head ?? "").filter((h) => h.trim() !== ""))];
  if (distinct.length > 1) {
    violations.push(
      violation(
        "high",
        "qc.alignment.single-snapshot",
        `assignments cover ${distinct.length} different review heads (${distinct.join(", ")}) \u2014 all reviewable commits must sit on ONE Working branch HEAD before QC tri + QA`,
        "merge the parallel tracks to a single Working branch HEAD, then re-derive the heads",
      ),
    );
  }
  return gate(violations);
}

/** Shell-safe display of snapshot-controlled command arguments. */
function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
