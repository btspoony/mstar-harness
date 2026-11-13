import { afterEach, describe, expect, test, vi } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTRACT_REVISION,
  NATIVE_ENDPOINT,
  NATIVE_MODEL,
  PACK_SCHEMA,
  PILOT_SCHEMA,
  TOKEN_POLICY_METHOD,
  TOKEN_RESERVATION_PER_ATTEMPT,
  validatePack,
  validatePilot,
  type JudgmentPilot,
  type ReviewDecisionPack,
} from "../src/contracts.js";
import { buildA05Request, canonicalJsonBytes, type PreparedRequest } from "../src/review-advice.js";
import { evaluateNative, type EvaluatorContext, type JudgmentResult } from "../src/runtime.js";
import type { NativeTransportInput, NativeTransportResult } from "../src/typesafe.js";

const temporaryRoots: string[] = [];
const hash = "a".repeat(64);
const responseBytes = (questionId: string) => new TextEncoder().encode(JSON.stringify({
  model: NATIVE_MODEL,
  answers: {
    [questionId]: {
      type: "choice",
      choice: "same_cause",
      probabilities: { same_cause: 0.8, different_cause: 0.1, insufficient_evidence: 0.1 },
      confidence: 0.75,
    },
  },
  usage: { input_tokens: 123, output_tokens: 9 },
}));

function runDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "judgment-runtime-evidence-"));
  temporaryRoots.push(root);
  const directory = join(root, "evidence", "run-1");
  mkdirSync(directory, { recursive: true });
  return realpathSync(directory);
}

function fixture(policyVersion = "policy-1", dataClass = "synthetic-only"): { pack: ReviewDecisionPack; pilot: JudgmentPilot; request: PreparedRequest } {
  const pack = validatePack({
    schema: PACK_SCHEMA,
    contractRevision: CONTRACT_REVISION,
    runId: "run-1",
    packId: "pack-1",
    concernId: "concern-1",
    profile: "review",
    scope: { kind: "review", reviewId: "review-1", snapshotSha256: hash, diffSha256: hash, tier: "default" },
    recipient: { id: "synthesis-main", phase: "synthesis" },
    sources: [{ id: "source-1", path: "src/example.ts", startLine: 1, endLine: 4, contentSha256: hash, observedInRunId: "run-1", basis: "seat-observation" }],
    state: {
      evidence: [
        { id: "evidence-left", sourceId: "source-1", excerpt: "left excerpt" },
        { id: "evidence-right", sourceId: "source-1", excerpt: "right excerpt" },
      ],
      subjects: [
        { id: "finding-left", kind: "finding", text: "left claim", evidenceIds: ["evidence-left"] },
        { id: "finding-right", kind: "finding", text: "right claim", evidenceIds: ["evidence-right"] },
      ],
    },
    tasks: [{ id: "task-1", useCase: "JEV-A05", subjectIds: ["finding-left", "finding-right"], workUnit: { id: "unit-1", revision: 2 } }],
    rubricVersion: "rubric-1",
    builderVersion: "builder-1",
  });
  const pilot = validatePilot({
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
    policyVersion,
    permission: { ref: "permission-1", purpose: "synthetic qualification", dataClass },
    isolation: { ref: "isolation-1" },
    packManifest: [{ packId: "pack-1", packSha256: createHash("sha256").update(canonicalJsonBytes(pack)).digest("hex") }],
    rubricVersion: "rubric-1",
    builderVersion: "builder-1",
    implementationVersion: "test-implementation",
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
    sourcePolicy: { minimization: "synthetic excerpts only", retention: "run-bound" },
    protocolVersion: "protocol-1",
    splitId: "split-1",
    calibrationId: "calibration-1",
  });
  return { pack, pilot, request: buildA05Request(pack, pilot) };
}

