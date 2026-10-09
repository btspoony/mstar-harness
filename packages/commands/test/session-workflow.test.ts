import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeExecutionSessionRef, initializeStore } from "@mstar-harness/engine";
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
    // The prepare-amendment family is a retired stub and publishes no `input`
    // payload contract; the surviving sparse-row payload validates as before.
    expect(definition("workflow.amend-prepare").payloads?.input).toBeUndefined();
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
    // The FILE-form recover-coordinator is a retired stub (T3b): the refusal is
    // the verb-retired stub, still redacting the malformed source bytes.
    expect(recovery).toMatchObject({ status: "refused", code: "workflow.verb-retired" });
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
  test("the retired coordinator recovery refuses without publishing a session transport", async () => {
    // T3b retired the FILE-form coordinator recovery to a refusing stub; the
    // ACTIVE replacement (`mstar session recover`) owns the runtime-identity
    // rule, so this verb publishes no `--session-id` context option.
    const recovery = definition("workflow.recover-coordinator");
    expect(recovery.cli.options ?? []).not.toContainEqual(expect.objectContaining({ key: "sessionId" }));
    const result = await recovery.execute({ sessionId: "child-agent-session", operationId: "recover-1" }, testContext());
    expect(result).toMatchObject({ status: "refused", code: "workflow.verb-retired" });
    expect(String(result.message)).toContain("mstar session recover");
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
