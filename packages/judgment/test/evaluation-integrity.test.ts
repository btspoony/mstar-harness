import { describe, expect, test } from "bun:test";
import { summarizeQualification, type QualificationRow } from "../src/evaluation.js";
const base: QualificationRow = { groupId: "g1", variantId: "v1", primary: true, gold: "same_cause", outcome: "accepted", rawLabel: "same_cause", accepted: true, lineageId: "lineage-a", causalClusterId: "cluster-a" };

describe("qualification integrity", () => {
  test("refuses duplicated primary opportunities and cross-group lineage leakage", () => {
    expect(() => summarizeQualification([base, { ...base, variantId: "v2", primary: true }])).toThrow("primary-duplicate");
    expect(() => summarizeQualification([base, { ...base, groupId: "g2", variantId: "v2", lineageId: "lineage-a", causalClusterId: "cluster-b" }])).toThrow("group-leakage");
  });
  test("retains related variants as diagnostics without increasing independent primary N", () => {
    const summary = summarizeQualification([base, { ...base, variantId: "v2", primary: false, rawLabel: "different_cause" }]);
    expect(summary.totals.groups).toBe(1);
    expect(summary.totals.variants).toBe(2);
    expect(summary.endpoints.precision.total).toBe(1);
  });
  test("refuses mixed-arm aggregation", () => {
    expect(() => summarizeQualification([
      { ...base, arm: "B" },
      { ...base, groupId: "g2", variantId: "v1", lineageId: "lineage-b", causalClusterId: "cluster-b", arm: "C" },
    ])).toThrow("arm-mixing");
  });
  test("flags loss against the original inventory and never credits engineering-only B-A", () => {
    const summary = summarizeQualification([base], { originalUnitIds: ["u1", "u2"], aCoverage: ["u1", "u2"], bCoverage: ["u1"], cCoverage: ["u1"] });
    expect(summary.coverageRegression).toBe(1);
    expect(summary.bMinusA.credited).toBe(false);
  });
  test("resolved insufficient evidence is a gold class, not unresolved adjudication", () => {
    const summary = summarizeQualification([{ ...base, gold: "insufficient_evidence", outcome: "model-abstain", rawLabel: "insufficient_evidence", accepted: false }]);
    expect(summary.unresolvedGold).toBe(0);
    expect(summary.rawResolvedAccuracy.value).toBe(1);
    expect(summary.endpoints.selectiveAccuracy.total).toBe(0);
  });
});
