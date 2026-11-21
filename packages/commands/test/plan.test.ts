import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import * as nodeOs from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createExecutionWorkflow,
  executionContextFor,
  getIssue,
  initializeCollaborationStore,
  initializeStore,
  listIssues,
  readExecutionAuthority,
  resolveCollaborationLocation,
} from "@mstar-harness/engine";
import { getCommandDefinitions, getCommandSchemas } from "../src/index.js";
import { getPlanCommandDefinitions } from "../src/families/plan.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * The collaboration lane is user-level, so every residual case must resolve its
 * home to this fixture and never to the operator's real one.
 */
const HOME_ROOT = mkdtempSync(path.join(os.tmpdir(), "plan-command-home-"));
let homeSpy: { mockRestore(): void } | undefined;
beforeAll(() => {
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME_ROOT);
});
afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "plan-command-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  const harness = path.join(root, ".mstar");
  const workflow = "wf-plan";
  const plan = "plan-a";
  const workflowDir = path.join(harness, "workflows", workflow);
  mkdirSync(workflowDir, { recursive: true });
  mkdirSync(path.join(harness, "plans"), { recursive: true });
  writeFileSync(path.join(harness, "plans", `${plan}.md`), `# Plan A\n\n**plan_id:** ${plan}\n`);
  writeFileSync(path.join(harness, "status.json"), JSON.stringify({
    version: 2,
    updated_at: "2026-09-26T00:00:00Z",
    workflows: [{ id: workflow, status: "running", type: "iteration", started_at: "2026-09-26T00:00:00Z", dir: `workflows/${workflow}` }],
  }));
  writeFileSync(path.join(workflowDir, "snapshot.json"), JSON.stringify({
    schema_version: 1,
    id: workflow,
    type: "iteration",
    status: "running",
    started_at: "2026-09-26T00:00:00Z",
    updated_at: "2026-09-26T00:00:00Z",
    plans: [{ id: plan, plan_id: plan, title: "Plan A", file: `plans/${plan}.md`, status: "Todo", metadata: { project_id: "_default" } }],
  }));
  return { root, harness, workflow, plan };
}
function activeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "plan-active-command-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  const harness = path.join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  return { root, harness, workflow: "wf-plan", plan: "plan-a" };
}

function context(cwd: string, sessionId?: string): InvocationContext {
  return {
    cwd,
    controlRoot: null,
    ...(sessionId === undefined ? {} : { sessionId }),
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { throw new Error("plan commands must not spawn a process"); },
      async startDashboard() { throw new Error("dashboard is unavailable in this test"); },
      async openBrowser() { throw new Error("browser is unavailable in this test"); },
    },
  };
}

function definition(id: string) {
  const found = getPlanCommandDefinitions().find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`Missing command definition: ${id}`);
  return found;
}

function workflowTokenOf(created: { data: unknown }): ExecutionToken {
  const data = created.data;
  if (data === null || typeof data !== "object" || !("workflows" in data) || !Array.isArray(data.workflows)) {
    throw new Error("createExecutionWorkflow returned no workflows array");
  }
  const [workflow] = data.workflows;
  if (workflow === null || typeof workflow !== "object" || !("workflowToken" in workflow)) {
    throw new Error("createExecutionWorkflow returned no workflow token");
  }
  return workflow.workflowToken as ExecutionToken;
}

/** The plan row inside a `plan.show` ExecutionRead envelope, narrowed at runtime. */
function planRowOf(envelope: { status: string; data: unknown }): { id: string } {
  if (envelope.status !== "ok" || envelope.data === null || typeof envelope.data !== "object" || !("data" in envelope.data)) {
    throw new Error("plan.show returned no ExecutionRead payload");
  }
  const read = envelope.data.data;
  if (read === null || typeof read !== "object" || !("plan" in read) || read.plan === null || typeof read.plan !== "object" || !("id" in read.plan)) {
    throw new Error("plan.show returned no plan row");
  }
  return read.plan as { id: string };
}

