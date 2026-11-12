import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { runEvaluationCommand } from "../scripts/evaluate.js";

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

  // A file that resolves but denies the open. Injected through a path-scoped readFileSync so
  // the case stays discriminating on an account that could read a mode-000 file anyway.
  test("names an artifact whose read is denied, relative to the run root", async () => {
    const root = rootMissingAnnotationShard();
    const fs = { ...require("node:fs") } as typeof FsModule;
    mock.module("node:fs", () => ({
      ...fs,
      readFileSync: (path: Parameters<typeof FsModule.readFileSync>[0], options?: Parameters<typeof FsModule.readFileSync>[1]) => {
        if (String(path).endsWith(`${sep}protocol.json`)) throw Object.assign(new Error(`EACCES: permission denied, open '${String(path)}'`), { code: "EACCES" });
        return (options === undefined ? fs.readFileSync(path) : fs.readFileSync(path, options as never)) as never;
      },
    }));
    try {
      const { code, stderr } = await capture(["check-protocol", "--root", root]);
      expect(code).toBe(2);
      expect(stderr).toContain("jev.artifact-missing: protocol.json");
      expect(stderr).not.toContain(root);
      expect(stderr).not.toContain("EACCES");
    } finally {
      mock.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
