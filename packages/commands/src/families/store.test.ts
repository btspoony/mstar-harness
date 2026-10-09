import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { WORKFLOW_SNAPSHOT_FILE, initializeStore, openStore } from "@mstar-harness/engine";
import type { InvocationContext } from "../types.js";
import { executeCommand, getCommandDefinitions } from "../definitions.js";
import { getStoreCommandDefinitions } from "../index.js";


function legacyWorkspace(harness: string): void {
  const workflowId = "upgrade-fixture-workflow";
  const workflowDir = join(harness, "workflows", workflowId);
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(harness, "status.json"), JSON.stringify({
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
    project: "_default",
    branch: { source: "feature/upgrade-fixture", target: "main" },
    plans: [{ id: `${workflowId}-plan`, title: "Upgrade fixture", file: "plan.md", status: "Todo", metadata: {} }],
  }));
}

function invocation(cwd: string): InvocationContext {
  const messages: string[] = [];
  return {
    cwd,
    controlRoot: join(cwd, ".mstar"),
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { return { exitCode: 1, signal: null, stdout: "", stderr: "" }; },
      async startDashboard() { throw new Error("not available in this command family"); },
      async openBrowser() { throw new Error("not available in this command family"); },
      writeStderr(message) { messages.push(message); },
    },
  };
}

async function protectedStoreState(harness: string) {
  const store = await openStore({ harnessDir: harness }, "read");
  try {
    const schema = z.array(z.object({
      type: z.string(), name: z.string(), tbl_name: z.string(), sql: z.string().nullable(),
    })).parse(store.db.prepare(
      "select type, name, tbl_name, sql from sqlite_schema where name not like 'sqlite_%' order by type, name",
    ).all());
    // Capture every stored surface, including registry, inputs, operations,
    // sessions, claims, authority metadata and migration records, not counts.
    const tables = Object.fromEntries(schema.filter(({ type }) => type === "table").map(({ name }) => [
      name,
      store.db.prepare(`select * from "${name.replaceAll('"', '""')}"`).all(),
    ]));
    return { schemaVersion: store.schemaVersion, schema, tables };
  } finally {
    store.close();
  }
}

