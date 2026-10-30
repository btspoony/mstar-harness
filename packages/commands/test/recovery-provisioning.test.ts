/**
 * `session.recover` automatic attestation provisioning (I-000297), driven
 * through the public `executeCommand` route: no `--attestation` succeeds and
 * records the generated document; an explicit file overrides it 1:1; the
 * caller cannot name itself as the prior holder it replaces.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommand, type InvocationContext } from "@mstar-harness/commands";
import {
  executionContextFor,
  initializeStore,
  openStore,
  readExecutionState,
  registerShippedCatalogExecution,
} from "@mstar-harness/engine";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const WORKFLOW = "wf-recover-provision";
const PLAN_ID = "recover-provision-plan";

function context(cwd: string, sessionId: string): InvocationContext {
  return {
    cwd,
    controlRoot: null,
    sessionId,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() {
        return "";
      },
      async spawn() {
        throw new Error("unused");
      },
      async startDashboard() {
        throw new Error("unused");
      },
      async openBrowser() {
        throw new Error("unused");
      },
    },
  };
}

/** One active store with one registered plan workflow and a recorded prior coordinator row. */
async function recoverableFixture(): Promise<{ root: string; harness: string; priorSession: string }> {
  const root = mkdtempSync(join(tmpdir(), "recover-provision-"));
  roots.push(root);
  const harness = join(root, ".mstar");
  mkdirSync(join(harness, "plans"), { recursive: true });
  writeFileSync(join(harness, "plans", `${PLAN_ID}.md`), `# Recover provision plan\n\n**plan_id:** ${PLAN_ID}\n`);
  (await initializeStore({ harnessDir: harness })).close();
  const workflow = {
    kind: "plan" as const,
    workflowId: WORKFLOW,
    options: {
      harnessDir: harness,
      plan: { id: PLAN_ID, title: "Recover provision plan", file: `plans/${PLAN_ID}.md` },
      deliveryKind: "development" as const,
      project: "_default",
      branchBase: "main",
      branchWork: `feature/${WORKFLOW}`,
      branchTarget: "main",
    },
  };
  await registerShippedCatalogExecution(
    executionContextFor({ harnessDir: harness }, { source: "local", sessionId: "registrar", workflowId: WORKFLOW, role: "coordinator" }, { allowUnsetSessionId: true }),
    { actor: "fixture", workflow },
  );
  const priorSession = "prior-holder";
  const epoch = (await readExecutionState({ harnessDir: harness })).epoch;
  const handle = await openStore({ harnessDir: harness }, "write");
  try {
    handle.db
      .prepare(
        "insert into execution_sessions(workflow_id, role, session_id, epoch, revision, state, bound_at) values (?, 'coordinator', ?, ?, 1, 'active', '2026-10-29T00:00:00.000Z')",
      )
      .run(WORKFLOW, priorSession, epoch);
  } finally {
    handle.close();
  }
  return { root, harness, priorSession };
}

/** The recorded recovery provenance of one operation, read from the immutable receipt. */
async function recordedRecovery(harness: string, operationId: string): Promise<Record<string, unknown>> {
  const store = await openStore({ harnessDir: harness }, "read");
  try {
    const row = store.db.prepare("select result_json from execution_operations where operation_id = ?").get(operationId) as
      | { result_json: string }
      | undefined;
    if (row === undefined) throw new Error(`no operation receipt for ${operationId}`);
    return (JSON.parse(row.result_json) as { recovery?: Record<string, unknown> }).recovery ?? {};
  } finally {
    store.close();
  }
}

describe("session.recover generates its operator document when --attestation is omitted", () => {
  test("a recovery with no --attestation succeeds and records the generated facts", async () => {
    const { root, harness, priorSession } = await recoverableFixture();
    const result = await executeCommand(
      "session.recover",
      {
        workflow: WORKFLOW,
        priorSession,
        reason: "prior coordinator stopped",
        operation: "op-recover-generated",
        harness,
      },
      context(root, "replacement-session"),
    );
    expect(result.status === "ok" ? undefined : JSON.stringify(result)).toBeUndefined();
    // The envelope carries the receipt; the receipt's own data is the bound session.
    expect((result.data as { data: Record<string, unknown> }).data).toMatchObject({
      workflowId: WORKFLOW,
      sessionId: "replacement-session",
    });
    // The prior holder was LIVE when attested stopped: the narrowed
    // provenance warning survives generation unchanged.
    expect((result.data as Record<string, unknown>)).toMatchObject({
      replayed: false,
      holder_live_warning: { code: "recovery.holder-live", holder: priorSession },
    });
    const recovery = await recordedRecovery(harness, "op-recover-generated");
    // The generated document's facts: the caller is the operator, the replay
    // id is the durable authorizationRef, and the stop names the prior holder.
    expect(recovery).toMatchObject({
      operator: { actor: "replacement-session", authorizationRef: "op-recover-generated" },
      stopped_sessions: [priorSession],
    });
    expect(typeof recovery.attested_at).toBe("string");
  });

  test("an explicit --attestation file overrides the generated document 1:1", async () => {
    const { root, harness, priorSession } = await recoverableFixture();
    const attestationPath = join(root, "override-attestation.json");
    writeFileSync(
      attestationPath,
      JSON.stringify({
        version: 1,
        attestedAt: "2026-10-04T04:00:00Z",
        operator: { actor: "file-operator", authorizationRef: "file-authorization" },
        consumers: [],
        stoppedSessions: [{ sessionId: priorSession, host: "local", state: "stopped" }],
      }),
    );
    const bytes = readFileSync(attestationPath);
    const result = await executeCommand(
      "session.recover",
      {
        workflow: WORKFLOW,
        priorSession,
        reason: "prior coordinator stopped",
        operation: "op-recover-file",
        harness,
        attestation: attestationPath,
      },
      context(root, "replacement-session"),
    );
    expect(result.status === "ok" ? undefined : JSON.stringify(result)).toBeUndefined();
    // The receipt records the FILE's operator, not the caller session.
    const recovery = await recordedRecovery(harness, "op-recover-file");
    expect(recovery).toMatchObject({ operator: { actor: "file-operator", authorizationRef: "file-authorization" } });
    // The override file was consumed, never rewritten.
    expect(readFileSync(attestationPath)).toEqual(bytes);
  });

  test("the caller cannot name itself as the prior holder it replaces", async () => {
    const { root, harness, priorSession } = await recoverableFixture();
    const result = await executeCommand(
      "session.recover",
      {
        workflow: WORKFLOW,
        priorSession,
        reason: "self-replacement",
        operation: "op-recover-self",
        harness,
      },
      context(root, priorSession),
    );
    expect(result).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    if (result.status === "ok") throw new Error("expected a usage refusal");
    const diagnostics = result.details?.diagnostics as Readonly<Record<string, unknown>>[];
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ path: "priorSession", message: expect.stringContaining("the caller names itself as the prior holder") }),
    );
  });
});
