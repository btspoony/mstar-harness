import { describe, expect, test } from "bun:test";
import {
  CONTRACT_REVISION,
  MAX_RUN_RESERVED_INPUT_TOKENS,
  NATIVE_ENDPOINT,
  NATIVE_MODEL,
  PACK_SCHEMA,
  PILOT_SCHEMA,
  TOKEN_POLICY_METHOD,
  TOKEN_RESERVATION_PER_ATTEMPT,
  validatePack,
  validatePilot,
} from "../src/index.js";

const hash = "a".repeat(64);

function makePack() {
  return {
    schema: PACK_SCHEMA,
    contractRevision: CONTRACT_REVISION,
    runId: "run-1",
    packId: "pack-1",
    concernId: "concern-1",
    profile: "review",
    scope: { kind: "review", reviewId: "review-1", snapshotSha256: hash, diffSha256: hash, tier: "default" },
    recipient: { id: "synthesis-main", phase: "synthesis" },
    sources: [{ id: "source-1", path: "local/source.ts", startLine: 1, endLine: 4, contentSha256: hash, observedInRunId: "run-1", basis: "seat-observation" }],
    state: {
      evidence: [{ id: "evidence-1", sourceId: "source-1", excerpt: "bounded literal excerpt" }],
      subjects: [
        { id: "finding-left", kind: "finding", text: "first finding", evidenceIds: ["evidence-1"] },
        { id: "finding-right", kind: "finding", text: "second finding", evidenceIds: ["evidence-1"] },
      ],
    },
    tasks: [{ id: "task-1", useCase: "JEV-A05", subjectIds: ["finding-left", "finding-right"], workUnit: { id: "unit-1", revision: 2 } }],
    rubricVersion: "a05-rubric-1",
    builderVersion: "a05-builder-1",
  };
}

function makePilot() {
  return {
    schema: PILOT_SCHEMA,
    contractRevision: CONTRACT_REVISION,
    pilotId: "pilot-1",
    runId: "run-1",
    profile: "review",
    scope: { kind: "review", reviewId: "review-1", snapshotSha256: hash, diffSha256: hash },
    mode: "shadow",
    transport: "native-typesafe",
    endpoint: NATIVE_ENDPOINT,
    model: NATIVE_MODEL,
    useCases: ["JEV-A05"],
    recipients: [{ id: "synthesis-main", phase: "synthesis" }],
    policyVersion: "policy-1",
    permission: { ref: "permission-1", purpose: "synthetic qualification", dataClass: "synthetic-only" },
    isolation: { ref: "evaluator-isolation-1" },
    packManifest: [{ packId: "pack-1", packSha256: hash }],
    rubricVersion: "a05-rubric-1",
    builderVersion: "a05-builder-1",
    implementationVersion: "judgment-0.0.0",
    limits: {
      timeoutMs: 10_000,
      maxRunElapsedMs: 10_000_000,
      maxCallsPerRun: 1,
      maxConcurrentRequests: 1,
      maxTasksPerPack: 4,
      maxPacksPerRun: 1,
      maxPairs: 4,
      maxPackBytes: 65_536,
      maxRequestBytes: 32_768,
      maxResponseBytes: 65_536,
      maxAttempts: 1,
    },
    tokenPolicy: {
      method: TOKEN_POLICY_METHOD,
      perAttemptReservation: TOKEN_RESERVATION_PER_ATTEMPT,
      maxRunReservedInputTokens: TOKEN_RESERVATION_PER_ATTEMPT,
    },
    sourcePolicy: { minimization: "only required synthetic excerpts", retention: "run-bound" },
    protocolVersion: "protocol-1",
    splitId: "split-1",
    calibrationId: "calibration-1",
  };
}

