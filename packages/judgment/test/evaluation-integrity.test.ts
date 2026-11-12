import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeQualification, validateFreezeGroups, validateFreezeLabels, type QualificationRow } from "../src/evaluation.js";
import { loadPreviousDevelopmentState, runEvaluationCommand } from "../scripts/evaluate.js";
import { annotationRoot, fixtureRoot, frozenBudget, frozenRoot, sha256 } from "./fixtures/qualification-root.js";
const base: QualificationRow = { groupId: "g1", variantId: "v1", primary: true, gold: "same_cause", outcome: "accepted", rawLabel: "same_cause", accepted: true, lineageId: "lineage-a", causalClusterId: "cluster-a" };
async function captureCommand(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const output: string[] = [];
  const errors: string[] = [];
  const originalWrite = process.stdout.write;
  const originalErrorWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { output.push(chunk.toString()); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { errors.push(chunk.toString()); return true; }) as typeof process.stderr.write;
  try {
    return { code: await runEvaluationCommand(args), stdout: output.join(""), stderr: errors.join("") };
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrorWrite;
  }
}


const refusal = ({ code, stderr, stdout }: { code: number; stdout: string; stderr: string }): string =>
  `exit ${code}; stderr: ${stderr.trim() || "<empty>"}; stdout: ${stdout.trim().slice(0, 400) || "<empty>"}`;


