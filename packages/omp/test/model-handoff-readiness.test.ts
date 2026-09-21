/**
 * E1/E2 contract tests — explicit workflow binding and read-only Phase 1
 * readiness.
 *
 * Every Git fact runs in a disposable repository with a local bare remote and a
 * linked integration worktree; the harness root, register, workflow snapshot,
 * compass, coordinator envelope, plan files and review/Prepare payload copies
 * are fixtures inside that disposable main checkout. Nothing here reads or
 * writes the operator's repository, harness, sessions, model settings or
 * configuration, and no test reaches the network: the only remote is a local
 * bare repository created inside the fixture root.
 *
 * The binding E2 consumes is the *actual* return value of
 * `reserveHandoffBinding`, captured before the fixture creates the workflow
 * artifacts — the same order of operations the coordinator performs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { inspectPhase1Readiness, reserveHandoffBinding } from "../src/model-handoff-readiness";
import type { HandoffBinding, HandoffBindingInput, Phase1CompletionInput, Phase1Readiness } from "../src/model-handoff-readiness";

const SPECIALISTS = ["product-manager", "architect", "writing-specialist"] as const;
const SCRATCH: string[] = [];
/** The module resolves the harness through the engine's documented precedence. */
const HARNESS_ENV = process.env.MSTAR_HARNESS_DIR;