describe("plan command family", () => {
  test("plan.complete publishes a lossless engine-compatible evidence shape", () => {
    const definition = getCommandDefinitions().find(({ id }) => id === "plan.complete");
    const contract = getCommandSchemas(getCommandDefinitions()).find(({ id }) => id === "plan.complete");
    if (definition === undefined || contract === undefined) throw new Error("missing plan.complete contract");
    const valid = {
      workflow: "wf-plan",
      plan: "plan-a",
      evidence: {
        evidence_paths: ["/repo/.mstar/plans/plan-a.md"],
        qc: { decision: "Approve", reports: ["qc.md"], consolidated: "qc-consolidated.md", extraEngineField: true },
        acceptance: { gate: "pm-acceptance", decision: "pass", report: "acceptance.md", extraEngineField: true },
        extraEngineField: true,
      },
    };
    const parsed = definition.input.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data.evidence as Record<string, unknown>).evidence_paths).toEqual(valid.evidence.evidence_paths);
      expect((parsed.data.evidence as Record<string, unknown>).extraEngineField).toBe(true);
    }
    expect(definition.input.safeParse({
      ...valid,
      evidence: { ...valid.evidence, qc: { ...valid.evidence.qc, reports: [] } },
    }).success).toBe(false);
    expect(definition.input.safeParse({ ...valid, evidence: { qc: {}, acceptance: {} } }).success).toBe(false);
    expect(contract.input.properties).toHaveProperty("evidence");
    expect(contract.payloadSchemas.evidence).toBeDefined();

    for (const verb of ["progress", "issue-add", "issue-close"] as const) {
      expect(getPlanCommandDefinitions().find(({ id }) => id === `plan.${verb}`)?.payloads).toBeDefined();
    }
  });


  test("plan family payload decode rejects malformed fields with accurate paths", () => {
    const planProgress = definition("plan.progress");
    const malformed = planProgress.input.safeParse({ progress: "not-an-object" });
    expect(malformed.success).toBe(false);
    if (!malformed.success) expect(malformed.error.issues[0]?.path).toEqual(["progress"]);
  });


  test("bind requires runtime identity; the active route binds, reports progress and cannot bypass completion", async () => {
    const data = activeFixture();
    const bindDefinition = definition("plan.bind");

    // Identity and addressing are validated before any route work.
    const suppliedOnly = await bindDefinition.execute({ coordinator: true, workflow: data.workflow, harness: data.harness, sessionId: "caller-chosen" } as never, context(data.root));
    expect(suppliedOnly).toMatchObject({ status: "usage", code: "command.invalid-input" });
    const rejectedPlanBind = await bindDefinition.execute({ workflow: data.workflow, plan: data.plan, harness: data.harness } as never, context(data.root, "runtime-coordinator"));
    expect(rejectedPlanBind).toMatchObject({ status: "usage", code: "command.invalid-input" });

    // The ACTIVE route: one active store, one running workflow, one coordinator.
    const storeContext = { harnessDir: data.harness };
    (await initializeStore(storeContext)).close();
    const initialized = await readExecutionAuthority(storeContext);
    const identity = {
      source: "local" as const,
      sessionId: "runtime-coordinator",
      workflowId: data.workflow,
      role: "coordinator" as const,
    };
    const created = await createExecutionWorkflow(executionContextFor(storeContext, identity), {
      entry: { id: data.workflow, type: "iteration", status: "running", started_at: "2026-09-26T00:00:00Z", dir: `workflows/${data.workflow}` } as never,
      snapshot: {
        schema_version: 1,
        id: data.workflow,
        type: "iteration",
        status: "running",
        started_at: "2026-09-26T00:00:00Z",
        updated_at: "2026-09-26T00:00:00Z",
        branch: { base: "main" },
        plans: [{ id: data.plan, plan_id: data.plan, title: "Plan A", file: `plans/${data.plan}.md`, status: "Todo", metadata: { project_id: "_default" } }],
      } as never,
      expected: initialized.token,
      operationId: "create-plan-workflow",
    });
    const workflowToken = workflowTokenOf(created);
    const ctx = { ...context(data.root, "runtime-coordinator"), controlRoot: data.harness };

    const bound = await bindDefinition.execute({ execution: true, coordinator: true, workflow: data.workflow, harness: data.harness, expect: workflowToken, operation: "bind-coordinator" } as never, ctx);
    expect(bound.status).toBe("ok");

    const shown = await definition("plan.show").execute({ workflow: data.workflow, plan: data.plan } as never, ctx);
    expect(shown.status).toBe("ok");
    if (shown.status !== "ok") throw new Error(`plan show failed: ${JSON.stringify(shown)}`);
    const shownRow = planRowOf(shown);
    expect(shownRow.id).toBe(data.plan);

    const started = await definition("plan.progress").execute({ workflow: data.workflow, plan: data.plan, progress: { status: "InProgress", summary: "started", evidence_paths: [] } } as never, ctx);
    expect(started.status).toBe("ok");
    if (started.status !== "ok") throw new Error(`plan progress failed: ${JSON.stringify(started)}`);

    // The recorded completion cannot be bypassed by an unsupported transition.
    const denied = await definition("plan.progress").execute({ workflow: data.workflow, plan: data.plan, progress: { status: "Done", summary: "x", evidence_paths: [] } } as never, ctx);
    expect(denied).toMatchObject({ status: "refused", exitCode: 1 });
  });


  test("plan bind without the execution route refuses, and its recovery names a working invocation", async () => {
    const data = activeFixture();
    const storeContext = { harnessDir: data.harness };
    (await initializeStore(storeContext)).close();
    // `store init` already activated execution authority with the schema.
    const initialized = await readExecutionAuthority(storeContext);
    const identity = {
      source: "local" as const,
      sessionId: "coordinator-a",
      workflowId: data.workflow,
      role: "coordinator" as const,
    };
    await createExecutionWorkflow(executionContextFor(storeContext, identity), {
      entry: { id: data.workflow, type: "iteration", status: "running", started_at: "2026-09-26T00:00:00Z", dir: `workflows/${data.workflow}` } as never,
      snapshot: {
        schema_version: 1,
        id: data.workflow,
        type: "iteration",
        status: "running",
        started_at: "2026-09-26T00:00:00Z",
        updated_at: "2026-09-26T00:00:00Z",
        branch: { base: "main" },
        plans: [{ id: data.plan, plan_id: data.plan, title: "Plan A", file: `plans/${data.plan}.md`, status: "Todo", metadata: { project_id: "_default" } }],
      } as never,
      expected: initialized.token,
      operationId: "create-plan-workflow",
    });

    // The retired file-route bind (no `--execution`) refuses.
    const result = await definition("plan.bind").execute(
      { coordinator: true, workflow: data.workflow, harness: data.harness } as never,
      context(data.root, "coordinator-a"),
    );
    expect(result).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
  });

  test("stale active execution tokens are rejected by the engine", async () => {
    const data = activeFixture();
    const storeContext = { harnessDir: data.harness };
    (await initializeStore(storeContext)).close();
    // `store init` activates execution authority; read the committed root token.
    const initialized = await readExecutionAuthority(storeContext);
    const identity = {
      source: "local" as const,
      sessionId: "coordinator-a",
      workflowId: data.workflow,
      role: "coordinator" as const,
    };
    const created = await createExecutionWorkflow(executionContextFor(storeContext, identity), {
      entry: { id: data.workflow, type: "iteration", status: "running", started_at: "2026-09-26T00:00:00Z", dir: `workflows/${data.workflow}` } as never,
      snapshot: {
        schema_version: 1,
        id: data.workflow,
        type: "iteration",
        status: "running",
        started_at: "2026-09-26T00:00:00Z",
        updated_at: "2026-09-26T00:00:00Z",
        branch: { base: "main" },
        plans: [{ id: data.plan, plan_id: data.plan, title: "Plan A", file: `plans/${data.plan}.md`, status: "Todo", metadata: { project_id: "_default" } }],
      } as never,
      expected: initialized.token,
      operationId: "create-plan-workflow",
    });
    const workflowToken = workflowTokenOf(created);
    const ctx = { ...context(data.root, "coordinator-a"), controlRoot: data.harness };
    const bind = {
      execution: true,
      coordinator: true,
      workflow: data.workflow,
      harness: data.harness,
      expect: workflowToken,
      operation: "bind-coordinator",
    };
    const first = await definition("plan.bind").execute(bind as never, ctx);
    expect(first.status).toBe("ok");

    const stale = await definition("plan.bind").execute({ ...bind, operation: "bind-stale" } as never, ctx);
    expect(stale).toMatchObject({ status: "refused", code: "execution.stale-token", exitCode: 1 });
    // The refusal reaches the plan.bind recovery producer, whose text names the
    // invocation that actually works: `--execution` is required for a new bind.
    const staleDetails = stale.details;
    if (staleDetails === null || typeof staleDetails !== "object" || !("recovery" in staleDetails)) {
      throw new Error("plan.bind refusal carries no details.recovery");
    }
    const recovery = String(staleDetails.recovery);
    expect(recovery).toContain("mstar plan bind --execution true --coordinator true --workflow <workflow-id>");
    expect(recovery).toContain("--coordinator");
    expect(recovery).toContain("--resume-ref");
  });
});

