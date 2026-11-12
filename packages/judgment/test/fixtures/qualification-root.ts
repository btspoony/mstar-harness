import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export const frozenBudget = {
  contractRevision: "phase3a-native-20260924",
  tokenPolicy: {
    method: "provider-context-reservation/v1",
    perAttemptReservation: 65_536,
    maxRunReservedInputTokens: 65_536_000,
    providerContextPolicy: "64k total context and 32k state plus longest question per documented jev-1.13.0 accepted request; provider enforces context, no local tokenizer/preflight context-fit claim",
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

export function fixtureRoot(artifacts: Record<string, string>, manifestSchema: string | null = "mstar.qualification-manifest/v1"): string {
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
  const listing = readdirSync(root);
  if (!listing.includes("protocol.json")) throw new Error(`fixture root is missing its default protocol.json; root listing: ${JSON.stringify(listing)}`);
  return root;
}

export function frozenRoot(overrides: { manifestSchema?: string | null; freezeId?: string; frozenAt?: string; splitSchema?: string; missingDisposition?: boolean; invalidOrigin?: boolean; missingQuarantine?: boolean; badEligibleDenominators?: boolean; unrecordedCollision?: boolean; emptyGold?: boolean; missingGoldForAnnotatedVariant?: boolean; developmentVariantSources?: boolean; calibrationArtifacts?: Record<string, string> } = {}): string {
  const groups: Array<Record<string, unknown>> = [];
  const assignments: Record<string, string> = {};
  const goldRows: Array<Record<string, unknown>> = [];
  const annotationRows = { A: [[], [], [], []] as Array<Array<Record<string, unknown>>>, B: [[], [], [], []] as Array<Array<Record<string, unknown>>> };
  const adjudicationRows: Array<Record<string, unknown>> = [];
  const quarantineReason = "The immutable source families reuse one lineage and causal cluster across development and holdout.";
  const excludedSlots = new Set([189, 294]);
  for (let index = 0; index < 360; index++) {
    const groupId = `opaque-group-${index}`;
    const itemId = `opaque-item-${index}`;
    const cohort = index >= 180 && index < 240 ? "development" : "holdout";
    const quarantined = excludedSlots.has(index);
    const sourceSlot = `shard-${Math.floor(index / 90) + 1}/group-${String(index % 90 + 1).padStart(3, "0")}`;
    const sourceSha256 = sha256(`source-${index}`);
    const itemDigest = sha256(`item-${index}`);
    assignments[groupId] = cohort;
    groups.push({
      id: groupId, split: cohort, sourceSlot,
      lineageId: quarantined || (overrides.unrecordedCollision && index === 0) ? "opaque-library-lineage" : `lineage-${index}`,
      causalClusterId: quarantined ? "opaque-library-cluster" : `cluster-${index}`,
      eligible: !quarantined, quarantined, ...(quarantined ? { quarantineReason } : {}),
      variants: [{ id: itemId, itemDigest, sourceSha256, primary: true, ...(overrides.developmentVariantSources ? { sourceVariant: `source-variant-${index}` } : {}) }],
    });
    const labels = quarantined ? ["same_cause", "different_cause"] : ["same_cause", "same_cause"];
    if (!overrides.missingGoldForAnnotatedVariant || index !== 0) {
      goldRows.push({ itemId, groupId, label: quarantined ? "unresolved" : "same_cause", ...(quarantined ? { eligible: false, quarantined: true } : {}) });
    }
    for (const seat of ["A", "B"] as const) {
      const shardIndex = Math.floor(index / 90) + 1;
      const reducedPackSupport = seat === "A" && shardIndex === 1
        ? { status: "sufficient", explanation: "Synthetic test support." }
        : seat === "A" && shardIndex === 2
          ? { label: "sufficient", explanation: "Synthetic test support." }
          : "sufficient";
      annotationRows[seat][shardIndex - 1].push({
        itemId, label: labels[seat === "A" ? 0 : 1], reducedPackSupport,
        sourceSha256, itemDigest, rationale: "Synthetic source-grounded comparison rationale.",
        anchors: [{ sourceRef: `file-${index}`, line: "1" }],
      });
    }
    if (quarantined) {
      adjudicationRows.push({
        itemId, groupId, labelA: labels[0], labelB: labels[1], sourceSha256, itemDigest,
        disposition: overrides.missingDisposition && index === 189 ? undefined : "preserved_disagreement",
        resolvedLabel: "unresolved", rationale: "The independent labels remain unresolved.",
        sourceEvidence: [{ source: `file-${index}`, line: 1 }], eligible: false, quarantined: true,
      });
    }
  }
  const gold = overrides.emptyGold ? "" : goldRows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const split = JSON.stringify({
    schema: overrides.splitSchema ?? "mstar.qualification-split-manifest/v1",
    contractRevision: "phase3a-native-20260924",
    freezeId: overrides.freezeId ?? "freeze-1",
    frozenAt: overrides.frozenAt ?? "2026-09-24T00:00:00.000Z",
    assignments, assignmentSha256: sha256(JSON.stringify(assignments)), goldSha256: sha256(gold), goldCount: goldRows.length,
    ...(overrides.missingQuarantine ? {} : {
      quarantine: {
        excludedGroupIds: ["opaque-group-189", "opaque-group-294"],
        collisions: [{
          kind: "lineage-and-causal", groupIds: ["opaque-group-189", "opaque-group-294"],
          sourceSlots: ["shard-3/group-010", "shard-4/group-025"],
          rawLineageId: "lineage-library-reservation", rawCausalClusterId: "cluster-library-reservation",
          lineageId: "opaque-library-lineage", causalClusterId: "opaque-library-cluster",
          assignedCohorts: { "opaque-group-189": "development", "opaque-group-294": "holdout" }, reason: quarantineReason,
        }],
      },
    }),
    eligibleDenominators: {
      developmentGroups: overrides.badEligibleDenominators ? 60 : 59,
      holdoutGroups: 299, totalGroups: overrides.badEligibleDenominators ? 359 : 358,
      developmentPrimaryCases: 59, holdoutPrimaryCases: 299, totalPrimaryCases: 358,
    },
  });
  const annotations: Record<string, string> = {};
  for (const seat of ["A", "B"] as const) for (const shard of [1, 2, 3, 4]) {
    annotations[`annotations/${seat}-${shard}.jsonl`] = annotationRows[seat][shard - 1].map((row) => JSON.stringify(row)).join("\n") + "\n";
  }
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
    "split-manifest.json": split, "gold/adjudicated.jsonl": gold, "corpus.json": JSON.stringify({ groups }),
    "adjudication.jsonl": adjudicationRows.map((row) => JSON.stringify(row)).join("\n") + "\n", "freeze.json": "{}",
    ...annotations, ...authors, ...overrides.calibrationArtifacts,
  }, overrides.manifestSchema);
}

export function annotationRoot(rowText: string, seat = "A", shard = 1): string {
  const sourceSha256 = sha256("source");
  const itemDigest = sha256("item");
  return fixtureRoot({
    "corpus.json": JSON.stringify({ groups: [{
      id: "group-1", split: "development", lineageId: "lineage-1", causalClusterId: "cluster-1",
      variants: [{ id: "item-1", itemDigest, sourceSha256, primary: true }],
    }] }),
    [`annotations/${seat}-${shard}.jsonl`]: rowText,
  });
}