function evaluatorContext(
  prepared: { pack: ReviewDecisionPack; pilot: JudgmentPilot; request: PreparedRequest },
  options: Readonly<{ isCurrent?: () => boolean; sendRequest?: (input: NativeTransportInput) => Promise<NativeTransportResult>; writeSealedResult?: (result: JudgmentResult) => Promise<string> }> = {},
): { context: EvaluatorContext; calls: { credentials: number; requests: number; writes: number; reads: number } } {
  const calls = { credentials: 0, requests: 0, writes: 0, reads: 0 };
  const stored = new Map<string, JudgmentResult>();
  const context: EvaluatorContext = {
    pilot: prepared.pilot,
    pack: prepared.pack,
    runDirectory: runDirectory(),
    isCurrent: options.isCurrent ?? (() => true),
    readCredential: async () => {
      calls.credentials += 1;
      return "test-only-credential";
    },
    sendRequest: async (request) => {
      calls.requests += 1;
      if (options.sendRequest) return options.sendRequest(request);
      return { responseBytes: responseBytes(Object.keys(prepared.request.questionMap)[0]), status: 200, elapsedMs: 1 };
    },
    writeSealedResult: async (result) => {
      calls.writes += 1;
      if (options.writeSealedResult) return options.writeSealedResult(result);
      const reference = `results/${result.reservationId}.json`;
      stored.set(reference, result);
      return reference;
    },
    readSealedResult: async (reference) => {
      calls.reads += 1;
      const result = stored.get(reference);
      if (!result) throw new Error("missing sealed result");
      return result;
    },
  };
  return { context, calls };
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("trusted native evaluator", () => {
  test("records once and reuses the exact same sealed result without another credential or request", async () => {
    const prepared = fixture();
    const { context, calls } = evaluatorContext(prepared);
    const first = await evaluateNative(prepared.request, context, new AbortController().signal);
    const second = await evaluateNative(prepared.request, context, new AbortController().signal);

    expect(second).toEqual(first);
    expect(first.response.usage).toEqual({ inputTokens: 123, outputTokens: 9 });
    expect(calls).toEqual({ credentials: 1, requests: 1, writes: 1, reads: 1 });
  });

  test("missing credentials and malformed native responses cannot create result artifacts", async () => {
    const prepared = fixture();
    const missingCredential = evaluatorContext(prepared);
    missingCredential.context = {
      ...missingCredential.context,
      readCredential: async () => {
        missingCredential.calls.credentials += 1;
        return "";
      },
    };
    await expect(evaluateNative(prepared.request, missingCredential.context, new AbortController().signal))
      .rejects.toMatchObject({ code: "jev.credential-unavailable" });
    expect(missingCredential.calls).toEqual({ credentials: 1, requests: 0, writes: 0, reads: 0 });

    const invalidResponse = evaluatorContext(prepared, {
      sendRequest: async () => ({ responseBytes: new TextEncoder().encode("{}"), status: 200, elapsedMs: 1 }),
    });
    await expect(evaluateNative(prepared.request, invalidResponse.context, new AbortController().signal))
      .rejects.toMatchObject({ code: "jev.response-invalid" });
    expect(invalidResponse.calls).toEqual({ credentials: 1, requests: 1, writes: 0, reads: 0 });
  });

  test("a stale evaluator and a pilot-policy mismatch cannot read credentials or produce success", async () => {
    const prepared = fixture();
    const stale = evaluatorContext(prepared, { isCurrent: () => false });
    await expect(evaluateNative(prepared.request, stale.context, new AbortController().signal))
      .rejects.toMatchObject({ code: "jev.revoked" });
    expect(stale.calls).toEqual({ credentials: 0, requests: 0, writes: 0, reads: 0 });

    const active = evaluatorContext(prepared);
    await evaluateNative(prepared.request, active.context, new AbortController().signal);
    const changedPilot = fixture("policy-2");
    const mismatched = evaluatorContext(changedPilot);
    mismatched.context = { ...mismatched.context, runDirectory: active.context.runDirectory };
    await expect(evaluateNative(prepared.request, mismatched.context, new AbortController().signal))
      .rejects.toMatchObject({ code: "run-budget.policy-mismatch" });
    expect(mismatched.calls).toEqual({ credentials: 0, requests: 0, writes: 0, reads: 0 });
  });

  test("revocation aborts an in-flight request and ignores its late response", async () => {
    vi.useFakeTimers();
    const prepared = fixture();
    let current = true;
    const { promise: sendStarted, resolve: markStarted } = Promise.withResolvers<void>();
    const lateResponse = Promise.withResolvers<NativeTransportResult>();
    const { context, calls } = evaluatorContext(prepared, {
      isCurrent: () => current,
      sendRequest: async () => {
        markStarted();
        return lateResponse.promise;
      },
    });
    const result = evaluateNative(prepared.request, context, new AbortController().signal);
    await sendStarted;
    current = false;
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    await expect(result).rejects.toMatchObject({ code: "jev.revoked" });
    lateResponse.resolve({ responseBytes: responseBytes(Object.keys(prepared.request.questionMap)[0]), status: 200, elapsedMs: 1 });
    await lateResponse.promise;
    expect(calls).toEqual({ credentials: 1, requests: 1, writes: 0, reads: 0 });
  });

  test("artifact failure never records success and makes the identical request non-retryable", async () => {
    const prepared = fixture();
    const failed = evaluatorContext(prepared, { writeSealedResult: async () => { throw new Error("disk full"); } });
    await expect(evaluateNative(prepared.request, failed.context, new AbortController().signal))
      .rejects.toMatchObject({ code: "jev.evaluation-failed" });
    expect(failed.calls).toEqual({ credentials: 1, requests: 1, writes: 1, reads: 0 });

    const retry = evaluatorContext(prepared);
    retry.context = { ...retry.context, runDirectory: failed.context.runDirectory };
    await expect(evaluateNative(prepared.request, retry.context, new AbortController().signal))
      .rejects.toMatchObject({ code: "run-budget.failed-request-not-retryable" });
    expect(retry.calls).toEqual({ credentials: 0, requests: 0, writes: 0, reads: 0 });
  });
});
