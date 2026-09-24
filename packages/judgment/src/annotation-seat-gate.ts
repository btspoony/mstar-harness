import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { allowedAnnotationOutput, type AnnotationSeat } from "./annotation-sink.js";
import type { ApprovedChild, ApprovedChildResult } from "./shadow-supervisor.js";
import type { EvidenceClass } from "./shadow-receipts.js";

export type AnnotationSeatMountPlan = Readonly<{
  annotationInputs: string;
  annotationSink: string;
  probeOutput: string;
  qualificationRoot: string;
  annotationViewRoot: string;
  forbiddenCustody: readonly string[];
  readOnlyRoot: true;
  nonRoot: true;
  dropCapabilities: true;
  hostPid: false;
  dockerSocket: false;
  network: false;
}>;

export type AnnotationSeatGateInput = Readonly<{
  gateRoot: string;
  qualificationRoot: string;
  annotationViewRoot: string;
  seat: AnnotationSeat;
  shard: number;
  sessionId: string;
  contractRevision: string;
  evidenceClass: Exclude<EvidenceClass, "named-host">;
  child: ApprovedChild;
  mountPlan: AnnotationSeatMountPlan;
  signal?: AbortSignal;
}>;

export type DenyProbeRecord = Readonly<{
  probe: string;
  target: string;
  observed: string;
  detail?: unknown;
}>;

export type AnnotationSeatGateResult = Readonly<{
  schema: "mstar.annotation-seat-gate-result/v1";
  evidenceClass: Exclude<EvidenceClass, "named-host">;
  w5: false;
  sessionId: string;
  seat: AnnotationSeat;
  shard: number;
  verdict: "pass" | "blocks";
  failures: readonly string[];
  inputAllowlist: Readonly<{ briefPath: string; shardViewPath: string; seat: AnnotationSeat; shard: number; sinkOutputs: readonly string[] }>;
  capabilityFindings: Readonly<{ shell: string; filesystemTools: string; network: string; evidenceRootMount: string; unrestrictedPaths: string }>;
  denyProbes: readonly DenyProbeRecord[];
  crosswalkInaccessibility: Readonly<{ probe: string; target: string; observed: string; detail?: unknown }>;
  sinkScoping: Readonly<{ allowedCreates: readonly string[]; deniedPaths: readonly string[] }>;
  transcriptPath: string;
}>;

export type AnnotationSeatProbeLauncher = (
  child: ApprovedChild,
  sessionId: string,
  seat: AnnotationSeat,
  shard: number,
  plan: AnnotationSeatMountPlan,
) => ChildProcessWithoutNullStreams;

const encoder = new TextEncoder();
const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
};
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const validSeat = (value: unknown): value is AnnotationSeat => value === "A" || value === "B";
const pinnedImageDigest = (value: string): boolean => /^.+@sha256:[a-f0-9]{64}$/.test(value) || /^sha256:[a-f0-9]{64}$/.test(value);

