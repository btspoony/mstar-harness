import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { consultDeliveryEvidence, encodeExecutionSessionRef, initializeExecutionAuthority, initializeStore, readWorkflowSnapshot, WORKFLOW_SNAPSHOT_FILE } from "@mstar-harness/engine";
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
  test("workflow family sparse payload decode validates object and array intent payloads", () => {
    const amendment = definition("workflow.amend-prepare");
    const iteration = definition("iteration.register");
    expect(amendment.payloads?.input?.schema.safeParse({ append: [] }).success).toBe(true);
    expect(amendment.payloads?.input?.schema.safeParse([]).success).toBe(false);
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

    const attestation = path.join(context.cwd, "malformed-attestation.json");
    writeFileSync(attestation, `{"operator":${secret}}`);
    const recovery = await executeCommand("workflow.recover-coordinator", {
      session: path.join(context.cwd, "unused-session.json"),
      operationId: "recover-malformed",
      reason: "malformed proof",
      authorizationRef: "fixture-authorization",
      stopped: ["prior-session"],
      attestation,
    }, context);
    expect(recovery).toMatchObject({ status: "refused", code: "workflow.recover-coordinator.attestation-malformed" });
    expect(JSON.stringify(recovery)).not.toContain(secret);
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
  test("workflow.evidence FILE consumers preserve revision paths, member boundaries, and completion freeze rules", async () => {
    const context = testContext();
    const harnessDir = path.join(context.cwd, ".mstar");
    mkdirSync(harnessDir, { recursive: true });
    mkdirSync(path.join(harnessDir, "plans"), { recursive: true });
    for (const planId of ["plan-evidence-order", "plan-report-only", "plan-historical-done", "plan-frozen-done"]) {
      writeFileSync(path.join(harnessDir, "plans", `${planId}.md`), `**plan_id:** ${planId}\n`);
    }
    const store = await initializeStore({ harnessDir });
    store.close();
    const evidenceCommand = definition("workflow.evidence");
    const evidenceFile = path.join(context.cwd, "delivery.json");
    const snapshotDir = (id: string) => path.join(harnessDir, "workflows", id);
    const readSnapshot = (id: string) => readWorkflowSnapshot(snapshotDir(id)).snapshot;
    const record = async (workflow: string, delivery: unknown) => {
      writeFileSync(evidenceFile, JSON.stringify(delivery));
      return evidenceCommand.execute({ workflow, file: evidenceFile, harness: harnessDir }, context);
    };
    const close = (workflow: string) => definition("status.workflow-close").execute({
      workflow, harness: harnessDir, endedAt: "2026-10-08T00:00:00.000Z",
    }, context);
    // The FILE route's plan status is moved only by the coordinator's authorized
    // lifecycle operations; this fixture instead plants the initial condition
    // directly on disk, exactly as the sibling close/process fixtures do, so the
    // evidence consumer is exercised against a row already at Done.
    const markDone = (workflow: string) => {
      const dir = snapshotDir(workflow);
      const snapshot = readWorkflowSnapshot(dir).snapshot;
      writeFileSync(path.join(dir, WORKFLOW_SNAPSHOT_FILE), JSON.stringify({
        ...snapshot,
        plans: snapshot.plans.map((row) => ({ ...row, status: "Done" })),
      }));
    };

    const development = await definition("workflow.register").execute({
      workflow: "wf-evidence-order", planId: "plan-evidence-order", planTitle: "Evidence order",
      planFile: "plans/plan-evidence-order.md", deliveryKind: "development", branchSource: "feature/evidence-order",
      branchTarget: "main", harness: harnessDir,
    }, context);
    expect(development.status).toBe("ok");
    expect((await record("wf-evidence-order", { compound: { outcome: "created" } })).status).toBe("ok");
    const beforeInvalid = readSnapshot("wf-evidence-order").delivery;
    for (const invalid of [
      { compound: { outcome: "skipped" } },
      { compound: { outcome: "skipped", reason: "   " } },
      { compound: { outcome: "created", unrecognized: "must not be dropped" } },
      { pr: { repo: "owner/repo", head: "feature/evidence-order" } },
      { completion: { policy: "wrong-kind", evidence: "must not attach" } },
    ]) {
      expect((await record("wf-evidence-order", invalid)).status).toBe("refused");
      expect(readSnapshot("wf-evidence-order").delivery).toEqual(beforeInvalid);
    }
    expect((await record("wf-evidence-order", {
      compound: { outcome: "skipped", reason: "not applicable to this delivery" },
    })).status).toBe("ok");
    expect((await record("wf-evidence-order", {
      pr: { repo: "owner/repo", head: "feature/evidence-order", target: "main" },
    })).status).toBe("ok");
    const beforeChangedPr = readSnapshot("wf-evidence-order").delivery;
    const changedIdentity = await record("wf-evidence-order", {
      pr: { repo: "different/repo", head: "feature/evidence-order", target: "main" },
    });
    expect(changedIdentity).toMatchObject({ status: "refused", code: "coordination.invalid-transition" });
    expect(readSnapshot("wf-evidence-order").delivery).toEqual(beforeChangedPr);
    expect((await record("wf-evidence-order", { merge: { provider: "github", evidence: "confirmed merge receipt" } })).status).toBe("ok");
    await markDone("wf-evidence-order");
    expect((await record("wf-evidence-order", { compound: { outcome: "updated" } })).status).toBe("ok");
    expect((await record("wf-evidence-order", { merge: { provider: "github", evidence: "updated checked receipt" } })).status).toBe("ok");
    const developmentSnapshot = readSnapshot("wf-evidence-order");
    expect(developmentSnapshot.plans[0]?.status).toBe("Done");
    expect(developmentSnapshot.delivery).toEqual({
      compound: { outcome: "updated" },
      pr: { repo: "owner/repo", head: "feature/evidence-order", target: "main" },
      merge: { provider: "github", evidence: "updated checked receipt" },
    });

    const reportOnly = await definition("workflow.register").execute({
      workflow: "wf-report-only", planId: "plan-report-only", planTitle: "Report only",
      planFile: "plans/plan-report-only.md", deliveryKind: "verification/report-only",
      completionPolicy: "approval-v1", harness: harnessDir,
    }, context);
    expect(reportOnly.status).toBe("ok");
    expect((await record("wf-report-only", {
      completion: { policy: "approval-v0", evidence: "acceptance/report.md" },
    })).status).toBe("ok");
    await markDone("wf-report-only");
    const mismatchClose = await close("wf-report-only");
    expect(mismatchClose).toMatchObject({ status: "refused", code: "coordination.invalid-transition" });
    expect(readSnapshot("wf-report-only").status).toBe("running");
    expect((await record("wf-report-only", {
      completion: { policy: "approval-v1", evidence: "acceptance/report.md" },
    })).status).toBe("ok");
    expect(consultDeliveryEvidence(readSnapshot("wf-report-only"))).toEqual([]);
    expect((await close("wf-report-only")).status).toBe("ok");
    expect(readSnapshot("wf-report-only").status).toBe("completed");

    const frozen = await definition("workflow.register").execute({
      workflow: "wf-frozen-done", planId: "plan-frozen-done", planTitle: "Frozen completion",
      planFile: "plans/plan-frozen-done.md", deliveryKind: "verification/report-only",
      completionPolicy: "approval-v1", harness: harnessDir,
    }, context);
    expect(frozen.status).toBe("ok");
    expect((await record("wf-frozen-done", {
      completion: { policy: "approval-v1", evidence: "acceptance/frozen-report.md" },
    })).status).toBe("ok");
    await markDone("wf-frozen-done");
    const acceptedSnapshot = readSnapshot("wf-frozen-done");
    expect(await record("wf-frozen-done", {
      completion: { policy: "approval-v1", evidence: "acceptance/replacement-report.md" },
    })).toMatchObject({ status: "refused", code: "coordination.completion-frozen" });
    expect(readSnapshot("wf-frozen-done")).toEqual(acceptedSnapshot);

    const historical = await definition("workflow.register").execute({
      workflow: "wf-historical-done", planId: "plan-historical-done", planTitle: "Historical completion",
      planFile: "plans/plan-historical-done.md", deliveryKind: "verification/report-only",
      completionPolicy: "approval-v2", harness: harnessDir,
    }, context);
    expect(historical.status).toBe("ok");
    await markDone("wf-historical-done");
    expect((await record("wf-historical-done", {
      completion: { policy: "approval-v2", evidence: "acceptance/historical-report.md" },
    })).status).toBe("ok");
    expect(consultDeliveryEvidence(readSnapshot("wf-historical-done"))).toEqual([]);
    expect((await close("wf-historical-done")).status).toBe("ok");



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
    expect(result).toMatchObject({ status: "usage" });
    expect(String(result.message)).toContain("recovery requires the main conversation session identity");
    expect(String(result.message)).toContain("--session-id");
    expect(String(result.message)).toContain("sessionId");
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
