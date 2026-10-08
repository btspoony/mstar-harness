import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

describe("issue command family", () => {

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

  test("actor-only disposition closes an issue without session authority", async () => {
    const context = await testContext();
    const added = await definition("issue.add").execute({ payload: capture(), operationId: "capture-2", actor: "project-manager" }, context);
    expect(added.status).toBe("ok");
    if (added.status !== "ok") return;
    const receipt = added.data as { issueId: string; revision: number };
    const closed = await definition("issue.close").execute({
      id: receipt.issueId, payload: { reason: "done", references: ["qa.md"], alignmentRef: "QA approved" },
      operationId: "actor-only-close", actor: "project-manager", expect: receipt.revision,
    }, context);
    expect(closed.status).toBe("ok");
    const shown = await definition("issue.show").execute({ id: receipt.issueId }, context);
    expect(shown.status).toBe("ok");
    if (shown.status === "ok") expect(shown.data).toMatchObject({ id: receipt.issueId, revision: receipt.revision + 1, disposition: "resolved" });
  });
  test("stale issue revision is refused without changing triage state", async () => {
    const context = await testContext();
    const added = await definition("issue.add").execute({ payload: capture(), operationId: "capture-stale", actor: "project-manager" }, context);
    expect(added.status).toBe("ok");
    if (added.status !== "ok") return;
    const receipt = added.data as { issueId: string; revision: number };
    const triaged = await definition("issue.triage").execute({
      id: receipt.issueId, payload: { reason: "reclassify", severity: "low" },
      operationId: "stale-triage", actor: "project-manager", expect: receipt.revision - 1,
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
    expect(command.payloads).toHaveProperty("payload");
    expect(command.effects).toEqual(["write"]);
    expect(definition("issue.export").effects).toEqual(["read"]);
  });
  test("payload schema exposes registry constraints and refusals identify invalid and missing paths", async () => {
    const context = await testContext();
    const command = definition("issue.add");
    const schema = command.payloads?.payload?.schema;
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
    if (missingMutation.status === "refused") expect(missingMutation.details?.paths).toEqual(["actor"]);
  });

  test("a declared string-or-null payload field keeps its type instead of accepting any JSON", async () => {
    const context = await testContext();
    // `IssueTriage.owner` is the registry's `"string | null"` field: the
    // published schema must reject a value the domain does not declare, not
    // fall back to an unbounded `z.unknown()`.
    const triage = definition("issue.triage").payloads?.payload?.schema;
    expect(triage?.safeParse({ reason: "reclassify", owner: "reviewer" }).success).toBe(true);
    expect(triage?.safeParse({ reason: "reclassify", owner: null }).success).toBe(true);
    expect(triage?.safeParse({ reason: "reclassify", owner: 7 }).success).toBe(false);
    expect(triage?.safeParse({ reason: "reclassify", owner: { role: "pm" } }).success).toBe(false);

    const added = await definition("issue.add").execute({ payload: capture(), operationId: "capture-owner", actor: "project-manager" }, context);
    expect(added.status).toBe("ok");
    if (added.status !== "ok") return;
    const receipt = added.data as { issueId: string; revision: number };
    const typed = await definition("issue.triage").execute({
      id: receipt.issueId, payload: { reason: "reclassify", owner: "reviewer" },
      operationId: "triage-owner", actor: "project-manager", expect: receipt.revision,
    }, context);
    expect(typed.status).toBe("ok");
    const shown = await definition("issue.show").execute({ id: receipt.issueId }, context);
    if (shown.status === "ok") expect(shown.data).toMatchObject({ owner: "reviewer" });
  });
  test("omitted replay ids are fresh per mutation while explicit blank remains invalid", async () => {
    const context = await testContext();
    const command = definition("issue.add");
    const first = await command.execute({
      payload: capture({ sourceIdentity: "review/auto-1", rootCauseKey: "auto-root-1", occurrenceKey: "auto-occ-1" }),
      actor: "project-manager",
    }, context);
    const second = await command.execute({
      payload: capture({ sourceIdentity: "review/auto-2", rootCauseKey: "auto-root-2", occurrenceKey: "auto-occ-2" }),
      actor: "project-manager",
    }, context);
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    const blank = await command.execute({
      payload: capture({ sourceIdentity: "review/blank", rootCauseKey: "blank-root", occurrenceKey: "blank-occ" }),
      operationId: "",
      actor: "project-manager",
    }, context);
    expect(blank.status).toBe("refused");
    if (first.status !== "ok") return;
    const receipt = first.data as { issueId: string; revision: number };
    const triaged = await definition("issue.triage").execute({
      id: receipt.issueId, payload: { reason: "reclassify", severity: "low" },
      actor: "project-manager", expect: receipt.revision,
    }, context);
    expect(triaged.status).toBe("ok");
    const shown = await definition("issue.show").execute({ id: receipt.issueId }, context);
    expect(shown.status).toBe("ok");
    if (shown.status === "ok") expect(shown.data).toMatchObject({ id: receipt.issueId, revision: receipt.revision + 1, severity: "low" });
  });
});