function sha256File(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(65_536);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("jev.manifest-file-invalid");
    let offset = 0;
    while ((offset = readSync(fd, buffer, 0, buffer.byteLength, null)) > 0) hash.update(buffer.subarray(0, offset));
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

export function buildAnnotationSeatDockerLaunchArgs(
  child: ApprovedChild,
  sessionId: string,
  seat: AnnotationSeat,
  shard: number,
  plan: AnnotationSeatMountPlan,
): readonly string[] {
  const runtimePath = realpathSync(child.runtimePath);
  if (!validId(sessionId) || !validSeat(seat) || !Number.isInteger(shard) || shard < 1 || shard > 4 ||
      !isAbsolute(child.runtimePath) || !/^[a-f0-9]{64}$/.test(child.runtimeSha256) ||
      sha256File(runtimePath) !== child.runtimeSha256 ||
      !Array.isArray(child.argv) || child.argv.length > 16 || child.argv.some((arg) => typeof arg !== "string" || arg.length > 256 || arg.includes("\0")) ||
      !pinnedImageDigest(child.imageDigest) || !child.containerExecutable.startsWith("/") || child.containerExecutable.split("/").includes("..") ||
      !Number.isSafeInteger(child.uid) || child.uid < 1 || !Number.isSafeInteger(child.gid) || child.gid < 1) throw new Error("jev.annotation-seat-container-manifest-invalid");
  if ([plan.annotationInputs, plan.annotationSink, plan.probeOutput].some((path) => path.includes(","))) throw new Error("jev.annotation-seat-mount-path-unsupported");
  const outputName = allowedAnnotationOutput(seat, shard);
  return Object.freeze([
    "run", "--rm", "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
    `--user=${child.uid}:${child.gid}`, "--pids-limit=64", "--memory=256m", "--cpus=1",
    `--tmpfs=/mnt/scratch:rw,nosuid,nodev,noexec,size=16m,uid=${child.uid},gid=${child.gid},mode=0700`,
    `--mount=type=bind,src=${plan.annotationInputs},dst=/mnt/inputs,readonly`,
    `--mount=type=bind,src=${plan.annotationSink},dst=/mnt/sink`,
    `--mount=type=bind,src=${plan.probeOutput},dst=/mnt/output`,
    "--env=JEV_ANNOTATION_WORKER=1", "--env=HOME=/mnt/scratch",
    `--env=JEV_ANNOTATION_SINK=/mnt/sink`, `--env=JEV_ANNOTATION_SEAT=${seat}`, `--env=JEV_ANNOTATION_SHARD=${shard}`,
    `--env=JEV_ANNOTATION_OUTPUT_NAME=${outputName}`,
    `--env=JEV_ANNOTATION_INPUTS=/mnt/inputs`, `--env=JEV_ANNOTATION_OUTPUT=/mnt/output`,
    child.imageDigest, child.containerExecutable, ...child.argv, sessionId,
  ]);
}

function dockerAnnotationSeatLauncher(child: ApprovedChild, sessionId: string, seat: AnnotationSeat, shard: number, plan: AnnotationSeatMountPlan): ChildProcessWithoutNullStreams {
  return spawn(child.runtimePath, buildAnnotationSeatDockerLaunchArgs(child, sessionId, seat, shard, plan), {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }) as unknown as ChildProcessWithoutNullStreams;
}

function runAnnotationSeatProbeChild(
  child: ApprovedChild,
  sessionId: string,
  seat: AnnotationSeat,
  shard: number,
  plan: AnnotationSeatMountPlan,
  signal: AbortSignal,
  launcher: AnnotationSeatProbeLauncher,
): Promise<ApprovedChildResult> {
  if (signal.aborted) return Promise.resolve({ events: [], elapsedMs: 0, exitCode: null, outputBytes: 0 });
  if (!validId(child.id) || !isAbsolute(child.executable) || !/^[a-f0-9]{64}$/.test(child.sha256) || !Number.isSafeInteger(child.maxElapsedMs) || child.maxElapsedMs < 1 || !Number.isSafeInteger(child.maxOutputBytes) || child.maxOutputBytes < 1 || child.maxOutputBytes > 1_048_576) {
    throw new Error("jev.child-manifest-invalid");
  }
  const executable = realpathSync(child.executable);
  if (!statSync(executable).isFile() || sha256File(executable) !== child.sha256) throw new Error("jev.child-not-approved");
  const started = performance.now();
  const { promise, resolve: finish, reject } = Promise.withResolvers<ApprovedChildResult>();
  const proc = launcher(child, sessionId, seat, shard, plan);
  let total = 0;
  const timer = setTimeout(() => proc.kill("SIGKILL"), child.maxElapsedMs);
  const abort = () => proc.kill("SIGTERM");
  signal.addEventListener("abort", abort, { once: true });
  proc.stdout.on("data", (chunk: Buffer) => { total += chunk.byteLength; if (total > child.maxOutputBytes) proc.kill("SIGKILL"); });
  proc.stderr.on("data", (chunk: Buffer) => { total += chunk.byteLength; if (total > child.maxOutputBytes) proc.kill("SIGKILL"); });
  proc.once("error", (error) => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(error); });
  proc.once("close", (exitCode) => {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    finish({ events: [], elapsedMs: performance.now() - started, exitCode, outputBytes: total });
  });
  return promise;
}

