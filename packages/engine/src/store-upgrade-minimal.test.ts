import { afterAll, expect, spyOn, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import * as nodeFs from "node:fs";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeStore, migrationChecksum, MIGRATIONS, openStore, SCHEMA_VERSION_TABLE_SQL, storeDbPath, upgradeStore, type StoreContext, type StoreDb } from "./store-db.js";
import { WORKFLOW_SNAPSHOT_FILE, consultDeliveryEvidence, type WorkflowSnapshot } from "./workflow.js";
import { upgradeStoreMinimal } from "./execution-minimal-import.js";
import { bindExecutionSession, createExecutionWorkflow, executionToken, readExecutionPlan, readExecutionState } from "./execution-store.js";
import { ACTIVATION_PROTOCOL_VERSION, backupStore, type ActivationAttestation } from "./store-activation.js";
import { createLocalExecutionIdentity, executionContextFor, resumeExecutionSession } from "./execution-session.js";
import { mutateExecutionPlan } from "./execution-coordination.js";
import { executionInputHash, executionInputSelection, resolveProcessHarnessDir } from "./coordination.js";
import { previewExecutionRestore, restoreExecutionBackup } from "./execution-recovery.js";
import { listPendingCatalogRegistrations } from "./catalog-registration.js";
import { createFsStore, setArtifactStore } from "./store.js";
import { registerCatalogEntity } from "./catalog.js";
import { readRoadmapAuthority, replaceRoadmapAuthority } from "./roadmap-store.js";
import type { DeliveryLiftDeclaration } from "./migrate.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "mstar-store-upgrade-minimal-")));
afterAll(() => {
  setArtifactStore(undefined);
  rmSync(ROOT, { recursive: true, force: true });
});

/**
 * Test-only instrumentation of the platform `node:fs` calls the importer
 * resolves through, scoped to one callback and always restored. It replaces the
 * functions on the shared namespace (exactly what the module's own `node:fs`
 * import sees) and records every path argument, so a case can assert that a
 * forbidden target or child path was NEVER probed by lstat/exists/realpath/read.
 * Production exposes no hook, option, environment knob or test mode, and the
 * recorded values are the real calls, not a mocked forwarding echo.
 */
async function withPathAccessLog<T>(run: () => Promise<T>): Promise<{ result: T; accessed: string[] }> {
  const real = {
    lstatSync: nodeFs.lstatSync,
    statSync: nodeFs.statSync,
    existsSync: nodeFs.existsSync,
    realpathSync: nodeFs.realpathSync,
    readFileSync: nodeFs.readFileSync,
    readdirSync: nodeFs.readdirSync,
  };
  const accessed: string[] = [];
  const spies: Array<{ mockRestore: () => void }> = [];
  const record = (value: unknown) => { if (typeof value === "string") accessed.push(value); };
  spies.push(spyOn(nodeFs, "lstatSync").mockImplementation(((path: unknown, ...rest: unknown[]) => { record(path); return (real.lstatSync as (...args: unknown[]) => unknown)(path, ...rest); }) as never));
  spies.push(spyOn(nodeFs, "statSync").mockImplementation(((path: unknown, ...rest: unknown[]) => { record(path); return (real.statSync as (...args: unknown[]) => unknown)(path, ...rest); }) as never));
  spies.push(spyOn(nodeFs, "existsSync").mockImplementation(((path: unknown) => { record(path); return real.existsSync(path as never); }) as never));
  spies.push(spyOn(nodeFs, "realpathSync").mockImplementation(((path: unknown, ...rest: unknown[]) => { record(path); return (real.realpathSync as (...args: unknown[]) => unknown)(path, ...rest); }) as never));
  spies.push(spyOn(nodeFs, "readFileSync").mockImplementation(((path: unknown, ...rest: unknown[]) => { record(path); return (real.readFileSync as (...args: unknown[]) => unknown)(path, ...rest); }) as never));
  spies.push(spyOn(nodeFs, "readdirSync").mockImplementation(((path: unknown, ...rest: unknown[]) => { record(path); return (real.readdirSync as (...args: unknown[]) => unknown)(path, ...rest); }) as never));
  try {
    return { result: await run(), accessed };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

function legacyWorkspace(name: string): { context: StoreContext; unknownBytes: Buffer } {
  const harnessDir = join(ROOT, name, ".mstar");
  const workflowId = `wf-${name}`;
  const planId = `${workflowId}-plan`;
  const workflowDir = join(harnessDir, "workflows", workflowId);
  const sessionsDir = join(workflowDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(harnessDir, `${planId}.md`), `# ${planId}\n`);
  const sessionId = `session-${name}`;
  writeFileSync(join(sessionsDir, "plan-pm.json"), JSON.stringify({
    schema_version: 1,
    role: "plan-pm",
    session_id: sessionId,
    workflow_id: workflowId,
    plan_id: planId,
    harness_root: harnessDir,
  }));
  writeFileSync(join(harnessDir, "status.json"), JSON.stringify({
    version: 2,
    updated_at: "2026-10-04",
    workflows: [{ id: workflowId, type: "plan", started_at: "2026-10-04", dir: `workflows/${workflowId}` }],
  }));
  writeFileSync(join(workflowDir, WORKFLOW_SNAPSHOT_FILE), JSON.stringify({
    schema_version: 1,
    id: workflowId,
    type: "plan",
    status: "running",
    started_at: "2026-10-04",
    updated_at: "2026-10-04",
    delivery_kind: "development",
    branch: { source: `feature/${workflowId}`, target: "main" },
    plans: [{
      id: planId,
      title: "Upgrade fixture plan",
      file: `${planId}.md`,
      status: "Todo",
      coordination: { revision: 1, session: { session_id: sessionId, session_file: join(sessionsDir, "plan-pm.json"), bound_at: "2026-10-04T00:00:00Z" } },
      execution_lease: { holder: sessionId, claimed_at: "2026-10-04T00:00:00Z", worktree_path: `${ROOT}/worktree-${name}`, working_branch: `feature/${workflowId}` },
    }],
  }));
  const unknownBytes = Buffer.from([0, 1, 2, 255]);
  writeFileSync(join(workflowDir, "unknown.bin"), unknownBytes);
  return { context: { harnessDir }, unknownBytes };
}

type ProtectedDatabase = {
  schema: Array<{ type: string; name: string }>;
  tables: Record<string, string[]>;
};

/** Compare every SQL row and schema object, including inputs, receipts and ledgers. */
function protectedDatabase(db: StoreDb): ProtectedDatabase {
  const schema = db.prepare("select type, name, tbl_name, sql from sqlite_schema order by type, name").all() as Array<{ type: string; name: string }>;
  const tables: Record<string, string[]> = {};
  for (const entry of schema) {
    if (entry.type !== "table") continue;
    const table = `"${entry.name.replaceAll('"', '""')}"`;
    tables[entry.name] = db.prepare(`select * from ${table}`).all()
      .map((row) => JSON.stringify(row)).sort();
  }
  return { schema, tables };
}

async function protectedStore(context: StoreContext) {
  const store = await openStore(context, "read");
  try {
    return protectedDatabase(store.db);
  } finally {
    store.close();
  }
}

function stopDocument(sessionId: string, attestedAt = "2026-10-04T04:00:00Z"): ActivationAttestation {
  return {
    version: ACTIVATION_PROTOCOL_VERSION,
    attestedAt,
    operator: { actor: "fixture-operator", authorizationRef: "schema-cutover-authorization" },
    consumers: [{
      entryId: "fixture-coordinator", kind: "coordinator", entrypoint: "/opt/mstar/coordinator/dist/index.js",
      runtime: "node", runtimeVersion: "24.18.0", version: "3.11.2", current: true, disposition: "reloaded",
    }],
    stoppedSessions: [{ sessionId, host: "omp", state: "stopped" }],
  };
}

function cleanCheckout(path: string, branch: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-b", branch], { cwd: path, stdio: "pipe" });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "--allow-empty", "-m", "Fixture source"], { cwd: path, stdio: "pipe" });
}

function seedInput(db: StoreDb, workflowId: string, planId: string, pinned = false): void {
  const row = db.prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?")
    .get(workflowId, planId) as { state_json: string };
  const state = JSON.parse(row.state_json);
  const hash = executionInputHash(state, planId);
  const store = db.prepare("select store_id from store_meta where id = 1").get() as { store_id: string };
  const pin = pinned ? { store_id: store.store_id, entity_revision: 7, document_hash: hash, relation_hash: "a".repeat(64) } : null;
  db.prepare("insert into execution_inputs(workflow_id, plan_id, revision, input_json, input_hash, catalog_pin_json) values (?, ?, 1, ?, ?, ?)")
    .run(workflowId, planId, JSON.stringify(executionInputSelection(state, planId)), hash, pin === null ? null : JSON.stringify(pin));
}

/** Authenticate an ordinary coordinator and actually mutate the migrated row. */
async function continuePlan(
  context: StoreContext, workflowId: string, planId: string,
  identity = createLocalExecutionIdentity({ workflowId, role: "coordinator" }),
): Promise<void> {
  const caller = executionContextFor(context, identity);
  const state = await readExecutionState(context);
  const workflow = state.data.workflows.find((entry) => entry.state.id === workflowId)!;
  const bound = workflow.coordinator === null
    ? await bindExecutionSession(caller, {
      workflowId, expected: workflow.workflowToken, operationId: `bind-${workflowId}`,
    })
    : await resumeExecutionSession(caller, workflow.coordinator);
  const before = await readExecutionPlan(caller, bound.data, planId);
  const originalInput = (await protectedStore(context)).tables;
  const prepared = await mutateExecutionPlan(caller, {
    session: bound.data, expected: before.token, planId, operationId: `prepare-${workflowId}`,
    operation: { kind: "prepare", config: { qaGate: "pm-acceptance", findingsCleanup: "allow-residual" } },
  });
  expect(prepared.data.plan.status).toBe(before.data.plan.status);
  expect(prepared.data.plan.metadata).toEqual(before.data.plan.metadata);
  expect(prepared.data.coordination?.prepared).toMatchObject({
    qa_gate: "pm-acceptance", findings_cleanup: "allow-residual", prepared_by: identity.sessionId,
  });
  expect(prepared.data.coordination?.progress).toEqual(before.data.coordination?.progress);
  expect(prepared.data.coordination?.completion).toEqual(before.data.coordination?.completion);
  const progress = { status: "InProgress" as const, summary: "Continue the migrated business row", evidence_paths: [] };
  const advanced = await mutateExecutionPlan(caller, {
    session: bound.data, expected: prepared.token, planId, operationId: `progress-${workflowId}`,
    operation: { kind: "progress", progress },
  });
  expect(advanced.data.plan.status).toBe("InProgress");
  expect(advanced.data.coordination?.progress).toEqual(progress);
  expect(advanced.data.plan.metadata).toEqual(before.data.plan.metadata);
  const reread = await readExecutionPlan(caller, bound.data, planId);
  expect(reread.data).toEqual(advanced.data);
  expect(reread.token).toEqual(advanced.token);
  expect((await protectedStore(context)).tables.execution_inputs).toEqual(originalInput.execution_inputs);
}

/** Build the historical database from its frozen migrations, not a schema-9 imitation. */
async function schema8Store(context: StoreContext) {
  const db = new DatabaseSync(storeDbPath(context));
  try {
    db.exec("pragma foreign_keys=ON");
    db.exec("begin");
    db.exec(SCHEMA_VERSION_TABLE_SQL);
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 8)) {
      db.exec(migration.sql);
      db.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)")
        .run(migration.version, migration.name, migrationChecksum(migration), "2026-10-04T00:00:00Z");
    }
    db.prepare("update store_meta set authority_state = 'active' where id = 1").run();
    db.prepare("update execution_meta set authority_state = 'active' where id = 1").run();
    db.exec("commit");
  } finally {
    db.close();
  }
  return openStore(context, "write");
}

test("store upgrade imports snapshot rows, ownership, and unknown bytes, then replays idempotently", async () => {
  const { context, unknownBytes } = legacyWorkspace("creates-and-imports");
  const unknownPath = join(context.harnessDir, "workflows", "wf-creates-and-imports", "unknown.bin");
  const input = { context, operator: "operator", operationId: "op-minimal-import" };
  const result = await upgradeStoreMinimal(input);
  expect(result).toMatchObject({ verdict: "upgraded", imported: 1, authorityState: "active" });
  expect(result.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(result.skipped).toEqual([
    { path: "workflows/wf-creates-and-imports/sessions/plan-pm.json", reason: "legacy plan-PM session envelope dropped; the seat was removed" },
    { path: "workflows/wf-creates-and-imports/unknown.bin", reason: "unrecognized workflow entry; left in place" },
  ]);
  expect([...readFileSync(unknownPath)]).toEqual([...unknownBytes]);
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select authority_state, revision from execution_meta where id = 1").get())
      .toEqual({ authority_state: "active", revision: 2 });
    expect(store.db.prepare("select authority_epoch from store_meta where id = 1").get())
      .toEqual({ authority_epoch: 1 });
    const workflow = store.db.prepare("select workflow_id, state_json from execution_workflows").get() as { workflow_id: string; state_json: string };
    expect(workflow.workflow_id).toBe("wf-creates-and-imports");
    expect(JSON.parse(workflow.state_json)).toMatchObject({
      status: "running",
      branch: { source: "feature/wf-creates-and-imports", target: "main" },
    });
    const plan = store.db.prepare("select workflow_id, plan_id, state_json, coordination_json from execution_plans").get() as {
      workflow_id: string;
      plan_id: string;
      state_json: string;
      coordination_json: string;
    };
    expect(plan).toMatchObject({ workflow_id: workflow.workflow_id, plan_id: "wf-creates-and-imports-plan" });
    // The dropped lease's source/cleanup ownership survives in ordinary
    // metadata: the row's worktree and branch are what L1 and cleanup read.
    expect(JSON.parse(plan.state_json)).toMatchObject({
      id: plan.plan_id,
      status: "Todo",
      title: "Upgrade fixture plan",
      metadata: {
        worktree_path: join(ROOT, "worktree-creates-and-imports"),
        working_branch: "feature/wf-creates-and-imports",
      },
    });
    // The stored coordination carries NO revision: that value is the plan
    // column's alone, exactly as the DB representation boundary requires.
    expect(JSON.parse(plan.coordination_json)).toEqual({});
    // The legacy plan-PM session envelope is dropped: the seat was removed, so
    // no plan-scoped session row and no per-plan lease table exist any more.
    expect(store.db.prepare("select count(*) as n from execution_sessions").get()).toEqual({ n: 0 });
    expect(result.dispositions).toEqual([
      "workflow wf-creates-and-imports plan wf-creates-and-imports-plan: legacy per-plan execution lease dropped on import; the row imports as Blocked and the coordinator continues it through ordinary plan operations",
      "workflow wf-creates-and-imports plan wf-creates-and-imports-plan: legacy plan-PM session binding dropped on import; that seat no longer exists",
    ]);
    // The final public read exposes the migrated row and its ownership facts.
    const readable = await readExecutionState(context);
    const migrated = readable.data.workflows[0]?.plans[0];
    expect(migrated?.plan.id).toBe(plan.plan_id);
  } finally {
    store.close();
  }
  expect(await upgradeStoreMinimal(input)).toEqual(result);
  const snapshotPath = join(context.harnessDir, "workflows", "wf-creates-and-imports", WORKFLOW_SNAPSHOT_FILE);
  const changedSnapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
  changedSnapshot.updated_at = "2026-10-05";
  writeFileSync(snapshotPath, JSON.stringify(changedSnapshot));
  // The imported input is part of the request identity: the SAME operation over
  // EDITED legacy bytes conflicts instead of answering with a receipt that
  // describes bytes this run never imported. Only the unchanged replay above is
  // answered by the retained receipt.
  await expect(upgradeStoreMinimal(input)).rejects.toMatchObject({ code: "execution.operation-conflict" });
  const replayStore = await openStore(context, "read");
  try {
    expect(replayStore.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 1 });
    expect(replayStore.db.prepare("select count(*) as n from execution_plans").get()).toEqual({ n: 1 });
  } finally {
    replayStore.close();
  }
});

