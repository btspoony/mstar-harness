import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { runShadowCommand } from "../scripts/shadow.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_REVISION, NATIVE_ENDPOINT, NATIVE_MODEL, PACK_SCHEMA, PILOT_SCHEMA, TOKEN_POLICY_METHOD, TOKEN_RESERVATION_PER_ATTEMPT, validatePack, validatePilot } from "../src/contracts.js";
import { canonicalJsonBytes } from "../src/review-advice.js";
import { assessShadowRun, buildDockerLaunchArgs, freezeBaseline, recordWorkUnitDisposition, runShadowSupervisor, type ApprovedChild, type ShadowMountPlan } from "../src/shadow-supervisor.js";

import { calibrationBaselineInventory, stageCalibrationSources } from "../scripts/evaluate.js";

const roots: string[] = [];
const hash = "a".repeat(64);
const fixturePath = new URL("./fixtures/reviewer-probe.mjs", import.meta.url).pathname;
function makeWritable(path: string): void {
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    if (lstatSync(child).isDirectory()) makeWritable(child);
    else chmodSync(child, 0o600);
  }
}
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "jev-supervisor-"));
  roots.push(root);
  for (const name of ["source", "runtime", "output", "requests", "scratch", "evaluator"]) mkdirSync(join(root, name));
  writeFileSync(join(root, "status.json"), "{}");
  return root;
}
function inputs(root: string, workerSource?: string) {
  const childPath = join(root, "reviewer-probe.mjs");
  copyFileSync(fixturePath, childPath);
  if (workerSource !== undefined) writeFileSync(childPath, workerSource);
  const sourceBytes = new TextEncoder().encode("literal source\nanother literal\n");
  mkdirSync(join(root, "source", "src"));
  writeFileSync(join(root, "source", "src", "example.ts"), sourceBytes);
  const pack = validatePack({
    schema: PACK_SCHEMA, contractRevision: CONTRACT_REVISION, runId: "run-1", packId: "pack-1", concernId: "concern-1", profile: "review",
    scope: { kind: "review", reviewId: "review-1", snapshotSha256: hash, diffSha256: hash, tier: "default" },
    recipient: { id: "synthesis-main", phase: "synthesis" },
    sources: [{ id: "source-1", path: "src/example.ts", startLine: 1, endLine: 2, contentSha256: createHash("sha256").update(sourceBytes).digest("hex"), observedInRunId: "run-1", basis: "seat-observation" }],
    state: { evidence: [{ id: "evidence-1", sourceId: "source-1", excerpt: "literal source" }, { id: "evidence-2", sourceId: "source-1", excerpt: "another literal" }], subjects: [{ id: "left", kind: "finding", text: "left", evidenceIds: ["evidence-1"] }, { id: "right", kind: "finding", text: "right", evidenceIds: ["evidence-2"] }] },
    tasks: [{ id: "task-1", useCase: "JEV-A05", subjectIds: ["left", "right"], workUnit: { id: "unit-1", revision: 1 } }], rubricVersion: "rubric-1", builderVersion: "builder-1",
  });
  const pilot = validatePilot({
    schema: PILOT_SCHEMA, contractRevision: CONTRACT_REVISION, pilotId: "pilot-1", runId: "run-1", profile: "review",
    scope: { kind: "review", reviewId: "review-1", snapshotSha256: hash, diffSha256: hash }, mode: "shadow", transport: "native-typesafe", endpoint: NATIVE_ENDPOINT, model: NATIVE_MODEL,
    useCases: ["JEV-A05"], recipients: [{ id: "synthesis-main", phase: "synthesis" }], policyVersion: "policy-1", permission: { ref: "permission-1", purpose: "component study", dataClass: "synthetic-only" }, isolation: { ref: "isolation-1" },
    packManifest: [{ packId: "pack-1", packSha256: createHash("sha256").update(canonicalJsonBytes(pack)).digest("hex") }], rubricVersion: "rubric-1", builderVersion: "builder-1", implementationVersion: "test-component",
    limits: { timeoutMs: 10_000, maxRunElapsedMs: 20_000, maxCallsPerRun: 1, maxConcurrentRequests: 1, maxTasksPerPack: 4, maxPacksPerRun: 1, maxPairs: 4, maxPackBytes: 65_536, maxRequestBytes: 32_768, maxResponseBytes: 65_536, maxAttempts: 1 },
    tokenPolicy: { method: TOKEN_POLICY_METHOD, perAttemptReservation: TOKEN_RESERVATION_PER_ATTEMPT, maxRunReservedInputTokens: TOKEN_RESERVATION_PER_ATTEMPT }, sourcePolicy: { minimization: "literal excerpt", retention: "run-bound" }, protocolVersion: "protocol-1", splitId: "split-1", calibrationId: "calibration-1",
  });
  const child: ApprovedChild = { id: "probe-1", executable: childPath, sha256: createHash("sha256").update(readFileSync(childPath)).digest("hex"), runtimePath: process.execPath, runtimeSha256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex"), imageDigest: "node@sha256:" + hash, containerExecutable: "/worker/reviewer-probe.mjs", uid: process.getuid(), gid: process.getgid(), argv: [], maxElapsedMs: 2_000, maxOutputBytes: 4_096 };
  const mountPlan: ShadowMountPlan = { syntheticSource: join(root, "source"), runtimeAssets: join(root, "runtime"), ordinaryOutput: join(root, "output"), requests: join(root, "requests"), publicStatus: join(root, "status.json"), scratch: join(root, "scratch"), evaluatorData: [join(root, "evaluator")], evaluatorCredentialEnv: [], readOnlyRoot: true, nonRoot: true, dropCapabilities: true, hostPid: false, dockerSocket: false };
  return { root, pack, pilot, child, mountPlan, baseline: { inventory: [{ id: "unit-1" }], seatOutputs: [{ unitId: "unit-1", outputId: "output-1" }], originalConsumption: { consumedOutputs: [{ unitId: "unit-1", outputId: "output-1", consumed: true, consumedAt: 1 }] }, finalReport: { status: "complete" } } };
}
const testLauncher = (child: ApprovedChild, runId: string) => spawn(process.execPath, [child.executable, ...child.argv, runId], { env: { PATH: process.env.PATH ?? "", HOME: process.cwd() }, stdio: ["ignore", "pipe", "pipe"] });
const containerOnlySkip = process.platform !== "linux";
afterEach(() => { for (const root of roots.splice(0)) { makeWritable(root); rmSync(root, { recursive: true, force: true }); } });

describe("trusted shadow supervisor", () => {
  test("default container argv enforces a nonroot offline boundary and exact mount rights", () => {
    const fixture = inputs(workspace());
    const args = buildDockerLaunchArgs(fixture.child, "run-1", fixture.mountPlan);
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--network=none");
    expect(args).toContain(`--user=${fixture.child.uid}:${fixture.child.gid}`);
    expect(args.some((arg) => arg === `--mount=type=bind,src=${fixture.mountPlan.syntheticSource},dst=/mnt/source,readonly`)).toBe(true);
    expect(args.some((arg) => arg === `--mount=type=bind,src=${fixture.mountPlan.runtimeAssets},dst=/mnt/source/.runtime,readonly`)).toBe(true);
    expect(args.some((arg) => arg.startsWith("--pid=") || arg.includes("docker.sock"))).toBe(false);
    expect(args.some((arg) => arg.startsWith("--env=") && arg.includes("TYPESAFE"))).toBe(false);
  });
  test("unconfigured exercise fails closed before launching a worker when supervisor mounts are absent", async () => {
    const fixture = inputs(workspace());
    writeFileSync(join(fixture.root, "study-manifest.json"), JSON.stringify({
      schema: "mstar.shadow-study/v1", runId: "run-1", evidenceClass: "synthetic-offline",
      pack: fixture.pack, pilot: fixture.pilot, child: fixture.child,
      mountPlan: { ...fixture.mountPlan, evaluatorData: [fixture.mountPlan.scratch] }, baseline: fixture.baseline,
    }));
    expect(await runShadowCommand(["exercise", "--root", fixture.root])).toBe(2);
    expect(() => readFileSync(join(fixture.root, "baseline.json"))).toThrow();
  });
  test("controlled responses require an explicit synthetic-offline exercise and never grant host authority", async () => {
    for (const [command, evidenceClass] of [["study", "synthetic-offline"], ["exercise", "component"], ["exercise", "named-host"]] as const) {
      const fixture = inputs(workspace());
      writeFileSync(join(fixture.root, "study-manifest.json"), JSON.stringify({
        schema: "mstar.shadow-study/v1", runId: "run-1", evidenceClass,
        pack: fixture.pack, pilot: fixture.pilot, child: fixture.child, mountPlan: fixture.mountPlan,
        baseline: fixture.baseline, controlledExercise: { schema: "mstar.shadow-controlled-exercise/v1", outcome: "same_cause" },
      }));
      expect(await runShadowCommand([command, "--root", fixture.root])).toBe(2);
      expect(() => readFileSync(join(fixture.root, "baseline.json"))).toThrow();
    }
  });

  test("one controlled mailbox request yields one valid lifecycle; duplicate worker events remain invalid", async () => {
    const worker = `
      import { randomUUID } from "node:crypto";
      import { writeFileSync, readFileSync } from "node:fs";
      import { join } from "node:path";
      const runId=process.argv.at(-1), id=randomUUID(), start=performance.now();
      const emit=(type)=>console.log(JSON.stringify({type,runId,at:performance.now()-start}));
      emit("start");emit("baseline-frozen");
      writeFileSync(join(process.env.JEV_REQUESTS_DIR,id+".json"),JSON.stringify({schema:"mstar.judgment-request/v1",requestId:id,runId,packBytes:process.env.JEV_PACK_BYTES,pilotDigest:process.env.JEV_PILOT_DIGEST}));
      emit("request");
      // Integration worker polls the real file mailbox; fake timers cannot advance the supervisor process.
      for(let i=0;i<200;i++){const {promise,resolve}=Promise.withResolvers();setTimeout(resolve,5);await promise;const s=JSON.parse(readFileSync(join(process.env.JEV_REQUESTS_DIR,"..","status.json"),"utf8"));if(s.requestId===id&&s.status==="recorded"){emit("complete");process.exit(0)}}
      process.exit(3);
    `;
    const fixture = inputs(workspace(), worker);
    writeFileSync(join(fixture.root, "study-manifest.json"), JSON.stringify({
      schema: "mstar.shadow-study/v1", runId: "run-1", evidenceClass: "synthetic-offline",
      pack: fixture.pack, pilot: fixture.pilot, child: fixture.child, mountPlan: fixture.mountPlan,
      baseline: fixture.baseline, controlledExercise: { schema: "mstar.shadow-controlled-exercise/v1", outcome: "same_cause" },
    }));
    expect(await runShadowCommand(["exercise", "--root", fixture.root])).toBe(0);
    const assessment = JSON.parse(readFileSync(join(fixture.root, "assessment.json"), "utf8"));
    expect(assessment.evidenceClass).toBe("synthetic-offline");
    expect(assessment.qualification).toBe("synthetic-offline");
    expect(assessment.w5).toBe(false);
    expect(assessment.receipts[0]).toMatchObject({ owner: "original", jevWorkCredit: 0 });
    expect(assessment.failures).toEqual([]);
    expect(assessment.childEvents.map((event: { type: string }) => event.type)).toEqual(["start", "baseline-frozen", "request", "complete"]);
    expect(assessShadowRun({
      baseline: JSON.parse(readFileSync(join(fixture.root, "baseline.json"), "utf8")),
      receipts: assessment.receipts, childEvents: [...assessment.childEvents, assessment.childEvents.at(-1)],
      evidenceClass: "synthetic-offline", elapsedMs: assessment.metrics.elapsedMs, packId: fixture.pack.packId,
      packSha256: createHash("sha256").update(canonicalJsonBytes(fixture.pack)).digest("hex"),
      scopeSha256: createHash("sha256").update(canonicalJsonBytes(fixture.pack.scope)).digest("hex"),
      requiredUnitIds: ["unit-1"], originalConsumption: fixture.baseline.originalConsumption,
      originalSeatOutputs: fixture.baseline.seatOutputs,
    }).failures).toContain("probe-lifecycle-invalid");
  });

  test.skipIf(containerOnlySkip)("freezes baseline before real probe child and reports component-only measured events (requires Linux container /mnt mounts and /proc)", async () => {
    const args = inputs(workspace());
    const result = await runShadowSupervisor({ ...args, runRoot: args.root, runId: "run-1", evidenceClass: "component", baseline: args.baseline }, undefined, testLauncher);
    expect(result.failures).toContain("probe-lifecycle-invalid"); // Confinement probe has no recorded provider response.
    expect(result.evidenceClass).toBe("component");
    expect(result.w5).toBe(false);
    expect(result.metrics.childEvents).toBe(4);
    expect(result.metrics.completedUnits).toBe(1);
    expect(result.receipts[0]?.jevWorkCredit).toBe(0);
    expect(result.childEvents.map((event) => event.type)).toEqual(["start", "baseline-frozen", "request", "complete"]);
  });

  test("rejects early reveal, foreign run identity, forbidden mounts, and named-host evidence", async () => {
    const root = workspace();
    const early = inputs(root, `const runId=process.argv.at(-1); for (const type of ["start","request","baseline-frozen","complete"]) console.log(JSON.stringify({type,runId,at:1}));`);
    const earlyResult = await runShadowSupervisor({ ...early, runRoot: root, runId: "run-1", evidenceClass: "component", baseline: early.baseline }, undefined, testLauncher);
    expect(earlyResult.failures).toContain("jev.early-reveal-rejected");
    await expect(runShadowSupervisor({ ...early, runRoot: root, runId: "foreign", evidenceClass: "component", baseline: early.baseline })).rejects.toThrow("jev.run-source-authority-invalid");
    await expect(runShadowSupervisor({ ...early, runRoot: root, runId: "run-1", evidenceClass: "named-host", baseline: early.baseline })).rejects.toThrow("jev.run-authority-invalid");
    await expect(runShadowSupervisor({ ...early, runRoot: root, runId: "run-1", evidenceClass: "component", baseline: early.baseline, mountPlan: { ...early.mountPlan, evaluatorData: [early.mountPlan.scratch] } })).rejects.toThrow("jev.evaluator-data-mounted");
  });

  test("records cancellation and child errors without reclassifying component as W5", async () => {
    const root = workspace();
    const slow = inputs(root, `const runId=process.argv.at(-1); console.log(JSON.stringify({type:"start",runId,at:1})); setTimeout(()=>process.exit(0),1000);`);
    const controller = new AbortController();
    const pending = runShadowSupervisor({ ...slow, runRoot: root, runId: "run-1", evidenceClass: "component", baseline: slow.baseline, signal: controller.signal }, controller.signal, testLauncher);
    // This integration boundary deliberately aborts a real child process rather than a mocked clock.
    setTimeout(() => controller.abort(), 30);
    const cancelled = await pending;
    expect(cancelled.w5).toBe(false);
    expect(cancelled.failures).toContain("probe-lifecycle-invalid");
    expect(cancelled.childEvents.some((event) => event.type === "cancelled" || event.type === "error")).toBe(true);
    const brokenRoot = workspace();
    const broken = inputs(brokenRoot, "process.exit(7);");
    const childError = await runShadowSupervisor({ ...broken, runRoot: brokenRoot, runId: "run-1", evidenceClass: "component", baseline: broken.baseline }, undefined, testLauncher);
    expect(childError.failures).toContain("probe-child-exit-7");
    expect(childError.w5).toBe(false);
    expect(() => assessShadowRun({ baseline: freezeBaseline({ runId: "run-1", ...slow.baseline }), receipts: [], childEvents: [], evidenceClass: "named-host", elapsedMs: 1, packId: "pack-1", packSha256: hash, scopeSha256: hash, requiredUnitIds: [], originalConsumption: slow.baseline.originalConsumption, originalSeatOutputs: slow.baseline.seatOutputs })).toThrow("jev.named-host-authorization-required");
    expect(() => recordWorkUnitDisposition({ runId: "run-1", unitId: "unit-1", packId: "pack-1", packSha256: hash, scopeSha256: hash, disposition: "completed", originalConsumption: null })).toThrow("jev.original-consumption-required");
  });
  test.skipIf(containerOnlySkip)("assessment refuses failed or mismatched study results and failure event streams (requires Linux container /mnt mounts and /proc)", async () => {
    const failed = inputs(workspace(), "process.exit(7);");
    writeFileSync(join(failed.root, "study-manifest.json"), JSON.stringify({ schema: "mstar.shadow-study/v1", runId: "run-1", evidenceClass: "component", pack: failed.pack, pilot: failed.pilot, child: failed.child, mountPlan: failed.mountPlan, baseline: failed.baseline }));
    expect(await runShadowCommand(["study", "--root", failed.root], testLauncher)).toBe(1);
    expect(await runShadowCommand(["assess", "--root", failed.root])).toBe(2);

    const mismatched = inputs(workspace());
    writeFileSync(join(mismatched.root, "study-manifest.json"), JSON.stringify({ schema: "mstar.shadow-study/v1", runId: "run-1", evidenceClass: "component", pack: mismatched.pack, pilot: mismatched.pilot, child: mismatched.child, mountPlan: mismatched.mountPlan, baseline: mismatched.baseline }));
    expect(await runShadowCommand(["study", "--root", mismatched.root], testLauncher)).toBe(0);
    const studyResult = JSON.parse(readFileSync(join(mismatched.root, "study-result.json"), "utf8"));
    rmSync(join(mismatched.root, "study-result.json"));
    writeFileSync(join(mismatched.root, "study-result.json"), JSON.stringify({ ...studyResult, runId: "foreign-run" }));
    expect(await runShadowCommand(["assess", "--root", mismatched.root])).toBe(2);

    const validBaseline = freezeBaseline({ runId: "run-1", ...mismatched.baseline });
    const invalidEvents = [
      { type: "baseline-frozen" as const, at: 0, runId: "run-1" },
      { type: "start" as const, at: 1, runId: "run-1" },
      { type: "baseline-frozen" as const, at: 2, runId: "run-1" },
      { type: "request" as const, at: 3, runId: "run-1" },
      { type: "error" as const, at: 4, runId: "run-1" },
    ];
    expect(assessShadowRun({ baseline: validBaseline, receipts: [], childEvents: invalidEvents, evidenceClass: "component", elapsedMs: 1 }).failures).toContain("probe-lifecycle-invalid");
  });

  test.skipIf(containerOnlySkip)("finite study and assess commands consume child artifacts (requires Linux container /mnt mounts and /proc)", async () => {
    const fixture = inputs(workspace());
    writeFileSync(join(fixture.root, "study-manifest.json"), JSON.stringify({ schema: "mstar.shadow-study/v1", runId: "run-1", evidenceClass: "component", pack: fixture.pack, pilot: fixture.pilot, child: fixture.child, mountPlan: fixture.mountPlan, baseline: fixture.baseline }));
    expect(await runShadowCommand(["study", "--root", fixture.root], testLauncher)).toBe(0);
    expect(await runShadowCommand(["assess", "--root", fixture.root])).toBe(0);
  });
  test("calibration inventory uses the assessor's required id field", () => {
    const fixture = inputs(workspace());
    const inventory = calibrationBaselineInventory(fixture.pack.tasks[0]!.workUnit.id);
    expect(inventory).toEqual([{ id: "unit-1", synthetic: true }]);
    const baseline = freezeBaseline({ runId: "run-1", ...fixture.baseline, inventory });
    expect(() => assessShadowRun({
      baseline, receipts: [], childEvents: [], evidenceClass: "synthetic-offline", elapsedMs: 1,
      packId: "pack-1", packSha256: hash, scopeSha256: hash, requiredUnitIds: [],
      originalConsumption: fixture.baseline.originalConsumption, originalSeatOutputs: fixture.baseline.seatOutputs,
    })).not.toThrow();
    expect(() => assessShadowRun({
      baseline: freezeBaseline({ runId: "run-1", ...fixture.baseline, inventory: [{ unitId: "unit-1", synthetic: true }] }),
      receipts: [], childEvents: [], evidenceClass: "synthetic-offline", elapsedMs: 1,
      packId: "pack-1", packSha256: hash, scopeSha256: hash, requiredUnitIds: ["unit-1"],
      originalConsumption: fixture.baseline.originalConsumption, originalSeatOutputs: fixture.baseline.seatOutputs,
    })).toThrow("jev.baseline-inventory-invalid");
  });

  test("does not assess a frozen inventory unit omitted from the pack as complete", () => {
    const fixture = inputs(workspace());
    const baseline = freezeBaseline({
      runId: "run-1",
      ...fixture.baseline,
      inventory: [{ id: "unit-1" }, { id: "unit-2" }],
    });
    const assessment = assessShadowRun({
      baseline,
      receipts: [recordWorkUnitDisposition({
        runId: "run-1", unitId: "unit-1", packId: "pack-1", packSha256: hash,
        scopeSha256: hash, disposition: "completed",
        originalConsumption: fixture.baseline.originalConsumption.consumedOutputs[0],
      })],
      childEvents: [],
      evidenceClass: "synthetic-offline",
      elapsedMs: 1,
      packId: "pack-1",
      packSha256: hash,
      scopeSha256: hash,
      requiredUnitIds: ["unit-1"],
      originalConsumption: fixture.baseline.originalConsumption,
      originalSeatOutputs: fixture.baseline.seatOutputs,
    });
    expect(assessment.metrics).toMatchObject({ workUnits: 2, incompleteUnits: 1 });
    expect(assessment.failures).toContain("jev.receipt-accounting-incomplete");
  });

  test("stages citation files separately from the readonly runtime-asset mount", async () => {
    const worker = `const runId=process.argv.at(-1); for (const type of ["start","baseline-frozen","request","complete"]) console.log(JSON.stringify({type,runId,at:Date.now()}));`;
    const fixture = inputs(workspace(), worker);
    const calibrationSource = join(fixture.root, "calibration-source");
    mkdirSync(calibrationSource);
    stageCalibrationSources(calibrationSource, fixture.pack.sources, {
      "src/example.ts": { text: "literal source\nanother literal\n" },
    });
    const mountPlan = { ...fixture.mountPlan, syntheticSource: calibrationSource };
    for (const name of ["worker.mjs", "mstar-harness.js", "pack.json", "pilot.json"]) {
      writeFileSync(join(fixture.mountPlan.runtimeAssets, name), name);
    }
    let launcherObserved = false;
    const launcher = (child: ApprovedChild, runId: string, plan: ShadowMountPlan) => {
      expect(readFileSync(join(plan.syntheticSource, "src", "example.ts"), "utf8")).toBe("literal source\nanother literal\n");
      expect(readdirSync(plan.syntheticSource).sort()).toEqual([".runtime", "src"]);
      expect(["worker.mjs", "mstar-harness.js", "pack.json", "pilot.json"].every((name) =>
        readFileSync(join(plan.runtimeAssets, name), "utf8") === name)).toBe(true);
      launcherObserved = true;
      return testLauncher(child, runId);
    };
    await runShadowSupervisor({
      ...fixture, mountPlan, runRoot: fixture.root, runId: "run-1", evidenceClass: "component",
      baseline: fixture.baseline,
    }, undefined, launcher);
    expect(launcherObserved).toBe(true);
  });
  test("refuses a traversal citation before writing outside the calibration source root", () => {
    const fixture = inputs(workspace());
    const sourceDir = join(fixture.root, "calibration-source");
    const escapedPath = join(fixture.root, "escaped.txt");
    mkdirSync(sourceDir);
    expect(() => stageCalibrationSources(sourceDir, fixture.pack.sources.map((source) => ({ ...source, path: "../escaped.txt" })), {
      "../escaped.txt": { text: "outside source root" },
    })).toThrow("jev.calibration-source-path-outside-root");
    expect(existsSync(escapedPath)).toBe(false);
  });

  test("bounded source view rejects an unmanifested file", async () => {
    const fixture = inputs(workspace());
    writeFileSync(join(fixture.root, "source", "extra.txt"), "not authorized");
    await expect(runShadowSupervisor({
      ...fixture, runRoot: fixture.root, runId: "run-1", evidenceClass: "component",
      baseline: fixture.baseline,
    }, undefined, testLauncher)).rejects.toThrow("jev.source-manifest-extra-file");
  });
});
