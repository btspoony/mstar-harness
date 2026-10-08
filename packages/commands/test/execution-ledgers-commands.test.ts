import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { executeCommand } from "../src/definitions.js";
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
  // The store is created by its own producer, so its explicit harness directory
  // must exist first: `initializeStore` refuses a missing control root rather
  // than inventing one, and a fixture that skips this never reaches a route.
  mkdirSync(harnessDir, { recursive: true });
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

describe("workflow-note public routes", () => {
  test("append writes the accepted record, replays the same id, and never echoes a foreign scope", async () => {
    const fx = await activeFixture();
    const ctx = context(fx.root);
    // The real public route: shared admission composes the coordinator session
    // selector and only then runs the family handler, so this case exercises
    // the actual consumer path rather than the handler alone.
    const input = { workflow: WORKFLOW, sessionRef: fx.sessionRef, id: "note-1", text: "first note", ts: "2026-10-08T01:00:00.000Z", harness: fx.harnessDir, sessionId: COORDINATOR };

    const first = await executeCommand("workflow-note.append", input, ctx);
    expect(first).toMatchObject({ status: "ok", data: { id: "note-1", replayed: false } });
    const ledger = readFileSync(path.join(fx.harnessDir, "workflows", WORKFLOW, "notes.jsonl"), "utf8");
    expect(ledger).toContain('"id":"note-1"');
    expect(ledger).toContain('"text":"first note"');

    // An identical retry replays the accepted record instead of duplicating it.
    const replay = await executeCommand("workflow-note.append", input, ctx);
    expect(replay).toMatchObject({ status: "ok", data: { id: "note-1", replayed: true } });
    expect(readFileSync(path.join(fx.harnessDir, "workflows", WORKFLOW, "notes.jsonl"), "utf8").match(/"id":"note-1"/g)).toHaveLength(1);

    // A sessionRef addressing another workflow is a usage refusal naming the
    // seat, never a write into that other workflow.
    const foreign = encodeExecutionSessionRef({ storeId: "00000000-0000-4000-8000-000000000000", epoch: 1, workflowId: "wf-other", role: "coordinator", sessionId: "other" });
    const refused = await executeCommand("workflow-note.append", { ...input, sessionRef: foreign }, ctx);
    expect(refused).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
  });

  test("append without an acquired identity refuses with its owner and supply, not a generic block", async () => {
    const fx = await activeFixture();
    const result = await executeCommand(
      "workflow-note.append",
      { workflow: WORKFLOW, sessionRef: fx.sessionRef, id: "note-2", text: "x", harness: fx.harnessDir },
      context(fx.root),
    );
    expect(result).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(result.details?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "sessionId", code: "required" }),
    ]));
  });

  test("coverage projects absent, then the accepted record, as distinct facts", async () => {
    const fx = await activeFixture();
    const ctx = context(fx.root);

    const absent = await executeCommand("workflow-note.coverage", { workflow: WORKFLOW, harness: fx.harnessDir }, ctx);
    expect(absent).toMatchObject({ status: "ok", data: { format: "absent", bytes: 0, fileSha256: null, acceptedIds: [] } });

    await executeCommand(
      "workflow-note.append",
      { workflow: WORKFLOW, sessionRef: fx.sessionRef, id: "note-3", text: "coverage note", ts: "2026-10-08T02:00:00.000Z", harness: fx.harnessDir, sessionId: COORDINATOR },
      ctx,
    );

    const present = await executeCommand("workflow-note.coverage", { workflow: WORKFLOW, harness: fx.harnessDir }, ctx);
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
  test("invalid append input returns shared input-aware diagnostics", async () => {
    const fx = await activeFixture();
    const result = await executeCommand(
      "workflow-note.append",
      { workflow: WORKFLOW, sessionRef: fx.sessionRef, id: "bad-note", text: 42, harness: fx.harnessDir, sessionId: COORDINATOR },
      context(fx.root),
    );
    expect(result).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(result.details?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "text", code: "invalid_type", expected: "string", received: "42" }),
    ]));
  });

  test("same-workflow foreign invocation refuses without changing retained bytes", async () => {
    const fx = await activeFixture();
    const ledgerPath = path.join(fx.harnessDir, "workflows", WORKFLOW, "notes.jsonl");
    const accepted = await executeCommand(
      "workflow-note.append",
      { workflow: WORKFLOW, sessionRef: fx.sessionRef, id: "note-owner", text: "retained", ts: "2026-10-08T03:00:00.000Z", harness: fx.harnessDir, sessionId: COORDINATOR },
      context(fx.root),
    );
    expect(accepted.status).toBe("ok");
    const before = readFileSync(ledgerPath);
    const refused = await executeCommand(
      "workflow-note.append",
      { workflow: WORKFLOW, sessionRef: fx.sessionRef, id: "note-foreign", text: "must not append", harness: fx.harnessDir, sessionId: "foreign-session" },
      context(fx.root),
    );
    expect(refused).toMatchObject({ status: "refused", code: "execution.scope-mismatch", exitCode: 1 });
    expect(readFileSync(ledgerPath)).toEqual(before);
  });

  test("coverage refuses symlinked and dangling retained leaves instead of reporting absence", async () => {
    const fx = await activeFixture();
    const outside = path.join(fx.root, "outside.jsonl");
    const link = path.join(fx.root, "linked.jsonl");
    const dangling = path.join(fx.root, "dangling.jsonl");
    const nonRegular = path.join(fx.root, "directory-leaf");
    writeFileSync(outside, '{"text":"outside-secret"}\n');
    symlinkSync(outside, link);
    symlinkSync(path.join(fx.root, "missing.jsonl"), dangling);
    mkdirSync(nonRegular);
    for (const file of [link, dangling, nonRegular]) {
      const result = await executeCommand("workflow-note.coverage", { workflow: WORKFLOW, file, harness: fx.harnessDir }, context(fx.root));
      expect(result).toMatchObject({ status: "refused", code: "execution-ledgers.target-untrusted", exitCode: 1 });
      expect(JSON.stringify(result)).not.toContain("outside-secret");
    }
  });

  test("coverage preserves explicit regular-file behavior", async () => {
    const fx = await activeFixture();
    const file = path.join(fx.root, "explicit.jsonl");
    writeFileSync(file, "");
    const result = await executeCommand(
      "workflow-note.coverage",
      { workflow: WORKFLOW, file, harness: fx.harnessDir },
      context(fx.root),
    );
    expect(result).toMatchObject({ status: "ok", data: { format: "empty", bytes: 0, fileSha256: expect.any(String) } });
  });
});
