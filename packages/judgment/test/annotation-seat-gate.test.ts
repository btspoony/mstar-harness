import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_REVISION } from "../src/contracts.js";
import { allowedAnnotationOutput, createOnlyAnnotationSinkWrite, validateAnnotationSinkRelativePath } from "../src/annotation-sink.js";
import { assertAnnotationSeatMountPlan, provisionAnnotationSeatGateLayout, runAnnotationSeatPreDispatchGate } from "../src/annotation-seat-gate.js";
import type { ApprovedChild } from "../src/shadow-supervisor.js";

const roots: string[] = [];
const fixturePath = new URL("./fixtures/annotation-seat-probe.mjs", import.meta.url).pathname;

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "jev-annotation-seat-gate-"));
  roots.push(root);
  return root;
}

function qualificationRoot(root: string): { qualification: string; annotationView: string } {
  const qualification = join(root, "qualification");
  const annotationView = join(qualification, "annotation-view");
  mkdirSync(join(annotationView, "seats", "A"), { recursive: true });
  writeFileSync(join(qualification, "annotation-brief.md"), "# annotation brief\n");
  writeFileSync(join(annotationView, "seats", "A", "annotation-brief.md"), "# annotation brief seat A\n");
  writeFileSync(join(annotationView, "seats", "A", "shard-1.jsonl"), '{"schema":"mstar.annotator-shard-view/v1","id":"x"}\n');
  return { qualification, annotationView };
}

describe("annotation seat pre-dispatch gate", () => {
  test("sink paths are seat and shard scoped", () => {
    expect(allowedAnnotationOutput("A", 1)).toBe("annotations/A-1.jsonl");
    expect(() => validateAnnotationSinkRelativePath("A", 1, "annotations/B-1.jsonl")).toThrow();
  });

  test("create-only sink rejects overwrite", () => {
    const root = workspace();
    const sink = join(root, "sink");
    mkdirSync(sink, { recursive: true });
    createOnlyAnnotationSinkWrite(sink, "A", 1, "annotations/A-1.jsonl", '{"ok":true}\n');
    expect(() => createOnlyAnnotationSinkWrite(sink, "A", 1, "annotations/A-1.jsonl", '{"again":true}\n')).toThrow();
  });

  test("provisioned mount plan excludes qualification and annotation-view roots", () => {
    const root = workspace();
    const { qualification, annotationView } = qualificationRoot(root);
    const gateRoot = join(root, "gate");
    mkdirSync(gateRoot, { recursive: true });
    const mountPlan = provisionAnnotationSeatGateLayout({
      gateRoot,
      qualificationRoot: qualification,
      annotationViewRoot: annotationView,
      seat: "A",
      shard: 1,
      sessionId: "annotation-session-1",
      contractRevision: CONTRACT_REVISION,
      briefSourcePath: join(annotationView, "seats", "A", "annotation-brief.md"),
      shardViewSourcePath: join(annotationView, "seats", "A", "shard-1.jsonl"),
    });
    const child: ApprovedChild = {
      id: "probe-local",
      executable: join(gateRoot, "probe.mjs"),
      sha256: "a".repeat(64),
      runtimePath: process.execPath,
      runtimeSha256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
      imageDigest: "node@sha256:" + "a".repeat(64),
      containerExecutable: "/worker/annotation-seat-probe.mjs",
      uid: process.getuid(),
      gid: process.getgid(),
      argv: [],
      maxElapsedMs: 5_000,
      maxOutputBytes: 65_536,
    };
    chmodSync(mountPlan.annotationSink, 0o700);
    assertAnnotationSeatMountPlan(mountPlan, gateRoot, child);
    expect(() => assertAnnotationSeatMountPlan({ ...mountPlan, annotationInputs: qualification }, gateRoot, child)).toThrow("jev.annotation-seat-evidence-root-mounted");
    expect(() => assertAnnotationSeatMountPlan({ ...mountPlan, annotationInputs: root }, gateRoot, child)).toThrow("jev.annotation-seat-evidence-root-mounted");
  });

  test("runAnnotationSeatPreDispatchGate passes with local probe child", async () => {
    const root = workspace();
    const { qualification, annotationView } = qualificationRoot(root);
    const gateRoot = join(root, "gate");
    mkdirSync(gateRoot, { recursive: true });
    const mountPlan = provisionAnnotationSeatGateLayout({
      gateRoot,
      qualificationRoot: qualification,
      annotationViewRoot: annotationView,
      seat: "A",
      shard: 1,
      sessionId: "annotation-session-1",
      contractRevision: CONTRACT_REVISION,
      briefSourcePath: join(annotationView, "seats", "A", "annotation-brief.md"),
      shardViewSourcePath: join(annotationView, "seats", "A", "shard-1.jsonl"),
    });
    const executable = join(gateRoot, "annotation-seat-probe.mjs");
    copyFileSync(fixturePath, executable);
    const child: ApprovedChild = {
      id: "probe-local",
      executable,
      sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
      runtimePath: process.execPath,
      runtimeSha256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
      imageDigest: "node@sha256:" + "a".repeat(64),
      containerExecutable: "/worker/annotation-seat-probe.mjs",
      uid: process.getuid(),
      gid: process.getgid(),
      argv: [],
      maxElapsedMs: 5_000,
      maxOutputBytes: 65_536,
    };
    const outputName = allowedAnnotationOutput("A", 1);
    const launcher = (approvedChild, sessionId, seat, shard) => spawn(process.execPath, [approvedChild.executable, sessionId], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.cwd(),
        JEV_ANNOTATION_WORKER: "1",
        JEV_ANNOTATION_SINK: mountPlan.annotationSink,
        JEV_ANNOTATION_INPUTS: mountPlan.annotationInputs,
        JEV_ANNOTATION_OUTPUT: mountPlan.probeOutput,
        JEV_ANNOTATION_SEAT: seat,
        JEV_ANNOTATION_SHARD: String(shard),
        JEV_ANNOTATION_OUTPUT_NAME: outputName,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as ChildProcessWithoutNullStreams;
    const result = await runAnnotationSeatPreDispatchGate({
      gateRoot,
      qualificationRoot: qualification,
      annotationViewRoot: annotationView,
      seat: "A",
      shard: 1,
      sessionId: "annotation-session-1",
      contractRevision: CONTRACT_REVISION,
      evidenceClass: "component",
      child,
      mountPlan,
    }, launcher);
    expect(result.verdict).toBe("pass");
    expect(result.crosswalkInaccessibility.observed).toBe("denied");
    expect(result.denyProbes.some((p) => p.probe === "crosswalk")).toBe(true);
    expect(result.sinkScoping.allowedCreates).toHaveLength(1);
    expect(readFileSync(result.transcriptPath, "utf8").includes("verdict")).toBe(true);
  });
});
