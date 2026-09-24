import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeQualification, type QualificationRow } from "../src/evaluation.js";
import { runEvaluationCommand } from "../scripts/evaluate.js";
const base: QualificationRow = { groupId: "g1", variantId: "v1", primary: true, gold: "same_cause", outcome: "accepted", rawLabel: "same_cause", accepted: true, lineageId: "lineage-a", causalClusterId: "cluster-a" };
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
function fixtureRoot(artifacts: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "qualification-eval-"));
  for (const [path, content] of Object.entries(artifacts)) {
    const target = join(root, path);
    const parent = target.slice(0, target.lastIndexOf("/"));
    mkdirSync(parent, { recursive: true });
    writeFileSync(target, content);
  }
  const files = Object.entries(artifacts).map(([path, content]) => ({ path, sha256: sha256(content) }));
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ schema: "mstar.qualification-manifest/v1", contractRevision: "phase3a-native-20260924", files }));
  return root;
}

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
  test("does not certify omitted coverage and refuses groups without one declared primary", () => {
    expect(summarizeQualification([base]).coverageRegression).toBeNull();
    expect(summarizeQualification([base]).coverageComplete).toBe(false);
    expect(() => summarizeQualification([{ ...base, primary: undefined }])).toThrow("primary-required");
  });
  test("rejects raw labels for failed or unissued outcomes", () => {
    expect(() => summarizeQualification([{ ...base, outcome: "transport-failure", accepted: false }])).toThrow("acceptance-invalid");
    expect(() => summarizeQualification([{ ...base, outcome: "budget", accepted: false }])).toThrow("acceptance-invalid");
  });
  test("reports reproducible causal-cluster bootstrap intervals", () => {
    const rows = [
      base,
      { ...base, groupId: "g2", lineageId: "lineage-b", causalClusterId: "cluster-b", gold: "different_cause" as const, rawLabel: "different_cause" as const },
      { ...base, groupId: "g3", lineageId: "lineage-c", causalClusterId: "cluster-c", outcome: "policy-abstain" as const, accepted: false, rawLabel: "same_cause" as const },
    ];
    const first = summarizeQualification(rows);
    const second = summarizeQualification(rows);
    expect(first.bootstrap.method).toBe("seeded-causal-cluster-bootstrap/v1");
    expect(first.bootstrap).toEqual(second.bootstrap);
    expect(first.bootstrap.clusters).toBe(3);
    expect(first.bootstrap.endpoints.precision.lower95).not.toBeNull();
  });
  test("rejects non-frozen reservation settings", async () => {
    const root = fixtureRoot({
      "protocol.json": JSON.stringify({ schema: "mstar.qualification-protocol/v1", contractRevision: "phase3a-native-20260924", mode: "shadow", transport: "native-typesafe" }),
      "budget.json": JSON.stringify({ contractRevision: "phase3a-native-20260924", tokenPolicy: { method: "local-token-estimate", perAttemptReservation: 65536, maxRunReservedInputTokens: 65536000 }, attemptPolicy: "No SDK retry" }),
      "permission.json": JSON.stringify({ contractRevision: "phase3a-native-20260924", status: "synthetic-only-policy-declaration; not a self-authorizing pilot" }),
    });
    try {
      expect(await runEvaluationCommand(["check-protocol", "--root", root])).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("rejects empty gold despite embedded split digests", async () => {
    const gold = "";
    const assignments = { "1/g1": "holdout" };
    const split = JSON.stringify({
      schema: "mstar.qualification-split-manifest/v1", contractRevision: "phase3a-native-20260924",
      freezeId: "freeze-1", frozenAt: "2026-09-24T00:00:00Z", assignments,
      assignmentSha256: sha256(JSON.stringify(assignments)), goldSha256: sha256(gold), goldCount: 0,
    });
    const root = fixtureRoot({ "split-manifest.json": split, "gold/adjudicated.jsonl": gold });
    try {
      expect(await runEvaluationCommand(["check-freeze", "--root", root])).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("shard corpus checks still validate global lineage closure", async () => {
    const corpus = JSON.stringify({ groups: [
      { id: "1/g1", split: "development", lineageId: "lineage-shared", causalClusterId: "cluster-1", variants: [{ id: "v1", primary: true }] },
      { id: "2/g2", split: "holdout", lineageId: "lineage-shared", causalClusterId: "cluster-2", variants: [{ id: "v1", primary: true }] },
    ] });
    const root = fixtureRoot({ "corpus.json": corpus });
    try {
      expect(await runEvaluationCommand(["check-corpus", "--root", root, "--shard", "1"])).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
