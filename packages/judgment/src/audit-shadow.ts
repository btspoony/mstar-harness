import { createHash } from "node:crypto";
import {
  CONTRACT_REVISION,
  PACK_SCHEMA,
  type ReviewDecisionPack,
  type ReviewTier,
  type WorkUnit,
} from "./contracts.js";

export type ReviewScope = Readonly<{
  runId: string;
  reviewId: string;
  snapshotSha256: string;
  diffSha256: string;
  baseRevision?: string;
  headRevision?: string;
  tier: ReviewTier;
  recipientId: string;
  concernId: string;
  rubricVersion: string;
  builderVersion: string;
}>;

/** Source authenticity (excerpt against source bytes/hash) is owned by the upstream evidence producer; this adapter only receives structured records. */
export type FindingSource = Readonly<{
  id: string;
  path: string;
  revision?: string;
  startLine: number;
  endLine: number;
  contentSha256: string;
  observedInRunId: string;
  basis: "snapshot" | "author-read" | "seat-observation" | "prior-run";
  excerpt: string;
}>;

export type StructuredFinding = Readonly<{
  id: string;
  title: string;
  description: string;
  fingerprint?: string;
  relatedFindingIds?: readonly string[];
  sources: readonly FindingSource[];
}>;

export type CandidatePair = Readonly<{
  id: string;
  findingIds: readonly [string, string];
  basis: "fingerprint" | "explicit-relation" | "fingerprint-and-explicit-relation";
  findings: readonly [StructuredFinding, StructuredFinding];
  sourceClosureSha256: string;
}>;

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("Shadow pack identity contains a non-JSON value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
};
const safeId = (prefix: string, seed: unknown): string => `${prefix}${sha256(canonical(seed))}`;

export function buildCandidatePairs(
  findings: readonly StructuredFinding[],
  scope: ReviewScope,
): readonly CandidatePair[] {
  const byId = new Set<string>();
  for (const finding of findings) {
    if (!finding.id || byId.has(finding.id)) throw new TypeError("Findings require unique non-empty IDs");
    byId.add(finding.id);
  }
  const ordered = [...findings].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const pairs: CandidatePair[] = [];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const left = ordered[i];
      const right = ordered[j];
      const fingerprint = left.fingerprint !== undefined && left.fingerprint === right.fingerprint;
      const explicit = left.relatedFindingIds?.includes(right.id) === true || right.relatedFindingIds?.includes(left.id) === true;
      if (!fingerprint && !explicit) continue;
      const findingIds = [left.id, right.id] as const;
      const pairIdentity = {
        runId: scope.runId,
        reviewId: scope.reviewId,
        snapshotSha256: scope.snapshotSha256,
        diffSha256: scope.diffSha256,
        findingIds,
      };
      pairs.push(Object.freeze({
        id: safeId("candidate_", pairIdentity),
        findingIds,
        basis: fingerprint && explicit ? "fingerprint-and-explicit-relation" : fingerprint ? "fingerprint" : "explicit-relation",
        findings: [left, right] as const,
        sourceClosureSha256: sha256(canonical([left.sources, right.sources])),
      }));
    }
  }
  return Object.freeze(pairs);
}

