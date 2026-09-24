import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { buildA05Request, canonicalJsonBytes } from "./review-advice.js";
import { createEvaluatorMailbox } from "./evaluator-channel.js";
import { evaluateNative, type EvaluatorContext, type JudgmentResult } from "./runtime.js";
import { validatePack, validatePilot, type JudgmentPilot, type ReviewDecisionPack } from "./contracts.js";
import { assessShadowRun, freezeBaseline, recordWorkUnitDisposition } from "./shadow-receipts.js";
import type { EvidenceClass, FrozenBaseline, FrozenShadowEvidence, ProbeEvent, ShadowRunAssessment, WorkUnitReceipt } from "./shadow-receipts.js";
import type { NativeTransportInput, NativeTransportResult } from "./typesafe.js";
export { assessShadowRun, freezeBaseline, recordWorkUnitDisposition } from "./shadow-receipts.js";
export type { BaselineFreezeInput, EvidenceClass, FrozenBaseline, FrozenShadowEvidence, ProbeEvent, ShadowRunAssessment, WorkUnitDispositionInput, WorkUnitReceipt } from "./shadow-receipts.js";

export type ShadowMountPlan = Readonly<{
  syntheticSource: string;
  ordinaryOutput: string;
  requests: string;
  publicStatus: string;
  scratch: string;
  evaluatorData: readonly string[];
  evaluatorCredentialEnv: readonly string[];
  readOnlyRoot: true;
  nonRoot: true;
  dropCapabilities: true;
  hostPid: false;
  dockerSocket: false;
}>;
export type ApprovedChild = Readonly<{
  id: string;
  executable: string;
  sha256: string;
  runtimePath: string;
  runtimeSha256: string;
  imageDigest: string;
  containerExecutable: string;
  uid: number;
  gid: number;
  argv: readonly string[];
  maxElapsedMs: number;
  maxOutputBytes: number;
}>;
export type ApprovedChildResult = Readonly<{ events: readonly ProbeEvent[]; elapsedMs: number; exitCode: number | null; outputBytes: number }>;
export type ShadowRunInput = Readonly<{
  runRoot: string;
  runId: string;
  pack: ReviewDecisionPack;
  pilot: JudgmentPilot;
  evidenceClass: EvidenceClass;
  child: ApprovedChild;
  mountPlan: ShadowMountPlan;
  baseline: Readonly<{ inventory: unknown; seatOutputs: unknown; originalConsumption: unknown; finalReport: unknown }>;
  credentialProvider?: (signal: AbortSignal) => string | Promise<string>;
  sendRequest?: (input: NativeTransportInput) => Promise<NativeTransportResult>;
  signal?: AbortSignal;
}>;

export type ProbeLauncher = (child: ApprovedChild, runId: string, plan: ShadowMountPlan) => ChildProcessWithoutNullStreams;

