import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createExecutionWorkflow,
  executionContextFor,
  initializeExecutionAuthority,
  initializeStore,
} from "@mstar-harness/engine";
import type { ExecutionToken } from "@mstar-harness/engine";
import { getCommandDefinitions } from "../src/index.js";
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
  const found = getCommandDefinitions().find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`Missing command definition: ${id}`);
  return found;
}

describe("plan command family", () => {


  test("plan family payload decode rejects malformed fields with accurate paths", () => {
    const planProgress = definition("plan.progress");
    const malformed = planProgress.input.safeParse({ progress: "not-an-object" });
    expect(malformed.success).toBe(false);
    if (!malformed.success) expect(malformed.error.issues[0]?.path).toEqual(["progress"]);
  });


  test("bind requires runtime identity and the coordinator reports progress but cannot bypass completion", async () => {
    const data = fixture();
    const ctx = context(data.root);
    const coordinatorDefinition = definition("plan.bind");
    const suppliedOnly = await coordinatorDefinition.execute({ coordinator: true, workflow: data.workflow, harness: data.harness, sessionId: "caller-chosen" } as never, ctx);
    expect(suppliedOnly).toMatchObject({ status: "usage", code: "command.invalid-input" });
    const rejectedPlanBind = await coordinatorDefinition.execute({ workflow: data.workflow, plan: data.plan, harness: data.harness } as never, ctx);
    expect(rejectedPlanBind).toMatchObject({ status: "usage", code: "command.invalid-input" });
    const bound = await coordinatorDefinition.execute({ coordinator: true, workflow: data.workflow, harness: data.harness } as never, context(data.root, "runtime-coordinator"));
    if (bound.status !== "ok" || typeof bound.data !== "object" || bound.data === null || !("session_file" in bound.data)) {
      throw new Error(`coordinator bind failed: ${JSON.stringify(bound)}`);
    }
    const session = String(bound.data.session_file);

    const shown = await definition("plan.show").execute({ session, plan: data.plan } as never, ctx);
    if (shown.status !== "ok") throw new Error(`plan show failed: ${JSON.stringify(shown)}`);
    const view = shown.data as { row: { id: string }; revision: number };
    expect(view.row.id).toBe(data.plan);
    const started = await definition("plan.progress").execute({ session, plan: data.plan, expect: view.revision, progress: { status: "InProgress", summary: "started", evidence_paths: [] } } as never, ctx);
    expect(started.status).toBe("ok");
    if (started.status !== "ok") throw new Error(`plan progress failed: ${JSON.stringify(started)}`);
    const progressed = started.data as { view: { revision: number; row: { status: string } } };
    expect(progressed.view.row.status).toBe("InProgress");
    const persisted = await definition("plan.show").execute({ session, plan: data.plan } as never, ctx);
    expect(persisted).toMatchObject({ status: "ok", data: { revision: progressed.view.revision, row: { status: "InProgress" } } });
    const snapshot = path.join(data.harness, "workflows", data.workflow, "snapshot.json");
    const beforeDenied = await Bun.file(snapshot).text();

    const denied = await definition("plan.progress").execute({ session, plan: data.plan, expect: progressed.view.revision, progress: { status: "Done", summary: "x", evidence_paths: [] } } as never, ctx);
    expect(denied).toMatchObject({ status: "refused", code: "coordination.invalid-input", exitCode: 1 });
    expect(await Bun.file(snapshot).text()).toBe(beforeDenied);
  });


  test("legacy plan bind refuses before snapshot lookup when workflow is in active DB authority", async () => {
    const data = activeFixture();
    const storeContext = { harnessDir: data.harness };
    (await initializeStore(storeContext)).close();
    const initialized = await initializeExecutionAuthority(storeContext);
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

    const result = await definition("plan.bind").execute(
      { coordinator: true, workflow: data.workflow, harness: data.harness } as never,
      context(data.root, "coordinator-a"),
    );
    expect(result).toMatchObject({ status: "refused", code: "execution.consumer-not-ready", exitCode: 1 });
    expect(result.message).toContain("registered in the active DB execution authority");
    expect(result.message).toContain("Re-run with `--execution`");
    expect(result.message).not.toContain("coordination.workflow-not-found");
  });

  test("stale active execution tokens are rejected by the engine", async () => {
    const data = activeFixture();
    const storeContext = { harnessDir: data.harness };
    (await initializeStore(storeContext)).close();
    const initialized = await initializeExecutionAuthority(storeContext);
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
    const createdWorkflow = (created.data as unknown as { workflows: Array<{ workflowToken: ExecutionToken }> }).workflows[0]!;
    const ctx = { ...context(data.root, "coordinator-a"), controlRoot: data.harness };
    const bind = {
      execution: true,
      coordinator: true,
      workflow: data.workflow,
      harness: data.harness,
      expect: createdWorkflow.workflowToken,
      operation: "bind-coordinator",
    };
    const first = await definition("plan.bind").execute(bind as never, ctx);
    expect(first.status).toBe("ok");

    const stale = await definition("plan.bind").execute({ ...bind, operation: "bind-stale" } as never, ctx);
    expect(stale).toMatchObject({ status: "refused", code: "execution.stale-token", exitCode: 1 });
  });
});
