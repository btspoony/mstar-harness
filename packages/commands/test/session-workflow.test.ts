import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  encodeExecutionSessionRef,
  executionContextFor,
  initializeStore,
  mutateExecutionWorkflow,
  readExecutionState,
  type ExecutionToken,
} from "@mstar-harness/engine";
import { getCommandDefinitions } from "../src/index.js";
import type { CommandEffects, InvocationContext } from "../src/types.js";
import { executeCommand } from "../src/definitions.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function testContext(overrides: Partial<InvocationContext> = {}): InvocationContext {
  const root = mkdtempSync(path.join(os.tmpdir(), "session-workflow-"));
  roots.push(root);
  const effects: CommandEffects = {
    async readInput() { return ""; },
    spawn({ argv, cwd, env }) {
      return new Promise((resolve, reject) => {
        const child = spawn(argv[0]!, argv.slice(1), { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
      });
    },
    async startDashboard() { throw new Error("not used"); },
    async openBrowser() { throw new Error("not used"); },
  };
  return { cwd: root, controlRoot: null, versions: { engine: null, cli: null, plugin: null, host: null, platform: null }, signal: new AbortController().signal, effects, ...overrides };
}

function definition(id: string) {
  const found = getCommandDefinitions().find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing command definition: ${id}`);
  return found;
}

describe("session and workflow command families", () => {
  test("iteration.register publishes and validates its sparse row payload", () => {
    const iteration = definition("iteration.register");
    expect(iteration.payloads?.row?.schema.safeParse([{ id: "plan-a" }]).success).toBe(true);
    expect(iteration.payloads?.row?.schema.safeParse({ id: "plan-a" }).success).toBe(false);
  });

  test("public workflow FILE routes redact malformed source bytes", async () => {
    const context = testContext({ sessionId: "caller-session" });
    const harness = path.join(context.cwd, ".mstar");
    mkdirSync(harness, { recursive: true });
    const secret = "sk-live-9f2c4ab1-secret";
    const malformedFile = path.join(context.cwd, "malformed.json");
    writeFileSync(malformedFile, `{"value":${secret}}`);

    const evidence = await executeCommand("workflow.evidence", {
      workflow: "wf-malformed", file: malformedFile, harness,
    }, context);
    expect(evidence).toMatchObject({ status: "refused", code: "workflow.evidence.file-malformed", details: { recovery: expect.stringContaining("mstar workflow evidence") } });
    expect(JSON.stringify(evidence)).not.toContain(secret);
    expect(JSON.stringify(evidence)).not.toContain("workflow adopt-terminal --attestation");

    const policy = await executeCommand("workflow.execution-policy", {
      workflow: "wf-malformed", file: malformedFile, harness,
    }, context);
    expect(policy).toMatchObject({ status: "refused", code: "workflow.execution-policy.file-malformed", details: { recovery: expect.stringContaining("mstar workflow execution-policy") } });
    expect(JSON.stringify(policy)).not.toContain(secret);
    expect(JSON.stringify(policy)).not.toContain("workflow adopt-terminal --attestation");

  });

  test("unreadable non-adoption workflow files recover through their own --file route", async () => {
    const context = testContext({ sessionId: "caller-session" });
    const harness = path.join(context.cwd, ".mstar");
    mkdirSync(harness, { recursive: true });
    const file = path.join(context.cwd, "missing.json");
    const evidence = await executeCommand("workflow.evidence", {
      workflow: "wf-missing-file", file, harness,
    }, context);
    expect(evidence).toMatchObject({
      status: "refused", code: "ENOENT",
      details: { recovery: expect.stringContaining("mstar workflow evidence --workflow <id> --file <absolute-json>") },
    });
    expect(JSON.stringify(evidence)).not.toContain("workflow adopt-terminal --attestation");

    const policy = await executeCommand("workflow.execution-policy", {
      workflow: "wf-missing-file", file, harness,
    }, context);
    expect(policy).toMatchObject({
      status: "refused", code: "ENOENT",
      details: { recovery: expect.stringContaining("mstar workflow execution-policy --workflow <id> --file <absolute-json>") },
    });
    expect(JSON.stringify(policy)).not.toContain("workflow adopt-terminal --attestation");
  });
  test("session.run launches argv without a shell and preserves child output and exit status", async () => {
    const { harness } = await runFixture("smoke", { bind: RUN_CLAIMED });
    const context = testContext({ sessionId: RUN_CLAIMED });
    const result = await definition("session.run").execute({ workflow: RUN_WORKFLOW, role: "coordinator", argv: [process.execPath, "-e", "const i=JSON.parse(process.env.MSTAR_EXECUTION_IDENTITY); process.stdout.write((process.env.MSTAR_HOST_SESSION_ID === undefined ? 'clean' : 'stale') + ':' + i.source + ':' + i.role); process.exit(124)" ], harness }, context);
    expect(result).toMatchObject({ status: "error", exitCode: 124, code: "session.child-exit", details: { stdout: "clean:local:coordinator" } });
  });

  test("session.run carries a real child signal in the result envelope", async () => {
    const { harness } = await runFixture("signal", { bind: RUN_CLAIMED });
    const context = testContext({ sessionId: RUN_CLAIMED });
    const result = await definition("session.run").execute({ workflow: RUN_WORKFLOW, role: "coordinator", argv: [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"], harness }, context);
    expect(result).toMatchObject({ status: "error", exitCode: 143, code: "session.child-exit", details: { signal: "SIGTERM" } });
  });

  test("workflow references cannot be re-scoped to a different workflow", async () => {
    const wire = encodeExecutionSessionRef({ storeId: "00000000-0000-4000-8000-000000000000", epoch: 1, workflowId: "wf-other", role: "coordinator", sessionId: "other-session" });
    const result = await definition("workflow.phase").execute({ workflow: "wf-target", sessionRef: wire, expect: "token", operation: "op", phase: "phase-1", compass: "/tmp/compass.md" }, testContext({ sessionId: "main-session" }));
    expect(result.status).toBe("usage");
  });

  test("session.recover refuses request-supplied identity when runtime identity is absent", async () => {
    const context = testContext();
    const result = await definition("session.recover").execute({ workflow: "wf-recovery", sessionId: "child-agent-session", priorSession: "stopped", reason: "reload", attestation: "/tmp/wf-recovery-attestation.json", expect: "stale-token", operation: "recover-1" }, context);
    expect(result).toMatchObject({ status: "usage", code: "command.invalid-input" });
    expect(result.details?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "sessionId", code: "required" }),
    ]));
  });


  test("workflow.register publishes no FILE transport on an ACTIVE control root", async () => {
    const context = testContext();
    const harnessDir = path.join(context.cwd, ".mstar");
    mkdirSync(harnessDir, { recursive: true });
    const store = await initializeStore({ harnessDir });
    store.close();
    // Issue #428: the store is created ACTIVE and registration runs on the
    // single ACTIVE seam — no status.json/snapshot.json FILE transport exists.
    // The declared plan file is missing, so the refusal comes from the ACTIVE
    // resolver rather than from a retired pre-activation branch.
    const result = await definition("workflow.register").execute({
      workflow: "wf-active", planId: "plan-active", planTitle: "Active plan", planFile: "plans/plan-active.md",
      deliveryKind: "development", harness: harnessDir,
    }, context);
    expect(result.status).toBe("refused");
    expect(existsSync(path.join(harnessDir, "status.json"))).toBe(false);
    expect(existsSync(path.join(harnessDir, "workflows", "wf-active"))).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * `session.run` verified binding: the launcher launches existing authority
 * and never manufactures a coordinator identity.
 * ------------------------------------------------------------------------ */

const RUN_WORKFLOW = "wf-run";
const RUN_PLAN = "plan-run";
const RUN_BRANCH = "feature/run";
const RUN_TS = "2026-10-24T00:00:00.000Z";
const RUN_CLAIMED = "run-claimed-session";
const RUN_HOLDER = "run-holder-session";

/** The child reports the identity it actually received, as one JSON line. */
const IDENTITY_PROBE =
  "const i=JSON.parse(process.env.MSTAR_EXECUTION_IDENTITY);" +
  "process.stdout.write(JSON.stringify({sessionId:i.sessionId,workflowId:i.workflowId,role:i.role,hostSessionId:Object.hasOwn(process.env,'MSTAR_HOST_SESSION_ID')}));";

/** A harness directory that holds no execution store at all. */
function absentStore(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "session-run-absent-"));
  roots.push(root);
  const harness = path.join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  return harness;
}

/** A harness directory whose initialized store holds no registered workflow. */
async function emptyStore(): Promise<string> {
  const root = mkdtempSync(path.join(os.tmpdir(), "session-run-empty-"));
  roots.push(root);
  const harness = path.join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  const store = await initializeStore({ harnessDir: harness });
  store.close();
  return harness;
}

/** The workflow token the fixture's authority serves right now. */
async function liveRunToken(harness: string): Promise<ExecutionToken> {
  const state = await readExecutionState({ harnessDir: harness });
  const workflow = state.data.workflows.find((entry) => entry.state.id === RUN_WORKFLOW);
  if (workflow === undefined) throw new Error("fixture: the workflow is not registered");
  return workflow.workflowToken;
}

/**
 * One ACTIVE authority holding a `running` lifecycle, optionally bound to a
 * coordinator and advanced to the lifecycle state a case observes. Every state
 * comes from the engine's own producers, never from editing store rows.
 */
async function runFixture(
  label: string,
  options: { bind?: string; status?: "paused" | "stopped" | "failed" | "completed" } = {},
): Promise<{ harness: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), `session-run-${label}-`));
  roots.push(root);
  const harness = path.join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  const store = await initializeStore({ harnessDir: harness });
  store.close();
  const context = executionContextFor(
    { harnessDir: harness },
    { source: "local", sessionId: options.bind ?? RUN_HOLDER, workflowId: RUN_WORKFLOW, role: "coordinator" },
  );
  const initialized = await readExecutionState({ harnessDir: harness });
  await createExecutionWorkflow(context, {
    entry: { id: RUN_WORKFLOW, type: "plan", started_at: RUN_TS, dir: `workflows/${RUN_WORKFLOW}` } as never,
    snapshot: {
      schema_version: 1,
      id: RUN_WORKFLOW,
      type: "plan",
      status: "running",
      started_at: RUN_TS,
      updated_at: RUN_TS,
      project: "harness",
      delivery_kind: "development",
      branch: { base: "main", work: RUN_BRANCH, target: "main" },
      execution_policy: { plan_parallelism: "serial", worktree_mode: "required" },
      plans: [
        { id: RUN_PLAN, title: "Run plan", file: `plans/${RUN_PLAN}.md`, status: options.status === "completed" ? "Done" : "Todo" },
      ],
    } as never,
    expected: initialized.token,
    operationId: `create-${label}`,
  });
  if (options.bind === undefined && options.status === undefined) return { harness };
  const bound = await bindExecutionSession(context, {
    workflowId: RUN_WORKFLOW,
    expected: await liveRunToken(harness),
    operationId: `bind-${label}`,
  });
  if (options.status === undefined) return { harness };
  if (options.status === "completed") {
    const deliveries = [
      { compound: { outcome: "created" } },
      { pr: { repo: "o/r", head: RUN_BRANCH, target: "main" } },
      { merge: { provider: "github", evidence: "PR #1 merged" } },
    ] as const;
    for (const [index, delivery] of deliveries.entries()) {
      await mutateExecutionWorkflow(context, {
        workflowId: RUN_WORKFLOW,
        session: bound.data,
        expected: await liveRunToken(harness),
        operationId: `delivery-${index}-${label}`,
        operation: { kind: "delivery", delivery },
      });
    }
  }
  await mutateExecutionWorkflow(context, {
    workflowId: RUN_WORKFLOW,
    session: bound.data,
    expected: await liveRunToken(harness),
    operationId: `lifecycle-${label}`,
    operation: { kind: "lifecycle", status: options.status, reason: "fixture lifecycle" },
  });
  return { harness };
}

/** One launch under the bound workflow, claiming the supplied session id. */
async function launchBound(harness: string, claimed: string) {
  return definition("session.run").execute(
    { workflow: RUN_WORKFLOW, role: "coordinator", argv: [process.execPath, "-e", IDENTITY_PROBE], harness },
    testContext({ sessionId: claimed }),
  );
}

function recoveryOf(envelope: { details?: Record<string, unknown> }): string {
  const recovery = envelope.details?.recovery;
  return typeof recovery === "string" ? recovery : "";
}

/** Every value one envelope publishes under a session-identity key. */
function sessionIdsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(sessionIdsIn);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, member]) =>
    key.toLowerCase().includes("sessionid") && typeof member === "string" ? [member] : sessionIdsIn(member),
  );
}

describe("session.run bound identity", () => {
  test("launches under the live coordinator binding and echoes the claimed id", async () => {
    const { harness } = await runFixture("bound", { bind: RUN_CLAIMED });
    const result = await launchBound(harness, RUN_CLAIMED);
    expect(result.status).toBe("ok");
    expect(result).toMatchObject({
      data: {
        identity: { source: "local", sessionId: RUN_CLAIMED, workflowId: RUN_WORKFLOW, role: "coordinator" },
        binding: { verified: true, coordinator: { sessionId: RUN_CLAIMED, workflowId: RUN_WORKFLOW, role: "coordinator" } },
        exitCode: 0,
      },
    });
    // The child received exactly the verified identity, and no host session id.
    const data = result.data;
    if (data === null || data === undefined || typeof data !== "object" || !("stdout" in data) || typeof data.stdout !== "string") {
      throw new Error("session.run receipt carries no child stdout");
    }
    expect(JSON.parse(data.stdout)).toEqual({
      sessionId: RUN_CLAIMED, workflowId: RUN_WORKFLOW, role: "coordinator", hostSessionId: false,
    });
    // No envelope publishes a session id other than the claimed one.
    expect(new Set(sessionIdsIn(result))).toEqual(new Set([RUN_CLAIMED]));
  });

  test("refuses an unbound id with the recovery that matches the observed state", async () => {
    const cases = [
      {
        label: "ownerless",
        fixture: () => runFixture("ownerless"),
        claimed: RUN_CLAIMED,
        expected: `mstar plan bind --execution --workflow ${RUN_WORKFLOW} --coordinator`,
      },
      {
        label: "foreign live holder",
        fixture: () => runFixture("foreign", { bind: RUN_HOLDER }),
        claimed: RUN_CLAIMED,
        expected: "mstar session recover",
      },
      {
        label: "paused",
        fixture: () => runFixture("paused", { bind: RUN_CLAIMED, status: "paused" }),
        claimed: RUN_CLAIMED,
        expected: `mstar workflow lifecycle --workflow ${RUN_WORKFLOW} --status running`,
      },
      {
        label: "stopped",
        fixture: () => runFixture("stopped", { bind: RUN_HOLDER, status: "stopped" }),
        claimed: RUN_CLAIMED,
        expected: "mstar workflow reopen",
      },
      {
        label: "failed",
        fixture: () => runFixture("failed", { bind: RUN_HOLDER, status: "failed" }),
        claimed: RUN_CLAIMED,
        expected: "mstar workflow reopen",
      },
    ];
    for (const entry of cases) {
      const { harness } = await entry.fixture();
      const result = await launchBound(harness, entry.claimed);
      expect(result, entry.label).toMatchObject({ command: "session.run", status: "refused", code: "session.run-unbound" });
      expect(recoveryOf(result), entry.label).toContain(entry.expected);
      expect(new Set(sessionIdsIn(result)), entry.label).toEqual(new Set([entry.claimed]));
    }
  });

  test("refuses a completed lifecycle without a bind or reopen route", async () => {
    const { harness } = await runFixture("completed", { bind: RUN_HOLDER, status: "completed" });
    const result = await launchBound(harness, RUN_CLAIMED);
    expect(result).toMatchObject({ status: "refused", code: "session.run-unbound", details: { state: "completed" } });
    const recovery = recoveryOf(result);
    expect(recovery).toContain("new lifecycle");
    expect(recovery).not.toContain("mstar plan bind");
    expect(recovery).not.toContain("mstar workflow reopen");
  });

  test("refuses a workflow the authority does not hold, naming registration", async () => {
    for (const harness of [await emptyStore(), absentStore()]) {
      const result = await launchBound(harness, RUN_CLAIMED);
      expect(result).toMatchObject({ status: "refused", code: "session.run-unbound" });
      expect(recoveryOf(result)).toContain("mstar workflow register");
    }
  });
});
