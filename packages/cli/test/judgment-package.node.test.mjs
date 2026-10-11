import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONTRACT_REVISION,
  NATIVE_ENDPOINT,
  NATIVE_MODEL,
  PACK_SCHEMA,
  PILOT_SCHEMA,
  TOKEN_POLICY_METHOD,
  TOKEN_RESERVATION_PER_ATTEMPT,
  buildA05Request,
  canonicalJsonBytes,
  evaluateNative,
  validatePack,
  validatePilot,
} from "../../judgment/dist/index.js";

const roots = [];
test.after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `judgment-package-${label}-`));
  roots.push(root);
  return root;
}


function judgmentFixture(runId = "run-1") {
  const hash = "a".repeat(64);
  const pack = validatePack({
    schema: PACK_SCHEMA,
    contractRevision: CONTRACT_REVISION,
    runId,
    packId: "pack-1",
    concernId: "concern-1",
    profile: "review",
    scope: { kind: "review", reviewId: "review-1", snapshotSha256: hash, diffSha256: hash, tier: "default" },
    recipient: { id: "synthesis-main", phase: "synthesis" },
    sources: [{ id: "source-1", path: "src/example.ts", startLine: 1, endLine: 4, contentSha256: hash, observedInRunId: runId, basis: "seat-observation" }],
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
    runId,
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

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}


test("native evaluator context reports missing credentials and provider failure without returning advice", async () => {
  const root = temporaryRoot("evaluator");
  const contextFor = (runId) => {
    const { pack, pilot, request } = judgmentFixture(runId);
    const runDirectory = join(root, "evidence", runId);
    mkdirSync(runDirectory, { recursive: true });
    return {
      request,
      context: (overrides = {}) => ({
        pilot,
        pack,
        runDirectory: realpathSync(runDirectory),
        isCurrent: () => true,
        readCredential: async () => "synthetic-test-key",
        writeSealedResult: async () => "sealed-result",
        readSealedResult: async () => { throw new Error("no reusable result expected"); },
        ...overrides,
      }),
    };
  };
  const missingKey = contextFor("run-1");
  const providerFailure = contextFor("run-2");
  await expectCode(evaluateNative(missingKey.request, missingKey.context({ readCredential: async () => "" }), new AbortController().signal), "jev.credential-unavailable");
  await expectCode(evaluateNative(providerFailure.request, providerFailure.context({ sendRequest: async () => { throw new Error("provider unavailable"); } }), new AbortController().signal), "jev.evaluation-failed");
});
