/**
 * CLI `mstar status workflow-close` — the post-merge lifecycle close verb.
 *
 * The close runs on the ACTIVE execution authority only: it is one terminal
 * `lifecycle` transition on the workflow mutation API, which re-checks the
 * plan-row completion prerequisite, consults the registered delivery evidence,
 * refuses a dangling integration merge claim, writes the terminal state and
 * unregisters the root entry in one transaction. The pre-activation file route
 * (`closeFileWorkflow`, the `--ended-at` / `--session <path>` transports) is
 * retired, so this suite pins:
 * - exit 0: a fully-closed ACTIVE lifecycle (stored `completed` + `ended_at`,
 *   the root register no longer serving the id, the phase-6 projection passing
 *   on the same state).
 * - exit 1 refusals before any write: an unfinished plan row
 *   (`coordination.invalid-transition`, header bytes unchanged), a control root
 *   with no ACTIVE authority (`execution.not-active` — the recovery names the
 *   ACTIVE route, and the legacy `status.json` / snapshot bytes are untouched),
 *   and a missing caller identity (`coordination.identity-missing`).
 * - exit 2 usage: missing `--workflow`; the removed file-route transports.
 * - exit 1: a hostile workflow id is rejected up front by the shared id guard.
 *
 * Every case runs the real CLI as a subprocess against a temp fixture with an
 * ACTIVE authority (or, for the retired-route case, a legacy file root) — no
 * live workflow is ever touched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  initializeStore,
  openStore,
  readExecutionAuthority,
  serializeExecutionValue,
  type ExecutionIdentity,
  type StoreContext,
} from "@mstar-harness/engine";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");
const WORKFLOW_ID = "wf-close";
const PLAN_ID = "plan-close";
const COORDINATOR_ID = "coord-close";
const COMPLETION_POLICY = "acceptance report at plans/plan-close/report.md";

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface CommandEnvelope {
  version: number;
  command: string;
  status: "ok" | "refused" | "usage" | "error";
  code: string;
  exitCode: number;
  message?: string;
  data?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function envelope(result: RunResult): CommandEnvelope {
  return JSON.parse(result.stdout) as CommandEnvelope;
}

function message(result: RunResult): string {
  return envelope(result).message ?? "";
}

function recoveryOf(result: RunResult): string {
  const recovery = envelope(result).details?.recovery;
  return typeof recovery === "string" ? recovery : "";
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/**
 * Spawn env with ambient harness env vars pinned out: the CLI resolves harness
 * dirs from MSTAR_HARNESS_DIR / MSTAR_CONTROL_ROOT ahead of probing, and
 * SDD_DIR redirects default outfile paths — ambient values would redirect every
 * fixture spuriously.
 */
function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR") continue;
    if (key === "MSTAR_HOST_SESSION_ID" || key === "MSTAR_EXECUTION_IDENTITY") continue;
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

function runCli(args: string[], cwd: string, extra: Record<string, string> = {}): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd,
    env: cliEnv(extra),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function jsonOf(result: RunResult): Record<string, unknown> {
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`expected JSON stdout, got ${JSON.stringify(result.stdout)} (stderr: ${result.stderr})`);
  }
}

function dataOf(result: RunResult): Record<string, unknown> {
  const data = jsonOf(result).data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`expected a data object, got ${result.stdout}`);
  }
  return data as Record<string, unknown>;
}

interface Fixture {
  root: string;
  harness: string;
  context: StoreContext;
  worktree: string;
  baseSha: string;
  sourceSha: string;
  qcReport: string;
  qcConsolidated: string;
  qaReport: string;
}

function coordinatorIdentity(): ExecutionIdentity {
  return { source: "local", sessionId: COORDINATOR_ID, workflowId: WORKFLOW_ID, role: "coordinator" };
}

/** The launcher channel that carries the caller's acquired identity. */
function identityEnv(): Record<string, string> {
  return { MSTAR_EXECUTION_IDENTITY: serializeExecutionValue(coordinatorIdentity()) };
}

