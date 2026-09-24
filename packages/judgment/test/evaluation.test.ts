import { describe, expect, test } from "bun:test";
import { clopperPearsonLower, classifyOutcome, summarizeQualification, type QualificationRow } from "../src/evaluation.js";

const row = (overrides: Partial<QualificationRow> = {}): QualificationRow => ({ groupId: "g1", variantId: "v1", primary: true, gold: "same_cause", outcome: "accepted", rawLabel: "same_cause", accepted: true, ...overrides });

describe("deterministic qualification metrics", () => {
  test("preserves outcome buckets and reason distinctions", () => {
    expect(classifyOutcome("model-abstain")).toEqual({ bucket: "model-abstain", reason: "model-abstain" });
    expect(classifyOutcome("policy-abstain")).toEqual({ bucket: "policy-abstain", reason: "policy-abstain" });
    expect(classifyOutcome("insufficient-input")).toEqual({ bucket: "unissued", reason: "insufficient-input" });
    expect(classifyOutcome("budget")).toEqual({ bucket: "unissued", reason: "budget" });
  });
  test("computes exact one-sided CP boundaries, including 58/59", () => {
    expect(clopperPearsonLower(0, 12)).toBe(0);
    expect(clopperPearsonLower(59, 59)).toBeCloseTo(0.9505, 3);
    expect(clopperPearsonLower(58, 59)).toBeLessThan(0.95);
    expect(clopperPearsonLower(58, 59)).toBeCloseTo(0.922, 2);
    expect(clopperPearsonLower(0, 0)).toBeNull();
  });
  test("keeps raw accuracy distinct from policy-useful accuracy and never credits unresolved gold", () => {
    const summary = summarizeQualification([
      row(),
      row({ groupId: "g2", variantId: "v1", gold: "unresolved", rawLabel: "same_cause" }),
      row({ groupId: "g3", variantId: "v1", gold: "different_cause", outcome: "policy-abstain", rawLabel: "different_cause", accepted: false }),
      row({ groupId: "g4", variantId: "v1", gold: "insufficient_evidence", outcome: "model-abstain", rawLabel: "insufficient_evidence", accepted: false }),
    ]);
    expect(summary.rawResolvedAccuracy).toEqual({ correct: 3, total: 3, value: 1 });
    expect(summary.policyUsefulAccuracy).toEqual({ correct: 1, total: 1, value: 1 });
    expect(summary.unresolvedGold).toBe(1);
    expect(summary.endpoints.usefulSameRecall).toMatchObject({ successes: 1, total: 1 });
    expect(summary.outcomeCounts["model-abstain"]).toBe(1);
    expect(summary.outcomeCounts["policy-abstain"]).toBe(1);
    expect(summary.bMinusA).toEqual({ credited: false, value: 0 });
  });
  test("counts every attempted failure and timeout as an opportunity miss", () => {
    const summary = summarizeQualification([
      row({ outcome: "transport-failure", rawLabel: undefined, accepted: false, attempted: true }),
      row({ groupId: "g2", outcome: "cancellation", rawLabel: undefined, accepted: false, attempted: false }),
      row({ groupId: "g3", outcome: "invalid-response", rawLabel: undefined, accepted: false, attempted: true }),
    ]);
    expect(summary.outcomeCounts["transport-failure"]).toBe(1);
    expect(summary.unissuedReasons.cancellation).toBe(1);
    expect(summary.endpoints.usefulSameRecall).toMatchObject({ successes: 0, total: 3 });
  });
  test("replayed raw rows have byte-for-byte deterministic aggregate output", () => {
    const rows = [row(), row({ groupId: "g2", variantId: "v1", gold: "different_cause", rawLabel: "different_cause" })];
    expect(JSON.stringify(summarizeQualification(rows))).toBe(JSON.stringify(summarizeQualification(structuredClone(rows))));
  });
});
