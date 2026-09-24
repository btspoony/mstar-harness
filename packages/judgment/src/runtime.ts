import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { findMstarc, parseMstarc, type MstarcConfig } from "../../engine/src/mstarc.js";
import {
  CONTRACT_REVISION,
  NATIVE_MODEL,
  type JudgmentPilot,
  type ReviewDecisionPack,
  validatePack,
  validatePilot,
} from "./contracts.js";
import { buildA05Request, canonicalJsonBytes, type PreparedRequest } from "./review-advice.js";
import { normalizeTypeSafeResponse, type NormalizedTypeSafeResponse } from "./normalize.js";
import { sendNativeRequest, type NativeTransportInput, type NativeTransportResult } from "./typesafe.js";
import { createRunBudgetPolicy, reserveRunBudget, RunBudgetError, type ReusedRunResult, type RunReservation } from "./run-budget.js";

const CLI_SCHEMA = "mstar.judgment-cli/v1" as const;
const RESULT_SCHEMA = "mstar.judgment-result/v1" as const;
const MAX_PILOT_BYTES = 1_048_576;
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

export type JudgmentCliStatus = "disabled" | "recorded" | "unavailable" | "invalid" | "cancelled";
export type JudgmentCliResult = Readonly<{
  schema: typeof CLI_SCHEMA;
  contractRevision: typeof CONTRACT_REVISION;
  status: JudgmentCliStatus;
  advice: null;
  code?: string;
}>;

export type EvaluatorChannelResponse = Readonly<{
  status: "recorded" | "unavailable" | "invalid";
  code?: string;
}>;

export type EvaluatorChannel = Readonly<{
  submit(input: Readonly<{ packBytes: Uint8Array; pilotDigest: string }>, signal: AbortSignal): Promise<EvaluatorChannelResponse>;
  cancel(): Promise<void>;
}>;

export type RuntimeEffects = Readonly<{
  resolveConfig?: typeof resolveJudgmentConfig;
  readFile?: (path: string, maxBytes: number) => Promise<Uint8Array>;
  readStdin?: (maxBytes: number) => Promise<Uint8Array>;
}>;

export class JudgmentRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "JudgmentRuntimeError";
  }
}

function cliResult(status: JudgmentCliStatus, code?: string): JudgmentCliResult {
  return code === undefined
    ? Object.freeze({ schema: CLI_SCHEMA, contractRevision: CONTRACT_REVISION, status, advice: null })
    : Object.freeze({ schema: CLI_SCHEMA, contractRevision: CONTRACT_REVISION, status, advice: null, code });
}