export function assertAnnotationSeatMountPlan(plan: AnnotationSeatMountPlan, gateRoot: string, child: ApprovedChild): void {
  if (plan.readOnlyRoot !== true || plan.nonRoot !== true || plan.dropCapabilities !== true || plan.hostPid !== false || plan.dockerSocket !== false || plan.network !== false) {
    throw new Error("jev.annotation-seat-mount-policy-invalid");
  }
  const qualificationRoot = realpathSync(plan.qualificationRoot);
  const annotationViewRoot = realpathSync(plan.annotationViewRoot);
  const canonical = [plan.annotationInputs, plan.annotationSink, plan.probeOutput].map((path) => {
    if (!isAbsolute(path)) throw new Error("jev.annotation-seat-mount-path-invalid");
    return realpathSync(path);
  });
  if (!statSync(canonical[0]!).isDirectory() || !statSync(canonical[1]!).isDirectory() || !statSync(canonical[2]!).isDirectory()) throw new Error("jev.annotation-seat-mount-shape-invalid");
  const owner = statSync(gateRoot);
  const sink = statSync(canonical[1]!);
  if (child.uid === 0 || child.uid !== owner.uid || child.gid !== owner.gid || sink.uid !== child.uid || (sink.mode & 0o300) !== 0o300) throw new Error("jev.annotation-seat-nonroot-mount-permission-invalid");
  if (new Set(canonical).size !== canonical.length) throw new Error("jev.annotation-seat-mount-overlap");
  if (canonical.some((mount) => mount === qualificationRoot || mount === annotationViewRoot)) throw new Error("jev.annotation-seat-evidence-root-mounted");
  if (!canonical.every((mount) => within(realpathSync(gateRoot), mount))) throw new Error("jev.annotation-seat-mount-outside-gate");
  for (const forbidden of plan.forbiddenCustody) {
    const protectedPath = realpathSync(forbidden);
    if (canonical.some((mount) => within(mount, protectedPath) || within(protectedPath, mount))) throw new Error("jev.annotation-seat-forbidden-mounted");
  }
}