function gitOut(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * A temp Git workspace whose `.mstar` holds an ACTIVE execution authority, a
 * real feature checkout and the registered report-only plan document. The row's
 * delivery is `verification/report-only`, so its completion is the recorded
 * fulfilment of the declared policy plus QC/QA evidence — no merge, no
 * integration pair.
 */
async function activeFixture(label: string): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${label}-`)));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  const harness = join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  const context: StoreContext = { harnessDir: harness };
  const store = await initializeStore(context);
  store.close();
  const baseSha = gitOut(["rev-parse", "HEAD"], root);

  const worktree = join(root, "wt-feature");
  execFileSync("git", ["worktree", "add", "-q", "-b", "feature/close", worktree], { cwd: root });
  writeText(join(worktree, "slice.txt"), "slice\n");
  execFileSync("git", ["add", "slice.txt"], { cwd: worktree });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feat: slice"], { cwd: worktree });
  const sourceSha = gitOut(["rev-parse", "HEAD"], worktree);

  writeText(join(harness, "plans", `${PLAN_ID}.md`), `# Close plan\n\n**plan_id:** ${PLAN_ID}\n\n**title:** Close plan\n`);
  const sdd = join(harness, "sdd", PLAN_ID);
  const qcReport = join(sdd, "review", "qc1.md");
  const qcConsolidated = join(sdd, "review", "qc.md");
  const qaReport = join(sdd, "qa.md");
  writeText(qcReport, "# QC 1\ndecision: Approve\n");
  writeText(qcConsolidated, "# QC consolidated\ndecision: Approve\n");
  writeText(qaReport, "# QA\nverdict: pass\n");
  return { root, harness, context, worktree, baseSha, sourceSha, qcReport, qcConsolidated, qaReport };
}

/** `register → bind`: the ACTIVE producer chain the close consumes. */
async function registerAndBind(fixture: Fixture): Promise<void> {
  const rootToken = (await readExecutionAuthority(fixture.context)).token;
  const registered = runCli([
    "workflow", "register",
    "--workflow", WORKFLOW_ID,
    "--plan-id", PLAN_ID,
    "--plan-title", "Close plan",
    "--plan-file", `plans/${PLAN_ID}.md`,
    "--delivery-kind", "verification/report-only",
    "--completion-policy", COMPLETION_POLICY,
    "--expect", rootToken,
    "--operation", "register-1",
    "--harness", fixture.harness,
  ], fixture.root, identityEnv());
  if (registered.exitCode !== 0) throw new Error(`workflow register failed: ${registered.stdout}${registered.stderr}`);

  const state = await readExecutionAuthority(fixture.context, { workflowId: WORKFLOW_ID });
  if (!("workflows" in state.data)) throw new Error("the workflow read did not return a state");
  const workflow = state.data.workflows.find((entry) => entry.state.id === WORKFLOW_ID);
  if (workflow === undefined) throw new Error(`workflow ${WORKFLOW_ID} is not in the authority register`);
  const bound = runCli([
    "plan", "bind",
    "--execution",
    "--workflow", WORKFLOW_ID,
    "--coordinator",
    "--expect", workflow.workflowToken,
    "--operation", "bind-1",
    "--harness", fixture.harness,
  ], fixture.root, identityEnv());
  if (bound.exitCode !== 0) throw new Error(`plan bind failed: ${bound.stdout}${bound.stderr}`);
}

function closeArgs(fixture: Fixture, extra: string[] = []): string[] {
  return ["status", "workflow-close", "--workflow", WORKFLOW_ID, "--harness", fixture.harness, ...extra];
}

/** Drive the row and the delivery evidence up to the close prerequisite. */
async function driveToDone(fixture: Fixture): Promise<void> {
  const prepared = runCli([
    "plan", "prepare",
    "--plan", PLAN_ID,
    "--worktree-path", fixture.worktree,
    "--working-branch", "feature/close",
    "--qa-gate", "mandatory",
    "--findings-cleanup", "allow-residual",
    "--harness", fixture.harness,
  ], fixture.root, identityEnv());
  if (prepared.exitCode !== 0) throw new Error(`plan prepare failed: ${prepared.stdout}${prepared.stderr}`);

  for (const status of ["InProgress", "InReview"]) {
    const payload = join(fixture.root, `progress-${status}.json`);
    writeJson(payload, { status, summary: `${status} for close`, evidence_paths: [fixture.qcReport] });
    const moved = runCli(["plan", "progress", "--plan", PLAN_ID, "--file", payload, "--harness", fixture.harness], fixture.root, identityEnv());
    if (moved.exitCode !== 0) throw new Error(`plan progress ${status} failed: ${moved.stdout}${moved.stderr}`);
  }

  const delivery = join(fixture.root, "delivery.json");
  writeJson(delivery, { completion: { policy: COMPLETION_POLICY, evidence: "acceptance/plan-close/report.md" } });
  const recorded = runCli(["workflow", "evidence", "--workflow", WORKFLOW_ID, "--file", delivery, "--harness", fixture.harness], fixture.root, identityEnv());
  if (recorded.exitCode !== 0) throw new Error(`workflow evidence failed: ${recorded.stdout}${recorded.stderr}`);

  const completion = join(fixture.root, "completion.json");
  writeJson(completion, {
    source_sha: fixture.sourceSha,
    review_base: fixture.baseSha,
    review_head: fixture.sourceSha,
    qc: { decision: "Approve", reports: [fixture.qcReport], consolidated: fixture.qcConsolidated },
    qa: { gate: "mandatory", decision: "pass", report: fixture.qaReport },
  });
  const completed = runCli(["plan", "complete", "--plan", PLAN_ID, "--file", completion, "--harness", fixture.harness], fixture.root, identityEnv());
  if (completed.exitCode !== 0) throw new Error(`plan complete failed: ${completed.stdout}${completed.stderr}`);
}

