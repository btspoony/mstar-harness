import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CONTRACT_REVISION,
  NATIVE_ENDPOINT,
  NATIVE_MODEL,
  PACK_SCHEMA,
  PILOT_SCHEMA,
  TOKEN_POLICY_METHOD,
  TOKEN_RESERVATION_PER_ATTEMPT,
  assessShadowRun,
  buildA05Request,
  buildCandidatePairs,
  buildDockerLaunchArgs,
  buildShadowPack,
  canonicalJsonBytes,
  connectEvaluatorChannel,
  createEvaluatorMailbox,
  evaluateNative,
  freezeBaseline,
  recordWorkUnitDisposition,
  runReviewAdvice,
  runShadowSupervisor,
  validatePack,
  validatePilot,
} from "../../judgment/dist/index.js";
import { runShadowCommand } from "@mstar-harness/judgment/shadow";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const BUNDLE = join(REPO, "packages/cli/dist/mstar-harness.js");
const roots = [];
test.after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `judgment-package-${label}-`));
  roots.push(root);
  return root;
}

function envWithoutHarness() {
  const env = { ...process.env };
  for (const key of ["MSTAR_HARNESS_DIR", "MSTAR_CONTROL_ROOT", "SDD_DIR", "JEV_REQUESTS_DIR", "JEV_STATUS_PATH"]) delete env[key];
  return env;
}