const encoder = new TextEncoder();
const MAX_ARTIFACT_BYTES = 1_048_576;
const digest = (value: unknown): string => createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
};
function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value); }
function sha256File(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(65_536);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("jev.manifest-file-invalid");
    let offset = 0;
    while ((offset = readSync(fd, buffer, 0, buffer.byteLength, null)) > 0) hash.update(buffer.subarray(0, offset));
    return hash.digest("hex");
  } finally { closeSync(fd); }
}
function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) throw new Error("jev.artifact-already-sealed");
  const json = JSON.stringify(value);
  const bytes = encoder.encode(json);
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error("jev.artifact-too-large");
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } catch (error) { unlinkSync(temp); throw error; }
  finally { closeSync(fd); }
  try {
    linkSync(temp, path);
    chmodSync(path, 0o400);
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { unlinkSync(temp); }
}
function assertMountPlan(plan: ShadowMountPlan, runRoot: string, child: ApprovedChild): void {
  if (plan.readOnlyRoot !== true || plan.nonRoot !== true || plan.dropCapabilities !== true || plan.hostPid !== false || plan.dockerSocket !== false || plan.evaluatorCredentialEnv.length !== 0) throw new Error("jev.mount-policy-invalid");
  const canonical = [plan.syntheticSource, plan.ordinaryOutput, plan.requests, plan.publicStatus, plan.scratch].map((path) => {
    if (!isAbsolute(path)) throw new Error("jev.mount-path-invalid");
    return realpathSync(path);
  });
  if (!statSync(canonical[0]!).isDirectory() || !statSync(canonical[1]!).isDirectory() || !statSync(canonical[2]!).isDirectory() || !statSync(canonical[3]!).isFile() || !statSync(canonical[4]!).isDirectory()) throw new Error("jev.mount-shape-invalid");
  const owner = statSync(runRoot);
  const output = statSync(canonical[1]!);
  const requests = statSync(canonical[2]!);
  if (child.uid === 0 || child.uid !== owner.uid || child.gid !== owner.gid || output.uid !== child.uid || requests.uid !== child.uid || (output.mode & 0o300) !== 0o300 || (requests.mode & 0o300) !== 0o300) throw new Error("jev.nonroot-mount-permission-invalid");
  if (new Set(canonical).size !== canonical.length) throw new Error("jev.mount-overlap");
  for (const forbidden of plan.evaluatorData) {
    if (!isAbsolute(forbidden)) throw new Error("jev.evaluator-data-mounted");
    const protectedPath = realpathSync(forbidden);
    if (canonical.some((mount) => within(mount, protectedPath) || within(protectedPath, mount))) throw new Error("jev.evaluator-data-mounted");
  }
  if (!canonical.every((mount) => within(realpathSync(runRoot), mount))) throw new Error("jev.mount-outside-run");
}

const pinnedImageDigest = (value: string): boolean =>
  /^.+@sha256:[a-f0-9]{64}$/.test(value) || /^sha256:[a-f0-9]{64}$/.test(value);

export function buildDockerLaunchArgs(child: ApprovedChild, runId: string, plan: ShadowMountPlan): readonly string[] {
  const runtimePath = realpathSync(child.runtimePath);
  if (!validId(runId) || !isAbsolute(child.runtimePath) || !/^[a-f0-9]{64}$/.test(child.runtimeSha256) ||
      sha256File(runtimePath) !== child.runtimeSha256 ||
      !Array.isArray(child.argv) || child.argv.length > 16 || child.argv.some((arg) => typeof arg !== "string" || arg.length > 256 || arg.includes("\0")) ||
      !pinnedImageDigest(child.imageDigest) || !child.containerExecutable.startsWith("/") || child.containerExecutable.split("/").includes("..") ||
      !Number.isSafeInteger(child.uid) || child.uid < 1 || !Number.isSafeInteger(child.gid) || child.gid < 1) throw new Error("jev.container-manifest-invalid");
  if ([plan.syntheticSource, plan.ordinaryOutput, plan.requests, plan.publicStatus].some((path) => path.includes(","))) throw new Error("jev.mount-path-unsupported");
  return Object.freeze([
    "run", "--rm", "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
    `--user=${child.uid}:${child.gid}`, "--pids-limit=64", "--memory=256m", "--cpus=1", `--tmpfs=/mnt/scratch:rw,nosuid,nodev,noexec,size=16m,uid=${child.uid},gid=${child.gid},mode=0700`,
    `--mount=type=bind,src=${plan.syntheticSource},dst=/mnt/source,readonly`, `--mount=type=bind,src=${plan.ordinaryOutput},dst=/mnt/output`,
    `--mount=type=bind,src=${plan.requests},dst=/mnt/requests`, `--mount=type=bind,src=${plan.publicStatus},dst=/mnt/status.json,readonly`,
    "--env=JEV_COMPONENT_WORKER=1", "--env=HOME=/mnt/scratch", "--env=JEV_REQUESTS_DIR=/mnt/requests", "--env=JEV_STATUS_PATH=/mnt/status.json", child.imageDigest, child.containerExecutable, ...child.argv, runId,
  ]);
}