export function buildShadowPack(
  pairs: readonly CandidatePair[],
  units: readonly WorkUnit[],
  scope: ReviewScope,
): ReviewDecisionPack {
  if (pairs.length !== 1 || units.length === 0) {
    throw new TypeError("Input abstention: each synthesis pack must bind exactly one candidate and at least one baseline work unit");
  }
  const pair = pairs[0];
  const unitIds = new Set<string>();
  for (const unit of units) {
    if (!unit.id || !Number.isSafeInteger(unit.revision) || unit.revision < 0) {
      throw new TypeError("Input abstention: baseline work unit is missing or invalid");
    }
    if (unitIds.has(unit.id)) throw new TypeError("Input abstention: baseline work unit IDs must be unique");
    unitIds.add(unit.id);
  }
  if (pair.findingIds[0] === pair.findingIds[1] ||
      pair.findings[0].id !== pair.findingIds[0] || pair.findings[1].id !== pair.findingIds[1]) {
    throw new TypeError("Input abstention: candidate pair identity is inconsistent");
  }
  if (sha256(canonical([pair.findings[0].sources, pair.findings[1].sources])) !== pair.sourceClosureSha256) {
    throw new TypeError("Input abstention: candidate source closure changed after pair generation");
  }

  const sourceById = new Map<string, FindingSource>();
  const evidence: Array<{ id: string; sourceId: string; excerpt: string }> = [];
  const subjects: Array<{ id: string; kind: "finding"; text: string; evidenceIds: string[] }> = [];
  for (const finding of pair.findings) {
    if (finding.sources.length === 0) throw new TypeError(`Input abstention: finding ${finding.id} has no source evidence`);
    const evidenceIds: string[] = [];
    for (const source of finding.sources) {
      if (!source.id || !source.path || !source.excerpt || !/^[a-f0-9]{64}$/.test(source.contentSha256) ||
          !Number.isSafeInteger(source.startLine) || source.startLine < 1 || !Number.isSafeInteger(source.endLine) || source.endLine < source.startLine) {
        throw new TypeError(`Input abstention: source evidence for ${finding.id} is incomplete`);
      }
      if (source.observedInRunId !== scope.runId && source.basis !== "prior-run") {
        throw new TypeError(`Input abstention: source ${source.id} is stale for this run`);
      }
      const previous = sourceById.get(source.id);
      if (previous && canonical(previous) !== canonical(source)) {
        throw new TypeError(`Input abstention: source ID ${source.id} has conflicting records`);
      }
      sourceById.set(source.id, source);
      const evidenceId = safeId("evidence_", { findingId: finding.id, sourceId: source.id, excerpt: source.excerpt });
      evidenceIds.push(evidenceId);
      evidence.push({ id: evidenceId, sourceId: source.id, excerpt: source.excerpt });
    }
    if (!finding.title || !finding.description) throw new TypeError(`Input abstention: finding ${finding.id} lacks a literal claim`);
    subjects.push({ id: `finding_${finding.id}`, kind: "finding", text: `${finding.title}\n${finding.description}`, evidenceIds });
  }

  const sources = [...sourceById.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ excerpt: _excerpt, ...source }) => source);
  const state = { evidence, subjects };
  const tasks = units.map((unit) => ({
    id: safeId("task_", { pairId: pair.id, workUnit: unit, scope }),
    useCase: "JEV-A05" as const,
    subjectIds: [`finding_${pair.findingIds[0]}`, `finding_${pair.findingIds[1]}`] as [string, string],
    workUnit: unit,
  }));
  const packScope = {
    kind: "review" as const,
    reviewId: scope.reviewId,
    snapshotSha256: scope.snapshotSha256,
    diffSha256: scope.diffSha256,
    ...(scope.baseRevision !== undefined ? { baseRevision: scope.baseRevision } : {}),
    ...(scope.headRevision !== undefined ? { headRevision: scope.headRevision } : {}),
    tier: scope.tier,
  };
  const packCore = {
    contractRevision: CONTRACT_REVISION,
    runId: scope.runId,
    concernId: scope.concernId,
    profile: "review" as const,
    scope: packScope,
    recipient: { id: scope.recipientId, phase: "synthesis" as const },
    sources,
    state,
    tasks,
    rubricVersion: scope.rubricVersion,
    builderVersion: scope.builderVersion,
    sourceClosureSha256: pair.sourceClosureSha256,
  };
  const packId = safeId("shadow_pack_", packCore);
  return Object.freeze({
    schema: PACK_SCHEMA,
    contractRevision: CONTRACT_REVISION,
    runId: scope.runId,
    packId,
    concernId: scope.concernId,
    profile: "review",
    scope: packScope,
    recipient: packCore.recipient,
    sources,
    state,
    tasks,
    rubricVersion: scope.rubricVersion,
    builderVersion: scope.builderVersion,
  });
}
