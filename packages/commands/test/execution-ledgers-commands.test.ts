import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  encodeExecutionSessionRef,
  executionContextFor,
  initializeExecutionAuthority,
  initializeStore,
  type ExecutionSessionRef,
  type ExecutionToken,
  type ExecutionIdentity,
} from "@mstar-harness/engine";
import { getExecutionLedgerCommandDefinitions } from "../src/families/execution-ledgers.js";
import type { InvocationContext } from "../src/types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const WORKFLOW = "wf-notes-cli";
const COORDINATOR = "coordinator-notes";

/**
 * A real ACTIVE authority with one created+bound coordinator workflow: the
 * append route must be exercised against the engine's own current-session
 * assertion, never a mock.
 */
async function activeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "execution-ledgers-command-"));
  roots.push(root);
  const harnessDir = path.join(root, ".mstar");
  const storeContext = { harnessDir };
  (await initializeStore(storeContext)).close();
  const initialized = await initializeExecutionAuthority(storeContext);
  const identity: ExecutionIdentity = { source: "local", sessionId: COORDINATOR, workflowId: WORKFLOW, role: "coordinator" };
  const created = await createExecutionWorkflow(executionContextFor(storeContext, identity), {
    entry: { id: WORKFLOW, type: "plan", status: "running", started_at: "2026-10-08T00:00:00Z", dir: `workflows/${WORKFLOW}` } as never,
    snapshot: {
      schema_version: 1,
      id: WORKFLOW,
      type: "plan",
      status: "running",
      started_at: "2026-10-08T00:00:00Z",
      updated_at: "2026-10-08T00:00:00Z",
      plans: [{ id: "p-1", title: "Plan One", file: "plans/p-1.md", status: "InProgress" }],
    } as never,
    expected: initialized.token,
    operationId: "create-notes-workflow",
  });
  const workflowToken = (created.data as unknown as { workflows: Array<{ workflowToken: ExecutionToken }> }).workflows[0]!.workflowToken;
  const bound = await bindExecutionSession(executionContextFor(storeContext, identity), {
    workflowId: WORKFLOW,
    expected: workflowToken,
    operationId: "bind-notes-coordinator",
  });
  const sessionRef = encodeExecutionSessionRef(bound.data as ExecutionSessionRef);
  return { root, harnessDir, sessionRef };
}

function context(cwd: string, sessionId?: string): InvocationContext {
  return {
    cwd,
    controlRoot: null,
    ...(sessionId === undefined ? {} : { sessionId }),
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { throw new Error("ledger commands must not spawn a process"); },
      async startDashboard() { throw new Error("dashboard is unavailable in this test"); },
      async openBrowser() { throw new Error("browser is unavailable in this test"); },
    },
  };
}

function definition(id: string) {
  // The canonical append is deferred until slice A integration, so this round's
  // routes are exercised through their own family module (they are already the
  // same shared Registry shape `getCommandDefinitions()` will mount later).
  const found = getExecutionLedgerCommandDefinitions().find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`Missing command definition: ${id}`);
  return found;
}

describe("workflow-note public routes", () => {
  test("append writes the accepted record, replays the same id, and never echoes a foreign scope", async () => {
    const fx = await activeFixture();
    const ctx = context(fx.root, COORDINATOR);
    const append = definition("workflow-note.append");
    const input = { workflow: WORKFLOW, sessionRef: fx.sessionRef, id: "note-1", text: "first note", ts: "2026-10-08T01:00:00.000Z", harness: fx.harnessDir };

    const first = await append.execute(input, ctx);
    expect(first).toMatchObject({ status: "ok", data: { id: "note-1", replayed: false } });
    const ledger = readFileSync(path.join(fx.harnessDir, "workflows", WORKFLOW, "notes.jsonl"), "utf8");
    expect(ledger).toContain('"id":"note-1"');
    expect(ledger).toContain('"text":"first note"');

    // An identical retry replays the accepted record instead of duplicating it.
    const replay = await append.execute(input, ctx);
    expect(replay).toMatchObject({ status: "ok", data: { id: "note-1", replayed: true } });
    expect(readFileSync(path.join(fx.harnessDir, "workflows", WORKFLOW, "notes.jsonl"), "utf8").match(/"id":"note-1"/g)).toHaveLength(1);

    // A sessionRef addressing another workflow is a usage refusal naming the
    // seat, never a write into that other workflow.
    const foreign = encodeExecutionSessionRef({ storeId: "00000000-0000-4000-8000-000000000000", epoch: 1, workflowId: "wf-other", role: "coordinator", sessionId: "other" });
    const refused = await append.execute({ ...input, sessionRef: foreign }, ctx);
    expect(refused).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
  });

  test("append without an acquired identity refuses with its owner and supply, not a generic block", async () => {
    const fx = await activeFixture();
    const result = await definition("workflow-note.append").execute(
      { workflow: WORKFLOW, sessionRef: fx.sessionRef, id: "note-2", text: "x", harness: fx.harnessDir },
      context(fx.root),
    );
    expect(result).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(result.message).toContain("--session-id");
    expect(result.message).toContain("sessionId");
  });

  test("coverage projects absent, then the accepted record, as distinct facts", async () => {
    const fx = await activeFixture();
    const ctx = context(fx.root);
    const coverage = definition("workflow-note.coverage");

    const absent = await coverage.execute({ workflow: WORKFLOW, harness: fx.harnessDir }, ctx);
    expect(absent).toMatchObject({ status: "ok", data: { format: "absent", bytes: 0, fileSha256: null, acceptedIds: [] } });

    await definition("workflow-note.append").execute(
      { workflow: WORKFLOW, sessionRef: fx.sessionRef, id: "note-3", text: "coverage note", ts: "2026-10-08T02:00:00.000Z", harness: fx.harnessDir },
      context(fx.root, COORDINATOR),
    );

    const present = await coverage.execute({ workflow: WORKFLOW, harness: fx.harnessDir }, ctx);
    expect(present.status).toBe("ok");
    if (present.status !== "ok") throw new Error("expected an ok coverage envelope");
    const data = present.data;
    if (data === null || typeof data !== "object" || !("format" in data) || !("acceptedIds" in data) || !("counts" in data) || !("fileSha256" in data)) {
      throw new Error("coverage facts must be an object carrying format/acceptedIds/counts/fileSha256");
    }
    expect(data.format).toBe("versioned");
    expect(data.acceptedIds).toEqual(["note-3"]);
    expect(data.counts).toMatchObject({ accepted: 1 });
    expect(typeof data.fileSha256 === "string" ? data.fileSha256 : "").toMatch(/^[0-9a-f]{64}$/);
  });
});
