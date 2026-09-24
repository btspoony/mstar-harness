import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  MAX_RUN_RESERVED_INPUT_TOKENS,
  TOKEN_POLICY_METHOD,
  TOKEN_RESERVATION_PER_ATTEMPT,
  type JudgmentPilot,
} from "./contracts.js";
import { canonicalJsonBytes } from "./review-advice.js";

const POLICY_SCHEMA = "mstar.judgment.run-budget/v1";
const RESERVATION_SCHEMA = "mstar.judgment.run-reservation/v1";
const OUTCOME_SCHEMA = "mstar.judgment.run-outcome/v1";
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 10;

export type RunBudgetPolicy = Readonly<{
  schema: typeof POLICY_SCHEMA;
  runId: string;
  pilotId: string;
  pilotSha256: string;
  policyVersion: string;
  maxCallsPerRun: number;
  maxConcurrentRequests: number;
  maxPacksPerRun: number;
  maxPairsPerPack: number;
  maxTasksPerPack: number;
  maxRunElapsedMs: number;
  perAttemptElapsedMs: number;
  perAttemptReservedInputTokens: typeof TOKEN_RESERVATION_PER_ATTEMPT;
  maxRunReservedInputTokens: number;
}>;

export class RunBudgetError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RunBudgetError";
  }
}

export type RunReservation = Readonly<{
  kind: "reserved";
  id: string;
  requestSha256: string;
  complete(resultReference: string, usage: Readonly<{ inputTokens: number; outputTokens: number }> | null, signal?: AbortSignal): Promise<void>;
  fail(code: string): Promise<void>;
}>;

export type ReusedRunResult = Readonly<{
  kind: "reuse";
  id: string;
  requestSha256: string;
  resultReference: string;
  usage: Readonly<{ inputTokens: number; outputTokens: number }> | null;
}>;

export type ReserveRunBudgetInput = Readonly<{
  runDirectory: string;
  policy: RunBudgetPolicy;
  packId: string;
  packSha256: string;
  requestSha256: string;
  pairCount: number;
}>;

export function createRunBudgetPolicy(pilot: JudgmentPilot): RunBudgetPolicy {
  if (pilot.tokenPolicy.method !== TOKEN_POLICY_METHOD ||
      pilot.tokenPolicy.perAttemptReservation !== TOKEN_RESERVATION_PER_ATTEMPT) {
    throw new RunBudgetError("run-budget.invalid-policy", "Pilot does not use the fixed provider-context reservation policy");
  }
  return Object.freeze({
    schema: POLICY_SCHEMA,
    runId: pilot.runId,
    pilotId: pilot.pilotId,
    pilotSha256: createHash("sha256").update(canonicalJsonBytes(pilot)).digest("hex"),
    policyVersion: pilot.policyVersion,
    maxCallsPerRun: pilot.limits.maxCallsPerRun,
    maxConcurrentRequests: pilot.limits.maxConcurrentRequests,
    maxPacksPerRun: pilot.limits.maxPacksPerRun,
    maxPairsPerPack: pilot.limits.maxPairs,
    maxTasksPerPack: pilot.limits.maxTasksPerPack,
    maxRunElapsedMs: pilot.limits.maxRunElapsedMs,
    perAttemptElapsedMs: pilot.limits.timeoutMs,
    perAttemptReservedInputTokens: TOKEN_RESERVATION_PER_ATTEMPT,
    maxRunReservedInputTokens: pilot.tokenPolicy.maxRunReservedInputTokens,
  });
}

function fail(code: string, message: string): never {
  throw new RunBudgetError(code, message);
}

function isDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function assertArtifactRoot(runDirectory: string): void {
  const evidenceDirectory = dirname(runDirectory);
  try {
    const evidenceStat = lstatSync(evidenceDirectory);
    const runStat = lstatSync(runDirectory);
    if (!evidenceStat.isDirectory() || evidenceStat.isSymbolicLink() || !runStat.isDirectory() || runStat.isSymbolicLink() ||
        realpathSync(evidenceDirectory) !== evidenceDirectory || realpathSync(runDirectory) !== runDirectory) {
      fail("run-budget.invalid-artifact-root", "Run artifacts must use real evidence/<run-id> directories");
    }
  } catch (error) {
    if (error instanceof RunBudgetError) throw error;
    fail("run-budget.invalid-artifact-root", "Run artifact root is unavailable");
  }
}

