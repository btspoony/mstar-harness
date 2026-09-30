import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { openStore, initializeStore, type StoreContext } from "./store-db.js";
import { WORKFLOW_SNAPSHOT_FILE } from "./workflow.js";
import { listPendingCatalogRegistrations } from "./catalog-registration.js";
import { previewExecutionMigration } from "./execution-migrate.js";
import { stageStoreUpgrade } from "./store-upgrade.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-store-upgrade-retirement-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

async function fixture(name: string): Promise<{ context: StoreContext; operationId: string }> {
  const harnessDir = join(ROOT, name, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const context = { harnessDir };
  const store = await initializeStore(context);
  store.close();
  const workflowId = `wf-${name}`;
  const workflowDir = join(harnessDir, "workflows", workflowId);
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    join(workflowDir, WORKFLOW_SNAPSHOT_FILE),
    JSON.stringify({
      schema_version: 1,
      id: workflowId,
      type: "plan",
      status: "running",
      started_at: "2026-09-30",
      updated_at: "2026-09-30",
      delivery_kind: "development",
      branch: { source: `feature/${workflowId}`, target: "main" },
      plans: [],
    }),
  );
  writeFileSync(
    join(harnessDir, "status.json"),
    JSON.stringify({
      version: 2,
      updated_at: "2026-09-30",
      workflows: [{ id: workflowId, type: "plan", started_at: "2026-09-30", dir: join("workflows", workflowId) }],
    }),
  );
  const operationId = `op-${name}`;
  const db = await openStore(context, "write");
  const delta = JSON.stringify({
    version: 1,
    workflow: {
      kind: "plan",
      workflowId: `wf-${name}`,
      harnessDir,
      dir: join(harnessDir, "workflows", `wf-${name}`),
      snapshotPath: join(harnessDir, "workflows", `wf-${name}`, "snapshot.json"),
      statusPath: join(harnessDir, "status.json"),
      identity: "unresolvable-plan-pointer",
    },
    execution: { kind: "plan", workflowId: `wf-${name}`, options: {} },
    catalog: { entities: [], links: [], binding: { catalogKind: "plan", catalogId: `wf-${name}` } },
    actor: "project-manager",
    expectedCatalogRevision: 0,
  });
  db.db
    .prepare(
      "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) " +
        "values (?, 'test-hash', 'execution-written', ?, '{}', '{}', null, ?, ?)",
    )
    .run(operationId, delta, "2026-09-30T00:00:00.000Z", "2026-09-30T00:00:00.000Z");
  db.close();
  return { context, operationId };
}

test("stageStoreUpgrade retires a stale unresolved journal row before read-only preview", async () => {
  const { context, operationId } = await fixture("stale");
  const moved = await openStore(context, "write");
  moved.db.prepare("update store_meta set catalog_revision = catalog_revision + 1 where id = 1").run();
  moved.close();
  const before = await openStore(context, "read");
  const originalRow = before.db
    .prepare("select catalog_delta_json, updated_at, created_at, before_versions_json, after_versions_json from catalog_operations where operation_id = ?")
    .get(operationId) as {
      catalog_delta_json: string;
      updated_at: string;
      created_at: string;
      before_versions_json: string;
      after_versions_json: string;
    };
  before.close();
  const previewRefusal = await previewExecutionMigration({
    context,
    operator: "owner",
    operationId: "preview-before-retirement",
  }).then(
    () => null,
    (error: { code?: string }) => error,
  );
  expect(previewRefusal?.code).toBe("execution.migration-conflict");


  const staged = await stageStoreUpgrade({
    context,
    operator: "owner",
    operationId: "stage-stale",
    catalogDeltaDisposition: "preserved by a fresh registration (reference fresh-registration-42)",
  });
  expect(staged.manifest.pendingCatalogOperations).toEqual([]);
  expect(await listPendingCatalogRegistrations(context)).toEqual([]);
  const after = await openStore(context, "read");
  const row = after.db
    .prepare("select phase, catalog_delta_json, result_json, updated_at, created_at, before_versions_json, after_versions_json from catalog_operations where operation_id = ?")
    .get(operationId) as {
      phase: string;
      catalog_delta_json: string;
      result_json: string;
      updated_at: string;
      created_at: string;
      before_versions_json: string;
      after_versions_json: string;
    };
  after.close();
  expect(row.phase).toBe("aborted");
  expect(row.catalog_delta_json).toBe(originalRow.catalog_delta_json);
  expect(row).toMatchObject({
    updated_at: originalRow.updated_at,
    created_at: originalRow.created_at,
    before_versions_json: originalRow.before_versions_json,
    after_versions_json: originalRow.after_versions_json,
  });
  expect(JSON.parse(row.result_json)).toMatchObject({
    reason: expect.stringContaining("retired with the file route; unpublished catalog delta disposition: preserved by a fresh registration (reference fresh-registration-42)"),
  });
});

test("stageStoreUpgrade still refuses a non-stale pending registration", async () => {
  const { context, operationId } = await fixture("ordinary");
  await expect(
    stageStoreUpgrade({
      context,
      operator: "owner",
      operationId: "stage-ordinary",
      catalogDeltaDisposition: "knowingly discarded (authorized by owner)",
    }),
  ).rejects.toMatchObject({ code: "catalog.reconcile-conflict" });
  expect((await listPendingCatalogRegistrations(context)).map((row) => row.operationId)).toEqual([operationId]);
});