test("an ACTIVE schema-8 store is normalized in place: protocol JSON becomes the target shape and business facts survive", async () => {
  const { context } = legacyWorkspace("active-schema8-normalize");
  cleanCheckout(dirname(context.harnessDir), "main");
  const workflowId = "wf-active-schema8-normalize";
  const planId = `${workflowId}-plan`;
  const sessionId = "session-active-schema8-normalize";
  const conflictIdentity = createLocalExecutionIdentity({ workflowId: `${workflowId}-conflict`, role: "coordinator" });
  /** Full pre-cutover state captured for the refusal comparison. */
  const protectedState: Record<string, unknown> = {};

  // The frozen schema-8 producer shape, populated with historical protocol JSON.
  const initialized = await schema8Store(context);
  cleanCheckout(join(ROOT, "metadata-worktree"), `feature/${workflowId}-conflict-plan`);
  try {
    initialized.db.prepare("update execution_meta set authority_state = 'active' where id = 1").run();
    // FK order: workflow, then plan, then the sessions and the lease that
    // reference them. The lease is the REAL `execution_leases` row — the plan row
    // itself never carries `execution_lease` (the old producer deleted it before
    // insert), so an embedded copy would be a nonhistorical boundary.
    initialized.db.prepare("insert into execution_workflows(workflow_id, revision, state_json, created_at, updated_at) values (?, 1, ?, ?, ?)")
      .run(
        workflowId,
        JSON.stringify({
          schema_version: 1,
          id: workflowId,
          type: "plan",
          status: "running",
          started_at: "2026-10-04",
          updated_at: "2026-10-04",
          delivery_kind: "development",
          branch: { source: `feature/${planId}`, target: "main" },
          coordination: {
            coordinator: { session_id: "host-coord", session_file: join(ROOT, "coord.json"), bound_at: "2026-10-04T00:00:00Z" },
            identity_recoveries: [{ operation_id: "recover-op" }],
          },
          self_amendments: [{ at: "2026-10-04T01:00:00Z", session_id: "plan-session", operation_id: "amend-op" }],
        }),
        "2026-10-04",
        "2026-10-04",
      );
    initialized.db.prepare(
      "insert into execution_plans(workflow_id, plan_id, revision, ordinal, state_json, coordination_json) values (?, ?, 1, 0, ?, ?)",
    ).run(
      workflowId,
      planId,
      JSON.stringify({
        id: planId,
        title: "Schema-8 fixture plan",
        file: `${planId}.md`,
        status: "Todo",
      }),
      JSON.stringify({
        revision: 1,
        prepared: {
          assignment_path: join(ROOT, "assignment.md"),
          assignment_sha256: "a".repeat(64),
          plan_sha256: "b".repeat(64),
          qa_gate: "mandatory",
          findings_cleanup: "allow-residual",
          prepared_by: "host-coord",
          prepared_at: "2026-10-04T00:00:00Z",
        },
        progress: { status: "InReview", summary: "Historical review completed", evidence_paths: [], track_branches: [`feature/${planId}`] },
        session: { session_id: sessionId, session_file: join(ROOT, "plan-pm.json"), bound_at: "2026-10-04T00:00:00Z" },
        handoff: {
          id: `${planId}-attempt-1`,
          attempt: 1,
          state: "completed",
          submitted_by: sessionId,
          submitted_at: "2026-10-04T01:00:00Z",
          source_branch: `feature/${planId}`,
          source_sha: "c".repeat(40),
          worktree_path: join(ROOT, "schema8-worktree"),
          review_base: "c".repeat(40),
          review_head: "c".repeat(40),
          qc: { decision: "Approve", reports: [{ path: join(ROOT, "qc.md"), sha256: "d".repeat(64) }], consolidated: { path: join(ROOT, "qc-s.md"), sha256: "e".repeat(64) } },
          qa: { gate: "mandatory", decision: "pass", report: { path: join(ROOT, "qa.md"), sha256: "f".repeat(64) } },
          accepted_by: "host-coord",
          accepted_at: "2026-10-04T02:00:00Z",
          completed_at: "2026-10-04T03:00:00Z",
        },
      }),
    );
    initialized.db.prepare(
      "insert into execution_sessions(workflow_id, role, session_id, plan_id, epoch, revision, state, bound_at) " +
        "values (?, 'coordinator', 'host-coord', null, 1, 1, 'active', '2026-10-04T00:00:00Z')",
    ).run(workflowId);
    initialized.db.prepare(
      "insert into execution_sessions(workflow_id, role, session_id, plan_id, epoch, revision, state, bound_at) " +
        "values (?, 'plan-pm', ?, ?, 1, 1, 'suspended', '2026-10-04T00:00:00Z')",
    ).run(workflowId, sessionId, planId);
    // The REAL per-plan lease — the only place this row records its checkout and
    // branch. Its facts must reach metadata before the table is dropped.
    initialized.db.prepare(
      "insert into execution_leases(workflow_id, plan_id, revision, owner_epoch, lease_json) values (?, ?, 1, 1, ?)",
    ).run(
      workflowId,
      planId,
      JSON.stringify({
        holder: sessionId,
        holder_session_id: sessionId,
        holder_role: "plan-pm",
        claimed_at: "2026-10-04T00:00:00Z",
        worktree_path: join(ROOT, "schema8-worktree"),
        working_branch: `feature/${planId}`,
        status: "held",
      }),
    );
    // A valid historical workflow has its ACTIVE registry routing row; without
    // it `readExecutionState` cannot enumerate the workflow.
    initialized.db.prepare("insert into execution_registry(workflow_id, entry_json) values (?, ?)").run(
      workflowId,
      JSON.stringify({ id: workflowId, type: "plan", started_at: "2026-10-04", dir: `workflows/${workflowId}` }),
    );
    // A second, SEPARATE workflow whose row metadata already records a scope that
    // disagrees with its removed lease. The metadata is the authoritative,
    // revisable record, so the upgrade must keep it and never hard-stop on the
    // stale copy. It is kept single-plan so the standalone route stays intact.
    const conflictWorkflowId = `${workflowId}-conflict`;
    const conflictPlanId = `${conflictWorkflowId}-plan`;
    initialized.db.prepare("insert into execution_workflows(workflow_id, revision, state_json, created_at, updated_at) values (?, 1, ?, ?, ?)")
      .run(
        conflictWorkflowId,
        JSON.stringify({
          schema_version: 1,
          id: conflictWorkflowId,
          type: "plan",
          status: "running",
          started_at: "2026-10-04",
          updated_at: "2026-10-04",
          delivery_kind: "development",
          branch: { source: `feature/${conflictPlanId}`, target: "main" },
        }),
        "2026-10-04",
        "2026-10-04",
      );
    initialized.db.prepare("insert into execution_registry(workflow_id, entry_json) values (?, ?)").run(
      conflictWorkflowId,
      JSON.stringify({ id: conflictWorkflowId, type: "plan", started_at: "2026-10-04", dir: `workflows/${conflictWorkflowId}` }),
    );
    initialized.db.prepare(
      "insert into execution_plans(workflow_id, plan_id, revision, ordinal, state_json, coordination_json) values (?, ?, 1, 0, ?, ?)",
    ).run(
      conflictWorkflowId,
      conflictPlanId,
      JSON.stringify({
        id: conflictPlanId,
        title: "Schema-8 conflict plan",
        file: `${conflictPlanId}.md`,
        status: "Todo",
        metadata: {
          worktree_path: join(ROOT, "metadata-worktree"),
          working_branch: `feature/${conflictPlanId}`,
        },
      }),
      JSON.stringify({}),
    );
    initialized.db.prepare(
      "insert into execution_leases(workflow_id, plan_id, revision, owner_epoch, lease_json) values (?, ?, 1, 1, ?)",
    ).run(
      conflictWorkflowId,
      conflictPlanId,
      JSON.stringify({
        holder: sessionId,
        holder_session_id: sessionId,
        holder_role: "plan-pm",
        claimed_at: "2026-10-04T00:00:00Z",
        worktree_path: join(ROOT, "lease-worktree"),
        working_branch: `feature/lease-${conflictPlanId}`,
        status: "held",
      }),
    );
    // A held plan-PM integration mutex on this very plan is an orphan once the
    // holder row retires: the cutover must settle it, using the operator's stop
    // evidence, or the workflow carries an unreachable claim forever.
    initialized.db.prepare(
      "insert into execution_integration_leases(workflow_id, revision, owner_epoch, lease_json) values (?, 1, 1, ?)",
    ).run(
      workflowId,
      JSON.stringify({
        holder: sessionId,
        plan_id: planId,
        claimed_at: "2026-10-04T00:30:00Z",
        source_branch: `feature/${planId}`,
        target_branch: "main",
        status: "held",
      }),
    );
    seedInput(initialized.db, workflowId, planId, true);
    seedInput(initialized.db, conflictWorkflowId, conflictPlanId);
    // A genuine public bind supplies a committed operation receipt and ordinary
    // coordinator identity before refusal; neither is manufactured as SQL setup.
    const conflictHeader = initialized.db.prepare("select revision from execution_workflows where workflow_id = ?")
      .get(conflictWorkflowId) as { revision: number };
    await bindExecutionSession(executionContextFor(context, conflictIdentity), {
      workflowId: conflictWorkflowId, operationId: "historical-conflict-bind",
      expected: executionToken("workflow", initialized.storeId, initialized.epoch, [conflictWorkflowId], conflictHeader.revision),
    });
    protectedState.database = protectedDatabase(initialized.db);
    // Capture the FULL protected state so the refusal comparison proves every
    // byte is intact — not just counts or defined-ness.
    protectedState.plan = JSON.parse(JSON.stringify(
      initialized.db.prepare("select * from execution_plans where workflow_id = ? and plan_id = ?").get(workflowId, planId),
    ));
    protectedState.workflow = JSON.parse(JSON.stringify(
      initialized.db.prepare("select * from execution_workflows where workflow_id = ?").get(workflowId),
    ));
    protectedState.sessions = JSON.parse(JSON.stringify(
      initialized.db.prepare("select * from execution_sessions order by workflow_id, role, session_id").all(),
    ));
    protectedState.claims = JSON.parse(JSON.stringify(
      initialized.db.prepare("select * from execution_integration_leases order by workflow_id").all(),
    ));
    protectedState.leases = JSON.parse(JSON.stringify(
      initialized.db.prepare("select * from execution_leases order by workflow_id, plan_id").all(),
    ));
  } finally {
    initialized.close();
  }

  const retiredAttestation = {
    version: ACTIVATION_PROTOCOL_VERSION,
    attestedAt: "2026-10-04T04:00:00Z",
    operator: { actor: "ops-engineer", authorizationRef: "compass D29 / schema-8 cutover" },
    consumers: [
      { entryId: "coordinator-omp", kind: "coordinator", entrypoint: "/opt/mstar/coordinator/dist/index.js", runtime: "node", runtimeVersion: "24.18.0", version: "3.11.2", current: true, disposition: "reloaded" },
    ],
    stoppedSessions: [{ sessionId, host: "omp", state: "stopped" }],
  };
  // Without the operator's stop attestation the cutover refuses and rolls the
  // whole batch back: schema 8, every business/claim byte intact, no staging
  // table left behind. The SAME fixture then upgrades successfully under the
  // attested retry, proving a supported public recovery rather than a one-way
  // orphan.
  await expect(upgradeStoreMinimal({ context, operator: "operator", operationId: "op-active-schema8-refused" }))
    .rejects.toMatchObject({ code: "store.upgrade-attestation-missing" });
  const refused = await openStore(context, "read");
  try {
    expect(refused.schemaVersion).toBe(8);
    // Every protected row is byte-identical: the batch rolled back whole.
    const afterPlan = JSON.parse(JSON.stringify(
      refused.db.prepare("select * from execution_plans where workflow_id = ? and plan_id = ?").get(workflowId, planId),
    ));
    expect(afterPlan).toEqual(protectedState.plan);
    const afterWorkflow = JSON.parse(JSON.stringify(
      refused.db.prepare("select * from execution_workflows where workflow_id = ?").get(workflowId),
    ));
    expect(afterWorkflow).toEqual(protectedState.workflow);
    const afterSessions = JSON.parse(JSON.stringify(
      refused.db.prepare("select * from execution_sessions order by workflow_id, role, session_id").all(),
    ));
    expect(afterSessions).toEqual(protectedState.sessions);
    const afterClaims = JSON.parse(JSON.stringify(
      refused.db.prepare("select * from execution_integration_leases order by workflow_id").all(),
    ));
    expect(afterClaims).toEqual(protectedState.claims);
    const afterLeases = JSON.parse(JSON.stringify(
      refused.db.prepare("select * from execution_leases order by workflow_id, plan_id").all(),
    ));
    expect(afterLeases).toEqual(protectedState.leases);
    expect(protectedState.database).toEqual(protectedDatabase(refused.db));
    // No staging table survives the rollback.
    for (const staging of ["execution_lease_cutover", "execution_session_cutover", "execution_integration_cutover"]) {
      expect(refused.db.prepare("select name from sqlite_master where type = 'table' and name = ?").get(staging)).toBeUndefined();
    }
  } finally {
    refused.close();
  }
  await upgradeStoreMinimal({
    context,
    operator: "operator",
    operationId: "op-active-schema8-normalize",
    attestation: retiredAttestation,
    // The retained legacy source for this id collides with the native row the
    // schema-8 store already holds: the normalization keeps the native row and
    // skips only that legacy IMPORT.
    acknowledgedWorkflowSkips: [workflowId],
  });
  const store = await openStore(context, "read");
  try {
    expect(store.schemaVersion).toBe(MIGRATIONS.length);
    // The retained coordination JSON is the target shape: no sealed assignment,
    // no session, no handoff, no revision; the real QC/QA evidence and the
    // completed outcome survive as a contracted CompletionRecord.
    const coordination = JSON.parse(
      (store.db.prepare("select coordination_json from execution_plans where workflow_id = ? and plan_id = ?").get(workflowId, planId) as { coordination_json: string })
        .coordination_json,
    ) as Record<string, unknown>;
    expect(Object.keys(coordination).sort()).toEqual(["completion", "prepared", "progress"]);
    expect((coordination.prepared as Record<string, unknown>)).toEqual({
      qa_gate: "mandatory",
      findings_cleanup: "allow-residual",
      prepared_by: "host-coord",
      prepared_at: "2026-10-04T00:00:00Z",
    });
    expect((coordination.completion as Record<string, unknown>)).toMatchObject({
      source_branch: `feature/${planId}`,
      completed_by: "host-coord",
      completed_at: "2026-10-04T03:00:00Z",
    });
    // The old lease's source/cleanup ownership moved into ordinary metadata, and
    // the completed row is Done.
    const state = JSON.parse(
      (store.db.prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?").get(workflowId, planId) as { state_json: string }).state_json,
    ) as Record<string, unknown>;
    expect(state).toMatchObject({
      status: "Done",
      metadata: { worktree_path: join(ROOT, "schema8-worktree"), working_branch: `feature/${planId}` },
    });
    expect(state).not.toHaveProperty("execution_lease");
    expect(state).not.toHaveProperty("coordination");
    // The workflow header lost the removed self-amendment audit and the removed
    // per-workflow coordination block, keeping its identity and promoting the
    // coordinator recovery history the ordinary importer keeps.
    const header = JSON.parse(
      (store.db.prepare("select state_json from execution_workflows where workflow_id = ?").get(workflowId) as { state_json: string }).state_json,
    ) as Record<string, unknown>;
    expect(header).not.toHaveProperty("self_amendments");
    expect(header).not.toHaveProperty("coordination");
    expect(header).toMatchObject({ id: workflowId, status: "running", identity_recoveries: [{ operation_id: "recover-op" }] });
    // The legacy plan-PM session is gone; the workflow's own coordinator session
    // is preserved exactly.
    const sessions = store.db.prepare("select role, session_id, epoch, revision, state from execution_sessions where workflow_id = ? order by role").all(workflowId) as Array<Record<string, unknown>>;
    expect(sessions).toEqual([
      { role: "coordinator", session_id: "host-coord", epoch: 1, revision: 1, state: "active" },
    ]);
    // The final public read serves the migrated row and its scope facts.
    const readable = await readExecutionState(context);
    const migrated = readable.data.workflows.find((workflow) => workflow.state.id === workflowId)?.plans[0];
    expect(migrated?.plan.id).toBe(planId);
    const originalPlan = protectedState.plan as { coordination_json: string };
    const originalCoordination = JSON.parse(originalPlan.coordination_json);
    const { state: _handoffState, id: _handoffId, attempt: _attempt, submitted_by: _submitter,
      submitted_at: _submittedAt, accepted_by: completedBy, accepted_at: _acceptedAt, ...completion } = originalCoordination.handoff;
    expect(coordination.prepared).toEqual(migrated?.coordination?.prepared);
    expect(migrated?.coordination?.progress).toEqual(originalCoordination.progress);
    expect(migrated?.coordination?.completion).toEqual({ ...completion, completed_by: completedBy });
    const originalDatabase = protectedState.database as ProtectedDatabase;
    const originalInputs = originalDatabase.tables.execution_inputs!;
    expect(protectedDatabase(store.db).tables.execution_inputs).toEqual(originalInputs);
    for (const receipt of originalDatabase.tables.execution_operations!) {
      expect(protectedDatabase(store.db).tables.execution_operations).toContain(receipt);
    }
    const originalInput = originalInputs.map((row) => JSON.parse(row))
      .find((row) => row.workflow_id === workflowId);
    expect(migrated?.frozenInput).toEqual(JSON.parse(originalInput.catalog_pin_json));
    // The conflicting workflow's own metadata survived untouched — no hard gate.
    const conflictState = JSON.parse(
      (store.db.prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?").get(`${workflowId}-conflict`, `${workflowId}-conflict-plan`) as { state_json: string }).state_json,
    ) as Record<string, unknown>;
    expect(conflictState.metadata).toEqual({
      worktree_path: join(ROOT, "metadata-worktree"),
      working_branch: `feature/${workflowId}-conflict-plan`,
    });
    // Metadata wins over the stale obsolete lease; ordinary operations below
    // use the real retained checkout rather than a readiness-only assertion.
    expect(conflictState.status).toBe("Todo");
    expect(conflictState).not.toHaveProperty("execution_lease");
    const conflictCoordination = JSON.parse(
      (store.db.prepare("select coordination_json from execution_plans where workflow_id = ? and plan_id = ?").get(`${workflowId}-conflict`, `${workflowId}-conflict-plan`) as { coordination_json: string }).coordination_json,
    ) as Record<string, unknown>;
    expect(conflictCoordination).toEqual({});
    expect(store.db.prepare("select revision from execution_plans where workflow_id = ? and plan_id = ?")
      .get(`${workflowId}-conflict`, `${workflowId}-conflict-plan`)).toEqual({ revision: 1 });
    // The retired seat's integration mutex is settled as a released tombstone,
    // naming the stop evidence that authorized it — not left unreachable.
    const claim = JSON.parse(
      (store.db.prepare("select lease_json from execution_integration_leases where workflow_id = ?").get(workflowId) as { lease_json: string }).lease_json,
    ) as Record<string, unknown>;
    expect(claim).toMatchObject({
      status: "released",
      prior_holder: sessionId,
      release_reason: `retired-plan-pm-seat:${sessionId}`,
    });
    // The staging tables are gone.
    for (const staging of ["execution_lease_cutover", "execution_session_cutover", "execution_integration_cutover"]) {
      expect(store.db.prepare("select name from sqlite_master where type = 'table' and name = ?").get(staging)).toBeUndefined();
    }
  } finally {
    store.close();
  }
  await continuePlan(context, `${workflowId}-conflict`, `${workflowId}-conflict-plan`, conflictIdentity);
});

test("a sealed/completed legacy file snapshot is projected and imported instead of skipped", async () => {
  const { context } = legacyWorkspace("legacy-sealed-completed");
  const workflowId = "wf-legacy-sealed-completed";
  const planId = `${workflowId}-plan`;
  const sessionId = "session-legacy-sealed-completed";
  const snapshotPath = join(context.harnessDir, "workflows", workflowId, WORKFLOW_SNAPSHOT_FILE);
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
  // The raw legacy shape admission must survive: a sealed prepared Assignment
  // projection, a completed handoff, a plan session and a header self-amendment.
  const plans = snapshot.plans as Array<Record<string, unknown>>;
  const plan = plans[0]!;
  const originalOwnership = { ...(plan.execution_lease as Record<string, unknown>) };
  plan.coordination = {
    revision: 1,
    prepared: {
      assignment_path: join(ROOT, "assignment.md"),
      assignment_sha256: "a".repeat(64),
      plan_sha256: "b".repeat(64),
      qa_gate: "mandatory",
      findings_cleanup: "allow-residual",
      prepared_by: "host-coord",
      prepared_at: "2026-10-04T00:00:00Z",
    },
    session: { session_id: sessionId, session_file: join(context.harnessDir, "workflows", workflowId, "sessions", "plan-pm.json"), bound_at: "2026-10-04T00:00:00Z" },
    handoff: {
      id: `${planId}-attempt-1`,
      attempt: 1,
      state: "completed",
      submitted_by: sessionId,
      submitted_at: "2026-10-04T01:00:00Z",
      source_branch: `feature/${workflowId}`,
      source_sha: "c".repeat(40),
      worktree_path: join(ROOT, "legacy-worktree"),
      review_base: "c".repeat(40),
      review_head: "c".repeat(40),
      qc: { decision: "Approve", reports: [{ path: join(ROOT, "qc.md"), sha256: "d".repeat(64) }], consolidated: { path: join(ROOT, "qc-s.md"), sha256: "e".repeat(64) } },
      qa: { gate: "mandatory", decision: "pass", report: { path: join(ROOT, "qa.md"), sha256: "f".repeat(64) } },
      accepted_by: "host-coord",
      accepted_at: "2026-10-04T02:00:00Z",
      completed_at: "2026-10-04T03:00:00Z",
    },
  };
  plan.status = "Todo";
  snapshot.coordination = {
    coordinator: {
      session_id: "host-coord",
      session_file: join(context.harnessDir, "workflows", workflowId, "sessions", "coordinator.json"),
      bound_at: "2026-10-04T00:00:00Z",
    },
    self_amendments: [{ at: "2026-10-04T01:00:00Z", session_id: "plan-session", operation_id: "amend-op" }],
  };
  writeFileSync(snapshotPath, JSON.stringify(snapshot));
  // A real in-workflow coordinator envelope matching the binding, so the
  // import's binding verification has something to verify against.
  const coordinatorPath = join(context.harnessDir, "workflows", workflowId, "sessions", "coordinator.json");
  writeFileSync(coordinatorPath, JSON.stringify({ schema_version: 1, role: "coordinator", session_id: "host-coord", workflow_id: workflowId, harness_root: context.harnessDir }));

  const result = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-legacy-sealed-completed" });
  // The workflow is ADMITTED, not skipped as unrecognizable.
  expect(result.imported).toBe(1);
  expect(result.skipped.some((entry) => entry.path.endsWith("snapshot.json"))).toBe(false);
  const store = await openStore(context, "read");
  try {
    const coordination = JSON.parse(
      (store.db.prepare("select coordination_json from execution_plans where workflow_id = ? and plan_id = ?").get(workflowId, planId) as { coordination_json: string })
        .coordination_json,
    ) as Record<string, unknown>;
    expect(Object.keys(coordination).sort()).toEqual(["completion", "prepared"]);
    expect((coordination.prepared as Record<string, unknown>)).toMatchObject({ qa_gate: "mandatory", prepared_by: "host-coord" });
    expect((coordination.completion as Record<string, unknown>)).toMatchObject({
      source_branch: `feature/${workflowId}`, source_sha: "c".repeat(40),
      worktree_path: join(ROOT, "legacy-worktree"), completed_by: "host-coord",
    });
    const state = JSON.parse(
      (store.db.prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?").get(workflowId, planId) as { state_json: string }).state_json,
    ) as Record<string, unknown>;
    expect(state).toMatchObject({
      status: "Done",
      metadata: {
        worktree_path: originalOwnership.worktree_path,
        working_branch: originalOwnership.working_branch,
      },
    });
    const header = JSON.parse(
      (store.db.prepare("select state_json from execution_workflows where workflow_id = ?").get(workflowId) as { state_json: string }).state_json,
    ) as Record<string, unknown>;
    expect(header).not.toHaveProperty("self_amendments");
  } finally {
    store.close();
  }
});

async function historicalClaimWorkspace(name: string) {
  const { context } = legacyWorkspace(name);
  cleanCheckout(dirname(context.harnessDir), "main");
  const workflowId = `wf-${name}`;
  const planId = `${workflowId}-plan`;
  const sessionId = `session-${name}`;
  const checkout = join(ROOT, `claim-worktree-${name}`);
  const branch = `feature/${planId}`;
  cleanCheckout(checkout, branch);
  const initialized = await schema8Store(context);
  try {
    initialized.db.prepare("insert into execution_workflows(workflow_id, revision, state_json, created_at, updated_at) values (?, 1, ?, ?, ?)")
      .run(workflowId, JSON.stringify({ schema_version: 1, id: workflowId, type: "plan", status: "running", started_at: "2026-10-04", updated_at: "2026-10-04", delivery_kind: "development", branch: { source: branch, target: "main" } }), "2026-10-04", "2026-10-04");
    initialized.db.prepare("insert into execution_registry(workflow_id, entry_json) values (?, ?)")
      .run(workflowId, JSON.stringify({ id: workflowId, type: "plan", started_at: "2026-10-04", dir: `workflows/${workflowId}` }));
    initialized.db.prepare("insert into execution_plans(workflow_id, plan_id, revision, ordinal, state_json, coordination_json) values (?, ?, 1, 0, ?, ?)")
      .run(workflowId, planId, JSON.stringify({ id: planId, title: "Historical claim plan", file: `${planId}.md`, status: "Todo",
        metadata: { worktree_path: checkout, working_branch: branch } }), JSON.stringify({}));
    initialized.db.prepare("insert into execution_sessions(workflow_id, role, session_id, plan_id, epoch, revision, state, bound_at) values (?, 'plan-pm', ?, ?, 1, 1, 'suspended', '2026-10-04T00:00:00Z')")
      .run(workflowId, sessionId, planId);
    initialized.db.prepare("insert into execution_leases(workflow_id, plan_id, revision, owner_epoch, lease_json) values (?, ?, 1, 1, ?)")
      .run(workflowId, planId, JSON.stringify({ holder: sessionId, claimed_at: "2026-10-04T00:00:00Z", worktree_path: checkout, working_branch: branch, status: "held" }));
    initialized.db.prepare("insert into execution_integration_leases(workflow_id, revision, owner_epoch, lease_json) values (?, 1, 1, ?)")
      .run(workflowId, JSON.stringify({ holder: sessionId, plan_id: planId, claimed_at: "2026-10-04T00:30:00Z", source_branch: branch, target_branch: "main", status: "held" }));
    seedInput(initialized.db, workflowId, planId);
  } finally {
    initialized.close();
  }
  return { context, workflowId, planId, sessionId };
}

test("an unattested retired plan-PM integration mutex refuses the upgrade and keeps schema 8", async () => {
  const { context } = await historicalClaimWorkspace("schema8-unattested-orphan");
  const before = await protectedStore(context);

  // No attestation, and then an attestation that does not name this holder: both
  // refuse, and the store is left at schema 8 with every byte intact.
  await expect(upgradeStoreMinimal({ context, operator: "operator", operationId: "op-unattested-orphan" }))
    .rejects.toMatchObject({ code: "store.upgrade-attestation-missing" });
  expect(await protectedStore(context)).toEqual(before);
  const wrongHolder = {
    version: ACTIVATION_PROTOCOL_VERSION,
    attestedAt: "2026-10-04T04:00:00Z",
    operator: { actor: "ops-engineer", authorizationRef: "compass D29 / schema-8 cutover" },
    consumers: [{ entryId: "coordinator-omp", kind: "coordinator", entrypoint: "/opt/mstar/coordinator/dist/index.js", runtime: "node", runtimeVersion: "24.18.0", version: "3.11.2", current: true, disposition: "reloaded" }],
    stoppedSessions: [{ sessionId: "some-other-session", host: "omp", state: "stopped" }],
  };
  await expect(upgradeStoreMinimal({ context, operator: "operator", operationId: "op-unattested-orphan-2", attestation: wrongHolder }))
    .rejects.toMatchObject({ code: "store.upgrade-attestation-missing" });
  expect(await protectedStore(context)).toEqual(before);
  const store = await openStore(context, "read");
  try {
    expect(store.schemaVersion).toBe(8);
    expect(store.db.prepare("select count(*) as n from execution_sessions where role = 'plan-pm'").get()).toEqual({ n: 1 });
    expect(store.db.prepare("select count(*) as n from execution_integration_leases").get()).toEqual({ n: 1 });
  } finally {
    store.close();
  }
});

for (const invalid of [
  { name: "thin-stop-list", document: { stoppedSessions: [{ sessionId: "retired", state: "stopped" }] }, code: "store.attestation-invalid" },
  { name: "malformed-instant", document: { ...stopDocument("retired"), attestedAt: "not-an-instant" }, code: "store.attestation-invalid" },
  { name: "missing-current-consumer", document: { ...stopDocument("retired"), consumers: [] }, code: "store.activation-blocked" },
  { name: "unauthorized-operator", document: { ...stopDocument("retired"), operator: { actor: "operator" } }, code: "store.attestation-invalid" },
]) {
  test(`low-level init and upgrade reject ${invalid.name} before changing the store`, async () => {
    const empty: StoreContext = { harnessDir: join(ROOT, `low-init-${invalid.name}`) };
    mkdirSync(empty.harnessDir, { recursive: true });
    await expect(initializeStore(empty, { attestation: invalid.document })).rejects.toMatchObject({ code: invalid.code });
    expect(existsSync(storeDbPath(empty))).toBe(false);
    const created = await initializeStore(empty, { attestation: stopDocument("retired") });
    try {
      expect(created.schemaVersion).toBe(MIGRATIONS.length);
    } finally {
      created.close();
    }
    const { context, sessionId } = await historicalClaimWorkspace(`low-upgrade-${invalid.name}`);
    const before = await protectedStore(context);
    await expect(upgradeStore(context, { attestation: invalid.document })).rejects.toMatchObject({ code: invalid.code });
    expect(await protectedStore(context)).toEqual(before);
    expect(await upgradeStore(context, { attestation: stopDocument(sessionId) })).toEqual({ schemaVersion: MIGRATIONS.length });
  });
}

for (const boundary of [
  { name: "future-stop", stopAt: "2999-01-01T00:00:00Z", claimAt: "2026-10-04T00:30:00Z", accepted: false },
  { name: "claim-newer-than-stop", stopAt: "2026-10-04T00:29:59Z", claimAt: "2026-10-04T00:30:00Z", accepted: false },
  { name: "equivalent-offset", stopAt: "2026-10-03T20:30:00-04:00", claimAt: "2026-10-04T08:30:00+08:00", accepted: true },
]) {
  test(`schema cutover compares parsed instants for ${boundary.name}`, async () => {
    const { context, workflowId, sessionId } = await historicalClaimWorkspace(`time-${boundary.name}`);
    const fixture = await openStore(context, "write");
    let claim: Record<string, unknown>;
    try {
      const row = fixture.db.prepare("select lease_json from execution_integration_leases where workflow_id = ?")
        .get(workflowId) as { lease_json: string };
      claim = { ...JSON.parse(row.lease_json), claimed_at: boundary.claimAt };
      fixture.db.prepare("update execution_integration_leases set lease_json = ? where workflow_id = ?")
        .run(JSON.stringify(claim), workflowId);
    } finally {
      fixture.close();
    }
    const before = await protectedStore(context);
    const document = stopDocument(sessionId, boundary.stopAt);
    if (!boundary.accepted) {
      await expect(upgradeStore(context, { attestation: document })).rejects.toMatchObject({ code: "store.upgrade-attestation-missing" });
      expect(await protectedStore(context)).toEqual(before);
    }
    const accepted = boundary.accepted ? document : stopDocument(sessionId);
    expect(await upgradeStore(context, { attestation: accepted })).toEqual({ schemaVersion: MIGRATIONS.length });
    const upgraded = await openStore(context, "read");
    try {
      const row = upgraded.db.prepare("select revision, owner_epoch, lease_json from execution_integration_leases where workflow_id = ?")
        .get(workflowId) as { revision: number; owner_epoch: number; lease_json: string };
      expect(row.revision).toBe(2);
      expect(row.owner_epoch).toBe(1);
      expect(JSON.parse(row.lease_json)).toEqual({
        ...claim!, status: "released", prior_holder: sessionId, released_by: "store-upgrade",
        released_at: accepted.attestedAt, release_reason: `retired-plan-pm-seat:${sessionId}`,
      });
    } finally {
      upgraded.close();
    }
  });
}

for (const obsoleteLease of ["missing", "mismatched"] as const) {
  test(`a ${obsoleteLease} obsolete row lease does not seal the retired holder's actual claim plan`, async () => {
    const { context, workflowId, planId, sessionId } = await historicalClaimWorkspace(`lease-${obsoleteLease}`);
    const claimPlanId = `${planId}-actual-claim`;
    const fixture = await openStore(context, "write");
    try {
      // The retired session remains scoped to the original row. Its integration
      // claim belongs to another REAL row in this workflow, which must be used.
      fixture.db.prepare("insert into execution_plans(workflow_id, plan_id, revision, ordinal, state_json, coordination_json) values (?, ?, 1, 1, ?, '{}')")
        .run(workflowId, claimPlanId, JSON.stringify({ id: claimPlanId, title: "Actual integration plan", file: `${claimPlanId}.md`, status: "InReview" }));
      seedInput(fixture.db, workflowId, claimPlanId);
      const row = fixture.db.prepare("select lease_json from execution_integration_leases where workflow_id = ?")
        .get(workflowId) as { lease_json: string };
      fixture.db.prepare("update execution_integration_leases set lease_json = ? where workflow_id = ?")
        .run(JSON.stringify({ ...JSON.parse(row.lease_json), plan_id: claimPlanId }), workflowId);
      if (obsoleteLease === "missing") {
        fixture.db.prepare("delete from execution_leases where workflow_id = ? and plan_id = ?").run(workflowId, planId);
      } else {
        const lease = fixture.db.prepare("select lease_json from execution_leases where workflow_id = ? and plan_id = ?")
          .get(workflowId, planId) as { lease_json: string };
        fixture.db.prepare("update execution_leases set lease_json = ? where workflow_id = ? and plan_id = ?")
          .run(JSON.stringify({ ...JSON.parse(lease.lease_json), holder: "unrelated-old-holder", plan_id: "obsolete-wrong-plan" }), workflowId, planId);
      }
    } finally {
      fixture.close();
    }
    await upgradeStore(context, { attestation: stopDocument(sessionId) });
    const upgraded = await openStore(context, "read");
    try {
      const row = upgraded.db.prepare("select lease_json from execution_integration_leases where workflow_id = ?")
        .get(workflowId) as { lease_json: string };
      expect(JSON.parse(row.lease_json)).toMatchObject({ plan_id: claimPlanId, status: "released", prior_holder: sessionId });
      expect(upgraded.db.prepare("select name from sqlite_schema where type = 'table' and name = 'execution_leases'").get()).toBeUndefined();
      expect(upgraded.db.prepare("select * from execution_sessions where role = 'plan-pm'").all()).toEqual([]);
      const state = await readExecutionState(context);
      expect(state.data.workflows[0]?.plans.find((entry) => entry.plan.id === claimPlanId)?.plan.status).toBe("InReview");
    } finally {
      upgraded.close();
    }
  });
}

test("retirement matches workflow and session together and preserves foreign and nonretired claims byte-for-byte", async () => {
  const { context, workflowId, planId, sessionId } = await historicalClaimWorkspace("workflow-session-pairs");
  const variants = [
    { id: `${workflowId}-retired-peer`, role: "plan-pm", sessionId },
    { id: `${workflowId}-foreign-same-id`, role: "coordinator", sessionId },
    { id: `${workflowId}-live-coordinator`, role: "coordinator", sessionId: "live-coordinator" },
  ];
  const fixture = await openStore(context, "write");
  const preservedClaims: Record<string, unknown> = {};
  const preservedSessions: Record<string, unknown> = {};
  try {
    for (const variant of variants) {
      fixture.db.prepare("insert into execution_workflows(workflow_id, revision, state_json, created_at, updated_at) values (?, 1, ?, ?, ?)")
        .run(variant.id, JSON.stringify({ schema_version: 1, id: variant.id, type: "plan", status: "running",
          started_at: "2026-10-04", updated_at: "2026-10-04", delivery_kind: "development",
          branch: { source: `feature/${variant.id}`, target: "main" } }), "2026-10-04", "2026-10-04");
      fixture.db.prepare("insert into execution_registry(workflow_id, entry_json) values (?, ?)")
        .run(variant.id, JSON.stringify({ id: variant.id, type: "plan", started_at: "2026-10-04", dir: `workflows/${variant.id}` }));
      // Repeated plan/session IDs in separate workflows are intentional.
      fixture.db.prepare("insert into execution_plans(workflow_id, plan_id, revision, ordinal, state_json, coordination_json) values (?, ?, 1, 0, ?, '{}')")
        .run(variant.id, planId, JSON.stringify({ id: planId, title: "Independent workflow row", file: `${planId}.md`, status: "InProgress" }));
      seedInput(fixture.db, variant.id, planId);
      fixture.db.prepare("insert into execution_sessions(workflow_id, role, session_id, plan_id, epoch, revision, state, bound_at) values (?, ?, ?, ?, 1, 1, 'active', '2026-10-04T00:00:00Z')")
        .run(variant.id, variant.role, variant.sessionId, variant.role === "plan-pm" ? planId : null);
      fixture.db.prepare("insert into execution_integration_leases(workflow_id, revision, owner_epoch, lease_json) values (?, 3, 1, ?)")
        .run(variant.id, JSON.stringify({ holder: variant.sessionId, plan_id: planId, claimed_at: "2026-10-04T00:30:00Z",
          source_branch: `feature/${variant.id}`, target_branch: "main", status: "held" }));
      if (variant.role === "coordinator") {
        preservedClaims[variant.id] = fixture.db.prepare("select * from execution_integration_leases where workflow_id = ?").get(variant.id);
        preservedSessions[variant.id] = fixture.db.prepare("select workflow_id, role, session_id, epoch, revision, state, bound_at from execution_sessions where workflow_id = ?").get(variant.id);
      }
    }
  } finally {
    fixture.close();
  }
  const document = stopDocument(sessionId);
  // Stop evidence naming a nonretired identity still grants no retirement.
  document.stoppedSessions.push({ sessionId: "live-coordinator", host: "omp", state: "stopped" });
  await upgradeStore(context, { attestation: document });
  const upgraded = await openStore(context, "read");
  try {
    for (const id of [workflowId, variants[0]!.id]) {
      const row = upgraded.db.prepare("select lease_json from execution_integration_leases where workflow_id = ?").get(id) as { lease_json: string };
      expect(JSON.parse(row.lease_json)).toMatchObject({ holder: sessionId, plan_id: planId, status: "released", prior_holder: sessionId });
    }
    for (const id of Object.keys(preservedClaims)) {
      expect(upgraded.db.prepare("select * from execution_integration_leases where workflow_id = ?").get(id)).toEqual(preservedClaims[id]);
      expect(upgraded.db.prepare("select * from execution_sessions where workflow_id = ?").get(id)).toEqual(preservedSessions[id]);
    }
    expect(upgraded.db.prepare("select * from execution_sessions where role = 'plan-pm'").all()).toEqual([]);
    const state = await readExecutionState(context);
    for (const variant of variants) {
      expect(state.data.workflows.find((entry) => entry.state.id === variant.id)?.plans[0]?.plan.status).toBe("InProgress");
    }
  } finally {
    upgraded.close();
  }
});

test("a logical missing-plan claim refuses unchanged and recovers from its genuine pre-corruption backup", async () => {
  const { context, workflowId, planId, sessionId } = await historicalClaimWorkspace("corrupt-claim-recovery");
  const before = await protectedStore(context);
  const backup = await backupStore(context, { out: join(context.harnessDir, "archived", "pre-corruption.db") });
  expect(backup.schemaVersion).toBe(8);
  expect(backup.execution?.authorityState).toBe("active");
  const fixture = await openStore(context, "write");
  try {
    const row = fixture.db.prepare("select lease_json from execution_integration_leases where workflow_id = ?").get(workflowId) as { lease_json: string };
    // Only the logical claim target is corrupt. Business rows and structural
    // FKs stay inventoryable, so the supported recovery admission applies.
    fixture.db.prepare("update execution_integration_leases set lease_json = ? where workflow_id = ?")
      .run(JSON.stringify({ ...JSON.parse(row.lease_json), plan_id: "absent-business-plan" }), workflowId);
  } finally {
    fixture.close();
  }
  const corrupt = await protectedStore(context);
  await expect(upgradeStoreMinimal({
    context, operator: "operator", operationId: "corrupt-upgrade", attestation: stopDocument(sessionId),
  })).rejects.toMatchObject({ code: "store.corrupt" });
  expect(await protectedStore(context)).toEqual(corrupt);
  const preview = await previewExecutionRestore(context, backup.backupPath);
  expect(preview.liveStoreId).toBe(backup.storeId);
  expect(preview.backupEpoch).toBe(backup.epoch);
  expect(preview.lostOperationIds).toEqual([]);
  expect(preview.authorityDifferences.map((difference) => ({ domain: difference.domain, key: difference.key })))
    .toEqual([{ domain: "execution", key: `integration-lease:${workflowId}` }]);
  expect(await protectedStore(context)).toEqual(corrupt);
  const restored = await restoreExecutionBackup(context, {
    preview, operator: "fixture-operator", authorization: "restore-pre-corruption-point",
  });
  expect(restored.storeId).toBe(backup.storeId);
  expect(restored.epoch).toBe(Math.max(preview.liveEpoch, backup.epoch) + 1);
  expect(restored.restoredFromSha256).toBe(preview.backupSha256);
  expect(restored.preRestoreBackup.schemaVersion).toBe(8);
  expect(restored.recoveryReceiptPath).not.toBeNull();
  const recoveryRecord = JSON.parse(readFileSync(restored.recoveryReceiptPath!, "utf8"));
  expect(recoveryRecord).toMatchObject({
    phase: "replaced", operator: "fixture-operator", authorization: "restore-pre-corruption-point",
    // The record names the SELECTED recovery point, which is a pathname a reader
    // can still follow afterwards. The staged image the rows were read from is
    // this attempt's own scratch and is disclosed separately by
    // `restoredCopyPath`, which is gone once the attempt finishes.
    backupPath: backup.backupPath, backupSha256: preview.backupSha256,
    verified: { integrity: "ok", foreignKeys: "ok", schemaVersion: 8, executionAuthorityState: "active" },
  });
  expect(existsSync(recoveryRecord.backupPath)).toBe(true);
  expect(existsSync(String(recoveryRecord.restoredCopyPath))).toBe(false);
  const recovered = await protectedStore(context);
  expect(recovered.schema).toEqual(before.schema);
  const originalMeta = JSON.parse(before.tables.store_meta![0]!);
  const restoredMeta = JSON.parse(recovered.tables.store_meta![0]!);
  expect(restoredMeta).toEqual({ ...originalMeta, authority_epoch: restored.epoch });
  // Every authority row is the selected point's, with ONE intended addition:
  // the restore commits its complete recovery record into the store's own
  // operation ledger in the same transaction as the authority it describes, so
  // the record and the restored generation are observable together.
  const restoreReceipts = (rows: readonly string[] | undefined): string[] =>
    (rows ?? []).filter((row) => row.includes('"operation_id":"restore-attempt:'));
  expect(restoreReceipts(recovered.tables.store_operations)).toHaveLength(1);
  for (const table of Object.keys(before.tables).filter((table) => table !== "store_meta")) {
    if (table === "store_operations") {
      expect((recovered.tables[table] ?? []).filter((row) => !row.includes('"operation_id":"restore-attempt:')))
        .toEqual(before.tables[table] ?? []);
      continue;
    }
    expect(recovered.tables[table]).toEqual(before.tables[table]);
  }
  await upgradeStoreMinimal({
    context, operator: "operator", operationId: "recovered-upgrade", attestation: stopDocument(sessionId),
    // The restored generation holds the same native workflow the retained legacy
    // source names, so this retry keeps the native row and skips only its IMPORT.
    acknowledgedWorkflowSkips: [workflowId],
  });
  await continuePlan(context, workflowId, planId);
});

test("one store upgrade completes staged store and execution authorities with populated legacy rows", async () => {
  const { context } = legacyWorkspace("staged-authorities");
  const store = await initializeStore(context);
  try {
    store.db.prepare("update execution_meta set authority_state = 'staged' where id = 1").run();
    store.db.prepare("update store_meta set authority_state = 'staged' where id = 1").run();
  } finally {
    store.close();
  }
  const result = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-staged-authorities" });
  expect(result).toMatchObject({ verdict: "upgraded", imported: 1, authorityState: "active" });
  const upgraded = await openStore(context, "read");
  try {
    expect(upgraded.db.prepare("select authority_state from store_meta where id = 1").get()).toEqual({ authority_state: "active" });
    expect(upgraded.db.prepare("select authority_state from execution_meta where id = 1").get()).toEqual({ authority_state: "active" });
    expect(upgraded.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 1 });
  } finally {
    upgraded.close();
  }
});

test("active-store import drops a legacy per-plan claim without changing epoch", async () => {
  const { context } = legacyWorkspace("active-held-lease");
  const snapshotPath = join(context.harnessDir, "workflows", "wf-active-held-lease", WORKFLOW_SNAPSHOT_FILE);
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as { plans: Array<Record<string, unknown>> };
  snapshot.plans[0]!.status = "InProgress";
  writeFileSync(snapshotPath, JSON.stringify(snapshot));
  const initialized = await initializeStore(context);
  try {
    const now = "2026-10-04T00:00:00Z";
    initialized.db.prepare("update execution_meta set authority_state = 'active', revision = revision + 1, root_updated_at = ?, activated_at = ? where id = 1")
      .run(now, now);
  } finally {
    initialized.close();
  }

  const before = await openStore(context, "read");
  let epoch: number;
  try {
    epoch = (before.db.prepare("select authority_epoch from store_meta where id = 1").get() as { authority_epoch: number }).authority_epoch;
  } finally {
    before.close();
  }
  const result = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-active-held-lease" });
  expect(result).toMatchObject({ verdict: "upgraded", imported: 1, authorityState: "active" });
  expect(result.dispositions).toEqual([
    "workflow wf-active-held-lease plan wf-active-held-lease-plan: legacy per-plan execution lease dropped on import; the row imports as Blocked and the coordinator continues it through ordinary plan operations",
    "workflow wf-active-held-lease plan wf-active-held-lease-plan: legacy plan-PM session binding dropped on import; that seat no longer exists",
  ]);
  const state = await readExecutionState(context);
  const importedPlan = state.data.workflows[0]?.plans[0];
  expect(importedPlan?.plan.status).toBe("Blocked");
  const after = await openStore(context, "read");
  try {
    expect(after.db.prepare("select authority_epoch from store_meta where id = 1").get()).toEqual({ authority_epoch: epoch });
    expect(after.db.prepare("select count(*) as n from execution_sessions").get()).toEqual({ n: 0 });
  } finally {
    after.close();
  }
});

test("import records that stale integration leases must be reclaimed", async () => {
  const { context } = legacyWorkspace("integration-lease-disposition");
  const workflowId = "wf-integration-lease-disposition";
  const workflowDir = join(context.harnessDir, "workflows", workflowId);
  const coordinatorId = "session-coordinator-integration-lease";
  const coordinatorPath = join(workflowDir, "sessions", "coordinator.json");
  writeFileSync(coordinatorPath, JSON.stringify({
    schema_version: 1,
    role: "coordinator",
    session_id: coordinatorId,
    workflow_id: workflowId,
    harness_root: context.harnessDir,
  }));
  const snapshotPath = join(workflowDir, WORKFLOW_SNAPSHOT_FILE);
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
  snapshot.coordination = {
    coordinator: { session_id: coordinatorId, session_file: coordinatorPath, bound_at: "2026-10-04T00:00:00Z" },
  };
  snapshot.integration_merge_lease = {
    holder: coordinatorId,
    plan_id: "wf-integration-lease-disposition-plan",
    claimed_at: "2026-10-04T00:00:00Z",
    source_branch: "feature/source",
    target_branch: "main",
  };
  writeFileSync(snapshotPath, JSON.stringify(snapshot));

  const result = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-integration-lease-disposition" });
  expect(result).toMatchObject({ verdict: "upgraded", imported: 1 });
  expect(result.dispositions).toContain(
    `workflow ${workflowId}: integration merge lease dropped on import; the coordinator re-establishes serial integration ownership through the ordinary completion operation`,
  );
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select count(*) as n from execution_integration_leases").get()).toEqual({ n: 0 });
  } finally {
    store.close();
  }
});

test("a discovered workspace store stays reachable: upgrade imports into the same db instead of creating a second empty store", async () => {
  // Process discovery selects the .mstar store before the domain context is
  // constructed. Preserve its marked data and import into that same database,
  // never a second, empty store at the workspace root.
  const repoRoot = join(ROOT, "git-root-reachable");
  mkdirSync(join(repoRoot, ".mstar"), { recursive: true });
  const discovered = resolveProcessHarnessDir(repoRoot);
  expect(discovered).toBe(join(repoRoot, ".mstar"));
  if (discovered === null) throw new Error("the workspace harness must be discoverable");
  const storeContext: StoreContext = { harnessDir: discovered };
  const seeded = await initializeStore(storeContext);
  try { seeded.close(); } catch { /* already closed by initializeStore */ }
  const marked = await openStore(storeContext, "read");
  const seededEpoch = marked.epoch;
  const seededStoreId = marked.storeId;
  try {
    marked.close();
  } catch { /* handle may self-close on read mode */ }
  // Old-layout corpus INSIDE the .mstar harness: root register + one workflow.
  writeFileSync(join(repoRoot, ".mstar", "status.json"), JSON.stringify({
    version: 2, updated_at: "2026-10-04",
    workflows: [{ id: "wf-legacy-git-root", type: "plan", started_at: "2026-10-04", dir: "workflows/wf-legacy-git-root" }],
  }));
  const workflowDir = join(repoRoot, ".mstar", "workflows", "wf-legacy-git-root");
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(workflowDir, WORKFLOW_SNAPSHOT_FILE), JSON.stringify({
    schema_version: 1, id: "wf-legacy-git-root", type: "plan", status: "running",
    started_at: "2026-10-04", updated_at: "2026-10-04", delivery_kind: "development",
    branch: { source: "feature/wf-legacy-git-root", target: "main" },
    plans: [{ id: "wf-legacy-git-root-plan", title: "Legacy plan", file: "wf-legacy-git-root-plan.md", status: "Todo" }],
  }));

  const result = await upgradeStoreMinimal({ context: storeContext, operator: "operator", operationId: "op-git-root-reachable" });
  expect(result).toMatchObject({ verdict: "upgraded", imported: 1, authorityState: "active" });

  // The SAME database received the import; no second store was created at
  // the repo root.
  expect(requiresNewRootStore(repoRoot)).toBe(false);
  const reopened = await openStore(storeContext, "read");
  try {
    expect(reopened.storeId).toBe(seededStoreId);
    expect(reopened.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 1 });
    expect(reopened.db.prepare("select workflow_id from execution_workflows").get()).toEqual({ workflow_id: "wf-legacy-git-root" });
    const reachable = await readExecutionState(storeContext);
    expect(reachable.data.workflows.map((w) => w.state.id)).toEqual(["wf-legacy-git-root"]);
    expect(reachable.data.workflows.flatMap((w) => w.plans.map((p) => p.plan.id))).toEqual(["wf-legacy-git-root-plan"]);
  } finally {
    reopened.close();
  }
});