function fileBytes(path: string, maxBytes: number, workspace: string): Uint8Array {
  const canonicalPath = realpathSync(path);
  const canonicalRelative = relative(workspace, canonicalPath);
  if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(canonicalRelative)) {
    throw new JudgmentRuntimeError("jev.input-outside-workspace", "Input must remain inside its workspace");
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(canonicalPath, constants.O_RDONLY | noFollow);
  try {
    if (!fstatSync(fd).isFile()) throw new JudgmentRuntimeError("jev.input-invalid", "Input must be a regular file");
    const chunks: Buffer[] = [];
    const chunk = Buffer.alloc(Math.min(8_192, maxBytes + 1));
    let total = 0;
    while (total <= maxBytes) {
      const length = readSync(fd, chunk, 0, Math.min(chunk.length, maxBytes + 1 - total), null);
      if (length === 0) break;
      total += length;
      if (total > maxBytes) throw new JudgmentRuntimeError("jev.input-too-large", "Input exceeds its byte limit");
      chunks.push(Buffer.from(chunk.subarray(0, length)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}
function workspaceInputPath(cwd: string, workspace: string, path: string): string {
  const resolved = resolve(cwd, path);
  const inputRelative = relative(workspace, resolved);
  if (inputRelative === ".." || inputRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(inputRelative)) {
    throw new JudgmentRuntimeError("jev.input-outside-workspace", "Input must remain inside its workspace");
  }
  return resolved;
}

async function stdinBytes(maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.byteLength;
    if (total > maxBytes) throw new JudgmentRuntimeError("jev.input-too-large", "Input exceeds its byte limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function parseObject(bytes: Uint8Array, code: string): unknown {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new JudgmentRuntimeError(code, "Input is not valid UTF-8"); }
  try { return JSON.parse(text) as unknown; }
  catch { throw new JudgmentRuntimeError(code, "Input is not valid JSON"); }
}

function pilotDigest(pilot: JudgmentPilot): string {
  return createHash("sha256").update(canonicalJsonBytes(pilot)).digest("hex");
}

function sameEnabledConfig(left: ResolvedJudgmentConfig, right: ResolvedJudgmentConfig): boolean {
  return left.state === "enabled" && right.state === "enabled" && left.mode === right.mode &&
    left.transport === right.transport && left.cwd === right.cwd && left.workspace === right.workspace &&
    left.configPath === right.configPath;
}

function invocationIsValid(invocation: JudgmentInvocation): boolean {
  return invocation !== null && typeof invocation === "object" &&
    typeof invocation.cwd === "string" && typeof invocation.workspace === "string" &&
    (invocation.pilotPath === null || typeof invocation.pilotPath === "string") &&
    invocation.input !== null && typeof invocation.input === "object" &&
    (invocation.input.kind === "stdin" || (invocation.input.kind === "file" && typeof invocation.input.path === "string"));
}

function channelIsValid(channel: EvaluatorChannel | null): channel is EvaluatorChannel {
  return channel !== null && typeof channel === "object" &&
    typeof channel.submit === "function" && typeof channel.cancel === "function";
}

function publicChannelResponse(value: EvaluatorChannelResponse): JudgmentCliResult {
  if (value === null || typeof value !== "object" ||
      !["recorded", "unavailable", "invalid"].includes(value.status) ||
      (value.code !== undefined && !/^[a-z0-9][a-z0-9.-]{0,95}$/.test(value.code))) {
    return cliResult("unavailable", "jev.channel-response-invalid");
  }
  return cliResult(value.status, value.code);
}

export async function runReviewAdvice(
  invocation: JudgmentInvocation,
  signal: AbortSignal,
  channel: EvaluatorChannel | null,
  effects: RuntimeEffects = {},
): Promise<JudgmentCliResult> {
  if (!invocationIsValid(invocation)) return cliResult("invalid", "jev.invocation-invalid");
  const resolveConfig = effects.resolveConfig ?? resolveJudgmentConfig;
  const config = resolveConfig(invocation.cwd, invocation.workspace);
  if (config.state === "disabled") return cliResult("disabled");
  if (config.state === "invalid") return cliResult("invalid", config.code);
  if (channel === null || !channelIsValid(channel)) return cliResult("unavailable", "jev.channel-unavailable");
  if (invocation.pilotPath === null) return cliResult("invalid", "jev.pilot-required");
  if (signal.aborted) return cliResult("cancelled", "jev.review-cancelled");

  const readFile = effects.readFile ?? (async (path, maxBytes) => fileBytes(path, maxBytes, config.workspace));
  let pilot: JudgmentPilot;
  try {
    const pilotPath = workspaceInputPath(config.cwd, config.workspace, invocation.pilotPath);
    const pilotBytes = await raceWithCallerSignal(readFile(pilotPath, MAX_PILOT_BYTES), signal);
    pilot = validatePilot(parseObject(pilotBytes, "jev.pilot-invalid"));
  } catch (error) {
    if (signal.aborted) return cliResult("cancelled", "jev.review-cancelled");
    if (error instanceof JudgmentRuntimeError) return cliResult("invalid", error.code);
    return cliResult("invalid", "jev.pilot-invalid");
  }
  if (signal.aborted) return cliResult("cancelled", "jev.review-cancelled");
  if (pilot.mode !== config.mode || pilot.transport !== config.transport || pilot.permission.dataClass !== "synthetic-only") {
    return cliResult("invalid", "jev.pilot-config-mismatch");
  }
  const maxPackBytes = pilot.limits.maxPackBytes;
  let packBytes: Uint8Array;
  try {
    if (invocation.input.kind === "file") {
      const packPath = workspaceInputPath(config.cwd, config.workspace, invocation.input.path);
      packBytes = await raceWithCallerSignal(readFile(packPath, maxPackBytes), signal);
    } else {
      packBytes = await raceWithCallerSignal((effects.readStdin ?? stdinBytes)(maxPackBytes), signal);
    }
    if (packBytes.byteLength > maxPackBytes) throw new JudgmentRuntimeError("jev.input-too-large", "Input exceeds its byte limit");
  } catch (error) {
    if (signal.aborted) return cliResult("cancelled", "jev.review-cancelled");
    if (error instanceof JudgmentRuntimeError) return cliResult("invalid", error.code);
    return cliResult("invalid", "jev.pack-unavailable");
  }

  let pack: ReviewDecisionPack;
  let canonicalPack: Uint8Array;
  try {
    pack = validatePack(parseObject(packBytes, "jev.pack-invalid"));
    canonicalPack = canonicalJsonBytes(pack);
    if (canonicalPack.byteLength > maxPackBytes) return cliResult("invalid", "jev.input-too-large");
    buildA05Request(pack, pilot);
  } catch {
    return cliResult("invalid", "jev.pack-invalid");
  }

  const latest = resolveConfig(invocation.cwd, invocation.workspace);
  if (!sameEnabledConfig(config, latest)) return cliResult("unavailable", "jev.revoked");
  if (signal.aborted) return cliResult("cancelled", "jev.review-cancelled");

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort("review-cancelled");
  signal.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort("deadline"), pilot.limits.timeoutMs);
  const poll = setInterval(() => {
    try {
      if (!sameEnabledConfig(config, resolveConfig(invocation.cwd, invocation.workspace))) controller.abort("revoked");
    } catch {
      controller.abort("revoked");
    }
  }, MODE_OBSERVATION_MS);
  let cancelRequested = false;
  const cancelChannel = () => {
    if (cancelRequested) return;
    cancelRequested = true;
    try { void channel.cancel().catch(() => {}); } catch { /* revoked channel is no longer consumable */ }
  };
  controller.signal.addEventListener("abort", cancelChannel, { once: true });
  try {
    const response = await raceWithSignal(
      channel.submit(Object.freeze({ packBytes: canonicalPack, pilotDigest: pilotDigest(pilot) }), controller.signal),
      controller.signal,
    );
    if (controller.signal.aborted) return cliResult(signal.aborted ? "cancelled" : "unavailable", signal.aborted ? "jev.review-cancelled" : "jev.revoked");
    if (!sameEnabledConfig(config, resolveConfig(invocation.cwd, invocation.workspace))) return cliResult("unavailable", "jev.revoked");
    return publicChannelResponse(response);
  } catch {
    if (signal.aborted) return cliResult("cancelled", "jev.review-cancelled");
    if (controller.signal.reason === "revoked") return cliResult("unavailable", "jev.revoked");
    if (controller.signal.reason === "deadline") return cliResult("unavailable", "jev.deadline");
    return cliResult("unavailable", "jev.channel-failed");
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
    signal.removeEventListener("abort", abortFromCaller);
    controller.signal.removeEventListener("abort", cancelChannel);
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

function raceWithCallerSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new JudgmentRuntimeError("jev.review-cancelled", "Whole-review evaluation was cancelled"));
  const { promise, reject } = Promise.withResolvers<never>();
  const abort = () => reject(new JudgmentRuntimeError("jev.review-cancelled", "Whole-review evaluation was cancelled"));
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
