/**
 * CLI `workflow recover-coordinator` — the FILE-route recovery consumer
 * regression over the supported registered/bound workflow fixture.
 *
 * The fixture establishes the ordinary prerequisites through the real
 * producers — initialized store, registered status entry, locked compass, plan
 * documents, integration worktree, phase-1 snapshot and a REAL `plan bind
 * --coordinator` recorded binding — then plants the workflow's held
 * integration-merge claim the way the engine's own prepare-recovery suite
 * does. Recovery is then exercised twice against that ONE fixture:
 *
 * - without the operator stop document the engine refuses, naming the stop
 *   attestation it needs, and nothing moves;
 * - the SAME fixture retries with the correct full document (naming the exact
 *   recorded prior holder stopped after its claim, operator authorization
 *   matching) and succeeds: the replacement binding is recorded, the audit
 *   names the prior holder, and the held claim is gone.
 *
 * The operator stop attestation is the trust boundary (the engine validates
 * the document and performs the authority discrimination; the CLI only reads
 * the absolute JSON file and passes it through). The deeper engine matrix
 * (exact identity/time bounds, schema-8 cutover orphans) stays with the engine
 * suites — this file proves the public refusal, nonmutation and supported retry.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { WORKFLOW_SNAPSHOT_FILE, initializeStore, type IntegrationMergeLease } from "@mstar-harness/engine";
import { executeCommand } from "../definitions.js";
import type { InvocationContext } from "../types.js";

const WORKFLOW_ID = "wf-recovery-fixture";
const PLAN_ID = "plan-recovery";
const PRIOR_HOLDER = "prior-coordinator-session";
const CALLER_SESSION = "caller-recovery-session";
const INTEGRATION_BRANCH = "integration/wf-recovery-fixture";
const AUTHORIZATION_REF = "PM-authorization-fixture";

const roots: string[] = [];

/** One temp Git workspace with the ordinary prerequisites and a REAL binding. */
async function boundRecoveryFixture(): Promise<{
  root: string;
  harness: string;
  priorEnvelope: string;
  snapshotPath: string;
  claimHolderAt: string;
}> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-recover-coordinator-")));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  const harness = join(root, ".mstar");
  const workflowDir = join(harness, "workflows", WORKFLOW_ID);
  const snapshotPath = join(workflowDir, WORKFLOW_SNAPSHOT_FILE);
  const integrationPath = join(root, "wt-integration");
  const claimHolderAt = "2026-09-30T00:00:00.000Z";

  // The ordinary FILE prerequisites: locked compass, plan documents, the
  // integration worktree the policy names, and the registered status entry.
  mkdirSync(join(harness, "plans"), { recursive: true });
  mkdirSync(join(workflowDir, "sessions"), { recursive: true });
  mkdirSync(join(harness, "iterations", WORKFLOW_ID), { recursive: true });
  writeFileSync(join(harness, "plans", `${PLAN_ID}.md`), `# ${PLAN_ID}\n\n**plan_id:** ${PLAN_ID}\n`);
  writeFileSync(join(harness, "iterations", WORKFLOW_ID, "delivery-compass.md"), [
    "---",
    `iteration_id: ${WORKFLOW_ID}`,
    "status: locked",
    "iteration_base_branch: main",
    `spec_integration_branch: ${INTEGRATION_BRANCH}`,
    "target_branch: main",
    `plans:\n  - ${PLAN_ID}`,
    "---",
    "",
    "# Compass",
    "",
  ].join("\n"));
  execFileSync("git", ["worktree", "add", "-q", "-b", INTEGRATION_BRANCH, integrationPath], { cwd: root });
  writeFileSync(join(harness, "status.json"), JSON.stringify({
    version: 2,
    updated_at: "2026-09-30T00:00:00.000Z",
    workflows: [{ id: WORKFLOW_ID, status: "running", type: "plan", started_at: claimHolderAt, dir: `workflows/${WORKFLOW_ID}` }],
  }));
  writeFileSync(snapshotPath, JSON.stringify({
    schema_version: 1,
    id: WORKFLOW_ID,
    type: "plan",
    status: "running",
    phase: "phase-1-prepare",
    started_at: claimHolderAt,
    updated_at: claimHolderAt,
    compass_ref: `iterations/${WORKFLOW_ID}/delivery-compass.md`,
    branch: { base: "main", integration: INTEGRATION_BRANCH, target: "main" },
    integration_worktree_path: integrationPath,
    execution_policy: { plan_parallelism: "serial", worktree_mode: "required" },
    plans: [{ id: PLAN_ID, title: PLAN_ID, file: `plans/${PLAN_ID}.md`, status: "Todo" }],
  }, null, 2));

  // The issue store is a prerequisite of the workspace, not of this verb.
  const store = await initializeStore({ harnessDir: harness });
  store.close();

  // The REAL producer: `plan bind --coordinator` records the predecessor's
  // binding and writes its coordinator envelope.
  const bound = await executeCommand("plan.bind", {
    coordinator: true,
    workflow: WORKFLOW_ID,
    sessionId: PRIOR_HOLDER,
    json: true,
  }, invocation(root));
  if (bound.status !== "ok") throw new Error(`fixture bind failed: ${bound.message}`);

  // The workflow's held integration-merge claim, planted the way the engine's
  // own prepare-recovery suite does: the recorded predecessor is its holder.
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
  const claim: IntegrationMergeLease = {
    holder: PRIOR_HOLDER,
    plan_id: PLAN_ID,
    claimed_at: claimHolderAt,
    source_branch: `feature/${PLAN_ID}`,
    target_branch: "main",
  };
  snapshot.integration_merge_lease = claim;
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

  return { root, harness, priorEnvelope: join(workflowDir, "sessions", `coordinator-${PRIOR_HOLDER}.json`), snapshotPath, claimHolderAt };
}