function requiresNewRootStore(repoRoot: string): boolean {
  // A second store would exist at <repoRoot>/store.db; the resolver-owned
  // location is <repoRoot>/.mstar/store.db. Reachability = the latter holds
  // the data and no root-level db file was created.
  return existsSync(join(repoRoot, "store.db"));
}

test("minimal import keeps an InProgress row continuable and drops the sealed Assignment projection", async () => {
  const name = "prepared-inprogress";
  const { context } = legacyWorkspace(name);
  const workflowId = `wf-${name}`;
  const planId = `${workflowId}-plan`;
  const snapshotPath = join(context.harnessDir, "workflows", workflowId, WORKFLOW_SNAPSHOT_FILE);
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
    plans: Array<{ status: string; coordination: Record<string, unknown>; metadata?: Record<string, string> }>;
  };
  snapshot.plans[0]!.status = "InProgress";
  snapshot.plans[0]!.metadata = {
    worktree_path: join(ROOT, `worktree-${name}`),
    working_branch: `feature/${workflowId}`,
  };
  snapshot.plans[0]!.coordination.prepared = {
    assignment_path: join(context.harnessDir, `${planId}.assignment.md`),
    assignment_sha256: "a".repeat(64),
    plan_sha256: "b".repeat(64),
    qa_gate: "mandatory",
    findings_cleanup: "allow-residual",
    prepared_by: "pm-fixture",
    prepared_at: "2026-10-04T00:00:00Z",
  };
  writeFileSync(snapshotPath, JSON.stringify(snapshot));

  const result = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-prepared-inprogress-import" });
  expect(result).toMatchObject({ verdict: "upgraded", imported: 1, authorityState: "active" });

  // The row is ordinary coordinator data: it imports as Blocked (its claim is
  // gone), it keeps the real configuration members, and the removed seat's
  // sealed `assignment_*` projection is dropped rather than carried forward.
  const store = await openStore(context, "read");
  try {
    const row = store.db.prepare("select state_json, coordination_json from execution_plans where workflow_id = ? and plan_id = ?")
      .get(workflowId, planId) as { state_json: string; coordination_json: string };
    const state = JSON.parse(row.state_json) as Record<string, unknown>;
    expect(state.status).toBe("Blocked");
    const coordination = JSON.parse(row.coordination_json) as { prepared?: Record<string, unknown> };
    expect(coordination.prepared).toEqual({
      qa_gate: "mandatory",
      findings_cleanup: "allow-residual",
      prepared_by: "pm-fixture",
      prepared_at: "2026-10-04T00:00:00Z",
    });
  } finally {
    store.close();
  }
  const reachable = await readExecutionState(context);
  expect(reachable.data.workflows[0]?.plans.map((plan) => plan.plan.id)).toEqual([planId]);
});

