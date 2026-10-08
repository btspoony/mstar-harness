import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { scanSource as scanRefusals, extractCliGrammar } from "./lint-refusal-quality";
import { scanRecoveryText } from "./lint-help-reachability";
import { scanSource as scanHashGates } from "./lint-hash-gates";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures/overdesign-backtest", name), "utf8");
const grammar = extractCliGrammar();
const refusalScan = (name: string) => scanRefusals(fixture(name), name);
const reachabilityScan = (name: string) => scanRecoveryText(fixture(name), name, grammar);

describe("over-design known-answer backtest", () => {
  test("#340 instance 4 generic catch-all without designed recovery is missing-recovery", () => {
    expect(refusalScan("instance-4-catchall.ts").map(({ classification }) => classification)).toContain("missing-recovery");
  });

  test("#340 instance 5 wrong-path restore-preview is capability-unreachable", () => {
    expect(reachabilityScan("instance-5-wrong-command.ts").map(({ classification }) => classification)).toContain("capability-unreachable");
  });

  test("conditional recovery with unsupported command remains capability-unreachable", () => {
    expect(reachabilityScan("conditional-unsupported-recovery.ts").map(({ classification }) => classification)).toContain("capability-unreachable");
  });
  test("#340 instances 6 and 8 are not mechanically classified by verb grammar", () => {
    expect(reachabilityScan("instances-6-and-8-unsupported-context.ts")).toHaveLength(0);
  });

  test("#341 C-class prepare seal is detected by hash-gates as a hash gate", () => {
    expect(scanHashGates("prepare-seal-hash-gate.ts", fixture("prepare-seal-hash-gate.ts")).map(({ classification }) => classification)).toContain("hash-gate");
  });

  test("#340 unsorted-set index comparison is explicitly an uncovered static rule", () => {
    expect(scanRefusals(fixture("unsorted-enumeration-index-comparison.ts"), "unsorted-enumeration-index-comparison.ts")).toHaveLength(0);
    expect(scanHashGates("unsorted-enumeration-index-comparison.ts", fixture("unsorted-enumeration-index-comparison.ts"))).toHaveLength(0);
  });

  test("clean usage, provenance-only hash, and cause plus reachable recovery are clean", () => {
    expect(refusalScan("clean-controls.ts")).toHaveLength(0);
    expect(reachabilityScan("clean-controls.ts")).toHaveLength(0);
    expect(scanHashGates("clean-controls.ts", fixture("clean-controls.ts")).filter(({ classification }) => classification !== "record-only" && classification !== "replay-allowed")).toHaveLength(0);
  });
});
