import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeQualification, validateFreezeGroups, validateFreezeLabels, type QualificationRow } from "../src/evaluation.js";
import { runEvaluationCommand } from "../scripts/evaluate.js";
const base: QualificationRow = { groupId: "g1", variantId: "v1", primary: true, gold: "same_cause", outcome: "accepted", rawLabel: "same_cause", accepted: true, lineageId: "lineage-a", causalClusterId: "cluster-a" };
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
function fixtureRoot(artifacts: Record<string, string>, manifestSchema: string | null = "mstar.qualification-manifest/v1"): string {
  const allArtifacts = { "protocol.json": "{}", ...artifacts };
  const root = mkdtempSync(join(tmpdir(), "qualification-eval-"));
  const committed = Object.entries(allArtifacts).filter(([path]) => path !== "freeze.json");
  for (const [path, content] of committed) {
    const target = join(root, path);
    const parent = target.slice(0, target.lastIndexOf("/"));
    mkdirSync(parent, { recursive: true });
    writeFileSync(target, content);
  }
  const files = committed.map(([path, content]) => ({ path, sha256: sha256(content) }));
  const manifestBytes = JSON.stringify({ ...(manifestSchema === null ? {} : { schema: manifestSchema }), contractRevision: "phase3a-native-20260924", files });
  writeFileSync(join(root, "manifest.json"), manifestBytes);
  if (Object.hasOwn(allArtifacts, "freeze.json")) {
    const byPath = new Map(files.map((entry) => [entry.path, entry.sha256]));
    const annotationCommitments = files.filter((entry) => /^annotations\/[AB]-[1-4]\.jsonl$/.test(entry.path))
      .sort((left, right) => left.path.localeCompare(right.path));
    writeFileSync(join(root, "freeze.json"), JSON.stringify({
      manifestSha256: sha256(manifestBytes), sourceManifestSha256: sha256(manifestBytes),
      corpusSha256: byPath.get("corpus.json"), splitSha256: byPath.get("split-manifest.json"),
      goldSha256: byPath.get("gold/adjudicated.jsonl"), adjudicationSha256: byPath.get("adjudication.jsonl"),
      annotationSha256: sha256(JSON.stringify(annotationCommitments)),
    }));
  }
  return root;
}