test("minimal import canonicalizes legacy plan_id rows into id", async () => {
  const { context } = legacyWorkspace("plan-id-alias");
  const snapshotPath = join(context.harnessDir, "workflows", "wf-plan-id-alias", WORKFLOW_SNAPSHOT_FILE);
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as { plans: Array<Record<string, unknown>> };
  const plan = snapshot.plans[0]!;
  plan.plan_id = plan.id;
  delete plan.id;
  writeFileSync(snapshotPath, JSON.stringify(snapshot));

  await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-plan-id-alias" });
  const store = await openStore(context, "read");
  try {
    const row = store.db.prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?").get("wf-plan-id-alias", "wf-plan-id-alias-plan") as { state_json: string };
    const imported = JSON.parse(row.state_json) as Record<string, unknown>;
    expect(imported).toMatchObject({ id: "wf-plan-id-alias-plan" });
    expect(imported).not.toHaveProperty("plan_id");
  } finally {
    store.close();
  }
});

test("minimal import preserves coordinator recovery history and drops the self-amendment audit", async () => {
  const { context } = legacyWorkspace("coordination-audit");
  const workflowDir = join(context.harnessDir, "workflows", "wf-coordination-audit");
  const coordinatorFile = join(workflowDir, "sessions", "coordinator.json");
  const coordinatorId = "coordinator-coordination-audit";
  writeFileSync(coordinatorFile, JSON.stringify({
    schema_version: 1,
    role: "coordinator",
    session_id: coordinatorId,
    workflow_id: "wf-coordination-audit",
    harness_root: context.harnessDir,
  }));
  const recovery = {
    operation_id: "recover-op",
    request_hash: "a".repeat(64),
    workflow_id: "wf-coordination-audit",
    prior_session_id: "prior-session",
    session_id: coordinatorId,
    authorization_ref: "auth-ref",
    reason: "operator-approved recovery",
    stopped_session_ids: ["prior-session"],
    snapshot_version_before: `sha256:${"b".repeat(64)}`,
    compass_version: `sha256:${"c".repeat(64)}`,
    recovered_at: "2026-10-04T00:00:00Z",
  };
  const amendment = {
    at: "2026-10-04T00:01:00Z",
    session_id: "plan-session",
    old_sha256: "d".repeat(64),
    new_sha256: "e".repeat(64),
    operation_id: "amend-op",
    prepared_by_matches: false,
  };
  const snapshotPath = join(workflowDir, WORKFLOW_SNAPSHOT_FILE);
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
  snapshot.coordination = {
    coordinator: { session_id: coordinatorId, session_file: coordinatorFile, bound_at: "2026-10-04T00:00:00Z" },
    identity_recoveries: [recovery],
    self_amendments: [amendment],
  };
  writeFileSync(snapshotPath, JSON.stringify(snapshot));

  await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-coordination-audit" });
  const store = await openStore(context, "read");
  try {
    const row = store.db.prepare("select state_json from execution_workflows where workflow_id = ?").get("wf-coordination-audit") as { state_json: string };
    const header = JSON.parse(row.state_json) as Record<string, unknown>;
    expect(header).toMatchObject({ identity_recoveries: [recovery] });
    expect(header).not.toHaveProperty("coordination");
    // The coordinator self-amendment audit belonged to the removed sealed
    // Assignment protocol; it is dropped with that protocol.
    expect(header).not.toHaveProperty("self_amendments");
  } finally {
    store.close();
  }
});

test("one command creates and activates an empty store when neither store nor register exists", async () => {
  const context = { harnessDir: join(ROOT, "empty-workspace", ".mstar") };
  const input = { context, operator: "operator", operationId: "op-empty-upgrade" };
  const result = await upgradeStoreMinimal(input);
  expect(result).toMatchObject({ verdict: "upgraded", imported: 0, skipped: [], authorityState: "active" });
  expect(result.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(await upgradeStoreMinimal(input)).toEqual(result);
});
test("no-store upgrade initializes execution schema and imports every populated workflow", async () => {
  const { context } = legacyWorkspace("no-store-populated");
  mkdirSync(join(context.harnessDir, "plans"), { recursive: true });
  const input = { context, operator: "operator", operationId: "op-no-store-populated" };

  const result = await upgradeStoreMinimal(input);
  expect(result).toMatchObject({ verdict: "upgraded", imported: 1, authorityState: "active" });

  const store = await openStore(context, "read");
  try {
    const tables = store.db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toContain("execution_workflows");
    expect(tables.map(({ name }) => name)).toContain("execution_plans");
    expect(tables.map(({ name }) => name)).toContain("execution_meta");
    expect(store.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 1 });
    expect(store.db.prepare("select count(*) as n from execution_plans").get()).toEqual({ n: 1 });
    expect(store.db.prepare("select count(*) as n from execution_sessions").get()).toEqual({ n: 0 });
    expect(store.db.prepare("select authority_state from execution_meta where id = 1").get()).toEqual({ authority_state: "active" });
    expect(store.db.prepare("select authority_state from store_meta where id = 1").get()).toEqual({ authority_state: "active" });
  } finally {
    store.close();
  }

  // A LATER operation id is not a replay: the recognized legacy source now
  // collides with the native row this store already holds, so it refuses
  // instead of silently skipping the source or guessing a prior import from a
  // matching id.
  const refused = await upgradeStoreMinimal({ ...input, operationId: "op-no-store-populated-replay" })
    .then(() => { throw new Error("a repeated legacy import under a new operation id did not refuse"); }, (error: Error & { code?: string }) => error);
  expect(refused.code).toBe("execution.migration-conflict");
  expect(refused.message).toContain("--ack-skip-workflow wf-no-store-populated");
  const afterRefusal = await openStore(context, "read");
  try {
    expect(afterRefusal.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 1 });
  } finally {
    afterRefusal.close();
  }
  // The supported recovery is the ordinary acknowledgement on the same entry:
  // the native row is kept and only the legacy IMPORT is skipped.
  const recovered = await upgradeStoreMinimal({
    ...input, operationId: "op-no-store-populated-ack",
    acknowledgedWorkflowSkips: ["wf-no-store-populated"],
  });
  expect(recovered.imported).toBe(0);
  expect(recovered.dispositions).toContainEqual(
    expect.stringContaining("workflow wf-no-store-populated: skipped by --ack-skip-workflow"),
  );
  const afterRecovery = await openStore(context, "read");
  try {
    expect(afterRecovery.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 1 });
  } finally {
    afterRecovery.close();
  }
});



test("registered workflows without snapshots are recorded as skips", async () => {
  const { context } = legacyWorkspace("missing-snapshot");
  rmSync(join(context.harnessDir, "workflows", "wf-missing-snapshot", WORKFLOW_SNAPSHOT_FILE));
  writeFileSync(join(context.harnessDir, "workflows", "wf-missing-snapshot", "sessions", "foreign.json"), JSON.stringify({
    schema_version: 1,
    role: "coordinator",
    session_id: "foreign-session",
    workflow_id: "wf-another-workflow",
    harness_root: context.harnessDir,
  }));
  const missing = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-missing-snapshot" });
  expect(missing.imported).toBe(0);
  expect(missing.skipped).toEqual([{
    path: "workflows/wf-missing-snapshot/snapshot.json",
    reason: "registered workflow snapshot is missing; left in place",
  }]);
});

test("unparseable registered snapshot is skipped while healthy workflows import", async () => {
  const { context } = legacyWorkspace("corrupt-snapshot");
  const statusPath = join(context.harnessDir, "status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8")) as { workflows: unknown[] };
  const badId = "wf-corrupt-registered-snapshot";
  const badDir = join(context.harnessDir, "workflows", badId);
  const badPath = join(badDir, WORKFLOW_SNAPSHOT_FILE);
  mkdirSync(badDir, { recursive: true });
  const badBytes = Buffer.from("{ definitely not json");
  writeFileSync(badPath, badBytes);
  status.workflows.push({ id: badId, type: "plan", started_at: "2026-10-04", dir: `workflows/${badId}` });
  writeFileSync(statusPath, JSON.stringify(status));

  const result = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-corrupt-snapshot" });
  expect(result.imported).toBe(1);
  expect(result.skipped).toContainEqual({
    path: `workflows/${badId}/snapshot.json`,
    reason: "unparseable snapshot; left in place",
  });
  expect(readFileSync(badPath)).toEqual(badBytes);
});

test("unregistered workflow directories without snapshots are skipped as a whole", async () => {
  const harnessDir = join(ROOT, "unregistered-empty", ".mstar");
  mkdirSync(join(harnessDir, "workflows", "unregistered-workflow"), { recursive: true });
  const result = await upgradeStoreMinimal({
    context: { harnessDir },
    operator: "operator",
    operationId: "op-unregistered-empty",
  });
  expect(result).toMatchObject({ verdict: "upgraded", imported: 0, skipped: [], authorityState: "active" });
});

test("unregistered snapshot directories import while empty unregistered directories remain ignored", async () => {
  const { context } = legacyWorkspace("unregistered-populated");
  const registeredDir = join(context.harnessDir, "workflows", "wf-unregistered-populated");
  const snapshot = JSON.parse(readFileSync(join(registeredDir, WORKFLOW_SNAPSHOT_FILE), "utf8")) as Record<string, unknown>;
  snapshot.id = "wf-unregistered-snapshot";
  snapshot.plans = [];
  delete snapshot.coordination;
  const unregisteredDir = join(context.harnessDir, "workflows", "wf-unregistered-snapshot");
  mkdirSync(unregisteredDir, { recursive: true });
  writeFileSync(join(unregisteredDir, WORKFLOW_SNAPSHOT_FILE), JSON.stringify(snapshot));
  mkdirSync(join(context.harnessDir, "workflows", "unregistered-empty"), { recursive: true });
  const result = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-unregistered-snapshot" });
  expect(result).toMatchObject({ verdict: "upgraded", imported: 2, authorityState: "active" });
  expect(result.skipped).toEqual([
    { path: "workflows/wf-unregistered-populated/sessions/plan-pm.json", reason: "legacy plan-PM session envelope dropped; the seat was removed" },
    { path: "workflows/wf-unregistered-populated/unknown.bin", reason: "unrecognized workflow entry; left in place" },
  ]);
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 2 });
    expect(store.db.prepare("select count(*) as n from execution_registry").get()).toEqual({ n: 1 });
    expect(store.db.prepare("select workflow_id from execution_workflows where workflow_id = ?").get("wf-unregistered-snapshot"))
      .toEqual({ workflow_id: "wf-unregistered-snapshot" });
  } finally {
    store.close();
  }
});

test("path escape and foreign workflow ownership remain integrity refusals", async () => {
  const escaped = legacyWorkspace("path-escape");
  writeFileSync(join(escaped.context.harnessDir, "status.json"), JSON.stringify({
    version: 2,
    updated_at: "2026-10-04",
    workflows: [{ id: "wf-path-escape", type: "plan", started_at: "2026-10-04", dir: "../outside" }],
  }));
  await expect(upgradeStoreMinimal({ context: escaped.context, operator: "operator", operationId: "op-path-escape" }))
    .rejects.toMatchObject({
      code: "execution.migration-conflict",
      message: expect.stringContaining("workflow wf-path-escape records dir"),
    });

  const foreign = legacyWorkspace("foreign-owner");
  const sessions = join(foreign.context.harnessDir, "workflows", "wf-foreign-owner", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "foreign.json"), JSON.stringify({
    schema_version: 1,
    role: "coordinator",
    session_id: "foreign-session",
    workflow_id: "wf-another-workflow",
    harness_root: foreign.context.harnessDir,
  }));
  await expect(upgradeStoreMinimal({ context: foreign.context, operator: "operator", operationId: "op-foreign-owner" }))
    .rejects.toMatchObject({ code: "execution.migration-conflict" });

  const malformed = legacyWorkspace("malformed-session");
  writeFileSync(join(malformed.context.harnessDir, "workflows", "wf-malformed-session", "sessions", "plan-pm.json"), "{");
  // A malformed legacy plan-PM envelope is now simply unrecognizable and left
  // in place: the seat it belonged to is gone, so it cannot conflict with any
  // binding this store still holds.
  const tolerated = await upgradeStoreMinimal({ context: malformed.context, operator: "operator", operationId: "op-malformed-session" });
  expect(tolerated.imported).toBe(1);
  expect(tolerated.skipped).toContainEqual({
    path: "workflows/wf-malformed-session/sessions/plan-pm.json",
    reason: "unrecognizable session envelope; left in place",
  });
});

test("same operation replays and a reused operation id with a different operator conflicts", async () => {
  const { context } = legacyWorkspace("replay-conflict");
  const input = { context, operator: "operator", operationId: "op-replay" };
  const first = await upgradeStoreMinimal(input);
  expect(await upgradeStoreMinimal(input)).toEqual(first);
  await expect(upgradeStoreMinimal({ ...input, operator: "another" })).rejects.toMatchObject({ code: "execution.operation-conflict" });
  // The imported input is part of the request identity: the SAME operator and
  // operation id over changed legacy bytes is a conflict, never a receipt that
  // describes bytes this run never imported.
  const snapshotPath = join(context.harnessDir, "workflows", "wf-replay-conflict", WORKFLOW_SNAPSHOT_FILE);
  const edited = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
  edited.updated_at = "2026-10-13";
  writeFileSync(snapshotPath, JSON.stringify(edited));
  await expect(upgradeStoreMinimal(input)).rejects.toMatchObject({ code: "execution.operation-conflict" });
});

test("minimal activation retains a manually constructed legacy registration recovery journal", async () => {
  const { context } = legacyWorkspace("pending-catalog");
  const workflowId = "wf-pending-catalog";
  const operationId = "op-pending-catalog";
  const store = await initializeStore(context);
  try {
    store.db.prepare(
      "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) " +
        "values (?, ?, 'execution-written', ?, '{}', '{}', null, ?, ?)",
    ).run(
      operationId,
      "legacy-pending-hash",
      JSON.stringify({ version: 1, workflow: { kind: "plan", workflowId } }),
      "2026-10-04T00:00:00.000Z",
      "2026-10-04T00:00:00.000Z",
    );
  } finally {
    store.close();
  }

  setArtifactStore(createFsStore(context.harnessDir));
  const imported = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-import-pending-catalog" });
  expect(imported).toMatchObject({ verdict: "upgraded", imported: 1, authorityState: "active" });
  expect(await listPendingCatalogRegistrations(context)).toContainEqual(
    expect.objectContaining({ operationId, workflowId, phase: "execution-written", rootVisible: true }),
  );
});

/* ------------------------------------------------------------------------ *
 * Direct v1 root conversion
 * ------------------------------------------------------------------------ */

/**
 * The declaration `v1-standalone` (the fixture's one ACTIVE standalone lift)
 * needs: a plan workflow fixes its delivery kind at registration, so the
 * ordinary upgrade must declare it.
 */
const V1_STANDALONE_DECLARATION: DeliveryLiftDeclaration[] = [
  { workflow: "v1-standalone", deliveryKind: "development", branchSource: "feature/v1-standalone", branchTarget: "main" },
];

/** Write a recognizable v1 root tree (version 1 + one standalone Done plan). */
function legacyV1Workspace(name: string): { context: StoreContext; statusBytes: Buffer } {
  const harnessDir = join(ROOT, name, ".mstar");
  const workflowId = `wf-${name}`;
  mkdirSync(join(harnessDir, "iterations", "iter-v1"), { recursive: true });
  writeFileSync(join(harnessDir, "iterations", "iter-v1", "delivery-compass.md"), [
    "---",
    "iteration_id: iter-v1",
    "start_date: 2026-10-01",
    "status: active",
    "plans:",
    `  - ${workflowId}`,
    "---",
    "",
  ].join("\n"));
  const statusBytes = Buffer.from(`${JSON.stringify({
    version: 1,
    updated_at: "2026-10-04",
    plans: [
      { id: workflowId, title: "Legacy v1 plan", file: `${workflowId}.md`, status: "Done", done_at: "2026-10-02" },
      { id: "v1-standalone", title: "Standalone v1 plan", file: "v1-standalone.md", status: "Todo" },
    ],
    metadata: {
      iteration_base_branch: "integration/v1",
      target_branch: "main",
      harness_root: harnessDir,
      program_roadmap: { title: "Retained program roadmap", milestones: [{ id: "m1", title: "Keep this fact" }] },
      integration_merge_lease: {
        holder: "legacy-coordinator",
        claimed_at: "2026-10-04T00:00:00Z",
        source_branch: "feature/legacy",
        target_branch: "main",
      },
    },
  }, null, 2)}\n`);
  writeFileSync(join(harnessDir, "status.json"), statusBytes);
  writeFileSync(join(harnessDir, "plain-doc.md"), "# unrelated document\n");
  return { context: { harnessDir }, statusBytes };
}

test("a v1 public upgrade refuses a symlinked workflows tree instead of silently skipping it", async () => {
  const { context } = legacyV1Workspace("v1-unsafe-workflows");
  // A recognizable v1 root takes the in-memory conversion route, which never
  // enumerates `workflows/`; the tree-safety precondition must still run before
  // either route commits, exactly like the v2 route's own refusal.
  const realTree = join(context.harnessDir, "elsewhere-v1-tree");
  mkdirSync(join(realTree, "wf-linked"), { recursive: true });
  writeFileSync(join(realTree, "wf-linked", "snapshot.json"), "{}\n");
  symlinkSync(realTree, join(context.harnessDir, "workflows"));

  await expect(upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-v1-unsafe-workflows",
    deliveryDeclarations: V1_STANDALONE_DECLARATION,
  })).rejects.toMatchObject({
    code: "execution.migration-conflict",
    message: expect.stringContaining("is not a real directory"),
  });

  // Nothing committed: the store holds no execution rows from this run.
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 0 });
  } finally {
    store.close();
  }
});

test("an acknowledged DSH-only symlinked workflows root drops that source through --ack-skip-dsh without following it", async () => {
  const { context } = legacyWorkspace("symlinked-dsh-root");
  const workflowsDir = join(context.harnessDir, "workflows");
  const registeredDir = join(workflowsDir, "wf-symlinked-dsh-root");
  // The whole `workflows/` tree is a symlink holding only legacy DSH host-state
  // data; the registered workflow lives elsewhere so the root is NOT an
  // execution source for it. The documented `dsh-workflows` acknowledgement
  // must be able to drop exactly that source instead of the preflight aborting.
  const outside = join(context.harnessDir, "outside-dsh-tree");
  mkdirSync(join(outside, "wf-linked"), { recursive: true });
  const linkedIds = '{"id":"wfe1:root-linked","d":"root-linked-digest"}\n';
  writeFileSync(join(outside, "wf-linked", "agent-flow-ids.jsonl"), linkedIds);
  // Relocate the registered workflow OUT of `workflows/` before linking the root
  // over it, so the root is a DSH-only source rather than an execution source.
  const snapshotBytes = readFileSync(join(registeredDir, WORKFLOW_SNAPSHOT_FILE));
  const relocated = join(context.harnessDir, "relocated", "wf-symlinked-dsh-root");
  mkdirSync(relocated, { recursive: true });
  writeFileSync(join(relocated, WORKFLOW_SNAPSHOT_FILE), snapshotBytes);
  rmSync(workflowsDir, { recursive: true, force: true });
  symlinkSync(outside, workflowsDir);
  const statusPath = join(context.harnessDir, "status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8")) as { workflows: Array<Record<string, unknown>> };
  status.workflows[0]!.dir = "relocated/wf-symlinked-dsh-root";
  writeFileSync(statusPath, JSON.stringify(status));

  // Refusal without the acknowledgement, and nothing committed: the recovery
  // is discoverable from the refusal itself.
  const refused = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-symlinked-dsh-root" })
    .then(() => { throw new Error("an unacknowledged symlinked workflows root unexpectedly imported"); }, (error: Error & { code?: string }) => error);
  expect(refused.code).toBe("execution.migration-conflict");
  expect(refused.message).toContain("--ack-skip-dsh dsh-workflows");
  const beforeStore = await openStore(context, "read");
  try { expect(beforeStore.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 0 }); }
  finally { beforeStore.close(); }

  const recovered = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-symlinked-dsh-root-ack",
    acknowledgedSkips: ["dsh-workflows"],
  });
  expect(recovered).toMatchObject({ verdict: "upgraded", imported: 1, authorityState: "active" });
  expect(recovered.dsh).toMatchObject({ verdict: "partially-imported" });
  expect(recovered.dsh.findings).toContainEqual(
    expect.objectContaining({ kind: "dropped-by-ack", selector: "dsh-workflows", category: "workflows" }),
  );
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select workflow_id from execution_workflows").all()).toEqual([{ workflow_id: "wf-symlinked-dsh-root" }]);
    expect(store.db.prepare("select count(*) as n from dsh_accepted_identities").get()).toEqual({ n: 0 });
  } finally { store.close(); }
  // Nothing was followed through the root link: it is still a symlink and its
  // target bytes are untouched.
  expect(lstatSync(workflowsDir).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(outside, "wf-linked", "agent-flow-ids.jsonl"), "utf8")).toBe(linkedIds);
});

