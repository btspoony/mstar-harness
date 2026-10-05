import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { resolveRegisteredPlanFile } from "./plan-path.js";

describe("resolveRegisteredPlanFile", () => {
  test("target-mismatch refusal first line names both permitted forms", () => {
    const harnessRoot = mkdtempSync(join(tmpdir(), "mstar-plan-path-test-"));
    let message = "";

    try {
      resolveRegisteredPlanFile({ harnessRoot, planId: "sample-plan", file: "elsewhere/sample-plan.md" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    const firstLine = message.split("\n", 1)[0]!;
    expect(firstLine).toContain("permitted forms are canonical absolute path");
    expect(firstLine).toContain("normalized harness-relative path resolved against");
  });
});