function judgmentFixture(runId = "run-1") {
  const hash = "a".repeat(64);
  const pack = validatePack({
    schema: PACK_SCHEMA,
    contractRevision: CONTRACT_REVISION,
    runId,
    packId: "pack-1",
    concernId: "concern-1",
    profile: "review",
    scope: { kind: "review", reviewId: "review-1", snapshotSha256: hash, diffSha256: hash, tier: "default" },
    recipient: { id: "synthesis-main", phase: "synthesis" },
    sources: [{ id: "source-1", path: "src/example.ts", startLine: 1, endLine: 4, contentSha256: hash, observedInRunId: runId, basis: "seat-observation" }],
    state: {
      evidence: [
        { id: "evidence-left", sourceId: "source-1", excerpt: "left excerpt" },
        { id: "evidence-right", sourceId: "source-1", excerpt: "right excerpt" },
      ],
      subjects: [
        { id: "finding-left", kind: "finding", text: "left claim", evidenceIds: ["evidence-left"] },
        { id: "finding-right", kind: "finding", text: "right claim", evidenceIds: ["evidence-right"] },
      ],
    },
    tasks: [{ id: "task-1", useCase: "JEV-A05", subjectIds: ["finding-left", "finding-right"], workUnit: { id: "unit-1", revision: 2 } }],
    rubricVersion: "rubric-1",
    builderVersion: "builder-1",
  });
  const pilot = validatePilot({
    schema: PILOT_SCHEMA,
    contractRevision: CONTRACT_REVISION,
    pilotId: "pilot-1",
    runId,
    profile: "review",
    scope: { kind: "review", reviewId: "review-1", snapshotSha256: hash, diffSha256: hash },
    mode: "shadow",
    transport: "native-typesafe",
    endpoint: NATIVE_ENDPOINT,
    model: NATIVE_MODEL,
    useCases: ["JEV-A05"],
    recipients: [{ id: "synthesis-main", phase: "synthesis" }],
    policyVersion: "policy-1",
    permission: { ref: "permission-1", purpose: "synthetic qualification", dataClass: "synthetic-only" },
    isolation: { ref: "isolation-1" },
    packManifest: [{ packId: "pack-1", packSha256: createHash("sha256").update(canonicalJsonBytes(pack)).digest("hex") }],
    rubricVersion: "rubric-1",
    builderVersion: "builder-1",
    implementationVersion: "test-implementation",
    limits: {
      timeoutMs: 10_000,
      maxRunElapsedMs: 10_000_000,
      maxCallsPerRun: 1,
      maxConcurrentRequests: 1,
      maxTasksPerPack: 4,
      maxPacksPerRun: 1,
      maxPairs: 4,
      maxPackBytes: 65_536,
      maxRequestBytes: 32_768,
      maxResponseBytes: 65_536,
      maxAttempts: 1,
    },
    tokenPolicy: {
      method: TOKEN_POLICY_METHOD,
      perAttemptReservation: TOKEN_RESERVATION_PER_ATTEMPT,
      maxRunReservedInputTokens: TOKEN_RESERVATION_PER_ATTEMPT,
    },
    sourcePolicy: { minimization: "synthetic excerpts only", retention: "run-bound" },
    protocolVersion: "protocol-1",
    splitId: "split-1",
    calibrationId: "calibration-1",
  });
  return { pack, pilot, request: buildA05Request(pack, pilot) };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

test("unpacked CLI runs outside monorepo resolution and leaves disabled inputs untouched", () => {
  assert.ok(existsSync(BUNDLE), "build the CLI bundle before the packaging proof");
  const packageRoot = temporaryRoot("unpacked");
  const workspace = join(packageRoot, "workspace");
  mkdirSync(join(packageRoot, "package", "dist"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const unpacked = join(packageRoot, "package", "dist", "mstar-harness.js");
  cpSync(BUNDLE, unpacked);
  writeFileSync(join(packageRoot, "package", "package.json"), JSON.stringify({ type: "module", bin: { "mstar-harness": "dist/mstar-harness.js" } }));
  const proc = spawnSync(process.execPath, [unpacked, "judgment", "review-advice", "--file", "missing-pack.json", "--pilot", "missing-pilot.json"], {
    cwd: workspace,
    env: envWithoutHarness(),
    encoding: "utf8",
  });
  assert.equal(proc.status, 0, proc.stderr);
  assert.deepEqual(JSON.parse(proc.stdout), {
    schema: "mstar.judgment-cli/v1",
    contractRevision: CONTRACT_REVISION,
    status: "disabled",
    advice: null,
  });
  assert.equal(existsSync(join(workspace, ".jev-mailbox")), false);
  assert.equal(proc.stdout.trim().split("\n").length, 1);
});

test("SIGINT and SIGTERM cancel an active request and preserve process exit status", async () => {
  const { pack, pilot } = judgmentFixture();
  for (const [signal, expectedCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    const workspace = temporaryRoot(signal);
    const requestDirectory = join(workspace, "supervisor", "requests");
    const statusPath = join(workspace, "supervisor", "status.json");
    const preloadPath = join(workspace, "supervisor-mounts.cjs");
    mkdirSync(requestDirectory, { recursive: true });
    writeFileSync(statusPath, JSON.stringify({ schema: "mstar.judgment-status/v1", runId: "run-1", status: "idle" }));
    writeFileSync(preloadPath, [
      'const fs = require("node:fs");',
      'const { syncBuiltinESMExports } = require("node:module");',
      'const realpathSync = fs.realpathSync;',
      'fs.realpathSync = function (path, ...args) {',
      '  if (path === "/mnt/requests") path = process.env.JEV_TEST_REQUESTS_DIR;',
      '  if (path === "/mnt/status.json") path = process.env.JEV_TEST_STATUS_PATH;',
      '  return realpathSync.call(this, path, ...args);',
      '};',
      'syncBuiltinESMExports();',
    ].join("\n"));
    writeFileSync(join(workspace, ".mstarc"), "[config]\njev_mode=shadow\njev_transport=typesafe\n");
    writeFileSync(join(workspace, "pack.json"), JSON.stringify(pack));
    writeFileSync(join(workspace, "pilot.json"), JSON.stringify(pilot));
    const env = {
      ...envWithoutHarness(),
      JEV_REQUESTS_DIR: "/mnt/requests",
      JEV_STATUS_PATH: "/mnt/status.json",
      JEV_TEST_REQUESTS_DIR: requestDirectory,
      JEV_TEST_STATUS_PATH: statusPath,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath}`].filter(Boolean).join(" "),
    };
    const proc = spawn(process.execPath, [BUNDLE, "judgment", "review-advice", "--file", "pack.json", "--pilot", "pilot.json"], {
      cwd: workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    proc.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const closed = new Promise((resolveClose, rejectClose) => {
      proc.once("error", rejectClose);
      proc.once("close", (code) => resolveClose(code));
    });
    const deadline = Date.now() + 5_000;
    let requests = [];
    while (Date.now() < deadline) {
      requests = readdirSync(requestDirectory).filter((name) => name.endsWith(".json"));
      if (requests.length > 0) break;
      if (proc.exitCode !== null) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.equal(requests.length, 1, `CLI did not submit a request: ${JSON.stringify({ stdout, stderr, exitCode: proc.exitCode, signal: proc.signalCode })}`);
    assert.equal(JSON.parse(readFileSync(join(requestDirectory, requests[0]), "utf8")).schema, "mstar.judgment-request/v1");
    proc.kill(signal);
    assert.equal(await closed, expectedCode, stderr);
    const output = JSON.parse(stdout);
    assert.equal(output.status, "cancelled");
    assert.equal(output.code, "jev.review-cancelled");
    assert.equal(output.advice, null);
  }
});

test("judgment package exposes the required runtime and shadow entrypoint APIs", () => {
  for (const value of [
    buildCandidatePairs,
    buildShadowPack,
    connectEvaluatorChannel,
    createEvaluatorMailbox,
    runReviewAdvice,
    runShadowSupervisor,
    freezeBaseline,
    recordWorkUnitDisposition,
    assessShadowRun,
    buildDockerLaunchArgs,
    runShadowCommand,
  ]) assert.equal(typeof value, "function");
});

test("native evaluator context reports missing credentials and provider failure without returning advice", async () => {
  const root = temporaryRoot("evaluator");
  const contextFor = (runId) => {
    const { pack, pilot, request } = judgmentFixture(runId);
    const runDirectory = join(root, "evidence", runId);
    mkdirSync(runDirectory, { recursive: true });
    return {
      request,
      context: (overrides = {}) => ({
        pilot,
        pack,
        runDirectory: realpathSync(runDirectory),
        isCurrent: () => true,
        readCredential: async () => "synthetic-test-key",
        writeSealedResult: async () => "sealed-result",
        readSealedResult: async () => { throw new Error("no reusable result expected"); },
        ...overrides,
      }),
    };
  };
  const missingKey = contextFor("run-1");
  const providerFailure = contextFor("run-2");
  await expectCode(evaluateNative(missingKey.request, missingKey.context({ readCredential: async () => "" }), new AbortController().signal), "jev.credential-unavailable");
  await expectCode(evaluateNative(providerFailure.request, providerFailure.context({ sendRequest: async () => { throw new Error("provider unavailable"); } }), new AbortController().signal), "jev.evaluation-failed");
});
