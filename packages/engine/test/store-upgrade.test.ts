import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectExecutionCoverage } from "../src/execution-migrate.js";
import { activateStoreUpgrade, stageStoreUpgrade } from "../src/store-upgrade.js";
import { ACTIVATION_PROTOCOL_VERSION } from "../src/store-activation.js";
import { initializeStore, storeDbPath, type StoreContext } from "../src/store-db.js";
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
  return { context, workflowId, dbPath: storeDbPath(context), operator: "ops-engineer", operationId: "upgrade-fixture" };
}

function fixtureAttestation() {
  // These facts are local to this isolated fixture: it installs the current coordinator
  // consumer below and creates no sessions, so there are no session ids to stop.
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
  test("derives the declared empty scope and activates a legacy execution authority", async () => {
    const f = fixture();
    const store = await initializeStore(f.context);
    store.close();
    const before = new DatabaseSync(f.dbPath);
    expect(before.prepare("select authority_state from execution_meta where id=1").get()).toEqual({ authority_state: "legacy" });
    before.close();

    const staged = await stageStoreUpgrade(f);
    expect(staged.manifest.inventoryPath).toBeNull();
    expect(staged.coverageDigest).toMatch(/^[a-f0-9]{64}$/);
    const active = await activateStoreUpgrade(staged, fixtureAttestation());
    expect(active).toBeDefined();
    const after = new DatabaseSync(f.dbPath);
    expect(after.prepare("select authority_state from execution_meta where id=1").get()).toEqual({ authority_state: "active" });
    after.close();

    const unexaminedInventoryPath = join(f.context.harnessDir, "inventory-not-examined.json");
    await expect(collectExecutionCoverage({ ...f, inventoryPath: unexaminedInventoryPath, manifest: staged.manifest })).rejects.toThrow();
  });
});