function invocation(cwd: string): InvocationContext {
  return {
    cwd,
    controlRoot: null,
    sessionId: CALLER_SESSION,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { return { exitCode: 1, signal: null, stdout: "", stderr: "" }; },
      async startDashboard() { throw new Error("not available in this command family"); },
      async openBrowser() { throw new Error("not available in this command family"); },
    },
  };
}

function recoveryInput(fixture: { priorEnvelope: string; harness: string }, attestation?: string) {
  return {
    session: fixture.priorEnvelope,
    operationId: "recover-1",
    reason: "the recorded coordinator stopped holding a merge claim",
    authorizationRef: AUTHORIZATION_REF,
    stopped: [PRIOR_HOLDER],
    harness: fixture.harness,
    ...(attestation === undefined ? {} : { attestation }),
  };
}

/** The operator stop document naming the exact prior holder, attested after its claim. */
function writeAttestation(fixture: { root: string; claimHolderAt: string }, overrides: Record<string, unknown> = {}): string {
  const path = join(fixture.root, "attestation.json");
  writeFileSync(path, JSON.stringify({
    version: 1,
    attestedAt: "2026-10-01T00:00:00.000Z",
    operator: { actor: "fixture-operator", authorizationRef: AUTHORIZATION_REF },
    consumers: [{
      entryId: "mstar-cli",
      kind: "coordinator",
      entrypoint: "packages/cli/src/index.ts",
      runtime: "bun",
      runtimeVersion: "1.4.0",
      version: "0.0.0-test",
      current: true,
      disposition: "reloaded",
    }],
    stoppedSessions: [{ sessionId: PRIOR_HOLDER, host: "omp", state: "stopped" }],
    ...overrides,
  }, null, 2));
  return path;
}

