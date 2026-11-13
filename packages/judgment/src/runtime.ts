import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { findMstarc, parseMstarc, type MstarcConfig } from "@mstar-harness/engine";
import {
  CONTRACT_REVISION,
  NATIVE_MODEL,
  type JudgmentPilot,
  type ReviewDecisionPack,
  validatePack,
  validatePilot,
} from "./contracts.js";
import { buildA05Request, type PreparedRequest } from "./review-advice.js";
import { normalizeTypeSafeResponse, type NormalizedTypeSafeResponse } from "./normalize.js";
import { sendNativeRequest, type NativeTransportInput, type NativeTransportResult } from "./typesafe.js";
import { createRunBudgetPolicy, reserveRunBudget, RunBudgetError, type ReusedRunResult, type RunReservation } from "./run-budget.js";

const RESULT_SCHEMA = "mstar.judgment-result/v1" as const;
const MODE_OBSERVATION_MS = 100;

type InvalidConfig = Readonly<{ state: "invalid"; code: string }>;
type DisabledConfig = Readonly<{ state: "disabled" }>;
type EnabledConfig = Readonly<{
  state: "enabled";
  mode: "shadow";
  transport: "native-typesafe";
  cwd: string;
  workspace: string;
  configPath: string;
}>;
export type ResolvedJudgmentConfig = DisabledConfig | EnabledConfig | InvalidConfig;

export function resolveJudgmentConfig(cwd: string, workspace: string): ResolvedJudgmentConfig {
  if (!isAbsolute(cwd) || !isAbsolute(workspace)) return { state: "invalid", code: "jev.invocation-invalid" };
  let canonicalCwd: string;
  let canonicalWorkspace: string;
  try {
    canonicalCwd = realpathSync(cwd);
    canonicalWorkspace = realpathSync(workspace);
  } catch {
    return { state: "invalid", code: "jev.workspace-unavailable" };
  }
  const cwdRelative = relative(canonicalWorkspace, canonicalCwd);
  if (cwdRelative === ".." || cwdRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(cwdRelative)) {
    return { state: "invalid", code: "jev.workspace-boundary" };
  }
  const configPath = findMstarc(canonicalCwd, canonicalWorkspace);
  if (configPath === null) return { state: "disabled" };
  let config: MstarcConfig;
  try { config = parseMstarc(readFileSync(configPath, "utf8")); }
  catch { return { state: "invalid", code: "jev.config-unavailable" }; }

  if (config.jevMode === undefined || config.jevMode === "off") return { state: "disabled" };
  if (config.jevMode !== "shadow") return { state: "invalid", code: "jev.mode-unsupported" };
  if (config.jevTransport === "assist") return { state: "invalid", code: "jev.assist-not-qualified" };
  if (config.jevTransport === "omp-judge") return { state: "invalid", code: "jev.host-contract-unavailable" };
  if (config.jevTransport === undefined) return { state: "invalid", code: "jev.transport-required" };
  if (config.jevTransport !== "typesafe") return { state: "invalid", code: "jev.transport-unsupported" };
  return {
    state: "enabled",
    mode: "shadow",
    transport: "native-typesafe",
    cwd: canonicalCwd,
    workspace: canonicalWorkspace,
    configPath,
  };
}

export type JudgmentInvocation = Readonly<{
  cwd: string;
  workspace: string;
  input: Readonly<{ kind: "file"; path: string }> | Readonly<{ kind: "stdin" }>;
  pilotPath: string | null;
}>;

export type EvaluatorChannelResponse = Readonly<{
  status: "recorded" | "unavailable" | "invalid";
  code?: string;
}>;

export type EvaluatorChannel = Readonly<{
  submit(input: Readonly<{ packBytes: Uint8Array; pilotDigest: string }>, signal: AbortSignal): Promise<EvaluatorChannelResponse>;
  cancel(): Promise<void>;
}>;

export class JudgmentRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "JudgmentRuntimeError";
  }
}

export type JudgmentResult = Readonly<{
  schema: typeof RESULT_SCHEMA;
  contractRevision: typeof CONTRACT_REVISION;
  runId: string;
  pilotId: string;
  packId: string;
  packSha256: string;
  requestSha256: string;
  reservationId: string;
  model: typeof NATIVE_MODEL;
  response: NormalizedTypeSafeResponse;
  elapsedMs: number;
}>;

export type EvaluatorContext = Readonly<{
  pilot: JudgmentPilot;
  pack: ReviewDecisionPack;
  runDirectory: string;
  isCurrent(): boolean | Promise<boolean>;
  readCredential(signal: AbortSignal): string | Promise<string>;
  writeSealedResult(
    result: JudgmentResult,
    options: Readonly<{ signal: AbortSignal; deadline: number }>,
  ): Promise<string>;
  readSealedResult(resultReference: string, signal: AbortSignal): Promise<JudgmentResult>;
  sendRequest?: (input: NativeTransportInput) => Promise<NativeTransportResult>;
}>;

