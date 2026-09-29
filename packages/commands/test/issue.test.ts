import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeStore } from "@mstar-harness/engine";
import { getCommandDefinitions } from "../src/index.js";
import type { CommandEffects, InvocationContext } from "../src/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function testContext(): Promise<InvocationContext> {
  const root = mkdtempSync(path.join(os.tmpdir(), "commands-issue-"));
  roots.push(root);
  const harness = path.join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  await (await initializeStore({ harnessDir: harness })).close();
  const effects: CommandEffects = {
    async readInput() { return ""; },
    async spawn() { throw new Error("not used"); },
    async startDashboard() { throw new Error("not used"); },
    async openBrowser() { throw new Error("not used"); },
  };
  return {
    cwd: root,
    controlRoot: harness,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects,
  };
}

function definition(id: string) {
  const found = getCommandDefinitions().find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing command definition: ${id}`);
  return found;
}

function capture(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "proj-a", title: "Finding", kind: "bug", severity: "high", impact: "impact", acceptance: "acceptance",
    sourceIdentity: "review/1", rootCauseKey: "root-1", acceptanceKey: "accept-1", occurrenceKey: "occ-1",
    sourceKind: "qc", location: "src/example.ts", observedBehavior: "fails", evidence: ["repro"], discoveredAt: "2026-09-26T10:00:00Z",
    ...overrides,
  };
}
function boundSession(harness: string): string {
  const workflowId = "wf-issue";
  const sessionId = "11111111-1111-1111-1111-111111111111";
  const sessionPath = path.join(harness, "workflows", workflowId, "sessions", `plan-pm-${sessionId}.json`);
  const writeJson = (file: string, value: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  };
  writeJson(sessionPath, {
    schema_version: 1, role: "plan-pm", session_id: sessionId, workflow_id: workflowId,
    plan_id: "plan-a", harness_root: harness,
  });
  writeJson(path.join(harness, "workflows", workflowId, "snapshot.json"), {
    schema_version: 1, id: workflowId, type: "iteration", status: "running",
    started_at: "2026-09-26T00:00:00Z", updated_at: "2026-09-26T00:00:00Z",
    plans: [{
      id: "plan-a", plan_id: "plan-a", title: "Plan A", file: ".mstar/plans/plan-a.md", status: "Todo",
      coordination: { revision: 1, session: { session_id: sessionId, session_file: sessionPath, bound_at: "2026-09-26T00:00:00Z" } },
    }],
  });
  return sessionPath;
}

describe("issue command family", () => {
  test("registers all eleven inventory identities, including separate terminal dispositions", () => {
    const ids = getCommandDefinitions().map(({ id }) => id).filter((id) => id.startsWith("issue."));
    expect(ids).toEqual([
      "issue.add", "issue.list", "issue.show", "issue.occurrence", "issue.triage", "issue.close", "issue.waive",
      "issue.duplicate", "issue.supersede", "issue.link", "issue.export",
    ]);
  });

  test("malformed capture is rejected without creating an issue", async () => {
    const context = await testContext();
    const result = await definition("issue.add").execute({ payload: {}, operationId: "bad-capture", actor: "project-manager" }, context);
    expect(result.status).toBe("refused");
    const page = await definition("issue.list").execute({}, context);
    expect(page.status).toBe("ok");
    if (page.status === "ok") expect((page.data as { items: unknown[] }).items).toHaveLength(0);
  });

  test("reads list, show and export data from the same store", async () => {
    const context = await testContext();
    const added = await definition("issue.add").execute({ payload: capture(), operationId: "capture-1", actor: "project-manager" }, context);
    expect(added.status).toBe("ok");
    if (added.status !== "ok") return;
    const id = (added.data as { issueId: string }).issueId;
    const listed = await definition("issue.list").execute({}, context);
    const shown = await definition("issue.show").execute({ id }, context);
    const exported = await definition("issue.export").execute({ id }, context);
    expect(listed.status).toBe("ok");
    expect(shown.status).toBe("ok");
    expect(exported.status).toBe("ok");
    if (listed.status === "ok") expect((listed.data as { items: Array<{ id: string }> }).items.map(({ id: itemId }) => itemId)).toContain(id);
    if (shown.status === "ok") expect(shown.data).toMatchObject({ id, title: "Finding" });
    if (exported.status === "ok") expect(exported.data).toMatchObject({ id, title: "Finding" });
  });

  test("unauthorized disposition is refused without changing issue state", async () => {
    const context = await testContext();
    const added = await definition("issue.add").execute({ payload: capture(), operationId: "capture-2", actor: "project-manager" }, context);
    expect(added.status).toBe("ok");
    if (added.status !== "ok") return;
    const receipt = added.data as { issueId: string; revision: number };
    const closed = await definition("issue.close").execute({
      id: receipt.issueId, payload: { reason: "done", references: ["qa.md"], alignmentRef: "QA approved" },
      operationId: "unauthorized-close", actor: "project-manager", expect: receipt.revision,
    }, context);
    expect(closed.status).toBe("refused");
    const shown = await definition("issue.show").execute({ id: receipt.issueId }, context);
    expect(shown.status).toBe("ok");
    if (shown.status === "ok") expect(shown.data).toMatchObject({ id: receipt.issueId, revision: receipt.revision, disposition: "open" });
  });
  test("stale issue revision is refused without changing triage state", async () => {
    const context = await testContext();
    const session = boundSession(context.controlRoot!);
    const added = await definition("issue.add").execute({ payload: capture(), operationId: "capture-stale", actor: "project-manager" }, context);
    expect(added.status).toBe("ok");
    if (added.status !== "ok") return;
    const receipt = added.data as { issueId: string; revision: number };
    const triaged = await definition("issue.triage").execute({
      id: receipt.issueId, payload: { reason: "reclassify", severity: "low" },
      operationId: "stale-triage", actor: "project-manager", session, expect: receipt.revision - 1,
    }, context);
    expect(triaged).toMatchObject({ status: "refused", code: "issue.revision-conflict" });
    const shown = await definition("issue.show").execute({ id: receipt.issueId }, context);
    expect(shown.status).toBe("ok");
    if (shown.status === "ok") expect(shown.data).toMatchObject({ id: receipt.issueId, revision: receipt.revision, severity: "high" });
  });
  test("payload JSON strings decode and expose domain schema links", async () => {
    const context = await testContext();
    const command = definition("issue.add");
    const result = await command.execute({
      payload: JSON.stringify(capture()), operationId: "capture-json", actor: "project-manager",
    }, context);
    expect(result.status).toBe("ok");
    expect(command.description).toContain("mstar schema CaptureInput");
    expect(command.payloads).toHaveProperty("CaptureInput");
    expect(command.effects).toEqual(["write"]);
    expect(definition("issue.export").effects).toEqual(["read"]);
  });
  test("payload schema exposes registry constraints and refusals identify invalid and missing paths", async () => {
    const context = await testContext();
    const command = definition("issue.add");
    const schema = command.payloads?.CaptureInput.schema;
    expect(schema?.safeParse({}).success).toBe(false);
    expect(schema?.safeParse(capture()).success).toBe(true);

    const invalid = await command.execute({
      payload: { ...capture(), title: 42 },
      operationId: "invalid-payload",
      actor: "project-manager",
    }, context);
    expect(invalid.status).toBe("refused");
    if (invalid.status === "refused") expect(invalid.details?.paths).toContain("payload.title");

    const missingMutation = await command.execute({ payload: capture() }, context);
    expect(missingMutation.status).toBe("refused");
    if (missingMutation.status === "refused") expect(missingMutation.details?.paths).toEqual(["operationId", "actor"]);
  });
});

