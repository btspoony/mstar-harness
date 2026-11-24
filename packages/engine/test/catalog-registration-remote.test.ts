/**
 * note: catalog-registration-remote — the catalog journal of a REMOTE checkout.
 *
 * A remote checkout's collaboration authority is the provider, so its journal
 * lives in the private cache the reviewed `remote bind` created, and the
 * execution store no longer carries `catalog_operations` at all. These cases
 * span remote binding, execution initialization and journal settlement, so they
 * live here rather than beside one module.
 *
 * Run with `bun test packages/engine/test/catalog-registration-remote.test.ts`.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodeOs from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  abortCatalogExecution,
  assertCatalogExecutionCommitted,
  listPendingCatalogRegistrations,
  purgeCatalogRegistration,
  readCatalogRevisions,
  readPendingRegistration,
} from "../src/catalog-registration.js";
import { resolveCollaborationLocation } from "../src/collaboration-identity.js";
import { bindRemoteAuthority } from "../src/collaboration-remote.js";
import { createRemoteScope } from "../src/remote-scope.fixture.js";
import { initializeStore } from "../src/store-db.js";

const HOME = mkdtempSync(join(tmpdir(), "catalog-registration-remote-home-"));
const ROOT = mkdtempSync(join(tmpdir(), "catalog-registration-remote-"));
let homeSpy: { mockRestore(): void } | undefined;
homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);
afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(HOME, { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
});

/** note: One bound remote checkout whose execution store no longer owns the journal. */
async function fencedRemoteCheckout(label: string) {
  const root = mkdtempSync(join(ROOT, `${label}-`));
  const scope = createRemoteScope(root, label);
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
  return { scope, context };
}

/** note: One REGISTERED lifecycle in the execution registry — the fact the gate decides first. */
function registerWorkflow(harness: string, workflowId: string): void {
  const store = new DatabaseSync(join(harness, "store.db"));
  try {
    store
      .prepare("insert into execution_workflows(workflow_id, revision, state_json, created_at, updated_at) values (?, 1, '{}', ?, ?)")
      .run(workflowId, "2026-11-24T00:00:00.000Z", "2026-11-24T00:00:00.000Z");
    store.prepare("insert into execution_registry(workflow_id, entry_json) values (?, '{}')").run(workflowId);
  } finally {
    store.close();
  }
}

/** note: One prepared journal row on the lane that owns it. */
function insertPrepared(lanePath: string, row: {
  operationId: string;
  workflowId: string;
  catalogDelta?: Record<string, unknown>;
  after?: Record<string, unknown>;
}): void {
  const lane = new DatabaseSync(lanePath);
  try {
    lane.prepare(
      "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) values (?, ?, 'prepared', ?, '{}', ?, null, ?, ?)",
    ).run(
      row.operationId,
      "remote-hash",
      JSON.stringify(row.catalogDelta ?? { workflow: { workflowId: row.workflowId }, execution: {}, catalog: {}, actor: "project-manager", expectedCatalogRevision: 0 }),
      JSON.stringify(row.after ?? {}),
      "2026-11-23",
      "2026-11-23",
    );
  } finally {
    lane.close();
  }
}

