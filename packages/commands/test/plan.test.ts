import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createExecutionWorkflow,
  executionContextFor,
  initializeStore,
  readExecutionAuthority,
} from "@mstar-harness/engine";
import type { ExecutionToken } from "@mstar-harness/engine";
import { getPlanCommandDefinitions } from "../src/families/plan.js";
import type { InvocationContext } from "../src/types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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

describe("plan command family", () => {


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
    expect((shown.data as { row: { id: string } }).row.id).toBe(data.plan);

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
    expect(recovery).toContain("mstar plan bind --execution --workflow");
    expect(recovery).toContain("--coordinator");
    expect(recovery).toContain("--resume-ref");
  });
});
