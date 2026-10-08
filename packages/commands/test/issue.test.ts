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
  test("omitted replay ids are fresh per mutation while explicit blank remains invalid without a write", async () => {
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
    if (first.status !== "ok" || second.status !== "ok") return;
    const firstReceipt = first.data as { issueId: string; revision: number; operationId: string };
    const secondReceipt = second.data as { issueId: string; revision: number; operationId: string };
    expect(firstReceipt.operationId).not.toBe(secondReceipt.operationId);
    expect(firstReceipt.operationId).toMatch(/^[0-9a-f-]{36}$/);
    const blank = await command.execute({
      payload: capture({ sourceIdentity: "review/blank", rootCauseKey: "blank-root", occurrenceKey: "blank-occ" }),
      operationId: "",
      actor: "project-manager",
    }, context);
    expect(blank).toMatchObject({ status: "refused", code: "issue.invalid-payload", details: { paths: ["operationId"] } });
    const afterBlank = await definition("issue.list").execute({}, context);
    expect(afterBlank.status).toBe("ok");
    if (afterBlank.status === "ok") expect((afterBlank.data as { items: unknown[] }).items).toHaveLength(2);
    const next = await command.execute({
      payload: capture({ sourceIdentity: "review/auto-3", rootCauseKey: "auto-root-3", occurrenceKey: "auto-occ-3" }),
      actor: "project-manager",
    }, context);
    expect(next.status).toBe("ok");
    if (next.status === "ok") expect((next.data as { issueId: string }).issueId).toBe("I-000003");

    const shown = await definition("issue.show").execute({ id: firstReceipt.issueId }, context);
    expect(shown.status).toBe("ok");
    if (shown.status !== "ok") return;
    const current = shown.data as { id: string; revision: number };
    const triaged = await definition("issue.triage").execute({
      id: current.id, payload: { reason: "reclassify", severity: "low" },
      operationId: "triage-from-show", actor: "project-manager", expect: current.revision,
    }, context);
    expect(triaged).toMatchObject({ status: "ok", data: { operationId: "triage-from-show", issueId: current.id } });
    const final = await definition("issue.show").execute({ id: current.id }, context);
    expect(final).toMatchObject({ status: "ok", data: { id: current.id, revision: current.revision + 1, severity: "low" } });
  });

  test("explicit replay ids replay once and reject conflicting reuse without mutation", async () => {
    const context = await testContext();
    const command = definition("issue.add");
    const input = capture();
    const first = await command.execute({ payload: input, operationId: "capture-replay", actor: "project-manager" }, context);
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    const replay = await command.execute({ payload: input, operationId: "capture-replay", actor: "project-manager" }, context);
    expect(replay).toEqual(first);
    expect(replay).toMatchObject({ data: { operationId: "capture-replay" } });
    const conflict = await command.execute({
      payload: capture({ title: "Different issue", occurrenceKey: "different-occurrence" }),
      operationId: "capture-replay", actor: "project-manager",
    }, context);
    expect(conflict).toMatchObject({ status: "refused", code: "store.operation-conflict" });
    const page = await definition("issue.list").execute({}, context);
    expect(page.status).toBe("ok");
    if (page.status === "ok") expect((page.data as { items: unknown[] }).items).toHaveLength(1);
  });

  test("addressed issue mutations publish issue id and revision CAS minima", () => {
    const addressed = ["occurrence", "triage", "close", "reopen", "waive", "duplicate", "supersede", "link"];
    for (const verb of addressed) {
      const command = definition(`issue.${verb}`);
      for (const route of ["cli", "mcp"] as const) {
        expect(command.requirements).toContainEqual(expect.objectContaining({ name: "id", route, required: true }));
      }
      expect(command.cli.options).toContainEqual(expect.objectContaining({ key: "id", required: true }));
      const missingId = command.input.safeParse({ actor: "project-manager" });
      expect(missingId.success).toBe(false);
      if (!missingId.success) expect(missingId.error.issues.some((issue) => issue.path.includes("id"))).toBe(true);
    }
    for (const verb of ["add", "export"]) {
      const command = definition(`issue.${verb}`);
      expect(command.requirements).not.toContainEqual(expect.objectContaining({ name: "id", required: true }));
      expect(command.cli.options).toContainEqual(expect.objectContaining({ key: "id", required: false }));
    }
    for (const verb of ["triage", "close", "reopen", "waive", "duplicate", "supersede", "link"]) {
      expect(definition(`issue.${verb}`).requirements).toContainEqual(
        expect.objectContaining({ name: "expect", required: true, constraint: expect.stringContaining("mstar issue show") }),
      );
      const missingCas = definition(`issue.${verb}`).input.safeParse({
        id: "I-000001", actor: "project-manager", payload: {},
      });
      expect(missingCas.success).toBe(false);
      if (!missingCas.success) expect(missingCas.error.issues.some((issue) => issue.path.includes("expect"))).toBe(true);
    }
  });
});

