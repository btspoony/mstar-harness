import { describe, expect, test } from "bun:test";
import { validatePack, type WorkUnit } from "../src/contracts.js";
import { buildCandidatePairs, buildShadowPack, type FindingSource, type ReviewScope, type StructuredFinding } from "../src/audit-shadow.js";
import { canonicalJsonBytes } from "../src/review-advice.js";

const digest = "a".repeat(64);
const scope: ReviewScope = Object.freeze({
  runId: "run-shadow-1",
  reviewId: "review-1",
  snapshotSha256: digest,
  diffSha256: "b".repeat(64),
  baseRevision: "base-1",
  headRevision: "head-1",
  tier: "default",
  recipientId: "synthesis-main",
  concernId: "concern-1",
  rubricVersion: "rubric-1",
  builderVersion: "shadow-builder-1",
});

function source(id: string, path: string, excerpt: string, observedInRunId = scope.runId): FindingSource {
  return Object.freeze({
    id,
    path,
    startLine: 4,
    endLine: 6,
    contentSha256: digest,
    observedInRunId,
    basis: "seat-observation",
    excerpt,
  });
}
function finding(id: string, description: string, sources: readonly FindingSource[], extra: Partial<StructuredFinding> = {}): StructuredFinding {
  return Object.freeze({
    id,
    title: `Finding ${id}`,
    description,
    sources: Object.freeze([...sources]),
    ...extra,
    ...(extra.relatedFindingIds !== undefined ? { relatedFindingIds: Object.freeze([...extra.relatedFindingIds]) } : {}),
  });
}

const unit: WorkUnit = Object.freeze({ id: "baseline-unit-1", revision: 3 });

describe("deterministic shadow candidate and synthesis pack adapter", () => {
  test("orders pair candidates deterministically and retains explicit cross-file relations pairwise", () => {
    const a = finding("a", "Root cause A", [source("source-a", "src/a.ts", "A excerpt")], { relatedFindingIds: ["b"] });
    const b = finding("b", "Root cause B", [source("source-b", "src/b.ts", "B excerpt")]);
    const c = finding("c", "Root cause C", [source("source-c", "src/c.ts", "C excerpt")], { relatedFindingIds: ["b"] });
    const first = buildCandidatePairs([c, b, a], scope);
    const second = buildCandidatePairs([a, b, c], scope);
    expect(first.map(({ findingIds, id }) => [findingIds, id])).toEqual(second.map(({ findingIds, id }) => [findingIds, id]));
    expect(first.map(({ findingIds }) => findingIds)).toEqual([["a", "b"], ["b", "c"]]);
    expect(first.every(({ basis }) => basis === "explicit-relation")).toBe(true);
  });

  test("does not auto-merge same-symptom findings with distinct explicit causes", () => {
    const findings = [
      finding("left", "Timeout caused by exhausted pool", [source("left-source", "src/left.ts", "left evidence")], { fingerprint: "pool-exhaustion" }),
      finding("right", "Timeout caused by remote outage", [source("right-source", "src/right.ts", "right evidence")], { fingerprint: "remote-outage" }),
    ];
    expect(buildCandidatePairs(findings, scope)).toEqual([]);
  });

  test("binds literal findings and every explicit source into a stable synthesis pack", () => {
    const findings = [
      finding("left", "Literal left claim", [source("left-source", "src/a.ts", "left excerpt")], { relatedFindingIds: ["right"] }),
      finding("right", "Literal right claim", [source("right-source", "src/b.ts", "right excerpt")]),
    ];
    const pairs = buildCandidatePairs(findings, scope);
    const originalFindings = canonicalJsonBytes(findings);
    const pack = buildShadowPack([pairs[0]], [unit], scope);
    const repeated = buildShadowPack([pairs[0]], [unit], scope);
    expect(canonicalJsonBytes(pack)).toEqual(canonicalJsonBytes(repeated));
    expect(pack.sources.map(({ id }) => id)).toEqual(["left-source", "right-source"]);
    expect(pack.state.evidence.map(({ excerpt }) => excerpt)).toEqual(["left excerpt", "right excerpt"]);
    expect(pack.state.subjects.map(({ text }) => text)).toEqual(["Finding left\nLiteral left claim", "Finding right\nLiteral right claim"]);
    expect(pack.tasks).toHaveLength(1);
    expect(pack.tasks[0].workUnit).toEqual(unit);
    expect(validatePack(pack)).toBe(pack);
    expect(canonicalJsonBytes(findings)).toEqual(originalFindings);
  });

  test("pack identity changes when scope or explicit source closure changes", () => {
    const findings = [
      finding("left", "Left claim", [source("left-source", "src/a.ts", "left excerpt")], { relatedFindingIds: ["right"] }),
      finding("right", "Right claim", [source("right-source", "src/b.ts", "right excerpt")]),
    ];
    const pair = buildCandidatePairs(findings, scope)[0];
    const original = buildShadowPack([pair], [unit], scope);
    const changedScope = buildShadowPack([pair], [unit], { ...scope, diffSha256: "c".repeat(64) });
    const changedFinding = finding("left", "Left claim", [source("left-source", "src/a.ts", "changed excerpt")], { relatedFindingIds: ["right"] });
    const changedPairs = buildCandidatePairs([changedFinding, findings[1]], scope);
    const changedSource = buildShadowPack([changedPairs[0]], [unit], scope);
    expect(changedScope.packId).not.toBe(original.packId);
    expect(changedSource.packId).not.toBe(original.packId);
  });

  test("refuses missing or stale source evidence and does not silently omit inventory pairs", () => {
    const noEvidence = [
      finding("left", "Left claim", [], { relatedFindingIds: ["right"] }),
      finding("right", "Right claim", [source("right-source", "src/b.ts", "right excerpt")]),
    ];
    const noEvidencePair = buildCandidatePairs(noEvidence, scope)[0];
    expect(() => buildShadowPack([noEvidencePair], [unit], scope)).toThrow("Input abstention");

    const stale = [
      finding("left", "Left claim", [source("left-source", "src/a.ts", "left excerpt", "old-run")], { relatedFindingIds: ["right"] }),
      finding("right", "Right claim", [source("right-source", "src/b.ts", "right excerpt")]),
    ];
    const stalePair = buildCandidatePairs(stale, scope)[0];
    expect(() => buildShadowPack([stalePair], [unit], scope)).toThrow("stale");
    const validPair = buildCandidatePairs([
      finding("left", "Left claim", [source("left-source", "src/a.ts", "left excerpt")], { relatedFindingIds: ["right"] }),
      finding("right", "Right claim", [source("right-source", "src/b.ts", "right excerpt")]),
    ], scope)[0];
    expect(() => buildShadowPack([validPair], [], scope)).toThrow("exactly one candidate and baseline work unit");
  });
});
