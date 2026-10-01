import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { listPendingCatalogRegistrations, registerCatalogExecution, assertCatalogExecutionCommitted } from "../src/catalog-registration.js";
import { createFsStore, setArtifactStore } from "../src/store.js";
import { initializeStore, type StoreContext } from "../src/store-db.js";
import { WORKFLOW_SNAPSHOT_FILE } from "../src/workflow.js";

const root = mkdtempSync(join(tmpdir(), "mstar-coordinator-registration-"));
afterEach(() => setArtifactStore(undefined));

async function fixture(name: string) {
  const harnessDir = mkdtempSync(join(root, name));
  mkdirSync(join(harnessDir, ".mstar"), { recursive: true });
  const context: StoreContext = { harnessDir };
  (await initializeStore(context)).close();
  setArtifactStore(createFsStore(harnessDir));
  const planId = "fixture-plan";
  mkdirSync(join(harnessDir, "plans"), { recursive: true });
  writeFileSync(join(harnessDir, "plans", `${planId}.md`), `# Fixture plan\n\n**plan_id:** ${planId}\n`);
  return { harnessDir, context, planId };
}

function request(harnessDir: string, planId: string, operationId: string, expectedCatalogRevision: number) {
  return {
    operationId,
    actor: "project-manager" as const,
    expectedCatalogRevision,
    workflow: {
      kind: "plan" as const,
      workflowId: "wf-coordinator",
      options: {
        harnessDir,
        plan: { id: planId, title: "Fixture plan", file: `plans/${planId}.md` },
        deliveryKind: "development" as const,
        branchSource: "feature/fixture",
        branchTarget: "main",
        project: "harness",
        coordinator: { session_id: "session-fixture", session_file: join(harnessDir, "session.json") },
        startedAt: "2026-09-18T00:00:00.000Z",
      },
    },
    delta: {
      entities: [{ kind: "plan" as const, id: planId, title: "Fixture plan", rootKind: "plans" as const, relativePath: basename(`plans/${planId}.md`) }],
      binding: { catalogKind: "plan" as const, catalogId: planId },
    },
  };
}

describe("coordinator-bound catalog registration", () => {
  test("writes execution files and commits the catalog operation", async () => {
    const { harnessDir, context, planId } = await fixture("commit-");
    const receipt = await registerCatalogExecution(context, request(harnessDir, planId, "op-coordinator", 0));

    expect(receipt).toMatchObject({ operationId: "op-coordinator", workflowId: "wf-coordinator", catalogRevision: 1 });
    expect(JSON.parse(readFileSync(join(harnessDir, "workflows", "wf-coordinator", WORKFLOW_SNAPSHOT_FILE), "utf8"))).toMatchObject({
      id: "wf-coordinator",
      coordination: { coordinator: { session_id: "session-fixture", session_file: join(harnessDir, "session.json") } },
    });
    expect(readFileSync(join(harnessDir, "status.json"), "utf8")).toContain("wf-coordinator");
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
    await assertCatalogExecutionCommitted(context, "wf-coordinator");
  });

  test("accepts ordinary workflow progress without changing registration inputs", async () => {
    const { harnessDir, context, planId } = await fixture("progress-");
    const req = request(harnessDir, planId, "op-coordinator-progress", 0);
    await registerCatalogExecution(context, req);
    const snapshotPath = join(harnessDir, "workflows", "wf-coordinator", WORKFLOW_SNAPSHOT_FILE);
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    snapshot.status = "paused";
    snapshot.plans[0].status = "InProgress";
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

    await expect(registerCatalogExecution(context, request(harnessDir, planId, "op-coordinator-progress-retry", 1))).resolves.toMatchObject({
      operationId: "op-coordinator-progress",
      workflowId: "wf-coordinator",
    });
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
  });
  
  test("refuses a changed registration input", async () => {
    const { harnessDir, context, planId } = await fixture("changed-input-");
    await registerCatalogExecution(context, request(harnessDir, planId, "op-coordinator-original", 0));
    const changed = request(harnessDir, planId, "op-coordinator-changed", 1);
    changed.workflow.options.branchSource = "feature/changed";

    await expect(registerCatalogExecution(context, changed)).rejects.toMatchObject({ code: "catalog.registration-conflict" });
    expect(await listPendingCatalogRegistrations(context)).toMatchObject([
      { operationId: "op-coordinator-changed", phase: "prepared", rootVisible: true },
    ]);
  });
});
