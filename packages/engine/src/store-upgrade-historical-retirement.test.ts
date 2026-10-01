import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStore, openStore, type StoreContext } from "./store-db.js";
import { WORKFLOW_SNAPSHOT_FILE } from "./workflow.js";
import { listPendingCatalogRegistrations } from "./catalog-registration.js";
import { stageStoreUpgrade } from "./store-upgrade.js";

const root = mkdtempSync(join(tmpdir(), "mstar-historical-retirement-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("stage upgrade retires a stale execution-written historical workflow without root membership", async () => {
  const harnessDir = join(root, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const context: StoreContext = { harnessDir };
  const initialized = await initializeStore(context);
  initialized.close();
  const workflowId = "wf-historical-retirement";
  const workflowDir = join(harnessDir, "workflows", workflowId);
  mkdirSync(workflowDir, { recursive: true });
  const plan = { file: "sample-plan.md", id: "sample-plan", status: "Todo", title: "Sample plan" };
  const branch = { source: "feature/historical", target: "main" };
  const snapshot = {
    schema_version: 1, id: workflowId, type: "plan", status: "stopped",
    started_at: "2026-09-30T00:00:00.000Z", updated_at: "2026-09-30", ended_at: "2026-09-30",
    stop_reason: "historical workflow stopped", plans: [plan], delivery_kind: "development", branch,
  };
  writeFileSync(join(workflowDir, WORKFLOW_SNAPSHOT_FILE), JSON.stringify(snapshot));
  writeFileSync(join(harnessDir, "status.json"), JSON.stringify({ version: 2, updated_at: "2026-09-30", workflows: [] }));
  const operationId = "op-historical-retirement";
  const db = await openStore(context, "write");
  db.db.prepare("update store_meta set catalog_revision = catalog_revision + 1 where id = 1").run();
  const identity = JSON.stringify({
    branch, completion_policy: null, coordinator: null, delivery_kind: "development",
    plans: [plan], project: null, status: "running", type: "plan",
  });
  const delta = JSON.stringify({
    version: 1,
    workflow: {
      kind: "plan", workflowId, harnessDir, dir: workflowDir,
      snapshotPath: join(workflowDir, WORKFLOW_SNAPSHOT_FILE), statusPath: join(harnessDir, "status.json"), identity,
    },
    execution: { kind: "plan", workflowId, options: {} },
    catalog: { entities: [], links: [], binding: { catalogKind: "plan", catalogId: workflowId } },
    actor: "project-manager", expectedCatalogRevision: 0,
  });
  db.db.prepare("insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) values (?, 'test-hash', 'execution-written', ?, '{}', '{}', null, ?, ?)")
    .run(operationId, delta, "2026-09-30T00:00:00.000Z", "2026-09-30T00:00:00.000Z");
  db.close();
  const beforeDb = await openStore(context, "read");
  const before = beforeDb.db.prepare("select phase from catalog_operations where operation_id = ?").get(operationId);
  beforeDb.close();
  expect(before).toEqual({ phase: "execution-written" });
  expect(await listPendingCatalogRegistrations(context)).toHaveLength(1);

  await stageStoreUpgrade({ context, operator: "owner", operationId: "stage-historical", catalogDeltaDisposition: "preserve for later review" });

  const afterDb = await openStore(context, "read");
  const after = afterDb.db.prepare("select phase, result_json from catalog_operations where operation_id = ?").get(operationId) as { phase: string; result_json: string };
  afterDb.close();
  expect(after.phase).toBe("aborted");
  expect(JSON.parse(after.result_json).reason).toContain("unpublished catalog delta disposition: preserve for later review");
  expect(await listPendingCatalogRegistrations(context)).toHaveLength(0);
});