test("a symlinked workflows root that registers an execution workflow is never discarded by a DSH acknowledgement", async () => {
  const { context } = legacyWorkspace("symlinked-registered-root");
  const workflowsDir = join(context.harnessDir, "workflows");
  const target = join(context.harnessDir, "outside-registered-tree");
  mkdirSync(join(target, "wf-symlinked-registered-root"), { recursive: true });
  const snapshotBytes = readFileSync(join(workflowsDir, "wf-symlinked-registered-root", WORKFLOW_SNAPSHOT_FILE));
  writeFileSync(join(target, "wf-symlinked-registered-root", WORKFLOW_SNAPSHOT_FILE), snapshotBytes);
  rmSync(workflowsDir, { recursive: true, force: true });
  symlinkSync(target, workflowsDir);

  // The register names a workflow directory under the linked root: that is an
  // execution source, so no *Dsh* acknowledgement may drop or skip it. Only the
  // execution-specific `--ack-skip-workflow` can, and only for the named id.
  const defaults = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-registered-symlinked-root-default",
  }).then(() => { throw new Error("a registered execution source was imported through a linked root"); }, (error: Error & { code?: string }) => error);
  expect(defaults.code).toBe("execution.migration-conflict");
  const refusal = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-registered-symlinked-root",
    acknowledgedSkips: ["dsh-workflows"],
  }).then(() => { throw new Error("a registered execution source was discarded by a Dsh acknowledgement"); }, (error: Error & { code?: string }) => error);
  expect(refusal.code).toBe("execution.migration-conflict");
  expect(refusal.message).toContain("never discarded by a DSH acknowledgement");
  expect(refusal.message).toContain("--ack-skip-workflow wf-symlinked-registered-root");
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 0 });
  } finally { store.close(); }
  expect(lstatSync(workflowsDir).isSymbolicLink()).toBe(true);
});

test("an acknowledged DSH-only symlinked workflows root recovers a v1 tree too", async () => {
  const { context, statusBytes } = legacyV1Workspace("v1-symlinked-dsh-root");
  const workflowsDir = join(context.harnessDir, "workflows");
  const outside = join(context.harnessDir, "outside-v1-dsh-tree");
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, workflowsDir);

  // A v1 root's conversion never enumerates `workflows/`; before the deferral
  // the preflight aborted here and the only way forward was editing filesystem
  // state by hand.
  const recovered = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-v1-symlinked-root-ack",
    acknowledgedSkips: ["dsh-workflows"],
    deliveryDeclarations: V1_STANDALONE_DECLARATION,
  });
  expect(recovered).toMatchObject({ verdict: "upgraded", imported: 2, authorityState: "active" });
  expect(recovered.dsh.findings).toContainEqual(expect.objectContaining({ kind: "dropped-by-ack", selector: "dsh-workflows" }));
  expect([...readFileSync(join(context.harnessDir, "status.json"))]).toEqual([...statusBytes]);
  expect(lstatSync(workflowsDir).isSymbolicLink()).toBe(true);
});

test("an acknowledged DSH-only symlinked child recovers through --ack-skip-dsh without following the link", async () => {
  const { context, unknownBytes } = legacyWorkspace("symlinked-dsh-child");
  const workflowsDir = join(context.harnessDir, "workflows");
  // An UNREGISTERED symlinked child holding only legacy DSH ledger data: the
  // execution preflight must leave it to the DSH importer's own documented
  // acknowledgement instead of failing before that recovery can run.
  const outside = join(context.harnessDir, "outside-dsh");
  mkdirSync(outside, { recursive: true });
  const linkedIds = '{"id":"wfe1:linked","d":"linked-digest"}\n';
  writeFileSync(join(outside, "agent-flow-ids.jsonl"), linkedIds);
  const linkPath = join(workflowsDir, "wf-link");
  symlinkSync(outside, linkPath);

  // Refusal without the explicit acknowledgement, and nothing committed.
  await expect(upgradeStoreMinimal({ context, operator: "operator", operationId: "op-symlinked-dsh-child" }))
    .rejects.toMatchObject({
      code: "execution.migration-conflict",
      message: expect.stringContaining("--ack-skip-dsh dsh-ledger:wf-link"),
    });
  const refused = await openStore(context, "read");
  try {
    expect(refused.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 0 });
    expect(refused.db.prepare("select count(*) as n from dsh_accepted_identities").get()).toEqual({ n: 0 });
  } finally { refused.close(); }

  const recovered = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-symlinked-dsh-child-ack",
    acknowledgedSkips: ["dsh-ledger:wf-link"],
  });
  expect(recovered).toMatchObject({ verdict: "upgraded", imported: 1, authorityState: "active" });
  expect(recovered.dsh).toMatchObject({ verdict: "partially-imported" });
  expect(recovered.dsh.findings).toContainEqual(
    expect.objectContaining({ kind: "dropped-by-ack", selector: "dsh-ledger:wf-link", category: "workflows" }),
  );
  // The registered in-root workflow still imported; the linked source did not.
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select workflow_id from execution_workflows").all()).toEqual([{ workflow_id: "wf-symlinked-dsh-child" }]);
    expect(store.db.prepare("select count(*) as n from dsh_accepted_identities").get()).toEqual({ n: 0 });
  } finally { store.close(); }
  // Nothing was followed through the link: it is still a symlink and its target
  // bytes are untouched, as is the unrelated in-root file.
  expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(outside, "agent-flow-ids.jsonl"), "utf8")).toBe(linkedIds);
  expect([...readFileSync(join(workflowsDir, "wf-symlinked-dsh-child", "unknown.bin"))]).toEqual([...unknownBytes]);
});

test("a DSH child acknowledgement cannot widen the skip to a registered symlinked workflow", async () => {
  const { context } = legacyWorkspace("symlinked-registered");
  const workflowsDir = join(context.harnessDir, "workflows");
  // The SAME child shape, but registered: the registration is an execution
  // source, so the acknowledgement must not defer it. The in-root target keeps
  // the containment guard out of the way so the per-entry no-follow guard is the
  // one that answers.
  const realInRoot = join(context.harnessDir, "real-in-root", "wf-symlinked-registered");
  mkdirSync(realInRoot, { recursive: true });
  const linkedIds = '{"id":"wfe1:registered","d":"registered-digest"}\n';
  writeFileSync(join(realInRoot, "agent-flow-ids.jsonl"), linkedIds);
  const linkPath = join(workflowsDir, "wf-symlinked-registered");
  rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(realInRoot, linkPath);

  await expect(upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-symlinked-registered",
    acknowledgedSkips: ["dsh-ledger:wf-symlinked-registered"],
  })).rejects.toMatchObject({
    code: "execution.migration-conflict",
    message: expect.stringContaining("is not a real in-root directory"),
  });
  // The acknowledged selector discarded nothing: no execution row, no DSH row,
  // and the link target was never followed or rewritten.
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 0 });
    expect(store.db.prepare("select count(*) as n from dsh_accepted_identities").get()).toEqual({ n: 0 });
  } finally { store.close(); }
  expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(realInRoot, "agent-flow-ids.jsonl"), "utf8")).toBe(linkedIds);
});

test("an explicit execution acknowledgement skips exactly the named registered linked source and reports the loss", async () => {
  const { context } = legacyWorkspace("acked-registered-root");
  const workflowsDir = join(context.harnessDir, "workflows");
  const target = join(context.harnessDir, "outside-acked-tree");
  mkdirSync(join(target, "wf-acked-registered-root"), { recursive: true });
  const snapshotBytes = readFileSync(join(workflowsDir, "wf-acked-registered-root", WORKFLOW_SNAPSHOT_FILE));
  writeFileSync(join(target, "wf-acked-registered-root", WORKFLOW_SNAPSHOT_FILE), snapshotBytes);
  // A second registered workflow that stays a real in-root directory, plus an
  // unrelated linked source under the same root: the acknowledgement must skip
  // exactly the named id and leave both of the others alone.
  const keepId = "wf-acked-keep";
  const keepDir = join(workflowsDir, keepId);
  mkdirSync(keepDir, { recursive: true });
  const keepSnapshot = JSON.parse(snapshotBytes.toString("utf8")) as Record<string, unknown>;
  keepSnapshot.id = keepId;
  keepSnapshot.plans = [];
  keepSnapshot.status = "running";
  keepSnapshot.branch = { source: `feature/${keepId}`, target: "main" };
  writeFileSync(join(keepDir, WORKFLOW_SNAPSHOT_FILE), JSON.stringify(keepSnapshot));
  const statusPath = join(context.harnessDir, "status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8")) as { workflows: Array<Record<string, unknown>> };
  status.workflows.push({ id: keepId, type: "plan", started_at: "2026-10-04", dir: `workflows/${keepId}` });
  writeFileSync(statusPath, JSON.stringify(status));
  const linkedSnapshot = readFileSync(join(target, "wf-acked-registered-root", WORKFLOW_SNAPSHOT_FILE));
  rmSync(workflowsDir, { recursive: true, force: true });
  mkdirSync(workflowsDir);
  mkdirSync(keepDir, { recursive: true });
  writeFileSync(join(keepDir, WORKFLOW_SNAPSHOT_FILE), JSON.stringify(keepSnapshot));
  symlinkSync(join(target, "wf-acked-registered-root"), join(workflowsDir, "wf-acked-registered-root"));
  const untouchedId = "wf-acked-untouched";
  const untouchedDir = join(workflowsDir, untouchedId);
  mkdirSync(untouchedDir);
  const untouchedSnapshot = JSON.stringify({ ...keepSnapshot, id: untouchedId, branch: { source: `feature/${untouchedId}`, target: "main" } });
  writeFileSync(join(untouchedDir, WORKFLOW_SNAPSHOT_FILE), untouchedSnapshot);

  const result = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-acked-registered-root",
    // The linked child is independently a DSH source, so completing the upgrade
    // needs that domain's own acknowledgement too: the two domains stay separate.
    acknowledgedSkips: ["dsh-ledger:wf-acked-registered-root"],
    // A repeated id is a harmless caller slip: it means the same one skip.
    acknowledgedWorkflowSkips: ["wf-acked-registered-root", "wf-acked-registered-root"],
  });
  expect(result).toMatchObject({ verdict: "upgraded", imported: 2, authorityState: "active" });
  expect(result.skipped).toContainEqual({
    path: "workflows/wf-acked-registered-root",
    reason: "registered workflow wf-acked-registered-root skipped by --ack-skip-workflow; its registered legacy source is not a real in-root directory, so it was not read and no execution row was imported for it",
  });
  expect(result.dispositions).toContainEqual(expect.stringContaining("workflow wf-acked-registered-root: skipped by --ack-skip-workflow"));
  expect(result.dispositions).toContainEqual(expect.stringContaining("no resumption is fabricated"));
  const store = await openStore(context, "read");
  try {
    // Only the trusted registered workflow and the unrelated unregistered one
    // import; no row is fabricated for the skipped id or for the untracked
    // symlink beside it.
    expect(store.db.prepare("select workflow_id from execution_workflows order by workflow_id").all())
      .toEqual([{ workflow_id: keepId }, { workflow_id: untouchedId }]);
  } finally { store.close(); }
  // Nothing was followed through the link: it is still a symlink, its target
  // bytes are untouched, and the unrelated sources keep their own bytes.
  expect(lstatSync(join(workflowsDir, "wf-acked-registered-root")).isSymbolicLink()).toBe(true);
  expect([...readFileSync(join(target, "wf-acked-registered-root", WORKFLOW_SNAPSHOT_FILE))]).toEqual([...linkedSnapshot]);
  expect(readFileSync(join(untouchedDir, WORKFLOW_SNAPSHOT_FILE), "utf8")).toBe(untouchedSnapshot);
  // The skip is an import decision only: the same source retries as an ordinary
  // refusal while it stays linked, and the registration is untouched.
  const retried = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-acked-registered-root-omit",
  }).then(() => { throw new Error("an omitted acknowledgement silently skipped a registered source"); }, (error: Error & { code?: string }) => error);
  expect(retried.code).toBe("execution.migration-conflict");
  expect(JSON.parse(readFileSync(statusPath, "utf8"))).toMatchObject({ workflows: expect.arrayContaining([expect.objectContaining({ id: "wf-acked-registered-root" })]) });
});

test("an execution acknowledgement naming a trusted, unknown or v1 registration refuses before any row", async () => {
  const trusted = legacyWorkspace("acked-trusted");
  // `wf-acked-trusted` is a real in-root directory: this run would import it, so
  // skipping it would silently drop a trusted source.
  await expect(upgradeStoreMinimal({
    context: trusted.context, operator: "operator", operationId: "op-acked-trusted",
    acknowledgedWorkflowSkips: ["wf-acked-trusted"],
  })).rejects.toMatchObject({
    code: "execution.workflow-skip-unmatched",
    message: expect.stringContaining("matched no workflow source this run refuses"),
  });
  const trustedStore = await openStore(trusted.context, "read");
  try { expect(trustedStore.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 0 }); }
  finally { trustedStore.close(); }

  const unknown = legacyWorkspace("acked-unknown");
  await expect(upgradeStoreMinimal({
    context: unknown.context, operator: "operator", operationId: "op-acked-unknown",
    acknowledgedWorkflowSkips: ["wf-never-registered"],
  })).rejects.toMatchObject({ code: "execution.workflow-skip-unmatched" });

  // A v1 root converts in memory and never reads `workflows/` (this fixture has
  // no workflows tree at all), so its registrations are not skippable linked
  // sources: the acknowledgement is refused rather than accepted and ignored.
  const v1 = legacyV1Workspace("v1-acked-registration");
  await expect(upgradeStoreMinimal({
    context: v1.context, operator: "operator", operationId: "op-v1-acked-registration",
    acknowledgedWorkflowSkips: ["wf-v1-acked-registration"],
    deliveryDeclarations: V1_STANDALONE_DECLARATION,
  })).rejects.toMatchObject({ code: "execution.workflow-skip-unmatched" });
  const v1Store = await openStore(v1.context, "read");
  try { expect(v1Store.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 0 }); }
  finally { v1Store.close(); }
});

/* ------------------------------------------------------------------------ *
 * Native/legacy ID collision
 * ------------------------------------------------------------------------ */

/**
 * One store with a REAL native workflow+plan created through the public
 * producers (not hand-written SQL), plus the control root's retained legacy v2
 * source for the SAME id — the shape the silent-omission defect came from. The
 * native branch differs from the legacy one, so the collision's preserved native
 * row is distinguishable from what the legacy source would have imported.
 */
async function nativeCollisionWorkspace(name: string): Promise<{ context: StoreContext; workflowId: string; legacyBytes: Buffer }> {
  const { context } = legacyWorkspace(name);
  const workflowId = `wf-${name}`;
  const initialized = await initializeStore(context);
  initialized.close();
  const root = await readExecutionState(context);
  await createExecutionWorkflow(executionContextFor(context, createLocalExecutionIdentity({ workflowId, role: "coordinator" })), {
    entry: { id: workflowId, type: "plan", started_at: "2026-10-04", dir: `workflows/${workflowId}` },
    snapshot: {
      schema_version: 1,
      id: workflowId,
      type: "plan",
      status: "running",
      started_at: "2026-10-04",
      updated_at: "2026-10-04",
      delivery_kind: "development",
      branch: { source: `feature/native-${workflowId}`, target: "main" },
      plans: [{ id: `${workflowId}-plan`, title: "Native collision plan", file: `${workflowId}-plan.md`, status: "Todo" }],
    } satisfies WorkflowSnapshot,
    expected: root.token,
    operationId: `create-${name}`,
  });
  // The legacy source the fixture's `legacyWorkspace` wrote stays exactly as it
  // is on disk; this read is the byte witness the collision must not touch.
  const legacyBytes = readFileSync(join(context.harnessDir, "workflows", workflowId, WORKFLOW_SNAPSHOT_FILE));
  return { context, workflowId, legacyBytes };
}

test("a recognized legacy source whose id already exists natively refuses, then an explicit acknowledgement keeps the native authority and skips only its IMPORT", async () => {
  const { context, workflowId, legacyBytes } = await nativeCollisionWorkspace("native-id-collision");
  // An unrelated healthy legacy row in the SAME run, so a partial import is
  // observable: the refusal must commit NOTHING, including that healthy row.
  const healthyId = "wf-native-id-collision-healthy";
  const healthyDir = join(context.harnessDir, "workflows", healthyId);
  mkdirSync(healthyDir, { recursive: true });
  writeFileSync(join(healthyDir, WORKFLOW_SNAPSHOT_FILE), JSON.stringify({
    schema_version: 1, id: healthyId, type: "plan", status: "running", started_at: "2026-10-04", updated_at: "2026-10-04",
    delivery_kind: "development", branch: { source: `feature/${healthyId}`, target: "main" }, plans: [],
  }));
  const statusPath = join(context.harnessDir, "status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8")) as { workflows: Array<Record<string, unknown>> };
  status.workflows.push({ id: healthyId, type: "plan", started_at: "2026-10-04", dir: `workflows/${healthyId}` });
  writeFileSync(statusPath, JSON.stringify(status));
  const before = await protectedStore(context);
  // The exact native header content, so the preserved row is observed as
  // content and not merely as a surviving id.
  const native = await openStore(context, "read");
  let nativeHeader: { state_json: string; revision: number };
  try {
    nativeHeader = native.db.prepare("select state_json, revision from execution_workflows where workflow_id = ?").get(workflowId) as { state_json: string; revision: number };
  } finally { native.close(); }
  expect(JSON.parse(nativeHeader.state_json)).toMatchObject({ branch: { source: `feature/native-${workflowId}` } });

  // Default: the collision refuses before any execution row commits, names the
  // exact original id and the runnable same-source recovery.
  const refusal = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-native-id-collision" })
    .then(() => { throw new Error("a native-id collision was silently omitted"); }, (error: Error & { code?: string }) => error);
  expect(refusal.code).toBe("execution.migration-conflict");
  expect(refusal.message).toContain(`--ack-skip-workflow ${workflowId}`);
  // Nothing committed — not even the healthy row, so no partial import is real.
  expect(await protectedStore(context)).toEqual(before);
  const refusedStore = await openStore(context, "read");
  try {
    expect(refusedStore.db.prepare("select workflow_id from execution_workflows order by workflow_id").all()).toEqual([{ workflow_id: workflowId }]);
  } finally { refusedStore.close(); }
  // The legacy source bytes are untouched by the refusal.
  expect([...readFileSync(join(context.harnessDir, "workflows", workflowId, WORKFLOW_SNAPSHOT_FILE))]).toEqual([...legacyBytes]);

  // The explicit acknowledgement keeps the native row and imports ONLY the
  // healthy row, reporting the colliding import loss with native progress
  // intact.
  const recovered = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-native-id-collision-ack",
    acknowledgedWorkflowSkips: [workflowId],
  });
  expect(recovered).toMatchObject({ verdict: "upgraded", imported: 1, authorityState: "active" });
  expect(recovered.skipped).toContainEqual({
    path: `workflows/${workflowId}`,
    reason: `legacy source for workflow ${workflowId} skipped by --ack-skip-workflow; the native execution authority already holds that id, so its native rows were kept and its legacy IMPORT was skipped`,
  });
  expect(recovered.dispositions).toContainEqual(
    expect.stringContaining(`workflow ${workflowId}: skipped by --ack-skip-workflow; the native execution authority already holds that id`),
  );
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select workflow_id from execution_workflows order by workflow_id").all())
      .toEqual([{ workflow_id: workflowId }, { workflow_id: healthyId }]);
    // The native header is byte-identical to the pre-run state: the legacy
    // source was NOT imported over it.
    expect(store.db.prepare("select state_json, revision from execution_workflows where workflow_id = ?").get(workflowId))
      .toEqual(nativeHeader);
    // The colliding legacy plan was never imported: the only plan row is the one
    // the native creation wrote, and the healthy workflow carries none.
    expect(store.db.prepare("select workflow_id, plan_id from execution_plans").all())
      .toEqual([{ workflow_id: workflowId, plan_id: `${workflowId}-plan` }]);
  } finally { store.close(); }
  // The legacy bytes remain retryable and untouched.
  expect([...readFileSync(join(context.harnessDir, "workflows", workflowId, WORKFLOW_SNAPSHOT_FILE))]).toEqual([...legacyBytes]);
});

test("a later new-operation import of the same legacy source requires explicit acknowledgement rather than heuristic replay, and native progress is not byte-frozen", async () => {
  const { context, workflowId } = await nativeCollisionWorkspace("native-id-later-op");
  const snapshotPath = join(context.harnessDir, "workflows", workflowId, WORKFLOW_SNAPSHOT_FILE);
  const legacyBytes = Buffer.from(readFileSync(snapshotPath));
  const readHeader = async (): Promise<{ state_json: string; revision: number }> => {
    const handle = await openStore(context, "read");
    try {
      return handle.db.prepare("select state_json, revision from execution_workflows where workflow_id = ?").get(workflowId) as { state_json: string; revision: number };
    } finally { handle.close(); }
  };
  const nativeHeader = await readHeader();

  // A genuine first import under one operation: the colliding source's own
  // retained receipt is the ONLY thing that may replay it.
  const first = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-native-later-first", acknowledgedWorkflowSkips: [workflowId],
  });
  expect(first.imported).toBe(0);
  // Exact same-operation replay: the retained request/result receipt answers and
  // the whole protected state (including that receipt) is unchanged.
  const afterFirst = await protectedStore(context);
  expect(await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-native-later-first", acknowledgedWorkflowSkips: [workflowId],
  })).toEqual(first);
  expect(await protectedStore(context)).toEqual(afterFirst);
  expect(await readHeader()).toEqual(nativeHeader);

  // The native source body is later EDITED: native progress, not the retained
  // legacy body, is authoritative, so the native row is unchanged — and because
  // the imported input is part of the request identity, a same-operation replay
  // over the edited bytes is a conflict rather than a stale receipt.
  const edited = JSON.parse(legacyBytes.toString("utf8")) as Record<string, unknown>;
  edited.updated_at = "2026-10-09";
  (edited.branch as Record<string, unknown>).source = `feature/edited-${workflowId}`;
  writeFileSync(snapshotPath, JSON.stringify(edited));
  // The EDITED bytes are what the next run reads as a source; the receipt and the
  // native row stay the same because neither depends on that body.
  expect(await protectedStore(context)).toEqual(afterFirst);

  // A LATER operation id whose request omits the acknowledgement is NOT a
  // replay — no id/type/date/header heuristic may fabricate one — so it
  // refuses the collision again.
  const laterRefusal = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-native-later-second" })
    .then(() => { throw new Error("a heuristic replay served a later operation"); }, (error: Error & { code?: string }) => error);
  expect(laterRefusal.code).toBe("execution.migration-conflict");
  expect(laterRefusal.message).toContain(`--ack-skip-workflow ${workflowId}`);
  // The acknowledgement on the later operation skips the import for real: the
  // native row (whose progress the operator owns) is untouched and the edited
  // legacy body is NOT read as an authority or used as a byte gate.
  const later = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-native-later-second-ack", acknowledgedWorkflowSkips: [workflowId],
  });
  expect(later.imported).toBe(0);
  expect(await readHeader()).toEqual(nativeHeader);
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select workflow_id, plan_id from execution_plans").all())
      .toEqual([{ workflow_id: workflowId, plan_id: `${workflowId}-plan` }]);
    // The two acknowledged operations each committed their OWN receipt.
    expect(store.db.prepare("select count(*) as n from store_operations where operation_id in (?, ?)").get("op-native-later-second-ack", "op-native-later-first")).toEqual({ n: 2 });
  } finally { store.close(); }
  // The edited legacy bytes stay exactly as the operator left them.
  expect(readFileSync(snapshotPath).toString("utf8")).toBe(JSON.stringify(edited));
});

