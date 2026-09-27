import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { getSddCommandDefinitions, type CommandEnvelope, type InvocationContext } from "@mstar-harness/commands";
import { validateSddEvidenceRecord, type SddEvidenceRecord } from "@mstar-harness/engine";
import { createMcpEffects } from "../src/effects.js";

const processRequest = (cwd: string, signal: AbortSignal, argv: readonly string[], stdin?: string) => ({
  argv,
  cwd,
  env: process.env as Record<string, string>,
  signal,
  ...(stdin === undefined ? {} : { stdin }),
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function evidenceFixture(root: string) {
  const primary = path.join(root, "primary");
  mkdirSync(primary);
  git(primary, "init", "-q");
  git(primary, "checkout", "-q", "-b", "main");
  git(primary, "config", "user.email", "mcp-evidence-test@example.com");
  git(primary, "config", "user.name", "MCP Evidence Test");
  writeFileSync(path.join(primary, "source.txt"), "source\n");
  git(primary, "add", ".");
  git(primary, "commit", "-q", "-m", "fixture");

  const control = path.join(root, "control");
  const feature = path.join(root, "feature");
  git(primary, "worktree", "add", "-q", "-b", "control/plan", control);
  git(primary, "worktree", "add", "-q", "-b", "feature/plan", feature);
  const controlRoot = path.join(control, ".mstar");
  const planFile = path.join(controlRoot, "plans", "plan.md");
  const sddDir = path.join(controlRoot, "sdd", "plan");
  mkdirSync(path.dirname(planFile), { recursive: true });
  mkdirSync(sddDir, { recursive: true });
  writeFileSync(planFile, "# Evidence fixture\n");
  const requestPath = path.join(root, "capture-request.json");
  writeFileSync(requestPath, JSON.stringify({
    context: { planId: "plan", controlHarnessRoot: controlRoot, featureCwd: feature, workingBranch: "feature/plan", planFile, sddDir },
    taskId: "task-1",
    coverage: {
      acIds: ["AC-1"], behavior: "capture child output", declaration: "reviewed",
      sourceRationale: "source declared", dependencyRationale: "none required",
      runtimeRationale: "node child", environmentRationale: "CI explicitly recorded",
    },
    inputs: [{ path: "source.txt", kind: "file", purpose: "source" }],
    environmentKeys: ["CI"],
  }));
  const targetPath = path.join(root, "target-request.json");
  writeFileSync(targetPath, JSON.stringify({
    cwd: feature,
    expectedHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: feature, encoding: "utf8" }).trim(),
    rationale: "exercise MCP target assessment",
  }));
  return { feature, controlRoot, sddDir, requestPath, targetPath };
}

