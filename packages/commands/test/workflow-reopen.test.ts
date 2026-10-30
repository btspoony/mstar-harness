import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStore, openStore, readExecutionState } from "@mstar-harness/engine";
import { getCommandDefinitions } from "../src/index.js";
import type { InvocationContext } from "../src/types.js";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const WORKFLOW_ID = "wf-reopen-command";

function definition(id: string) {
  const found = getCommandDefinitions().find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing command definition: ${id}`);
  return found;
}

function invocation(cwd: string): InvocationContext {
  return {
    cwd, controlRoot: null, sessionId: "coord-session",
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { return { exitCode: 1, signal: null, stdout: "", stderr: "" }; },
      async startDashboard() { throw new Error("not available in this test"); },
      async openBrowser() { throw new Error("not available in this test"); },
    },
  };
}

/** An ACTIVE store holding one unregistered header in the requested terminal status. */
async function fixture(status: "stopped" | "completed"): Promise<{ root: string; harness: string; attestation: string }> {
  const root = mkdtempSync(join(tmpdir(), "mstar-reopen-command-"));
  roots.push(root);
  const harness = join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  const initial = await initializeStore({ harnessDir: harness });
  initial.close();
  const writer = await openStore({ harnessDir: harness }, "write");
  try {
    writer.db.prepare(
      "insert into execution_workflows(workflow_id, revision, creator_session_id, state_json, created_at, updated_at) values (?, 1, null, ?, ?, ?)",
    ).run(WORKFLOW_ID, JSON.stringify({
      id: WORKFLOW_ID, schema_version: 1, type: "plan", status,
      started_at: "2026-10-01T00:00:00.000Z",
      ended_at: "2026-10-01T01:00:00.000Z",
      updated_at: "2026-10-01T01:00:00.000Z",
    }), "2026-10-01T00:00:00.000Z", "2026-10-01T01:00:00.000Z");
  } finally { writer.close(); }
  const attestation = join(root, "reopen-attestation.json");
  // The recovery-scope document: operator + reason are the authorization, so a
  // consumerless attestation with no stopped session is valid.
  writeFileSync(attestation, JSON.stringify({
    version: 1,
    attestedAt: "2026-10-23T00:00:00.000Z",
    operator: { actor: "ops-engineer", authorizationRef: "fixture operator decision" },
    stoppedSessions: [],
  }));
  return { root, harness, attestation };
}

describe("workflow.reopen — the public verb on a terminal lifecycle", () => {
  test("returns a stopped lifecycle to running through the derived terminal-token CAS", async () => {
    const { root, harness, attestation } = await fixture("stopped");
    const result = await definition("workflow.reopen").execute({
      workflow: WORKFLOW_ID,
      harness,
      reason: "resume the stopped lifecycle under the operator's authorization",
      attestation,
    }, invocation(root));
    expect(result).toMatchObject({ status: "ok", code: "workflow.reopen.ok", exitCode: 0 });
    // `--expect` was omitted: the command read the retained terminal token and
    // passed it explicitly, so the committed state is the CAS-guarded one.
    const state = await readExecutionState({ harnessDir: harness });
    expect(state.data.workflows.map((entry) => entry.state.status)).toEqual(["running"]);
    expect(state.data.terminalUnregistered).toBeUndefined();
  });

  test("a completed lifecycle refuses with the named code and leaves the header untouched", async () => {
    const { root, harness, attestation } = await fixture("completed");
    const result = await definition("workflow.reopen").execute({
      workflow: WORKFLOW_ID, harness, reason: "reopen a completed lifecycle", attestation,
    }, invocation(root));
    expect(result).toMatchObject({ status: "refused", code: "workflow.reopen-completed", exitCode: 1 });
    const state = await readExecutionState({ harnessDir: harness });
    expect(state.data.workflows).toEqual([]);
    expect(state.data.terminalUnregistered?.map((entry) => [entry.id, entry.status]))
      .toEqual([[WORKFLOW_ID, "completed"]]);
  });

  test("an identical retry with no --expect replays the committed reopen", async () => {
    const { root, harness, attestation } = await fixture("stopped");
    const request = {
      workflow: WORKFLOW_ID,
      harness,
      reason: "resume the stopped lifecycle under the operator's authorization",
      attestation,
      operation: "op-reopen-retry",
    };
    const first = await definition("workflow.reopen").execute(request, invocation(root));
    expect(first).toMatchObject({ status: "ok", code: "workflow.reopen.ok", exitCode: 0 });
    const committed = await readExecutionState({ harnessDir: harness });
    // The caller omitted --expect both times: the engine, not the command,
    // resolves the terminal revision, so the fingerprint is unchanged and the
    // revision the first call advanced cannot turn the retry into a conflict.
    const retry = await definition("workflow.reopen").execute(request, invocation(root));
    expect(retry).toMatchObject({ status: "ok", code: "workflow.reopen.ok", exitCode: 0 });
    expect(retry.data).toMatchObject({ replayed: true });
    expect(await readExecutionState({ harnessDir: harness })).toEqual(committed);
  });

  test("reason is required, while an omitted attestation is generated instead of demanded", async () => {
    const { root, harness } = await fixture("stopped");
    // No --attestation: the reopen generates its recovery-scope document from
    // its own recorded facts (I-000297) and succeeds — the file is never a
    // required input.
    const generated = await definition("workflow.reopen").execute({
      workflow: WORKFLOW_ID, harness, reason: "no operator document supplied",
    }, invocation(root));
    expect(generated).toMatchObject({ status: "ok", code: "workflow.reopen.ok", exitCode: 0 });
    // The generated facts: the calling session is the operator, the replay id
    // (generated for an omitted --operation) is the authorizationRef, and a
    // reopen disposes no session row so its stop list is empty.
    const generatedRecovery = generated.status === "ok" ? generated.data.recovery : undefined;
    expect(generatedRecovery?.resolvedFrom).toHaveLength(3);
    expect(generatedRecovery?.resolvedFrom?.[0]).toMatchObject({ path: "attestation.operator" });
    expect(generatedRecovery?.resolvedFrom?.[0]?.source).toMatch(/^coord-session \([0-9a-f-]{36}\)$/);
    expect(generatedRecovery?.resolvedFrom?.[1]).toMatchObject({ path: "attestation.attestedAt" });
    expect(generatedRecovery?.resolvedFrom?.[2]).toEqual({ path: "attestation.stoppedSessions", source: "none" });
    // `reason` is still the one required authorization fact.
    const stoppedAgain = await fixture("stopped");
    const missingReason = await definition("workflow.reopen").execute({
      workflow: WORKFLOW_ID, harness: stoppedAgain.harness,
    }, invocation(stoppedAgain.root));
    expect(missingReason).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
  });
});