beforeAll(() => {
  delete process.env.MSTAR_HARNESS_DIR;
});
afterAll(() => {
  if (HARNESS_ENV !== undefined) process.env.MSTAR_HARNESS_DIR = HARNESS_ENV;
  for (const dir of SCRATCH) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omp-handoff-readiness-"));
  SCRATCH.push(dir);
  return dir;
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function text(path: string): string {
  return readFileSync(path, "utf8");
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** CAS version of a file's current bytes, computed independently of the module. */
function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

/** Age a file's atime so a later read stays observable under Linux `relatime`. */
function ageAtime(path: string): void {
  utimesSync(path, new Date(Date.now() - 3_600_000), new Date());
}

function atimeOf(path: string): number {
  return statSync(path).atimeMs;
}

function codesOf(readiness: Phase1Readiness): readonly string[] {
  return readiness.ready ? [] : readiness.codes;
}

type Fixture = Readonly<{
  root: string;
  main: string;
  harness: string;
  integration: string;
  integrationBranch: string;
  workflowId: string;
  siblingId: string;
  sessionId: string;
  planIds: readonly string[];
  reportPaths: readonly string[];
  binding: HandoffBinding;
  input: Phase1CompletionInput;
}>;

async function buildFixture(options: { workflowId?: string; planIds?: readonly string[] } = {}): Promise<Fixture> {
  const workflowId = options.workflowId ?? "fixture-iteration";
  const siblingId = "fixture-sibling-iteration";
  const planIds = options.planIds ?? ["fixture-plan"];
  const sessionId = "fixture-session-0001";
  const integrationBranch = "iteration/fixture";

  const root = scratchDir();
  const bare = join(root, "remote.git");
  git(["init", "-q", "--bare", bare], root);
  const main = join(root, "main");
  git(["init", "-q", "-b", "main", main], root);
  git(["config", "user.email", "fixture@example.invalid"], main);
  git(["config", "user.name", "fixture"], main);
  writeFileSync(join(main, "README.md"), "fixture\n");
  git(["add", "README.md"], main);
  git(["commit", "-qm", "init"], main);
  git(["remote", "add", "origin", bare], main);
  git(["push", "-q", "-u", "origin", "main"], main);

  const integration = join(root, "integration");
  git(["worktree", "add", "-q", "-b", integrationBranch, integration], main);
  git(["push", "-q", "-u", "origin", integrationBranch], integration);

  const harness = join(main, ".mstar");
  const workflowsDir = join(harness, "workflows");
  const iterationsDir = join(harness, "iterations");
  const plansDir = join(harness, "plans");
  for (const dir of [workflowsDir, iterationsDir, plansDir]) mkdirSync(dir, { recursive: true });

  // A sibling active iteration: registered, running and never adopted.
  mkdirSync(join(workflowsDir, siblingId), { recursive: true });
  writeJson(join(workflowsDir, siblingId, "snapshot.json"), {
    schema_version: 1,
    id: siblingId,
    type: "iteration",
    status: "running",
    started_at: "2026-09-16",
    updated_at: "2026-09-16T00:00:00.000Z",
    plans: [],
  });
  writeRegister(harness, [siblingId]);

  // E1 runs before the workflow artifacts exist — the real order of operations.
  const reservation = await reserveHandoffBinding(
    { workflowId, entry: "iteration-start", intent: "new-iteration", authority: "coordinator" },
    { sessionId, cwd: main, taskSession: false },
    "reserve",
  );
  if (!reservation.ok) throw new Error(`fixture reservation refused: ${reservation.code} ${reservation.message}`);
  const binding = reservation.binding;

  // The lawful workflow creation the coordinator performs after the reservation.
  const workflowDir = join(workflowsDir, workflowId);
  const iterationDir = join(iterationsDir, workflowId);
  const guidesDir = join(iterationDir, "guides");
  mkdirSync(join(workflowDir, "sessions"), { recursive: true });
  mkdirSync(guidesDir, { recursive: true });
  const envelopePath = join(workflowDir, "sessions", `${sessionId}.json`);
  writeJson(envelopePath, {
    schema_version: 1,
    role: "coordinator",
    session_id: sessionId,
    workflow_id: workflowId,
    harness_root: harness,
  });
  const planPaths = planIds.map((id) => join(plansDir, `${id}.md`));
  // §4: a real registered plan markdown declares its own `plan_id` — the
  // shared resolver (registration, the Prepare append and readiness) requires
  // that declaration, so the fixture states it like any registered plan does.
  planPaths.forEach((path, index) =>
    writeFileSync(path, `# ${planIds[index]}\n\n**plan_id:** ${planIds[index]}\n\nPlan body.\n`),
  );
  const evidencePaths = planIds.map((id) => join(guidesDir, `${id}-prepare.md`));
  evidencePaths.forEach((path, index) => writeFileSync(path, `# Prepare evidence — ${planIds[index]}\n`));
  const reportPaths = SPECIALISTS.map((role) => join(guidesDir, `${role}-return.md`));
  reportPaths.forEach((path, index) => writeFileSync(path, `returned payload — ${SPECIALISTS[index]}\n`));
  writeJson(join(workflowDir, "snapshot.json"), {
    schema_version: 1,
    id: workflowId,
    type: "iteration",
    status: "running",
    phase: "phase-1-prepare",
    started_at: "2026-09-16",
    updated_at: "2026-09-16T00:00:00.000Z",
    compass_ref: `iterations/${workflowId}/delivery-compass.md`,
    branch: { base: "main", integration: integrationBranch, target: "main" },
    execution_policy: { plan_parallelism: "parallel", worktree_mode: "required", push_policy: "after-review-wave" },
    integration_worktree_path: integration,
    plans: planIds.map((id, index) => ({
      id,
      title: id,
      file: planPaths[index]!,
      status: "InProgress",
    })),
    coordination: {
      coordinator: { session_id: sessionId, session_file: envelopePath, bound_at: "2026-09-16T00:00:00.000Z" },
    },
  });
  writeFileSync(
    join(iterationDir, "delivery-compass.md"),
    [
      "---",
      `iteration_id: ${workflowId}`,
      "start_date: 2026-09-16",
      "status: locked",
      "iteration_base_branch: main",
      `spec_integration_branch: ${integrationBranch}`,
      "target_branch: main",
      `integration_worktree_path: ${integration}`,
      "plans:",
      ...planIds.map((id) => `  - ${id}`),
      "---",
      "",
      "# Fixture compass",
      "",
    ].join("\n"),
  );
  writeRegister(harness, [siblingId, workflowId]);

  const input: Phase1CompletionInput = {
    workflowId,
    coordinatorSessionPath: envelopePath,
    mainWorktreeBranch: "main",
    reviews: [
      { role: "product-manager", agentId: "fixture-pm-agent", resultRef: "agent://fixture-pm-agent", reportPath: reportPaths[0]! },
      {
        role: "architect",
        agentId: "fixture-architect-agent",
        resultRef: "agent://fixture-architect-agent",
        reportPath: reportPaths[1]!,
      },
      {
        role: "writing-specialist",
        agentId: "fixture-writer-agent",
        resultRef: "artifact://fixture-writer-agent",
        reportPath: reportPaths[2]!,
      },
    ],
    plans: planIds.map((id, index) => ({
      planId: id,
      planPath: planPaths[index]!,
      prepareEvidencePath: evidencePaths[index]!,
    })),
  };

  return { root, main, harness, integration, integrationBranch, workflowId, siblingId, sessionId, planIds, reportPaths, binding, input };
}

function writeRegister(harness: string, ids: readonly string[], dirs: Record<string, string> = {}): void {
  writeJson(join(harness, "status.json"), {
    version: 2,
    updated_at: "2026-09-16",
    workflows: ids.map((id) => ({ id, type: "iteration", started_at: "2026-09-16", dir: dirs[id] ?? `workflows/${id}` })),
  });
}

function snapshotPathOf(fixture: Fixture): string {
  return join(fixture.harness, "workflows", fixture.workflowId, "snapshot.json");
}

function compassPathOf(fixture: Fixture): string {
  return join(fixture.harness, "iterations", fixture.workflowId, "delivery-compass.md");
}

/** The module derives refusal paths canonically (`realpath` of the nearest existing ancestor). */
function canonicalize(path: string): string {
  return realpathSync(dirname(path)) === dirname(path) ? path : join(realpathSync(dirname(path)), basename(path));
}

function patchSnapshot(fixture: Fixture, patch: Record<string, unknown>): void {
  const path = snapshotPathOf(fixture);
  const doc = JSON.parse(text(path)) as Record<string, unknown>;
  writeJson(path, { ...doc, ...patch });
}

/** Replace one compass frontmatter line, matched by its key. */
function setCompassField(fixture: Fixture, key: string, value: string): void {
  const path = compassPathOf(fixture);
  const body = text(path);
  const pattern = new RegExp(`^${key}: .*$`, "mu");
  if (!pattern.test(body)) throw new Error(`fixture compass has no ${key}`);
  writeFileSync(path, body.replace(pattern, `${key}: ${value}`));
}

/** Point both documents at one integration checkout path (anchors stay in agreement). */
function setIntegrationPath(fixture: Fixture, path: string): void {
  patchSnapshot(fixture, { integration_worktree_path: path });
  setCompassField(fixture, "integration_worktree_path", path);
}

describe("E1 explicit binding", () => {
  test("explicit binding ignores sibling workflow", async () => {
    const f = await buildFixture();
    const registerPath = join(f.harness, "status.json");
    const registerBefore = text(registerPath);
    const workflowsBefore = readdirSync(join(f.harness, "workflows")).sort();

    const result = await reserveHandoffBinding(
      { workflowId: "fixture-later-iteration", entry: "iteration-loop", intent: "new-iteration", authority: "coordinator" },
      { sessionId: f.sessionId, cwd: f.main, taskSession: false },
      "reserve",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    const realHarness = realpathSync(f.harness);
    expect(result.binding.workflowId).toBe("fixture-later-iteration");
    expect(result.binding.sessionId).toBe(f.sessionId);
    expect(result.binding.controlRoot).toBe(realpathSync(f.main));
    expect(result.binding.harnessRoot).toBe(realHarness);
    expect(result.binding.snapshotPath).toBe(join(realHarness, "workflows", "fixture-later-iteration", "snapshot.json"));
    expect(result.binding.compassPath).toBe(join(realHarness, "iterations", "fixture-later-iteration", "delivery-compass.md"));

    // The sibling active iteration and the register are untouched: reserving writes nothing.
    expect(text(registerPath)).toBe(registerBefore);
    expect(readdirSync(join(f.harness, "workflows")).sort()).toEqual(workflowsBefore);

    // A symlink alias of the main checkout is the same checkout.
    const alias = join(f.root, "main-alias");
    symlinkSync(f.main, alias);
    const viaAlias = await reserveHandoffBinding(
      { workflowId: "fixture-alias-iteration", entry: "skill-start", intent: "new-iteration", authority: "coordinator" },
      { sessionId: f.sessionId, cwd: alias, taskSession: false },
      "reserve",
    );
    expect(viaAlias.ok).toBe(true);
    if (!viaAlias.ok) throw new Error(`${viaAlias.code}: ${viaAlias.message}`);
    expect(viaAlias.binding.controlRoot).toBe(result.binding.controlRoot);

    // A linked worktree — even one nested inside the main checkout — is not the
    // main checkout, so the coordinator cannot run there.
    const linked = await reserveHandoffBinding(
      { workflowId: "fixture-linked-iteration", entry: "iteration-start", intent: "new-iteration", authority: "coordinator" },
      { sessionId: f.sessionId, cwd: f.integration, taskSession: false },
      "reserve",
    );
    expect(linked.ok).toBe(false);
    if (linked.ok) throw new Error("a linked worktree must not host the coordinator");
    expect(linked.code).toBe("invalid-root");
  });

  test("new reservation refuses existing artifacts", async () => {
    const f = await buildFixture();
    const host = { sessionId: f.sessionId, cwd: f.main, taskSession: false };
    const attempt = (input: Record<string, unknown>, hostOverride: Record<string, unknown> = host) =>
      reserveHandoffBinding(
        input as unknown as HandoffBindingInput,
        hostOverride as unknown as Parameters<typeof reserveHandoffBinding>[1],
        "reserve",
      );
    const start = (workflowId: string) => ({ workflowId, entry: "iteration-start", intent: "new-iteration", authority: "coordinator" });

    // Registered id, an id with snapshot+compass that is not registered, and an
    // id with only a compass are all already-bound: nothing is adopted.
    const registered = await attempt(start(f.siblingId));
    expect(registered.ok).toBe(false);
    if (registered.ok) throw new Error("a registered workflow must not be re-reserved");
    expect(registered.code).toBe("already-bound");

    mkdirSync(join(f.harness, "workflows", "fixture-orphan"), { recursive: true });
    writeJson(join(f.harness, "workflows", "fixture-orphan", "snapshot.json"), { schema_version: 1, id: "fixture-orphan" });
    mkdirSync(join(f.harness, "iterations", "fixture-orphan"), { recursive: true });
    writeFileSync(join(f.harness, "iterations", "fixture-orphan", "delivery-compass.md"), "---\n---\n");
    const orphan = await attempt(start("fixture-orphan"));
    expect(orphan.ok).toBe(false);
    if (orphan.ok) throw new Error("existing artifacts must not be adopted");
    expect(orphan.code).toBe("already-bound");

    mkdirSync(join(f.harness, "iterations", "fixture-compass-only"), { recursive: true });
    writeFileSync(join(f.harness, "iterations", "fixture-compass-only", "delivery-compass.md"), "---\n---\n");
    const compassOnly = await attempt(start("fixture-compass-only"));
    expect(compassOnly.ok).toBe(false);
    if (compassOnly.ok) throw new Error("an existing compass must not be adopted");
    expect(compassOnly.code).toBe("already-bound");

    // Unsafe ids never become path segments; `-` and a dotted id are safe
    // single components and still bind.
    for (const workflowId of ["", ".", "..", "a/b", "../escape", "with space", "trailing\\", "ok-id_9.1", "-"]) {
      const result = await attempt(start(workflowId));
      if (workflowId === "ok-id_9.1" || workflowId === "-") {
        expect(result.ok).toBe(true);
        continue;
      }
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`${workflowId} must not bind`);
      expect(result.code).toBe("invalid-workflow");
    }

    // Trusted-assertion and host-fact refusals.
    const wrongAuthority = await attempt({ ...start("fixture-other"), authority: "leaf" });
    expect(wrongAuthority.ok === false && wrongAuthority.code).toBe("not-coordinator");
    const wrongIntent = await attempt({ ...start("fixture-other"), intent: "resume" });
    expect(wrongIntent.ok === false && wrongIntent.code).toBe("not-coordinator");
    const wrongEntry = await attempt({ ...start("fixture-other"), entry: "iteration-drive" });
    expect(wrongEntry.ok === false && wrongEntry.code).toBe("not-coordinator");
    const taskSession = await attempt(start("fixture-other"), { ...host, taskSession: true });
    expect(taskSession.ok === false && taskSession.code).toBe("not-coordinator");
    const noSession = await attempt(start("fixture-other"), { ...host, sessionId: "" });
    expect(noSession.ok === false && noSession.code).toBe("not-coordinator");

    // Root facts: not a repository, a relative cwd, a corrupt register and a
    // v1-shaped register all refuse.
    const noRepo = await attempt(start("fixture-other"), { ...host, cwd: scratchDir() });
    expect(noRepo.ok === false && noRepo.code).toBe("invalid-root");
    const relative = await attempt(start("fixture-other"), { ...host, cwd: "main" });
    expect(relative.ok === false && relative.code).toBe("invalid-root");
    const registerPath = join(f.harness, "status.json");
    const goodRegister = text(registerPath);
    writeFileSync(registerPath, "{ not json\n");
    const corrupt = await attempt(start("fixture-other"));
    expect(corrupt.ok === false && corrupt.code).toBe("invalid-root");
    writeJson(registerPath, { version: 1, plans: [] });
    const v1Register = await attempt(start("fixture-other"));
    expect(v1Register.ok === false && v1Register.code).toBe("invalid-root");

    // An absent register permits the session reservation only.
    unlinkSync(registerPath);
    const absent = await attempt(start("fixture-registerless"));
    expect(absent.ok).toBe(true);
    writeFileSync(registerPath, goodRegister);

    // The three unregistered-path refusal message templates stay byte-identical.
    const registerHit = await attempt(start(f.siblingId));
    expect(registerHit.ok === false && registerHit.message).toBe(
      `workflow ${f.siblingId} is already registered in the root register — a new start never adopts it`,
    );
    const snapshotHit = await attempt(start("fixture-orphan"));
    expect(snapshotHit.ok === false && snapshotHit.message).toBe(
      `a workflow snapshot already exists at ${canonicalize(join(f.harness, "workflows", "fixture-orphan", "snapshot.json"))}`,
    );
    const compassHit = await attempt(start("fixture-compass-only"));
    expect(compassHit.ok === false && compassHit.message).toBe(
      `an iteration compass already exists at ${canonicalize(join(f.harness, "iterations", "fixture-compass-only", "delivery-compass.md"))}`,
    );
  });
});

describe("E1 registered attachment (attach mode)", () => {
  const attach = (f: Fixture, workflowId = f.workflowId) =>
    reserveHandoffBinding(
      { workflowId, entry: "iteration-start", intent: "new-iteration", authority: "coordinator" },
      { sessionId: f.sessionId, cwd: f.main, taskSession: false },
      "attach",
    );

  test("a genuinely registered workflow with its own snapshot returns a structural candidate", async () => {
    const f = await buildFixture();
    // Control: the same state still refuses in reserve mode.
    const reserve = await reserveHandoffBinding(
      { workflowId: f.workflowId, entry: "iteration-start", intent: "new-iteration", authority: "coordinator" },
      { sessionId: f.sessionId, cwd: f.main, taskSession: false },
      "reserve",
    );
    expect(reserve.ok).toBe(false);
    if (!reserve.ok) expect(reserve.code).toBe("already-bound");

    const realHarness = realpathSync(f.harness);
    const registerPath = join(f.harness, "status.json");
    const registerBefore = text(registerPath);
    const result = await attach(f);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    expect(result.binding.workflowId).toBe(f.workflowId);
    expect(result.binding.sessionId).toBe(f.sessionId);
    expect(result.binding.controlRoot).toBe(realpathSync(f.main));
    expect(result.binding.harnessRoot).toBe(realHarness);
    expect(result.binding.snapshotPath).toBe(realpathSync(snapshotPathOf(f)));
    expect(result.binding.compassPath).toBe(join(realHarness, "iterations", f.workflowId, "delivery-compass.md"));

    // Attachment is structural: nothing is written and no artifact moves.
    expect(text(registerPath)).toBe(registerBefore);
    expect(statSync(snapshotPathOf(f)).isFile()).toBe(true);
    expect(statSync(compassPathOf(f)).isFile()).toBe(true);
  });

  test("attach refuses invalid-root on absent or mismatched registration", async () => {
    const f = await buildFixture();
    const registerPath = join(f.harness, "status.json");

    // The row names another workflow directory: wrong canonical snapshot path.
    writeRegister(f.harness, [f.siblingId, f.workflowId], { [f.workflowId]: `workflows/${f.siblingId}` });
    const mismatched = await attach(f);
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.code).toBe("invalid-root");

    // The named row is gone from a valid register.
    writeRegister(f.harness, [f.siblingId]);
    const unregistered = await attach(f);
    expect(unregistered.ok).toBe(false);
    if (!unregistered.ok) expect(unregistered.code).toBe("invalid-root");

    // The register itself is absent: attachment always requires registration.
    unlinkSync(registerPath);
    const noRegister = await attach(f);
    expect(noRegister.ok).toBe(false);
    if (!noRegister.ok) expect(noRegister.code).toBe("invalid-root");
  });

  test("attach refuses invalid-root on a missing or mismatched own snapshot", async () => {
    const f = await buildFixture();

    // The registered snapshot vanished.
    const snapshotPath = snapshotPathOf(f);
    const bytes = text(snapshotPath);
    unlinkSync(snapshotPath);
    const vanished = await attach(f);
    expect(vanished.ok).toBe(false);
    if (!vanished.ok) expect(vanished.code).toBe("invalid-root");

    // The snapshot exists but names another workflow.
    writeJson(snapshotPath, { ...JSON.parse(bytes), id: f.siblingId });
    const mismatchedId = await attach(f);
    expect(mismatchedId.ok).toBe(false);
    if (!mismatchedId.ok) expect(mismatchedId.code).toBe("invalid-root");

    // Restore: the same state attaches again.
    writeJson(snapshotPath, JSON.parse(bytes));
    const restored = await attach(f);
    expect(restored.ok).toBe(true);
  });

  test("attach refuses invalid-root on a terminal or non-iteration workflow snapshot", async () => {
    const f = await buildFixture();
    const snapshotPath = snapshotPathOf(f);
    const bytes = JSON.parse(text(snapshotPath));

    // Terminal status: attach never adopts a completed workflow. The register
    // gate already refuses a terminal-listed snapshot (removal-at-terminal),
    // so only the frozen refusal code is asserted here; the attach-side
    // running-iteration check is the second, defense-in-depth layer.
    writeJson(snapshotPath, { ...bytes, status: "completed" });
    const completed = await attach(f);
    expect(completed.ok === false && completed.code).toBe("invalid-root");

    // Non-iteration type: a plan workflow is not attachable (the register
    // cross-check refuses the mismatched type the same way).
    writeJson(snapshotPath, { ...bytes, type: "plan" });
    const plan = await attach(f);
    expect(plan.ok === false && plan.code).toBe("invalid-root");

    // A register-valid non-running status (paused) passes the register gate
    // and must be refused by the attach-side eligibility check itself.
    writeJson(snapshotPath, { ...bytes, status: "paused" });
    const paused = await attach(f);
    expect(paused.ok === false && paused.code).toBe("invalid-root");
    if (!paused.ok) {
      expect(paused.message).toBe(
        `workflow ${f.workflowId} snapshot at ${canonicalize(snapshotPath)} is not a running iteration (status paused, type iteration)`,
      );
    }

    // Restore: the same state attaches again.
    writeJson(snapshotPath, bytes);
    const restored = await attach(f);
    expect(restored.ok).toBe(true);
  });

  test("attach still honors the shared input and host refusals", async () => {
    const f = await buildFixture();
    const wrongAuthority = await reserveHandoffBinding(
      { workflowId: f.workflowId, entry: "iteration-start", intent: "new-iteration", authority: "leaf" },
      { sessionId: f.sessionId, cwd: f.main, taskSession: false },
      "attach",
    );
    expect(wrongAuthority.ok === false && wrongAuthority.code).toBe("not-coordinator");
    const linked = await reserveHandoffBinding(
      { workflowId: f.workflowId, entry: "iteration-start", intent: "new-iteration", authority: "coordinator" },
      { sessionId: f.sessionId, cwd: f.integration, taskSession: false },
      "attach",
    );
    expect(linked.ok === false && linked.code).toBe("invalid-root");
  });
});

describe("E2 phase 1 readiness", () => {
  test("structured completion receipt validates current files", async () => {
    const f = await buildFixture({ planIds: ["fixture-plan-a", "fixture-plan-b"] });
    const readiness = await inspectPhase1Readiness(f.binding, f.input);
    expect(readiness.ready).toBe(true);
    if (!readiness.ready) throw new Error(`unexpected refusal: ${readiness.codes.join(", ")}`);

    expect(readiness.integrationHead).toBe(git(["rev-parse", "HEAD"], f.integration));
    expect(readiness.receipt.input).toBe(f.input);
    expect(readiness.receipt.binding).toBe(f.binding);

    const versions = new Map(readiness.receipt.artifactVersions.map((entry) => [entry.path, entry.version]));
    const named = [
      ...f.reportPaths,
      ...f.planIds.map((id) => join(f.harness, "plans", `${id}.md`)),
      ...f.planIds.map((id) => join(f.harness, "iterations", f.workflowId, "guides", `${id}-prepare.md`)),
      snapshotPathOf(f),
      compassPathOf(f),
      join(f.harness, "workflows", f.workflowId, "sessions", `${f.sessionId}.json`),
      join(f.harness, "status.json"),
    ];
    for (const path of named) expect(versions.get(realpathSync(path))).toBe(sha256(path));
    expect(versions.size).toBe(named.length);

    // Readiness is derived from the current bytes rather than a stored literal:
    // an edit made before the call is simply the new current state.
    const report = f.reportPaths[0]!;
    const before = versions.get(realpathSync(report))!;
    writeFileSync(report, `${text(report)}extra line\n`);
    const again = await inspectPhase1Readiness(f.binding, f.input);
    expect(again.ready).toBe(true);
    if (!again.ready) throw new Error(`unexpected refusal: ${again.codes.join(", ")}`);
    const after = new Map(again.receipt.artifactVersions.map((entry) => [entry.path, entry.version])).get(realpathSync(report));
    expect(after).not.toBe(before);
    expect(after).toBe(sha256(report));
  });

  test("missing review or prepare proof refuses", async () => {
    const f = await buildFixture({ planIds: ["fixture-plan-a", "fixture-plan-b"] });
    const [pm, architect, writer] = f.input.reviews;
    const inspect = (input: Phase1CompletionInput) => inspectPhase1Readiness(f.binding, input);

    // Baseline: the untouched fixture is ready, so each refusal below is caused
    // by the mutated input or artifact rather than by an inspector that never
    // says yes.
    expect((await inspect(f.input)).ready).toBe(true);

    // Duplicate return tuple.
    const duplicate = { ...f.input, reviews: [pm, { ...pm }, writer] } as unknown as Phase1CompletionInput;
    expect(codesOf(await inspect(duplicate))).toContain("review-evidence-missing");

    // Out-of-order return.
    const reordered = { ...f.input, reviews: [architect, pm, writer] } as unknown as Phase1CompletionInput;
    expect(codesOf(await inspect(reordered))).toContain("review-evidence-missing");

    // A return belonging to another workflow.
    const wrongWorkflow = { ...f.input, workflowId: f.siblingId } as Phase1CompletionInput;
    expect(codesOf(await inspect(wrongWorkflow))).toContain("binding-invalid");

    // A boolean-ish reference is not a native completion reference.
    const fakeRef = {
      ...f.input,
      reviews: [pm, architect, { ...writer, resultRef: "ready" }],
    } as unknown as Phase1CompletionInput;
    expect(codesOf(await inspect(fakeRef))).toContain("review-evidence-missing");

    // Missing report copy and a report outside this iteration's area.
    const outside = join(f.root, "outside-return.md");
    writeFileSync(outside, "not an iteration guide\n");
    const escaping = {
      ...f.input,
      reviews: [pm, architect, { ...writer, reportPath: outside }],
    } as unknown as Phase1CompletionInput;
    expect(codesOf(await inspect(escaping))).toContain("review-evidence-missing");
    const absent = {
      ...f.input,
      reviews: [pm, architect, { ...writer, reportPath: join(dirname(writer.reportPath), "missing-return.md") }],
    } as unknown as Phase1CompletionInput;
    expect(codesOf(await inspect(absent))).toContain("review-evidence-missing");

    // Plan set: incomplete, duplicated and foreign rows, a plan path that names
    // another plan's file, and Prepare evidence outside the resolved areas.
    expect(codesOf(await inspect({ ...f.input, plans: f.input.plans.slice(1) }))).toContain("prepare-not-locked");
    expect(codesOf(await inspect({ ...f.input, plans: [f.input.plans[0]!, f.input.plans[0]!] }))).toContain("prepare-not-locked");
    expect(
      codesOf(
        await inspect({
          ...f.input,
          plans: [...f.input.plans.slice(1), { planId: "fixture-foreign", planPath: f.input.plans[0]!.planPath, prepareEvidencePath: f.input.plans[0]!.prepareEvidencePath }],
        }),
      ),
    ).toContain("prepare-not-locked");
    expect(
      codesOf(
        await inspect({
          ...f.input,
          plans: [{ ...f.input.plans[0]!, planPath: f.input.plans[1]!.planPath }, f.input.plans[1]!],
        }),
      ),
    ).toContain("prepare-not-locked");
    expect(
      codesOf(
        await inspect({
          ...f.input,
          plans: [{ ...f.input.plans[0]!, prepareEvidencePath: outside }, f.input.plans[1]!],
        }),
      ),
    ).toContain("prepare-not-locked");

    // Compass not locked while every artifact is present.
    setCompassField(f, "status", "active");
    const stillActive = await inspect(f.input);
    expect(codesOf(stillActive)).toContain("prepare-not-locked");
    setCompassField(f, "status", "locked");

    // A locked compass with no review or Prepare evidence at all.
    for (const path of f.reportPaths) unlinkSync(path);
    for (const plan of f.input.plans) unlinkSync(plan.prepareEvidencePath);
    const empty = codesOf(await inspect(f.input));
    expect(empty).toContain("review-evidence-missing");
    expect(empty).toContain("prepare-not-locked");
  });

  test("integration checkout and remote tip gate", async () => {
    const refuses = async (code: string, mutate: (fixture: Fixture) => Phase1CompletionInput | void): Promise<void> => {
      const f = await buildFixture();
      // Causality control: the same fixture is ready before the mutation.
      const baseline = await inspectPhase1Readiness(f.binding, f.input);
      expect(baseline.ready).toBe(true);
      const mutated = mutate(f);
      const readiness = await inspectPhase1Readiness(f.binding, mutated ?? f.input);
      expect(readiness.ready).toBe(false);
      expect(codesOf(readiness)).toContain(code);
    };

    // Detached HEAD and a wrong checked-out branch.
    await refuses("branch-mismatch", (f) => {
      git(["checkout", "-q", "--detach"], f.integration);
    });
    await refuses("branch-mismatch", (f) => {
      git(["checkout", "-q", "-b", "side-branch"], f.integration);
    });
    // Main residency: the receipt names a branch the main worktree is not on.
    await refuses("branch-mismatch", (f) => ({ ...f.input, mainWorktreeBranch: "release" }));
    // An integration checkout that does not exist.
    await refuses("worktree-invalid", (f) => {
      setIntegrationPath(f, join(f.root, "missing-worktree"));
    });
    // The control checkout and a symlink alias of it are not distinct checkouts.
    await refuses("worktree-invalid", (f) => {
      setIntegrationPath(f, f.main);
    });
    await refuses("worktree-invalid", (f) => {
      const alias = join(f.root, "control-alias");
      symlinkSync(f.main, alias);
      setIntegrationPath(f, alias);
    });
    // A checkout from another repository.
    await refuses("worktree-invalid", (f) => {
      const other = join(f.root, "other");
      git(["init", "-q", "-b", "main", other], f.root);
      git(["config", "user.email", "fixture@example.invalid"], other);
      git(["config", "user.name", "fixture"], other);
      writeFileSync(join(other, "README.md"), "other\n");
      git(["add", "README.md"], other);
      git(["commit", "-qm", "init"], other);
      setIntegrationPath(f, other);
    });
    // Dirty checkout and an in-progress Git operation.
    await refuses("worktree-invalid", (f) => {
      writeFileSync(join(f.integration, "untracked.txt"), "dirty\n");
    });
    await refuses("worktree-invalid", (f) => {
      const raw = git(["rev-parse", "--git-path", "MERGE_HEAD"], f.integration);
      const mergeHead = isAbsolute(raw) ? raw : join(f.integration, raw);
      mkdirSync(dirname(mergeHead), { recursive: true });
      writeFileSync(mergeHead, "in progress\n");
    });
    // Missing upstream.
    await refuses("push-unverified", (f) => {
      git(["branch", "--unset-upstream"], f.integration);
    });
    // A remote query that fails.
    await refuses("push-unverified", (f) => {
      git(["remote", "set-url", "origin", join(f.root, "missing-remote.git")], f.integration);
    });
    // An unpushed commit: the remote tip no longer equals the live HEAD.
    await refuses("push-unverified", (f) => {
      writeFileSync(join(f.integration, "ahead.txt"), "ahead\n");
      git(["add", "ahead.txt"], f.integration);
      git(["commit", "-qm", "ahead"], f.integration);
    });
    // Snapshot and compass disagree about the integration branch.
    await refuses("binding-invalid", (f) => {
      setCompassField(f, "spec_integration_branch", "iteration/other");
    });
    // The root register drops the named workflow.
    await refuses("binding-invalid", (f) => {
      writeRegister(f.harness, [f.siblingId]);
    });
  }, 30_000);

  test("a binding for a foreign workflow refuses", async () => {
    const f = await buildFixture();
    expect((await inspectPhase1Readiness(f.binding, f.input)).ready).toBe(true);

    // Paths are re-derived from the Git control root, so a binding whose
    // snapshot path does not follow from the bound workflow id refuses before
    // any artifact read — another workflow's artifacts are never adopted.
    const foreignSnapshot = {
      ...f.binding,
      snapshotPath: join(f.harness, "workflows", f.siblingId, "snapshot.json"),
    } as HandoffBinding;
    expect(codesOf(await inspectPhase1Readiness(foreignSnapshot, f.input))).toContain("binding-invalid");

    // A relative harness root is not the resolved harness dir.
    const relativeHarness = { ...f.binding, harnessRoot: ".mstar" } as HandoffBinding;
    expect(codesOf(await inspectPhase1Readiness(relativeHarness, f.input))).toContain("binding-invalid");

    // A linked worktree is not the main checkout the binding must come from.
    const featureRoot = { ...f.binding, controlRoot: f.integration } as HandoffBinding;
    expect(codesOf(await inspectPhase1Readiness(featureRoot, f.input))).toContain("binding-invalid");
  });

  test("the host session id must equal the engine coordinator and envelope identities", async () => {
    const f = await buildFixture();

    // The association this plan makes reachable: `plan bind` adopts the id the
    // extension injects, so the binding's *host* id, the snapshot's
    // `coordination.coordinator.session_id` and the coordinator envelope's
    // `session_id` are one identifier — and readiness is ready on exactly that.
    const coordinatorOf = (): Record<string, unknown> => {
      const doc = JSON.parse(text(snapshotPathOf(f))) as {
        coordination: { coordinator: Record<string, unknown> };
      };
      return doc.coordination.coordinator;
    };
    const envelopeOf = (): Record<string, unknown> =>
      JSON.parse(text(f.input.coordinatorSessionPath)) as Record<string, unknown>;
    const setCoordinator = (patch: Record<string, unknown>): void => {
      const path = snapshotPathOf(f);
      const doc = JSON.parse(text(path)) as { coordination: { coordinator: Record<string, unknown> } };
      writeJson(path, {
        ...doc,
        coordination: { ...doc.coordination, coordinator: { ...doc.coordination.coordinator, ...patch } },
      });
    };
    const setEnvelope = (patch: Record<string, unknown>): void => {
      writeJson(f.input.coordinatorSessionPath, { ...envelopeOf(), ...patch });
    };

    expect(coordinatorOf().session_id).toBe(f.binding.sessionId);
    expect(realpathSync(String(coordinatorOf().session_file))).toBe(realpathSync(f.input.coordinatorSessionPath));
    expect(envelopeOf().session_id).toBe(f.binding.sessionId);
    expect((await inspectPhase1Readiness(f.binding, f.input)).ready).toBe(true);

    // A host id that is not the engine's coordinator id refuses: a foreign
    // coordinator is never adopted by a matching envelope alone.
    const foreignHost = { ...f.binding, sessionId: "someone-else-session" } as HandoffBinding;
    expect(codesOf(await inspectPhase1Readiness(foreignHost, f.input))).toContain("binding-invalid");

    // The snapshot naming another coordinator refuses.
    setCoordinator({ session_id: "someone-else-session" });
    expect(codesOf(await inspectPhase1Readiness(f.binding, f.input))).toContain("binding-invalid");
    setCoordinator({ session_id: f.sessionId });

    // The envelope naming another session refuses — the same comparison on the
    // envelope's own `session_id`, not only on the snapshot's copy.
    setEnvelope({ session_id: "someone-else-session" });
    expect(codesOf(await inspectPhase1Readiness(f.binding, f.input))).toContain("binding-invalid");
    setEnvelope({ session_id: f.sessionId });

    // Restoring both identities returns the checkpoint to ready, so the two
    // refusals above are attributable to the identity equality and not to a
    // fixture that could never pass.
    expect((await inspectPhase1Readiness(f.binding, f.input)).ready).toBe(true);
  }, 30_000);

  test("a binding whose paths leave the derived workflow is refused before any artifact read", async () => {
    const f = await buildFixture();
    expect((await inspectPhase1Readiness(f.binding, f.input)).ready).toBe(true);

    // A complete, register-consistent copy of this workflow at a location the
    // binding may not name. It references the same coordinator envelope,
    // integration checkout, plan files, Prepare evidence and review copies, so
    // the refusal below is about *which paths may be opened*, not about the
    // content being wrong.
    const decoyWorkflowDir = join(f.harness, "decoy", "workflows", f.workflowId);
    const decoyIterationDir = join(f.harness, "decoy", "iterations", f.workflowId);
    mkdirSync(decoyWorkflowDir, { recursive: true });
    mkdirSync(decoyIterationDir, { recursive: true });
    const decoySnapshotPath = join(decoyWorkflowDir, "snapshot.json");
    const decoyCompassPath = join(decoyIterationDir, "delivery-compass.md");
    const realSnapshot = JSON.parse(text(snapshotPathOf(f))) as Record<string, unknown>;
    writeJson(decoySnapshotPath, { ...realSnapshot, compass_ref: `decoy/iterations/${f.workflowId}/delivery-compass.md` });
    writeFileSync(decoyCompassPath, text(compassPathOf(f)));
    // The register is made to agree with the decoy, so the register-agreement
    // check alone cannot be what rejects the foreign binding.
    writeRegister(f.harness, [f.siblingId, f.workflowId], { [f.workflowId]: `decoy/workflows/${f.workflowId}` });

    // Read-boundary sentinels: the two bound artifact paths the binding names
    // and the root register. Each is aged explicitly (`relatime` only refreshes
    // an atime older than the file's mtime), and a twin file read by this test
    // proves that a read really shows up as an atime change here — so the
    // "unchanged atime" assertions below cannot pass vacuously.
    const twin = join(f.root, "atime-control.txt");
    writeFileSync(twin, "control\n");
    const registerPath = join(f.harness, "status.json");
    const sentinels = [decoySnapshotPath, decoyCompassPath, registerPath];
    for (const path of [...sentinels, twin]) ageAtime(path);
    const before = new Map(sentinels.map((path) => [path, atimeOf(path)]));
    const controlBefore = atimeOf(twin);
    expect(readFileSync(twin, "utf8")).toBe("control\n");
    expect(atimeOf(twin)).toBeGreaterThan(controlBefore);

    const foreign = { ...f.binding, snapshotPath: decoySnapshotPath, compassPath: decoyCompassPath } as HandoffBinding;
    const readiness = await inspectPhase1Readiness(foreign, f.input);
    expect(codesOf(readiness)).toEqual(["binding-invalid"]);
    for (const path of sentinels) expect(atimeOf(path)).toBe(before.get(path));

    // The sentinel really was a complete alternative tree.
    const decoy = JSON.parse(text(decoySnapshotPath)) as Record<string, unknown>;
    expect(decoy.id).toBe(f.workflowId);
    expect({ ...decoy, compass_ref: realSnapshot.compass_ref }).toEqual(realSnapshot);
    const register = JSON.parse(text(registerPath)) as { workflows: { id: string; dir: string }[] };
    expect(register.workflows.find((row) => row.id === f.workflowId)?.dir).toBe(`decoy/workflows/${f.workflowId}`);
  });

  test("changed evidence refuses", async () => {
    const f = await buildFixture();
    const baseline = await inspectPhase1Readiness(f.binding, f.input);
    expect(baseline.ready).toBe(true);
    if (!baseline.ready) throw new Error(`unexpected refusal: ${baseline.codes.join(", ")}`);
    const report = f.reportPaths[0]!;
    const versioned = baseline.receipt.artifactVersions.find((entry) => entry.path === realpathSync(report));
    expect(versioned).toBeDefined();

    // Deterministic mutation window: the Git transport runs this wrapper during
    // the checkpoint's own read-only `ls-remote` probe, so the sampled bytes
    // change after they were first read and before the final re-sample.
    const wrapper = join(f.root, "mutating-upload-pack.sh");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nprintf 'mutated during the push probe\\n' >> ${JSON.stringify(report)}\nexec "$(git --exec-path)/git-upload-pack" "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    git(["config", "remote.origin.uploadpack", wrapper], f.integration);

    const changed = await inspectPhase1Readiness(f.binding, f.input);
    expect(changed.ready).toBe(false);
    expect(codesOf(changed)).toContain("evidence-changed");
    // The mutation really landed inside the check window.
    expect(sha256(report)).not.toBe(versioned!.version);

    // Freshness is re-derivation, not a latch: with the wrapper removed the new
    // current bytes are validated afresh.
    git(["config", "--unset", "remote.origin.uploadpack"], f.integration);
    const recovered = await inspectPhase1Readiness(f.binding, f.input);
    expect(recovered.ready).toBe(true);
    if (!recovered.ready) throw new Error(`unexpected refusal: ${recovered.codes.join(", ")}`);
    expect(recovered.receipt.artifactVersions.find((entry) => entry.path === realpathSync(report))?.version).toBe(sha256(report));
  });

  test("a symlink retargeted inside the checkpoint window refuses", async () => {
    const f = await buildFixture();
    const guides = join(f.harness, "iterations", f.workflowId, "guides");
    const link = join(guides, "pm-return-link.md");
    const firstTarget = join(guides, "pm-return-payload.md");
    writeFileSync(firstTarget, "linked payload\n");
    symlinkSync(firstTarget, link);
    const linkedInput = {
      ...f.input,
      reviews: [{ ...f.input.reviews[0]!, reportPath: link }, f.input.reviews[1]!, f.input.reviews[2]!],
    } as unknown as Phase1CompletionInput;

    const baseline = await inspectPhase1Readiness(f.binding, linkedInput);
    expect(baseline.ready).toBe(true);
    if (!baseline.ready) throw new Error(`unexpected refusal: ${baseline.codes.join(", ")}`);
    expect(baseline.receipt.artifactVersions.some((entry) => entry.path === realpathSync(link))).toBe(true);

    // Same deterministic window as above, but the wrapper retargets the
    // symlink instead of rewriting a file: the logical name keeps resolving to
    // a regular file the old byte-hash-only re-sample would never notice.
    const retarget = async (destination: string): Promise<Phase1Readiness> => {
      const wrapper = join(f.root, `retarget-${basename(destination)}.sh`);
      writeFileSync(
        wrapper,
        `#!/bin/sh\nln -sfn ${JSON.stringify(destination)} ${JSON.stringify(link)}\nexec "$(git --exec-path)/git-upload-pack" "$@"\n`,
      );
      chmodSync(wrapper, 0o755);
      git(["config", "remote.origin.uploadpack", wrapper], f.integration);
      const readiness = await inspectPhase1Readiness(f.binding, linkedInput);
      git(["config", "--unset", "remote.origin.uploadpack"], f.integration);
      return readiness;
    };

    // Retargeted to another legitimate file of the same iteration area.
    const otherPayload = join(guides, "other-payload.md");
    writeFileSync(otherPayload, "another legitimate payload\n");
    const inRepo = await retarget(otherPayload);
    expect(inRepo.ready).toBe(false);
    expect(codesOf(inRepo)).toContain("evidence-changed");
    expect(realpathSync(link)).toBe(realpathSync(otherPayload));

    // Retargeted outside this iteration's area: the containment class applies.
    const outside = join(f.root, "outside-return.md");
    writeFileSync(outside, "outside the iteration area\n");
    const escaped = await retarget(outside);
    expect(escaped.ready).toBe(false);
    expect(codesOf(escaped)).toContain("review-evidence-missing");
    expect(realpathSync(link)).toBe(realpathSync(outside));
  });

  test("relative snapshot paths resolve against the harness root, never the process cwd", async () => {
    const f = await buildFixture();

    // The fixture's snapshot stores an absolute plan file and the engine's own
    // relative `compass_ref`; the process cwd is a different tree from the
    // harness, so a cwd-based resolution could not pass this control.
    expect(process.cwd() === f.harness || process.cwd().startsWith(`${f.harness}/`)).toBe(false);
    const control = await inspectPhase1Readiness(f.binding, f.input);
    expect(control.ready).toBe(true);
    if (!control.ready) throw new Error(`unexpected refusal: ${control.codes.join(", ")}`);

    // Snapshot pointer values are harness-root relative by the engine's own
    // convention (`snapshot.compass_ref` must be relative and resolves against
    // the harness root with containment; `plans[].file` is stored the same way).
    // Rewriting the registered plan row to a harness-relative value must stay
    // ready, from a cwd that is not the harness root.
    const snapshot = JSON.parse(text(snapshotPathOf(f))) as { plans: Record<string, unknown>[] };
    const planId = f.planIds[0]!;
    writeJson(snapshotPathOf(f), {
      ...snapshot,
      plans: snapshot.plans.map((row) => ({ ...row, file: join("plans", `${planId}.md`) })),
    });
    const relative = await inspectPhase1Readiness(f.binding, f.input);
    expect(relative.ready).toBe(true);
    if (!relative.ready) throw new Error(`unexpected refusal: ${relative.codes.join(", ")}`);

    // A relative value that leaves the harness root is refused even when the
    // receipt names that escaped path: relative resolution is a *base*, not a
    // blanket acceptance, and containment still decides.
    const outsidePlans = join(f.main, "outside-plans");
    mkdirSync(outsidePlans, { recursive: true });
    const escapedPlan = join(outsidePlans, "escaped.md");
    writeFileSync(escapedPlan, "# escaped plan\n");
    const escapedInput = {
      ...f.input,
      plans: [{ ...f.input.plans[0]!, planPath: escapedPlan }],
    } as unknown as Phase1CompletionInput;
    const escapedSnapshot = JSON.parse(text(snapshotPathOf(f))) as { plans: Record<string, unknown>[] };
    writeJson(snapshotPathOf(f), {
      ...escapedSnapshot,
      plans: escapedSnapshot.plans.map((row) => ({ ...row, file: join("..", "outside-plans", "escaped.md") })),
    });
    const escapedRelative = await inspectPhase1Readiness(f.binding, escapedInput);
    expect(escapedRelative.ready).toBe(false);
    expect(codesOf(escapedRelative)).toContain("prepare-not-locked");

    // The same escaped target named absolutely is refused identically: absolute
    // values are taken as written and containment decides.
    const absoluteSnapshot = JSON.parse(text(snapshotPathOf(f))) as { plans: Record<string, unknown>[] };
    writeJson(snapshotPathOf(f), {
      ...absoluteSnapshot,
      plans: absoluteSnapshot.plans.map((row) => ({ ...row, file: escapedPlan })),
    });
    const escapedAbsolute = await inspectPhase1Readiness(f.binding, escapedInput);
    expect(escapedAbsolute.ready).toBe(false);
    expect(codesOf(escapedAbsolute)).toContain("prepare-not-locked");
  }, 60_000);

  test("an absolute compass reference still validates", async () => {
    const f = await buildFixture();

    // `snapshot.compass_ref` is canonically relative; an absolute pointer that
    // resolves to exactly the bound compass is still accepted (the identity
    // check is what decides, not the textual form).
    patchSnapshot(f, { compass_ref: compassPathOf(f) });
    const readiness = await inspectPhase1Readiness(f.binding, f.input);
    expect(readiness.ready).toBe(true);

    // An absolute pointer to a different file is refused.
    patchSnapshot(f, { compass_ref: join(f.root, "elsewhere-compass.md") });
    const other = await inspectPhase1Readiness(f.binding, f.input);
    expect(other.ready).toBe(false);
    expect(codesOf(other)).toContain("binding-invalid");
  }, 60_000);

  test("a remote advanced inside the checkpoint window refuses", async () => {
    const f = await buildFixture();
    const baseline = await inspectPhase1Readiness(f.binding, f.input);
    expect(baseline.ready).toBe(true);
    if (!baseline.ready) throw new Error(`unexpected refusal: ${baseline.codes.join(", ")}`);

    // A side commit that exists only in the bare remote: the transport wrapper
    // advances `snapshot.branch.integration` to it on the checkpoint's *second*
    // remote query — after the first one already matched the live HEAD — so the
    // advance lands strictly inside the window the closing re-sample must cover.
    const bare = join(f.root, "remote.git");
    writeFileSync(join(f.main, "advance.txt"), "advance\n");
    git(["add", "advance.txt"], f.main);
    git(["commit", "-qm", "advance"], f.main);
    const advanceSha = git(["rev-parse", "HEAD"], f.main);
    git(["push", "-q", bare, `${advanceSha}:refs/heads/advance`], f.main);

    const counter = join(f.root, "upload-pack-calls");
    const wrapper = join(f.root, "advancing-upload-pack.sh");
    writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        `if [ -f ${JSON.stringify(counter)} ]; then`,
        `  git -C ${JSON.stringify(bare)} update-ref ${JSON.stringify(`refs/heads/${f.integrationBranch}`)} ${advanceSha}`,
        "else",
        `  : > ${JSON.stringify(counter)}`,
        "fi",
        'exec "$(git --exec-path)/git-upload-pack" "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(wrapper, 0o755);
    git(["config", "remote.origin.uploadpack", wrapper], f.integration);

    const advanced = await inspectPhase1Readiness(f.binding, f.input);
    expect(advanced.ready).toBe(false);
    expect(codesOf(advanced)).toContain("push-unverified");
    // The window really moved the remote (the checkpoint queried it a second
    // time) and the integration checkout itself did not move.
    expect(git(["rev-parse", `refs/heads/${f.integrationBranch}`], bare)).toBe(advanceSha);
    expect(git(["rev-parse", "HEAD"], f.integration)).toBe(baseline.integrationHead);

    // With the wrapper gone the advance is still visible: the push is no longer
    // verified, which is the readable reason behind the refusal code.
    git(["config", "--unset", "remote.origin.uploadpack"], f.integration);
    const stillRefused = await inspectPhase1Readiness(f.binding, f.input);
    expect(stillRefused.ready).toBe(false);
    expect(codesOf(stillRefused)).toContain("push-unverified");
  }, 60_000);
});