test("a v1 root whose converted lifecycle id already exists natively refuses, then recovers through the same acknowledgement", async () => {
  const { context } = legacyV1Workspace("v1-native-collision");
  // One of the two converted v1 lifecycles is already a native row, so the v1
  // route shares the same collision contract as the v2 route. `iter-v1` stays
  // un-imported so the collision is the ONLY cause of the refusal.
  const initialized = await initializeStore(context);
  initialized.close();
  const root = await readExecutionState(context);
  await createExecutionWorkflow(executionContextFor(context, createLocalExecutionIdentity({ workflowId: "v1-standalone", role: "coordinator" })), {
    entry: { id: "v1-standalone", type: "plan", started_at: "2026-10-04", dir: "workflows/v1-standalone" },
    snapshot: {
      schema_version: 1, id: "v1-standalone", type: "plan", status: "paused", started_at: "2026-10-04", updated_at: "2026-10-04",
      delivery_kind: "development", branch: { source: "feature/native-v1-standalone", target: "main" },
      plans: [{ id: "v1-standalone", title: "Native v1 plan", file: "v1-standalone.md", status: "Todo" }],
    } satisfies WorkflowSnapshot,
    expected: root.token,
    operationId: "create-v1-native-collision",
  });
  // The exact native header bytes the acknowledgement must leave untouched.
  const native = await openStore(context, "read");
  let nativeHeader: { state_json: string };
  try {
    nativeHeader = native.db.prepare("select state_json from execution_workflows where workflow_id = ?").get("v1-standalone") as { state_json: string };
  } finally { native.close(); }
  expect(JSON.parse(nativeHeader.state_json)).toMatchObject({ branch: { source: "feature/native-v1-standalone" } });

  const refusal = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-v1-native-collision",
    deliveryDeclarations: V1_STANDALONE_DECLARATION,
  }).then(() => { throw new Error("a v1 native-id collision was silently omitted"); }, (error: Error & { code?: string }) => error);
  expect(refusal.code).toBe("execution.migration-conflict");
  expect(refusal.message).toContain("--ack-skip-workflow v1-standalone");
  // The unrelated v1 lifecycle did not import either: no partial registration.
  const refusedStore = await openStore(context, "read");
  try { expect(refusedStore.db.prepare("select workflow_id from execution_workflows").all()).toEqual([{ workflow_id: "v1-standalone" }]); }
  finally { refusedStore.close(); }

  const recovered = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-v1-native-collision-ack",
    deliveryDeclarations: V1_STANDALONE_DECLARATION,
    acknowledgedWorkflowSkips: ["v1-standalone"],
  });
  expect(recovered).toMatchObject({ verdict: "upgraded", imported: 1 });
  expect(recovered.dispositions).toContainEqual(
    expect.stringContaining("workflow v1-standalone: skipped by --ack-skip-workflow; the native execution authority already holds that id"),
  );
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select workflow_id from execution_workflows order by workflow_id").all())
      .toEqual([{ workflow_id: "iter-v1" }, { workflow_id: "v1-standalone" }]);
    // The native row keeps ITS OWN branch/kind; the acknowledged v1 conversion
    // (declared development anchors) did not import over it.
    expect(store.db.prepare("select state_json from execution_workflows where workflow_id = ?").get("v1-standalone"))
      .toEqual(nativeHeader);
  } finally { store.close(); }
});

test("one unmatched acknowledgement in a mixed request refuses the whole run before any write, even when another acknowledgement is valid", async () => {
  const { context, workflowId } = await nativeCollisionWorkspace("native-id-mixed-ack");
  const before = await protectedStore(context);

  // `workflowId` genuinely collides and is acknowledged, but
  // `wf-never-anywhere` names nothing this run refuses: the whole request is
  // caller input, so it refuses as usage before any execution row commits —
  // the valid acknowledgement is not silently honoured on a rejected request.
  const mixed = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-native-mixed-ack",
    acknowledgedWorkflowSkips: [workflowId, "wf-never-anywhere"],
  }).then(() => { throw new Error("a mixed acknowledgement silently skipped a source"); }, (error: Error & { code?: string }) => error);
  expect(mixed.code).toBe("execution.workflow-skip-unmatched");
  expect(mixed.message).toContain("wf-never-anywhere");
  expect(await protectedStore(context)).toEqual(before);

  // Dropping only the unmatched id is the same-entry retry: the colliding
  // source is skipped and the native row is kept.
  const recovered = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-native-mixed-ack-retry",
    acknowledgedWorkflowSkips: [workflowId],
  });
  expect(recovered.imported).toBe(0);
  expect(recovered.dispositions).toContainEqual(
    expect.stringContaining(`workflow ${workflowId}: skipped by --ack-skip-workflow; the native execution authority already holds that id`),
  );
  // The retained receipt of that accepted retry then answers its own replay.
  expect(await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-native-mixed-ack-retry",
    acknowledgedWorkflowSkips: [workflowId],
  })).toEqual(recovered);
});

test("changed execution acknowledgements under one operation id conflict with the retained receipt", async () => {
  const { context } = legacyWorkspace("acked-request-identity");
  const harnessDir = context.harnessDir;
  const workflowsDir = join(harnessDir, "workflows");
  const statusPath = join(harnessDir, "status.json");
  const firstId = "wf-acked-request-identity";
  const secondId = "wf-acked-request-identity-second";
  const operationId = "op-acked-request-identity";
  const snapshotOf = (id: string) => JSON.stringify({
    schema_version: 1, id, type: "plan", status: "running", started_at: "2026-10-04", updated_at: "2026-10-04",
    delivery_kind: "development", branch: { source: `feature/${id}`, target: "main" }, plans: [],
  });
  // The whole `workflows/` root is ONE symlinked source, so the DSH domain
  // refuses exactly one selector in BOTH rounds: `acknowledgedSkips` is held
  // constant and only the execution acknowledgement set changes across rounds,
  // making the changed request identity the sole cause of the conflict.
  const target = join(harnessDir, "outside-identity-tree");
  mkdirSync(join(target, firstId), { recursive: true });
  writeFileSync(join(target, firstId, WORKFLOW_SNAPSHOT_FILE), snapshotOf(firstId));
  rmSync(workflowsDir, { recursive: true, force: true });
  symlinkSync(target, workflowsDir);
  const status = JSON.parse(readFileSync(statusPath, "utf8")) as { workflows: Array<Record<string, unknown>> };
  status.workflows[0]!.dir = `workflows/${firstId}`;
  writeFileSync(statusPath, JSON.stringify(status));
  const common = { context, operator: "operator", operationId, acknowledgedSkips: ["dsh-workflows"] };

  // Round 1: only `firstId` is a linked (unsafe) registration, and it is exactly
  // the acknowledgement its discovery admits.
  const first = await upgradeStoreMinimal({ ...common, acknowledgedWorkflowSkips: [firstId] });
  expect(first).toMatchObject({ verdict: "upgraded", imported: 0 });
  // Full protected state AFTER the first success: schema, every table row and
  // the retained operation receipt, not just row counts.
  const afterFirst = await protectedStore(context);
  // A repeated id is one request, so this repeats and replays exactly and the
  // whole protected state (including the retained receipt) stays identical.
  expect(await upgradeStoreMinimal({ ...common, acknowledgedWorkflowSkips: [firstId, firstId] })).toEqual(first);
  expect(await protectedStore(context)).toEqual(afterFirst);

  // Round 2: a SECOND registration under the linked root makes the valid
  // acknowledgement set genuinely change while `--ack-skip-dsh` stays identical,
  // so both requests stay discovery-valid and only the changed request identity
  // can answer — it must not replay round 1.
  mkdirSync(join(target, secondId), { recursive: true });
  writeFileSync(join(target, secondId, WORKFLOW_SNAPSHOT_FILE), snapshotOf(secondId));
  status.workflows.push({ id: secondId, type: "plan", started_at: "2026-10-04", dir: `workflows/${secondId}` });
  writeFileSync(statusPath, JSON.stringify(status));

  await expect(upgradeStoreMinimal({ ...common, acknowledgedWorkflowSkips: [firstId, secondId] }))
    .rejects.toMatchObject({ code: "execution.operation-conflict" });

  // The retained receipt and native execution state are unchanged by the
  // conflicting call: the whole protected snapshot (schema + every table row,
  // including `store_operations`) equals the post-success snapshot, and the
  // retained receipt's own content still names the round-1 result.
  expect(await protectedStore(context)).toEqual(afterFirst);
  const store = await openStore(context, "read");
  try {
    const receipt = store.db.prepare("select result_json from store_operations where operation_id = ?").get(operationId) as { result_json: string };
    expect(JSON.parse(receipt.result_json)).toMatchObject({
      verdict: "upgraded", imported: 0, skipped: first.skipped, dispositions: first.dispositions, sourceDigest: first.sourceDigest,
    });
    expect(store.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 0 });
  } finally { store.close(); }
  // The linked root and its target bytes were never rewritten.
  expect(lstatSync(workflowsDir).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(target, firstId, WORKFLOW_SNAPSHOT_FILE), "utf8")).toBe(snapshotOf(firstId));
});

for (const shape of ["symlink", "file"] as const) {
  test(`an unmatched acknowledgement outranks a registered ${shape} root refusal without probing its children`, async () => {
    const { context } = legacyWorkspace(`wrong-ack-${shape}-root`);
    const workflowsDir = join(context.harnessDir, "workflows");
    const target = join(ROOT, `wrong-ack-${shape}-target`);
    mkdirSync(target);
    rmSync(workflowsDir, { recursive: true, force: true });
    if (shape === "symlink") symlinkSync(target, workflowsDir);
    else writeFileSync(workflowsDir, "retained source");
    const initialized = await initializeStore(context);
    initialized.close();
    const before = await protectedStore(context);
    const { accessed } = await withPathAccessLog(async () => {
      await expect(upgradeStoreMinimal({
        context, operator: "operator", operationId: `op-wrong-ack-${shape}`,
        acknowledgedWorkflowSkips: ["wf-not-a-source"],
      })).rejects.toMatchObject({ code: "execution.workflow-skip-unmatched" });
    });
    expect(accessed.filter((path) => path.startsWith(`${workflowsDir}/`) || path === target || path.startsWith(`${target}/`))).toEqual([]);
    expect(await protectedStore(context)).toEqual(before);
    if (shape === "symlink") expect(lstatSync(workflowsDir).isSymbolicLink()).toBe(true);
    else expect(readFileSync(workflowsDir, "utf8")).toBe("retained source");
  });
}

test("whole-root recovery classifies registered ids lexically: partial acknowledgement refuses, complete skips both, trusted sibling imports", async () => {
  const { context } = legacyWorkspace("acked-two-id-root");
  const workflowsDir = join(context.harnessDir, "workflows");
  const statusPath = join(context.harnessDir, "status.json");
  const firstId = "wf-acked-two-id-root";
  const secondId = "wf-acked-two-id-second";
  const trustedId = "wf-acked-two-id-trusted";
  const snapshotOf = (id: string) => JSON.stringify({
    schema_version: 1, id, type: "plan", status: "running", started_at: "2026-10-04", updated_at: "2026-10-04",
    delivery_kind: "development", branch: { source: `feature/${id}`, target: "main" }, plans: [],
  });
  // The trusted sibling is registered OUTSIDE `workflows/`: lexical under-root
  // classification must not treat it as a linked source, so it imports with no
  // execution acknowledgement at all.
  const trustedDir = join(context.harnessDir, "relocated", trustedId);
  mkdirSync(trustedDir, { recursive: true });
  writeFileSync(join(trustedDir, WORKFLOW_SNAPSHOT_FILE), snapshotOf(trustedId));
  const status = JSON.parse(readFileSync(statusPath, "utf8")) as { workflows: Array<Record<string, unknown>> };
  status.workflows.push({ id: trustedId, type: "plan", started_at: "2026-10-04", dir: `relocated/${trustedId}` });

  // `workflows/` becomes ONE symlink to an out-of-root tree. `firstId` has a
  // readable target that must be preserved; `secondId`'s target is deliberately
  // ABSENT, so a successful skip of it is an observable no-read boundary: any
  // lstat/exists/read of its linked source would surface the missing target.
  const target = join(context.harnessDir, "outside-two-id-tree");
  const firstSnapshot = snapshotOf(firstId);
  mkdirSync(join(target, firstId), { recursive: true });
  writeFileSync(join(target, firstId, WORKFLOW_SNAPSHOT_FILE), firstSnapshot);
  rmSync(workflowsDir, { recursive: true, force: true });
  symlinkSync(target, workflowsDir);
  status.workflows.push({ id: secondId, type: "plan", started_at: "2026-10-04", dir: `workflows/${secondId}` });
  writeFileSync(statusPath, JSON.stringify(status));

  // Partial acknowledgement of the TWO linked ids: the unacknowledged one keeps
  // the whole execution transaction refused, with nothing committed and no
  // linked target visited.
  await expect(upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-two-id-partial",
    acknowledgedWorkflowSkips: [firstId],
  })).rejects.toMatchObject({
    code: "execution.migration-conflict",
    message: expect.stringContaining(`--ack-skip-workflow ${secondId}`),
  });
  const afterPartial = await openStore(context, "read");
  try {
    expect(afterPartial.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 0 });
    expect(afterPartial.db.prepare("select count(*) as n from dsh_accepted_identities").get()).toEqual({ n: 0 });
  } finally { afterPartial.close(); }

  // Complete acknowledgement of BOTH linked ids: each is skipped with a named
  // receipt, and the trusted sibling outside the linked root still imports.
  // The platform fs calls are recorded so the forbidden linked targets can be
  // asserted un-probed rather than inferred from absent bytes.
  // Both the LINKED ALIAS a caller would use and the resolved TARGET child are
  // forbidden: a probe reached through the linked root is recorded under the
  // alias, so matching targets alone would miss it. The root itself is not
  // forbidden — its own lstat is the preflight's legitimate check.
  const forbidden = [firstId, secondId].flatMap((id) => [join(workflowsDir, id), join(target, id)]);
  const { result, accessed } = await withPathAccessLog(() => upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-two-id-complete",
    // The whole `workflows/` root is a symlink, so the DSH domain refuses it as
    // its own source; that acknowledgement is separate from the two execution skips.
    acknowledgedSkips: ["dsh-workflows"],
    acknowledgedWorkflowSkips: [firstId, secondId],
  }));
  expect(result).toMatchObject({ verdict: "upgraded", imported: 1, authorityState: "active" });
  expect(result.skipped.map(({ path }) => path)).toEqual([`workflows/${firstId}`, `workflows/${secondId}`]);
  expect(result.dispositions).toEqual(expect.arrayContaining([
    expect.stringContaining(`workflow ${firstId}: skipped by --ack-skip-workflow`),
    expect.stringContaining(`workflow ${secondId}: skipped by --ack-skip-workflow`),
  ]));
  const store = await openStore(context, "read");
  try {
    // Only the trusted relocation imports; neither linked id is fabricated.
    expect(store.db.prepare("select workflow_id from execution_workflows").all()).toEqual([{ workflow_id: trustedId }]);
  } finally { store.close(); }
  // No linked alias OR resolved target child was ever probed: the recorded
  // lstat/stat/exists/realpath/read/readdir arguments named neither. This is the
  // real no-read/no-traversal boundary — a probe through the linked root is
  // recorded under the alias, and the absent second target alone could not prove
  // it because a failed probe is swallowed.
  const touchedForbidden = accessed.filter((path) => forbidden.some((f) => path === f || path.startsWith(`${f}/`) || path.startsWith(`${f}\\`)));
  expect(touchedForbidden).toEqual([]);
  expect(lstatSync(workflowsDir).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(target, firstId, WORKFLOW_SNAPSHOT_FILE), "utf8")).toBe(firstSnapshot);
  expect(existsSync(join(target, secondId))).toBe(false);
});

test("an ordinary registered workflow reached through an out-of-root ancestor symlink is refused by physical containment", async () => {
  const { context } = legacyWorkspace("containment-ancestor");
  const harnessDir = context.harnessDir;
  const workflowId = "wf-containment-ancestor";
  const statusPath = join(harnessDir, "status.json");
  // The registration names an IN-ROOT path (`relocated/<id>`), but `relocated`
  // is a symlink to a directory OUTSIDE the control root: the leaf itself is a
  // real directory with a real snapshot, so only PHYSICAL containment can catch
  // it. This is the ordinary trusted-import path, not the acknowledged one.
  const outsideTree = join(ROOT, "containment-ancestor", "outside-tree");
  mkdirSync(join(outsideTree, workflowId), { recursive: true });
  writeFileSync(join(outsideTree, workflowId, WORKFLOW_SNAPSHOT_FILE), JSON.stringify({
    schema_version: 1, id: workflowId, type: "plan", status: "running", started_at: "2026-10-04", updated_at: "2026-10-04",
    delivery_kind: "development", branch: { source: `feature/${workflowId}`, target: "main" }, plans: [],
  }));
  rmSync(join(harnessDir, "workflows"), { recursive: true, force: true });
  symlinkSync(outsideTree, join(harnessDir, "relocated"));
  const status = JSON.parse(readFileSync(statusPath, "utf8")) as { workflows: Array<Record<string, unknown>> };
  status.workflows[0]!.dir = `relocated/${workflowId}`;
  writeFileSync(statusPath, JSON.stringify(status));

  await expect(upgradeStoreMinimal({ context, operator: "operator", operationId: "op-containment-ancestor" }))
    .rejects.toMatchObject({
      code: "execution.migration-conflict",
      message: expect.stringContaining("resolves outside control root"),
    });
  const store = await openStore(context, "read");
  try { expect(store.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 0 }); }
  finally { store.close(); }
  // The escaping tree is untouched: nothing was imported through the ancestor link.
  expect(lstatSync(join(harnessDir, "relocated")).isSymbolicLink()).toBe(true);
  expect(existsSync(join(outsideTree, workflowId, WORKFLOW_SNAPSHOT_FILE))).toBe(true);
});

test("a recognizable v1 root imports through the ordinary store upgrade and preserves every source byte", async () => {
  const { context, statusBytes } = legacyV1Workspace("v1-direct");
  const compassBytes = readFileSync(join(context.harnessDir, "iterations", "iter-v1", "delivery-compass.md"));
  const docBytes = readFileSync(join(context.harnessDir, "plain-doc.md"));

  const result = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-v1-direct",
    deliveryDeclarations: V1_STANDALONE_DECLARATION,
  });
  expect(result).toMatchObject({ verdict: "upgraded", imported: 2, authorityState: "active" });
  expect(result.sourceDigest).toMatch(/^[a-f0-9]{64}$/);

  const store = await openStore(context, "read");
  try {
    // Both lifecycles land in the native tables, with the v1 metadata lift.
    const header = store.db.prepare("select state_json from execution_workflows where workflow_id = ?").get("iter-v1") as { state_json: string };
    const iteration = JSON.parse(header.state_json) as Record<string, unknown>;
    expect(iteration).toMatchObject({
      type: "iteration",
      status: "running",
      branch: { base: "integration/v1", target: "main" },
      legacy_metadata: { program_roadmap: { title: "Retained program roadmap", milestones: [{ id: "m1", title: "Keep this fact" }] } },
    });
    expect(iteration.integration_merge_lease).toBeUndefined();
    expect(result.dispositions).toContain(
      "workflow iter-v1: historical v1 integration merge lease for legacy-coordinator was not imported as a live lease; operator \"operator\" requested store upgrade, which retires the historical claim, and future integration ownership uses the ordinary serial lease operation",
    );
    // The standalone Todo row imports paused, declared, and continuable: the
    // declared kind and its anchors are registered, so a later close can
    // consult them instead of dead-ending on an unregistered kind.
    const standalone = store.db.prepare("select state_json from execution_workflows where workflow_id = ?").get("v1-standalone") as { state_json: string };
    expect(JSON.parse(standalone.state_json)).toMatchObject({
      type: "plan",
      status: "paused",
      delivery_kind: "development",
      branch: { source: "feature/v1-standalone", target: "main" },
    });
    const standaloneRow = store.db.prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?").get("v1-standalone", "v1-standalone") as { state_json: string };
    expect(JSON.parse(standaloneRow.state_json)).toMatchObject({ id: "v1-standalone", status: "Todo" });
    const row = store.db.prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?").get("iter-v1", "wf-v1-direct") as { state_json: string };
    expect(JSON.parse(row.state_json)).toMatchObject({ id: "wf-v1-direct", status: "Done" });
    // Registry membership is ACTIVE-lifecycle membership: the running
    // iteration and the paused (non-terminal) standalone plan are both listed;
    // a terminal lift would import unregistered.
    expect(store.db.prepare("select count(*) as n from execution_registry").get()).toEqual({ n: 2 });
  } finally {
    store.close();
  }

  // No JSON authority was recreated: the legacy root, the compass and an
  // unrelated document are byte-identical, and no snapshot tree appeared.
  expect([...readFileSync(join(context.harnessDir, "status.json"))]).toEqual([...statusBytes]);
  expect([...readFileSync(join(context.harnessDir, "iterations", "iter-v1", "delivery-compass.md"))]).toEqual([...compassBytes]);
  expect([...readFileSync(join(context.harnessDir, "plain-doc.md"))]).toEqual([...docBytes]);
  expect(existsSync(join(context.harnessDir, "workflows"))).toBe(false);
  expect(existsSync(join(context.harnessDir, "archived"))).toBe(false);

  // A LATER operation id is not a replay, and the v1 source this run converts
  // now collides with the native rows the first upgrade committed: it refuses
  // and names the same-entry acknowledgement.
  const refusedRetry = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-v1-direct-2",
    deliveryDeclarations: V1_STANDALONE_DECLARATION,
  }).then(() => { throw new Error("a repeated v1 import under a new operation id did not refuse"); }, (error: Error & { code?: string }) => error);
  expect(refusedRetry.code).toBe("execution.migration-conflict");
  expect(refusedRetry.message).toContain("--ack-skip-workflow iter-v1 v1-standalone");
  // The acknowledged retry keeps the native authority and skips only the legacy
  // IMPORTs; the source bytes stay untouched.
  const recovered = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-v1-direct-3",
    deliveryDeclarations: V1_STANDALONE_DECLARATION,
    acknowledgedWorkflowSkips: ["iter-v1", "v1-standalone"],
  });
  expect(recovered.imported).toBe(0);
  expect(recovered.dispositions).toEqual(expect.arrayContaining([
    expect.stringContaining("workflow iter-v1: skipped by --ack-skip-workflow"),
    expect.stringContaining("workflow v1-standalone: skipped by --ack-skip-workflow"),
  ]));
  const afterRecovery = await openStore(context, "read");
  try {
    expect(afterRecovery.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 2 });
    expect(afterRecovery.db.prepare("select count(*) as n from execution_plans").get()).toEqual({ n: 2 });
  } finally {
    afterRecovery.close();
  }
  expect([...readFileSync(join(context.harnessDir, "status.json"))]).toEqual([...statusBytes]);
});

