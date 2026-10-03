import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { listPendingCatalogRegistrations, reconcileCatalogExecution, registerCatalogExecution } from "../src/catalog-registration.js";
import { createFsStore, setArtifactStore } from "../src/store.js";
import { initializeStore, openStore, type StoreContext } from "../src/store-db.js";
import { WORKFLOW_SNAPSHOT_FILE } from "../src/workflow.js";

const root = mkdtempSync(join(tmpdir(), "mstar-ownership-projection-"));
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

function request(harnessDir: string, planId: string, operationId: string, expectedCatalogRevision: number, coordinator = "session-original") {
  return {
    operationId,
    actor: "project-manager" as const,
    expectedCatalogRevision,
    workflow: {
      kind: "plan" as const,
      workflowId: "wf-ownership",
      options: {
        harnessDir,
        plan: { id: planId, title: "Fixture plan", file: `plans/${planId}.md` },
        deliveryKind: "development" as const,
        branchSource: "feature/fixture",
        branchTarget: "main",
        project: "harness",
        coordinator: { session_id: coordinator, session_file: join(harnessDir, `${coordinator}.json`) },
        startedAt: "2026-09-18T00:00:00.000Z",
      },
    },
    delta: {
      entities: [{ kind: "plan" as const, id: planId, title: "Fixture plan", rootKind: "plans" as const, relativePath: basename(`plans/${planId}.md`) }],
      binding: { catalogKind: "plan" as const, catalogId: planId },
    },
  };
}

function snapshotPath(harnessDir: string) {
  return join(harnessDir, "workflows", "wf-ownership", WORKFLOW_SNAPSHOT_FILE);
}

describe("catalog migration ownership projection", () => {
  test("refuses a different coordinator without issuing a successful receipt", async () => {
    const { harnessDir, context, planId } = await fixture("coordinator-");
    await registerCatalogExecution(context, request(harnessDir, planId, "op-owner", 0));
    const before = readFileSync(snapshotPath(harnessDir), "utf8");
    await expect(registerCatalogExecution(context, request(harnessDir, planId, "op-retry", 1, "session-other")))
      .rejects.toMatchObject({ code: "catalog.registration-conflict" });
    expect(JSON.parse(before).coordination.coordinator.session_id).toBe("session-original");
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
  });

  test("ignores ordinary workflow and plan progress", async () => {
    const { harnessDir, context, planId } = await fixture("progress-");
    await registerCatalogExecution(context, request(harnessDir, planId, "op-progress", 0));
    const snapshot = JSON.parse(readFileSync(snapshotPath(harnessDir), "utf8"));
    snapshot.status = "paused";
    snapshot.plans[0].status = "InProgress";
    writeFileSync(snapshotPath(harnessDir), `${JSON.stringify(snapshot, null, 2)}\n`);
    await expect(registerCatalogExecution(context, request(harnessDir, planId, "op-progress", 0)))
      .resolves.toMatchObject({ operationId: "op-progress", workflowId: "wf-ownership" });
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
  });

  test("reconciles a pending journal identity in the pre-projection shape", async () => {
    const { harnessDir, context, planId } = await fixture("legacy-identity-");
    await registerCatalogExecution(context, request(harnessDir, planId, "op-legacy", 0));
    const before = await listPendingCatalogRegistrations(context);
    expect(before).toEqual([]);
    // Recreate an interrupted execution-written operation while preserving its real snapshot/root bytes.
    const handle = await openStore(context, "write");
    const row = handle.db.prepare("select catalog_delta_json from catalog_operations where operation_id = ?").get("op-legacy") as { catalog_delta_json: string };
    const journal = JSON.parse(row.catalog_delta_json);
    const snapshot = JSON.parse(readFileSync(snapshotPath(harnessDir), "utf8"));
    journal.workflow.identity = JSON.stringify({ ...snapshot, status: snapshot.status, coordinator: snapshot.coordination.coordinator });
    handle.db.prepare("update catalog_operations set phase = 'execution-written', result_json = null, catalog_delta_json = ? where operation_id = ?")
      .run(JSON.stringify(journal), "op-legacy");
    handle.close();
    const beforeReconcile = await listPendingCatalogRegistrations(context);
    expect(beforeReconcile).toMatchObject([{ operationId: "op-legacy", phase: "execution-written", rootVisible: true }]);
    await reconcileCatalogExecution(context, "op-legacy");
    const afterReconcile = await listPendingCatalogRegistrations(context);
    expect(afterReconcile).toEqual([]);
    const committed = await openStore(context, "read");
    expect((committed.db.prepare("select phase from catalog_operations where operation_id = ?").get("op-legacy") as { phase: string }).phase)
      .toBe("committed");
    committed.close();
  });

  test("refuses a changed registration input", async () => {
    const { harnessDir, context, planId } = await fixture("changed-input-");
    await registerCatalogExecution(context, request(harnessDir, planId, "op-input-owner", 0));
    const changed = request(harnessDir, planId, "op-input-retry", 1);
    changed.workflow.options.branchSource = "feature/changed";
    await expect(registerCatalogExecution(context, changed)).rejects.toMatchObject({ code: "catalog.registration-conflict" });
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
  });
});
