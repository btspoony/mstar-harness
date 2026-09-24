import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";
import { CONTRACT_REVISION } from "../src/contracts.js";
import {
  buildAuthorDockerLaunchArgs,
  provisionAuthorGateLayout,
  runAuthorPreDispatchGate,
  writeAuthorGateEvidence,
  type AuthorProbeLauncher,
} from "../src/author-gate.js";
import type { ApprovedChild } from "../src/shadow-supervisor.js";

const USAGE = "Usage: author-gate.ts run --root <author-gate-evidence-root> --qualification-root <E> [--shard <1-4>]";

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: readonly string[]): { gateRoot: string; qualificationRoot: string; shard: number } {
  if (argv[0] !== "run") fail(USAGE);
  let gateRoot: string | undefined;
  let qualificationRoot: string | undefined;
  let shard = 1;
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[++index];
    if (!value) fail("Missing flag value");
    if (flag === "--root" && gateRoot === undefined) gateRoot = value;
    else if (flag === "--qualification-root" && qualificationRoot === undefined) qualificationRoot = value;
    else if (flag === "--shard") {
      shard = Number(value);
      if (!Number.isInteger(shard) || shard < 1 || shard > 4) fail("Invalid shard");
    } else fail("Invalid command arguments");
  }
  if (!gateRoot || !qualificationRoot || !isAbsolute(gateRoot) || !isAbsolute(qualificationRoot)) fail(USAGE);
  return { gateRoot: realpathSync(mkdirGate(gateRoot)), qualificationRoot: realpathSync(qualificationRoot), shard };
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

async function buildAuthorImage(gateRoot: string): Promise<{ digest: string; tag: string; buildContext: string }> {
  const buildContext = resolve(gateRoot, "container");
  mkdirSync(buildContext, { recursive: true, mode: 0o700 });
  const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/author-probe.mjs");
  copyFileSync(fixture, resolve(buildContext, "author-probe.mjs"));
  writeFileSync(resolve(buildContext, "author-container.Dockerfile"), [
    "FROM node:22-alpine",
    "WORKDIR /worker",
    "COPY author-probe.mjs /worker/author-probe.mjs",
    `USER ${process.getuid()}:${process.getgid()}`,
    'ENTRYPOINT ["node", "/worker/author-probe.mjs"]',
    "",
  ].join("\n"));
  const tag = "jev-author-gate:iter-20260924-jev-3a";
  const build = spawn(dockerBinary(), ["build", "-t", tag, "-f", "author-container.Dockerfile", "."], { cwd: buildContext, stdio: ["ignore", "pipe", "pipe"] });
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
  const executable = resolve(gateRoot, "container", "author-probe.mjs");
  const runtimePath = dockerBinary();
  return {
    id: "author-gate-probe",
    executable,
    sha256: sha256File(executable),
    runtimePath,
    runtimeSha256: sha256File(runtimePath),
    imageDigest,
    containerExecutable: "/worker/author-probe.mjs",
    uid: process.getuid(),
    gid: process.getgid(),
    argv: [],
    maxElapsedMs: 30_000,
    maxOutputBytes: 65_536,
  };
}

export async function runAuthorGateCommand(argv = process.argv.slice(2), launcher?: AuthorProbeLauncher): Promise<number> {
  try {
    const { gateRoot, qualificationRoot, shard } = parseArgs(argv);
    const briefSource = resolve(qualificationRoot, "authoring-brief.md");
    if (!statSync(briefSource).isFile()) fail("Authoring brief missing at qualification root");
    const sessionId = `author-gate-shard-${shard}`;
    const mountPlan = provisionAuthorGateLayout({
      gateRoot,
      qualificationRoot,
      shard,
      sessionId,
      contractRevision: CONTRACT_REVISION,
      briefSourcePath: briefSource,
    });
    const image = await buildAuthorImage(gateRoot);
    const child = approvedChild(gateRoot, image.digest);
    const dockerLaunchArgv = buildAuthorDockerLaunchArgs(child, sessionId, shard, mountPlan);
    const launchManifest = {
      schema: "mstar.author-launch-manifest/v1",
      evidenceClass: "component",
      w5: false,
      sessionId,
      shard,
      builtAt: new Date().toISOString(),
      image: { tag: image.tag, digest: image.digest, buildContext: image.buildContext },
      child: { uid: child.uid, gid: child.gid, containerExecutable: child.containerExecutable, executableSha256: child.sha256 },
      dockerLaunchArgv,
    };
    const result = await runAuthorPreDispatchGate({
      gateRoot,
      qualificationRoot,
      shard,
      sessionId,
      contractRevision: CONTRACT_REVISION,
      evidenceClass: "component",
      child,
      mountPlan,
    }, launcher);
    writeAuthorGateEvidence(gateRoot, result, launchManifest);
    const denialLog = resolve(mountPlan.probeOutput, "denial-log.jsonl");
    if (existsSync(denialLog)) copyFileSync(denialLog, resolve(gateRoot, "denial-log.jsonl"));
    writeFileSync(resolve(gateRoot, "probe.json"), JSON.stringify({
      schema: "mstar.author-gate-probe/v1",
      evidenceClass: "component",
      w5: false,
      sessionId,
      shard,
      command: `bun run packages/judgment/scripts/author-gate.ts run --root ${gateRoot} --qualification-root ${qualificationRoot} --shard ${shard}`,
      exitCode: result.verdict === "pass" ? 0 : 1,
      verdict: result.verdict,
      failures: result.failures,
    }, null, 2));
    process.stdout.write(`${JSON.stringify({ status: result.verdict, evidenceClass: "component", w5: false, shard, failures: result.failures })}\n`);
    return result.verdict === "pass" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "author gate failed"}\n`);
    return 2;
  }
}

if (import.meta.main && process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runAuthorGateCommand();
}