function validateInput(input: ReserveRunBudgetInput): void {
  const { policy } = input;
  if (!isAbsolute(input.runDirectory) || resolve(input.runDirectory) !== input.runDirectory ||
      basename(dirname(input.runDirectory)) !== "evidence" || basename(input.runDirectory) !== policy.runId) {
    fail("run-budget.invalid-artifact-root", "Run budget must be stored under evidence/<run-id>");
  }
  assertArtifactRoot(input.runDirectory);
  if (policy.schema !== POLICY_SCHEMA || !policy.runId || !policy.pilotId || !policy.policyVersion || !isDigest(policy.pilotSha256)) {
    fail("run-budget.invalid-policy", "Run budget policy is malformed");
  }
  for (const [name, value] of Object.entries({
    maxCallsPerRun: policy.maxCallsPerRun,
    maxConcurrentRequests: policy.maxConcurrentRequests,
    maxPacksPerRun: policy.maxPacksPerRun,
    maxPairsPerPack: policy.maxPairsPerPack,
    maxTasksPerPack: policy.maxTasksPerPack,
    maxRunElapsedMs: policy.maxRunElapsedMs,
    perAttemptElapsedMs: policy.perAttemptElapsedMs,
    perAttemptReservedInputTokens: policy.perAttemptReservedInputTokens,
    maxRunReservedInputTokens: policy.maxRunReservedInputTokens,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) fail("run-budget.invalid-policy", `Invalid ${name}`);
  }
  if (policy.perAttemptReservedInputTokens !== TOKEN_RESERVATION_PER_ATTEMPT ||
      policy.maxRunReservedInputTokens > MAX_RUN_RESERVED_INPUT_TOKENS ||
      policy.maxRunReservedInputTokens < policy.perAttemptReservedInputTokens ||
      policy.maxConcurrentRequests > policy.maxCallsPerRun) {
    fail("run-budget.invalid-policy", "Run budget policy exceeds the fixed reservation contract");
  }
  if (!input.packId || !isDigest(input.packSha256) || !isDigest(input.requestSha256)) {
    fail("run-budget.invalid-request", "Pack and request identities must be non-empty and SHA-256 bound");
  }
  if (!Number.isSafeInteger(input.pairCount) || input.pairCount < 1 ||
      input.pairCount > Math.min(policy.maxPairsPerPack, policy.maxTasksPerPack)) {
    fail("run-budget.pack-limit", "Pack exceeds the pilot pair/task limit");
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function ensureReservationDirectory(runDirectory: string): string {
  const path = join(runDirectory, "reservations");
  let created = false;
  try {
    mkdirSync(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("run-budget.invalid-artifact-root", "Reservation directory must be a real directory");
  if (created) fsyncDirectory(runDirectory);
  return path;
}

function durableCreate(path: string, content: Uint8Array): void {
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("run-budget.already-recorded", "Create-only reservation artifact already exists");
    throw error;
  }
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
}

function durableCreateOrMatch(path: string, content: Uint8Array): void {
  try {
    durableCreate(path, content);
  } catch (error) {
    if (!(error instanceof RunBudgetError) || error.code !== "run-budget.already-recorded") throw error;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("run-budget.policy-mismatch", "Existing run policy must be a regular file");
    if (!readFileSync(path).equals(Buffer.from(content))) fail("run-budget.policy-mismatch", "Existing run policy does not match this pilot");
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function lockOwner(path: string): { pid: number; token: string } | null {
  try {
    const match = /^(\d+):([a-f0-9-]+)\n$/.exec(readFileSync(path, "utf8"));
    if (!match) return null;
    return { pid: Number(match[1]), token: match[2] };
  } catch {
    return null;
  }
}
function reclaimStaleLock(path: string, directory: string, observed: { pid: number; token: string }): void {
  const guardPath = `${path}.reclaim`;
  const token = randomUUID();
  const owner = `${process.pid}:${token}\n`;
  let guard: number;
  try {
    guard = openSync(guardPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  try {
    writeFileSync(guard, owner, "utf8");
    fsyncSync(guard);
    const current = lockOwner(path);
    if (current?.pid === observed.pid && current.token === observed.token && !pidIsAlive(current.pid)) {
      unlinkSync(path);
      fsyncDirectory(directory);
    }
  } finally {
    closeSync(guard);
    if (readFileSync(guardPath, "utf8") === owner) {
      unlinkSync(guardPath);
      fsyncDirectory(directory);
    }
  }
}

async function withExclusiveLock<T>(directory: string, operation: () => T): Promise<T> {
  const path = join(directory, ".reservation.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = randomUUID();
  const owner = `${process.pid}:${token}\n`;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      writeFileSync(fd, owner, "utf8");
      fsyncSync(fd);
      fsyncDirectory(directory);
    } catch (error) {
      if (fd !== undefined) {
        closeSync(fd);
        fd = undefined;
        try { unlinkSync(path); fsyncDirectory(directory); } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
        }
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = lockOwner(path);
      if (current && !pidIsAlive(current.pid)) reclaimStaleLock(path, directory, current);
      if (Date.now() >= deadline) fail("run-budget.lock-busy", "Timed out waiting for the run reservation lock");
      const { promise, resolve: resume } = Promise.withResolvers<void>();
      setTimeout(resume, LOCK_RETRY_MS);
      await promise;
    }
  }

  try {
    return operation();
  } finally {
    closeSync(fd);
    const current = lockOwner(path);
    if (current?.pid === process.pid && current.token === token) {
      unlinkSync(path);
      fsyncDirectory(directory);
    }
  }
}

function parseJson(path: string): Record<string, unknown> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("run-budget.corrupt-ledger", "Reservation entries must be regular files");
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { return fail("run-budget.corrupt-ledger", "Reservation entry is not valid JSON"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail("run-budget.corrupt-ledger", "Reservation entry must be an object");
  return parsed as Record<string, unknown>;
}

type ReservationRecord = Readonly<{
  schema: typeof RESERVATION_SCHEMA;
  id: string;
  requestSha256: string;
  packId: string;
  packSha256: string;
  pairCount: number;
  reservedCalls: 1;
  reservedElapsedMs: number;
  reservedInputTokens: typeof TOKEN_RESERVATION_PER_ATTEMPT;
}>;

type Outcome = Readonly<{
  schema: typeof OUTCOME_SCHEMA;
  requestSha256: string;
  state: "recorded" | "failed";
  resultReference?: string;
  usage?: Readonly<{ inputTokens: number; outputTokens: number }> | null;
  failureCode?: string;
}>;

function readOutcome(directory: string, requestSha256: string): Outcome | null {
  const recordedPath = join(directory, `recorded-${requestSha256}.json`);
  const failedPath = join(directory, `failed-${requestSha256}.json`);
  const hasRecorded = existsSync(recordedPath);
  const hasFailed = existsSync(failedPath);
  if (hasRecorded && hasFailed) fail("run-budget.corrupt-ledger", "Request has conflicting terminal outcomes");
  if (!hasRecorded && !hasFailed) return null;
  const item = parseJson(hasRecorded ? recordedPath : failedPath);
  if (item.schema !== OUTCOME_SCHEMA || item.requestSha256 !== requestSha256 || item.state !== (hasRecorded ? "recorded" : "failed")) {
    fail("run-budget.corrupt-ledger", "Request outcome does not match its reservation");
  }
  return item as unknown as Outcome;
}

function readReservations(directory: string, policy: RunBudgetPolicy): ReservationRecord[] {
  const rows: ReservationRecord[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (name === ".reservation.lock" || name.startsWith("recorded-") || name.startsWith("failed-")) continue;
    if (!/^[a-f0-9]{64}\.json$/.test(name)) fail("run-budget.corrupt-ledger", "Unexpected entry in the reservation directory");
    const value = parseJson(join(directory, name));
    if (value.schema !== RESERVATION_SCHEMA || value.requestSha256 !== name.slice(0, -5) ||
        typeof value.id !== "string" || typeof value.packId !== "string" || !isDigest(String(value.packSha256)) ||
        !Number.isSafeInteger(value.pairCount) || value.reservedElapsedMs !== policy.perAttemptElapsedMs ||
        value.reservedCalls !== 1 || value.reservedInputTokens !== TOKEN_RESERVATION_PER_ATTEMPT) {
      fail("run-budget.corrupt-ledger", "Reservation entry is malformed");
    }
    rows.push(value as unknown as ReservationRecord);
  }
  return rows;
}

function assertPolicy(input: ReserveRunBudgetInput): string {
  const bytes = canonicalJsonBytes(input.policy);
  durableCreateOrMatch(join(input.runDirectory, "policy.json"), bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

async function settle(
  input: ReserveRunBudgetInput,
  directory: string,
  policySha256: string,
  outcome: Outcome,
  signal?: AbortSignal,
): Promise<void> {
  validateInput(input);
  await withExclusiveLock(directory, () => {
    const persistedPolicy = readFileSync(join(input.runDirectory, "policy.json"));
    if (createHash("sha256").update(persistedPolicy).digest("hex") !== policySha256) {
      fail("run-budget.policy-mismatch", "Run policy changed before reservation settlement");
    }
    const record = parseJson(join(directory, `${input.requestSha256}.json`)) as unknown as ReservationRecord;
    if (record.packId !== input.packId || record.packSha256 !== input.packSha256 || record.requestSha256 !== input.requestSha256) {
      fail("run-budget.request-mismatch", "Reservation identity changed before settlement");
    }
    if (readOutcome(directory, input.requestSha256)) fail("run-budget.already-settled", "Reservation already has a terminal outcome");
    if (signal?.aborted) fail("run-budget.operation-cancelled", "Cannot record a result after evaluation cancellation");
    const prefix = outcome.state === "recorded" ? "recorded" : "failed";
    durableCreate(join(directory, `${prefix}-${input.requestSha256}.json`), canonicalJsonBytes(outcome));
  });
}

export async function reserveRunBudget(input: ReserveRunBudgetInput): Promise<RunReservation | ReusedRunResult> {
  validateInput(input);
  const directory = ensureReservationDirectory(input.runDirectory);
  const reservation = await withExclusiveLock(directory, () => {
    const policySha256 = assertPolicy(input);
    const rows = readReservations(directory, input.policy);
    const currentPath = join(directory, `${input.requestSha256}.json`);
    if (existsSync(currentPath)) {
      const prior = parseJson(currentPath) as unknown as ReservationRecord;
      if (prior.packId !== input.packId || prior.packSha256 !== input.packSha256 || prior.pairCount !== input.pairCount) {
        fail("run-budget.request-mismatch", "Identical request bytes have a different pack identity");
      }
      const outcome = readOutcome(directory, input.requestSha256);
      if (outcome?.state === "recorded" && typeof outcome.resultReference === "string" && outcome.resultReference.length > 0) {
        return Object.freeze({
          kind: "reuse" as const,
          id: prior.id,
          requestSha256: input.requestSha256,
          resultReference: outcome.resultReference,
          usage: outcome.usage ?? null,
        });
      }
      if (outcome?.state === "failed") fail("run-budget.failed-request-not-retryable", "A failed request cannot be retried in this run");
      fail("run-budget.unknown-request-not-retryable", "An incomplete request reservation is conservatively spent");
    }

    if (rows.some((row) => row.packId === input.packId)) fail("run-budget.pack-already-reserved", "A pack may issue only one request per run");
    const packs = new Set(rows.map((row) => row.packId));
    if (rows.length >= input.policy.maxCallsPerRun) fail("run-budget.call-limit", "Run call limit is exhausted");
    if ((rows.length + 1) * input.policy.perAttemptReservedInputTokens > input.policy.maxRunReservedInputTokens) {
      fail("run-budget.token-limit", "Run token reservation limit would be exceeded");
    }
    if ((rows.length + 1) * input.policy.perAttemptElapsedMs > input.policy.maxRunElapsedMs) {
      fail("run-budget.elapsed-limit", "Run elapsed reservation limit would be exceeded");
    }
    if (packs.size >= input.policy.maxPacksPerRun) fail("run-budget.pack-limit", "Run pack limit is exhausted");
    let active = 0;
    for (const row of rows) if (readOutcome(directory, row.requestSha256) === null) active += 1;
    if (active >= input.policy.maxConcurrentRequests) fail("run-budget.concurrency-limit", "Run concurrency limit is exhausted by pending or unknown attempts");

    const value: ReservationRecord = Object.freeze({
      schema: RESERVATION_SCHEMA,
      id: randomUUID(),
      requestSha256: input.requestSha256,
      packId: input.packId,
      packSha256: input.packSha256,
      pairCount: input.pairCount,
      reservedCalls: 1,
      reservedElapsedMs: input.policy.perAttemptElapsedMs,
      reservedInputTokens: TOKEN_RESERVATION_PER_ATTEMPT,
    });
    durableCreate(currentPath, canonicalJsonBytes(value));
    return Object.freeze({ kind: "reserved" as const, value, policySha256 });
  });

  if (reservation.kind === "reuse") return reservation;
  const value = reservation.value;
  return Object.freeze({
    kind: "reserved" as const,
    id: value.id,
    requestSha256: value.requestSha256,
    complete: async (
      resultReference: string,
      usage: Readonly<{ inputTokens: number; outputTokens: number }> | null,
      signal?: AbortSignal,
    ) => {
      if (typeof resultReference !== "string" || resultReference.length === 0) fail("run-budget.invalid-result-reference", "Recorded result requires an artifact reference");
      if (usage !== null && (!Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens) ||
          usage.inputTokens < 0 || usage.outputTokens < 0 || usage.inputTokens > input.policy.perAttemptReservedInputTokens)) {
        fail("run-budget.usage-exceeds-reservation", "Observed provider usage exceeds its reserved input capacity");
      }
      await settle(input, directory, reservation.policySha256, Object.freeze({
        schema: OUTCOME_SCHEMA,
        requestSha256: value.requestSha256,
        state: "recorded",
        resultReference,
        usage,
      }), signal);
    },
    fail: async (code: string) => {
      if (!/^[a-z0-9][a-z0-9.-]{0,95}$/.test(code)) fail("run-budget.invalid-failure-code", "Failure code must be a stable identifier");
      await settle(input, directory, reservation.policySha256, Object.freeze({
        schema: OUTCOME_SCHEMA,
        requestSha256: value.requestSha256,
        state: "failed",
        failureCode: code,
      }));
    },
  });
}