test("MCP process effects preserve bounded stdin, normal exit and cancellation", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mcp-effects-"));
  try {
    const effects = createMcpEffects([]);
    const completed = await effects.spawn(processRequest(cwd, new AbortController().signal, [process.execPath, "-e", "process.stdin.on('data', d => process.stdout.write(d)); process.stdin.on('end', () => process.stderr.write('done'))"], "payload"));
    assert.deepEqual(completed, { exitCode: 0, signal: null, stdout: "payload", stderr: "done" });

    const exactExit = await effects.spawn(processRequest(cwd, new AbortController().signal, [process.execPath, "-e", "process.exit(127)"]));
    assert.equal(exactExit.exitCode, 127);
    const reservedExit = await effects.spawn(processRequest(cwd, new AbortController().signal, [process.execPath, "-e", "process.exit(124)"]));
    assert.equal(reservedExit.exitCode, 124);
    await assert.rejects(effects.spawn(processRequest(cwd, new AbortController().signal, [process.execPath, "-e", "process.stdout.write(Buffer.alloc(1024 * 1024 + 1))"])), (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, "command.effect-unavailable");
      return true;
    });

    const controller = new AbortController();
    const pending = effects.spawn(processRequest(cwd, controller.signal, [process.execPath, "-e", "setInterval(() => {}, 1000)"]));
    setTimeout(() => controller.abort(), 30);
    const cancelled = await pending;
    assert.equal(cancelled.exitCode, 143);
    assert.equal(cancelled.signal, "SIGTERM");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("MCP process effects surface missing executable as exact child exit 127", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mcp-effects-"));
  try {
    const effects = createMcpEffects([]);
    await assert.rejects(effects.spawn(processRequest(cwd, new AbortController().signal, [path.join(cwd, "missing-child")])), (error: NodeJS.ErrnoException & { exitCode?: number }) => {
      assert.equal(error.code, "process.not-found");
      assert.equal(error.exitCode, 127);
      return true;
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("MCP stdin reads a request-local payload once and rejects absent input", async () => {
  const effects = createMcpEffects([]);
  const request = { cwd: process.cwd(), signal: new AbortController().signal };
  await effects.withInput({ input: "explicit payload" }, request, async () => {
    assert.equal(await effects.readInput(), "explicit payload");
    await assert.rejects(effects.readInput(), /only be consumed once/);
  });
  await effects.withInput({}, request, async () => assert.rejects(effects.readInput(), /explicit input string/));
});

test("MCP evidence capture gates the bound context, writes bounded logs and verifies read-only", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "mcp-evidence-"));
  const featureCwdBefore = process.cwd();
  try {
    const fixture = evidenceFixture(root);
    const effects = createMcpEffects([]);
    const signal = new AbortController().signal;
    const invocation: InvocationContext = {
      cwd: fixture.feature,
      controlRoot: null,
      versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
      signal,
      effects,
    };
    const definitions = getSddCommandDefinitions();
    const captureDefinition = definitions.find(({ id }) => id === "sdd.evidence.capture");
    const verifyDefinition = definitions.find(({ id }) => id === "sdd.evidence.verify");
    assert.ok(captureDefinition && verifyDefinition);
    const execute = (definition: NonNullable<typeof captureDefinition>, input: Record<string, unknown>, cwd = fixture.feature): Promise<CommandEnvelope> => {
      const requestContext: InvocationContext = { ...invocation, cwd };
      return effects.withInput(input, requestContext, () => definition.execute(input, requestContext));
    };

    const captureEnvelope = await execute(captureDefinition, {
      request: fixture.requestPath,
      argv: [process.execPath, "-e", "process.stdout.write('captured'); process.stderr.write('warning')"],
    });
    assert.equal(captureEnvelope.status, "ok", JSON.stringify(captureEnvelope));
    const captured = captureEnvelope.data as { exitCode: number; runDir: string; record: SddEvidenceRecord };
    assert.equal(captured.exitCode, 0);
    assert.equal(captured.record.state, "finished");
    assert.equal(validateSddEvidenceRecord(captured.record).ok, true);
    assert.equal(captured.record.logs.stdout.bytes, Buffer.byteLength("captured"));
    assert.equal(captured.record.logs.stderr.bytes, Buffer.byteLength("warning"));
    assert.equal(readFileSync(path.join(captured.runDir, "stdout.log"), "utf8"), "captured");
    assert.equal(readFileSync(path.join(captured.runDir, "stderr.log"), "utf8"), "warning");
    assert.equal(captured.record.before.stable, false);
    assert.deepEqual(captured.record.before.unknowns, ["MCP capture does not collect repository or declared-input snapshots"]);

    const recordPath = path.join(captured.runDir, "record.json");
    const recordBytes = readFileSync(recordPath);
    const stdoutBytes = readFileSync(path.join(captured.runDir, "stdout.log"));
    const verifyEnvelope = await execute(verifyDefinition, {
      sddDir: fixture.sddDir, plan: "plan", task: "task-1", run: captured.record.runId,
    });
    assert.equal(verifyEnvelope.status, "ok");
    const verified = verifyEnvelope.data as { integrity: { ok: boolean }; outcome: string; applicability: string };
    assert.equal(verified.integrity.ok, true);
    assert.equal(verified.outcome, "passed");
    assert.equal(verified.applicability, "not-assessed");
    assert.deepEqual(readFileSync(recordPath), recordBytes);
    assert.deepEqual(readFileSync(path.join(captured.runDir, "stdout.log")), stdoutBytes);
    const targetEnvelope = await execute(verifyDefinition, {
      sddDir: fixture.sddDir, plan: "plan", task: "task-1", run: captured.record.runId, target: fixture.targetPath,
    });
    assert.equal(targetEnvelope.status, "refused");
    assert.equal(targetEnvelope.code, "sdd.evidence.assessment-failed");
    assert.equal((targetEnvelope.details as { applicability: string }).applicability, "uncertain");

    const failedEnvelope = await execute(captureDefinition, {
      request: fixture.requestPath, argv: [process.execPath, "-e", "process.exit(3)"],
    });
    assert.equal(failedEnvelope.status, "error");
    assert.equal(failedEnvelope.exitCode, 3);
    const failedData = failedEnvelope.details as { runDir: string; record: { runId: string; outcome: { kind: string; code?: number } } };
    assert.equal(failedData.record.outcome.kind, "exit");
    assert.equal(failedData.record.outcome.code, 3);
    const failedVerify = await execute(verifyDefinition, {
      sddDir: fixture.sddDir, plan: "plan", task: "task-1", run: failedData.record.runId,
    });
    assert.equal(failedVerify.status, "ok");
    if (failedVerify.status !== "ok") assert.fail("evidence verification envelope must be successful");
    const failedVerifyData = failedVerify.data as { integrity: { ok: boolean }; outcome: string };
    assert.equal(failedVerifyData.integrity.ok, true);
    assert.equal(failedVerifyData.outcome, "failed");
    const boundedEnvelope = await execute(captureDefinition, {
      request: fixture.requestPath,
      argv: [process.execPath, "-e", "process.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1, 97))"],
    });
    assert.equal(boundedEnvelope.status, "error");
    const bounded = boundedEnvelope.details as { runDir: string; record: SddEvidenceRecord };
    assert.equal(bounded.record.logs.stdout.bytes, 8 * 1024 * 1024);
    assert.equal(bounded.record.logs.stdout.truncated, true);
    assert.equal(readFileSync(path.join(bounded.runDir, "stdout.log")).byteLength, 8 * 1024 * 1024);


    const blocked = await execute(captureDefinition, {
      request: fixture.requestPath, argv: [process.execPath, "-e", "process.stdout.write('must not launch')"],
    }, root);
    assert.equal(blocked.status, "refused");
    assert.match(blocked.message, /refused/);
    assert.equal(existsSync(path.join(fixture.sddDir, "evidence")) && readdirSync(path.join(fixture.sddDir, "evidence")).length, 3);
  } finally {
    process.chdir(featureCwdBefore);
    rmSync(root, { recursive: true, force: true });
  }
});
