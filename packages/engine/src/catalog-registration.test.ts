import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getCatalog } from "./catalog.js";
import {
  abortCatalogExecution,
  listPendingCatalogRegistrations,
  purgeCatalogRegistration,
  readCatalogRevisions,
} from "./catalog-registration.js";
import { registerShippedCatalogExecution } from "./execution-registration.js";
import { bindExecutionSession, readExecutionState, type ExecutionContext } from "./execution-store.js";
import { mutateExecutionWorkflow } from "./execution-workflow.js";
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
    const beforeAbort = await readCatalogRevisions(context);
    const abandoned = await abortCatalogExecution(context, "legacy-pending", "discard unwritten legacy request");
    expect(abandoned).toEqual({ operationId: "legacy-pending", workflowId, phase: "aborted", sourceBytesRetained: true });
    expect(await abortCatalogExecution(context, "legacy-pending")).toEqual(abandoned);
    expect(await readCatalogRevisions(context)).toEqual({
      storeRevision: beforeAbort.storeRevision + 1,
      catalogRevision: beforeAbort.catalogRevision,
    });
    const receipt = await registerShippedCatalogExecution(execution, { actor: "project-manager", workflow });
    expect(receipt).toMatchObject({ workflowId, catalogRevision: 1, recovered: false });
    expect((await readExecutionState(context)).data.workflows.map((item) => item.state.id)).toEqual([workflowId]);
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
  });

  test("catalog purge-registration settles the legacy journal but preserves snapshot bytes and replays", async () => {
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

    const before = await readCatalogRevisions(context);
    const input = { workflowId, operationId: "legacy-failed-snapshot", expectedCatalogRevision: 0, actor: "project-manager" };
    const receipt = await purgeCatalogRegistration(context, input);
    expect(receipt).toMatchObject({ workflowId, preservedDigest: digest, sourceBytesRetained: true, actor: "project-manager" });
    expect(await purgeCatalogRegistration(context, input)).toEqual(receipt);
    expect(await readCatalogRevisions(context)).toEqual({ storeRevision: before.storeRevision + 1, catalogRevision: before.catalogRevision });
    expect(readFileSync(snapshotPath, "utf8")).toBe(snapshot);
    expect(existsSync(join(harnessDir, "status.json"))).toBe(false);
  });

  test("purge-registration refuses changed snapshot bytes and reconcile abort preserves them", async () => {
    const { harnessDir, context } = await fixture("purge-conflict");
    const workflowId = "wf-purge-conflict";
    const snapshotPath = join(harnessDir, "workflows", workflowId, "snapshot.json");
    mkdirSync(join(harnessDir, "workflows", workflowId), { recursive: true });
    const snapshot = '{"schema_version":1,"id":"wf-purge-conflict"}\n';
    writeFileSync(snapshotPath, `${snapshot}changed`);
    const digest = createHash("sha256").update(snapshot).digest("hex");
    const journal = { workflow: { workflowId, harnessDir, snapshotPath }, execution: {}, catalog: {}, actor: "project-manager", expectedCatalogRevision: 0 };
    const handle = await openStore(context, "write");
    try {
      handle.db.prepare(
        "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) values (?, ?, 'prepared', ?, '{}', ?, null, ?, ?)",
      ).run("legacy-conflict", "legacy-hash", JSON.stringify(journal),
        JSON.stringify({ failure: { workflow_id: workflowId, snapshot_path: snapshotPath, snapshot_content_sha256: digest, reviewed_identity: "legacy-identity" } }),
        "2026-10-09", "2026-10-09");
    } finally {
      handle.close();
    }
    const before = await readCatalogRevisions(context);
    await expect(purgeCatalogRegistration(context, {
      workflowId, operationId: "legacy-conflict", expectedCatalogRevision: 0, actor: "project-manager",
    })).rejects.toMatchObject({ code: "catalog.purge-identity-mismatch" });
    expect(readFileSync(snapshotPath, "utf8")).toBe(`${snapshot}changed`);
    expect(await listPendingCatalogRegistrations(context)).toMatchObject([{ operationId: "legacy-conflict" }]);
    expect(await readCatalogRevisions(context)).toEqual(before);
    expect(await abortCatalogExecution(context, "legacy-conflict")).toEqual({
      operationId: "legacy-conflict", workflowId, phase: "aborted", sourceBytesRetained: true,
    });
    expect(readFileSync(snapshotPath, "utf8")).toBe(`${snapshot}changed`);
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
    expect(await readCatalogRevisions(context)).toEqual({
      storeRevision: before.storeRevision + 1,
      catalogRevision: before.catalogRevision,
    });
  });

  test("reconcile refuses registered active work but abort retains unregistered leases and permits disposition retry", async () => {
    const { harnessDir, context, execution } = await fixture("active-reconcile");
    const workflowId = "wf-active-reconcile";
    await registerShippedCatalogExecution(execution, {
      actor: "project-manager",
      workflow: planWorkflow(harnessDir, workflowId, "20261009-active-reconcile", "Active reconcile"),
    });
    const workflowBeforeClose = (await readExecutionState(context)).data.workflows.find(({ state }) => state.id === workflowId);
    if (workflowBeforeClose === undefined) throw new Error("registered workflow disappeared");
    const binding = await bindExecutionSession(execution, {
      workflowId,
      expected: workflowBeforeClose.workflowToken,
      operationId: "bind-active-reconcile",
    });
    const activeJournal = { workflow: { workflowId, harnessDir }, execution: {}, catalog: {}, actor: "project-manager", expectedCatalogRevision: 0 };
    const activeHandle = await openStore(context, "write");
    try {
      activeHandle.db.prepare(
        "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) values (?, ?, 'prepared', ?, '{}', '{}', null, ?, ?)",
      ).run("active-reconcile-pending", "legacy-hash", JSON.stringify(activeJournal), "2026-10-09", "2026-10-09");
    } finally {
      activeHandle.close();
    }
    const activeBefore = await readCatalogRevisions(context);
    await expect(abortCatalogExecution(context, "active-reconcile-pending")).rejects.toMatchObject({
      code: "catalog.reconcile-conflict",
      message: expect.stringContaining("mstar workflow lifecycle"),
    });
    expect(await listPendingCatalogRegistrations(context)).toMatchObject([{ operationId: "active-reconcile-pending", rootVisible: true }]);
    expect(await readCatalogRevisions(context)).toEqual(activeBefore);
    const liveAfterRefusal = (await readExecutionState(context)).data.workflows.find(({ state }) => state.id === workflowId);
    if (liveAfterRefusal === undefined) throw new Error("registered workflow disappeared after refusal");
    await mutateExecutionWorkflow(execution, {
      operationId: "stop-active-reconcile",
      workflowId,
      session: binding.data,
      expected: liveAfterRefusal.workflowToken,
      operation: { kind: "lifecycle", status: "stopped", reason: "finish the registered workflow before settling its pending catalog journal" },
    });
    expect(await abortCatalogExecution(context, "active-reconcile-pending")).toMatchObject({
      workflowId, phase: "aborted", sourceBytesRetained: true,
    });
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);

    const statusPath = join(harnessDir, "status.json");
    const statusOriginal = '{"preexisting":"historical-root"}\n';
    writeFileSync(statusPath, statusOriginal);
    const cases = [
      { workflowId: "wf-orphan-held", lease: JSON.stringify({ holder: "foreign-holder", status: "held" }), kind: "integration" as const },
      { workflowId: "wf-orphan-unreadable", lease: "{unreadable", kind: "integration" as const },
      { workflowId: "wf-orphan-plan", lease: JSON.stringify({ holder: "plan-holder", status: "held" }), kind: "plan" as const },
    ];
    for (const [index, item] of cases.entries()) {
      const planId = `20261009-orphan-${index}`;
      const workflow = planWorkflow(harnessDir, item.workflowId, planId, `Orphan ${index}`);
      const orphanExecution = { ...execution, caller: { ...execution.caller, workflowId: item.workflowId } };
      await registerShippedCatalogExecution(orphanExecution, {
        actor: "project-manager", workflow, operationId: `register-${item.workflowId}`,
      });
      const snapshotPath = join(harnessDir, "workflows", item.workflowId, "snapshot.json");
      mkdirSync(join(harnessDir, "workflows", item.workflowId), { recursive: true });
      const snapshot = `{"legacy":"${item.workflowId}"}\n`;
      writeFileSync(snapshotPath, snapshot);
      const documentPath = join(harnessDir, "plans", `${planId}.md`);
      const documentOriginal = readFileSync(documentPath, "utf8");
      const journal = { workflow: { workflowId: item.workflowId, harnessDir, snapshotPath }, execution: {}, catalog: {}, actor: "project-manager", expectedCatalogRevision: 0 };
      const setup = await openStore(context, "write");
      try {
        setup.db.prepare(
          "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) values (?, ?, 'prepared', ?, '{}', '{}', null, ?, ?)",
        ).run(`pending-${item.workflowId}`, "legacy-hash", JSON.stringify(journal), "2026-10-09", "2026-10-09");
        setup.db.prepare("delete from execution_registry where workflow_id = ?").run(item.workflowId);
        if (item.kind === "integration") {
          setup.db.prepare(
            "insert into execution_integration_leases(workflow_id, revision, owner_epoch, lease_json) values (?, 1, ?, ?)",
          ).run(item.workflowId, setup.epoch, item.lease);
        } else {
          setup.db.exec("create table if not exists execution_leases(workflow_id text not null, plan_id text not null, revision integer not null, owner_epoch integer not null, lease_json text not null, primary key(workflow_id, plan_id))");
          setup.db.prepare(
            "insert into execution_leases(workflow_id, plan_id, revision, owner_epoch, lease_json) values (?, ?, 1, ?, ?)",
          ).run(item.workflowId, planId, setup.epoch, item.lease);
        }
      } finally {
        setup.close();
      }
      const before = await readCatalogRevisions(context);
      const nativeBeforeHandle = await openStore(context, "read");
      const nativeBefore = nativeBeforeHandle.db.prepare(
        "select workflow_id, revision, owner_epoch, lease_json from execution_integration_leases where workflow_id = ?",
      ).get(item.workflowId) ?? nativeBeforeHandle.db.prepare(
        "select workflow_id, plan_id, revision, owner_epoch, lease_json from execution_leases where workflow_id = ?",
      ).get(item.workflowId);
      const historyBefore = nativeBeforeHandle.db.prepare(
        "select workflow_id, revision, state_json from execution_workflows where workflow_id = ?",
      ).get(item.workflowId);
      const sessionsBefore = nativeBeforeHandle.db.prepare(
        "select role, session_id, epoch, state from execution_sessions where workflow_id = ? order by role, session_id",
      ).all(item.workflowId);
      nativeBeforeHandle.close();

      if (index === 0) {
        const trigger = await openStore(context, "write");
        try {
          trigger.db.exec(
            `create trigger reject_catalog_disposition before update on catalog_operations ` +
              `when old.operation_id = 'pending-${item.workflowId}' begin select raise(abort, 'injected disposition rollback'); end`,
          );
        } finally {
          trigger.close();
        }
        await expect(abortCatalogExecution(context, `pending-${item.workflowId}`)).rejects.toThrow("injected disposition rollback");
        expect(await readCatalogRevisions(context)).toEqual(before);
        const stillPending = await listPendingCatalogRegistrations(context);
        expect(stillPending).toContainEqual(expect.objectContaining({ operationId: `pending-${item.workflowId}`, phase: "prepared" }));
        const removeTrigger = await openStore(context, "write");
        try { removeTrigger.db.exec("drop trigger reject_catalog_disposition"); } finally { removeTrigger.close(); }
      }
      const [abandoned, replayed] = await Promise.all([
        abortCatalogExecution(context, `pending-${item.workflowId}`, "abandon only the catalog journal"),
        abortCatalogExecution(context, `pending-${item.workflowId}`, "abandon only the catalog journal"),
      ]);
      expect(replayed).toEqual(abandoned);
      expect(await listPendingCatalogRegistrations(context)).not.toContainEqual(expect.objectContaining({ operationId: `pending-${item.workflowId}` }));
      expect(await readCatalogRevisions(context)).toEqual({
        storeRevision: before.storeRevision + 1,
        catalogRevision: before.catalogRevision,
      });
      expect(readFileSync(snapshotPath, "utf8")).toBe(snapshot);
      expect(readFileSync(statusPath, "utf8")).toBe(statusOriginal);
      expect(readFileSync(documentPath, "utf8")).toBe(documentOriginal);
      const nativeAfterHandle = await openStore(context, "read");
      const nativeAfter = nativeAfterHandle.db.prepare(
        "select workflow_id, revision, owner_epoch, lease_json from execution_integration_leases where workflow_id = ?",
      ).get(item.workflowId) ?? nativeAfterHandle.db.prepare(
        "select workflow_id, plan_id, revision, owner_epoch, lease_json from execution_leases where workflow_id = ?",
      ).get(item.workflowId);
      expect(nativeAfter).toEqual(nativeBefore);
      expect(nativeAfterHandle.db.prepare(
        "select workflow_id, revision, state_json from execution_workflows where workflow_id = ?",
      ).get(item.workflowId)).toEqual(historyBefore);
      expect(nativeAfterHandle.db.prepare(
        "select role, session_id, epoch, state from execution_sessions where workflow_id = ? order by role, session_id",
      ).all(item.workflowId)).toEqual(sessionsBefore);
      nativeAfterHandle.close();
      await expect(registerShippedCatalogExecution(orphanExecution, {
        actor: "project-manager", workflow, operationId: `retry-${item.workflowId}`,
      })).rejects.toMatchObject({ code: "execution.not-empty" });
    }
  });
  test("purge refuses when the store generation changes between its selection and final transaction", async () => {
    const { harnessDir, context } = await fixture("purge-generation-race");
    const workflowId = "wf-purge-generation-race";
    const operationId = "op-purge-generation-race";
    const snapshotPath = join(harnessDir, "workflows", workflowId, "snapshot.json");
    mkdirSync(join(harnessDir, "workflows", workflowId), { recursive: true });
    const snapshot = `{"identity":"${workflowId}"}\n`;
    const fifo = spawnSync("mkfifo", [snapshotPath], { encoding: "utf8" });
    expect(fifo.status).toBe(0);
    const digest = createHash("sha256").update(snapshot).digest("hex");
    const journal = { workflow: { workflowId, harnessDir, snapshotPath }, execution: {}, catalog: {}, actor: "project-manager", expectedCatalogRevision: 0 };
    const setup = await openStore(context, "write");
    try {
      setup.db.prepare(
        "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) values (?, ?, 'prepared', ?, '{}', ?, null, ?, ?)",
      ).run(
        operationId,
        "generation-race",
        JSON.stringify(journal),
        JSON.stringify({ failure: { workflow_id: workflowId, snapshot_path: snapshotPath, snapshot_content_sha256: digest, reviewed_identity: "legacy-identity" } }),
        "2026-10-12",
        "2026-10-12",
      );
    } finally { setup.close(); }

    const revisionsBefore = await readCatalogRevisions(context);
    const storeDbModule = new URL("./store-db.ts", import.meta.url).href;
    const writerSource =
      `import { openSync, writeSync, closeSync } from "node:fs"; ` +
      `import { openStore } from ${JSON.stringify(storeDbModule)}; ` +
      `const fd=openSync(process.env.CATALOG_FIFO,"w"); ` +
      `const h=await openStore({harnessDir:process.env.CATALOG_HARNESS},"write"); ` +
      `h.db.exec("begin immediate"); ` +
      `h.db.prepare("update store_meta set authority_epoch=authority_epoch+1, revision=revision+1 where id=1").run(); ` +
      `h.db.exec("commit"); h.close(); ` +
      `writeSync(fd, Buffer.from(process.env.CATALOG_SNAPSHOT)); closeSync(fd);`;
    const writer = spawn(process.execPath, ["-e", writerSource], {
      cwd: process.cwd(),
      env: { ...process.env, CATALOG_FIFO: snapshotPath, CATALOG_HARNESS: harnessDir, CATALOG_SNAPSHOT: snapshot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let writerOutput = "";
    writer.stdout?.on("data", (chunk: Buffer) => { writerOutput += chunk.toString(); });
    writer.stderr?.on("data", (chunk: Buffer) => { writerOutput += chunk.toString(); });
    const writerExit = new Promise<number | null>((resolveExit) => writer.once("exit", resolveExit));
    await expect(purgeCatalogRegistration(context, {
      workflowId,
      operationId,
      expectedCatalogRevision: revisionsBefore.catalogRevision,
      actor: "project-manager",
    })).rejects.toMatchObject({ code: "store.operation-conflict" });
    expect(await writerExit).toBe(0);
    expect(writerOutput).toBe("");
    expect(await listPendingCatalogRegistrations(context)).toContainEqual(
      expect.objectContaining({ operationId, phase: "prepared" }),
    );
    expect(await readCatalogRevisions(context)).toEqual({
      storeRevision: revisionsBefore.storeRevision + 1,
      catalogRevision: revisionsBefore.catalogRevision,
    });
  });
});
