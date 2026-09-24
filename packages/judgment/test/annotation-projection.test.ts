import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opaqueId128, runAnnotationProjection, runLeakCheck } from "../src/annotation-projection.js";

function qualificationFixture(root: string): string {
  const qualificationRoot = join(root, "qualification");
  const sources = join(qualificationRoot, "sources");
  mkdirSync(sources, { recursive: true });
  writeFileSync(join(qualificationRoot, "annotation-brief.md"), "# Annotation fixture\n");
  const sourceText = "synthetic evidence text\n";
  const sha256 = createHash("sha256").update(sourceText).digest("hex");
  for (let shard = 1; shard <= 4; shard++) {
    const groups = Array.from({ length: 90 }, (_, index) => {
      const id = `shard-${shard}/group-${String(index + 1).padStart(3, "0")}`;
      return {
        id,
        lineageId: `lineage-${shard}-${index}`,
        causalClusterId: `cluster-${shard}-${index}`,
        sourceFiles: { "src/evidence.ts": { text: sourceText, sha256 } },
        variants: [{
          id: `variant-${shard}-${index}`,
          left: { id: `finding-left-${shard}-${index}`, claim: "left claim", citations: [{ sourceRef: "src/evidence.ts", startLine: 1, endLine: 1, excerpt: "synthetic evidence" }] },
          right: { id: `finding-right-${shard}-${index}`, claim: "right claim", citations: [{ sourceRef: "src/evidence.ts", startLine: 1, endLine: 1, excerpt: "synthetic evidence" }] },
        }],
      };
    });
    writeFileSync(join(sources, `shard-${shard}.jsonl`), `${groups.map((group) => JSON.stringify(group)).join("\n")}\n`);
  }
  return qualificationRoot;
}

describe("annotation projection", () => {
  test("opaque ids are unique 128-bit hex", () => {
    const used = new Set<string>();
    const id = opaqueId128(used);
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(used.has(id)).toBe(true);
  });

  test("projects all shards and passes leak check", () => {
    const fixtureParent = mkdtempSync(join(tmpdir(), "annotation-projection-test-"));
    const qualificationRoot = qualificationFixture(fixtureParent);
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
      const seatSample = readFileSync(result.seatViewPaths[0]!, "utf8");
      expect(seatSample.includes("shard-1/group-")).toBe(false);
      expect(seatSample.includes("\"development\"")).toBe(false);
      const crosswalk = readFileSync(result.crosswalkPath, "utf8");
      expect(crosswalk.includes("slotKey")).toBe(true);
      for (const seatPath of result.seatViewPaths) {
        expect(readFileSync(seatPath, "utf8").includes("slotKey")).toBe(false);
      }
    } finally {
      rmSync(fixtureParent, { recursive: true, force: true });
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });
});
