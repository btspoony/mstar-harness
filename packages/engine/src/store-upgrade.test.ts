import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { openStore, initializeStore, type StoreContext } from "./store-db.js";
import { WORKFLOW_SNAPSHOT_FILE } from "./workflow.js";
import { listPendingCatalogRegistrations, retireStaleCatalogExecutionsForMigration } from "./catalog-registration.js";
import { previewExecutionMigration } from "./execution-migrate.js";
import { stageStoreUpgrade, activateStoreUpgrade } from "./store-upgrade.js";
import type { ActivationAttestation } from "./store-activation.js";
function validAttestation(): ActivationAttestation {
  return {
    version: 1,
    attestedAt: "2026-09-21T00:00:00.000Z",
    operator: { actor: "owner", authorizationRef: "D29 execution activation" },
    consumers: [
      {
        entryId: "cli-global",
        kind: "cli",
        entrypoint: "/usr/local/lib/node_modules/@mstar-harness/cli/dist/index.js",
        runtime: "bun",
        runtimeVersion: "1.4.0",
        version: "3.11.0",
        current: false,
        disposition: "upgraded",
      },
      {
        entryId: "coordinator-omp",
        kind: "coordinator",
        entrypoint: "/Users/op/.omp/plugins/mstar/packages/cli/dist/index.js",
        runtime: "node",
        runtimeVersion: "24.18.0",
        version: "3.11.0",
        current: true,
        disposition: "reloaded",
      },
    ],
    stoppedSessions: [],
  };
}

test("a fresh staged retry resumes persisted migration identity after failed activation and changed legacy bytes", async () => {
  const { context } = await fixture("restart-resume");
  const advance = await openStore(context, "write");
  advance.db.prepare("update store_meta set catalog_revision = catalog_revision + 1 where id = 1").run();
  advance.close();
  const first = await stageStoreUpgrade({
    context,
    operator: "owner",
    operationId: "stage-restart",
    catalogDeltaDisposition: "not applicable",
  });
  expect(first.resumed).toBe(false);
  const store = await openStore(context, "read");
  const persisted = store.db
    .prepare("select manifest_id, manifest_hash, manifest_json, coverage_json, phase from execution_migrations")
    .get() as { manifest_id: string; manifest_hash: string; manifest_json: string; coverage_json: string; phase: string };
  store.close();
  expect(persisted.phase).toBe("staged");
  const manifest = JSON.parse(persisted.manifest_json);
  const coverage = JSON.parse(persisted.coverage_json);

  await expect(activateStoreUpgrade(first, {} as ActivationAttestation)).rejects.toMatchObject({
    code: "store.attestation-invalid",
  });

  const snapshotPath = join(context.harnessDir, "workflows", "wf-restart-resume", WORKFLOW_SNAPSHOT_FILE);
  const changed = JSON.parse(readFileSync(snapshotPath, "utf8"));
  changed.updated_at = "2026-10-01";
  writeFileSync(snapshotPath, JSON.stringify(changed));

  // This is a new invocation: authority and coverage are recovered from SQLite,
  // not from `first` or any process-local cache.
  const resumed = await stageStoreUpgrade({
    context,
    operator: "owner",
    operationId: "stage-restart-retry",
    catalogDeltaDisposition: "not applicable",
  });
  expect(resumed.resumed).toBe(true);
  expect(resumed.manifest).toEqual(manifest);
  expect(resumed.manifest.id).toBe(persisted.manifest_id);
  expect(resumed.manifestHash).toBe(persisted.manifest_hash);
  expect(resumed.coverageDigest).toBe(coverage.digest);

  await expect(activateStoreUpgrade(resumed, validAttestation())).rejects.toMatchObject({
    code: "execution.migration-conflict",
    message: expect.stringContaining("source witness mismatch"),
  });
});
test("migration retirement refuses a foreign snapshot identity without changing journal bytes", async () => {
  const { context, operationId } = await fixture("identity-refusal");
  const advance = await openStore(context, "write");
  advance.db.prepare("update store_meta set catalog_revision = catalog_revision + 1 where id = 1").run();
  advance.close();

  const snapshotPath = join(context.harnessDir, "workflows", "wf-identity-refusal", WORKFLOW_SNAPSHOT_FILE);
  const foreignSnapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
  foreignSnapshot.id = "wf-another-registration";
  writeFileSync(snapshotPath, JSON.stringify(foreignSnapshot));
  const beforeHandle = await openStore(context, "read");
  const beforeBytes = JSON.stringify(beforeHandle.db.prepare("select * from catalog_operations where operation_id = ?").get(operationId));
  beforeHandle.close();

  const refusal = await retireStaleCatalogExecutionsForMigration(context, [operationId], "authorized disposition").then(
    () => null,
    (error: { code?: string; message?: string }) => error,
  );
  expect(refusal).toMatchObject({ code: "catalog.reconcile-conflict" });
  expect(refusal?.message).toContain("snapshot and matching root execution entry");
  expect(refusal?.message).toContain("belong to a different workflow");

  const afterHandle = await openStore(context, "read");
  const afterBytes = JSON.stringify(afterHandle.db.prepare("select * from catalog_operations where operation_id = ?").get(operationId));
  afterHandle.close();
  expect(afterBytes).toBe(beforeBytes);
});

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