describe("qualification integrity", () => {
  test("calibration admits a first run, then discovers the newest per-run state and request hashes", () => {
    const firstRunRoot = fixtureRoot({});
    const expected = { plannedVariants: 2, protocolSha256: sha256("protocol"), splitSha256: sha256("split"), goldSha256: sha256("gold") };
    try {
      expect(loadPreviousDevelopmentState(realpathSync(firstRunRoot), expected)).toEqual({
        firstRun: true, previousManifest: null, previousOutcomes: [],
      });
    } finally { rmSync(firstRunRoot, { recursive: true, force: true }); }
    const priorManifest = {
      runId: "previous-run", plannedVariants: expected.plannedVariants, identity: { runtimeSha256: sha256("runtime") },
      protocolSha256: expected.protocolSha256, splitSha256: expected.splitSha256, goldSha256: expected.goldSha256,
    };
    const olderManifest = { ...priorManifest, runId: "older-run" };
    const priorRequest = sha256("previous request");
    const priorRunRoot = fixtureRoot({
      "runs/development/older-run/run-manifest.json": JSON.stringify(olderManifest),
      "runs/development/older-run/development-run.json": JSON.stringify({ outcomes: [{ runId: "old-request", requestSha256: sha256("old request") }] }),
      "runs/development/previous-run/run-manifest.json": JSON.stringify(priorManifest),
      "runs/development/previous-run/development-run.json": JSON.stringify({ outcomes: [{ runId: "spent-request", requestSha256: priorRequest }] }),
    });
    try {
      const root = realpathSync(priorRunRoot);
      const state = loadPreviousDevelopmentState(root, expected);
      expect(state.firstRun).toBe(false);
      expect(state.previousManifest?.runId).toBe("previous-run");
      expect(state.previousOutcomes).toMatchObject([{ runId: "spent-request" }]);
      expect(() => loadPreviousDevelopmentState(root, { ...expected, goldSha256: sha256("changed") }))
        .toThrow("Development freeze identity changed");
    } finally { rmSync(priorRunRoot, { recursive: true, force: true }); }
  });
  test("partial prior-run state fails closed", () => {
    const root = fixtureRoot({
      "runs/development/partial-run/run-manifest.json": JSON.stringify({
        runId: "partial-run", plannedVariants: 2, identity: { runtimeSha256: sha256("runtime") },
        protocolSha256: sha256("protocol"), splitSha256: sha256("split"), goldSha256: sha256("gold"),
      }),
    });
    try {
      expect(() => loadPreviousDevelopmentState(realpathSync(root), {
        plannedVariants: 2, protocolSha256: sha256("protocol"), splitSha256: sha256("split"), goldSha256: sha256("gold"),
      })).toThrow("Development prior-run state incomplete");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
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
  test("insufficient evidence remains attributable only as model-abstain, never accepted completion credit", () => {
    const abstention = { ...base, gold: "insufficient_evidence" as const, rawLabel: "insufficient_evidence" as const, outcome: "model-abstain" as const, accepted: false };
    const summary = summarizeQualification([abstention]);
    expect(summary.outcomeCounts["model-abstain"]).toBe(1);
    expect(summary.outcomeCounts.accepted).toBe(0);
    expect(summary.endpoints.selectiveAccuracy.total).toBe(0);
    expect(() => summarizeQualification([{ ...abstention, outcome: "accepted", accepted: true }])).toThrow("acceptance-invalid");
  });
  test("freeze cohort closure and group denominators fail closed", () => {
    expect(() => validateFreezeGroups([
      { id: "g1", split: "development", lineageId: "lineage-x", causalClusterId: "cluster-1", variants: [{ id: "v1" }] },
      { id: "g2", split: "holdout", lineageId: "lineage-x", causalClusterId: "cluster-2", variants: [{ id: "v2" }] },
    ], { g1: "development", g2: "holdout" })).toThrow("Freeze lineage/causal cluster crosses cohorts");
    expect(() => validateFreezeGroups([
      { id: "g1", split: "development", lineageId: "lineage-1", causalClusterId: "cluster-1", variants: [{ id: "v1" }] },
    ], { g1: "development", missing: "holdout" })).toThrow("Freeze group denominator incomplete or duplicated");
    expect(() => validateFreezeGroups([
      { id: "g1", split: "development", lineageId: "lineage-1", causalClusterId: "cluster-1", variants: [{ id: "v1" }] },
    ], {})).toThrow("Freeze cohort assignment missing or invalid");
    expect(() => validateFreezeGroups([
      { id: "g1", split: "holdout", lineageId: "lineage-1", causalClusterId: "cluster-1", variants: [{ id: "v1" }] },
    ], { g1: "development" })).toThrow("Freeze corpus/split cohort mismatch");
  });
  test("reports declared cross-cohort clusters but refuses any collision member outside quarantine", () => {
    const pair = [
      { id: "q-dev", split: "development", lineageId: "shared-lineage", causalClusterId: "shared-causal", variants: [{ id: "a", primary: true }] },
      { id: "q-holdout", split: "holdout", lineageId: "shared-lineage", causalClusterId: "shared-causal", variants: [{ id: "b", primary: true }] },
    ];
    const assignments = { "q-dev": "development", "q-holdout": "holdout" };
    const reported = validateFreezeGroups(pair, assignments, new Set(["q-dev", "q-holdout"]));
    expect(reported.map((collision) => collision.kind)).toEqual(["lineage", "causal"]);
    expect(() => validateFreezeGroups([
      ...pair,
      { id: "unlisted", split: "holdout", lineageId: "shared-lineage", causalClusterId: "shared-causal", variants: [{ id: "c", primary: true }] },
    ], { ...assignments, unlisted: "holdout" }, new Set(["q-dev", "q-holdout"]))).toThrow("Freeze lineage/causal cluster crosses cohorts");
  });
  test("freeze requires one A and one B label per adjudicated item", () => {
    const gold = [{ itemId: "i1", groupId: "g1" }];
    expect(() => validateFreezeLabels(gold, [
      { itemId: "i1", groupId: "g1", label: "same_cause", seat: "A" },
    ])).toThrow("Freeze requires two seat labels per case");
    expect(() => validateFreezeLabels(gold, [
      { itemId: "i1", groupId: "g1", label: "same_cause", seat: "A" },
      { itemId: "i1", groupId: "g1", label: "different_cause", seat: "A" },
    ])).toThrow("Freeze duplicate seat label");
  });
  test("reports quarantined cluster collisions separately from eligible denominators", async () => {
    const root = frozenRoot();
    try {
      const result = await captureCommand(["check-corpus", "--root", root]);
      expect(result.code, refusal(result)).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.status).toBe("quarantined-collision");
      expect(report.assignmentCounts).toEqual({ developmentGroups: 60, holdoutGroups: 300, totalGroups: 360 });
      expect(report.eligibleDenominators).toEqual({
        developmentGroups: 59, holdoutGroups: 299, totalGroups: 358,
        developmentPrimaryCases: 59, holdoutPrimaryCases: 299, totalPrimaryCases: 358,
      });
      expect(report.quarantinedCollisions).toHaveLength(2);
      expect(report.quarantinedCollisions.every((collision: { excludedFromEligibleDenominators: boolean }) => collision.excludedFromEligibleDenominators)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("unrecorded collisions cannot hide behind a valid quarantine record", async () => {
    const root = frozenRoot({ unrecordedCollision: true });
    try { expect(await runEvaluationCommand(["check-corpus", "--root", root])).toBe(2); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("check-annotations accepts all reduced-pack support shapes and equivalent declared identities", async () => {
    const row = {
      itemId: "item-1", itemDigest: sha256("item"), sourceSha256: sha256("source"),
      label: "same_cause", rationale: "An evidence-grounded synthetic annotation.",
      anchors: [{ sourceRef: "opaque-source", lines: "1-2" }],
    };
    const cases = [
      { seat: "A", shard: 1, annotation: { ...row, reducedPackSupport: { status: "sufficient", explanation: "Status-shaped." } } },
      { seat: "A", shard: 2, annotation: { ...row, reducedPackSupport: { label: "sufficient", explanation: "Label-shaped." } } },
      { seat: "A", shard: 3, annotation: { ...row, reducedPackSupport: "sufficient", seat: "A", shard: "3" } },
      { seat: "A", shard: 4, annotation: { ...row, reducedPackSupport: "unresolved", seat: "A/4" } },
      { seat: "B", shard: 3, annotation: { ...row, reducedPackSupport: "insufficient", seat: "B", shard: 3 } },
    ];
    const roots = cases.map(({ seat, shard, annotation }) =>
      annotationRoot(`${JSON.stringify(annotation)}\n`, seat, shard));
    try {
      for (let index = 0; index < cases.length; index++) {
        const { seat, shard } = cases[index]!;
        const result = await captureCommand(["check-annotations", "--root", roots[index]!, "--seat", seat, "--shard", String(shard)]);
        expect(result.code, refusal(result)).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.annotations).toBe(1);
        expect(report.identityMetadata.sessionId.status).toBe("undeclared");
      }
      expect(JSON.parse((await captureCommand(["check-annotations", "--root", roots[0]!, "--seat", "A", "--shard", "1"])).stdout).identityMetadata.seat.status).toBe("undeclared");
    } finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
  });
  test("check-annotations rejects unknown items and malformed reduced-pack support shapes", async () => {
    const valid = { itemId: "item-1", itemDigest: sha256("item"), sourceSha256: sha256("source"), label: "same_cause", rationale: "Grounded.", reducedPackSupport: { label: "sufficient", explanation: "Supported." }, citations: ["opaque-source:1"] };
    const invalidSupports = [
      undefined,
      { explanation: "Missing status." },
      { status: "invalid_support", explanation: "Invalid status." },
      { explanation: "Missing label." },
      { label: "invalid_support", explanation: "Invalid label." },
      "invalid_support",
    ];
    const roots = [
      annotationRoot(`${JSON.stringify({ ...valid, itemId: "unknown" })}\n`),
      ...invalidSupports.map((reducedPackSupport) => annotationRoot(`${JSON.stringify({ ...valid, reducedPackSupport })}\n`)),
    ];
    try {
      for (const root of roots) expect(await runEvaluationCommand(["check-annotations", "--root", root, "--seat", "A", "--shard", "1"])).toBe(2);
    } finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
  });
  test("check-annotations rejects unknown, duplicate, and incomplete annotation rows", async () => {
    const valid = { itemId: "item-1", itemDigest: sha256("item"), sourceSha256: sha256("source"), label: "same_cause", rationale: "Grounded.", reducedPackSupport: { label: "sufficient", explanation: "Supported." }, citations: ["opaque-source:1"] };
    const roots = [
      annotationRoot(`${JSON.stringify({ ...valid, itemId: "unknown" })}\n`),
      annotationRoot(`${JSON.stringify(valid)}\n${JSON.stringify(valid)}\n`),
      annotationRoot(`${JSON.stringify({ ...valid, label: undefined })}\n`),
      annotationRoot(`${JSON.stringify({ ...valid, label: "invalid_label" })}\n`),
      annotationRoot(`${JSON.stringify({ ...valid, reducedPackSupport: undefined })}\n`),
      annotationRoot(`${JSON.stringify({ ...valid, reducedPackSupport: { label: "invalid_support", explanation: "Bad." } })}\n`),
    ];
    try {
      for (const root of roots) expect(await runEvaluationCommand(["check-annotations", "--root", root, "--seat", "A", "--shard", "1"])).toBe(2);
    } finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
  });
  test("check-freeze recomputes committed corpus and annotation hashes", async () => {
    const root = frozenRoot();
    try {
      writeFileSync(join(root, "corpus.json"), '{"groups":[]}\n');
      expect(await runEvaluationCommand(["check-freeze", "--root", root])).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
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
  test("accepts frozen provider-context prose but rejects missing method and contradictory claims", async () => {
    const budget = frozenBudget;
    const protocol = JSON.stringify({ schema: "mstar.qualification-protocol/v1", contractRevision: "phase3a-native-20260924", mode: "shadow", transport: "native-typesafe" });
    const permission = JSON.stringify({ contractRevision: "phase3a-native-20260924", status: "synthetic-only-policy-declaration; not a self-authorizing pilot" });
    const makeRoot = (value: typeof budget) => fixtureRoot({ "protocol.json": protocol, "budget.json": JSON.stringify(value), "permission.json": permission });
    const valid = makeRoot(budget);
    const missingMethod = makeRoot({ ...budget, tokenPolicy: { ...budget.tokenPolicy, method: "" } });
    const contradictory = makeRoot({ ...budget, tokenPolicy: { ...budget.tokenPolicy, providerContextPolicy: `${budget.tokenPolicy.providerContextPolicy}; local tokenizer estimate enabled` } });
    try {
      const result = await captureCommand(["check-protocol", "--root", valid]);
      expect(result.code, refusal(result)).toBe(0);
      expect(await runEvaluationCommand(["check-protocol", "--root", missingMethod])).toBe(2);
      expect(await runEvaluationCommand(["check-protocol", "--root", contradictory])).toBe(2);
    } finally { for (const root of [valid, missingMethod, contradictory]) rmSync(root, { recursive: true, force: true }); }
  });
  test("requires manifest schema and well-formed frozen split identity", async () => {
    const valid = frozenRoot();
    const wrongManifestSchema = frozenRoot({ manifestSchema: "mstar.other-manifest/v1" });
    const missingManifestSchema = frozenRoot({ manifestSchema: null });
    const invalidFreezeId = frozenRoot({ freezeId: "not a valid ID" });
    const invalidFrozenAt = frozenRoot({ frozenAt: "not-a-timestamp" });
    const roots = [valid, wrongManifestSchema, missingManifestSchema, invalidFreezeId, invalidFrozenAt];
    try {
      const result = await captureCommand(["check-freeze", "--root", valid]);
      expect(result.code, refusal(result)).toBe(0);
      for (const root of roots.slice(1)) expect(await runEvaluationCommand(["check-freeze", "--root", root])).toBe(2);
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  });
  test("requires third-read dispositions and rejects old-fixture provenance", async () => {
    const missingDisposition = frozenRoot({ missingDisposition: true });
    const oldFixture = frozenRoot({ invalidOrigin: true });
    try {
      expect(await runEvaluationCommand(["check-freeze", "--root", missingDisposition])).toBe(2);
      expect(await runEvaluationCommand(["check-freeze", "--root", oldFixture])).toBe(2);
    } finally {
      rmSync(missingDisposition, { recursive: true, force: true });
      rmSync(oldFixture, { recursive: true, force: true });
    }
  });
  test("check-freeze recomputes corpus and annotation file hashes", async () => {
    const corpusRoot = frozenRoot();
    const annotationRoot = frozenRoot();
    try {
      writeFileSync(join(corpusRoot, "corpus.json"), '{"groups":[]}\n');
      writeFileSync(join(annotationRoot, "annotations/A-1.jsonl"), '{"changed":true}\n');
      expect(await runEvaluationCommand(["check-freeze", "--root", corpusRoot])).toBe(2);
      expect(await runEvaluationCommand(["check-freeze", "--root", annotationRoot])).toBe(2);
    } finally {
      rmSync(corpusRoot, { recursive: true, force: true });
      rmSync(annotationRoot, { recursive: true, force: true });
    }
  });
  test("check-freeze refuses missing quarantine records and unadjusted eligible denominators", async () => {
    const missingQuarantine = frozenRoot({ missingQuarantine: true });
    const wrongEligibleCounts = frozenRoot({ badEligibleDenominators: true });
    try {
      expect(await runEvaluationCommand(["check-freeze", "--root", missingQuarantine])).toBe(2);
      expect(await runEvaluationCommand(["check-freeze", "--root", wrongEligibleCounts])).toBe(2);
    } finally {
      rmSync(missingQuarantine, { recursive: true, force: true });
      rmSync(wrongEligibleCounts, { recursive: true, force: true });
    }
  });
  test("check-freeze rejects annotations for corpus variants without gold rows", async () => {
    const root = frozenRoot({ missingGoldForAnnotatedVariant: true });
    try {
      expect(await runEvaluationCommand(["check-freeze", "--root", root])).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("check-freeze recomputes the manifest digest committed by freeze.json", async () => {
    const root = frozenRoot();
    try {
      const freeze = JSON.parse(readFileSync(join(root, "freeze.json"), "utf8")) as Record<string, string>;
      freeze.manifestSha256 = "0".repeat(64);
      writeFileSync(join(root, "freeze.json"), JSON.stringify(freeze));
      expect(await runEvaluationCommand(["check-freeze", "--root", root])).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("rejects empty gold despite embedded split digests", async () => {
    const root = frozenRoot({ emptyGold: true });
    try {
      expect(await runEvaluationCommand(["check-freeze", "--root", root])).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("shard corpus checks still validate global lineage closure", async () => {
    const root = frozenRoot({ unrecordedCollision: true });
    try {
      expect(await runEvaluationCommand(["check-corpus", "--root", root, "--shard", "3"])).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