function dockerProbeLauncher(child: ApprovedChild, runId: string, plan: ShadowMountPlan): ChildProcessWithoutNullStreams {
  // The supervisor consumes only stdout/stderr; stdin is intentionally ignored at spawn.
  return spawn(child.runtimePath, buildDockerLaunchArgs(child, runId, plan), { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }) as unknown as ChildProcessWithoutNullStreams;
}
function runApprovedChild(child: ApprovedChild, runId: string, plan: ShadowMountPlan, signal: AbortSignal, launcher: ProbeLauncher): Promise<ApprovedChildResult> {
  if (signal.aborted) return Promise.resolve({ events: [], elapsedMs: 0, exitCode: null, outputBytes: 0 });
  if (!validId(child.id) || !isAbsolute(child.executable) || !/^[a-f0-9]{64}$/.test(child.sha256) || !Number.isSafeInteger(child.maxElapsedMs) || child.maxElapsedMs < 1 || !Number.isSafeInteger(child.maxOutputBytes) || child.maxOutputBytes < 1 || child.maxOutputBytes > 1_048_576) throw new Error("jev.child-manifest-invalid");
  const executable = realpathSync(child.executable);
  if (!statSync(executable).isFile() || sha256File(executable) !== child.sha256) throw new Error("jev.child-not-approved");
  const started = performance.now();
  const { promise, resolve: finish, reject } = Promise.withResolvers<ApprovedChildResult>();
  const proc = launcher(child, runId, plan);
  let total = 0;
  let output = "";
  let settled = false;
  const timer = setTimeout(() => proc.kill("SIGKILL"), child.maxElapsedMs);
  const abort = () => proc.kill("SIGTERM");
  signal.addEventListener("abort", abort, { once: true });
  proc.stdout.on("data", (chunk: Buffer) => {
    total += chunk.byteLength;
    if (total > child.maxOutputBytes) { proc.kill("SIGKILL"); return; }
    output += chunk.toString("utf8");
  });
  proc.stderr.on("data", (chunk: Buffer) => { total += chunk.byteLength; if (total > child.maxOutputBytes) proc.kill("SIGKILL"); });
  proc.once("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); reject(error); } });
  proc.once("close", (exitCode) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    let lastAt = -1;
    const events: ProbeEvent[] = [];
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const raw = JSON.parse(line) as Partial<ProbeEvent>;
        if (!["start", "baseline-frozen", "request", "complete", "cancelled", "error"].includes(raw.type ?? "") || raw.runId !== runId || typeof raw.at !== "number" || !Number.isFinite(raw.at) || raw.at < lastAt || raw.at > child.maxElapsedMs || events.length >= 256) throw new Error("invalid probe event");
        lastAt = raw.at;
        events.push(Object.freeze({ type: raw.type as ProbeEvent["type"], runId, at: raw.at }));
      } catch { finish({ events, elapsedMs: performance.now() - started, exitCode: exitCode ?? 1, outputBytes: total }); return; }
    }
    finish({ events, elapsedMs: performance.now() - started, exitCode, outputBytes: total });
  });
  return promise;
}

