import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getCatalog } from "./catalog.js";
import {
  abortCatalogExecution,
  listPendingCatalogRegistrations,
  purgeCatalogRegistration,
} from "./catalog-registration.js";
import { registerShippedCatalogExecution } from "./execution-registration.js";
import { readExecutionState, type ExecutionContext } from "./execution-store.js";
import { createFsStore, setArtifactStore } from "./store.js";
import { initializeStore, openStore, type StoreContext } from "./store-db.js";
import { WORKFLOW_SNAPSHOT_FILE } from "./workflow.js";

describe("ACTIVE catalog execution registration and legacy recovery", () => {
  let root: string | undefined;
  afterEach(() => {
    setArtifactStore(undefined);
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  async function fixture(name: string): Promise<{ harnessDir: string; context: StoreContext; execution: ExecutionContext }> {
    root = mkdtempSync(join(tmpdir(), `catalog-registration-${name}-`));
    const harnessDir = join(root, ".mstar");
    mkdirSync(harnessDir, { recursive: true });
    const context: StoreContext = { harnessDir };
    const initialized = await initializeStore(context);
    initialized.close();
    setArtifactStore(createFsStore(harnessDir));
    const workflowId = `wf-${name}`;
    return {
      harnessDir,
      context,
      execution: {
        ...context,
        caller: { sessionId: `coordinator-${name}`, role: "coordinator", workflowId },
      },
    };
  }

  function planWorkflow(harnessDir: string, workflowId: string, id: string, title: string) {
    const file = join(harnessDir, "plans", `${id}.md`);
    mkdirSync(join(harnessDir, "plans"), { recursive: true });
    writeFileSync(file, `# ${title}\n\n**plan_id:** ${id}\n`);
    return {
      kind: "plan" as const,
      workflowId,
      options: {
        harnessDir,
        plan: { id, title, file: `plans/${basename(file)}` },
        deliveryKind: "development" as const,
        project: "_default",
        branchSource: `feature/${workflowId}`,
        branchTarget: "main",
        startedAt: "2026-10-09T00:00:00.000Z",
      },
    };
  }

  test("the shipped seam atomically registers, replays, and conflicts by operation identity", async () => {
    const { harnessDir, context, execution } = await fixture("atomic");
    const workflow = planWorkflow(harnessDir, "wf-atomic", "20261009-atomic-plan", "Atomic plan");
    const before = await readExecutionState(context);
    const request = { actor: "project-manager", workflow, operationId: "op-atomic", expected: before.token, expectedCatalogRevision: 0 };

    const receipt = await registerShippedCatalogExecution(execution, request);
    expect(receipt).toMatchObject({ operationId: "op-atomic", workflowId: "wf-atomic", catalogRevision: 1, recovered: false });
    expect(await registerShippedCatalogExecution(execution, { actor: "project-manager", workflow, operationId: "op-atomic" })).toEqual(receipt);
    expect((await getCatalog(context, { kind: "plan", id: "20261009-atomic-plan" })).entity.title).toBe("Atomic plan");
    expect(existsSync(join(harnessDir, "status.json"))).toBe(false);
    expect(existsSync(join(harnessDir, "workflows", "wf-atomic", WORKFLOW_SNAPSHOT_FILE))).toBe(false);

    await expect(
      registerShippedCatalogExecution(execution, {
        actor: "different-actor",
        workflow,
        operationId: "op-atomic",
      }),
    ).rejects.toMatchObject({ code: "execution.operation-conflict" });
  });

  test("a pending legacy journal refuses ACTIVE registration, then abort permits the new DB route", async () => {
    const { harnessDir, context, execution } = await fixture("pending");
    const workflowId = "wf-pending";
    const workflow = planWorkflow(harnessDir, workflowId, "20261009-pending-plan", "Pending plan");
    const journal = {
      workflow: { workflowId, harnessDir, snapshotPath: join(harnessDir, "workflows", workflowId, "snapshot.json") },
      execution: workflow,
      catalog: { entities: [], binding: { catalogKind: "plan", catalogId: "20261009-pending-plan" } },
      actor: "project-manager",
      expectedCatalogRevision: 0,
    };
    const handle = await openStore(context, "write");
    try {
      handle.db.prepare(
        "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) values (?, ?, 'prepared', ?, '{}', '{}', null, ?, ?)",
      ).run("legacy-pending", "legacy-hash", JSON.stringify(journal), "2026-10-09", "2026-10-09");
    } finally {
      handle.close();
    }

    expect(await listPendingCatalogRegistrations(context)).toMatchObject([{ operationId: "legacy-pending", workflowId, phase: "prepared", rootVisible: false }]);
    await expect(registerShippedCatalogExecution(execution, { actor: "project-manager", workflow })).rejects.toMatchObject({
      code: "catalog.registration-pending",
      message: expect.stringContaining("mstar catalog reconcile --abort"),
    });
    expect(await abortCatalogExecution(context, "legacy-pending", "discard unwritten legacy request")).toEqual({
      operationId: "legacy-pending",
      workflowId,
      phase: "aborted",
    });
    const receipt = await registerShippedCatalogExecution(execution, { actor: "project-manager", workflow });
    expect(receipt).toMatchObject({ workflowId, catalogRevision: 1, recovered: false });
    expect((await readExecutionState(context)).data.workflows.map((item) => item.state.id)).toEqual([workflowId]);
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
  });

  // T21 owns the purge-entry veto under withWorkflowPurgeLocks.
  // Keep this refusal until T21 retires that veto; T17 removes only the replace-chain caller.
  test("ACTIVE purge refuses through the file-write veto without deleting the recorded snapshot", async () => {
    const { harnessDir, context } = await fixture("purge");
    const workflowId = "wf-purge";
    const snapshotPath = join(harnessDir, "workflows", workflowId, "snapshot.json");
    mkdirSync(join(harnessDir, "workflows", workflowId), { recursive: true });
    const snapshot = '{"schema_version":1,"id":"wf-purge"}\n';
    writeFileSync(snapshotPath, snapshot);
    const digest = createHash("sha256").update(snapshot).digest("hex");
    const journal = {
      workflow: { workflowId, harnessDir, snapshotPath },
      execution: {},
      catalog: {},
      actor: "project-manager",
      expectedCatalogRevision: 0,
    };
    const handle = await openStore(context, "write");
    try {
      handle.db.prepare(
        "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) values (?, ?, 'prepared', ?, '{}', ?, null, ?, ?)",
      ).run(
        "legacy-failed-snapshot",
        "legacy-hash",
        JSON.stringify(journal),
        JSON.stringify({ failure: { workflow_id: workflowId, snapshot_path: snapshotPath, snapshot_content_sha256: digest, reviewed_identity: "legacy-identity" } }),
        "2026-10-09",
        "2026-10-09",
      );
    } finally {
      handle.close();
    }

    await expect(
      purgeCatalogRegistration(context, {
        workflowId,
        operationId: "legacy-failed-snapshot",
        expectedCatalogRevision: 0,
        actor: "project-manager",
      }),
    ).rejects.toMatchObject({ code: "execution.direct-write-refused" });
    expect(existsSync(snapshotPath)).toBe(true);
  });
});
