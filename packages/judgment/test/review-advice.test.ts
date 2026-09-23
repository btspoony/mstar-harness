import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import {
  CONTRACT_REVISION, NATIVE_ENDPOINT, NATIVE_MODEL, PACK_SCHEMA, PILOT_SCHEMA,
  TOKEN_POLICY_METHOD, TOKEN_RESERVATION_PER_ATTEMPT, validatePack, validatePilot,
} from "../src/contracts.js";
import { A05_QUESTION, buildA05Request } from "../src/review-advice.js";

const hash = "a".repeat(64);
function fixture() {
  const pack = validatePack({
    schema: PACK_SCHEMA, contractRevision: CONTRACT_REVISION, runId: "run-1", packId: "pack-1", concernId: "concern-1", profile: "review",
    scope: { kind: "review", reviewId: "review-1", snapshotSha256: hash, diffSha256: hash, tier: "default" },
    recipient: { id: "synthesis-main", phase: "synthesis" },
    sources: [{ id: "source-1", path: "/private/repo/src/file.ts", startLine: 1, endLine: 4, contentSha256: "b".repeat(64), observedInRunId: "run-1", basis: "seat-observation" }],
    state: {
      evidence: [{ id: "e1", sourceId: "source-1", excerpt: "left evidence" }, { id: "e2", sourceId: "source-1", excerpt: "right evidence" }],
      subjects: [
        { id: "left", kind: "finding", text: "left claim", evidenceIds: ["e1"] },
        { id: "right", kind: "finding", text: "right claim", evidenceIds: ["e2"] },
      ],
    },
    tasks: [{ id: "task-1", useCase: "JEV-A05", subjectIds: ["left", "right"], workUnit: { id: "unit-1", revision: 2 } }],
    rubricVersion: "rubric-1", builderVersion: "builder-1",
  });
  const pilot = validatePilot({
    schema: PILOT_SCHEMA, contractRevision: CONTRACT_REVISION, pilotId: "pilot-1", runId: "run-1", profile: "review",
    scope: { kind: "review", reviewId: "review-1", snapshotSha256: hash, diffSha256: hash }, mode: "shadow", transport: "native-typesafe",
    endpoint: NATIVE_ENDPOINT, model: NATIVE_MODEL, useCases: ["JEV-A05"], recipients: [{ id: "synthesis-main", phase: "synthesis" }],
    policyVersion: "policy-1", permission: { ref: "permission-1", purpose: "synthetic qualification", dataClass: "synthetic-only" },
    isolation: { ref: "isolation-1" }, packManifest: [{ packId: "pack-1", packSha256: createHash("sha256").update(JSON.stringify(pack)).digest("hex") }],
    rubricVersion: "rubric-1", builderVersion: "builder-1", implementationVersion: "judgment-0.0.0",
    limits: { timeoutMs: 10_000, maxRunElapsedMs: 10_000_000, maxCallsPerRun: 1, maxConcurrentRequests: 1, maxTasksPerPack: 4, maxPacksPerRun: 1, maxPairs: 4, maxPackBytes: 65_536, maxRequestBytes: 32_768, maxResponseBytes: 65_536, maxAttempts: 1 },
    tokenPolicy: { method: TOKEN_POLICY_METHOD, perAttemptReservation: TOKEN_RESERVATION_PER_ATTEMPT, maxRunReservedInputTokens: TOKEN_RESERVATION_PER_ATTEMPT },
    sourcePolicy: { minimization: "synthetic excerpts only", retention: "run-bound" }, protocolVersion: "protocol-1", splitId: "split-1", calibrationId: "calibration-1",
  });
  return { pack, pilot };
}

describe("fixed A05 request builder", () => {
  test("emits deterministic canonical bytes with only the fixed question and authorized pair evidence", () => {
    const { pack, pilot } = fixture();
    const first = buildA05Request(pack, pilot);
    const second = buildA05Request(pack, pilot);
    expect(new TextDecoder().decode(first.bytes)).toBe(new TextDecoder().decode(second.bytes));
    expect(first.requestSha256).toBe(second.requestSha256);
    const request = JSON.parse(new TextDecoder().decode(first.bytes));
    expect(request).toEqual({
      model: NATIVE_MODEL,
      state: { pairs: [{ id: "task-1", left: { id: "left", claim: "left claim", evidence: ["left evidence"] }, right: { id: "right", claim: "right claim", evidence: ["right evidence"] } }] },
      questions: { "a05_task-1": A05_QUESTION },
    });
    expect(new TextDecoder().decode(first.bytes)).not.toContain("/private/repo");
    expect(new TextDecoder().decode(first.bytes)).not.toContain("b".repeat(64));
    expect(first.questionMap["a05_task-1"]).toEqual({ taskId: "task-1", useCase: "JEV-A05", subjectIds: ["left", "right"], workUnit: { id: "unit-1", revision: 2 } });
  });
  test("binds each batched question to its matching ordered pair", () => {
    const { pack, pilot } = fixture();
    const twoTaskPack = { ...pack, tasks: [pack.tasks[0], { ...pack.tasks[0], id: "task-2", workUnit: { id: "unit-2", revision: 1 } }] };
    const authorizedPilot = {
      ...pilot,
      packManifest: [{ packId: twoTaskPack.packId, packSha256: createHash("sha256").update(JSON.stringify(twoTaskPack)).digest("hex") }],
    };
    const request = buildA05Request(twoTaskPack, authorizedPilot);
    expect(request.questions["a05_task-1"].instructions).toContain("pairs[0].left.claim");
    expect(request.questions["a05_task-2"].instructions).toContain("pairs[1].right.evidence");
    expect(request.questions["a05_task-2"].instructions).not.toContain("pairs[0]");
  });


  test("refuses scope, manifest, version, recipient and request-bound violations without repair", () => {
    const { pack, pilot } = fixture();
    expect(() => buildA05Request({ ...pack, scope: { ...pack.scope, diffSha256: "d".repeat(64) } }, pilot)).toThrow("scope");
    expect(() => buildA05Request(pack, { ...pilot, packManifest: [] })).toThrow("manifest");
    expect(() => buildA05Request({ ...pack, rubricVersion: "other" }, pilot)).toThrow("version");
    expect(() => buildA05Request({ ...pack, tasks: [{ ...pack.tasks[0], subjectIds: ["left", "absent"] }] }, pilot)).toThrow();
    expect(() => buildA05Request(pack, { ...pilot, limits: { ...pilot.limits, maxRequestBytes: 1 } })).toThrow("byte limit");
  });
  test("refuses pack contents that differ from the manifest-bound canonical bytes", () => {
    const { pack, pilot } = fixture();
    const altered = {
      ...pack,
      state: {
        ...pack.state,
        evidence: pack.state.evidence.map((item) => ({ ...item, excerpt: "substituted evidence" })),
      },
    };
    expect(() => buildA05Request(altered, pilot)).toThrow("manifest hash");
  });

});