/** Runs one finite component/synthetic assessment; the default launcher is an explicit hardened Docker invocation. */
export async function runShadowSupervisor(input: ShadowRunInput, signal = input.signal ?? new AbortController().signal, launcher: ProbeLauncher = dockerProbeLauncher): Promise<ShadowRunAssessment> {
  if (!isAbsolute(input.runRoot) || !validId(input.runId) || input.evidenceClass === "named-host") throw new Error("jev.run-authority-invalid");
  const runRoot = realpathSync(input.runRoot);
  const pack = validatePack(input.pack);
  const pilot = validatePilot(input.pilot);
  if (pack.runId !== input.runId || pilot.runId !== input.runId || pack.runId !== pilot.runId || pilot.permission.dataClass !== "synthetic-only") throw new Error("jev.run-source-authority-invalid");
  if (!within(runRoot, realpathSync(input.child.executable))) throw new Error("jev.child-outside-approved-root");
  assertMountPlan(input.mountPlan, runRoot, input.child);
  if (input.child.maxElapsedMs > pilot.limits.timeoutMs || input.child.maxOutputBytes > pilot.limits.maxResponseBytes) throw new Error("jev.child-budget-exceeded");
  const evaluatorRoot = realpathSync(resolve(runRoot, "evaluator"));
  if (!input.mountPlan.evaluatorData.some((path) => realpathSync(path) === evaluatorRoot)) throw new Error("jev.evaluator-root-unapproved");
  const evidenceRoot = resolve(evaluatorRoot, "evidence");
  const runDirectory = resolve(evidenceRoot, input.runId);
  const resultDirectory = resolve(evaluatorRoot, "results");
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(resultDirectory, { recursive: true, mode: 0o700 });
  const baseline = freezeBaseline({ runId: input.runId, ...input.baseline });
  atomicJson(resolve(runRoot, "baseline.json"), baseline);
  const started = performance.now();
  const events: ProbeEvent[] = [];
  const receipts: WorkUnitReceipt[] = [];
  const failures: string[] = [];
  const packSha256 = createHash("sha256").update(canonicalJsonBytes(pack)).digest("hex");
  const prepared = buildA05Request(pack, pilot);
  const sealed = new Map<string, JudgmentResult>();
  const mailbox = createEvaluatorMailbox({ runId: input.runId, requestDirectory: input.mountPlan.requests, statusPath: input.mountPlan.publicStatus, maxRequestBytes: pilot.limits.maxPackBytes });
  mailbox.publishStatus({ runId: input.runId, status: "idle" });
  const mailboxController = new AbortController();
  const abortMailbox = () => mailboxController.abort();
  signal.addEventListener("abort", abortMailbox, { once: true });
  let elapsedMs = 0;
  let outputBytes = 0;
  let childResult: ApprovedChildResult | undefined;
  let providerRecorded = false;
  const childPromise = runApprovedChild(input.child, input.runId, input.mountPlan, signal, launcher);
  const requestPromise = mailbox.readNext(mailboxController.signal);
  try {
    const first = await Promise.race([
      childPromise.then((child) => ({ kind: "child" as const, child })),
      requestPromise.then((request) => ({ kind: "request" as const, request })),
    ]);
    if (first.kind === "request" && first.request !== null) {
      const request = first.request;
      mailbox.publishStatus({ runId: input.runId, requestId: request.requestId, status: "pending" });
      const requestPack = Buffer.from(request.packBytes, "base64");
      if (request.pilotDigest !== digest(pilot) || !requestPack.equals(canonicalJsonBytes(pack))) {
        mailbox.publishStatus({ runId: input.runId, requestId: request.requestId, status: "invalid", code: "jev.foreign-request" });
        failures.push("jev.foreign-request");
      } else if (mailbox.isCancelled(request.requestId)) {
        mailbox.publishStatus({ runId: input.runId, requestId: request.requestId, status: "cancelled", code: "jev.review-cancelled" });
      } else {
        const evaluationController = new AbortController();
        const cancelPoll = setInterval(() => { if (mailbox.isCancelled(request.requestId)) evaluationController.abort("review-cancelled"); }, 10);
        const abortEvaluation = () => evaluationController.abort("review-cancelled");
        signal.addEventListener("abort", abortEvaluation, { once: true });
        const context: EvaluatorContext = {
          pilot,
          pack,
          runDirectory,
          isCurrent: () => !evaluationController.signal.aborted && !mailbox.isCancelled(request.requestId),
          readCredential: async (evaluationSignal) => {
            const credential = input.credentialProvider === undefined ? process.env.TYPESAFE_API_KEY : await input.credentialProvider(evaluationSignal);
            if (typeof credential !== "string" || credential.length === 0) throw new Error("jev.credential-unavailable");
            return credential;
          },
          sendRequest: input.sendRequest,
          writeSealedResult: async (result, options) => {
            if (options.signal.aborted || !await context.isCurrent()) throw new Error("jev.revoked");
            const reference = resolve(resultDirectory, `${result.reservationId}.json`);
            atomicJson(reference, result);
            sealed.set(reference, result);
            return reference;
          },
          readSealedResult: async (reference) => {
            const result = sealed.get(reference);
            if (result === undefined || !within(resultDirectory, reference)) throw new Error("jev.sealed-result-unavailable");
            return result;
          },
        };
        try {
          await evaluateNative(prepared, context, evaluationController.signal);
          if (evaluationController.signal.aborted || mailbox.isCancelled(request.requestId)) {
            mailbox.publishStatus({ runId: input.runId, requestId: request.requestId, status: "cancelled", code: "jev.review-cancelled" });
          } else {
            mailbox.publishStatus({ runId: input.runId, requestId: request.requestId, status: "recorded" });
            providerRecorded = true;
          }
        } catch (error) {
          const failureCode = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z0-9][a-z0-9.-]{0,95}$/.test(error.code) ? error.code : "jev.evaluation-failed";
          if (failureCode !== "jev.review-cancelled") failures.push(failureCode);
          mailbox.publishStatus({ runId: input.runId, requestId: request.requestId, status: failureCode === "jev.review-cancelled" ? "cancelled" : "unavailable", code: failureCode });
        } finally {
          clearInterval(cancelPoll);
          signal.removeEventListener("abort", abortEvaluation);
        }
      }
      mailbox.clearCancellation(request.requestId);
      childResult = await childPromise;
    } else {
      mailboxController.abort();
      childResult = first.kind === "child" ? first.child : await childPromise;
    }
  } catch (error) {
    mailboxController.abort();
    failures.push(error instanceof Error ? error.message.replace(/[^a-zA-Z0-9.-]/g, "-").slice(0, 96) : "jev.supervisor-failed");
  } finally {
    mailboxController.abort();
    signal.removeEventListener("abort", abortMailbox);
  }
  if (childResult !== undefined) {
    events.push(...childResult.events);
    elapsedMs = childResult.elapsedMs;
    outputBytes = childResult.outputBytes;
    if (childResult.exitCode !== 0) failures.push(`probe-child-exit-${childResult.exitCode ?? "signal"}`);
    const childTypes = childResult.events.map((event) => event.type);
    if (!providerRecorded || childResult.exitCode !== 0 || childTypes.join(",") !== "start,baseline-frozen,request,complete") failures.push("probe-lifecycle-invalid");
    if (childTypes.includes("request") && childTypes.indexOf("baseline-frozen") > childTypes.indexOf("request")) failures.push("jev.early-reveal-rejected");
  }
  if (signal.aborted && !events.some((event) => event.type === "cancelled")) events.push({ type: "cancelled", at: performance.now(), runId: input.runId });
  const consumption = input.baseline.originalConsumption;
  const consumedOutputs = consumption && typeof consumption === "object" && "consumedOutputs" in consumption && Array.isArray(consumption.consumedOutputs) ? consumption.consumedOutputs : [];
  for (const task of pack.tasks) {
    const matching = consumedOutputs.filter((output) => !!output && typeof output === "object" && "unitId" in output && output.unitId === task.workUnit.id && "outputId" in output && typeof output.outputId === "string" && "consumed" in output && output.consumed === true && "consumedAt" in output && typeof output.consumedAt === "number" && Number.isFinite(output.consumedAt) && output.consumedAt >= 0);
    const consumedOutput = matching.length === 1 ? matching[0] : null;
    const disposition = signal.aborted ? "cancelled" : consumedOutput !== null ? "completed" : "blocked";
    receipts.push(recordWorkUnitDisposition({ runId: input.runId, unitId: task.workUnit.id, packId: pack.packId, packSha256, scopeSha256: digest(pack.scope), disposition, originalConsumption: disposition === "completed" ? consumedOutput : null }));
  }
  atomicJson(resolve(runRoot, "probe-events.json"), events);
  atomicJson(resolve(runRoot, "study-result.json"), { schema: "mstar.shadow-study-result/v1", runId: input.runId, evidenceClass: input.evidenceClass, elapsedMs, childOutputBytes: outputBytes, exitStatus: failures.length === 0 ? "completed" : "failed" });
  atomicJson(resolve(runRoot, "receipts.json"), receipts);
  const assessment = assessShadowRun({ baseline, receipts, childEvents: events, evidenceClass: input.evidenceClass, elapsedMs, childOutputBytes: outputBytes, failures, packId: pack.packId, packSha256, scopeSha256: digest(pack.scope), requiredUnitIds: pack.tasks.map((task) => task.workUnit.id), originalConsumption: consumption, originalSeatOutputs: input.baseline.seatOutputs });
  atomicJson(resolve(runRoot, "assessment.json"), assessment);
  return assessment;
}
