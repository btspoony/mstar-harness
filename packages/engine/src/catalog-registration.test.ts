import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as storeDb from "./store-db.js";
import { getCatalog } from "./catalog.js";
import { initializeCollaborationStore, writeCollaborationBinding } from "./collaboration-store.js";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import { bindRemoteAuthority } from "./collaboration-remote.js";
import { createRemoteScope } from "./remote-scope.fixture.js";
import {
  abortCatalogExecution,
  listPendingCatalogRegistrations,
  purgeCatalogRegistration,
  readCatalogRevisions,
  readPendingRegistration,
} from "./catalog-registration.js";
import { registerShippedCatalogExecution } from "./execution-registration.js";
import { bindExecutionSession, readExecutionState, type ExecutionContext } from "./execution-store.js";
import { mutateExecutionWorkflow } from "./execution-workflow.js";
import { createFsStore, setArtifactStore } from "./store.js";
import { initializeStore, openStore, tableNamesOn, type StoreContext } from "./store-db.js";
import { WORKFLOW_SNAPSHOT_FILE } from "./workflow.js";

/**
 * note: The collaboration lane is user-level, so every fixture pins `homedir` to a
 * temporary home: a real spy on the live module binding, restored after each
 * case. A registration publishes into this repository's ACTIVE lane.
 */
const HOME = mkdtempSync(join(tmpdir(), "catalog-registration-home-"));
let homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);

