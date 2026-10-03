import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeExecutionSessionRef, initializeExecutionAuthority, initializeStore } from "@mstar-harness/engine";
import { getCommandDefinitions } from "../src/index.js";
import type { CommandEffects, InvocationContext } from "../src/types.js";

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
  test("workflow family sparse payload decode validates object and array intent payloads", () => {
    const amendment = definition("workflow.amend-prepare");
    const iteration = definition("iteration.register");
    expect(amendment.payloads?.input?.schema.safeParse({ append: [] }).success).toBe(true);
    expect(amendment.payloads?.input?.schema.safeParse([]).success).toBe(false);
    expect(iteration.payloads?.row?.schema.safeParse([{ id: "plan-a" }]).success).toBe(true);
    expect(iteration.payloads?.row?.schema.safeParse({ id: "plan-a" }).success).toBe(false);
  });
  test("pathname fields carry no payload descriptor, so a file path is never parsed as JSON", () => {
    // `--file` is an absolute pathname on every workflow verb. A descriptor
    // bound to it would make the shared CLI decoder `JSON.parse` the path and
    // reject ordinary paths as invalid JSON, so the field must not appear —
    // while the genuine document-valued fields keep theirs.
    for (const id of ["workflow.evidence", "workflow.execution-policy"]) {
      const command = definition(id);
      expect(command.payloads).toBeDefined();
      expect(command.payloads).not.toHaveProperty("file");
      expect(command.cli.options.some((option) => option.key === "file")).toBe(true);
    }
  });

  test("evidence before Done is accepted through the workflow command", async () => {
    const context = testContext();
    const harnessDir = path.join(context.cwd, ".mstar");
    mkdirSync(harnessDir, { recursive: true });
    mkdirSync(path.join(harnessDir, "plans"), { recursive: true });
    writeFileSync(path.join(harnessDir, "plans", "plan-evidence-order.md"), "**plan_id:** plan-evidence-order\n");
    const store = await initializeStore({ harnessDir });
    store.close();
    const registered = await definition("workflow.register").execute({
      workflow: "wf-evidence-order", planId: "plan-evidence-order", planTitle: "Evidence order",
      planFile: "plans/plan-evidence-order.md", deliveryKind: "development", branchSource: "feature/evidence-order",
      branchTarget: "main", harness: harnessDir,
    }, context);
    expect(registered).toMatchObject({ status: "ok" });

    const evidenceFile = path.join(context.cwd, "delivery.json");
    writeFileSync(evidenceFile, JSON.stringify({ compound: { outcome: "created" } }));
    const recorded = await definition("workflow.evidence").execute({
      workflow: "wf-evidence-order", file: evidenceFile, harness: harnessDir,
    }, context);
    expect(recorded.status).toBe("ok");
    const snapshot = JSON.parse(readFileSync(path.join(harnessDir, "workflows", "wf-evidence-order", "snapshot.json"), "utf8"));
    expect(snapshot.delivery).toEqual({ compound: { outcome: "created" } });
    expect(snapshot.plans[0].status).not.toBe("Done");
  });


  test("session.run launches argv without a shell and preserves child output and exit status", async () => {
    const context = testContext();
    const result = await definition("session.run").execute({ workflow: "wf-smoke", role: "coordinator", argv: [process.execPath, "-e", "const i=JSON.parse(process.env.MSTAR_EXECUTION_IDENTITY); process.stdout.write((process.env.MSTAR_HOST_SESSION_ID === undefined ? 'clean' : 'stale') + ':' + i.source + ':' + i.role); process.exit(124)" ] }, context);
    expect(result).toMatchObject({ status: "error", exitCode: 124, code: "session.child-exit", details: { stdout: "clean:local:coordinator" } });
  });

  test("session.run carries a real child signal in the result envelope", async () => {
    const context = testContext();
    const result = await definition("session.run").execute({ workflow: "wf-signal", role: "coordinator", argv: [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"] }, context);
    expect(result).toMatchObject({ status: "error", exitCode: 143, code: "session.child-exit", details: { signal: "SIGTERM" } });
  });

  test("workflow references cannot be re-scoped to a different workflow", async () => {
    const wire = encodeExecutionSessionRef({ storeId: "00000000-0000-4000-8000-000000000000", epoch: 1, workflowId: "wf-other", role: "coordinator", sessionId: "other-session", planId: null });
    const result = await definition("workflow.phase").execute({ workflow: "wf-target", sessionRef: wire, expect: "token", operation: "op", phase: "phase-1", compass: "/tmp/compass.md" }, testContext({ sessionId: "main-session" }));
    expect(result.status).toBe("usage");
  });

  test("session.recover requires the runtime main-conversation identity", async () => {
    const context = testContext();
    const result = await definition("session.recover").execute({ workflow: "wf-recovery", sessionId: "child-agent-session", priorSession: "stopped", reason: "reload", attestation: "/tmp/wf-recovery-attestation.json", expect: "stale-token", operation: "recover-1" }, context);
    expect(result).toMatchObject({ status: "usage", message: "active recovery requires the main conversation session identity" });
  });
  test("workflow recovery requires the runtime main-session identity, not a request-supplied session", async () => {
    const recovery = definition("workflow.recover-coordinator");
    const input = {
      session: "/tmp/prior-coordinator.json",
      sessionId: "child-agent-session",
      operationId: "recover-1",
      reason: "the prior session stopped",
      authorizationRef: "approval-1",
      stopped: ["prior-coordinator"],
    };
    expect(recovery.input.parse(input)).not.toHaveProperty("sessionId");
    expect(recovery.cli.options).toContainEqual({
      key: "sessionId",
      flags: "--session-id <value>",
      required: false,
      context: "sessionId",
    });
    expect(recovery.input.parse(input)).not.toHaveProperty("sessionId");

    const result = await recovery.execute(input, testContext());
    expect(result).toMatchObject({
      status: "usage",
      message: "recovery requires the main conversation session identity",
    });
  });


  test("pre-activation registration refuses on an active execution authority", async () => {
    const context = testContext();
    const harnessDir = path.join(context.cwd, ".mstar");
    mkdirSync(harnessDir, { recursive: true });
    const store = await initializeStore({ harnessDir });
    store.close();
    await initializeExecutionAuthority({ harnessDir });
    const result = await definition("workflow.register").execute({
      workflow: "wf-active", planId: "plan-active", planTitle: "Active plan", planFile: "plans/plan-active.md",
      deliveryKind: "development", harness: harnessDir,
    }, context);
    expect(result).toMatchObject({ status: "refused", code: "execution.consumer-not-ready" });
  });
});