function frozenRoot(overrides: { manifestSchema?: string | null; freezeId?: string; frozenAt?: string; splitSchema?: string; missingDisposition?: boolean; invalidOrigin?: boolean } = {}): string {
  const sourceSha256 = sha256("source");
  const itemDigest = sha256("item");
  const gold = `${JSON.stringify({ itemId: "item-1", groupId: "1/g1", label: "insufficient_evidence" })}\n`;
  const assignments = { "1/g1": "holdout" };
  const split = JSON.stringify({
    schema: overrides.splitSchema ?? "mstar.qualification-split-manifest/v1",
    contractRevision: "phase3a-native-20260924",
    freezeId: overrides.freezeId ?? "freeze-1",
    frozenAt: overrides.frozenAt ?? "2026-09-24T00:00:00.000Z",
    assignments,
    assignmentSha256: sha256(JSON.stringify(assignments)),
    goldSha256: sha256(gold),
    goldCount: 1,
  });
  const corpus = JSON.stringify({ groups: [
    { id: "1/g1", split: "holdout", lineageId: "lineage-1", causalClusterId: "cluster-1", variants: [{ id: "item-1", primary: true }] },
  ] });
  const annotations: Record<string, string> = {};
  for (const seat of ["A", "B"]) {
    for (const shard of [1, 2, 3, 4]) {
      annotations[`annotations/${seat}-${shard}.jsonl`] = shard === 1
        ? `${JSON.stringify({ itemId: "item-1", groupId: "1/g1", label: seat === "A" ? "same_cause" : "insufficient_evidence", reducedPackSupport: "sufficient", sourceSha256, itemDigest })}\n`
        : "";
    }
  }
  const adjudication = {
    itemId: "item-1", groupId: "1/g1", labelA: "same_cause", labelB: "insufficient_evidence",
    sourceSha256, itemDigest, ...(overrides.missingDisposition ? {} : { disposition: "resolved_insufficiency" }),
    resolvedLabel: "insufficient_evidence", rationale: "synthetic test rationale", sourceEvidence: [{ source: "file-1", line: 1 }],
  };
  const origins = [
    "Newly authored synthetic source families in this session; no real-source derivation or old fixture reuse.",
    "Newly authored synthetic source and review findings; no production source or explored fixtures used.",
    "New domain-specific synthetic source families written in this author session from the brief, without consulting historical fixtures or other shards.",
    "Newly authored synthetic repository/source families, not derived from exploratory fixtures, production code, or external data.",
  ];
  const authors = Object.fromEntries(origins.map((origin, index) => [
    `authoring/shard-${index + 1}-provenance.json`,
    JSON.stringify({ origin: overrides.invalidOrigin && index === 0 ? "Synthetic source derived from old fixtures." : origin }),
  ]));
  return fixtureRoot({
    "split-manifest.json": split,
    "gold/adjudicated.jsonl": gold,
    "corpus.json": corpus,
    "adjudication.jsonl": `${JSON.stringify(adjudication)}\n`,
    "freeze.json": "{}",
    ...annotations,
    ...authors,
  }, overrides.manifestSchema);
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
  test("rejects contradictory reservation prose even when it contains the required disclaimer", async () => {
    const budget = {
      contractRevision: "phase3a-native-20260924",
      tokenPolicy: {
        method: "provider-context-reservation/v1",
        perAttemptReservation: 65_536,
        maxRunReservedInputTokens: 65_536_000,
        providerContextPolicy: "local tokenizer estimate enabled; no local tokenizer/preflight context-fit claim",
      },
      requestAllocation: {
        developmentVariantCallsMax: 120, holdoutVariantCallsMax: 600, temporalVariantCallsMax: 48,
        variantCallsMax: 768, selectedControlCallsMax: 32, allocatedCallsMax: 800,
        unallocatedSafetyHeadroomNotRetries: 200, allRequestsMax: 1_000,
      },
      attemptPolicy: "No SDK retry",
      maxPacksPerRun: 1_000, maxTasksPerPack: 4, maxPairsPerPack: 4,
      maxAttemptsPerRequest: 1, maxConcurrentRequests: 1, timeoutMsPerOperation: 10_000,
      maxRunOptionalElapsedMs: 10_000_000, maxPackBytes: 65_536,
      maxOutboundRequestBytes: 32_768, maxResponseBytes: 65_536,
    };
    const root = fixtureRoot({
      "protocol.json": JSON.stringify({ schema: "mstar.qualification-protocol/v1", contractRevision: "phase3a-native-20260924", mode: "shadow", transport: "native-typesafe" }),
      "budget.json": JSON.stringify(budget),
      "permission.json": JSON.stringify({ contractRevision: "phase3a-native-20260924", status: "synthetic-only-policy-declaration; not a self-authorizing pilot" }),
    });
    try {
      expect(await runEvaluationCommand(["check-protocol", "--root", root])).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("requires manifest schema and well-formed frozen split identity", async () => {
    const valid = frozenRoot();
    const wrongManifestSchema = frozenRoot({ manifestSchema: "mstar.other-manifest/v1" });
    const missingManifestSchema = frozenRoot({ manifestSchema: null });
    const invalidFreezeId = frozenRoot({ freezeId: "not a valid ID" });
    const invalidFrozenAt = frozenRoot({ frozenAt: "not-a-timestamp" });
    const roots = [valid, wrongManifestSchema, missingManifestSchema, invalidFreezeId, invalidFrozenAt];
    try {
      expect(await runEvaluationCommand(["check-freeze", "--root", valid])).toBe(0);
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