/** The stored header of the workflow, read from the real row. */
async function storedHeader(fixture: Fixture): Promise<{ status?: unknown; ended_at?: unknown }> {
  const handle = await openStore(fixture.context, "read");
  try {
    const row = handle.db.prepare("select state_json from execution_workflows where workflow_id = ?").get(WORKFLOW_ID);
    if (typeof row !== "object" || row === null || !("state_json" in row) || typeof row.state_json !== "string") {
      throw new Error(`no stored row for ${WORKFLOW_ID}`);
    }
    const parsed: unknown = JSON.parse(row.state_json);
    if (typeof parsed !== "object" || parsed === null) throw new Error("stored row is not an object");
    return {
      ...("status" in parsed ? { status: parsed.status } : {}),
      ...("ended_at" in parsed ? { ended_at: parsed.ended_at } : {}),
    };
  } finally {
    handle.close();
  }
}

/** The IDs the authority's root register currently serves. */
async function servedRoot(fixture: Fixture): Promise<readonly { id: string }[]> {
  const read = await readExecutionAuthority(fixture.context);
  if (!("workflows" in read.data)) throw new Error("the register read did not return the whole state");
  return read.data.root.workflows;
}

describe("mstar status workflow-close — ACTIVE lifecycle close", () => {
  test("closes the finished lifecycle: terminal state, root unregister and the phase-6 projection", async () => {
    const fixture = await activeFixture("mstar-close-active");
    await registerAndBind(fixture);
    await driveToDone(fixture);

    expect((await storedHeader(fixture)).status).toBe("running");
    expect(await servedRoot(fixture)).toHaveLength(1);

    const closed = runCli(closeArgs(fixture, ["--reason", "delivery complete"]), fixture.root, identityEnv());
    expect(closed.exitCode, closed.stdout).toBe(0);
    expect(jsonOf(closed)).toMatchObject({ command: "status.workflow-close", status: "ok" });

    // The terminal state is persisted in the same transaction that dropped the
    // registry row: the row survives in `execution_workflows`, the register no
    // longer serves the id.
    const terminal = await storedHeader(fixture);
    expect(terminal.status).toBe("completed");
    expect(typeof terminal.ended_at).toBe("string");
    expect(await servedRoot(fixture)).toHaveLength(0);

    // The read-only phase-6 projection passes on the same lifecycle state.
    const phase6 = runCli(["iteration", "gate", "--phase", "6", "--workflow", WORKFLOW_ID, "--harness", fixture.harness], fixture.root);
    expect(phase6.exitCode, phase6.stdout).toBe(0);
    expect(jsonOf(phase6)).toMatchObject({ status: "ok", data: { phase: 6 } });
  }, 30_000);

  test("a repeated close of the closed lifecycle refuses without a second write", async () => {
    const fixture = await activeFixture("mstar-close-retry");
    await registerAndBind(fixture);
    await driveToDone(fixture);

    expect(runCli(closeArgs(fixture), fixture.root, identityEnv()).exitCode).toBe(0);
    const terminal = await storedHeader(fixture);

    const retry = runCli(closeArgs(fixture, ["--reason", "again"]), fixture.root, identityEnv());
    expect(retry.exitCode).toBe(1);
    // The registry no longer serves the closed lifecycle, so the exact-address
    // read refuses it; the recorded terminal state is left as it was.
    expect(envelope(retry).code).toBe("coordination.workflow-not-found");
    expect(await storedHeader(fixture)).toEqual(terminal);
  }, 30_000);
});