/**
 * One residual-bearing checkout: a synthetic origin (the collaboration identity),
 * an active combined store and — unless `collaboration: "absent"` — an ACTIVE
 * collaboration authority, plus a running workflow whose coordinator is bound.
 */
async function residualFixture(
  name: string,
  options: { collaboration?: "active" | "absent" } = {},
): Promise<{ root: string; harness: string; workflow: string; plan: string; ctx: InvocationContext }> {
  const root = mkdtempSync(path.join(os.tmpdir(), `plan-${name}-`));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${name}.git`], { cwd: root });
  writeFileSync(path.join(root, ".mstarc"), "[collaboration]\nmode=local\n");
  const harness = path.join(root, ".mstar");
  mkdirSync(path.join(harness, "plans"), { recursive: true });
  const workflow = "wf-plan";
  const plan = "plan-a";
  writeFileSync(path.join(harness, "plans", `${plan}.md`), `# Plan A\n\n**plan_id:** ${plan}\n`);
  const storeContext = { harnessDir: harness };
  (await initializeStore(storeContext)).close();
  if ((options.collaboration ?? "active") === "active") {
    const location = resolveCollaborationLocation(storeContext);
    await initializeCollaborationStore(location);
    const db = new DatabaseSync(location.dbPath);
    try {
      db.prepare("update collaboration_meta set authority_state = 'active', activated_at = ? where id = 1").run(new Date().toISOString());
    } finally {
      db.close();
    }
  }
  const initialized = await readExecutionAuthority(storeContext);
  const identity = { source: "local" as const, sessionId: "runtime-coordinator", workflowId: workflow, role: "coordinator" as const };
  const created = await createExecutionWorkflow(executionContextFor(storeContext, identity), {
    entry: { id: workflow, type: "iteration", status: "running", started_at: "2026-09-26T00:00:00Z", dir: `workflows/${workflow}` } as never,
    snapshot: {
      schema_version: 1,
      id: workflow,
      type: "iteration",
      status: "running",
      started_at: "2026-09-26T00:00:00Z",
      updated_at: "2026-09-26T00:00:00Z",
      branch: { base: "main" },
      plans: [{ id: plan, plan_id: plan, title: "Plan A", file: `plans/${plan}.md`, status: "Todo", metadata: { project_id: "_default" } }],
    } as never,
    expected: initialized.token,
    operationId: `create-${name}`,
  });
  const ctx = { ...context(root, "runtime-coordinator"), controlRoot: harness };
  const bound = await definition("plan.bind").execute(
    { execution: true, coordinator: true, workflow, harness, expect: workflowTokenOf(created), operation: `bind-${name}` } as never,
    ctx,
  );
  if (bound.status !== "ok") throw new Error(`fixture: coordinator bind failed: ${JSON.stringify(bound)}`);
  return { root, harness, workflow, plan, ctx };
}