test("an active standalone v1 plan without a declared delivery kind refuses before any row registers, then a declared retry continues it", async () => {
  const { context, statusBytes } = legacyV1Workspace("v1-undeclared-refusal");
  const statusPath = join(context.harnessDir, "status.json");

  // No declaration: the ACTIVE standalone lift would register a plan workflow
  // with no kind, which could never close. Nothing commits, and the refusal
  // names the ids and the exact same-entry retry.
  const refusal = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-v1-undeclared" })
    .then(() => { throw new Error("an undeclared active v1 lift unexpectedly imported"); }, (error: Error & { code?: string }) => error);
  expect(refusal.code).toBe("execution.delivery-declaration-required");
  expect(refusal.message).toContain("v1-standalone");
  expect(refusal.message).toContain("--delivery");
  expect(refusal.message).toContain("legacy source bytes are unchanged");
  const refusedStore = await openStore(context, "read");
  try {
    expect(refusedStore.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 0 });
    expect(refusedStore.db.prepare("select count(*) as n from execution_plans").get()).toEqual({ n: 0 });
  } finally { refusedStore.close(); }
  expect([...readFileSync(statusPath)]).toEqual([...statusBytes]);

  // The declared retry is the SAME public operation on the SAME source: it
  // preserves ids, the verbatim row status and the source bytes, and the
  // workflow's delivery consultation now names no unregistered kind, so the
  // ordinary lifecycle continues/closes it instead of dead-ending.
  const retried = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-v1-undeclared-retry",
    deliveryDeclarations: V1_STANDALONE_DECLARATION,
  });
  expect(retried.imported).toBe(2);
  expect([...readFileSync(statusPath)]).toEqual([...statusBytes]);
  const retriedStore = await openStore(context, "read");
  try {
    const header = JSON.parse((retriedStore.db.prepare("select state_json from execution_workflows where workflow_id = ?").get("v1-standalone") as { state_json: string }).state_json) as Record<string, unknown>;
    const row = JSON.parse((retriedStore.db.prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?").get("v1-standalone", "v1-standalone") as { state_json: string }).state_json) as Record<string, unknown>;
    expect(header).toMatchObject({ delivery_kind: "development", branch: { source: "feature/v1-standalone", target: "main" } });
    expect(row).toMatchObject({ id: "v1-standalone", status: "Todo" });
    expect(consultDeliveryEvidence({ ...header, plans: [{ id: "p" }] } as never).map((entry) => entry.code))
      .not.toContain("PHASE6_DELIVERY_KIND_UNREGISTERED");
  } finally { retriedStore.close(); }
});

test("each active standalone v1 lift declares its own delivery kind and anchors", async () => {
  const { context } = legacyV1Workspace("v1-multi-intent");
  const statusPath = join(context.harnessDir, "status.json");
  const doc = JSON.parse(readFileSync(statusPath, "utf8")) as { plans: Array<Record<string, unknown>> };
  // One row per ACTIVE v1 status, as an operator would supply a tree that
  // stopped mid-flight with several plans in different states.
  doc.plans.push(
    { id: "v1-inprogress", title: "In progress", file: "v1-inprogress.md", status: "InProgress" },
    { id: "v1-blocked", title: "Blocked", file: "v1-blocked.md", status: "Blocked" },
    { id: "v1-inreview", title: "In review", file: "v1-inreview.md", status: "InReview" },
  );
  writeFileSync(statusPath, `${JSON.stringify(doc, null, 2)}\n`);

  // Two different kinds/anchors in one upgrade — not a batch-of-one limit.
  const result = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-v1-multi-intent",
    deliveryDeclarations: [
      ...V1_STANDALONE_DECLARATION,
      { workflow: "v1-inprogress", deliveryKind: "development", branchSource: "feature/v1-inprogress", branchTarget: "main" },
      { workflow: "v1-blocked", deliveryKind: "verification/report-only", completionPolicy: "report at reports/v1-blocked.md" },
      { workflow: "v1-inreview", deliveryKind: "verification/report-only", completionPolicy: "acceptance at qa/v1-inreview.md" },
    ],
  });
  expect(result.imported).toBe(5);

  const store = await openStore(context, "read");
  try {
    const header = (id: string): Record<string, unknown> => {
      const row = store.db.prepare("select state_json from execution_workflows where workflow_id = ?").get(id) as { state_json: string };
      return JSON.parse(row.state_json) as Record<string, unknown>;
    };
    expect(header("v1-inprogress")).toMatchObject({
      status: "running", delivery_kind: "development", branch: { source: "feature/v1-inprogress", target: "main" },
    });
    expect(header("v1-blocked")).toMatchObject({
      status: "paused", delivery_kind: "verification/report-only", completion_policy: "report at reports/v1-blocked.md",
    });
    expect(header("v1-inreview")).toMatchObject({
      status: "running", delivery_kind: "verification/report-only", completion_policy: "acceptance at qa/v1-inreview.md",
    });
    // Every declared lift consults a registered kind; none dead-ends on
    // PHASE6_DELIVERY_KIND_UNREGISTERED. The completed v1 row (grouped into the
    // fixture's iteration) stays undeclared, exactly as before this contract.
    for (const id of ["v1-standalone", "v1-inprogress", "v1-blocked", "v1-inreview"]) {
      expect(consultDeliveryEvidence({ ...header(id), plans: [{ id: "p" }] } as never).map((entry) => entry.code))
        .not.toContain("PHASE6_DELIVERY_KIND_UNREGISTERED");
    }
    const completedRow = store.db.prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?").get("iter-v1", "wf-v1-multi-intent") as { state_json: string };
    expect(JSON.parse(completedRow.state_json)).toMatchObject({ id: "wf-v1-multi-intent", status: "Done" });
  } finally { store.close(); }
});

test("a delivery declaration that addresses no active standalone lift, or repeats one, is refused instead of ignored", async () => {
  const { context } = legacyV1Workspace("v1-unmatched-declaration");
  const unmatched = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-v1-unmatched",
    deliveryDeclarations: [{ workflow: "not-a-lift", deliveryKind: "development", branchSource: "a", branchTarget: "b" }],
  }).then(() => { throw new Error("an unmatched declaration unexpectedly imported"); }, (error: Error & { code?: string }) => error);
  expect(unmatched.code).toBe("execution.delivery-declaration-required");
  expect(unmatched.message).toContain("not-a-lift");
  expect(unmatched.message).toContain("v1-standalone");
  // The completed v1 row is not a lift that needs a declaration either.
  const completedIsNotALift = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-v1-completed-declared",
    deliveryDeclarations: [
      ...V1_STANDALONE_DECLARATION,
      { workflow: "wf-v1-unmatched-declaration", deliveryKind: "development", branchSource: "a", branchTarget: "b" },
    ],
  }).then(() => { throw new Error("a declaration on a completed row unexpectedly imported"); }, (error: Error & { code?: string }) => error);
  expect(completedIsNotALift.message).toContain("wf-v1-unmatched-declaration");
  const duplicated = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-v1-duplicated",
    deliveryDeclarations: [...V1_STANDALONE_DECLARATION, ...V1_STANDALONE_DECLARATION],
  }).then(() => { throw new Error("a duplicated declaration unexpectedly imported"); }, (error: Error & { code?: string }) => error);
  expect(duplicated.message).toContain("twice");
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 0 });
  } finally { store.close(); }
});

test("an incoherent delivery declaration is refused by the shared registration rule before any row registers", async () => {
  const { context } = legacyV1Workspace("v1-incoherent-declaration");
  const missingAnchors = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-v1-missing-anchors",
    deliveryDeclarations: [{ workflow: "v1-standalone", deliveryKind: "development" }],
  }).then(() => { throw new Error("a development declaration without anchors unexpectedly imported"); }, (error: Error & { code?: string }) => error);
  expect(missingAnchors.code).toBe("execution.delivery-declaration-required");
  expect(missingAnchors.message).toContain("requires its delivery source and target branches");
  const missingPolicy = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-v1-missing-policy",
    deliveryDeclarations: [{ workflow: "v1-standalone", deliveryKind: "verification/report-only" }],
  }).then(() => { throw new Error("a report-only declaration without a policy unexpectedly imported"); }, (error: Error & { code?: string }) => error);
  expect(missingPolicy.message).toContain("requires the completion policy");
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 0 });
  } finally { store.close(); }
});

test.each([
  ["an already-v2 root", "non-v1-declared-v2", legacyWorkspace("non-v1-declared-v2").context],
  ["an empty root", "non-v1-declared-empty", (() => { const harnessDir = join(ROOT, "non-v1-declared-empty", ".mstar"); mkdirSync(harnessDir, { recursive: true }); return { harnessDir }; })()],
])("a delivery declaration on %s is refused before any row registers, and the same source upgrades without it", async (_label, name, context) => {
  const declarations = [{ workflow: "not-a-lift", deliveryKind: "development" as const, branchSource: "a", branchTarget: "b" }];

  const refused = await upgradeStoreMinimal({
    context, operator: "operator", operationId: `op-${name}-declared`, deliveryDeclarations: declarations,
  }).then(() => { throw new Error("a declaration on a non-v1 root unexpectedly imported"); }, (error: Error & { code?: string }) => error);
  expect(refused.code).toBe("execution.delivery-declaration-required");
  expect(refused.message).toContain("not-a-lift");
  const refusedStore = await openStore(context, "read");
  try {
    expect(refusedStore.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 0 });
    expect(refusedStore.db.prepare("select count(*) as n from execution_plans").get()).toEqual({ n: 0 });
  } finally { refusedStore.close(); }

  // Dropping the declaration is the same source's supported retry: the ordinary
  // route runs and imports what that root actually holds.
  const retried = await upgradeStoreMinimal({ context, operator: "operator", operationId: `op-${name}-undeclared` });
  expect(retried.verdict).toBe("upgraded");
});

test("malformed v1 lease metadata is retired with an explicit operator disposition", async () => {
  const { context } = legacyV1Workspace("v1-malformed-historical-lease");
  const statusPath = join(context.harnessDir, "status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8")) as { metadata: Record<string, unknown> };
  status.metadata.integration_merge_lease = { holder: "legacy-coordinator" };
  const sourceBytes = Buffer.from(`${JSON.stringify(status, null, 2)}\n`);
  writeFileSync(statusPath, sourceBytes);

  const result = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-v1-malformed-lease", deliveryDeclarations: V1_STANDALONE_DECLARATION });
  expect(result.imported).toBe(2);
  expect(result.dispositions).toContain(
    "workflow iter-v1: historical v1 integration merge lease for legacy-coordinator was not imported as a live lease; operator \"operator\" requested store upgrade, which retires the historical claim, and future integration ownership uses the ordinary serial lease operation",
  );
  expect(readFileSync(statusPath)).toEqual(sourceBytes);
  const store = await openStore(context, "read");
  try {
    const header = store.db.prepare("select state_json from execution_workflows where workflow_id = ?").get("iter-v1") as { state_json: string };
    const iteration = JSON.parse(header.state_json) as Record<string, unknown>;
    expect(iteration.integration_merge_lease).toBeUndefined();
    expect(iteration.legacy_metadata).not.toHaveProperty("integration_merge_lease");
  } finally {
    store.close();
  }
});
test("no-active-iteration metadata is recoverably disclosed while malformed leases do not block import", async () => {
  const { context } = legacyV1Workspace("v1-no-active-iteration");
  const statusPath = join(context.harnessDir, "status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8")) as {
    metadata: Record<string, unknown>;
  };
  status.metadata.integration_merge_lease = { holder: "legacy-coordinator" };
  const sourceBytes = Buffer.from(`${JSON.stringify(status, null, 2)}\n`);
  writeFileSync(statusPath, sourceBytes);
  rmSync(join(context.harnessDir, "iterations", "iter-v1"), { recursive: true, force: true });

  const result = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-v1-no-active", deliveryDeclarations: V1_STANDALONE_DECLARATION });
  expect(result).toMatchObject({ verdict: "upgraded", imported: 2, authorityState: "active" });
  expect(result.dispositions).toContain(
    "root metadata program_roadmap was not imported because no active iteration exists to carry it as workflow metadata; status.json is preserved. Recover through the supported project-roadmap authoring path (`mstar roadmap import` preview/review/apply or revision-guarded `mstar roadmap replace`), using `_default` when no project is identified",
  );
  expect(result.dispositions).toContain(
    "root metadata integration_merge_lease is historical data only and is not converted to a live store lease; the direct store-upgrade import leaves status.json unchanged, and future integration ownership uses the native serial lease operation",
  );
  expect(readFileSync(statusPath)).toEqual(sourceBytes);

  const project = await registerCatalogEntity(
    context,
    { kind: "project", id: "_default", title: "Default project", rootKind: "projects", relativePath: "_default/roadmap.md" },
    { operationId: "op-register-default-roadmap", actor: "store-upgrade-minimal.test" },
  );
  expect(project.id).toBe("_default");
  const current = await readRoadmapAuthority(context, "_default");
  expect(current).toEqual({ projectId: "_default", projectRevision: 1, roadmap: null });
  const roadmap = [
    "---",
    "project_id: _default",
    "title: Recovered legacy roadmap",
    "status: active",
    "created_at: 2026-10-04",
    "---",
    "",
    "## Direction",
    "",
    "Recovered from the preserved program_roadmap source.",
    "",
    "## Goals",
    "",
    "- [ ] Keep the original roadmap goal",
    "",
  ].join("\n");
  await replaceRoadmapAuthority(
    context,
    { projectId: "_default", expectedProjectRevision: current.projectRevision, expectedRoadmapRevision: "absent", contentMarkdown: roadmap },
    { operationId: "op-recover-default-roadmap" },
  );
  expect((await readRoadmapAuthority(context, "_default")).roadmap?.contentMarkdown).toBe(roadmap);
  expect(readFileSync(statusPath)).toEqual(sourceBytes);
});

test("a v1 root whose lift is unacceptable reports the committed schema and authority state", async () => {
  const { context } = legacyV1Workspace("v1-refusal");
  const statusPath = join(context.harnessDir, "status.json");
  const doc = JSON.parse(readFileSync(statusPath, "utf8")) as { plans: Array<Record<string, unknown>> };
  doc.plans.push({ id: "../escape", title: "unsafe", file: "x.md", status: "Todo" });
  writeFileSync(statusPath, JSON.stringify(doc));
  const before = readFileSync(statusPath);
  const refusal = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-v1-refusal", deliveryDeclarations: V1_STANDALONE_DECLARATION })
    .then(() => { throw new Error("unsafe v1 plan unexpectedly imported"); }, (error: Error & { code?: string }) => error);
  expect(refusal.message).toContain("Schema version");
  expect(refusal.message).toContain("issue/catalog authority active, execution authority active");
  expect(refusal.message).toContain("The failed import transaction committed no rows, and existing execution rows remain unchanged");
  expect(refusal.message).toContain("retry `mstar store upgrade --operator <name>`");
  expect(refusal.code).toBe("execution.migration-conflict");
  expect([...readFileSync(statusPath)]).toEqual([...before]);
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select authority_state from store_meta where id = 1").get()).toEqual({ authority_state: "active" });
    expect(store.db.prepare("select authority_state from execution_meta where id = 1").get()).toEqual({ authority_state: "active" });
    expect(store.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 0 });
  } finally {
    store.close();
  }
  expect(existsSync(join(context.harnessDir, "workflows"))).toBe(false);
  expect(existsSync(join(context.harnessDir, "archived"))).toBe(false);
});

/* ------------------------------------------------------------------------ *
 * Registered non-directory source: default refusal and explicit recovery
 * ------------------------------------------------------------------------ */

/**
 * A real regular file where a registered workflow directory belongs. Both the
 * whole-`workflows/` root and a single per-workflow registration can take this
 * shape; the file's bytes are the witness the refusal and the acknowledged skip
 * must leave untouched.
 */
const NON_DIRECTORY_BYTES = "NOT-A-WORKFLOW-SOURCE-BYTES\n";

/**
 * One REAL unrelated native workflow with a meaningful plan, frozen input row
 * and committed domain receipt, created through the public producers. The
 * non-directory recovery must leave every one of these rows byte-identical.
 * Returns the exact native content a post-recovery comparison needs.
 */
async function seedUnrelatedNative(context: StoreContext, nativeId: string) {
  const root = await readExecutionState(context);
  await createExecutionWorkflow(executionContextFor(context, createLocalExecutionIdentity({ workflowId: nativeId, role: "coordinator" })), {
    entry: { id: nativeId, type: "plan", started_at: "2026-10-04", dir: `workflows/${nativeId}` },
    snapshot: {
      schema_version: 1,
      id: nativeId,
      type: "plan",
      status: "running",
      started_at: "2026-10-04",
      updated_at: "2026-10-04",
      delivery_kind: "development",
      branch: { source: `feature/native-${nativeId}`, target: "main" },
      plans: [{ id: `${nativeId}-plan`, title: "Native kept plan", file: `${nativeId}-plan.md`, status: "Todo" }],
    } satisfies WorkflowSnapshot,
    expected: root.token,
    operationId: `create-${nativeId}`,
  });
  return readUnrelatedNative(context, nativeId);
}

/** Re-read the same unrelated native rows after a run, for a content comparison. */
async function readUnrelatedNative(context: StoreContext, nativeId: string) {
  const store = await openStore(context, "read");
  try {
    return {
      workflow: store.db.prepare("select * from execution_workflows where workflow_id = ?").get(nativeId),
      registry: store.db.prepare("select * from execution_registry where workflow_id = ?").get(nativeId),
      plans: store.db.prepare("select * from execution_plans where workflow_id = ? order by ordinal, plan_id").all(nativeId),
      inputs: store.db.prepare("select * from execution_inputs where workflow_id = ? order by plan_id").all(nativeId),
      receipts: store.db.prepare("select * from execution_operations where workflow_id = ? order by epoch, operation_id").all(nativeId),
    };
  } finally { store.close(); }
}

test("a registered per-workflow path that is a regular file refuses by default, then an explicit acknowledgement imports only the healthy sibling with the loss named", async () => {
  const { context } = legacyWorkspace("nondir-child");
  const blockingId = "wf-nondir-child";
  const blockingPath = join(context.harnessDir, "workflows", blockingId);
  // A real regular file where the registered workflow directory belongs; the
  // registration the fixture wrote still names it.
  rmSync(blockingPath, { recursive: true, force: true });
  writeFileSync(blockingPath, NON_DIRECTORY_BYTES);

  // A healthy in-root sibling with a real plan, so the recovery's imported
  // content — not only its ID — is observable.
  const healthyId = "wf-nondir-child-healthy";
  const healthyPlanId = `${healthyId}-plan`;
  const healthyDir = join(context.harnessDir, "workflows", healthyId);
  mkdirSync(join(healthyDir, "sessions"), { recursive: true });
  writeFileSync(join(healthyDir, WORKFLOW_SNAPSHOT_FILE), JSON.stringify({
    schema_version: 1, id: healthyId, type: "plan", status: "running", started_at: "2026-10-04", updated_at: "2026-10-04",
    delivery_kind: "development", branch: { source: `feature/${healthyId}`, target: "main" },
    plans: [{ id: healthyPlanId, title: "Healthy sibling plan", file: `${healthyPlanId}.md`, status: "Todo" }],
  }));
  const statusPath = join(context.harnessDir, "status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8")) as { workflows: Array<Record<string, unknown>> };
  status.workflows.push({ id: healthyId, type: "plan", started_at: "2026-10-04", dir: `workflows/${healthyId}` });
  writeFileSync(statusPath, JSON.stringify(status));
  // The store must already exist for a pre-run snapshot of the whole protected
  // state; the refusal below must leave every byte of it identical.
  const initialized = await initializeStore(context);
  initialized.close();
  // A real unrelated native workflow, plan, frozen input and committed receipt:
  // the recovery must not disturb any of them.
  const nativeId = "wf-nondir-child-native";
  const nativeBefore = await seedUnrelatedNative(context, nativeId);
  const before = await protectedStore(context);

  // Default: the non-directory registered source is refused and nothing commits
  // — not even the healthy sibling.
  const refusal = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-nondir-child" })
    .then(() => { throw new Error("a non-directory registered source was silently omitted"); }, (error: Error & { code?: string }) => error);
  expect(refusal.code).toBe("execution.migration-conflict");
  expect(refusal.message).toContain("is not a real in-root directory");
  expect(refusal.message).toContain("a non-directory path is not a workflow source");
  expect(refusal.message).toContain(`--ack-skip-workflow ${blockingId}`);
  expect(await protectedStore(context)).toEqual(before);
  expect(readFileSync(blockingPath, "utf8")).toBe(NON_DIRECTORY_BYTES);

  // Explicit recovery: only the healthy sibling imports; the regular file keeps
  // its bytes and its lost import is named, with no fabricated resumption.
  const recovered = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-nondir-child-ack",
    acknowledgedWorkflowSkips: [blockingId],
  });
  expect(recovered).toMatchObject({ verdict: "upgraded", imported: 1, authorityState: "active" });
  expect(recovered.skipped).toContainEqual({
    path: `workflows/${blockingId}`,
    reason: `registered workflow ${blockingId} skipped by --ack-skip-workflow; its registered legacy source is not a real in-root directory, so it was not read and no execution row was imported for it`,
  });
  expect(recovered.dispositions).toContainEqual(
    expect.stringContaining(`workflow ${blockingId}: skipped by --ack-skip-workflow`),
  );
  expect(recovered.dispositions).toContainEqual(expect.stringContaining("no resumption is fabricated"));
  // The unrelated native workflow/plan/input/receipt content is byte-identical,
  // compared row by row and never by count.
  expect(await readUnrelatedNative(context, nativeId)).toEqual(nativeBefore);
  const store = await openStore(context, "read");
  try {
    // Exactly the unrelated native row and the healthy sibling imported; the
    // refused non-directory source fabricated nothing.
    expect(store.db.prepare("select workflow_id from execution_workflows order by workflow_id").all())
      .toEqual([{ workflow_id: healthyId }, { workflow_id: nativeId }]);
    // The healthy sibling's REAL imported header and plan content, not just its ID.
    const healthyHeader = JSON.parse((store.db.prepare("select state_json from execution_workflows where workflow_id = ?").get(healthyId) as { state_json: string }).state_json) as Record<string, unknown>;
    expect(healthyHeader).toMatchObject({
      schema_version: 1, id: healthyId, type: "plan", status: "running",
      delivery_kind: "development", branch: { source: `feature/${healthyId}`, target: "main" },
    });
    expect(healthyHeader).not.toHaveProperty("plans");
    const healthyPlan = JSON.parse((store.db.prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?").get(healthyId, healthyPlanId) as { state_json: string }).state_json) as Record<string, unknown>;
    expect(healthyPlan).toMatchObject({ id: healthyPlanId, title: "Healthy sibling plan", file: `${healthyPlanId}.md`, status: "Todo" });
    // The refused source contributed no plan row at all.
    expect(store.db.prepare("select workflow_id, plan_id from execution_plans where workflow_id = ?").all(blockingId)).toEqual([]);
  } finally { store.close(); }
  expect(readFileSync(blockingPath, "utf8")).toBe(NON_DIRECTORY_BYTES);
  // The refused source keeps its registered identity in the source register.
  expect(JSON.parse(readFileSync(statusPath, "utf8"))).toMatchObject({
    workflows: expect.arrayContaining([expect.objectContaining({ id: blockingId })]),
  });
});

