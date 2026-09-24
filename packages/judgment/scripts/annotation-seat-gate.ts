import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";
import { CONTRACT_REVISION } from "../src/contracts.js";
import {
  buildAnnotationSeatDockerLaunchArgs,
  provisionAnnotationSeatGateLayout,
  runAnnotationSeatPreDispatchGate,
  writeAnnotationSeatGateEvidence,
  type AnnotationSeatProbeLauncher,
} from "../src/annotation-seat-gate.js";
import type { ApprovedChild } from "../src/shadow-supervisor.js";

const USAGE = "Usage: annotation-seat-gate.ts run --root <author-gate-evidence-root> --qualification-root <E> [--shard <1-4>]";

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: readonly string[]): { gateRoot: string; qualificationRoot: string; annotationViewRoot: string; seat: "A" | "B"; shard: number } {
  if (argv[0] !== "run") fail(USAGE);
  let gateRoot: string | undefined;
  let qualificationRoot: string | undefined;
  let annotationViewRoot: string | undefined;
  let seat: "A" | "B" | undefined;
  let shard = 1;
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[++index];
    if (!value) fail("Missing flag value");
    if (flag === "--root" && gateRoot === undefined) gateRoot = value;
    else if (flag === "--qualification-root" && qualificationRoot === undefined) qualificationRoot = value;
    else if (flag === "--annotation-view-root" && annotationViewRoot === undefined) annotationViewRoot = value;
    else if (flag === "--seat" && seat === undefined) {
      if (value !== "A" && value !== "B") fail("Invalid seat");
      seat = value;
    } else if (flag === "--shard") {
      shard = Number(value);
      if (!Number.isInteger(shard) || shard < 1 || shard > 4) fail("Invalid shard");
    } else fail("Invalid command arguments");
  }
  if (!gateRoot || !qualificationRoot || !annotationViewRoot || !seat || !isAbsolute(gateRoot) || !isAbsolute(qualificationRoot) || !isAbsolute(annotationViewRoot)) fail(USAGE);
  return { gateRoot: realpathSync(mkdirGate(gateRoot)), qualificationRoot: realpathSync(qualificationRoot), annotationViewRoot: realpathSync(annotationViewRoot), seat, shard };
}

function mkdirGate(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function dockerBinary(): string {
  const candidates = ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "docker"];
  for (const candidate of candidates) {
    try {
      if (candidate === "docker" || existsSync(candidate)) return candidate;
    } catch {
      continue;
    }
  }
  return "docker";
}

