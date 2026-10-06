import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeStore, migrationChecksum, MIGRATIONS, openStore, SCHEMA_VERSION_TABLE_SQL, storeDbPath, upgradeStore, type StoreContext, type StoreDb } from "./store-db.js";
import { WORKFLOW_SNAPSHOT_FILE } from "./workflow.js";
import { upgradeStoreMinimal } from "./execution-minimal-import.js";
import { bindExecutionSession, executionToken, readExecutionPlan, readExecutionState } from "./execution-store.js";
import { ACTIVATION_PROTOCOL_VERSION, backupStore, type ActivationAttestation } from "./store-activation.js";
import { createLocalExecutionIdentity, executionContextFor, resumeExecutionSession } from "./execution-session.js";
import { mutateExecutionPlan } from "./execution-coordination.js";
import { executionInputHash, executionInputSelection } from "./coordination.js";
import { previewExecutionRestore, restoreExecutionBackup } from "./execution-recovery.js";
import { listPendingCatalogRegistrations, reconcileCatalogExecution, registerCatalogExecution } from "./catalog-registration.js";
import { createFsStore, setArtifactStore } from "./store.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "mstar-store-upgrade-minimal-")));
afterAll(() => {
  setArtifactStore(undefined);
  rmSync(ROOT, { recursive: true, force: true });
});

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
  expect(await upgradeStoreMinimal(input)).toEqual(result);
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
    expect(refused.schemaVersion).toBe(MIGRATIONS.length - 1);
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
    expect((coordination.completion as Record<string, unknown>)).toMatchObject({ source_branch: `feature/${workflowId}`, completed_by: "host-coord" });
    const state = JSON.parse(
      (store.db.prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?").get(workflowId, planId) as { state_json: string }).state_json,
    ) as Record<string, unknown>;
    expect(state).toMatchObject({ status: "Done", metadata: { worktree_path: join(ROOT, "legacy-worktree"), working_branch: `feature/${workflowId}` } });
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
    expect(store.schemaVersion).toBe(MIGRATIONS.length - 1);
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
      expect(created.schemaVersion).toBe(9);
    } finally {
      created.close();
    }
    const { context, sessionId } = await historicalClaimWorkspace(`low-upgrade-${invalid.name}`);
    const before = await protectedStore(context);
    await expect(upgradeStore(context, { attestation: invalid.document })).rejects.toMatchObject({ code: invalid.code });
    expect(await protectedStore(context)).toEqual(before);
    expect(await upgradeStore(context, { attestation: stopDocument(sessionId) })).toEqual({ schemaVersion: 9 });
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
    expect(await upgradeStore(context, { attestation: accepted })).toEqual({ schemaVersion: 9 });
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
  const recoveryRecord = JSON.parse(readFileSync(restored.recoveryReceiptPath, "utf8"));
  expect(recoveryRecord).toMatchObject({
    phase: "replaced", operator: "fixture-operator", authorization: "restore-pre-corruption-point",
    backupPath: backup.backupPath, backupSha256: preview.backupSha256,
    verified: { integrity: "ok", foreignKeys: "ok", schemaVersion: 8, executionAuthorityState: "active" },
  });
  const recovered = await protectedStore(context);
  expect(recovered.schema).toEqual(before.schema);
  const originalMeta = JSON.parse(before.tables.store_meta![0]!);
  const restoredMeta = JSON.parse(recovered.tables.store_meta![0]!);
  expect(restoredMeta).toEqual({ ...originalMeta, authority_epoch: restored.epoch });
  for (const table of Object.keys(before.tables).filter((table) => table !== "store_meta")) {
    expect(recovered.tables[table]).toEqual(before.tables[table]);
  }
  await upgradeStoreMinimal({
    context, operator: "operator", operationId: "recovered-upgrade", attestation: stopDocument(sessionId),
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

test("existing git-root store stays reachable: upgrade imports into the same db instead of creating a second empty store", async () => {
  // Old layout per Greptile Issue 2: harnessDir is a repo root with a .mstar
  // child; the store lives at <root>/.mstar/store.db (the resolver's own
  // selection, unchanged by this PR). Pre-seed marked data there, then run
  // the upgrade against the repo root and prove the SAME database received
  // the import — no second, empty store at <root>/store.db.
  const repoRoot = join(ROOT, "git-root-reachable");
  mkdirSync(join(repoRoot, ".mstar"), { recursive: true });
  const storeContext: StoreContext = { harnessDir: repoRoot };
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

  const replay = await upgradeStoreMinimal({ ...input, operationId: "op-no-store-populated-replay" });
  expect(replay.imported).toBe(0);
  const afterReplay = await openStore(context, "read");
  try {
    expect(afterReplay.db.prepare("select count(*) as n from execution_workflows").get()).toEqual({ n: 1 });
  } finally {
    afterReplay.close();
  }
});
test("store path preserves fail-closed refusal for an unresolved linked worktree", () => {
  const harnessDir = join(ROOT, "unresolved-linked-checkout");
  mkdirSync(join(harnessDir, "plans"), { recursive: true });
  writeFileSync(join(harnessDir, ".git"), "gitdir: /missing/worktree/metadata\n");

  expect(() => storeDbPath({ harnessDir })).toThrow("linked checkout");
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
});

test("pending execution-written catalog registration remains publicly reconcilable after minimal activation", async () => {
  const context: StoreContext = { harnessDir: join(ROOT, "pending-catalog", ".mstar") };
  const workflowId = "wf-pending-catalog";
  const planId = "pending-catalog-plan";
  const title = "Pending catalog plan";
  mkdirSync(join(context.harnessDir, "plans"), { recursive: true });
  writeFileSync(join(context.harnessDir, "plans", `${planId}.md`), `# ${title}\n\n**plan_id:** ${planId}\n`);
  const store = await initializeStore(context);
  try {
    store.db.exec(`CREATE TRIGGER fail_catalog_publish BEFORE INSERT ON catalog_entities
      BEGIN SELECT RAISE(ABORT, 'injected publish failure'); END;`);
  } finally {
    store.close();
  }
  setArtifactStore(createFsStore(context.harnessDir));
  await expect(registerCatalogExecution(context, {
    operationId: "op-pending-catalog",
    actor: "project-manager",
    expectedCatalogRevision: 0,
    workflow: {
      kind: "plan",
      workflowId,
      options: {
        harnessDir: context.harnessDir,
        plan: { id: planId, title, file: `plans/${planId}.md` },
        deliveryKind: "development",
        branchSource: "feature/pending-catalog",
        branchTarget: "main",
        project: "harness",
        startedAt: "2026-10-04T00:00:00.000Z",
      },
    },
    delta: {
      entities: [{ kind: "plan", id: planId, title, rootKind: "plans", relativePath: `${planId}.md` }],
      binding: { catalogKind: "plan", catalogId: planId },
    },
  })).rejects.toThrow();

  const before = await listPendingCatalogRegistrations(context);
  expect(before).toContainEqual(expect.objectContaining({ operationId: "op-pending-catalog", workflowId, phase: "execution-written" }));
  const storeAfterFailure = await openStore(context, "write");
  try {
    storeAfterFailure.db.exec("DROP TRIGGER fail_catalog_publish");
  } finally {
    storeAfterFailure.close();
  }
  const imported = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-import-pending-catalog" });
  expect(imported).toMatchObject({ verdict: "upgraded", imported: 1, authorityState: "active" });
  expect(await listPendingCatalogRegistrations(context)).toContainEqual(
    expect.objectContaining({ operationId: "op-pending-catalog", workflowId, phase: "execution-written" }),
  );

  const receipt = await reconcileCatalogExecution(context, "op-pending-catalog");
  expect(receipt).toMatchObject({ operationId: "op-pending-catalog", workflowId });
  expect(await listPendingCatalogRegistrations(context)).not.toContainEqual(expect.objectContaining({ operationId: "op-pending-catalog" }));
});
