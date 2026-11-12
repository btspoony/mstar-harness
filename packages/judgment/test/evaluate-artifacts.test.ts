import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvaluationCommand } from "../scripts/evaluate.js";
import { frozenBudget, frozenRoot } from "./fixtures/qualification-root.js";

async function capture(args: string[]): Promise<{ code: number; stderr: string }> {
  const output: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { output.push(chunk.toString()); return true; }) as typeof process.stderr.write;
  try {
    return { code: await runEvaluationCommand(args), stderr: output.join("") };
  } finally {
    process.stderr.write = originalWrite;
  }
}

// Manifest-listed artifacts must exist for verifyFiles; the annotation artifact stays absent.
function rootMissingAnnotationShard(): string {
  const root = mkdtempSync(join(tmpdir(), "qualification-artifact-"));
  const corpus = JSON.stringify({ groups: [] });
  writeFileSync(join(root, "corpus.json"), corpus);
  writeFileSync(join(root, "protocol.json"), "{}");
  writeFileSync(join(root, "manifest.json"), JSON.stringify({
    schema: "mstar.qualification-manifest/v1", contractRevision: "phase3a-native-20260924",
    files: [
      { path: "corpus.json", sha256: createHash("sha256").update(corpus).digest("hex") },
      { path: "protocol.json", sha256: createHash("sha256").update("{}").digest("hex") },
    ],
  }));
  return root;
}

describe("evaluation artifact refusals", () => {
  test("names a missing JSON artifact relative to the run root and keeps the fail-closed exit code", async () => {
    const root = mkdtempSync(join(tmpdir(), "qualification-artifact-missing-"));
    try {
      const { code, stderr } = await capture(["check-protocol", "--root", root]);
      expect(code).toBe(2);
      expect(stderr).toContain("jev.artifact-missing: protocol.json");
      expect(stderr).not.toContain(root);
      expect(stderr).not.toContain("ENOENT");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("names a missing JSONL artifact relative to the run root instead of surfacing ENOENT", async () => {
    const root = rootMissingAnnotationShard();
    try {
      const { code, stderr } = await capture(["check-annotations", "--root", root, "--seat", "A", "--shard", "1"]);
      expect(code).toBe(2);
      expect(stderr).toContain("jev.artifact-missing: annotations/A-1.jsonl");
      expect(stderr).not.toContain(root);
      expect(stderr).not.toContain("ENOENT");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // `sources/` is absent, so this reaches the shard read at evaluate.ts:282. The calibration reads only run after
  // the outer verifyFiles manifest check and the check-protocol/check-freeze sub-runs admit the root, so every
  // frozen artifact is committed. The gold read at :274 is a defensive-consistency branch: gold must be
  // manifest-listed and check-freeze-committed, so no deletion can reach it through the current admission flow.
  test("calibrate names a missing source shard relative to the run root instead of surfacing ENOENT", async () => {
    const root = frozenRoot({
      developmentVariantSources: true,
      calibrationArtifacts: {
        "protocol.json": JSON.stringify({
          schema: "mstar.qualification-protocol/v1", contractRevision: "phase3a-native-20260924",
          mode: "shadow", transport: "native-typesafe",
          providerEndpoint: "https://provider.invalid/v1/judge", requestedModel: "jev-1.13.0",
        }),
        "budget.json": JSON.stringify(frozenBudget),
        "permission.json": JSON.stringify({
          contractRevision: "phase3a-native-20260924",
          status: "synthetic-only-policy-declaration; not a self-authorizing pilot",
          dataClass: "newly authored synthetic source claims and bounded literal evidence excerpts only",
          endpoint: "https://provider.invalid/v1/judge", model: "jev-1.13.0",
          mode: "shadow", transport: "native-typesafe",
          authorizedBy: "synthetic-policy-owner", permissionRef: "permission.json", isolation: "run-manifest.json#docker-mount-plan",
        }),
      },
    });
    try {
      const { code, stderr } = await capture(["calibrate-preflight", "--root", root]);
      expect(code).toBe(2);
      expect(stderr).toContain("jev.artifact-missing: sources/shard-1.jsonl");
      expect(stderr).not.toContain(root);
      expect(stderr).not.toContain("ENOENT");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