describe("a remote checkout's catalog journal", () => {
  test("an empty journal reads as none without taking a write lock", async () => {
    const { context } = await fencedRemoteCheckout("remote-journal-read");

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
    insertPrepared(location.dbPath, { operationId: "remote-pending", workflowId: "wf-remote-journal" });
    expect(await readPendingRegistration(context, "wf-remote-journal")).toEqual({ operationId: "remote-pending", phase: "prepared", hasIdentityFailure: false });
  });

  test("settles pending registrations on the cache lane that owns the journal", async () => {
    const { scope, context } = await fencedRemoteCheckout("remote-journal-write");

    const lanePath = resolveCollaborationLocation(context).dbPath;
    const workflowId = "wf-remote-write";
    const snapshotPath = join(scope.harness, "workflows", workflowId, "snapshot.json");
    mkdirSync(join(scope.harness, "workflows", workflowId), { recursive: true });
    const snapshot = `{"identity":"${workflowId}"}\n`;
    writeFileSync(snapshotPath, snapshot);
    const digest = createHash("sha256").update(snapshot).digest("hex");
    insertPrepared(lanePath, { operationId: "remote-pending-write", workflowId: "wf-remote-write" });
    insertPrepared(lanePath, {
      operationId: "remote-pending-purge",
      workflowId,
      catalogDelta: { workflow: { workflowId, harnessDir: scope.harness, snapshotPath }, execution: {}, catalog: {}, actor: "project-manager", expectedCatalogRevision: 0 },
      after: { failure: { workflow_id: workflowId, snapshot_path: snapshotPath, snapshot_content_sha256: digest, reviewed_identity: "remote-identity" } },
    });
    const lane = new DatabaseSync(lanePath);
    try {
      lane.prepare("update collaboration_meta set revision = 2, catalog_revision = 4 where id = 1").run();
    } finally {
      lane.close();
    }

    // invariant: A pending row on the cache is visible to discovery, not only to the point read.
    const pending = await listPendingCatalogRegistrations(context);
    expect(pending).toContainEqual(expect.objectContaining({ operationId: "remote-pending-write", workflowId: "wf-remote-write", phase: "prepared" }));
    expect(pending).toContainEqual(expect.objectContaining({ operationId: "remote-pending-purge", workflowId, phase: "prepared" }));

    // invariant: Abort settles it on the cache and advances that lane's counter.
    expect(await abortCatalogExecution(context, "remote-pending-write")).toEqual({
      operationId: "remote-pending-write", workflowId: "wf-remote-write", phase: "aborted", sourceBytesRetained: true,
    });
    expect(await readCatalogRevisions(context)).toEqual({ storeRevision: 3, catalogRevision: 4 });

    // invariant: Both purge halves compare generations on the cache lane, so they agree.
    const receipt = await purgeCatalogRegistration(context, {
      workflowId, operationId: "remote-pending-purge", expectedCatalogRevision: 4, actor: "project-manager",
    });
    expect(receipt).toMatchObject({ workflowId, sourceBytesRetained: true, actor: "project-manager" });
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
    expect(await readCatalogRevisions(context)).toEqual({ storeRevision: 4, catalogRevision: 4 });

    // invariant: Settlement retains the source document itself, never a re-serialized copy.
    expect(JSON.parse(readFileSync(snapshotPath, "utf8"))).toEqual({ identity: workflowId });
  });

  test("a lane this checkout does not hold passes registration through instead of refusing selection", async () => {
    const { scope, context } = await fencedRemoteCheckout("remote-journal-gate-missing-lane");
    registerWorkflow(scope.harness, "wf-registered");
    // note: The cache the bind created is gone, so the journal's owner cannot be opened at all.
    const location = resolveCollaborationLocation(context);
    for (const path of [location.dbPath, `${location.dbPath}-wal`, `${location.dbPath}-shm`]) rmSync(path, { force: true });

    // invariant: A lane this workspace does not hold carries no journal row, so it is the same
    // pre-activation pass-through `store.not-active` already had — never a
    // `collaboration.not-initialized` refusal of a workflow selection. An unregistered workflow
    // never even pays for that read.
    await expect(assertCatalogExecutionCommitted(context, "wf-unregistered")).resolves.toBeUndefined();
    await expect(assertCatalogExecutionCommitted(context, "wf-registered")).resolves.toBeUndefined();
  });

  test("a bound checkout's pending journal still refuses its registered workflow", async () => {
    const { scope, context } = await fencedRemoteCheckout("remote-journal-gate-pending");
    registerWorkflow(scope.harness, "wf-registered");
    insertPrepared(resolveCollaborationLocation(context).dbPath, { operationId: "op-gate-pending", workflowId: "wf-registered" });

    // invariant: Tolerating a lane this workspace does not hold never hides a journal it DOES
    // hold: a registered workflow with a pending registration still refuses.
    await expect(assertCatalogExecutionCommitted(context, "wf-registered")).rejects.toMatchObject({
      code: "catalog.registration-pending",
    });
  });

  test("a bound checkout with no cache names the reviewed remote bind, never local setup", async () => {
    const root = mkdtempSync(join(ROOT, "remote-journal-absent-"));
    const scope = createRemoteScope(root, "remote-journal-absent");
    const context = scope.context();
    const commit = scope.publish();
    await bindRemoteAuthority(context, scope.batch(commit));
    await initializeStore(context).then((handle) => handle.close());
    const fenced = new DatabaseSync(join(scope.harness, "store.db"));
    try {
      fenced.exec("drop table catalog_operations");
    } finally {
      fenced.close();
    }
    // note: The cache the bind created is gone, so the journal's owner cannot be opened at all.
    rmSync(resolveCollaborationLocation(context).dbPath, { force: true });

    const readRefusal = await readPendingRegistration(context, "wf-remote-absent").catch((error: unknown) => error) as {
      code?: string; message?: string; recovery?: string;
    };
    expect(readRefusal.code).toBe("collaboration.not-initialized");
    expect(readRefusal.message).toContain("mstar store init");
    // invariant: The REMOTE recovery replaces the local creation advice for this path only.
    expect(readRefusal.recovery).toContain("mstar store collaboration remote bind --harness <abs> --input <file|->");
    expect(readRefusal.recovery).not.toContain("mstar store init");

    const writeRefusal = await listPendingCatalogRegistrations(context).catch((error: unknown) => error) as {
      code?: string; recovery?: string;
    };
    expect(writeRefusal.code).toBe("collaboration.not-initialized");
    expect(writeRefusal.recovery).toContain("mstar store collaboration remote bind --harness <abs> --input <file|->");
  });
});