test("the same bound fixture refuses recovery without the operator document and settles with it", async () => {
  const fixture = await boundRecoveryFixture();
  try {
    const beforeBytes = readFileSync(fixture.snapshotPath);
    const before = JSON.parse(beforeBytes.toString("utf8")) as Record<string, unknown>;
    const protectedPaths = [
      join(fixture.harness, "status.json"),
      join(fixture.harness, "iterations", WORKFLOW_ID, "delivery-compass.md"),
      join(fixture.harness, "plans", `${PLAN_ID}.md`),
      fixture.priorEnvelope,
    ];
    const protectedBytes = protectedPaths.map((path) => readFileSync(path));
    const registeredCheckouts = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: fixture.root }).toString();
    const replacementEnvelope = join(fixture.harness, "workflows", WORKFLOW_ID, "sessions", `coordinator-${CALLER_SESSION}.json`);

    // The refused attempt preserves the entire snapshot, including business
    // rows, branch/checkout registration, prior binding and held claim.
    const refused = await executeCommand("workflow.recover-coordinator", recoveryInput(fixture), invocation(fixture.root));
    expect(refused).toMatchObject({
      status: "refused",
      code: "coordination.identity-recovery.unauthorized",
      exitCode: 1,
      details: { holder: PRIOR_HOLDER, claimed_at: fixture.claimHolderAt, attested_at: null },
    });
    expect(readFileSync(fixture.snapshotPath)).toEqual(beforeBytes);
    for (const [index, path] of protectedPaths.entries()) {
      expect(readFileSync(path)).toEqual(protectedBytes[index]);
    }
    expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: fixture.root }).toString()).toBe(registeredCheckouts);
    expect(existsSync(replacementEnvelope)).toBe(false);

    // The SAME fixture retries with the correct full document and succeeds.
    const attestationPath = writeAttestation(fixture);
    const result = await executeCommand(
      "workflow.recover-coordinator",
      recoveryInput(fixture, attestationPath),
      invocation(fixture.root),
    );
    expect(result.status, result.status !== "ok" ? JSON.stringify(result) : "").toBe("ok");

    // Authoritative readback: the replacement binding is recorded, the audit
    // names the prior holder, and the held claim is gone.
    const after = JSON.parse(readFileSync(fixture.snapshotPath, "utf8")) as Record<string, unknown> & {
      integration_merge_lease?: unknown;
      coordination?: {
        coordinator?: { session_id?: string; session_file?: string };
        identity_recoveries?: Array<{ stopped_session_ids?: string[]; prior_session_id?: string }>;
      };
    };
    expect(after.integration_merge_lease).toBeUndefined();
    expect(after.coordination?.coordinator?.session_id).toBe(CALLER_SESSION);
    expect(after.coordination?.coordinator?.session_file).toBe(replacementEnvelope);
    expect(JSON.parse(readFileSync(replacementEnvelope, "utf8"))).toMatchObject({
      role: "coordinator", workflow_id: WORKFLOW_ID, session_id: CALLER_SESSION, harness_root: fixture.harness,
    });
    const beforeCoordination = before.coordination as NonNullable<typeof after.coordination>;
    const priorAudit = beforeCoordination.identity_recoveries ?? [];
    const audit = after.coordination?.identity_recoveries ?? [];
    expect(audit.slice(0, priorAudit.length)).toEqual(priorAudit);
    expect(audit).toHaveLength(priorAudit.length + 1);
    expect(audit[priorAudit.length]).toMatchObject({
      operation_id: "recover-1", workflow_id: WORKFLOW_ID,
      prior_session_id: PRIOR_HOLDER, session_id: CALLER_SESSION,
      authorization_ref: AUTHORIZATION_REF, stopped_session_ids: [PRIOR_HOLDER],
      attested_at: "2026-10-01T00:00:00.000Z",
    });

    // Only recovery-owned timestamp/binding/audit/claim fields may change.
    // Compare every remaining business field to the actual pre-refusal baseline.
    const businessBefore = { ...before };
    const businessAfter = { ...after };
    for (const field of ["updated_at", "coordination", "integration_merge_lease"]) {
      delete businessBefore[field];
      delete businessAfter[field];
    }
    expect(businessAfter).toEqual(businessBefore);
    const coordinationBefore = { ...beforeCoordination };
    const coordinationAfter = { ...after.coordination };
    delete coordinationBefore.coordinator;
    delete coordinationBefore.identity_recoveries;
    delete coordinationAfter.coordinator;
    delete coordinationAfter.identity_recoveries;
    expect(coordinationAfter).toEqual(coordinationBefore);
    for (const [index, path] of protectedPaths.entries()) {
      expect(readFileSync(path)).toEqual(protectedBytes[index]);
    }
    expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: fixture.root }).toString()).toBe(registeredCheckouts);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an operator authorization mismatch refuses with its specific cause on the valid fixture", async () => {
  const fixture = await boundRecoveryFixture();
  try {
    // The document's operator authorization does not match the request's
    // authorizationRef: the engine refuses with the field named.
    const mismatched = writeAttestation(fixture, {
      operator: { actor: "fixture-operator", authorizationRef: "other-authorization" },
    });
    const before = readFileSync(fixture.snapshotPath, "utf8");
    const refused = await executeCommand(
      "workflow.recover-coordinator",
      recoveryInput(fixture, mismatched),
      invocation(fixture.root),
    );
    expect(refused.status).toBe("refused");
    if (refused.status !== "refused") throw new Error("expected the operator authorization refusal");
    expect(String(refused.message)).toContain("authorization");
    expect(refused.details).toMatchObject({ field: "attestation.operator.authorizationRef" });
    // The refusal wrote nothing: the held claim and the binding are unchanged.
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(before);
    expect(existsSync(join(fixture.harness, "workflows", WORKFLOW_ID, "sessions", `coordinator-${CALLER_SESSION}.json`))).toBe(false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("relative and absent absolute attestation inputs preserve the bound fixture at their public error boundaries", async () => {
  const fixture = await boundRecoveryFixture();
  try {
    const before = readFileSync(fixture.snapshotPath);
    // A relative document is caller input, not a filesystem read.
    const usage = await executeCommand(
      "workflow.recover-coordinator",
      recoveryInput(fixture, "attestation.json"),
      invocation(fixture.root),
    );
    expect(usage).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(readFileSync(fixture.snapshotPath)).toEqual(before);

    // A genuinely absent absolute document is an engine-surfaced refusal, not
    // a usage error: the path is admitted and the read fails.
    const absent = await executeCommand(
      "workflow.recover-coordinator",
      recoveryInput(fixture, join(fixture.root, "absent", "attestation.json")),
      invocation(fixture.root),
    );
    expect(absent).toMatchObject({ status: "refused", code: "ENOENT", exitCode: 1 });
    expect(readFileSync(fixture.snapshotPath)).toEqual(before);
    expect(existsSync(join(fixture.harness, "workflows", WORKFLOW_ID, "sessions", `coordinator-${CALLER_SESSION}.json`))).toBe(false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
