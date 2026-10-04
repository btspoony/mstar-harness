import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStore, openStore, storeDbPath, type StoreContext } from "./store-db.js";
import { WORKFLOW_SNAPSHOT_FILE } from "./workflow.js";
import { upgradeStoreMinimal } from "./execution-minimal-import.js";
import { readExecutionState } from "./execution-store.js";
import { listPendingCatalogRegistrations, reconcileCatalogExecution, registerCatalogExecution } from "./catalog-registration.js";
import { createFsStore, setArtifactStore } from "./store.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-store-upgrade-minimal-"));
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

test("store upgrade imports snapshot rows, ownership, and unknown bytes, then replays idempotently", async () => {
  const { context, unknownBytes } = legacyWorkspace("creates-and-imports");
  const unknownPath = join(context.harnessDir, "workflows", "wf-creates-and-imports", "unknown.bin");
  const input = { context, operator: "operator", operationId: "op-minimal-import" };
  const result = await upgradeStoreMinimal(input);
  expect(result).toMatchObject({ verdict: "upgraded", imported: 1, authorityState: "active" });
  expect(result.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(result.skipped).toEqual([{ path: "workflows/wf-creates-and-imports/unknown.bin", reason: "unrecognized workflow entry; left in place" }]);
  expect([...readFileSync(unknownPath)]).toEqual([...unknownBytes]);
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select authority_state, revision from execution_meta where id = 1").get())
      .toEqual({ authority_state: "active", revision: 2 });
    expect(store.db.prepare("select authority_epoch from store_meta where id = 1").get())
      .toEqual({ authority_epoch: 2 });
    const workflow = store.db.prepare("select workflow_id, state_json from execution_workflows").get() as { workflow_id: string; state_json: string };
    expect(workflow.workflow_id).toBe("wf-creates-and-imports");
    expect(JSON.parse(workflow.state_json)).toMatchObject({
      status: "running",
      branch: { source: "feature/wf-creates-and-imports", target: "main" },
    });
    const plan = store.db.prepare("select workflow_id, plan_id, state_json from execution_plans").get() as { workflow_id: string; plan_id: string; state_json: string };
    expect(plan).toMatchObject({ workflow_id: workflow.workflow_id, plan_id: "wf-creates-and-imports-plan" });
    expect(JSON.parse(plan.state_json)).toMatchObject({ id: plan.plan_id, status: "Todo", title: "Upgrade fixture plan" });
    expect(store.db.prepare("select workflow_id, role, session_id, plan_id, state from execution_sessions").get())
      .toMatchObject({ workflow_id: workflow.workflow_id, role: "plan-pm", session_id: "session-creates-and-imports", plan_id: plan.plan_id, state: "suspended" });
    const lease = store.db.prepare("select workflow_id, plan_id, lease_json from execution_leases").get() as { workflow_id: string; plan_id: string; lease_json: string };
    expect(lease).toMatchObject({ workflow_id: workflow.workflow_id, plan_id: plan.plan_id });
    expect(JSON.parse(lease.lease_json)).toMatchObject({
      holder: "session-creates-and-imports",
      working_branch: "feature/wf-creates-and-imports",
      plan_branch: "feature/wf-creates-and-imports",
      status: "held",
    });
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
    expect(replayStore.db.prepare("select count(*) as n from execution_sessions").get()).toEqual({ n: 1 });
    expect(replayStore.db.prepare("select count(*) as n from execution_leases").get()).toEqual({ n: 1 });
  } finally {
    replayStore.close();
  }
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

test("active-store import advances the epoch for imported held leases", async () => {
  const { context } = legacyWorkspace("active-held-lease");
  const initialized = await initializeStore(context);
  try {
    const now = "2026-10-04T00:00:00Z";
    initialized.db.prepare("update execution_meta set authority_state = 'active', revision = revision + 1, root_updated_at = ?, activated_at = ? where id = 1")
      .run(now, now);
  } finally {
    initialized.close();
  }

  const result = await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-active-held-lease" });
  expect(result).toMatchObject({ verdict: "upgraded", imported: 1, authorityState: "active" });
  const state = await readExecutionState(context);
  expect(state.data.workflows[0]?.plans[0]?.executionLease).toMatchObject({
    status: "held",
    holder_session_id: "session-active-held-lease",
  });
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

test("minimal import preserves coordinator recovery and self-amendment audits in the workflow header", async () => {
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
    expect(header).toMatchObject({ identity_recoveries: [recovery], self_amendments: [amendment] });
    expect(header).not.toHaveProperty("coordination");
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
    expect(store.db.prepare("select count(*) as n from execution_sessions").get()).toEqual({ n: 1 });
    expect(store.db.prepare("select count(*) as n from execution_leases").get()).toEqual({ n: 1 });
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
  expect(result.skipped).toEqual([{ path: "workflows/wf-unregistered-populated/unknown.bin", reason: "unrecognized workflow entry; left in place" }]);
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
  await expect(upgradeStoreMinimal({ context: malformed.context, operator: "operator", operationId: "op-malformed-session" }))
    .rejects.toMatchObject({ code: "execution.migration-conflict", message: expect.stringContaining("malformed; repair the envelope or remove its plan-pm binding") });
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