/** The refusal of a call that must refuse, as its code and message. */
async function refusalOf(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run();
  } catch (error) {
    const candidate = error as { code?: unknown; message?: unknown };
    if (typeof candidate?.code === "string" && typeof candidate.message === "string") {
      return { code: candidate.code, message: candidate.message };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("ACTIVE catalog execution registration and legacy recovery", () => {
  let root: string | undefined;
  afterEach(() => {
    setArtifactStore(undefined);
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
    homeSpy.mockRestore();
    homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);
  });

  async function fixture(name: string): Promise<{ harnessDir: string; context: StoreContext; execution: ExecutionContext }> {
    root = mkdtempSync(join(tmpdir(), `catalog-registration-${name}-`));
    const harnessDir = join(root, ".mstar");
    mkdirSync(harnessDir, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, ".mstarc"), `[collaboration]\nmode=local\nrepo_id=catalog-registration-${name}\n`);
    const context: StoreContext = { harnessDir };
    const initialized = await initializeStore(context);
    initialized.close();
    const location = resolveCollaborationLocation(context);
    await initializeCollaborationStore(location);
    const lane = new DatabaseSync(location.dbPath);
    let storeId = "";
    let epoch = 0;
    try {
      lane.prepare("update collaboration_meta set authority_state = 'active', activated_at = ? where id = 1").run(
        new Date().toISOString(),
      );
      const row = lane.prepare("select store_id, authority_epoch from collaboration_meta where id = 1").get() as
        | { store_id?: unknown; authority_epoch?: unknown }
        | undefined;
      if (typeof row?.store_id === "string") storeId = row.store_id;
      if (typeof row?.authority_epoch === "number") epoch = row.authority_epoch;
    } finally {
      lane.close();
    }
    writeCollaborationBinding(context, { repoKey: location.repoKey, mode: location.mode, storeId, epoch, binding: "active" });
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
        branchBase: "main",
        branchWork: `feature/${workflowId}`,
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

    // The registered header records the CURRENT branch vocabulary, in the one
    // place a plan workflow's anchors are fixed: the branch it was created from,
    // its delivery branch and its PR target - never the pre-rename `source`
    // spelling.
    const [registered] = (await readExecutionState(context)).data.workflows;
    expect(registered!.state.branch).toEqual({ base: "main", work: "feature/wf-atomic", target: "main" });

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
    // invariant: The refusal states only the pending phase: this entry holds no registry
    // row for the workflow, so it may not claim root visibility. (The gates that DO read
    // a registry row — dispatch, handle-taking — still name it; see catalog-consumers.)
    const unregistered = await refusalOf(() => registerShippedCatalogExecution(execution, { actor: "project-manager", workflow }));
    expect(unregistered.code).toBe("catalog.registration-pending");
    expect(unregistered.message).not.toContain("root-visible");
    expect(unregistered.message).toContain("legacy-pending");
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
    expect(receipt).toMatchObject({ workflowId,  sourceBytesRetained: true, actor: "project-manager" });
    expect(await purgeCatalogRegistration(context, input)).toEqual(receipt);
    expect(await readCatalogRevisions(context)).toEqual({ storeRevision: before.storeRevision + 1, catalogRevision: before.catalogRevision });
    expect(readFileSync(snapshotPath, "utf8")).toBe(snapshot);
    expect(existsSync(join(harnessDir, "status.json"))).toBe(false);
  });

  test("purge-registration settles an edited snapshot in the native journal and preserves the edited bytes", async () => {
    const { harnessDir, context } = await fixture("purge-edited");
    const workflowId = "wf-purge-edited";
    const snapshotPath = join(harnessDir, "workflows", workflowId, "snapshot.json");
    mkdirSync(join(harnessDir, "workflows", workflowId), { recursive: true });
    const recorded = '{"schema_version":1,"id":"wf-purge-edited"}\n';
    // The operator edited the document after the producer failed: those bytes
    // are no longer the recorded digest, and settlement must neither re-certify
    // nor block on them.
    const edited = `${recorded}edited-after-failure\n`;
    writeFileSync(snapshotPath, edited);
    const digest = createHash("sha256").update(recorded).digest("hex");
    const journal = { workflow: { workflowId, harnessDir, snapshotPath }, execution: {}, catalog: {}, actor: "project-manager", expectedCatalogRevision: 0 };
    const handle = await openStore(context, "write");
    try {
      handle.db.prepare(
        "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) values (?, ?, 'prepared', ?, '{}', ?, null, ?, ?)",
      ).run("legacy-edited", "legacy-hash", JSON.stringify(journal),
        JSON.stringify({ failure: { workflow_id: workflowId, snapshot_path: snapshotPath, snapshot_content_sha256: digest, reviewed_identity: "legacy-identity" } }),
        "2026-10-09", "2026-10-09");
    } finally {
      handle.close();
    }
    const before = await readCatalogRevisions(context);
    const input = { workflowId, operationId: "legacy-edited", expectedCatalogRevision: 0, actor: "project-manager" };
    const receipt = await purgeCatalogRegistration(context, input);
    expect(receipt).toMatchObject({ workflowId,  sourceBytesRetained: true, actor: "project-manager" });
    expect(await purgeCatalogRegistration(context, input)).toEqual(receipt);
    expect(await readCatalogRevisions(context)).toEqual({ storeRevision: before.storeRevision + 1, catalogRevision: before.catalogRevision });
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
    expect(readFileSync(snapshotPath, "utf8")).toBe(edited);
    expect(existsSync(join(harnessDir, "status.json"))).toBe(false);
  });

  test("a fenced source registers into the lane that now owns the catalog journal", async () => {
    const { harnessDir, context, execution } = await fixture("post-cutover");
    const location = resolveCollaborationLocation(context);
    const planId = "20261009-post-cutover-plan";
    const workflow = planWorkflow(harnessDir, "wf-post-cutover", planId, "Post-cutover plan");

    // why: This is the post-cutover shape: the collaboration lane owns the
    // catalog journal while the fenced execution store no longer carries it.
    const fenced = new DatabaseSync(join(harnessDir, "store.db"));
    try {
      fenced.exec("drop table catalog_operations");
    } finally {
      fenced.close();
    }
    const lane = new DatabaseSync(location.dbPath);
    try {
      lane.exec(
        "create table if not exists catalog_operations(operation_id text primary key, request_hash text not null, " +
          "phase text not null check (phase in ('prepared','execution-written','committed','aborted')), " +
          "catalog_delta_json text not null, before_versions_json text not null, after_versions_json text not null, " +
          "result_json text, created_at text not null, updated_at text not null)",
      );
    } finally {
      lane.close();
    }

    const receipt = await registerShippedCatalogExecution(execution, {
      actor: "project-manager",
      workflow,
      operationId: "op-post-cutover",
    });
    expect(receipt).toMatchObject({ operationId: "op-post-cutover", workflowId: "wf-post-cutover", recovered: false });

    // invariant: The journal row lands on the lane, committed; the execution store no
    // longer carries the table at all.
    const laneRows = new DatabaseSync(location.dbPath);
    try {
      expect(laneRows.prepare("select operation_id, phase from catalog_operations order by operation_id").all())
        .toMatchObject([{ phase: "committed" }]);
    } finally {
      laneRows.close();
    }
    const executionStore = await openStore(context, "read");
    try {
      expect(tableNamesOn(executionStore.db).has("catalog_operations")).toBe(false);
    } finally {
      executionStore.close();
    }
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
    expect((await getCatalog(context, { kind: "plan", id: planId })).entity.title).toBe("Post-cutover plan");
  });

  test("a fenced catalog journal answers and compares the lane revision, not the stale execution one", async () => {
    const { harnessDir, context } = await fixture("post-fence-revisions");
    const location = resolveCollaborationLocation(context);
    const workflowId = "wf-post-fence-revisions";
    const operationId = "op-post-fence-revisions";
    const snapshotPath = join(harnessDir, "workflows", workflowId, "snapshot.json");
    mkdirSync(join(harnessDir, "workflows", workflowId), { recursive: true });
    const snapshot = `{"identity":"${workflowId}"}\n`;
    writeFileSync(snapshotPath, snapshot);
    const digest = createHash("sha256").update(snapshot).digest("hex");

    // why: The post-fence shape: the lane owns the journal and its counters, while the fenced
    // execution store keeps ADVANCING its own — and now meaningless — revision pair.
    const fenced = new DatabaseSync(join(harnessDir, "store.db"));
    try {
      fenced.exec("drop table catalog_operations");
      fenced.prepare("update store_meta set revision = 41, catalog_revision = 99 where id = 1").run();
    } finally {
      fenced.close();
    }
    const lane = new DatabaseSync(location.dbPath);
    try {
      lane.exec(
        "create table if not exists catalog_operations(operation_id text primary key, request_hash text not null, " +
          "phase text not null check (phase in ('prepared','execution-written','committed','aborted')), " +
          "catalog_delta_json text not null, before_versions_json text not null, after_versions_json text not null, " +
          "result_json text, created_at text not null, updated_at text not null)",
      );
      lane.prepare("update collaboration_meta set revision = 7, catalog_revision = 5 where id = 1").run();
      lane.prepare(
        "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) values (?, ?, 'prepared', ?, '{}', ?, null, ?, ?)",
      ).run(
        operationId,
        "post-fence-hash",
        JSON.stringify({ workflow: { workflowId, harnessDir, snapshotPath }, execution: {}, catalog: {}, actor: "project-manager", expectedCatalogRevision: 5 }),
        JSON.stringify({ failure: { workflow_id: workflowId, snapshot_path: snapshotPath, snapshot_content_sha256: digest, reviewed_identity: "legacy-identity" } }),
        "2026-11-23",
        "2026-11-23",
      );
    } finally {
      lane.close();
    }

    // invariant: The reported revisions are the OWNER's, never the fenced store's.
    expect(await readCatalogRevisions(context)).toEqual({ storeRevision: 7, catalogRevision: 5 });

    // invariant: A stale execution revision can neither refuse the lane's correct one...
    await expect(purgeCatalogRegistration(context, {
      workflowId, operationId, expectedCatalogRevision: 99, actor: "project-manager",
    })).rejects.toMatchObject({ code: "catalog.revision-conflict", message: expect.stringContaining("current revision is 5") });
    // ...nor approve the settlement: the lane revision is what the CAS compares.
    const receipt = await purgeCatalogRegistration(context, {
      workflowId, operationId, expectedCatalogRevision: 5, actor: "project-manager",
    });
    expect(receipt).toMatchObject({ workflowId, sourceBytesRetained: true });
    expect(await readCatalogRevisions(context)).toEqual({ storeRevision: 8, catalogRevision: 5 });

    // note: The settlement advanced the lane's counter only; the fenced pair is untouched.
    const untouched = new DatabaseSync(join(harnessDir, "store.db"));
    try {
      expect(untouched.prepare("select revision, catalog_revision from store_meta where id = 1").get())
        .toEqual({ revision: 41, catalog_revision: 99 });
    } finally {
      untouched.close();
    }
    expect(readFileSync(snapshotPath, "utf8")).toBe(snapshot);
  });

  test("a remote checkout's empty journal reads as none without taking a write lock", async () => {
    root = mkdtempSync(join(tmpdir(), "catalog-registration-remote-journal-"));
    const scope = createRemoteScope(root, "remote-journal-read");
    const context = scope.context();
    const commit = scope.publish();
    await bindRemoteAuthority(context, scope.batch(commit));
    await initializeStore(context).then((handle) => handle.close());
    // why: The fenced shape a remote checkout lands in — the cache owns the journal, and the
    // execution store no longer carries the table at all.
    const fenced = new DatabaseSync(join(scope.harness, "store.db"));
    try {
      fenced.exec("drop table catalog_operations");
    } finally {
      fenced.close();
    }

    expect(await readPendingRegistration(context, "wf-remote-journal")).toBeNull();

    // invariant: The verdict takes no write lock: a competing RESERVED writer cannot refuse a read.
    const location = resolveCollaborationLocation(context);
    const holder = new DatabaseSync(location.dbPath);
    try {
      holder.exec("begin immediate");
      expect(await readPendingRegistration(context, "wf-remote-journal")).toBeNull();
    } finally {
      holder.exec("rollback");
      holder.close();
    }

    // invariant: A genuinely pending journal on the cache is still reported.
    const writer = new DatabaseSync(location.dbPath);
    try {
      writer.prepare(
        "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) values (?, ?, 'prepared', ?, '{}', '{}', null, ?, ?)",
      ).run(
        "remote-pending",
        "remote-hash",
        JSON.stringify({ workflow: { workflowId: "wf-remote-journal" }, execution: {}, catalog: {}, actor: "project-manager", expectedCatalogRevision: 0 }),
        "2026-11-23",
        "2026-11-23",
      );
    } finally {
      writer.close();
    }
    expect(await readPendingRegistration(context, "wf-remote-journal")).toEqual({ operationId: "remote-pending", phase: "prepared" });
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
    writeFileSync(snapshotPath, snapshot);
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
      `import { openStore } from ${JSON.stringify(storeDbModule)}; ` +
      `const h=await openStore({harnessDir:process.env.CATALOG_HARNESS},"write"); ` +
      `h.db.exec("begin immediate"); ` +
      `h.db.prepare("update store_meta set authority_epoch=authority_epoch+1, revision=revision+1 where id=1").run(); ` +
      `h.db.exec("commit"); h.close();`;
    const realOpenStore = storeDb.openStore;
    let writerRan = false;
    const openSpy = spyOn(storeDb, "openStore").mockImplementation(async (storeContext, mode) => {
      const handle = await realOpenStore(storeContext, mode);
      const close = handle.close.bind(handle);
      handle.close = () => {
        if (!writerRan && storeContext.harnessDir === harnessDir) {
          writerRan = true;
          const writer = spawnSync(process.execPath, ["-e", writerSource], {
            cwd: process.cwd(),
            env: { ...process.env, CATALOG_HARNESS: harnessDir },
            encoding: "utf8",
          });
          close();
          expect(writer.status).toBe(0);
          expect(writer.stdout).toBe("");
          expect(writer.stderr).toBe("");
          return;
        }
        close();
      };
      return handle;
    });
    try {
      await expect(purgeCatalogRegistration(context, {
        workflowId,
        operationId,
        expectedCatalogRevision: revisionsBefore.catalogRevision,
        actor: "project-manager",
      })).rejects.toMatchObject({ code: "store.operation-conflict" });
    } finally {
      openSpy.mockRestore();
    }
    expect(writerRan).toBe(true);
    expect(await listPendingCatalogRegistrations(context)).toContainEqual(
      expect.objectContaining({ operationId, phase: "prepared" }),
    );
    expect(await readCatalogRevisions(context)).toEqual({
      storeRevision: revisionsBefore.storeRevision + 1,
      catalogRevision: revisionsBefore.catalogRevision,
    });

  });
  test("purge ignores hostile cwd dotenv and preserves the marker and source bytes", async () => {
    const { harnessDir, context } = await fixture("purge-hostile-dotenv");
    const workflowId = "wf-purge-hostile-dotenv";
    const operationId = "op-purge-hostile-dotenv";
    const snapshotPath = join(harnessDir, "workflows", workflowId, "snapshot.json");
    mkdirSync(join(harnessDir, "workflows", workflowId), { recursive: true });
    const snapshot = `{"identity":"${workflowId}"}\n`;
    writeFileSync(snapshotPath, snapshot);
    const digest = createHash("sha256").update(snapshot).digest("hex");
    const journal = { workflow: { workflowId, harnessDir, snapshotPath }, execution: {}, catalog: {}, actor: "project-manager", expectedCatalogRevision: 0 };
    const setup = await openStore(context, "write");
    try {
      setup.db.prepare(
        "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) values (?, ?, 'prepared', ?, '{}', ?, null, ?, ?)",
      ).run(
        operationId,
        "hostile-dotenv",
        JSON.stringify(journal),
        JSON.stringify({ failure: { workflow_id: workflowId, snapshot_path: snapshotPath, snapshot_content_sha256: digest, reviewed_identity: "legacy-identity" } }),
        "2026-10-13",
        "2026-10-13",
      );
    } finally { setup.close(); }

    const markerPath = join(root!, "benign-marker");
    const releasePath = join(root!, "already-released");
    const marker = "preexisting benign marker; must not be truncated\n";
    writeFileSync(markerPath, marker);
    writeFileSync(releasePath, "released\n");
    writeFileSync(join(root!, ".env"), [
      "MSTAR_STORE_TEST_RUNNER=1",
      "MSTAR_STORE_PARK_CATALOG_PURGE=*",
      `MSTAR_STORE_PARK_READY=${markerPath}`,
      `MSTAR_STORE_PARK_RELEASE=${releasePath}`,
      "",
    ].join("\n"));
    const moduleUrl = new URL("./catalog-registration.js", import.meta.url).href;
    const childSource =
      `import { purgeCatalogRegistration, readCatalogRevisions } from ${JSON.stringify(moduleUrl)}; ` +
      `const context={harnessDir:process.env.CATALOG_HARNESS}; ` +
      `const revisions=await readCatalogRevisions(context); ` +
      `const receipt=await purgeCatalogRegistration(context,{workflowId:${JSON.stringify(workflowId)},operationId:${JSON.stringify(operationId)},expectedCatalogRevision:revisions.catalogRevision,actor:"project-manager"}); ` +
      `const revisionsAfter=await readCatalogRevisions(context); ` +
      `console.log(JSON.stringify({receipt,revisions,revisionsAfter}));`;
    const childEnv: NodeJS.ProcessEnv = { ...process.env, CATALOG_HARNESS: harnessDir };
    for (const key of [
      "MSTAR_STORE_TEST_RUNNER",
      "MSTAR_STORE_PARK_CATALOG_PURGE",
      "MSTAR_STORE_PARK_READY",
      "MSTAR_STORE_PARK_RELEASE",
    ]) delete childEnv[key];
    const child = spawnSync(process.execPath, ["-e", childSource], {
      cwd: root!,
      env: childEnv,
      encoding: "utf8",
    });
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    const result = JSON.parse(child.stdout.trim()) as { receipt: unknown; revisions: { storeRevision: number; catalogRevision: number }; revisionsAfter: { storeRevision: number; catalogRevision: number } };
    expect(result.receipt).toMatchObject({
      workflowId,
      
      sourceBytesRetained: true,
    });
    expect(result.revisionsAfter).toEqual({
      storeRevision: result.revisions.storeRevision + 1,
      catalogRevision: result.revisions.catalogRevision,
    });
    expect(readFileSync(snapshotPath, "utf8")).toBe(snapshot);
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
  });
});
