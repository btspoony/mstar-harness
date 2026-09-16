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
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
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
  planPaths.forEach((path, index) => writeFileSync(path, `# ${planIds[index]}\n\nPlan body.\n`));
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

function writeRegister(harness: string, ids: readonly string[]): void {
  writeJson(join(harness, "status.json"), {
    version: 2,
    updated_at: "2026-09-16",
    workflows: ids.map((id) => ({ id, type: "iteration", started_at: "2026-09-16", dir: `workflows/${id}` })),
  });
}

function snapshotPathOf(fixture: Fixture): string {
  return join(fixture.harness, "workflows", fixture.workflowId, "snapshot.json");
}

function compassPathOf(fixture: Fixture): string {
  return join(fixture.harness, "iterations", fixture.workflowId, "delivery-compass.md");
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
    );
    expect(viaAlias.ok).toBe(true);
    if (!viaAlias.ok) throw new Error(`${viaAlias.code}: ${viaAlias.message}`);
    expect(viaAlias.binding.controlRoot).toBe(result.binding.controlRoot);

    // A linked worktree — even one nested inside the main checkout — is not the
    // main checkout, so the coordinator cannot run there.
    const linked = await reserveHandoffBinding(
      { workflowId: "fixture-linked-iteration", entry: "iteration-start", intent: "new-iteration", authority: "coordinator" },
      { sessionId: f.sessionId, cwd: f.integration, taskSession: false },
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
});
