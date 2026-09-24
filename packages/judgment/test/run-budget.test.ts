import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  reserveRunBudget,
  type ReserveRunBudgetInput,
  type RunBudgetPolicy,
} from "../src/run-budget.js";

const temporaryRoots: string[] = [];
const digest = (letter: string) => letter.repeat(64);

function createRunDirectory(runId = "run-1"): string {
  const root = mkdtempSync(join(tmpdir(), "judgment-run-budget-"));
  temporaryRoots.push(root);
  const evidence = join(root, "evidence");
  const runDirectory = join(evidence, runId);
  mkdirSync(runDirectory, { recursive: true });
  return realpathSync(runDirectory);
}

function policy(maxCallsPerRun = 1): RunBudgetPolicy {
  return Object.freeze({
    schema: "mstar.judgment.run-budget/v1",
    runId: "run-1",
    pilotId: "pilot-1",
    pilotSha256: digest("a"),
    policyVersion: "policy-1",
    maxCallsPerRun,
    maxConcurrentRequests: 1,
    maxPacksPerRun: maxCallsPerRun,
    maxPairsPerPack: 4,
    maxTasksPerPack: 4,
    maxRunElapsedMs: maxCallsPerRun * 10_000,
    perAttemptElapsedMs: 10_000,
    perAttemptReservedInputTokens: 65_536,
    maxRunReservedInputTokens: maxCallsPerRun * 65_536,
  });
}

function input(runDirectory: string, requestLetter: string, packId = `pack-${requestLetter}`): ReserveRunBudgetInput {
  return Object.freeze({
    runDirectory,
    policy: policy(),
    packId,
    packSha256: digest("b"),
    requestSha256: digest(requestLetter),
    pairCount: 1,
  });
}

async function spawnReservation(inputValue: ReserveRunBudgetInput, crashAfterReserve = false): Promise<{ output: string; exitCode: number }> {
  const moduleUrl = pathToFileURL(join(import.meta.dir, "../src/run-budget.ts")).href;
  const script = `
    import { reserveRunBudget } from ${JSON.stringify(moduleUrl)};
    try {
      const reservation = await reserveRunBudget(${JSON.stringify(inputValue)});
      process.stdout.write(reservation.kind);
      if (${crashAfterReserve}) process.exitCode = 70;
    } catch (error) {
      process.stdout.write(error.code || "unexpected-error");
      process.exitCode = 1;
    }
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [output, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (stderr !== "") throw new Error(stderr);
  return { output, exitCode };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable per-run reservations", () => {
  test("concurrent child processes cannot overspend the shared call cap", async () => {
    const runDirectory = createRunDirectory();
    const results = await Promise.all([
      spawnReservation(input(runDirectory, "c")),
      spawnReservation(input(runDirectory, "d")),
    ]);

    expect(results.filter((result) => result.output === "reserved")).toHaveLength(1);
    expect(results.filter((result) => result.output !== "reserved")).toHaveLength(1);
    expect(readdirSync(join(runDirectory, "reservations")).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))).toHaveLength(1);
  });

  test("simultaneous contenders serialize reclamation of a stale lock generation", async () => {
    const runDirectory = createRunDirectory();
    const reservationDirectory = join(runDirectory, "reservations");
    mkdirSync(reservationDirectory);
    writeFileSync(join(reservationDirectory, ".reservation.lock"), "99999999:deadbeef-0000\n");
    const results = await Promise.all([
      spawnReservation(input(runDirectory, "a")),
      spawnReservation(input(runDirectory, "b")),
    ]);
    expect(results.filter((result) => result.output === "reserved")).toHaveLength(1);
    expect(readdirSync(reservationDirectory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))).toHaveLength(1);
  });

  test("a reservation left by a crashed process remains spent and cannot be retried", async () => {
    const runDirectory = createRunDirectory();
    const first = await spawnReservation(input(runDirectory, "e"), true);
    expect(first).toEqual({ output: "reserved", exitCode: 70 });

    await expect(reserveRunBudget(input(runDirectory, "e"))).rejects.toMatchObject({ code: "run-budget.unknown-request-not-retryable" });
    await expect(reserveRunBudget(input(runDirectory, "f"))).rejects.toMatchObject({ code: "run-budget.call-limit" });
  });

  test("a successful same-run request reuses the original result and usage without reserving again", async () => {
    const runDirectory = createRunDirectory();
    const request = input(runDirectory, "1");
    const reservation = await reserveRunBudget(request);
    expect(reservation.kind).toBe("reserved");
    if (reservation.kind !== "reserved") throw new Error("Expected a new reservation");
    await reservation.complete("results/result-1.json", { inputTokens: 320, outputTokens: 40 });

    const reused = await reserveRunBudget(request);
    expect(reused).toEqual({
      kind: "reuse",
      id: reservation.id,
      requestSha256: request.requestSha256,
      resultReference: "results/result-1.json",
      usage: { inputTokens: 320, outputTokens: 40 },
    });
    expect(readdirSync(join(runDirectory, "reservations")).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))).toHaveLength(1);
  });

  test("rejects symlinked evidence roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "judgment-run-budget-link-"));
    temporaryRoots.push(root);
    const backing = join(root, "backing");
    mkdirSync(join(backing, "run-1"), { recursive: true });
    symlinkSync(backing, join(root, "evidence"));

    await expect(reserveRunBudget(input(join(root, "evidence", "run-1"), "8")))
      .rejects.toMatchObject({ code: "run-budget.invalid-artifact-root" });
  });

  test("an aborted result commit remains unknown and cannot be reused as recorded", async () => {
    const runDirectory = createRunDirectory();
    const request = input(runDirectory, "3");
    const reservation = await reserveRunBudget(request);
    if (reservation.kind !== "reserved") throw new Error("Expected a new reservation");
    const controller = new AbortController();
    controller.abort();

    await expect(reservation.complete("results/result-3.json", null, controller.signal))
      .rejects.toMatchObject({ code: "run-budget.operation-cancelled" });
    await expect(reserveRunBudget(request))
      .rejects.toMatchObject({ code: "run-budget.unknown-request-not-retryable" });
  });

  test("a known failed request and a changed pilot policy are never retried as fresh capacity", async () => {
    const runDirectory = createRunDirectory();
    const request = input(runDirectory, "2");
    const reservation = await reserveRunBudget(request);
    if (reservation.kind !== "reserved") throw new Error("Expected a new reservation");
    await reservation.fail("jev.transport-failed");
    await expect(reserveRunBudget(request)).rejects.toMatchObject({ code: "run-budget.failed-request-not-retryable" });

    const changedPolicy = Object.freeze({ ...request.policy, pilotId: "pilot-2", pilotSha256: digest("f") });
    await expect(reserveRunBudget(Object.freeze({ ...input(runDirectory, "3"), policy: changedPolicy })))
      .rejects.toMatchObject({ code: "run-budget.policy-mismatch" });
  });
});