test("store.upgrade discovers the canonical project harness and imports its legacy workflow without attestation", async () => {
  const root = mkdtempSync(join(tmpdir(), "mstar-store-upgrade-command-"));
  try {
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    legacyWorkspace(harness);
    const definition = getStoreCommandDefinitions().find(({ id }) => id === "store.upgrade");
    if (definition === undefined) throw new Error("missing store.upgrade definition");
    const result = await definition.execute(definition.input.parse({ operator: "fixture-operator" }), invocation(root));
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toMatchObject({ verdict: "upgraded", authorityState: "active", imported: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("store.upgrade names the required operator input before writing", async () => {
  const root = mkdtempSync(join(tmpdir(), "mstar-store-upgrade-missing-operator-"));
  try {
    const definition = getStoreCommandDefinitions().find(({ id }) => id === "store.upgrade");
    if (definition === undefined) throw new Error("missing store.upgrade definition");
    const result = await definition.execute(definition.input.parse({ harness: join(root, ".mstar") }), invocation(root));
    expect(result).toMatchObject({ status: "usage", message: "--operator is required" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a store usage refusal carries the shared factory metadata and keeps its code", async () => {
  const root = mkdtempSync(join(tmpdir(), "mstar-store-usage-shape-"));
  try {
    const definition = getStoreCommandDefinitions().find(({ id }) => id === "store.upgrade");
    if (definition === undefined) throw new Error("missing store.upgrade definition");
    const result = await definition.execute(definition.input.parse({ harness: join(root, ".mstar") }), invocation(root));
    expect(result).toMatchObject({ status: "usage", code: "usage", exitCode: 2 });
    if (result.status !== "usage") throw new Error("expected usage envelope");
    expect(result.message.split("\n")[0]).toBe("--operator is required");
    expect(result.details).toMatchObject({
      helpRoute: "mstar store upgrade --help",
      recovery: "Run mstar store upgrade --help and correct the flagged input.",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a store engine refusal keeps its code, exit 1 and message through the factory", async () => {
  const root = mkdtempSync(join(tmpdir(), "mstar-store-refused-shape-"));
  try {
    const definition = getStoreCommandDefinitions().find(({ id }) => id === "store.init");
    if (definition === undefined) throw new Error("missing store.init definition");
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    // An existing store makes `store.init` refuse from the engine (exit 1).
    const seeded = await initializeStore({ harnessDir: harness });
    seeded.close();
    const result = await definition.execute(definition.input.parse({ harness }), invocation(root));
    expect(result).toMatchObject({ status: "refused", code: "store.already-exists", exitCode: 1 });
    if (result.status === "ok" || result.status === "usage") throw new Error(`expected a refusal, got ${result.status}`);
    expect(result.message.split("\n")[0]).not.toContain("Help:");
    expect(result.message).toContain("Help: mstar store init --help");
    expect(result.details).toMatchObject({ helpRoute: "mstar store init --help" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default registration removes only staged protocol faces and keeps independent restore/export", () => {
  const definitions = getCommandDefinitions();
  const ids = new Set(definitions.map(({ id }) => id));
  expect(ids.has("store.safe-upgrade")).toBe(false);
  for (const verb of ["preview", "apply", "activate", "retire", "abort"]) {
    expect(ids.has(`store.execution.${verb}`)).toBe(false);
  }
  expect(ids.has("store.execution.restore-preview")).toBe(true);
  expect(ids.has("store.execution.restore")).toBe(true);
  expect(ids.has("store.execution.export")).toBe(true);
});

test("a held retired schema-8 claim refuses without mutation and settles on the same public command's attested retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "mstar-store-upgrade-retired-claim-"));
  try {
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    const workflowId = "retired-claim-workflow";
    const planId = `${workflowId}-plan`;
    const sessionId = "retired-plan-holder";
    const worktreePath = join(root, "wt-retired");
    const workingBranch = `feature/${planId}`;
    const businessPlan = { id: planId, title: "Retired claim plan", file: `${planId}.md`, status: "InProgress" };
    const workflowState = {
      schema_version: 1, id: workflowId, type: "plan", status: "running",
      started_at: "2026-10-04", updated_at: "2026-10-04",
      delivery_kind: "development", branch: { source: workingBranch, target: "main" },
    };
    const prepared = {
      qa_gate: "mandatory", findings_cleanup: "allow-residual",
      prepared_by: "host-coord", prepared_at: "2026-10-04T00:00:00Z",
    };
    const initialized = await initializeStore({ harnessDir: harness });
    try {
      // Reconstruct the actual schema-8 shape, as in the owning engine fixture:
      // the historical session CHECK/indexes and per-plan lease table must exist
      // before inserting the retired identity. Initialization alone is schema 9.
      initialized.db.exec(`
        delete from schema_version where version = 9;
        create table execution_sessions_v8(
          workflow_id text not null references execution_workflows(workflow_id),
          role text not null check (role in ('coordinator','plan-pm')),
          session_id text not null,
          plan_id text,
          epoch integer not null check (epoch > 0),
          revision integer not null check (revision > 0),
          state text not null check (state in ('active','suspended','revoked')),
          bound_at text not null,
          primary key (workflow_id, role, session_id),
          foreign key (workflow_id, plan_id) references execution_plans(workflow_id, plan_id),
          check ((role = 'coordinator' and plan_id is null) or (role = 'plan-pm' and plan_id is not null))
        );
        drop table execution_sessions;
        alter table execution_sessions_v8 rename to execution_sessions;
        create unique index execution_sessions_active_coordinator
          on execution_sessions(workflow_id) where role = 'coordinator' and state = 'active';
        create unique index execution_sessions_active_plan_pm
          on execution_sessions(workflow_id, plan_id) where role = 'plan-pm' and state = 'active';
        create table execution_leases(
          workflow_id text not null,
          plan_id text not null,
          revision integer not null check (revision > 0),
          owner_epoch integer not null check (owner_epoch > 0),
          lease_json text not null,
          primary key (workflow_id, plan_id),
          foreign key (workflow_id, plan_id) references execution_plans(workflow_id, plan_id)
        );
      `);
      initialized.db.prepare("update execution_meta set authority_state = 'active' where id = 1").run();
      // Historical FK order: workflow, registry/business row, then identities
      // and claims. Retirement is keyed by this actual workflow/session pair.
      initialized.db.prepare(
        "insert into execution_workflows(workflow_id, revision, state_json, created_at, updated_at) values (?, 1, ?, ?, ?)",
      ).run(workflowId, JSON.stringify(workflowState), "2026-10-04", "2026-10-04");
      initialized.db.prepare("insert into execution_registry(workflow_id, entry_json) values (?, ?)").run(
        workflowId,
        JSON.stringify({ id: workflowId, type: "plan", started_at: "2026-10-04", dir: `workflows/${workflowId}` }),
      );
      initialized.db.prepare(
        "insert into execution_plans(workflow_id, plan_id, revision, ordinal, state_json, coordination_json) values (?, ?, 1, 0, ?, ?)",
      ).run(workflowId, planId, JSON.stringify(businessPlan), JSON.stringify({
        revision: 1,
        prepared,
        session: { session_id: sessionId, session_file: join(root, "plan-pm.json"), bound_at: "2026-10-04T00:00:00Z" },
      }));
      initialized.db.prepare(
        "insert into execution_sessions(workflow_id, role, session_id, plan_id, epoch, revision, state, bound_at) " +
          "values (?, 'coordinator', 'host-coord', null, 1, 1, 'active', '2026-10-04T00:00:00Z')",
      ).run(workflowId);
      initialized.db.prepare(
        "insert into execution_sessions(workflow_id, role, session_id, plan_id, epoch, revision, state, bound_at) " +
          "values (?, 'plan-pm', ?, ?, 1, 1, 'suspended', '2026-10-04T00:00:00Z')",
      ).run(workflowId, sessionId, planId);
      initialized.db.prepare(
        "insert into execution_leases(workflow_id, plan_id, revision, owner_epoch, lease_json) values (?, ?, 1, 1, ?)",
      ).run(workflowId, planId, JSON.stringify({
        holder: sessionId, holder_session_id: sessionId, holder_role: "plan-pm",
        claimed_at: "2026-10-04T00:00:00Z",
        worktree_path: worktreePath, working_branch: workingBranch, status: "held",
      }));
      initialized.db.prepare(
        "insert into execution_integration_leases(workflow_id, revision, owner_epoch, lease_json) values (?, 1, 1, ?)",
      ).run(workflowId, JSON.stringify({
        holder: sessionId, plan_id: planId, claimed_at: "2026-10-04T00:30:00Z",
        source_branch: workingBranch, target_branch: "main", status: "held",
      }));
    } finally {
      initialized.close();
    }

    const before = await protectedStoreState(harness);
    expect(before.schemaVersion).toBe(8);
    const refused = await executeCommand("store.upgrade", { harness, operator: "fixture-operator" }, invocation(root));
    expect(refused).toMatchObject({ status: "refused", code: "store.upgrade-attestation-missing", exitCode: 1 });
    expect(await protectedStoreState(harness)).toEqual(before);

    // The same protected store also witnesses the public file-input boundary:
    // none of these caller mistakes may start the schema cutover.
    const malformedPath = join(root, "malformed-attestation.json");
    writeFileSync(malformedPath, "{");
    const malformedBytes = readFileSync(malformedPath);
    for (const attestation of ["attestation.json", join(root, "absent-attestation.json"), malformedPath]) {
      const invalid = await executeCommand("store.upgrade", {
        harness, operator: "fixture-operator", attestation,
      }, invocation(root));
      expect(invalid).toMatchObject({ status: "usage", code: "usage", exitCode: 2 });
      expect(await protectedStoreState(harness)).toEqual(before);
    }
    expect(readFileSync(malformedPath)).toEqual(malformedBytes);

    // Every invalid document reaches the real engine validator through the
    // store command's absolute-file transport; none may start the cutover.
    const validAttestation = {
      version: 1,
      attestedAt: "2026-10-04T04:00:00Z",
      operator: { actor: "fixture-operator", authorizationRef: "fixture-authorization" },
      consumers: [{
        entryId: "coordinator-cli", kind: "coordinator" as const,
        entrypoint: "packages/cli/src/index.ts", runtime: "node" as const, runtimeVersion: "24.18.0",
        version: "0.0.0-test", current: true, disposition: "reloaded" as const,
      }],
      stoppedSessions: [{ sessionId, host: "omp", state: "stopped" as const }],
    };
    const nonCoordinator = {
      ...validAttestation,
      consumers: [{ ...validAttestation.consumers[0]!, kind: "cli" as const }],
    };
    const multipleCurrent = {
      ...validAttestation,
      consumers: [
        ...validAttestation.consumers,
        { ...validAttestation.consumers[0]!, entryId: "second-current" },
      ],
    };
    const credentialMarker = "synthetic-secret-marker-do-not-disclose-9f3b";
    const invalidDocuments: unknown[] = [
      { ...validAttestation, operator: { ...validAttestation.operator, actor: "   " } },
      { ...validAttestation, attestedAt: "not-an-instant" },
      { ...validAttestation, consumers: [{ ...validAttestation.consumers[0]!, runtimeVersion: "24.17.9" }] },
      { ...validAttestation, consumers: [{ ...validAttestation.consumers[0]!, current: false }] },
      multipleCurrent,
      nonCoordinator,
      { ...validAttestation, sessionCredential: credentialMarker },
      { ...validAttestation, consumers: [{ ...validAttestation.consumers[0]!, sessionCredential: credentialMarker }] },
    ];
    const attestationPath = join(root, "attestation.json");
    for (const invalidDocument of invalidDocuments) {
      writeFileSync(attestationPath, JSON.stringify(invalidDocument));
      const invalid = await executeCommand("store.upgrade", {
        harness, operator: "fixture-operator", attestation: attestationPath,
      }, invocation(root));
      expect(invalid.status).toBe("refused");
      expect(JSON.stringify(invalid)).not.toContain(credentialMarker);
      expect(await protectedStoreState(harness)).toEqual(before);
    }
    // The same actual consumer accepts the corrected proof after all failures.
    writeFileSync(attestationPath, JSON.stringify(validAttestation));
    const attestationBytes = readFileSync(attestationPath);
    const result = await executeCommand("store.upgrade", {
      harness, operator: "fixture-operator", attestation: attestationPath,
    }, invocation(root));
    expect(result.status, result.status !== "ok" ? JSON.stringify(result) : "").toBe("ok");
    expect(readFileSync(attestationPath)).toEqual(attestationBytes);

    const store = await openStore({ harnessDir: harness }, "read");
    try {
      expect(store.schemaVersion).toBe(9);
      expect(store.db.prepare("select name from sqlite_schema where type = 'table' and name = 'execution_leases'").get()).toBeUndefined();
      expect(store.db.prepare("select * from execution_sessions where workflow_id = ? and session_id = ?").get(workflowId, sessionId)).toBeUndefined();
      expect(store.db.prepare("select * from execution_sessions where workflow_id = ?").all(workflowId)).toEqual([{
        workflow_id: workflowId, role: "coordinator", session_id: "host-coord",
        epoch: 1, revision: 1, state: "active", bound_at: "2026-10-04T00:00:00Z",
      }]);
      const plan = z.object({ revision: z.number(), state_json: z.string(), coordination_json: z.string() }).parse(
        store.db.prepare(
          "select revision, state_json, coordination_json from execution_plans where workflow_id = ? and plan_id = ?",
        ).get(workflowId, planId),
      );
      expect(plan.revision).toBe(1);
      expect(JSON.parse(plan.state_json)).toEqual({
        ...businessPlan, metadata: { worktree_path: worktreePath, working_branch: workingBranch },
      });
      expect(JSON.parse(plan.coordination_json)).toEqual({ prepared });
      const workflow = z.object({ state_json: z.string() }).parse(
        store.db.prepare("select state_json from execution_workflows where workflow_id = ?").get(workflowId),
      );
      expect(JSON.parse(workflow.state_json)).toEqual(workflowState);
      expect(store.db.prepare("select * from execution_registry where workflow_id = ?").get(workflowId))
        .toEqual(before.tables.execution_registry[0]);
      const claim = z.object({ revision: z.number(), owner_epoch: z.number(), lease_json: z.string() }).parse(
        store.db.prepare(
          "select revision, owner_epoch, lease_json from execution_integration_leases where workflow_id = ?",
        ).get(workflowId),
      );
      expect(claim.revision).toBe(2);
      expect(claim.owner_epoch).toBe(1);
      expect(JSON.parse(claim.lease_json)).toEqual({
        holder: sessionId, plan_id: planId, claimed_at: "2026-10-04T00:30:00Z",
        source_branch: workingBranch, target_branch: "main", status: "released",
        prior_holder: sessionId, released_by: "store-upgrade",
        released_at: "2026-10-04T04:00:00Z", release_reason: `retired-plan-pm-seat:${sessionId}`,
      });
      for (const table of ["execution_lease_cutover", "execution_session_cutover", "execution_integration_cutover"]) {
        expect(store.db.prepare("select name from sqlite_schema where type = 'table' and name = ?").get(table)).toBeUndefined();
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