describe("versioned judgment contracts", () => {
  test("accepts exactly bound review/A05 pack and explicitly authorized native shadow pilot", () => {
    expect(validatePack(makePack()).tasks[0]?.subjectIds).toEqual(["finding-left", "finding-right"]);
    expect(validatePilot(makePilot()).model).toBe(NATIVE_MODEL);
  });

  test("rejects superseded revisions, profile/recipient/use-case drift and extra wire fields", () => {
    const oldPack = makePack();
    oldPack.contractRevision = "audit-acceleration-20260920";
    expect(() => validatePack(oldPack)).toThrow("unsupported revision");
    const alias = makePack();
    alias.profile = "audit";
    expect(() => validatePack(alias)).toThrow("only review profile");
    const extra = makePack();
    extra.secret = "credential";
    expect(() => validatePack(extra)).toThrow("unknown field");
    const wrongRecipient = makePack();
    wrongRecipient.recipient.phase = "collect";
    expect(() => validatePack(wrongRecipient)).toThrow("only synthesis");
    const wrongCase = makePack();
    wrongCase.tasks[0].useCase = "JEV-A04";
    expect(() => validatePack(wrongCase)).toThrow("only JEV-A05");
  });

  test("rejects malformed and duplicate/dangling pack bindings", () => {
    const duplicate = makePack();
    duplicate.sources.push({ ...duplicate.sources[0] });
    expect(() => validatePack(duplicate)).toThrow("duplicate ID");
    const dangling = makePack();
    dangling.state.evidence[0].sourceId = "missing";
    expect(() => validatePack(dangling)).toThrow("dangling source ID");
    const crossed = makePack();
    crossed.tasks[0].subjectIds = ["finding-left", "other"];
    expect(() => validatePack(crossed)).toThrow("ordered pack subjects");
    const missingWorkUnit = makePack();
    missingWorkUnit.tasks[0].workUnit = null;
    expect(() => validatePack(missingWorkUnit)).toThrow("expected object");
  });

  test("rejects assist, alternate transports, secrets and unsupported pins", () => {
    const assist = makePilot();
    assist.mode = "assist";
    expect(() => validatePilot(assist)).toThrow("assist is not qualified");
    const omp = makePilot();
    omp.transport = "omp-judge";
    expect(() => validatePilot(omp)).toThrow("only native-typesafe");
    const alias = makePilot();
    alias.model = "latest";
    expect(() => validatePilot(alias)).toThrow("pin the qualified model");
    const extra = makePilot();
    extra.apiKey = "never-in-contract";
    expect(() => validatePilot(extra)).toThrow("unknown field");
  });

  test("rejects numeric overflow, nonfinite and negative bounds, and insufficient token reservation", () => {
    const overflow = makePilot();
    overflow.limits.maxRequestBytes = 32_769;
    expect(() => validatePilot(overflow)).toThrow("finite native policy");
    const nonfinite = makePilot();
    nonfinite.limits.timeoutMs = Number.POSITIVE_INFINITY;
    expect(() => validatePilot(nonfinite)).toThrow("safe integer");
    const negative = makePilot();
    negative.limits.maxPairs = -1;
    expect(() => validatePilot(negative)).toThrow("safe integer");
    const tooLittle = makePilot();
    tooLittle.tokenPolicy.maxRunReservedInputTokens = 65_535;
    expect(() => validatePilot(tooLittle)).toThrow("cover every permitted attempt");
    const tooMuch = makePilot();
    tooMuch.tokenPolicy.maxRunReservedInputTokens = MAX_RUN_RESERVED_INPUT_TOKENS + 1;
    expect(() => validatePilot(tooMuch)).toThrow("frozen run cap");
  });

  test("rejects non-exact primitives and never claims local token fit", () => {
    const malformed = makePack();
    malformed.sources[0].startLine = 1.5;
    expect(() => validatePack(malformed)).toThrow("safe integer");
    const malformedSubject = makePack();
    malformedSubject.state.subjects[0].candidateKind = "caller";
    expect(() => validatePack(malformedSubject)).toThrow("unknown field");
    const correct = validatePilot(makePilot());
    expect(correct.tokenPolicy).toEqual({
      method: "provider-context-reservation/v1",
      perAttemptReservation: 65_536,
      maxRunReservedInputTokens: 65_536,
    });
  });
});
