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
  test("#340 instance 4 catch-all without structured recovery is missing-recovery despite its identical-failure rerun message", () => {
    expect(refusalScan("instance-4-catchall.ts").map(({ classification }) => classification)).toEqual(["missing-recovery"]);
  });

  test("#340 instance 5 wrong-path restore-preview is capability-unreachable", () => {
    expect(reachabilityScan("instance-5-wrong-command.ts").map(({ classification }) => classification)).toContain("capability-unreachable");
  });

  test("shorthand recovery with unsupported command is capability-unreachable", () => {
    expect(reachabilityScan("shorthand-unsupported-recovery.ts").map(({ classification }) => classification)).toContain("capability-unreachable");
  });

  test("conditional spread supported true branch is accepted when false branch is absent", () => {
    expect(reachabilityScan("conditional-supported-recovery.ts")).toHaveLength(0);
  });

  test("conditional spread inspects its distinct unsupported false branch", () => {
    expect(reachabilityScan("conditional-unsupported-recovery.ts").map(({ classification }) => classification)).toContain("capability-unreachable");
  });

  test("#340 instances 6 and 8 remain semantic, not grammar-only, coverage gaps", () => {
    expect(reachabilityScan("instances-6-and-8-unsupported-context.ts")).toHaveLength(0);
  });

  test("#341 C-class prepare seal is detected by hash-gates as a hash gate", () => {
    expect(scanHashGates("prepare-seal-hash-gate.ts", fixture("prepare-seal-hash-gate.ts")).map(({ classification }) => classification)).toContain("hash-gate");
  });

  test("structured usage, provenance-only hash, and reachable refusal controls are clean", () => {
    expect(refusalScan("clean-controls.ts")).toHaveLength(0);
    expect(reachabilityScan("clean-controls.ts")).toHaveLength(0);
    expect(scanHashGates("clean-controls.ts", fixture("clean-controls.ts")).filter(({ classification }) => classification !== "record-only" && classification !== "replay-allowed")).toHaveLength(0);
  });
});