function appendTranscript(transcriptPath: string, entry: Record<string, unknown>): void {
  mkdirSync(dirname(transcriptPath), { recursive: true, mode: 0o700 });
  appendFileSync(transcriptPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
}

function parseDenialLog(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function classifyDenials(
  records: readonly Record<string, unknown>[],
  seat: AnnotationSeat,
  shard: number,
): { denyProbes: DenyProbeRecord[]; sinkScoping: AnnotationSeatGateResult["sinkScoping"]; failures: string[]; crosswalkInaccessibility: AnnotationSeatGateResult["crosswalkInaccessibility"] } {
  const failures: string[] = [];
  const denyProbes: DenyProbeRecord[] = [];
  const allowedCreates: string[] = [];
  const deniedPaths: string[] = [];
  const otherSeat: AnnotationSeat = seat === "A" ? "B" : "A";
  const otherShard = shard === 4 ? 1 : shard + 1;
  const requiredProbes = new Set([
    "other-seat-view",
    "other-shard-view",
    "crosswalk",
    "gold",
    "sources",
    "authoring",
    "authoring-brief",
    "protocol",
    "protocol-budget",
    "protocol-permission",
    "tuner",
    "model-output",
    "evaluator",
    "holdout",
    "other-seat-annotation",
    "evidence-root-enumeration",
  ]);
  const seenProbes = new Set<string>();
  for (const record of records) {
    const check = String(record.check ?? "");
    const outcome = String(record.outcome ?? "");
    const detail = record.detail as Record<string, unknown> | undefined;
    const target = detail?.target === undefined ? check : String(detail.target);
    if (check.startsWith("forbidden-read:")) {
      const probe = check.slice("forbidden-read:".length);
      denyProbes.push({ probe, target, observed: outcome, detail });
      seenProbes.add(probe);
      if (outcome !== "denied") failures.push(`forbidden-read-not-denied:${probe}`);
    } else if (check === "sink-create-allowed") {
      if (outcome === "allowed") allowedCreates.push(target);
      else failures.push(`sink-create-blocked:${target}`);
    } else if (check === "sink-create-denied") {
      deniedPaths.push(target);
      if (outcome !== "denied") failures.push(`sink-create-not-denied:${target}`);
    } else if (check === "sink-overwrite-denied" && outcome !== "denied") failures.push("sink-overwrite-not-denied");
    else if (check === "allowed-input-read" && outcome !== "allowed") failures.push("input-allowlist-read-failed");
    else if (check === "network-shell-filesystem" && outcome !== "denied") failures.push("forbidden-capability-present");
  }
  for (const probe of requiredProbes) {
    if (!seenProbes.has(probe)) failures.push(`missing-deny-probe:${probe}`);
    if (probe === "other-seat-view" && !denyProbes.some((entry) => entry.probe === "other-seat-view" && entry.target.includes(`/seats/${otherSeat}/`))) failures.push("missing-other-seat-target");
    if (probe === "other-shard-view" && !denyProbes.some((entry) => entry.probe === "other-shard-view" && entry.target.includes(`shard-${otherShard}`))) failures.push("missing-other-shard-target");
  }
  const crosswalk = denyProbes.find((entry) => entry.probe === "crosswalk");
  const crosswalkInaccessibility = crosswalk ?? { probe: "crosswalk", target: "/supervisor-only/crosswalk.json", observed: "missing", detail: { reason: "probe-not-recorded" } };
  if (!crosswalk || crosswalk.observed !== "denied") failures.push("crosswalk-inaccessible");
  return { denyProbes, sinkScoping: { allowedCreates, deniedPaths }, failures, crosswalkInaccessibility };
}

export function provisionAnnotationSeatGateLayout(input: {
  gateRoot: string;
  qualificationRoot: string;
  annotationViewRoot: string;
  seat: AnnotationSeat;
  shard: number;
  sessionId: string;
  contractRevision: string;
  briefSourcePath: string;
  shardViewSourcePath: string;
}): AnnotationSeatMountPlan {
  if (!validSeat(input.seat)) throw new Error("jev.annotation-seat-invalid");
  const gateRoot = realpathSync(input.gateRoot);
  const qualificationRoot = realpathSync(input.qualificationRoot);
  const annotationViewRoot = realpathSync(input.annotationViewRoot);
  const inputs = resolve(gateRoot, "annotation-seat-view", "inputs");
  const sink = resolve(gateRoot, "annotation-seat-view", "sink");
  const output = resolve(gateRoot, "annotation-seat-view", "output");
  const custody = resolve(gateRoot, "supervisor-custody");
  mkdirSync(resolve(gateRoot, "annotation-seat-view"), { recursive: true, mode: 0o700 });
  mkdirSync(inputs, { mode: 0o700 });
  mkdirSync(sink, { recursive: true, mode: 0o700 });
  mkdirSync(output, { recursive: true, mode: 0o700 });
  mkdirSync(custody, { recursive: true, mode: 0o700 });
  const briefTarget = resolve(inputs, "annotation-brief.md");
  copyFileSync(input.briefSourcePath, briefTarget);
  chmodSync(briefTarget, 0o400);
  const shardViewTarget = resolve(inputs, "shard-view.jsonl");
  copyFileSync(input.shardViewSourcePath, shardViewTarget);
  chmodSync(shardViewTarget, 0o400);
  writeFileSync(resolve(inputs, "seat-manifest.json"), JSON.stringify({
    schema: "mstar.annotation-seat-input-manifest/v1",
    contractRevision: input.contractRevision,
    seat: input.seat,
    shard: input.shard,
    sessionId: input.sessionId,
    shardViewPath: "annotation-seat-view/inputs/shard-view.jsonl",
  }, null, 2));
  chmodSync(resolve(inputs, "seat-manifest.json"), 0o400);
  chmodSync(inputs, 0o500);
  const forbiddenPaths: string[] = [];
  const stage = (relativePath: string, body: string) => {
    const target = resolve(custody, relativePath);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, body);
    chmodSync(target, 0o400);
    forbiddenPaths.push(target);
  };
  const otherSeat: AnnotationSeat = input.seat === "A" ? "B" : "A";
  const otherShard = input.shard === 4 ? 1 : input.shard + 1;
  stage(`seats/${otherSeat}/shard-${input.shard}.jsonl`, '{"forbidden":true}\n');
  stage(`seats/${input.seat}/shard-${otherShard}.jsonl`, '{"forbidden":true}\n');
  stage("supervisor-only/crosswalk.json", '{"forbidden":true}\n');
  stage("gold/adjudicated.jsonl", '{"forbidden":true}\n');
  stage(`sources/shard-${input.shard}.jsonl`, '{"forbidden":true}\n');
  stage(`authoring/shard-${input.shard}-provenance.json`, '{"forbidden":true}\n');
  stage("authoring-brief.md", "# forbidden\n");
  stage("protocol.json", '{"forbidden":true}');
  stage("budget.json", '{"forbidden":true}');
  stage("permission.json", '{"forbidden":true}');
  stage("calibration/candidates.json", '{"forbidden":true}');
  stage("model-output/development.jsonl", '{"forbidden":true}\n');
  stage("evaluator/canary", "evaluator-secret");
  stage("holdout-run.json", '{"forbidden":true}');
  stage(`annotations/${otherSeat}-${input.shard}.jsonl`, '{"forbidden":true}\n');
  return {
    annotationInputs: realpathSync(inputs),
    annotationSink: realpathSync(sink),
    probeOutput: realpathSync(output),
    qualificationRoot,
    annotationViewRoot,
    forbiddenCustody: Object.freeze(forbiddenPaths.map((path) => realpathSync(path))),
    readOnlyRoot: true,
    nonRoot: true,
    dropCapabilities: true,
    hostPid: false,
    dockerSocket: false,
    network: false,
  };
}

export async function runAnnotationSeatPreDispatchGate(
  input: AnnotationSeatGateInput,
  launcher: AnnotationSeatProbeLauncher = dockerAnnotationSeatLauncher,
): Promise<AnnotationSeatGateResult> {
  const evidenceClass = input.evidenceClass as EvidenceClass;
  if (!isAbsolute(input.gateRoot) || !validId(input.sessionId) || !validSeat(input.seat) || evidenceClass === "named-host") throw new Error("jev.annotation-seat-gate-authority-invalid");
  const gateRoot = realpathSync(input.gateRoot);
  assertAnnotationSeatMountPlan(input.mountPlan, gateRoot, input.child);
  const transcriptPath = resolve(gateRoot, "supervisor", "access-transcript.jsonl");
  const sinkOutput = allowedAnnotationOutput(input.seat, input.shard);
  const inputAllowlist = {
    briefPath: "annotation-seat-view/inputs/annotation-brief.md",
    shardViewPath: "annotation-seat-view/inputs/shard-view.jsonl",
    seat: input.seat,
    shard: input.shard,
    sinkOutputs: [sinkOutput],
  };
  appendTranscript(transcriptPath, { phase: "provision", inputAllowlist, mountPlan: input.mountPlan, qualificationRoot: input.mountPlan.qualificationRoot, annotationViewRoot: input.mountPlan.annotationViewRoot });
  const capabilityFindings = {
    shell: "absent-in-tool-less-context",
    filesystemTools: "supervisor-mediated-create-only-sink-only",
    network: "container-network-none",
    evidenceRootMount: "qualification-and-annotation-view-not-mounted",
    unrestrictedPaths: "bounded-to-annotation-seat-view-subtree",
  };
  appendTranscript(transcriptPath, { phase: "capability-audit", capabilityFindings });
  const childResult = await runAnnotationSeatProbeChild(input.child, input.sessionId, input.seat, input.shard, input.mountPlan, input.signal ?? new AbortController().signal, launcher);
  appendTranscript(transcriptPath, { phase: "child-complete", exitCode: childResult.exitCode, outputBytes: childResult.outputBytes, elapsedMs: childResult.elapsedMs });
  const denialRecords = parseDenialLog(resolve(input.mountPlan.probeOutput, "denial-log.jsonl"));
  appendTranscript(transcriptPath, { phase: "deny-probes", records: denialRecords });
  const { denyProbes, sinkScoping, failures: denialFailures, crosswalkInaccessibility } = classifyDenials(denialRecords, input.seat, input.shard);
  const failures = [...denialFailures];
  if (childResult.exitCode !== 0) failures.push(`annotation-seat-probe-exit-${childResult.exitCode ?? "null"}`);
  if (sinkScoping.allowedCreates.length !== 1) failures.push("sink-allowed-create-count");
  const verdict = failures.length === 0 ? "pass" : "blocks";
  appendTranscript(transcriptPath, { phase: "verdict", verdict, failures, crosswalkInaccessibility });
  chmodSync(transcriptPath, 0o400);
  return {
    schema: "mstar.annotation-seat-gate-result/v1",
    evidenceClass: input.evidenceClass,
    w5: false,
    sessionId: input.sessionId,
    seat: input.seat,
    shard: input.shard,
    verdict,
    failures,
    inputAllowlist,
    capabilityFindings,
    denyProbes,
    crosswalkInaccessibility,
    sinkScoping,
    transcriptPath,
  };
}

export function writeAnnotationSeatGateEvidence(gateRoot: string, result: AnnotationSeatGateResult, launchManifest: Record<string, unknown>): void {
  const root = realpathSync(gateRoot);
  const writeJson = (name: string, value: unknown) => {
    const path = resolve(root, name);
    const bytes = encoder.encode(JSON.stringify(value, null, 2));
    const fd = openSync(path, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY, 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(path, 0o400);
  };
  writeJson("input-allowlist.json", { schema: "mstar.annotation-seat-input-allowlist/v1", evidenceClass: result.evidenceClass, w5: false, ...result.inputAllowlist });
  writeJson("capability-findings.json", { schema: "mstar.annotation-seat-capability-findings/v1", evidenceClass: result.evidenceClass, w5: false, findings: result.capabilityFindings });
  writeJson("deny-probes.json", { schema: "mstar.annotation-seat-deny-probes/v1", evidenceClass: result.evidenceClass, w5: false, probes: result.denyProbes });
  writeJson("crosswalk-inaccessibility.json", { schema: "mstar.annotation-crosswalk-inaccessibility/v1", evidenceClass: result.evidenceClass, w5: false, ...result.crosswalkInaccessibility });
  writeJson("sink-scoping.json", { schema: "mstar.annotation-seat-sink-scoping/v1", evidenceClass: result.evidenceClass, w5: false, ...result.sinkScoping });
  writeJson("gate-result.json", result);
  writeJson("launch-manifest.json", launchManifest);
}