describe("mstar status workflow-close — prerequisite refusals", () => {
  test("an unfinished plan row refuses before any write", async () => {
    const fixture = await activeFixture("mstar-close-unfinished");
    await registerAndBind(fixture);

    const before = await storedHeader(fixture);
    const result = runCli(closeArgs(fixture, ["--reason", "too early"]), fixture.root, identityEnv());
    expect(result.exitCode).toBe(1);
    expect(envelope(result).code).toBe("coordination.invalid-transition");
    // Row completion is an explicit close prerequisite, not a transition the
    // close invents: the header keeps its running lifecycle.
    expect(await storedHeader(fixture)).toEqual(before);
    expect(await servedRoot(fixture)).toHaveLength(1);
  }, 30_000);

  test("a missing caller identity refuses and names the identity recovery", async () => {
    const fixture = await activeFixture("mstar-close-identity");
    await registerAndBind(fixture);

    const result = runCli(closeArgs(fixture), fixture.root);
    expect(result.exitCode).toBe(1);
    expect(envelope(result).code).toBe("coordination.identity-missing");
    // The recovery states the supported route: mint/bind a coordinator identity.
    expect(message(result)).toContain("mstar session run");
    expect(message(result)).toContain("mstar plan bind --execution");
    expect((await storedHeader(fixture)).status).toBe("running");
  }, 30_000);

  test("a control root with no ACTIVE authority refuses, names the ACTIVE route, and leaves the file bytes untouched", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-close-legacy-")));
    roots.push(root);
    const harness = join(root, ".mstar");
    writeText(join(harness, "plans", `${PLAN_ID}.md`), `# Close plan\n\n**plan_id:** ${PLAN_ID}\n`);
    const statusPath = join(harness, "status.json");
    const snapshotPath = join(harness, "workflows", WORKFLOW_ID, "snapshot.json");
    writeJson(statusPath, {
      version: 2,
      updated_at: "2026-09-15",
      workflows: [{ id: WORKFLOW_ID, type: "plan", started_at: "2026-09-01", dir: `workflows/${WORKFLOW_ID}` }],
    });
    writeJson(snapshotPath, {
      schema_version: 1, id: WORKFLOW_ID, type: "plan", status: "running",
      started_at: "2026-09-01", updated_at: "2026-09-15", delivery_kind: "development",
      branch: { source: "feature/close", target: "main" },
      delivery: {
        compound: { outcome: "created" },
        pr: { repo: "synthetic/example", head: "feature/close", target: "main" },
        merge: { provider: "synthetic-fixture", evidence: "fixture verified-merge record" },
      },
      plans: [{ id: PLAN_ID, title: "Close plan", file: `plans/${PLAN_ID}.md`, status: "Done" }],
    });
    const beforeStatus = readFileSync(statusPath, "utf8");
    const beforeSnapshot = readFileSync(snapshotPath, "utf8");

    const result = runCli(
      ["status", "workflow-close", "--workflow", WORKFLOW_ID, "--harness", harness, "--reason", "close"],
      root,
      identityEnv(),
    );
    expect(result.exitCode).toBe(1);
    // The retired file route never answers: a control root without a store
    // refuses store.not-initialized and its recovery names the ACTIVE route.
    expect(envelope(result).code).toBe("store.not-initialized");
    expect(recoveryOf(result)).toContain("mstar store init");
    expect(readFileSync(statusPath, "utf8")).toBe(beforeStatus);
    expect(readFileSync(snapshotPath, "utf8")).toBe(beforeSnapshot);
  }, 30_000);
});

describe("mstar status workflow-close — usage and the retired file transports", () => {
  test("missing workflow selector is a usage refusal", async () => {
    const fixture = await activeFixture("mstar-close-usage");
    const result = runCli(["status", "workflow-close", "--harness", fixture.harness], fixture.root);
    expect(result.exitCode).toBe(2);
    expect(envelope(result)).toMatchObject({ status: "usage", code: "command.invalid-input" });
  }, 30_000);

  test("a retired file-route input refuses by naming the ACTIVE route", async () => {
    const fixture = await activeFixture("mstar-close-file-flags");
    await registerAndBind(fixture);

    for (const [fileInput, flag] of [["--ended-at", "--ended-at"], ["--session", "--session"]] as const) {
      const values = fileInput === "--ended-at" ? ["2026-09-12"] : [join(fixture.harness, "session.json")];
      const result = runCli(closeArgs(fixture, [fileInput, ...values]), fixture.root, identityEnv());
      expect(result.exitCode).toBe(2);
      expect(envelope(result)).toMatchObject({ status: "usage", code: "command.invalid-input" });
      // The refusal names the retired input AND the supported ACTIVE route.
      expect(message(result)).toContain(flag);
      expect(message(result)).toContain("ACTIVE execution authority");
      expect(recoveryOf(result)).toContain("mstar status workflow-close --workflow <id> --reason <text>");
      // The retired transport never reached a write: the lifecycle stays open.
      expect((await storedHeader(fixture)).status).toBe("running");
    }
  }, 30_000);

  test("a hostile workflow id is rejected by the shared id guard", async () => {
    const fixture = await activeFixture("mstar-close-hostile");
    const result = runCli(["status", "workflow-close", "--workflow", "../escape", "--harness", fixture.harness], fixture.root);
    expect(result.exitCode).toBe(1);
    expect(envelope(result).code).toBe("workflow.invalid-id");
    expect(message(result)).toContain("invalid workflow id");
    expect(existsSync(join(fixture.root, "escape"))).toBe(false);
  }, 30_000);
});