async function buildAnnotationSeatImage(gateRoot: string): Promise<{ digest: string; tag: string; buildContext: string }> {
  const buildContext = resolve(gateRoot, "container");
  mkdirSync(buildContext, { recursive: true, mode: 0o700 });
  const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/annotation-seat-probe.mjs");
  copyFileSync(fixture, resolve(buildContext, "annotation-seat-probe.mjs"));
  writeFileSync(resolve(buildContext, "annotation-seat-container.Dockerfile"), [
    "FROM node:22-alpine",
    "WORKDIR /worker",
    "COPY annotation-seat-probe.mjs /worker/annotation-seat-probe.mjs",
    `USER ${process.getuid!()}:${process.getgid!()}`,
    'ENTRYPOINT ["node", "/worker/annotation-seat-probe.mjs"]',
    "",
  ].join("\n"));
  const tag = "jev-annotation-seat-gate:iter-20260924-jev-3a";
  const build = spawn(dockerBinary(), ["build", "-t", tag, "-f", "annotation-seat-container.Dockerfile", "."], { cwd: buildContext, stdio: ["ignore", "pipe", "pipe"] });
  const output: Buffer[] = [];
  build.stdout.on("data", (chunk) => output.push(chunk));
  build.stderr.on("data", (chunk) => output.push(chunk));
  const exitCode: number = await new Promise((resolveExit, reject) => {
    build.once("error", reject);
    build.once("close", (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0) fail(`docker build failed: ${Buffer.concat(output).toString("utf8")}`);
  const inspect = spawn(dockerBinary(), ["image", "inspect", "--format", "{{.Id}}", tag], { stdio: ["ignore", "pipe", "pipe"] });
  let digest = "";
  inspect.stdout.on("data", (chunk) => { digest += chunk.toString("utf8"); });
  const inspectCode: number = await new Promise((resolveExit, reject) => {
    inspect.once("error", reject);
    inspect.once("close", (code) => resolveExit(code ?? 1));
  });
  if (inspectCode !== 0 || !digest.includes("sha256:")) fail("docker image inspect failed");
  return { digest: digest.trim(), tag, buildContext };
}

function approvedChild(gateRoot: string, imageDigest: string): ApprovedChild {
  const executable = resolve(gateRoot, "container", "annotation-seat-probe.mjs");
  const runtimePath = dockerBinary();
  return {
    id: "annotation-seat-gate-probe",
    executable,
    sha256: sha256File(executable),
    runtimePath,
    runtimeSha256: sha256File(runtimePath),
    imageDigest,
    containerExecutable: "/worker/annotation-seat-probe.mjs",
    uid: process.getuid!(),
    gid: process.getgid!(),
    argv: [],
    maxElapsedMs: 30_000,
    maxOutputBytes: 65_536,
  };
}

export async function runAnnotationSeatGateCommand(argv = process.argv.slice(2), launcher?: AnnotationSeatProbeLauncher): Promise<number> {
  try {
    const { gateRoot, qualificationRoot, annotationViewRoot, seat, shard } = parseArgs(argv);
    const seatBrief = resolve(annotationViewRoot, "seats", seat, "annotation-brief.md");
    const rootBrief = resolve(qualificationRoot, "annotation-brief.md");
    const briefSource = statSync(seatBrief).isFile() ? seatBrief : rootBrief;
    if (!statSync(briefSource).isFile()) fail("Annotation brief missing");
    const shardViewSource = resolve(annotationViewRoot, "seats", seat, `shard-${shard}.jsonl`);
    if (!statSync(shardViewSource).isFile()) fail("Seat shard view missing");
    const sessionId = `annotation-seat-gate-${seat}-${shard}`;
    const mountPlan = provisionAnnotationSeatGateLayout({
      gateRoot,
      qualificationRoot,
      annotationViewRoot,
      seat,
      shard,
      sessionId,
      contractRevision: CONTRACT_REVISION,
      briefSourcePath: briefSource,
      shardViewSourcePath: shardViewSource,
    });
    const image = await buildAnnotationSeatImage(gateRoot);
    const child = approvedChild(gateRoot, image.digest);
    const dockerLaunchArgv = buildAnnotationSeatDockerLaunchArgs(child, sessionId, seat, shard, mountPlan);
    const launchManifest = {
      schema: "mstar.annotation-seat-launch-manifest/v1",
      evidenceClass: "component",
      w5: false,
      sessionId,
      seat,
      shard,
      builtAt: new Date().toISOString(),
      image: { tag: image.tag, digest: image.digest, buildContext: image.buildContext },
      child: { uid: child.uid, gid: child.gid, containerExecutable: child.containerExecutable, executableSha256: child.sha256 },
      dockerLaunchArgv,
    };
    const result = await runAnnotationSeatPreDispatchGate({
      gateRoot,
      qualificationRoot,
      annotationViewRoot,
      seat,
      shard,
      sessionId,
      contractRevision: CONTRACT_REVISION,
      evidenceClass: "component",
      child,
      mountPlan,
    }, launcher);
    writeAnnotationSeatGateEvidence(gateRoot, result, launchManifest);
    const denialLog = resolve(mountPlan.probeOutput, "denial-log.jsonl");
    if (existsSync(denialLog)) copyFileSync(denialLog, resolve(gateRoot, "denial-log.jsonl"));
    writeFileSync(resolve(gateRoot, "probe.json"), JSON.stringify({
      schema: "mstar.annotation-seat-gate-probe/v1",
      evidenceClass: "component",
      w5: false,
      sessionId,
      seat,
      shard,
      command: `bun run packages/judgment/scripts/annotation-seat-gate.ts run --root ${gateRoot} --qualification-root ${qualificationRoot} --annotation-view-root ${annotationViewRoot} --seat ${seat} --shard ${shard}`,
      exitCode: result.verdict === "pass" ? 0 : 1,
      verdict: result.verdict,
      failures: result.failures,
    }, null, 2));
    process.stdout.write(`${JSON.stringify({ status: result.verdict, evidenceClass: "component", w5: false, seat, shard, failures: result.failures })}\n`);
    return result.verdict === "pass" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "annotation seat gate failed"}\n`);
    return 2;
  }
}

if (import.meta.main && process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runAnnotationSeatGateCommand();
}
