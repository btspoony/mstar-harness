import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { allowedAuthorOutputs, authorSlotKeys } from "./author-sink.js";
import type { ApprovedChild, ApprovedChildResult } from "./shadow-supervisor.js";
import type { EvidenceClass } from "./shadow-receipts.js";

export type AuthorMountPlan = Readonly<{
  authorInputs: string;
  authorSink: string;
  probeOutput: string;
  qualificationRoot: string;
  forbiddenCustody: readonly string[];
  readOnlyRoot: true;
  nonRoot: true;
  dropCapabilities: true;
  hostPid: false;
  dockerSocket: false;
  network: false;
}>;

export type AuthorGateInput = Readonly<{
  gateRoot: string;
  qualificationRoot: string;
  shard: number;
  sessionId: string;
  contractRevision: string;
  evidenceClass: Exclude<EvidenceClass, "named-host">;
  child: ApprovedChild;
  mountPlan: AuthorMountPlan;
  signal?: AbortSignal;
}>;

export type DenyProbeRecord = Readonly<{
  probe: string;
  target: string;
  observed: string;
  detail?: unknown;
}>;

export type AuthorGateResult = Readonly<{
  schema: "mstar.author-gate-result/v1";
  evidenceClass: Exclude<EvidenceClass, "named-host">;
  w5: false;
  sessionId: string;
  shard: number;
  verdict: "pass" | "blocks";
  failures: readonly string[];
  inputAllowlist: Readonly<{ briefPath: string; slotKeysPath: string; slotKeys: readonly string[]; sinkOutputs: readonly string[] }>;
  capabilityFindings: Readonly<{ shell: string; filesystemTools: string; network: string; evidenceRootMount: string; unrestrictedPaths: string }>;
  denyProbes: readonly DenyProbeRecord[];
  sinkScoping: Readonly<{ allowedCreates: readonly string[]; deniedPaths: readonly string[] }>;
  transcriptPath: string;
}>;

export type AuthorProbeLauncher = (child: ApprovedChild, sessionId: string, shard: number, plan: AuthorMountPlan) => ChildProcessWithoutNullStreams;

const encoder = new TextEncoder();
const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
};
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
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

export function buildAuthorDockerLaunchArgs(child: ApprovedChild, sessionId: string, shard: number, plan: AuthorMountPlan): readonly string[] {
  const runtimePath = realpathSync(child.runtimePath);
  if (!validId(sessionId) || !Number.isInteger(shard) || shard < 1 || shard > 4 ||
      !isAbsolute(child.runtimePath) || !/^[a-f0-9]{64}$/.test(child.runtimeSha256) ||
      sha256File(runtimePath) !== child.runtimeSha256 ||
      !Array.isArray(child.argv) || child.argv.length > 16 || child.argv.some((arg) => typeof arg !== "string" || arg.length > 256 || arg.includes("\0")) ||
      !pinnedImageDigest(child.imageDigest) || !child.containerExecutable.startsWith("/") || child.containerExecutable.split("/").includes("..") ||
      !Number.isSafeInteger(child.uid) || child.uid < 1 || !Number.isSafeInteger(child.gid) || child.gid < 1) throw new Error("jev.author-container-manifest-invalid");
  if ([plan.authorInputs, plan.authorSink, plan.probeOutput].some((path) => path.includes(","))) throw new Error("jev.author-mount-path-unsupported");
  const [sourcesName, provenanceName] = allowedAuthorOutputs(shard);
  return Object.freeze([
    "run", "--rm", "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
    `--user=${child.uid}:${child.gid}`, "--pids-limit=64", "--memory=256m", "--cpus=1",
    `--tmpfs=/mnt/scratch:rw,nosuid,nodev,noexec,size=16m,uid=${child.uid},gid=${child.gid},mode=0700`,
    `--mount=type=bind,src=${plan.authorInputs},dst=/mnt/inputs,readonly`,
    `--mount=type=bind,src=${plan.authorSink},dst=/mnt/sink`,
    `--mount=type=bind,src=${plan.probeOutput},dst=/mnt/output`,
    "--env=JEV_AUTHOR_WORKER=1", "--env=HOME=/mnt/scratch",
    `--env=JEV_AUTHOR_SINK=/mnt/sink`, `--env=JEV_AUTHOR_SHARD=${shard}`,
    `--env=JEV_AUTHOR_SOURCES=${sourcesName}`, `--env=JEV_AUTHOR_PROVENANCE=${provenanceName}`,
    `--env=JEV_AUTHOR_INPUTS=/mnt/inputs`, `--env=JEV_AUTHOR_OUTPUT=/mnt/output`,
    child.imageDigest, child.containerExecutable, ...child.argv, sessionId,
  ]);
}