/** The plan CAS token `plan.show` reports, or a fixture failure. */
function planTokenOf(envelope: { status: string; data: unknown }): string {
  if (envelope.status !== "ok" || envelope.data === null || typeof envelope.data !== "object" || !("token" in envelope.data)) {
    throw new Error(`plan.show returned no execution token: ${JSON.stringify(envelope)}`);
  }
  const token = envelope.data.token;
  if (typeof token !== "string") throw new Error("plan.show returned a non-string execution token");
  return token;
}

function residualEntry(occurrenceKey: string) {
  return {
    title: "residual finding",
    kind: "bug",
    severity: "high",
    impact: "the residual is unfixed",
    acceptance: "the residual is fixed",
    sourceIdentity: "qc/review.md",
    rootCauseKey: "missing-guard",
    acceptanceKey: "guard-present",
    occurrenceKey,
    sourceKind: "qc",
    location: "packages/commands/src/families/plan.ts:1",
    observedBehavior: "the finding is visible",
    evidence: ["stack: TypeError"],
    discoveredAt: "2026-09-18T10:00:00.000Z",
  };
}

describe("plan residual-add / residual-close composite commands", () => {
  test("plan.issue-add and plan.issue-close carry the cross-store composite and replay exactly", async () => {
    const data = await residualFixture("residual-add-close");
    const shown = await definition("plan.show").execute({ workflow: data.workflow, plan: data.plan, harness: data.harness } as never, data.ctx);
    const request = {
      workflow: data.workflow,
      plan: data.plan,
      harness: data.harness,
      expect: planTokenOf(shown),
      operation: "residual-add-command-1",
      entries: [residualEntry("command-event-1")],
    };
    const added = await definition("plan.issue-add").execute(request as never, data.ctx);
    expect(added.status).toBe("ok");
    if (added.status !== "ok") throw new Error(`plan.issue-add failed: ${JSON.stringify(added)}`);
    const receipt = added.data as { replayed: boolean; token: string };
    expect(receipt.replayed).toBe(false);

    // The same operation id and payload replay the recorded receipt instead of
    // capturing a second issue.
    const replayed = await definition("plan.issue-add").execute(request as never, data.ctx);
    expect(replayed.status).toBe("ok");
    if (replayed.status !== "ok") throw new Error(`plan.issue-add replay failed: ${JSON.stringify(replayed)}`);
    expect((replayed.data as { replayed: boolean }).replayed).toBe(true);

    const storeContext = { harnessDir: data.harness };
    const issues = await listIssues(storeContext, {});
    expect(issues.total).toBe(1);
    const [finding] = issues.items;
    if (finding === undefined) throw new Error("fixture: the residual was not captured");
    const detail = await getIssue(storeContext, finding.id);

    const closed = await definition("plan.issue-close").execute({
      workflow: data.workflow,
      plan: data.plan,
      harness: data.harness,
      expect: receipt.token,
      operation: "residual-close-command-1",
      issue: detail.id,
      disposition: "resolved",
      expectIssue: detail.revision,
      evidence: { reason: "fixed", references: ["p-1"], alignmentRef: "qa-gate:accepted" },
    } as never, data.ctx);
    expect(closed.status).toBe("ok");
    if (closed.status !== "ok") throw new Error(`plan.issue-close failed: ${JSON.stringify(closed)}`);
    expect((await getIssue(storeContext, detail.id)).disposition).toBe("resolved");
    expect((closed.data as { replayed: boolean }).replayed).toBe(false);
  });

  test("an unavailable collaboration authority refuses the residual without reporting success and names the same-id recovery", async () => {
    const data = await residualFixture("residual-unavailable", { collaboration: "absent" });
    const shown = await definition("plan.show").execute({ workflow: data.workflow, plan: data.plan, harness: data.harness } as never, data.ctx);
    const refused = await definition("plan.issue-add").execute({
      workflow: data.workflow,
      plan: data.plan,
      harness: data.harness,
      expect: planTokenOf(shown),
      operation: "residual-unavailable-1",
      entries: [residualEntry("command-event-unavailable")],
    } as never, data.ctx);
    expect(refused.status).toBe("refused");
    expect(refused.code).toBe("collaboration.not-initialized");
    const details = refused.details;
    if (details === null || typeof details !== "object" || !("recovery" in details)) {
      throw new Error("plan.issue-add refusal carries no details.recovery");
    }
    expect(String(details.recovery)).toContain("same --operation id");
  });
});
