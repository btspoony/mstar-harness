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
 * suites — this file proves the CLI admits, refuses and forwards.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { WORKFLOW_SNAPSHOT_FILE, initializeStore } from "@mstar-harness/engine";
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
  snapshot.integration_merge_lease = {
    holder: PRIOR_HOLDER,
    claimed_at: claimHolderAt,
    source_branch: `feature/${PLAN_ID}`,
    target_branch: "main",
  };
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
    // WITHOUT the operator document the engine refuses and names the stop
    // attestation it needs; nothing about the held claim moves.
    const refused = await executeCommand("workflow.recover-coordinator", recoveryInput(fixture), invocation(fixture.root));
    expect(refused.status).toBe("refused");
    expect(String(refused.message)).toContain("stop attestation");
    const before = JSON.parse(readFileSync(fixture.snapshotPath, "utf8")) as Record<string, unknown>;
    expect(before.integration_merge_lease).toMatchObject({ holder: PRIOR_HOLDER });
    expect(existsSync(join(fixture.harness, "workflows", WORKFLOW_ID, "sessions", `coordinator-${CALLER_SESSION}.json`))).toBe(false);

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
    const after = JSON.parse(readFileSync(fixture.snapshotPath, "utf8")) as {
      integration_merge_lease?: unknown;
      coordination?: {
        coordinator?: { session_id?: string; session_file?: string };
        identity_recoveries?: Array<{ stopped_session_ids?: string[]; prior_session_id?: string }>;
      };
    };
    expect(after.integration_merge_lease).toBeUndefined();
    expect(after.coordination?.coordinator?.session_id).toBe(CALLER_SESSION);
    expect(existsSync(join(fixture.harness, "workflows", WORKFLOW_ID, "sessions", `coordinator-${CALLER_SESSION}.json`))).toBe(true);
    const recovery = (after.coordination?.identity_recoveries ?? []).find((entry) => entry.prior_session_id === PRIOR_HOLDER);
    expect(recovery?.stopped_session_ids).toContain(PRIOR_HOLDER);
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
    expect(String(refused.message)).toContain("authorization");
    expect((refused.details as { field?: string } | undefined)?.field).toBe("attestation.operator.authorizationRef");
    // The refusal wrote nothing: the held claim and the binding are unchanged.
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(before);
    expect(existsSync(join(fixture.harness, "workflows", WORKFLOW_ID, "sessions", `coordinator-${CALLER_SESSION}.json`))).toBe(false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a relative attestation path is a usage error naming the field, and an absent absolute file is refused", async () => {
  const fixture = await boundRecoveryFixture();
  try {
    // The adapter's absolute-path boundary names the field without a flag
    // prefix; the document is never read from a relative value.
    const usage = await executeCommand(
      "workflow.recover-coordinator",
      recoveryInput(fixture, "attestation.json"),
      invocation(fixture.root),
    );
    expect(usage.status).toBe("usage");
    expect(String(usage.message)).toContain("attestation must be an absolute path");

    // A genuinely absent absolute document is an engine-surfaced refusal, not
    // a usage error: the path is admitted and the read fails.
    const absent = await executeCommand(
      "workflow.recover-coordinator",
      recoveryInput(fixture, join(fixture.root, "absent", "attestation.json")),
      invocation(fixture.root),
    );
    expect(absent.status).toBe("refused");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
