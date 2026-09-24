import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_REVISION } from "../src/contracts.js";
import { allowedAuthorOutputs, authorSlotKeys, createOnlyAuthorSinkWrite, validateAuthorSinkRelativePath } from "../src/author-sink.js";
import { assertAuthorMountPlan, provisionAuthorGateLayout, runAuthorPreDispatchGate } from "../src/author-gate.js";
import type { ApprovedChild } from "../src/shadow-supervisor.js";

const roots: string[] = [];
const fixturePath = new URL("./fixtures/author-probe.mjs", import.meta.url).pathname;

afterEach(() => {
  for (const root of roots.splice(0)) {
    const gateRoot = join(root, "gate");
    try { chmodSync(join(gateRoot, "author-view", "inputs"), 0o700); } catch { /* ignore */ }
    try { chmodSync(join(gateRoot, "supervisor", "access-transcript.jsonl"), 0o600); } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "jev-author-gate-"));
  roots.push(root);
  return root;
}

function qualificationRoot(root: string): string {
  const qualification = join(root, "qualification");
  mkdirSync(qualification, { recursive: true });
  writeFileSync(join(qualification, "authoring-brief.md"), "# authoring brief\n");
  return qualification;
}

function localLauncher(child: ApprovedChild, sessionId: string, shard: number): ChildProcessWithoutNullStreams {
  const [sourcesName, provenanceName] = allowedAuthorOutputs(shard);
  return spawn(process.execPath, [child.executable, sessionId], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.cwd(),
      JEV_AUTHOR_WORKER: "1",
      JEV_AUTHOR_SINK: join(dirname(child.executable), "..", "author-view", "sink"),
      JEV_AUTHOR_SHARD: String(shard),
      JEV_AUTHOR_SOURCES: sourcesName,
      JEV_AUTHOR_PROVENANCE: provenanceName,
    },
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as ChildProcessWithoutNullStreams;
}

describe("author pre-dispatch gate", () => {
  test("slot keys and sink paths are shard scoped", () => {
    expect(authorSlotKeys(1)).toHaveLength(90);
    expect(authorSlotKeys(1)[0]).toBe("shard-1/group-001");
    expect(allowedAuthorOutputs(2)).toEqual(["sources/shard-2.jsonl", "authoring/shard-2-provenance.json"]);
    expect(() => validateAuthorSinkRelativePath(1, "protocol.json")).toThrow("jev.author-sink-path-forbidden");
  });

  test("create-only sink rejects overwrite and forbidden paths", () => {
    const root = workspace();
    const sink = join(root, "sink");
    mkdirSync(sink, { recursive: true });
    createOnlyAuthorSinkWrite(sink, 1, "sources/shard-1.jsonl", '{"ok":true}\n');
    expect(() => createOnlyAuthorSinkWrite(sink, 1, "sources/shard-1.jsonl", '{"again":true}\n')).toThrow("jev.author-sink-create-only");
    expect(() => createOnlyAuthorSinkWrite(sink, 1, "sources/shard-2.jsonl", '{"x":true}\n')).toThrow("jev.author-sink-path-forbidden");
  });

  test("provisioned mount plan excludes qualification root and forbidden custody", () => {
    const root = workspace();
    const gateRoot = join(root, "gate");
    mkdirSync(gateRoot, { recursive: true });
    const qualification = qualificationRoot(gateRoot);
    const mountPlan = provisionAuthorGateLayout({
      gateRoot,
      qualificationRoot: qualification,
      shard: 1,
      sessionId: "author-session-1",
      contractRevision: CONTRACT_REVISION,
      briefSourcePath: join(qualification, "authoring-brief.md"),
    });
    const child: ApprovedChild = {
      id: "probe-local",
      executable: join(gateRoot, "author-probe.mjs"),
      sha256: "00",
      runtimePath: process.execPath,
      runtimeSha256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
      imageDigest: "node@sha256:" + "a".repeat(64),
      containerExecutable: "/worker/author-probe.mjs",
      uid: process.getuid(),
      gid: process.getgid(),
      argv: [],
      maxElapsedMs: 5_000,
      maxOutputBytes: 65_536,
    };
    copyFileSync(fixturePath, child.executable);
    child.sha256 = createHash("sha256").update(readFileSync(child.executable)).digest("hex");
    assertAuthorMountPlan(mountPlan, gateRoot, child);
    expect(() => assertAuthorMountPlan({ ...mountPlan, authorInputs: qualification }, gateRoot, child)).toThrow("jev.author-evidence-root-mounted");
    expect(() => assertAuthorMountPlan({ ...mountPlan, authorInputs: gateRoot }, gateRoot, child)).toThrow("jev.author-evidence-root-mounted");
  });

  test("runAuthorPreDispatchGate passes with local probe child", async () => {
    const root = workspace();
    const qualification = qualificationRoot(root);
    const gateRoot = join(root, "gate");
    mkdirSync(gateRoot, { recursive: true });
    const mountPlan = provisionAuthorGateLayout({
      gateRoot,
      qualificationRoot: qualification,
      shard: 1,
      sessionId: "author-session-1",
      contractRevision: CONTRACT_REVISION,
      briefSourcePath: join(qualification, "authoring-brief.md"),
    });
    const executable = join(gateRoot, "author-probe.mjs");
    copyFileSync(fixturePath, executable);
    const child: ApprovedChild = {
      id: "probe-local",
      executable,
      sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
      runtimePath: process.execPath,
      runtimeSha256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
      imageDigest: "node@sha256:" + "a".repeat(64),
      containerExecutable: "/worker/author-probe.mjs",
      uid: process.getuid(),
      gid: process.getgid(),
      argv: [],
      maxElapsedMs: 5_000,
      maxOutputBytes: 65_536,
    };
    const launcher = (approvedChild, sessionId, shard) => {
      const [sourcesName, provenanceName] = allowedAuthorOutputs(shard);
      return spawn(process.execPath, [approvedChild.executable, sessionId], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.cwd(),
          JEV_AUTHOR_WORKER: "1",
          JEV_AUTHOR_SINK: mountPlan.authorSink,
          JEV_AUTHOR_INPUTS: mountPlan.authorInputs,
          JEV_AUTHOR_OUTPUT: mountPlan.probeOutput,
          JEV_AUTHOR_SHARD: String(shard),
          JEV_AUTHOR_SOURCES: sourcesName,
          JEV_AUTHOR_PROVENANCE: provenanceName,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }) as unknown as ChildProcessWithoutNullStreams;
    };
    const result = await runAuthorPreDispatchGate({
      gateRoot,
      qualificationRoot: qualification,
      shard: 1,
      sessionId: "author-session-1",
      contractRevision: CONTRACT_REVISION,
      evidenceClass: "component",
      child,
      mountPlan,
    }, launcher);
    expect(result.verdict).toBe("pass");
    expect(result.w5).toBe(false);
    expect(result.denyProbes.length).toBeGreaterThan(0);
    expect(result.sinkScoping.allowedCreates).toHaveLength(2);
    expect(readFileSync(result.transcriptPath, "utf8").includes("verdict")).toBe(true);
  });
});
