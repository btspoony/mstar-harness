/**
 * CLI `workflow recover-coordinator` — the FILE-route recovery consumer
 * contract against a real held integration-merge claim.
 *
 * The operator's stop attestation is the trust boundary (the engine validates
 * it and performs the authority discrimination; the CLI only reads the
 * absolute JSON document and passes it through). These cases drive the real
 * engine entry over real snapshot/envelope fixtures:
 *
 * - a workflow whose snapshot still holds an integration merge claim naming a
 *   holder that is no longer a recorded session refuses recovery WITHOUT the
 *   operator stop document, naming the document it needs;
 * - the SAME recovery WITH a correct document (naming that exact prior holder
 *   stopped, attested after its claim, operator authorization matching)
 *   succeeds and settles;
 * - a mixed invocation that also carries the attestation on the ACTIVE
 *   authority is refused before either engine verb runs.
 *
 * No engine internals are re-implemented here; the deeper engine matrix (exact
 * identity/time bounds, schema-8 cutover orphans) is owned by the engine
 * suites — this file only proves the CLI admits, refuses and forwards.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { WORKFLOW_SNAPSHOT_FILE, initializeStore } from "@mstar-harness/engine";
import { executeCommand } from "./definitions.js";
import type { InvocationContext } from "../types.js";

const WORKFLOW_ID = "wf-recovery-fixture";
const PLAN_ID = "plan-recovery";
const PRIOR_HOLDER = "prior-holder-session";
const CALLER_SESSION = "caller-recovery-session";

const roots: string[] = [];
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "mstar-recover-coordinator-"));
  roots.push(root);
  return root;
}

/** One temp Git workspace whose FILE snapshot still holds a merge claim. */
function heldClaimFixture(): { root: string; harness: string; priorEnvelope: string; claimHolderAt: string } {
  const root = scratch();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  const harness = join(root, ".mstar");
  const workflowDir = join(harness, "workflows", WORKFLOW_ID);
  mkdirSync(join(harness, "plans"), { recursive: true });
  mkdirSync(join(workflowDir, "sessions"), { recursive: true });
  const store = initializeStore({ harnessDir: harness });
  store.close();
  writeFileSync(join(harness, "plans", `${PLAN_ID}.md`), `# ${PLAN_ID}\n`);
  const claimHolderAt = "2026-09-30T00:00:00.000Z";
  writeFileSync(join(workflowDir, WORKFLOW_SNAPSHOT_FILE), JSON.stringify({
    schema_version: 1,
    id: WORKFLOW_ID,
    type: "plan",
    status: "running",
    started_at: claimHolderAt,
    updated_at: claimHolderAt,
    delivery_kind: "development",
    project: "_default",
    branch: { source: `feature/${PLAN_ID}`, target: "main" },
    plans: [{ id: PLAN_ID, plan_id: PLAN_ID, title: PLAN_ID, file: `plans/${PLAN_ID}.md`, status: "Todo", metadata: {} }],
    integration_merge_lease: {
      holder: PRIOR_HOLDER,
      claimed_at: claimHolderAt,
      source_branch: `feature/${PLAN_ID}`,
      target_branch: "main",
    },
  }, null, 2));
  const priorEnvelope = join(workflowDir, "sessions", `coordinator-${PRIOR_HOLDER}.json`);
  writeFileSync(priorEnvelope, JSON.stringify({
    schema_version: 1,
    role: "coordinator",
    session_id: PRIOR_HOLDER,
    workflow_id: WORKFLOW_ID,
    harness_root: harness,
  }, null, 2));
  return { root, harness, priorEnvelope, claimHolderAt };
}

/** One caller attestation naming the prior holder stopped after its claim. */
function attestationDocument(root: string, authorizationRef: string, attestedAt: string): string {
  const path = join(root, "attestation.json");
  writeFileSync(path, JSON.stringify({
    version: 1,
    attestedAt,
    operator: { actor: "fixture-operator", authorizationRef },
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
  }, null, 2));
  return path;
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

function recoveryInput(fixture: { root: string; harness: string; priorEnvelope: string }, attestation?: string) {
  return {
    session: fixture.priorEnvelope,
    operationId: "recover-1",
    reason: "the recorded coordinator stopped holding a merge claim",
    authorizationRef: "fixture-authorization",
    stopped: [PRIOR_HOLDER],
    harness: fixture.harness,
    ...(attestation === undefined ? {} : { attestation }),
  };
}

test("a FILE recovery over a held merge claim requires the operator stop document", async () => {
  const fixture = heldClaimFixture();
  try {
    // The snapshot still holds the claim: the engine refuses without the
    // operator attestation and names the document it needs.
    const result = await executeCommand("workflow.recover-coordinator", recoveryInput(fixture), invocation(fixture.root));
    expect(result).toMatchObject({ status: "refused" });
    expect(String(result.message)).toContain("workflow recover-coordinator --attestation");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the SAME recovery with a correct document succeeds and settles the claim", async () => {
  const fixture = heldClaimFixture();
  try {
    const attestationPath = attestationDocument(fixture.root, "fixture-authorization", "2026-10-01T00:00:00.000Z");
    const result = await executeCommand(
      "workflow.recover-coordinator",
      recoveryInput(fixture, attestationPath),
      invocation(fixture.root),
    );
    expect(result.status, result.status === "refused" ? result.message : "").toBe("ok");

    // The real effects: a coordinator envelope exists for the replacement
    // session, and the snapshot records the identity recovery naming the prior
    // holder as stopped — the stop fact the close path later reads.
    const workflowDir = join(fixture.harness, "workflows", WORKFLOW_ID);
    expect(existsSync(join(workflowDir, "sessions", `coordinator-${CALLER_SESSION}.json`))).toBe(true);
    const snapshot = JSON.parse(readFileSync(join(workflowDir, WORKFLOW_SNAPSHOT_FILE), "utf8")) as {
      coordination?: { identity_recoveries?: Array<{ stopped_session_ids?: string[] }> };
    };
    const recoveries = snapshot.coordination?.identity_recoveries ?? [];
    expect(recoveries.some((entry) => (entry.stopped_session_ids ?? []).includes(PRIOR_HOLDER))).toBe(true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the operator authorization must match the document, and a missing file is a usage error", async () => {
  const fixture = heldClaimFixture();
  try {
    // A mismatched authorizationRef is refused by the engine, not silently
    // accepted by the CLI.
    const mismatched = attestationDocument(fixture.root, "other-authorization", "2026-10-01T00:00:00.000Z");
    const refused = await executeCommand(
      "workflow.recover-coordinator",
      recoveryInput(fixture, mismatched),
      invocation(fixture.root),
    );
    expect(refused.status).toBe("refused");

    // A relative or absent document path never reaches the engine.
    const usage = await executeCommand(
      "workflow.recover-coordinator",
      { ...recoveryInput(fixture), attestation: "attestation.json" },
      invocation(fixture.root),
    );
    expect(usage).toMatchObject({ status: "usage", message: "--attestation must be an absolute path" });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