function dockerAuthorLauncher(child: ApprovedChild, sessionId: string, shard: number, plan: AuthorMountPlan): ChildProcessWithoutNullStreams {
  return spawn(child.runtimePath, buildAuthorDockerLaunchArgs(child, sessionId, shard, plan), {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }) as unknown as ChildProcessWithoutNullStreams;
}

function runAuthorProbeChild(child: ApprovedChild, sessionId: string, shard: number, plan: AuthorMountPlan, signal: AbortSignal, launcher: AuthorProbeLauncher): Promise<ApprovedChildResult> {
  if (signal.aborted) return Promise.resolve({ events: [], elapsedMs: 0, exitCode: null, outputBytes: 0 });
  if (!validId(child.id) || !isAbsolute(child.executable) || !/^[a-f0-9]{64}$/.test(child.sha256) || !Number.isSafeInteger(child.maxElapsedMs) || child.maxElapsedMs < 1 || !Number.isSafeInteger(child.maxOutputBytes) || child.maxOutputBytes < 1 || child.maxOutputBytes > 1_048_576) {
    throw new Error("jev.child-manifest-invalid");
  }
  const executable = realpathSync(child.executable);
  if (!statSync(executable).isFile() || sha256File(executable) !== child.sha256) throw new Error("jev.child-not-approved");
  const started = performance.now();
  const { promise, resolve: finish, reject } = Promise.withResolvers<ApprovedChildResult>();
  const proc = launcher(child, sessionId, shard, plan);
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

export function assertAuthorMountPlan(plan: AuthorMountPlan, gateRoot: string, child: ApprovedChild): void {
  if (plan.readOnlyRoot !== true || plan.nonRoot !== true || plan.dropCapabilities !== true || plan.hostPid !== false || plan.dockerSocket !== false || plan.network !== false) {
    throw new Error("jev.author-mount-policy-invalid");
  }
  const qualificationRoot = realpathSync(plan.qualificationRoot);
  const canonical = [plan.authorInputs, plan.authorSink, plan.probeOutput].map((path) => {
    if (!isAbsolute(path)) throw new Error("jev.author-mount-path-invalid");
    return realpathSync(path);
  });
  if (!statSync(canonical[0]!).isDirectory() || !statSync(canonical[1]!).isDirectory() || !statSync(canonical[2]!).isDirectory()) throw new Error("jev.author-mount-shape-invalid");
  const owner = statSync(gateRoot);
  const sink = statSync(canonical[1]!);
  if (child.uid === 0 || child.uid !== owner.uid || child.gid !== owner.gid || sink.uid !== child.uid || (sink.mode & 0o300) !== 0o300) throw new Error("jev.author-nonroot-mount-permission-invalid");
  if (new Set(canonical).size !== canonical.length) throw new Error("jev.author-mount-overlap");
  if (canonical.some((mount) => within(mount, qualificationRoot) || within(qualificationRoot, mount))) throw new Error("jev.author-evidence-root-mounted");
  if (!canonical.every((mount) => within(realpathSync(gateRoot), mount))) throw new Error("jev.author-mount-outside-gate");
  for (const forbidden of plan.forbiddenCustody) {
    const protectedPath = realpathSync(forbidden);
    if (canonical.some((mount) => within(mount, protectedPath) || within(protectedPath, mount))) throw new Error("jev.author-forbidden-mounted");
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

function classifyDenials(records: readonly Record<string, unknown>[], shard: number): { denyProbes: DenyProbeRecord[]; sinkScoping: AuthorGateResult["sinkScoping"]; failures: string[] } {
  const failures: string[] = [];
  const denyProbes: DenyProbeRecord[] = [];
  const allowedCreates: string[] = [];
  const deniedPaths: string[] = [];
  const otherShard = shard === 4 ? 1 : shard + 1;
  const requiredProbes = new Set(["other-shard", "annotation", "gold", "tuner", "evaluator", "evidence-root-enumeration", "protocol", "holdout"]);
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
    if (probe === "other-shard" && !denyProbes.some((entry) => entry.probe === "other-shard" && entry.target.includes(`shard-${otherShard}`))) failures.push("missing-other-shard-target");
  }
  return { denyProbes, sinkScoping: { allowedCreates, deniedPaths }, failures };
}

export function provisionAuthorGateLayout(input: {
  gateRoot: string;
  qualificationRoot: string;
  shard: number;
  sessionId: string;
  contractRevision: string;
  briefSourcePath: string;
}): AuthorMountPlan {
  const gateRoot = realpathSync(input.gateRoot);
  const qualificationRoot = realpathSync(input.qualificationRoot);
  const inputs = resolve(gateRoot, "author-view", "inputs");
  const sink = resolve(gateRoot, "author-view", "sink");
  const output = resolve(gateRoot, "author-view", "output");
  const custody = resolve(gateRoot, "supervisor-custody");
  mkdirSync(resolve(gateRoot, "author-view"), { recursive: true, mode: 0o700 });
  mkdirSync(inputs, { mode: 0o700 });
  mkdirSync(sink, { recursive: true, mode: 0o700 });
  mkdirSync(output, { recursive: true, mode: 0o700 });
  mkdirSync(custody, { recursive: true, mode: 0o700 });
  const briefTarget = resolve(inputs, "authoring-brief.md");
  copyFileSync(input.briefSourcePath, briefTarget);
  chmodSync(briefTarget, 0o400);
  const slotKeys = authorSlotKeys(input.shard);
  const slotKeysTarget = resolve(inputs, "slot-keys.json");
  writeFileSync(slotKeysTarget, JSON.stringify({ schema: "mstar.author-slot-keys/v1", contractRevision: input.contractRevision, shard: input.shard, sessionId: input.sessionId, keys: slotKeys }, null, 2));
  chmodSync(slotKeysTarget, 0o400);
  chmodSync(inputs, 0o500);
  const forbiddenPaths: string[] = [];
  const stage = (relativePath: string, body: string) => {
    const target = resolve(custody, relativePath);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, body);
    chmodSync(target, 0o400);
    forbiddenPaths.push(target);
  };
  const otherShard = input.shard === 4 ? 1 : input.shard + 1;
  stage(`sources/shard-${otherShard}.jsonl`, '{"forbidden":true}\n');
  stage("annotations/A-1.jsonl", '{"forbidden":true}\n');
  stage("gold/adjudicated.jsonl", '{"forbidden":true}\n');
  stage("calibration/candidates.json", '{"forbidden":true}\n');
  stage("evaluator/canary", "evaluator-secret");
  stage("protocol.json", '{"forbidden":true}');
  stage("holdout-run.json", '{"forbidden":true}');
  return {
    authorInputs: realpathSync(inputs),
    authorSink: realpathSync(sink),
    probeOutput: realpathSync(output),
    qualificationRoot,
    forbiddenCustody: Object.freeze(forbiddenPaths.map((path) => realpathSync(path))),
    readOnlyRoot: true,
    nonRoot: true,
    dropCapabilities: true,
    hostPid: false,
    dockerSocket: false,
    network: false,
  };
}

export async function runAuthorPreDispatchGate(input: AuthorGateInput, launcher: AuthorProbeLauncher = dockerAuthorLauncher): Promise<AuthorGateResult> {
  const evidenceClass = input.evidenceClass as EvidenceClass;
  if (!isAbsolute(input.gateRoot) || !validId(input.sessionId) || evidenceClass === "named-host") throw new Error("jev.author-gate-authority-invalid");
  const gateRoot = realpathSync(input.gateRoot);
  assertAuthorMountPlan(input.mountPlan, gateRoot, input.child);
  const transcriptPath = resolve(gateRoot, "supervisor", "access-transcript.jsonl");
  const inputAllowlist = {
    briefPath: "author-view/inputs/authoring-brief.md",
    slotKeysPath: "author-view/inputs/slot-keys.json",
    slotKeys: authorSlotKeys(input.shard),
    sinkOutputs: allowedAuthorOutputs(input.shard),
  };
  appendTranscript(transcriptPath, { phase: "provision", inputAllowlist, mountPlan: input.mountPlan, qualificationRoot: input.mountPlan.qualificationRoot });
  const capabilityFindings = {
    shell: "absent-in-tool-less-context",
    filesystemTools: "supervisor-mediated-create-only-sink-only",
    network: "container-network-none",
    evidenceRootMount: "qualification-root-not-mounted",
    unrestrictedPaths: "bounded-to-author-view-subtree",
  };
  appendTranscript(transcriptPath, { phase: "capability-audit", capabilityFindings });
  const childResult = await runAuthorProbeChild(input.child, input.sessionId, input.shard, input.mountPlan, input.signal ?? new AbortController().signal, launcher);
  appendTranscript(transcriptPath, { phase: "child-complete", exitCode: childResult.exitCode, outputBytes: childResult.outputBytes, elapsedMs: childResult.elapsedMs });
  const denialRecords = parseDenialLog(resolve(input.mountPlan.probeOutput, "denial-log.jsonl"));
  appendTranscript(transcriptPath, { phase: "deny-probes", records: denialRecords });
  const { denyProbes, sinkScoping, failures: denialFailures } = classifyDenials(denialRecords, input.shard);
  const failures = [...denialFailures];
  if (childResult.exitCode !== 0) failures.push(`author-probe-exit-${childResult.exitCode ?? "null"}`);
  if (sinkScoping.allowedCreates.length !== 2) failures.push("sink-allowed-create-count");
  const verdict = failures.length === 0 ? "pass" : "blocks";
  appendTranscript(transcriptPath, { phase: "verdict", verdict, failures });
  chmodSync(transcriptPath, 0o400);
  return {
    schema: "mstar.author-gate-result/v1",
    evidenceClass: input.evidenceClass,
    w5: false,
    sessionId: input.sessionId,
    shard: input.shard,
    verdict,
    failures,
    inputAllowlist,
    capabilityFindings,
    denyProbes,
    sinkScoping,
    transcriptPath,
  };
}

export function writeAuthorGateEvidence(gateRoot: string, result: AuthorGateResult, launchManifest: Record<string, unknown>): void {
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
  writeJson("input-allowlist.json", { schema: "mstar.author-input-allowlist/v1", evidenceClass: result.evidenceClass, w5: false, ...result.inputAllowlist });
  writeJson("capability-findings.json", { schema: "mstar.author-capability-findings/v1", evidenceClass: result.evidenceClass, w5: false, findings: result.capabilityFindings });
  writeJson("deny-probes.json", { schema: "mstar.author-deny-probes/v1", evidenceClass: result.evidenceClass, w5: false, probes: result.denyProbes });
  writeJson("sink-scoping.json", { schema: "mstar.author-sink-scoping/v1", evidenceClass: result.evidenceClass, w5: false, ...result.sinkScoping });
  writeJson("gate-result.json", result);
  writeJson("launch-manifest.json", launchManifest);
}
