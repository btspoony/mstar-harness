import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opaqueId128, runAnnotationProjection, runLeakCheck } from "../src/annotation-projection.js";

const qualificationRoot = "/Users/bibi/workspace/ai/mstar-harness/.mstar/iterations/iter-20260924-jev-3a/evidence/qualification";

describe("annotation projection", () => {
  test("opaque ids are unique 128-bit hex", () => {
    const used = new Set<string>();
    const id = opaqueId128(used);
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(used.has(id)).toBe(true);
  });

  test("projects all shards and passes leak check", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "annotation-view-"));
    try {
      const result = runAnnotationProjection({
        qualificationRoot,
        outputRoot,
        shuffleSeed: Buffer.alloc(32, 7),
      });
      expect(result.groupCount).toBe(360);
      expect(result.variantCount).toBeGreaterThanOrEqual(360);
      const report = runLeakCheck(result.seatViewPaths, result.crosswalkPath);
      expect(report.verdict).toBe("pass");
      const seatSample = readFileSync(result.seatViewPaths[0], "utf8");
      expect(seatSample.includes("shard-1/group-")).toBe(false);
      expect(seatSample.includes("\"development\"")).toBe(false);
      const crosswalk = readFileSync(result.crosswalkPath, "utf8");
      expect(crosswalk.includes("slotKey")).toBe(true);
      for (const seatPath of result.seatViewPaths) {
        expect(readFileSync(seatPath, "utf8").includes("slotKey")).toBe(false);
      }
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });
});
