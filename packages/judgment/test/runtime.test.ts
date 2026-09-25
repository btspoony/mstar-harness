import { afterEach, describe, expect, test, vi } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { attestEvaluatorChannel } from "../src/evaluator-channel-trust.js";
import {
  evaluateNative,
  resolveJudgmentConfig,
  runReviewAdvice,
  type EvaluatorContext,
  type EvaluatorChannel,
  type EvaluatorChannelResponse,
  type JudgmentInvocation,
  type JudgmentResult,
  type RuntimeEffects,
} from "../src/runtime.js";
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

function workspaceWithConfig(text: string): string {
  const workspace = mkdtempSync(join(tmpdir(), "judgment-runtime-workspace-"));
  temporaryRoots.push(workspace);
  writeFileSync(join(workspace, ".mstarc"), text);
  return workspace;
}

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

function invocation(workspace: string): JudgmentInvocation {
  return { cwd: workspace, workspace, input: { kind: "file", path: "pack.json" }, pilotPath: "pilot.json" };
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

function channelResponse(status: EvaluatorChannelResponse["status"]): EvaluatorChannelResponse {
  return { status };
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("inert judgment runtime", () => {
  test("off does not read pack or pilot bytes and cannot call the channel", async () => {
    const workspace = workspaceWithConfig("[config]\njev_mode=off\njev_transport=typesafe\n");
    let inputReads = 0;
    let submits = 0;
    const channel: EvaluatorChannel = {
      submit: async () => { submits += 1; return channelResponse("recorded"); },
      cancel: async () => {},
    };
    const effects: RuntimeEffects = {
      readFile: async () => { inputReads += 1; throw new Error("off must not read inputs"); },
      readStdin: async () => { inputReads += 1; throw new Error("off must not read stdin"); },
    };

    const result = await runReviewAdvice(invocation(workspace), new AbortController().signal, attestEvaluatorChannel(channel), effects);
    expect(result).toEqual({ schema: "mstar.judgment-cli/v1", contractRevision: CONTRACT_REVISION, status: "disabled", advice: null });
    expect(inputReads).toBe(0);
    expect(submits).toBe(0);
  });

  test("unknown mode and transports refuse; shadow without a channel refuses before collection", async () => {
    const unsupported = [
      { text: "[config]\njev_mode=unknown\njev_transport=typesafe\n", code: "jev.mode-unsupported" },
      { text: "[config]\njev_mode=shadow\njev_transport=assist\n", code: "jev.assist-not-qualified" },
      { text: "[config]\njev_mode=shadow\njev_transport=omp-judge\n", code: "jev.host-contract-unavailable" },
      { text: "[config]\njev_mode=shadow\njev_transport=other\n", code: "jev.transport-unsupported" },
      { text: "[config]\njev_mode=shadow\n", code: "jev.transport-required" },
    ];
    for (const item of unsupported) {
      const workspace = workspaceWithConfig(item.text);
      expect(resolveJudgmentConfig(workspace, workspace)).toMatchObject({ state: "invalid", code: item.code });
      const result = await runReviewAdvice(invocation(workspace), new AbortController().signal, null, {
        readFile: async () => { throw new Error("invalid config must refuse before collection"); },
      });
      expect(result).toMatchObject({ status: "invalid", code: item.code, advice: null });
    }

    const workspace = workspaceWithConfig("[config]\njev_mode=shadow\njev_transport=typesafe\n");
    let reads = 0;
    const result = await runReviewAdvice(invocation(workspace), new AbortController().signal, null, {
      readFile: async () => { reads += 1; throw new Error("channel absence must precede collection"); },
    });
    expect(result).toMatchObject({ status: "unavailable", code: "jev.channel-unavailable", advice: null });
    expect(reads).toBe(0);
  });
  test("refuses structurally callable but unattested channels before collecting inputs", async () => {
    const workspace = workspaceWithConfig("[config]\njev_mode=shadow\njev_transport=typesafe\n");
    let reads = 0;
    const result = await runReviewAdvice(invocation(workspace), new AbortController().signal, {
      submit: async () => channelResponse("recorded"),
      cancel: async () => {},
    }, { readFile: async () => { reads += 1; throw new Error("unattested channel must be rejected first"); } });
    expect(result).toMatchObject({ status: "unavailable", code: "jev.channel-unavailable" });
    expect(reads).toBe(0);
  });

  test("refuses TTY stdin and bounds stdin collection by the pilot deadline", async () => {
    vi.useFakeTimers();
    const workspace = workspaceWithConfig("[config]\njev_mode=shadow\njev_transport=typesafe\n");
    const prepared = fixture();
    let stdinReads = 0;
    const channel: EvaluatorChannel = { submit: async () => channelResponse("recorded"), cancel: async () => {} };
    const ttyResult = await runReviewAdvice({ ...invocation(workspace), input: { kind: "stdin" } }, new AbortController().signal, attestEvaluatorChannel(channel), {
      readFile: async () => canonicalJsonBytes(prepared.pilot),
      isStdinTTY: () => true,
      readStdin: async () => { stdinReads += 1; throw new Error("TTY stdin must be rejected before reading"); },
    });
    expect(ttyResult).toMatchObject({ status: "invalid", code: "jev.stdin-tty" });
    expect(stdinReads).toBe(0);

    const shortPilot = { ...prepared.pilot, limits: { ...prepared.pilot.limits, timeoutMs: 10 } };
    const { promise: stdinStarted, resolve: markStdinStarted } = Promise.withResolvers<void>();
    const pending = runReviewAdvice({ ...invocation(workspace), input: { kind: "stdin" } }, new AbortController().signal, attestEvaluatorChannel(channel), {
      readFile: async () => canonicalJsonBytes(shortPilot),
      readStdin: async (_maxBytes, signal) => {
        stdinReads += 1;
        markStdinStarted();
        return new Promise<Uint8Array>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stdin deadline")), { once: true }));
      },
    });
    await stdinStarted;
    vi.advanceTimersByTime(10);
    await expect(pending).resolves.toMatchObject({ status: "unavailable", code: "jev.deadline" });
    expect(stdinReads).toBe(1);
    vi.useRealTimers();
  });


  test("rejects pack paths outside the workspace before collecting them", async () => {
    const workspace = workspaceWithConfig("[config]\njev_mode=shadow\njev_transport=typesafe\n");
    const pilotBytes = canonicalJsonBytes(fixture().pilot);
    let reads = 0;
    let submits = 0;
    const channel: EvaluatorChannel = {
      submit: async () => { submits += 1; return channelResponse("recorded"); },
      cancel: async () => {},
    };
    const result = await runReviewAdvice({
      ...invocation(workspace),
      input: { kind: "file", path: "../private.json" },
    }, new AbortController().signal, attestEvaluatorChannel(channel), {
      readFile: async () => { reads += 1; return pilotBytes; },
    });

    expect(result).toMatchObject({ status: "invalid", code: "jev.input-outside-workspace", advice: null });
    expect(reads).toBe(1);
    expect(submits).toBe(0);
  });

  test("shadow submits only the canonical bounded pack through its injected channel", async () => {
    const workspace = workspaceWithConfig("[config]\njev_mode=shadow\njev_transport=typesafe\n");
    const prepared = fixture();
    const pilotBytes = canonicalJsonBytes(prepared.pilot);
    const packBytes = canonicalJsonBytes(prepared.pack);
    let submission: Readonly<{ packBytes: Uint8Array; pilotDigest: string }> | undefined;
    const effects: RuntimeEffects = {
      readFile: async (path) => path.endsWith("pilot.json") ? pilotBytes : packBytes,
    };
    const channel: EvaluatorChannel = {
      submit: async (input) => { submission = input; return channelResponse("recorded"); },
      cancel: async () => {},
    };

    const result = await runReviewAdvice(invocation(workspace), new AbortController().signal, attestEvaluatorChannel(channel), effects);
    expect(result).toEqual({ schema: "mstar.judgment-cli/v1", contractRevision: CONTRACT_REVISION, status: "recorded", advice: null });
    expect(submission?.packBytes).toEqual(packBytes);
    expect(submission?.pilotDigest).toBe(createHash("sha256").update(pilotBytes).digest("hex"));
    expect(Object.keys(result)).toEqual(["schema", "contractRevision", "status", "advice"]);
  });

  test("off during input collection ignores a late pilot result without reading pack", async () => {
    vi.useFakeTimers();
    const workspace = workspaceWithConfig("[config]\njev_mode=shadow\njev_transport=typesafe\n");
    const prepared = fixture();
    let configReads = 0;
    let inputReads = 0;
    let submits = 0;
    const enabled = resolveJudgmentConfig(workspace, workspace);
    const { promise: pilotRead, resolve: finishPilotRead } = Promise.withResolvers<Uint8Array>();
    const { promise: readingPilot, resolve: markReadingPilot } = Promise.withResolvers<void>();
    const effects: RuntimeEffects = {
      resolveConfig: () => {
        configReads += 1;
        return configReads <= 2 ? enabled : { state: "disabled" };
      },
      readFile: async (path) => {
        inputReads += 1;
        if (path.endsWith("pilot.json")) {
          markReadingPilot();
          return pilotRead;
        }
        return canonicalJsonBytes(prepared.pack);
      },
    };
    const channel: EvaluatorChannel = {
      submit: async () => { submits += 1; return channelResponse("recorded"); },
      cancel: async () => {},
    };

    const pending = runReviewAdvice(invocation(workspace), new AbortController().signal, attestEvaluatorChannel(channel), effects);
    await readingPilot;
    vi.advanceTimersByTime(100);
    const result = await pending;
    expect(result).toMatchObject({ status: "unavailable", code: "jev.revoked", advice: null });
    finishPilotRead(canonicalJsonBytes(prepared.pilot));
    await Promise.resolve();
    expect(inputReads).toBe(1);
    expect(submits).toBe(0);
  });

  test("off during an active pilot read aborts that read and ignores late bytes", async () => {
    vi.useFakeTimers();
    const workspace = workspaceWithConfig("[config]\njev_mode=shadow\njev_transport=typesafe\n");
    const prepared = fixture();
    let configReads = 0;
    let inputReads = 0;
    let readAborted = false;
    let submits = 0;
    const enabled = resolveJudgmentConfig(workspace, workspace);
    const { promise: readingPilot, resolve: markReadingPilot } = Promise.withResolvers<void>();
    const { promise: pilotRead, reject: rejectPilotRead } = Promise.withResolvers<Uint8Array>();
    const effects: RuntimeEffects = {
      resolveConfig: () => {
        configReads += 1;
        return configReads <= 2 ? enabled : { state: "disabled" };
      },
      readFile: async (path, _maxBytes, readSignal) => {
        inputReads += 1;
        if (path.endsWith("pilot.json")) {
          markReadingPilot();
          readSignal.addEventListener("abort", () => {
            readAborted = true;
            rejectPilotRead(new Error("read aborted"));
          }, { once: true });
          return pilotRead;
        }
        return canonicalJsonBytes(prepared.pack);
      },
    };
    const channel: EvaluatorChannel = {
      submit: async () => { submits += 1; return channelResponse("recorded"); },
      cancel: async () => {},
    };

    const pending = runReviewAdvice(invocation(workspace), new AbortController().signal, attestEvaluatorChannel(channel), effects);
    await readingPilot;
    vi.advanceTimersByTime(100);
    const result = await pending;
    expect(result).toMatchObject({ status: "unavailable", code: "jev.revoked", advice: null });
    expect(readAborted).toBe(true);
    expect(inputReads).toBe(1);
    expect(submits).toBe(0);
  });

  test("off during an active stdin read aborts stdin consumption", async () => {
    vi.useFakeTimers();
    const workspace = workspaceWithConfig("[config]\njev_mode=shadow\njev_transport=typesafe\n");
    const prepared = fixture();
    let configReads = 0;
    let stdinReads = 0;
    let stdinAborted = false;
    let submits = 0;
    const enabled = resolveJudgmentConfig(workspace, workspace);
    const { promise: readingStdin, resolve: markReadingStdin } = Promise.withResolvers<void>();
    const { promise: stdinRead, reject: rejectStdinRead } = Promise.withResolvers<Uint8Array>();
    const effects: RuntimeEffects = {
      resolveConfig: () => {
        configReads += 1;
        return configReads <= 4 ? enabled : { state: "disabled" };
      },
      readFile: async () => canonicalJsonBytes(prepared.pilot),
      readStdin: async (_maxBytes, readSignal) => {
        stdinReads += 1;
        markReadingStdin();
          readSignal.addEventListener("abort", () => {
            stdinAborted = true;
            rejectStdinRead(new Error("stdin read aborted"));
          }, { once: true });
          return stdinRead;
      },
    };
    const channel: EvaluatorChannel = {
      submit: async () => { submits += 1; return channelResponse("recorded"); },
      cancel: async () => {},
    };
    const pending = runReviewAdvice({
      ...invocation(workspace),
      input: { kind: "stdin" },
    }, new AbortController().signal, attestEvaluatorChannel(channel), effects);
    await readingStdin;
    vi.advanceTimersByTime(100);
    const result = await pending;
    expect(result).toMatchObject({ status: "unavailable", code: "jev.revoked", advice: null });
    expect(stdinAborted).toBe(true);
    expect(stdinReads).toBe(1);
    expect(submits).toBe(0);
  });

  test("off observed during channel submission cancels it and cannot consume a late result", async () => {
    vi.useFakeTimers();
    const workspace = workspaceWithConfig("[config]\njev_mode=shadow\njev_transport=typesafe\n");
    const prepared = fixture();
    let configReads = 0;
    const enabled = resolveJudgmentConfig(workspace, workspace);
    const effects: RuntimeEffects = {
      resolveConfig: () => {
        configReads += 1;
        return configReads <= 7 ? enabled : { state: "disabled" };
      },
      readFile: async (path) => path.endsWith("pilot.json") ? canonicalJsonBytes(prepared.pilot) : canonicalJsonBytes(prepared.pack),
    };
    let cancels = 0;
    const { promise: submitted, resolve: markSubmitted } = Promise.withResolvers<void>();
    const channel: EvaluatorChannel = {
      submit: async (_input, signal) => {
        const { promise, reject } = Promise.withResolvers<EvaluatorChannelResponse>();
        signal.addEventListener("abort", () => reject(new Error("revoked")), { once: true });
        markSubmitted();
        return promise;
      },
      cancel: async () => { cancels += 1; },
    };

    const pending = runReviewAdvice(invocation(workspace), new AbortController().signal, attestEvaluatorChannel(channel), effects);
    await submitted;
    vi.advanceTimersByTime(100);
    const result = await pending;
    expect(result).toMatchObject({ status: "unavailable", code: "jev.revoked", advice: null });
    expect(cancels).toBe(1);
  });


  test("whole-review cancellation is distinct from an optional channel failure", async () => {
    const workspace = workspaceWithConfig("[config]\njev_mode=shadow\njev_transport=typesafe\n");
    const prepared = fixture();
    const effects: RuntimeEffects = {
      readFile: async (path) => path.endsWith("pilot.json") ? canonicalJsonBytes(prepared.pilot) : canonicalJsonBytes(prepared.pack),
    };
    const failureChannel: EvaluatorChannel = {
      submit: async () => { throw new Error("optional service failure"); },
      cancel: async () => {},
    };
    const optional = await runReviewAdvice(invocation(workspace), new AbortController().signal, attestEvaluatorChannel(failureChannel), effects);
    expect(optional).toMatchObject({ status: "unavailable", code: "jev.channel-failed" });

    const abortController = new AbortController();
    const { promise: submitted, resolve: markSubmitted } = Promise.withResolvers<void>();
    const cancellationChannel: EvaluatorChannel = {
      submit: async (_input, signal) => {
        const { promise, reject } = Promise.withResolvers<EvaluatorChannelResponse>();
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        markSubmitted();
        return promise;
      },
      cancel: async () => {},
    };
    const pending = runReviewAdvice(invocation(workspace), abortController.signal, attestEvaluatorChannel(cancellationChannel), effects);
    await submitted;
    abortController.abort();
    const cancelled = await pending;
    expect(cancelled).toMatchObject({ status: "cancelled", code: "jev.review-cancelled" });
  });
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