function activeError(signal: AbortSignal): JudgmentRuntimeError {
  if (signal.reason === "review-cancelled") return new JudgmentRuntimeError("jev.review-cancelled", "Whole-review evaluation was cancelled");
  if (signal.reason === "deadline") return new JudgmentRuntimeError("jev.deadline", "Evaluation deadline expired");
  return new JudgmentRuntimeError("jev.revoked", "Evaluator context was revoked or became stale");
}

function raceWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(activeError(signal));
  const { promise, reject } = Promise.withResolvers<never>();
  const abort = () => reject(activeError(signal));
  signal.addEventListener("abort", abort, { once: true });
  return Promise.race([work, promise]).finally(() => signal.removeEventListener("abort", abort));
}

function watchContext(context: EvaluatorContext, controller: AbortController): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const poll = async () => {
    if (stopped || controller.signal.aborted) return;
    try {
      if (!await context.isCurrent()) controller.abort("revoked");
    } catch {
      controller.abort("revoked");
    }
    if (!stopped && !controller.signal.aborted) timer = setTimeout(poll, MODE_OBSERVATION_MS);
  };
  timer = setTimeout(poll, MODE_OBSERVATION_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

async function assertCurrent(context: EvaluatorContext, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw activeError(signal);
  let current: boolean;
  try { current = await raceWithSignal(Promise.resolve(context.isCurrent()), signal); }
  catch (error) {
    if (error instanceof JudgmentRuntimeError) throw error;
    throw new JudgmentRuntimeError("jev.revoked", "Evaluator context could not be verified");
  }
  if (!current) throw new JudgmentRuntimeError("jev.revoked", "Evaluator context was revoked or became stale");
}

function validatePreparedRequest(request: PreparedRequest, expected: PreparedRequest): void {
  const digest = createHash("sha256").update(request.bytes).digest("hex");
  if (digest !== request.requestSha256 || digest !== expected.requestSha256 || request.packId !== expected.packId ||
      request.packSha256 !== expected.packSha256 || request.pilotId !== expected.pilotId || request.model !== expected.model) {
    throw new JudgmentRuntimeError("jev.request-mismatch", "Prepared request does not match the frozen pack and pilot");
  }
}

function runtimeFailureCode(error: unknown): string {
  if (error instanceof RunBudgetError) return error.code;
  if (error instanceof JudgmentRuntimeError) return error.code;
  return "jev.evaluation-failed";
}

export async function evaluateNative(
  request: PreparedRequest,
  context: EvaluatorContext,
  signal: AbortSignal,
): Promise<JudgmentResult> {
  if (typeof context.isCurrent !== "function" || typeof context.readCredential !== "function" ||
      typeof context.writeSealedResult !== "function" || typeof context.readSealedResult !== "function") {
    throw new JudgmentRuntimeError("jev.evaluator-context-invalid", "Trusted evaluator capabilities are incomplete");
  }
  if (signal.aborted) throw new JudgmentRuntimeError("jev.review-cancelled", "Whole-review evaluation was cancelled");
  await assertCurrent(context, signal);
  let pilot: JudgmentPilot;
  let pack: ReviewDecisionPack;
  let expected: PreparedRequest;
  try {
    pilot = validatePilot(context.pilot);
    pack = validatePack(context.pack);
    if (pilot.permission.dataClass !== "synthetic-only") throw new TypeError("Permission is not synthetic-only");
    expected = buildA05Request(pack, pilot);
    validatePreparedRequest(request, expected);
  } catch (error) {
    if (error instanceof JudgmentRuntimeError) throw error;
    throw new JudgmentRuntimeError("jev.pilot-pack-mismatch", "Pack, pilot, and prepared request do not match");
  }
  if (pilot.runId !== pack.runId || pilot.runId !== basename(context.runDirectory)) {
    throw new JudgmentRuntimeError("jev.run-mismatch", "Evaluator artifacts do not belong to this run");
  }
  const policy = createRunBudgetPolicy(pilot);
  const budgetInput = Object.freeze({
    runDirectory: context.runDirectory,
    policy,
    packId: pack.packId,
    packSha256: expected.packSha256,
    requestSha256: expected.requestSha256,
    pairCount: Object.keys(expected.questionMap).length,
  });
  const startedAt = performance.now();
  const deadline = startedAt + pilot.limits.timeoutMs;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort("review-cancelled");
  signal.addEventListener("abort", abortFromCaller, { once: true });
  if (signal.aborted) controller.abort("review-cancelled");
  const timer = setTimeout(() => controller.abort("deadline"), Math.max(0, deadline - performance.now()));
  let reservation: RunReservation | ReusedRunResult | undefined;
  let settled = false;
  let stopWatching = () => {};
  try {
    if (controller.signal.aborted) throw activeError(controller.signal);
    reservation = await reserveRunBudget(budgetInput);
    await assertCurrent(context, controller.signal);
    stopWatching = watchContext(context, controller);
    if (reservation.kind === "reuse") {
      const reused = await raceWithSignal(context.readSealedResult(reservation.resultReference, controller.signal), controller.signal);
      await assertCurrent(context, controller.signal);
      if (reused.requestSha256 !== expected.requestSha256 || reused.runId !== pilot.runId || reused.pilotId !== pilot.pilotId ||
          reused.packId !== pack.packId || reused.packSha256 !== expected.packSha256) {
        throw new JudgmentRuntimeError("jev.reuse-mismatch", "Stored result does not match the original reservation");
      }
      return reused;
    }

    if (performance.now() >= deadline) throw new JudgmentRuntimeError("jev.deadline", "Evaluation deadline expired");
    await assertCurrent(context, controller.signal);
    const credential = await raceWithSignal(Promise.resolve(context.readCredential(controller.signal)), controller.signal);
    if (typeof credential !== "string" || credential.length === 0) {
      throw new JudgmentRuntimeError("jev.credential-unavailable", "Native credential is unavailable");
    }
    await assertCurrent(context, controller.signal);
    if (performance.now() >= deadline) throw new JudgmentRuntimeError("jev.deadline", "Evaluation deadline expired");
    const sendRequest = context.sendRequest ?? sendNativeRequest;
    const transport = await raceWithSignal(sendRequest({
      requestBytes: expected.bytes,
      credential,
      signal: controller.signal,
      deadline,
      maxResponseBytes: pilot.limits.maxResponseBytes,
    }), controller.signal);
    if (transport === null || typeof transport !== "object" || !(transport.responseBytes instanceof Uint8Array) ||
        transport.responseBytes.byteLength > pilot.limits.maxResponseBytes ||
        !Number.isInteger(transport.status) || transport.status < 200 || transport.status >= 300) {
      throw new JudgmentRuntimeError("jev.transport-response-invalid", "Native transport returned an invalid response");
    }
    if (performance.now() >= deadline || !Number.isFinite(transport.elapsedMs) ||
        transport.elapsedMs < 0 || transport.elapsedMs > pilot.limits.timeoutMs) {
      throw new JudgmentRuntimeError("jev.deadline", "Evaluation exceeded its finite deadline");
    }
    let normalized: NormalizedTypeSafeResponse;
    try { normalized = normalizeTypeSafeResponse(transport.responseBytes, expected); }
    catch { throw new JudgmentRuntimeError("jev.response-invalid", "Native transport response did not match the request contract"); }
    if (normalized.usage !== null && normalized.usage.inputTokens > pilot.tokenPolicy.perAttemptReservation) {
      throw new JudgmentRuntimeError("jev.usage-exceeds-reservation", "Observed input usage exceeds the fixed token reservation");
    }
    await assertCurrent(context, controller.signal);
    const result: JudgmentResult = Object.freeze({
      schema: RESULT_SCHEMA,
      contractRevision: CONTRACT_REVISION,
      runId: pilot.runId,
      pilotId: pilot.pilotId,
      packId: pack.packId,
      packSha256: expected.packSha256,
      requestSha256: expected.requestSha256,
      reservationId: reservation.id,
      model: NATIVE_MODEL,
      response: normalized,
      elapsedMs: transport.elapsedMs,
    });
    const resultReference = await raceWithSignal(context.writeSealedResult(result, { signal: controller.signal, deadline }), controller.signal);
    await assertCurrent(context, controller.signal);
    if (performance.now() >= deadline) throw new JudgmentRuntimeError("jev.deadline", "Evaluation deadline expired before recording");
    await reservation.complete(resultReference, normalized.usage, controller.signal);
    settled = true;
    return result;
  } catch (error) {
    if (reservation?.kind === "reserved" && !settled) {
      try { await reservation.fail(runtimeFailureCode(error)); } catch { /* the durable reservation remains unknown and spent */ }
    }
    if (controller.signal.aborted) throw activeError(controller.signal);
    if (error instanceof JudgmentRuntimeError || error instanceof RunBudgetError) throw error;
    throw new JudgmentRuntimeError("jev.evaluation-failed", "Native evaluation failed without a reusable result");
  } finally {
    stopWatching();
    clearTimeout(timer);
    signal.removeEventListener("abort", abortFromCaller);
  }
}