test("a whole workflows root that is a regular file refuses naming its original registered ids, then the same acknowledgement skips only those IMPORTs and leaves the native authority intact", async () => {
  const { context } = legacyWorkspace("nondir-root");
  const workflowId = "wf-nondir-root";
  // A real unrelated native workflow/plan/input/receipt, created BEFORE the root
  // becomes a regular file: the whole-root recovery must not disturb it.
  const initialized = await initializeStore(context);
  initialized.close();
  const nativeId = "wf-nondir-root-native";
  const nativeBefore = await seedUnrelatedNative(context, nativeId);
  const protectedBefore = await protectedStore(context);

  const workflowsDir = join(context.harnessDir, "workflows");
  rmSync(workflowsDir, { recursive: true, force: true });
  writeFileSync(workflowsDir, NON_DIRECTORY_BYTES);

  const refusal = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-nondir-root" })
    .then(() => { throw new Error("a non-directory workflows root that registers a workflow was silently omitted"); }, (error: Error & { code?: string }) => error);
  expect(refusal.code).toBe("execution.migration-conflict");
  expect(refusal.message).toContain("is not a real directory");
  expect(refusal.message).toContain(`--ack-skip-workflow ${workflowId}`);
  // The refusal left the whole protected state — including the native rows —
  // and the root's bytes exactly as they were.
  expect(await readUnrelatedNative(context, nativeId)).toEqual(nativeBefore);
  expect(await protectedStore(context)).toEqual(protectedBefore);
  expect(readFileSync(workflowsDir, "utf8")).toBe(NON_DIRECTORY_BYTES);

  const recovered = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-nondir-root-ack",
    acknowledgedWorkflowSkips: [workflowId],
  });
  expect(recovered).toMatchObject({ verdict: "upgraded", imported: 0, authorityState: "active" });
  expect(recovered.skipped).toContainEqual({
    path: `workflows/${workflowId}`,
    reason: `registered workflow ${workflowId} skipped by --ack-skip-workflow; its registered legacy source is not a real in-root directory, so it was not read and no execution row was imported for it`,
  });
  expect(recovered.dispositions).toContainEqual(
    expect.stringContaining(`workflow ${workflowId}: skipped by --ack-skip-workflow`),
  );
  // The native workflow/plan/input/receipt content survives the acknowledged
  // whole-root recovery byte-for-byte.
  expect(await readUnrelatedNative(context, nativeId)).toEqual(nativeBefore);
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select workflow_id from execution_workflows order by workflow_id").all())
      .toEqual([{ workflow_id: nativeId }]);
  } finally { store.close(); }
  // The root keeps its bytes: the skip disposed an IMPORT, never the source.
  expect(readFileSync(workflowsDir, "utf8")).toBe(NON_DIRECTORY_BYTES);
});

test("a registered workflow with a MISSING snapshot stays an ordinary reported skip and is not an ackable refusal", async () => {
  const { context } = legacyWorkspace("nondir-missing");
  const workflowId = "wf-nondir-missing";
  // This is specifically the missing-SNAPSHOT shape: the registered directory
  // stays a real in-root directory, only its snapshot file is gone. A wholly
  // missing registered DIRECTORY is the separate physical-containment refusal
  // (`resolves outside control root`), which already has its own regression and
  // is deliberately not redefined here.
  rmSync(join(context.harnessDir, "workflows", workflowId, WORKFLOW_SNAPSHOT_FILE));

  // Missing snapshot is the existing reported skip: no refusal, and no
  // acknowledgement of it is accepted, because the run never refused that source.
  const skipped = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-nondir-missing" });
  expect(skipped.imported).toBe(0);
  expect(skipped.skipped).toContainEqual({
    path: `workflows/${workflowId}/snapshot.json`,
    reason: "registered workflow snapshot is missing; left in place",
  });
  const unmatched = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-nondir-missing-ack",
    acknowledgedWorkflowSkips: [workflowId],
  }).then(() => { throw new Error("a missing snapshot was accepted as an ackable refusal"); }, (error: Error & { code?: string }) => error);
  expect(unmatched.code).toBe("execution.workflow-skip-unmatched");
});

test("concurrent importer processes serialize through SQLite, not a status directory", async () => {
  const { context } = legacyV1Workspace("v1-concurrent");
  const worker = join(ROOT, "upgrade-worker.mjs");
  writeFileSync(worker, `
import { upgradeStoreMinimal } from ${JSON.stringify(join(import.meta.dir, "execution-minimal-import.ts"))};
const [harnessDir, operationId, declaration] = process.argv.slice(2);
// Announce readiness, then block on the parent's release line: every child
// begins its upgrade only once all of them are waiting, so they truly overlap.
process.stdout.write("ready\\n");
const reader = Bun.stdin.stream().getReader();
await reader.read();
reader.releaseLock();
try {
  const result = await upgradeStoreMinimal({ context: { harnessDir }, operator: "child", operationId, deliveryDeclarations: JSON.parse(declaration) });
  process.stdout.write(JSON.stringify({ imported: result.imported }));
} catch (error) {
  process.stdout.write(JSON.stringify({ refused: String(error?.code ?? error?.message ?? error) }));
}
`);
  const children = Array.from({ length: 3 }, (_, index) => {
    const child = spawn("bun", [worker, context.harnessDir, `op-concurrent-${index}`, JSON.stringify(V1_STANDALONE_DECLARATION)], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let announced: () => void = () => {};
    const ready = new Promise<void>((resolve) => { announced = resolve; });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes("ready\n")) announced();
    });
    const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
    return { index, ready, release: () => child.stdin.write("go\n"), done: closed.then(() => ({ stdout })) };
  });
  await Promise.all(children.map((child) => child.ready));
  for (const child of children) child.release();
  const results = await Promise.all(children.map((child) => child.done));

  const parsed = results.map(({ stdout }) => {
    const payload = JSON.parse(stdout.slice("ready\n".length)) as { imported?: number; refused?: string };
    return { imported: payload.imported ?? 0, refused: payload.refused };
  });
  // The importer creates one coherent store and commits the v1 lifecycles once;
  // competing public attempts receive only the create-only store refusal.
  expect(parsed.filter(({ imported }) => imported > 0)).toHaveLength(1);
  expect(parsed.map(({ imported }) => imported).reduce((sum, value) => sum + value, 0)).toBe(2);
  for (const { refused } of parsed) {
    if (refused !== undefined) expect(refused).toBe("store.already-exists");
  }
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 2 });
    expect(store.db.prepare("select authority_state from execution_meta where id = 1").get()).toEqual({ authority_state: "active" });
  } finally {
    store.close();
  }
  // A LATER operation id is not a replay: the v1 lifecycles this store already
  // holds collide with the retained source, so it refuses and names the
  // same-entry acknowledgement instead of silently skipping them.
  const refusedRetry = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-concurrent-retry", deliveryDeclarations: V1_STANDALONE_DECLARATION })
    .then(() => { throw new Error("a repeated v1 import under a new operation id did not refuse"); }, (error: Error & { code?: string }) => error);
  expect(refusedRetry.code).toBe("execution.migration-conflict");
  const ackedRetry = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-concurrent-retry-ack",
    deliveryDeclarations: V1_STANDALONE_DECLARATION,
    acknowledgedWorkflowSkips: ["iter-v1", "v1-standalone"],
  });
  expect(ackedRetry.imported).toBe(0);
  // No filesystem mutex directory was created anywhere in the workspace.
  expect(existsSync(join(context.harnessDir, ".status-write.lockdir"))).toBe(false);
  expect(existsSync(join(context.harnessDir, ".execution-maintenance"))).toBe(false);
}, 60_000);

for (const shape of ["symlink", "directory"] as const) {
  test(`an unsafe nested ${shape} snapshot has same-entry recovery preserving native authority`, async () => {
    const { context, workflowId, legacyBytes } = await nativeCollisionWorkspace(`nested-${shape}`);
    const snapshot = join(context.harnessDir, "workflows", workflowId, WORKFLOW_SNAPSHOT_FILE);
    const target = join(ROOT, `nested-${shape}-target.json`);
    writeFileSync(target, legacyBytes);
    rmSync(snapshot);
    if (shape === "symlink") symlinkSync(target, snapshot);
    else mkdirSync(snapshot);
    const before = await protectedStore(context);
    await expect(upgradeStoreMinimal({ context, operator: "operator", operationId: `nested-${shape}-refuse` }))
      .rejects.toMatchObject({ code: "execution.migration-conflict", message: expect.stringContaining(`--ack-skip-workflow ${workflowId}`) });
    expect(await protectedStore(context)).toEqual(before);
    await expect(upgradeStoreMinimal({ context, operator: "operator", operationId: `nested-${shape}-wrong`, acknowledgedWorkflowSkips: ["wf-not-a-source"] }))
      .rejects.toMatchObject({ code: "execution.workflow-skip-unmatched" });
    const { result, accessed } = await withPathAccessLog(() => upgradeStoreMinimal({
      context, operator: "operator", operationId: `nested-${shape}-ack`, acknowledgedWorkflowSkips: [workflowId],
    }));
    expect(result).toMatchObject({ verdict: "upgraded", imported: 0 });
    expect(result.skipped).toContainEqual(expect.objectContaining({ path: `workflows/${workflowId}` }));
    expect(result.dispositions).toContainEqual(expect.stringContaining(`workflow ${workflowId}: skipped by --ack-skip-workflow`));
    // The containing directory IS a real in-root directory here, so the shared
    // disposition must not blame it; only the per-item reason names the cause.
    expect(result.dispositions.join("\n")).not.toContain("is not a real in-root directory");
    expect(accessed.filter((path) => path === target || path.startsWith(`${snapshot}/`))).toEqual([]);
    const after = await protectedStore(context);
    for (const [name, rows] of Object.entries(before.tables)) {
      if (name.startsWith("execution_") && name !== "execution_operations") expect(after.tables[name]).toEqual(rows);
    }
    expect(readFileSync(target).equals(legacyBytes)).toBe(true);
    expect(shape === "symlink" ? lstatSync(snapshot).isSymbolicLink() : lstatSync(snapshot).isDirectory()).toBe(true);
  });
}

for (const leaf of ["status", "snapshot", "session"] as const) {
  test(`a ${leaf} execution source replaced at open never contributes target bytes`, async () => {
    const name = `execution-leaf-${leaf}`;
    const { context } = legacyWorkspace(name);
    const workflowId = `wf-${name}`;
    const dir = join(context.harnessDir, "workflows", workflowId);
    const source = leaf === "status" ? join(context.harnessDir, "status.json")
      : leaf === "snapshot" ? join(dir, WORKFLOW_SNAPSHOT_FILE) : join(dir, "sessions", "plan-pm.json");
    const target = join(ROOT, `${name}-outside.json`);
    const bytes = readFileSync(source);
    writeFileSync(target, bytes);
    const outside = nodeFs.statSync(target);
    const initialized = await initializeStore(context); initialized.close();
    const before = await protectedStore(context);
    const realLstat = nodeFs.lstatSync, realRead = nodeFs.readFileSync, realStat = nodeFs.statSync, realFstat = nodeFs.fstatSync;
    let swapped = false, targetReads = 0;
    const probe = spyOn(nodeFs, "lstatSync").mockImplementation(((path: string) => {
      const info = realLstat(path);
      if (path === source && !swapped) { swapped = true; rmSync(source); symlinkSync(target, source); }
      return info;
    }) as never);
    const reads = spyOn(nodeFs, "readFileSync").mockImplementation(((path: string | number, ...args: unknown[]) => {
      const info = typeof path === "number" ? realFstat(path) : realStat(path);
      if (info.dev === outside.dev && info.ino === outside.ino) targetReads++;
      return (realRead as (...args: unknown[]) => unknown)(path, ...args);
    }) as never);
    try {
      await expect(upgradeStoreMinimal({ context, operator: "operator", operationId: name }))
        .rejects.toMatchObject({ code: "execution.migration-conflict" });
    } finally { probe.mockRestore(); reads.mockRestore(); }
    expect(swapped).toBe(true);
    expect(targetReads).toBe(0);
    expect(await protectedStore(context)).toEqual(before);
    if (leaf === "status") {
      const fresh = { harnessDir: join(ROOT, `${name}-fresh-native`) };
      mkdirSync(fresh.harnessDir);
      const initialized = await initializeStore(fresh); initialized.close();
      expect((await readExecutionState(fresh)).data.workflows).toEqual([]);
      expect(await protectedStore(context)).toEqual(before);
    }
    expect(readFileSync(target)).toEqual(bytes);
  });
}

test("a legacy root register that is a FIFO at open refuses instead of blocking", async () => {
  const name = "fifo-root-register";
  const { context } = legacyWorkspace(name);
  const statusPath = join(context.harnessDir, "status.json");
  // The harness fixture lives on disk, and a blocking open cannot be interrupted
  // in-process, so the probe runs in a child with a real timeout: a regression
  // fails this case instead of wedging the suite.
  rmSync(statusPath);
  execFileSync("mkfifo", [statusPath]);
  const probe = (harnessDir: string, operationId: string): { status: string; code?: string } =>
    JSON.parse(execFileSync(process.execPath, ["-e", `
      const mod = await import(${JSON.stringify(join(import.meta.dir, "execution-minimal-import.ts"))});
      try {
        const result = await mod.upgradeStoreMinimal({ context: { harnessDir: ${JSON.stringify(harnessDir)} }, operator: "operator", operationId: ${JSON.stringify(operationId)} });
        console.log(JSON.stringify({ status: "ok", verdict: result.verdict }));
      } catch (error) {
        console.log(JSON.stringify({ status: "threw", code: error && error.code }));
      }
    `], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }));
  const refused = probe(context.harnessDir, "op-fifo-root");
  expect(refused).toMatchObject({ status: "threw", code: "execution.migration-conflict" });
  expect(lstatSync(statusPath).isFIFO()).toBe(true);
  // The refusal is per source and the read was bounded: a decidable root in the
  // same run shape still imports.
  const { context: healthy, unknownBytes } = legacyWorkspace("fifo-root-register-control");
  expect(probe(healthy.harnessDir, "op-fifo-control")).toMatchObject({ status: "ok", verdict: "upgraded" });
  expect(readFileSync(join(healthy.harnessDir, "status.json")).length).toBeGreaterThan(0);
  expect(unknownBytes.length).toBeGreaterThan(0);
}, 30_000);

test("a v1 root converts from the verified register bytes without a second path read", async () => {
  const { context } = legacyV1Workspace("v1-single-read");
  const statusPath = join(context.harnessDir, "status.json");
  const realRead = nodeFs.readFileSync;
  const pathReads: string[] = [];
  const probe = spyOn(nodeFs, "readFileSync").mockImplementation(((path: string | number, ...rest: unknown[]) => {
    if (typeof path === "string" && path === statusPath) pathReads.push(path);
    return (realRead as (...args: unknown[]) => unknown)(path, ...rest);
  }) as never);
  let result;
  try {
    result = await upgradeStoreMinimal({
      context, operator: "operator", operationId: "op-v1-single-read", deliveryDeclarations: V1_STANDALONE_DECLARATION,
    });
  }
  finally { probe.mockRestore(); }
  expect(result.verdict).toBe("upgraded");
  // The classification read and the converted rows come from one descriptor
  // read: the path was never re-acquired (readFileSync receives only numbers
  // for that file, which the spy would have recorded as no path read at all).
  expect(pathReads).toEqual([]);
  const store = await openStore(context, "read");
  try { expect(store.db.prepare("select count(*) as n from execution_workflows").get()).toMatchObject({ n: expect.any(Number) }); }
  finally { store.close(); }
});

test("a malformed legacy plan row is skippable instead of blocking every other workflow", async () => {
  const root = join(ROOT, "malformed-row", ".mstar");
  const healthy = join(root, "workflows", "wf-healthy");
  const broken = join(root, "workflows", "wf-broken");
  mkdirSync(join(healthy, "sessions"), { recursive: true });
  mkdirSync(broken, { recursive: true });
  const snapshot = (id: string, plans: Array<Record<string, unknown>>): string => JSON.stringify({
    schema_version: 1, id, type: "plan", status: "running", started_at: "2026-10-04", updated_at: "2026-10-04",
    delivery_kind: "development", branch: { source: `feature/${id}`, target: "main" }, plans,
  });
  writeFileSync(join(healthy, WORKFLOW_SNAPSHOT_FILE), snapshot("wf-healthy", [{ id: "wf-healthy-plan", title: "ok", status: "Todo", file: "wf-healthy-plan.md" }]));
  writeFileSync(join(broken, WORKFLOW_SNAPSHOT_FILE), snapshot("wf-broken", [
    { id: "dup-plan", title: "first", status: "Todo", file: "first.md" },
    { id: "dup-plan", title: "second", status: "Todo", file: "second.md" },
  ]));
  writeFileSync(join(root, "wf-healthy-plan.md"), "# wf-healthy-plan\n");
  writeFileSync(join(root, "status.json"), JSON.stringify({
    version: 2, updated_at: "2026-10-04", workflows: [
      { id: "wf-healthy", type: "plan", started_at: "2026-10-04", dir: "workflows/wf-healthy" },
      { id: "wf-broken", type: "plan", started_at: "2026-10-04", dir: "workflows/wf-broken" },
    ],
  }));
  const context = { harnessDir: root };
  // One agent-authored mistake refuses as a SOURCE the acknowledgement can name,
  // not as a whole-run conflict.
  await expect(upgradeStoreMinimal({ context, operator: "operator", operationId: "op-malformed-row" }))
    .rejects.toMatchObject({ code: "execution.migration-conflict", message: expect.stringContaining("--ack-skip-workflow wf-broken") });
  const acked = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-malformed-row-ack", acknowledgedWorkflowSkips: ["wf-broken"] });
  expect(acked).toMatchObject({ verdict: "upgraded", imported: 1, importedIds: ["wf-healthy"] });
  expect(acked.dispositions).toContainEqual(expect.stringContaining("workflow wf-broken: skipped by --ack-skip-workflow"));
  expect(readFileSync(join(broken, WORKFLOW_SNAPSHOT_FILE), "utf8")).toContain("dup-plan");
});

test("a workflows entry that sources nothing no longer aborts the upgrade", async () => {
  const root = join(ROOT, "workflows-file", ".mstar");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "status.json"), JSON.stringify({ version: 2, updated_at: "2026-10-04", workflows: [] }));
  writeFileSync(join(root, "workflows"), "not a directory");
  const result = await upgradeStoreMinimal({ context: { harnessDir: root }, operator: "operator", operationId: "op-workflows-file" });
  expect(result).toMatchObject({ verdict: "upgraded", imported: 0 });
  expect(readFileSync(join(root, "workflows"), "utf8")).toBe("not a directory");
  // A registration UNDER it keeps the existing per-source refusal.
  const registered = join(ROOT, "workflows-file-registered", ".mstar");
  mkdirSync(registered, { recursive: true });
  writeFileSync(join(registered, "workflows"), "not a directory");
  writeFileSync(join(registered, "status.json"), JSON.stringify({
    version: 2, updated_at: "2026-10-04",
    workflows: [{ id: "wf-under-file", type: "plan", started_at: "2026-10-04", dir: "workflows/wf-under-file" }],
  }));
  await expect(upgradeStoreMinimal({ context: { harnessDir: registered }, operator: "operator", operationId: "op-workflows-file-registered" }))
    .rejects.toMatchObject({ code: "execution.migration-conflict", message: expect.stringContaining("--ack-skip-workflow wf-under-file") });
});

test("a DSH refusal names every acknowledgement its advertised retry needs", async () => {
  const { context } = legacyWorkspace("dsh-retry");
  const workflowId = "wf-dsh-retry";
  // Conflicting duplicate identities make the DSH phase refuse after the
  // execution phase has already committed this workflow's rows.
  writeFileSync(join(context.harnessDir, "workflows", workflowId, "agent-flow-ids.jsonl"), '{"id":"wfe1:x:1","d":"a"}\n{"id":"wfe1:x:1","d":"b"}\n');
  const error = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-dsh-retry" })
    .then(() => { throw new Error("expected a DSH refusal"); }, (failure: Error & { code?: string }) => failure);
  expect(error.code).toBe("store.upgrade-dsh-source-refused");
  expect(error.message).toContain("--ack-skip-dsh");
  expect(error.message).toContain(`dsh-ledger:${workflowId}`);
  // The committed ids are native collisions on the next invocation, so the same
  // message must name the execution acknowledgement too.
  expect(error.message).toContain(`--ack-skip-workflow ${workflowId}`);
  const retried = await upgradeStoreMinimal({
    context, operator: "operator", operationId: "op-dsh-retry-2",
    acknowledgedSkips: [`dsh-ledger:${workflowId}`], acknowledgedWorkflowSkips: [workflowId],
  });
  expect(retried).toMatchObject({ verdict: "upgraded", imported: 0 });
});

test("each legacy source leaf is opened once: the digest hashes the bytes the import consumed", async () => {
  const { context } = legacyWorkspace("single-acquisition");
  const realOpen = nodeFs.openSync;
  const opened: string[] = [];
  const spy = spyOn(nodeFs, "openSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
    if (typeof path === "string") opened.push(path);
    return (realOpen as (...args: unknown[]) => number)(path, ...rest);
  }) as never);
  let result;
  try { result = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-single-acquisition" }); }
  finally { spy.mockRestore(); }
  expect(result.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  for (const leaf of [
    "status.json",
    `workflows/wf-single-acquisition/${WORKFLOW_SNAPSHOT_FILE}`,
    "workflows/wf-single-acquisition/sessions/plan-pm.json",
    "workflows/wf-single-acquisition/unknown.bin",
  ]) {
    const path = join(context.harnessDir, leaf);
    expect({ leaf, opens: opened.filter((candidate) => candidate === path).length }).toEqual({ leaf, opens: 1 });
  }
});

