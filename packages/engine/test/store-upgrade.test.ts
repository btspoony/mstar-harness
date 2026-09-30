import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyExecutionMigration, executionManifestHash } from "../src/execution-migrate.js";
import { activateStoreUpgrade, stageStoreUpgrade } from "../src/store-upgrade.js";
import { ACTIVATION_PROTOCOL_VERSION } from "../src/store-activation.js";
import { initializeStore, MIGRATIONS, storeDbPath, type StoreContext } from "../src/store-db.js";
import { WORKFLOW_SNAPSHOT_FILE } from "../src/workflow.js";
import { DatabaseSync } from "node:sqlite";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "store-upgrade-"));
  roots.push(root);
  const harnessDir = join(root, ".mstar");
  const context: StoreContext = { harnessDir };
  mkdirSync(harnessDir, { recursive: true });
  const workflowId = "upgrade-fixture-workflow";
  const workflowDir = join(harnessDir, "workflows", workflowId);
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(harnessDir, "status.json"), JSON.stringify({
    version: 2,
    updated_at: "2026-09-30",
    workflows: [{ id: workflowId, type: "plan", started_at: "2026-09-30", dir: `workflows/${workflowId}` }],
  }));
  writeFileSync(join(workflowDir, WORKFLOW_SNAPSHOT_FILE), JSON.stringify({
    schema_version: 1,
    id: workflowId,
    type: "plan",
    status: "running",
    started_at: "2026-09-30",
    updated_at: "2026-09-30",
    delivery_kind: "development",
    project: "_default",
    branch: { source: "feature/upgrade-fixture", target: "main" },
    plans: [{ id: `${workflowId}-plan`, title: "Upgrade fixture", file: "plan.md", status: "Todo", metadata: {} }],
  }));
  return {
    context,
    workflowId,
    dbPath: storeDbPath(context),
    operator: "ops-engineer",
    operationId: "upgrade-fixture",
    catalogDeltaDisposition: "synthetic fixture disposition",
  };
}

function fixtureAttestation() {
  // These fixture-only consumer facts are authored here and passed to the real
  // API; the fixture installs no host consumer and creates no sessions.
  return {
    version: ACTIVATION_PROTOCOL_VERSION,
    attestedAt: "2026-09-30T00:00:00.000Z",
    operator: { actor: "ops-engineer", authorizationRef: "fixture-only-activation" },
    consumers: [{
      entryId: "fixture-coordinator",
      kind: "coordinator" as const,
      entrypoint: "/fixture/engine",
      runtime: "bun" as const,
      runtimeVersion: "1.4.0",
      version: "fixture",
      current: true,
      disposition: "reloaded" as const,
    }],
    stoppedSessions: [],
  };
}

describe("single-call store upgrade", () => {
  test("stages an older schema with pre-schema and reviewed-schema recovery points, then retires through phase two", async () => {
    const f = fixture();
    const store = await initializeStore(f.context);
    store.db.exec("drop trigger issues_milestone_project_insert; drop trigger issues_milestone_project_update; drop trigger project_milestones_identity_immutable; drop index issues_milestone_disposition; drop table project_milestones; alter table issues drop column milestone_id; delete from schema_version where version=7");
    store.close();

    const old = new DatabaseSync(f.dbPath);
    expect(old.prepare("select max(version) as version from schema_version").get()).toEqual({ version: 6 });
    old.close();

    const staged = await stageStoreUpgrade(f);

    if (staged.resumed === false) {
      expect(staged.schemaBackup.schemaVersion).toBe(6);
      expect(staged.backup.schemaVersion).toBe(MIGRATIONS.length);
    }
    expect(staged.manifest.schemaVersion).toBe(MIGRATIONS.length);
    expect(staged.manifest.inventoryPath).toBeNull();
    expect(staged.coverageDigest).toMatch(/^[a-f0-9]{64}$/);
    const retired = await activateStoreUpgrade(staged, fixtureAttestation());
    expect(retired).toMatchObject({ phase: "retired", manifestId: staged.manifest.id });

    const after = new DatabaseSync(f.dbPath);
    expect(after.prepare("select authority_state from execution_meta where id=1").get()).toEqual({ authority_state: "active" });
    after.close();
    expect(existsSync(join(f.context.harnessDir, "status.json"))).toBe(false);
    expect(existsSync(join(f.context.harnessDir, "archived", "execution", staged.manifest.id, "status.json"))).toBe(true);
  });

  test("resumes the reviewed inventory scope when retry omits --inventory", async () => {
    const f = fixture();
    const store = await initializeStore(f.context);
    store.close();
    const inventoryPath = join(f.context.harnessDir, "operator-inventory.json");
    const snapshotPath = join(f.context.harnessDir, "workflows", f.workflowId, WORKFLOW_SNAPSHOT_FILE);
    writeFileSync(inventoryPath, JSON.stringify({
      version: 2,
      roots: {
        sdd: join(f.context.harnessDir, "workflows"),
        host: join(f.context.harnessDir, "operator-host"),
        package: join(f.context.harnessDir, "operator-package"),
      },
      hostSessions: [],
      sddEvidence: [{ workflowId: f.workflowId, path: snapshotPath }],
      consumers: [],
      injectors: [],
      injectorInventory: null,
      backup: null,
    }));
    const staged = await stageStoreUpgrade({ ...f, inventoryPath });
    expect(staged.resumed).toBe(false);
    expect(staged.manifest.inventoryPath).toBe(inventoryPath);

    const resumed = await stageStoreUpgrade({ ...f, operationId: "upgrade-fixture-retry" });
    expect(resumed.resumed).toBe(true);
    expect(resumed.inventoryPath).toBe(inventoryPath);
    const retired = await activateStoreUpgrade(resumed, fixtureAttestation());
    expect(retired).toMatchObject({ phase: "retired", manifestId: staged.manifest.id });
  });
});
