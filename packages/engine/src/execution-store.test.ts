/**
 * execution-store.test.ts — proof for migration 4 (`execution-authority`,
 * primary spec §2.2) and for the issue/catalog-versus-execution mode
 * separation.
 *
 * Run with
 * `bun test packages/engine/src/execution-store.test.ts --test-name-pattern 'execution-schema'`
 * (C1 schema) or `--test-name-pattern 'execution-tokens|execution-initialize'`
 * (C2 canonical tokens, transaction ownership, empty initialization).
 *
 * Every fixture lives in its own temporary control root created by
 * `mkdtempSync`; no test reads or writes this checkout's `store.db`. The
 * pre-migration-4 stores are built from the real migrations 1–3 SQL with the
 * checksums such a store actually carries, so a mutated applied migration
 * makes the upgrade refuse exactly as it would in a real workspace.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ExecutionError,
  assertExecutionToken,
  executionToken,
  initializeExecutionAuthority,
  parseExecutionToken,
  readExecutionState,
  serializeExecutionValue,
  withExecutionTransaction,
} from "./execution-store.js";
import {
  MIGRATIONS,
  SCHEMA_VERSION_TABLE_SQL,
  StoreError,
  initializeStore,
  migrationChecksum,
  openStore,
  upgradeStore,
  type StoreContext,
  type StoreDb,
} from "./store-db.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-execution-store-"));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const TS = "2026-01-02T03:04:05.000Z";

/**
 * Checksums recorded by stores written before migration 4 (BASE_SHA
 * `22ce47cb`, the v4 phase-1 cutover). These literal rows are what an existing
 * workspace has on disk; migrations 1–3 must keep matching them.
 */
const FROZEN_V3_CHECKSUMS: Record<number, string> = {
  1: "bea7e69deecdfc06fb76d4af675470ea02f0c9dbc4de36c8d12c7fa2fa14dff2",
  2: "88b79b6848dc6b72aeefb364e64b0e1ddf6614b821b726951263997e96dd427a",
  3: "2bd2e90874e0bf81b63957394935bf98dd651a689b081284b7852913980c5f37",
};

/** §2.2 column sets in declaration order — literals, never read back from the implementation. */
const EXECUTION_COLUMNS: Record<string, string[]> = {
  execution_meta: [
    "id",
    "protocol_version",
    "authority_state",
    "revision",
    "root_updated_at",
    "manifest_id",
    "activated_at",
  ],
  execution_workflows: ["workflow_id", "revision", "creator_session_id", "state_json", "created_at", "updated_at"],
  execution_registry: ["workflow_id", "entry_json"],
  execution_plans: ["workflow_id", "plan_id", "revision", "ordinal", "state_json", "coordination_json"],
  execution_sessions: ["workflow_id", "role", "session_id", "plan_id", "epoch", "revision", "state", "bound_at"],
  execution_leases: ["workflow_id", "plan_id", "revision", "owner_epoch", "lease_json"],
  execution_integration_leases: ["workflow_id", "revision", "owner_epoch", "lease_json"],
  execution_inputs: ["workflow_id", "plan_id", "revision", "input_json", "input_hash", "catalog_pin_json"],
  execution_operations: [
    "epoch",
    "operation_id",
    "request_hash",
    "store_id",
    "workflow_id",
    "plan_id",
    "result_json",
    "committed_at",
  ],
  execution_migrations: [
    "manifest_id",
    "manifest_hash",
    "phase",
    "manifest_json",
    "activation_receipt_json",
    "retirement_json",
    "created_at",
    "updated_at",
  ],
};

const EXECUTION_TABLES = Object.keys(EXECUTION_COLUMNS);

const EXECUTION_PRIMARY_KEYS: Record<string, string[]> = {
  execution_meta: ["id"],
  execution_workflows: ["workflow_id"],
  execution_registry: ["workflow_id"],
  execution_plans: ["workflow_id", "plan_id"],
  execution_sessions: ["workflow_id", "role", "session_id"],
  execution_leases: ["workflow_id", "plan_id"],
  execution_integration_leases: ["workflow_id"],
  execution_inputs: ["workflow_id", "plan_id"],
  execution_operations: ["epoch", "operation_id"],
  execution_migrations: ["manifest_id"],
};

/** Normalized `childCols->parentTable.parentCols`, one entry per declared foreign key. */
const EXECUTION_FOREIGN_KEYS: Record<string, string[]> = {
  execution_meta: [],
  execution_workflows: [],
  execution_registry: ["workflow_id->execution_workflows.workflow_id"],
  execution_plans: ["workflow_id->execution_workflows.workflow_id"],
  execution_sessions: [
    "workflow_id->execution_workflows.workflow_id",
    "workflow_id+plan_id->execution_plans.workflow_id+plan_id",
  ],
  execution_leases: ["workflow_id+plan_id->execution_plans.workflow_id+plan_id"],
  execution_integration_leases: ["workflow_id->execution_workflows.workflow_id"],
  execution_inputs: ["workflow_id+plan_id->execution_plans.workflow_id+plan_id"],
  execution_operations: [],
  execution_migrations: [],
};

/** Fields a copied projection would have carried; the execution schema owns none of them. */
const PROJECTION_ONLY_COLUMNS = ["progress", "done_at", "catalog_pin_revision", "holder", "expires_at"];

type Row = Record<string, unknown>;

function all(db: StoreDb, sql: string): Row[] {
  return db.prepare(sql).all() as Row[];
}

function one(db: StoreDb, sql: string): Row {
  const [first] = all(db, sql);
  if (!first) throw new Error(`expected one row from: ${sql}`);
  return first;
}

function scalar(db: StoreDb, sql: string): unknown {
  return Object.values(one(db, sql))[0];
}

/** Raw connection for fixtures and post-failure inspection (no store pragmas). */
function rawDb(path: string): StoreDb {
  return new DatabaseSync(path) as unknown as StoreDb;
}

function controlRoot(label: string): StoreContext {
  return { harnessDir: mkdtempSync(join(ROOT, `${label}-`)) };
}

function storePath(context: StoreContext): string {
  return join(context.harnessDir, "store.db");
}

/**
 * Write a real pre-migration-4 store: migrations 1–3 applied with the exact
 * checksums such a store carries, plus representative issue/catalog records
 * and a live issue/catalog authority state. `rogueTable` simulates a store
 * object that collides with migration 4.
 */
function createV3Store(context: StoreContext, options: { rogueTable?: string } = {}): void {
  const db = new DatabaseSync(storePath(context));
  try {
    db.exec("pragma foreign_keys=ON");
    db.exec(SCHEMA_VERSION_TABLE_SQL);
    db.exec("begin immediate");
    for (const migration of MIGRATIONS.slice(0, 3)) db.exec(migration.sql);
    const record = db.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)");
    for (const migration of MIGRATIONS.slice(0, 3)) {
      record.run(migration.version, migration.name, FROZEN_V3_CHECKSUMS[migration.version], TS);
    }
    db.exec(`
update store_meta set authority_state = 'active', activated_at = '${TS}', revision = 7, catalog_revision = 3 where id = 1;
insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, identity_key, revision)
values ('iss-1','proj-1','Store survives the upgrade','bug','high','open','Users lose data','Rows stay readable','${TS}','${TS}','key-iss-1',4);
insert into occurrences(issue_id, occurrence_key, source_kind, source_identity, root_cause_key, acceptance_key, location, observed_behavior, evidence_json, recorded_at)
values ('iss-1','occ-1','suite','store-db.test.ts','rc-1','ac-1','store-db.ts:1','row vanished','{"stdout":"x"}','${TS}');
insert into catalog_entities(kind,id,title,root_kind,relative_path,revision,registered_at,updated_at)
values ('project','proj-1','Project','projects','projects/proj-1/roadmap.md',2,'${TS}','${TS}');
insert into catalog_entities(kind,id,title,root_kind,relative_path,document_kind,revision,registered_at,updated_at)
values ('document','doc-1','Spec','iterations','iterations/it-1/specs/spec.md','spec',3,'${TS}','${TS}');
insert into catalog_entities(kind,id,title,root_kind,relative_path,revision,registered_at,updated_at)
values ('plan','plan-1','Plan','plans','plans/plan-1.md',5,'${TS}','${TS}');
insert into catalog_links(from_kind,from_id,relation,to_kind,to_id) values ('plan','plan-1','belongs-to','project','proj-1');
insert into catalog_links(from_kind,from_id,relation,to_kind,to_id) values ('document','doc-1','belongs-to','project','proj-1');
insert into catalog_execution_bindings(workflow_id,catalog_kind,catalog_id,workflow_root_kind,workflow_relative_path,catalog_revision,input_hash,pin_json,operation_id)
values ('wf-legacy','plan','plan-1','plans','plans/plan-1.md',5,'input-hash-1','{"store_id":"store-1"}','op-bind-1');
insert into store_operations(operation_id,request_hash,result_json,committed_at) values ('op-1','req-hash-1','{"ok":true}','${TS}');
`);
    if (options.rogueTable) db.exec(`create table ${options.rogueTable}(payload text)`);
    db.exec("commit");
  } catch (error) {
    try {
      db.exec("rollback");
    } catch {
      // nothing committed either way
    }
    throw error;
  } finally {
    db.close();
  }
}

/** Fresh store at the compiled head with an empty execution domain. */
async function freshStore(label: string): Promise<{ context: StoreContext; epoch: number }> {
  const context = controlRoot(label);
  const handle = await initializeStore(context);
  try {
    return { context, epoch: handle.epoch };
  } finally {
    handle.close();
  }
}

/** One workflow with two plans; the sessions below are added per scenario. */
function seedExecutionGraph(db: StoreDb): void {
  db.prepare(
    "insert into execution_workflows(workflow_id, revision, creator_session_id, state_json, created_at, updated_at) " +
      "values ('wf-1', 1, 'host-1', '{\"id\":\"wf-1\"}', ?, ?)",
  ).run(TS, TS);
  const plan = db.prepare(
    "insert into execution_plans(workflow_id, plan_id, revision, ordinal, state_json, coordination_json) " +
      "values (?, ?, 1, ?, '{}', '{}')",
  );
  plan.run("wf-1", "p-1", 0);
  plan.run("wf-1", "p-2", 1);
}

function session(
  db: StoreDb,
  input: { sessionId: string; role: "coordinator" | "plan-pm"; planId: string | null; state?: string; epoch: number },
): void {
  db.prepare(
    "insert into execution_sessions(workflow_id, role, session_id, plan_id, epoch, revision, state, bound_at) " +
      "values ('wf-1', ?, ?, ?, ?, 1, ?, ?)",
  ).run(input.role, input.sessionId, input.planId, input.epoch, input.state ?? "active", TS);
}

/** Composite foreign keys collapse into one entry per declared constraint. */
function foreignKeys(db: StoreDb, table: string): string[] {
  const rows = all(db, `pragma foreign_key_list(${table})`) as Array<{
    id: unknown;
    seq: unknown;
    table: unknown;
    from: unknown;
    to: unknown;
  }>;
  const groups: Record<string, { table: string; columns: Array<{ seq: number; from: string; to: string }> }> = {};
  for (const row of rows) {
    const group = (groups[String(row.id)] ??= { table: String(row.table), columns: [] });
    group.columns.push({ seq: Number(row.seq), from: String(row.from), to: String(row.to) });
  }
  return Object.values(groups)
    .map((group) => {
      const ordered = [...group.columns].sort((a, b) => a.seq - b.seq);
      return `${ordered.map((column) => column.from).join("+")}->${group.table}.${ordered
        .map((column) => column.to)
        .join("+")}`;
    })
    .sort();
}

describe("execution-schema: migration 4 (execution-authority)", () => {
  describe("migration identity", () => {
    test("keeps the applied v1–v3 checksums and appends execution-authority as version 4", () => {
      for (const version of [1, 2, 3]) {
        expect(migrationChecksum(MIGRATIONS[version - 1])).toBe(FROZEN_V3_CHECKSUMS[version]);
      }
      expect(MIGRATIONS[3].version).toBe(4);
      expect(MIGRATIONS[3].name).toBe("execution-authority");
      expect(MIGRATIONS.length).toBe(4);
    });
  });

  describe("upgrade of an existing store", () => {
    test("retains issue/catalog records and yields legacy execution authority", async () => {
      const context = controlRoot("upgrade-retention");
      createV3Store(context);
      const before = rawDb(storePath(context));
      const storeIdBefore = String(scalar(before, "select store_id from store_meta where id = 1"));
      expect(scalar(before, "select max(version) as v from schema_version")).toBe(3);
      before.close();

      const upgraded = await upgradeStore(context);
      expect(upgraded.schemaVersion).toBe(MIGRATIONS.length);

      const handle = await openStore(context, "read");
      try {
        const db = handle.db;
        // The upgraded store reads as legacy execution authority.
        expect(handle.execution).toEqual({
          protocolVersion: 1,
          authorityState: "legacy",
          revision: 1,
          rootUpdatedAt: expect.any(String),
          manifestId: null,
          activatedAt: null,
        });
        expect(handle.execution?.rootUpdatedAt ?? "").toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        // Issue/catalog authority is a separate namespace and is left alone.
        expect(handle.storeId).toBe(storeIdBefore);
        expect(
          one(db, "select authority_state, authority_epoch, revision, catalog_revision from store_meta where id = 1"),
        ).toEqual({ authority_state: "active", authority_epoch: 1, revision: 7, catalog_revision: 3 });
        // Issue/catalog records survive the upgrade.
        expect(one(db, "select id, title, severity, disposition, revision, identity_key from issues")).toEqual({
          id: "iss-1",
          title: "Store survives the upgrade",
          severity: "high",
          disposition: "open",
          revision: 4,
          identity_key: "key-iss-1",
        });
        expect(scalar(db, "select count(*) as n from occurrences")).toBe(1);
        expect(all(db, "select kind, id, revision from catalog_entities order by kind, id")).toEqual([
          { kind: "document", id: "doc-1", revision: 3 },
          { kind: "plan", id: "plan-1", revision: 5 },
          { kind: "project", id: "proj-1", revision: 2 },
        ]);
        expect(scalar(db, "select count(*) as n from catalog_links")).toBe(2);
        expect(one(db, "select workflow_id, catalog_revision, input_hash from catalog_execution_bindings")).toEqual({
          workflow_id: "wf-legacy",
          catalog_revision: 5,
          input_hash: "input-hash-1",
        });
        expect(one(db, "select operation_id, request_hash from store_operations")).toEqual({
          operation_id: "op-1",
          request_hash: "req-hash-1",
        });
        // The applied rows 1–3 keep their checksums; migration 4 is appended.
        expect(all(db, "select version, name, checksum from schema_version order by version")).toEqual([
          { version: 1, name: "issue-core", checksum: FROZEN_V3_CHECKSUMS[1] },
          { version: 2, name: "catalog-authority", checksum: FROZEN_V3_CHECKSUMS[2] },
          { version: 3, name: "execution-projections", checksum: FROZEN_V3_CHECKSUMS[3] },
          { version: 4, name: "execution-authority", checksum: migrationChecksum(MIGRATIONS[3]) },
        ]);
        expect(all(db, "pragma foreign_key_check")).toEqual([]);
        expect(one(db, "pragma integrity_check")).toEqual({ integrity_check: "ok" });
      } finally {
        handle.close();
      }
    });

    test("leaves every execution table empty except the legacy singleton", async () => {
      const context = controlRoot("upgrade-empty");
      createV3Store(context);
      await upgradeStore(context);

      const handle = await openStore(context, "read");
      try {
        for (const table of EXECUTION_TABLES) {
          expect(scalar(handle.db, `select count(*) as n from ${table}`), table).toBe(
            table === "execution_meta" ? 1 : 0,
          );
        }
        expect(
          one(handle.db, "select protocol_version, authority_state, revision, manifest_id, activated_at from execution_meta"),
        ).toEqual({ protocol_version: 1, authority_state: "legacy", revision: 1, manifest_id: null, activated_at: null });
      } finally {
        handle.close();
      }
    });

    test("creates the exact §2.2 tables, keys and foreign keys with no projection columns", async () => {
      const context = controlRoot("upgrade-shape");
      createV3Store(context);
      await upgradeStore(context);

      const handle = await openStore(context, "read");
      try {
        const db = handle.db;
        for (const table of EXECUTION_TABLES) {
          const columns = all(db, `pragma table_info(${table})`) as Array<{ name: unknown; pk: unknown }>;
          expect(columns.map((column) => String(column.name)), table).toEqual(EXECUTION_COLUMNS[table]);
          const primaryKey = columns
            .filter((column) => Number(column.pk) > 0)
            .sort((a, b) => Number(a.pk) - Number(b.pk))
            .map((column) => String(column.name));
          expect(primaryKey, table).toEqual(EXECUTION_PRIMARY_KEYS[table]);
          expect(foreignKeys(db, table), table).toEqual([...EXECUTION_FOREIGN_KEYS[table]].sort());
          for (const column of EXECUTION_COLUMNS[table]) {
            expect(PROJECTION_ONLY_COLUMNS, `${table}.${column}`).not.toContain(column);
          }
        }

        // Active ownership is enforced by partial unique indexes, so a
        // released or revoked owner does not consume the only slot.
        const sessionIndexes = all(db, "pragma index_list(execution_sessions)") as Array<{
          name: unknown;
          unique: unknown;
          partial: unknown;
        }>;
        expect(
          sessionIndexes
            .filter((index) => Number(index.unique) === 1 && Number(index.partial) === 1)
            .map((index) => String(index.name))
            .sort(),
        ).toEqual(["execution_sessions_active_coordinator", "execution_sessions_active_plan_pm"]);
      } finally {
        handle.close();
      }
    });
  });

  describe("mode separation", () => {
    test("a read-intent open applies no migration and reports no execution authority", async () => {
      const context = controlRoot("no-implicit-migration");
      createV3Store(context);

      const reader = await openStore(context, "read");
      try {
        expect(reader.schemaVersion).toBe(3);
        expect(reader.execution).toBeNull();
      } finally {
        reader.close();
      }
      const writer = await openStore(context, "write");
      try {
        expect(writer.schemaVersion).toBe(3);
        expect(writer.execution).toBeNull();
      } finally {
        writer.close();
      }

      const after = rawDb(storePath(context));
      try {
        expect(scalar(after, "select max(version) as v from schema_version")).toBe(3);
        expect(all(after, "select name from sqlite_master where name = 'execution_meta'")).toEqual([]);
        expect(scalar(after, "select count(*) as n from issues")).toBe(1);
      } finally {
        after.close();
      }
    });

    test("a fresh store is issue/catalog active while execution stays legacy", async () => {
      const context = controlRoot("fresh-mode");
      const handle = await initializeStore(context);
      try {
        expect(handle.execution?.authorityState).toBe("legacy");
        expect(scalar(handle.db, "select authority_state from store_meta where id = 1")).toBe("active");
        for (const table of EXECUTION_TABLES) {
          expect(scalar(handle.db, `select count(*) as n from ${table}`), table).toBe(
            table === "execution_meta" ? 1 : 0,
          );
        }
      } finally {
        handle.close();
      }
    });

    test("execution tables without the recorded migration grant no execution authority", async () => {
      const context = controlRoot("stray-execution-tables");
      createV3Store(context, { rogueTable: "execution_operations" });

      const handle = await openStore(context, "read");
      try {
        // The recorded migration history decides: without migration 4 this
        // store has no execution authority, whatever tables it carries.
        expect(handle.schemaVersion).toBe(3);
        expect(handle.execution).toBeNull();
      } finally {
        handle.close();
      }
    });

    test("a recorded execution migration with an incomplete schema is refused as drift", async () => {
      const context = controlRoot("incomplete-execution-schema");
      createV3Store(context);
      await upgradeStore(context);
      const raw = rawDb(storePath(context));
      try {
        raw.exec("drop table execution_inputs");
      } finally {
        raw.close();
      }

      await expect(openStore(context, "read")).rejects.toThrow(/store\.schema-drift/);
      await expect(upgradeStore(context)).rejects.toThrow(/store\.schema-drift/);
    });
  });

  describe("schema refusals", () => {
    test("refuses a second active owner while accepting non-active owners", async () => {
      const { context, epoch } = await freshStore("refuse-duplicate-active");
      const handle = await openStore(context, "write");
      try {
        seedExecutionGraph(handle.db);
        session(handle.db, { sessionId: "s-1", role: "coordinator", planId: null, epoch });
        session(handle.db, { sessionId: "s-5", role: "plan-pm", planId: "p-1", epoch });
        session(handle.db, { sessionId: "s-7", role: "plan-pm", planId: "p-2", epoch });

        // A second ACTIVE coordinator for the workflow, and a second ACTIVE
        // plan-pm on the same plan, are refused.
        expect(() => session(handle.db, { sessionId: "s-2", role: "coordinator", planId: null, epoch })).toThrow();
        expect(() => session(handle.db, { sessionId: "s-6", role: "plan-pm", planId: "p-1", epoch })).toThrow();
        // The uniqueness is on ACTIVE ownership: the same identity may be
        // recorded once it is no longer active.
        session(handle.db, { sessionId: "s-6", role: "plan-pm", planId: "p-1", state: "suspended", epoch });
        // Identity is the row key, so one plan-pm identity cannot silently
        // move between plans while its record exists.
        expect(() =>
          session(handle.db, { sessionId: "s-7", role: "plan-pm", planId: "p-1", state: "suspended", epoch }),
        ).toThrow();
      } finally {
        handle.close();
      }
    });

    test("refuses a dangling lease, input, plan or registry entry", async () => {
      const { context, epoch } = await freshStore("refuse-dangling");
      const handle = await openStore(context, "write");
      try {
        seedExecutionGraph(handle.db);
        const lease = handle.db.prepare(
          "insert into execution_leases(workflow_id, plan_id, revision, owner_epoch, lease_json) values (?, ?, 1, ?, '{}')",
        );
        expect(() => lease.run("wf-1", "p-missing", epoch)).toThrow();
        expect(() => lease.run("wf-missing", "p-1", epoch)).toThrow();
        expect(() => lease.run("wf-1", "p-1", epoch)).not.toThrow();

        const input = handle.db.prepare(
          "insert into execution_inputs(workflow_id, plan_id, revision, input_json, input_hash, catalog_pin_json) " +
            "values (?, ?, 1, '{}', 'hash', null)",
        );
        expect(() => input.run("wf-1", "p-missing")).toThrow();
        expect(() => input.run("wf-1", "p-2")).not.toThrow();

        const integrationLease = handle.db.prepare(
          "insert into execution_integration_leases(workflow_id, revision, owner_epoch, lease_json) values (?, 1, ?, '{}')",
        );
        expect(() => integrationLease.run("wf-missing", epoch)).toThrow();
        expect(() => integrationLease.run("wf-1", epoch)).not.toThrow();

        const plan = handle.db.prepare(
          "insert into execution_plans(workflow_id, plan_id, revision, ordinal, state_json, coordination_json) " +
            "values (?, ?, 1, ?, '{}', '{}')",
        );
        expect(() => plan.run("wf-missing", "p-9", 9)).toThrow();
        expect(() => plan.run("wf-1", "p-3", 0)).toThrow(); // ordinal is unique per workflow
        expect(() => plan.run("wf-1", "p-3", 2)).not.toThrow();

        const registry = handle.db.prepare("insert into execution_registry(workflow_id, entry_json) values (?, '{}')");
        expect(() => registry.run("wf-missing")).toThrow();
        expect(() => registry.run("wf-1")).not.toThrow();
      } finally {
        handle.close();
      }
    });

    test("refuses malformed ownership values and the singleton row", async () => {
      const { context, epoch } = await freshStore("refuse-values");
      const handle = await openStore(context, "write");
      try {
        seedExecutionGraph(handle.db);
        // plan_id is null exactly for a coordinator.
        expect(() => session(handle.db, { sessionId: "s-1", role: "coordinator", planId: "p-1", epoch })).toThrow();
        expect(() => session(handle.db, { sessionId: "s-1", role: "plan-pm", planId: null, epoch })).toThrow();
        // Epoch 0 is not a usable authority fence, and the role set is closed.
        expect(() => session(handle.db, { sessionId: "s-1", role: "coordinator", planId: null, epoch: 0 })).toThrow();
        expect(() =>
          handle.db
            .prepare(
              "insert into execution_sessions(workflow_id, role, session_id, plan_id, epoch, revision, state, bound_at) " +
                "values ('wf-1','keeper','s-1',null,?,1,'active',?)",
            )
            .run(epoch, TS),
        ).toThrow();
        // execution_meta is a singleton with a closed authority-state set.
        expect(() =>
          handle.db
            .prepare(
              "insert into execution_meta(id, protocol_version, authority_state, revision, root_updated_at) " +
                "values (2, 1, 'legacy', 1, ?)",
            )
            .run(TS),
        ).toThrow();
        expect(() => handle.db.prepare("update execution_meta set authority_state = 'active-ish' where id = 1").run()).toThrow();
        expect(() => handle.db.prepare("update execution_meta set protocol_version = 2 where id = 1").run()).toThrow();
        // Migration provenance uses the closed phase set.
        expect(() =>
          handle.db
            .prepare(
              "insert into execution_migrations(manifest_id, manifest_hash, phase, manifest_json, created_at, updated_at) " +
                "values ('m-1', 'manifest-hash', 'half', ?, ?, ?)",
            )
            .run("{}", TS, TS),
        ).toThrow();
      } finally {
        handle.close();
      }
    });
  });

  describe("failure atomicity", () => {
    test("a failed migration leaves the original schema and data intact", async () => {
      const context = controlRoot("failed-migration");
      createV3Store(context, { rogueTable: "execution_operations" });

      const failure = await upgradeStore(context).then(
        () => {
          throw new Error("expected the migration batch to fail");
        },
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(StoreError);
      expect((failure as StoreError).code).toBe("store.corrupt");
      expect((failure as Error).message).toContain("rolled back");

      const after = rawDb(storePath(context));
      try {
        expect(scalar(after, "select max(version) as v from schema_version")).toBe(3);
        // Migration 4 created eight tables before it reached the collision;
        // the rollback removed every one of them, leaving only the store
        // object that was already there.
        expect(
          all(after, `select name from sqlite_master where type = 'table' and name like 'execution\\_%' escape '\\'`),
        ).toEqual([{ name: "execution_operations" }]);
        expect(scalar(after, "select count(*) as n from issues")).toBe(1);
        expect(one(after, "select authority_state, revision, catalog_revision from store_meta where id = 1")).toEqual({
          authority_state: "active",
          revision: 7,
          catalog_revision: 3,
        });
      } finally {
        after.close();
      }
    });
  });
});

/* ------------------------------------------------------------------------ *
 * C2 — canonical value form and tokens (§3.1)
 * ------------------------------------------------------------------------ */

/** Syntactically valid store identities for the token-grammar cases. */
const TOKEN_STORE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER_STORE = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";

/** `key64` of an arbitrary JSON text — the adversarial encoder for key cases. */
function key64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

describe("execution-tokens: §3.1 canonical value form and version tokens", () => {
  test("sorts object keys by code unit regardless of insertion and keeps array order", () => {
    const inserted = serializeExecutionValue({ b: 1, a: { d: [3, 1, 2], c: null }, "": true });
    expect(inserted).toBe(serializeExecutionValue({ "": true, a: { c: null, d: [3, 1, 2] }, b: 1 }));
    expect(inserted).toBe('{"":true,"a":{"c":null,"d":[3,1,2]},"b":1}\n');
    // Code-unit order, never a locale collation.
    expect(serializeExecutionValue({ ä: 1, Z: 2, a: 3 })).toBe('{"Z":2,"a":3,"ä":1}\n');
    // Array order is content, not a set.
    expect(serializeExecutionValue([2, 1])).toBe("[2,1]\n");
    expect(serializeExecutionValue([2, 1])).not.toBe(serializeExecutionValue([1, 2]));
    // No whitespace beyond the single terminal LF.
    expect(serializeExecutionValue({ a: [1, { b: 2 }] })).toBe('{"a":[1,{"b":2}]}\n');
    // Sharing a reference is not a cycle; a null-prototype object is still plain JSON.
    const shared = { a: 1 };
    expect(serializeExecutionValue([shared, shared])).toBe('[{"a":1},{"a":1}]\n');
    expect(serializeExecutionValue(Object.assign(Object.create(null), { a: 1 }))).toBe('{"a":1}\n');
  });

  test("refuses values that are not plain, finite, acyclic JSON", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const refused: Array<[unknown, string]> = [
      [undefined, "undefined"],
      [NaN, "NaN"],
      [Infinity, "Infinity"],
      [-Infinity, "-Infinity"],
      [Number.MAX_SAFE_INTEGER + 1, "unsafe integer"],
      [1n, "bigint"],
      [Symbol("s"), "symbol"],
      [() => 1, "function"],
      [new Date(0), "foreign prototype"],
      [new Map(), "Map"],
      [Object.create({ inherited: 1 }), "inherited prototype"],
      [{ nested: undefined }, "undefined property"],
      [[1, undefined], "undefined element"],
      [[1, , 3], "array hole"],
      [cyclic, "cycle"],
      ["\uD800", "unpaired high surrogate"],
      ["\uDC00", "unpaired low surrogate"],
    ];
    for (const [value, label] of refused) {
      expect(() => serializeExecutionValue(value), label).toThrow(/execution\.canonical-value/);
    }
    // A well-formed surrogate pair and the largest safe integer are canonical.
    expect(serializeExecutionValue({ emoji: "\uD83D\uDE00", n: Number.MAX_SAFE_INTEGER })).toBe(
      '{"emoji":"😀","n":9007199254740991}\n',
    );
  });

  test("composes and parses the exact exec-v1 wire format", () => {
    const root = executionToken("root", TOKEN_STORE, 3, [], 2);
    expect(root).toBe(`exec-v1:root:${TOKEN_STORE}:3:W10K:2`);
    expect(parseExecutionToken(root)).toEqual({ kind: "root", storeId: TOKEN_STORE, epoch: 3, key: [], revision: 2 });
    // key64 is the canonical form of the key array: unpadded base64url over
    // `serializeExecutionValue`, terminal LF included.
    const plan = executionToken("plan", TOKEN_STORE, 7, ["wf-1", "p-1"], 4);
    expect(plan.split(":")[4]).toBe(key64('["wf-1","p-1"]\n'));
    expect(parseExecutionToken(plan).key).toEqual(["wf-1", "p-1"]);
    expect(parseExecutionToken(executionToken("session", TOKEN_STORE, 7, ["wf-1", "plan-pm", "s-1"], 1)).key).toEqual([
      "wf-1",
      "plan-pm",
      "s-1",
    ]);
    expect(
      assertExecutionToken(plan, { kind: "plan", storeId: TOKEN_STORE, epoch: 7, key: ["wf-1", "p-1"], revision: 4 }),
    ).toEqual(parseExecutionToken(plan));
  });

  test("refuses malformed and noncanonical tokens", () => {
    const malformed: Array<[string, string]> = [
      ["", "empty"],
      [`exec-v1:root:${TOKEN_STORE}:1:W10K`, "five parts"],
      [`exec-v1:root:${TOKEN_STORE}:1:W10K:1:extra`, "seven parts"],
      [`exec-v2:root:${TOKEN_STORE}:1:W10K:1`, "prefix"],
      [`exec-v1:keeper:${TOKEN_STORE}:1:W10K:1`, "unknown kind"],
      [`exec-v1:root:not-a-uuid:1:W10K:1`, "store identity"],
      [`exec-v1:root:${TOKEN_STORE.toUpperCase()}:1:W10K:1`, "uppercase store identity"],
      [`exec-v1:root:${TOKEN_STORE}:01:W10K:1`, "leading-zero epoch"],
      [`exec-v1:root:${TOKEN_STORE}:0:W10K:1`, "zero epoch"],
      [`exec-v1:root:${TOKEN_STORE}:-1:W10K:1`, "signed epoch"],
      [`exec-v1:root:${TOKEN_STORE}:1.0:W10K:1`, "fractional epoch"],
      [`exec-v1:root:${TOKEN_STORE}: 1:W10K:1`, "whitespace epoch"],
      [`exec-v1:root:${TOKEN_STORE}:1:W10K:9007199254740992`, "unsafe revision"],
      [`exec-v1:root:${TOKEN_STORE}:1:W10K=:1`, "padded base64"],
      [`exec-v1:root:${TOKEN_STORE}:1:W10:1`, "noncanonical key encoding"],
      [`exec-v1:root:${TOKEN_STORE}:1:${key64("[]")}:1`, "key without the canonical LF"],
      [`exec-v1:workflow:${TOKEN_STORE}:1:${key64("[]\n")}:1`, "key arity below the kind"],
      [`exec-v1:workflow:${TOKEN_STORE}:1:${key64('["wf-1","p-1"]\n')}:1`, "key arity above the kind"],
      [`exec-v1:workflow:${TOKEN_STORE}:1:${key64('[ "wf-1" ]\n')}:1`, "whitespace inside the key JSON"],
      [`exec-v1:workflow:${TOKEN_STORE}:1:${key64("[1]\n")}:1`, "non-string key part"],
      [`exec-v1:workflow:${TOKEN_STORE}:1:${key64('"wf-1"\n')}:1`, "key is not an array"],
      [`exec-v1:workflow:${TOKEN_STORE}:1:${key64('[""]\n')}:1`, "empty key part"],
      [`exec-v1:session:${TOKEN_STORE}:1:${key64('["wf-1","keeper","s-1"]\n')}:1`, "unknown session role"],
    ];
    for (const [token, label] of malformed) {
      expect(() => parseExecutionToken(token), label).toThrow(/execution\.token-invalid/);
      expect(() => assertExecutionToken(token, { kind: "root", storeId: TOKEN_STORE, epoch: 1, key: [] }), label).toThrow(
        /execution\.token-invalid/,
      );
    }
    // Creation refuses the same grammar: a malformed token is never minted either.
    expect(() => executionToken("root", "not-a-uuid", 1, [], 1)).toThrow(/execution\.token-invalid/);
    expect(() => executionToken("plan", TOKEN_STORE, 1, ["wf-1"], 1)).toThrow(/execution\.token-invalid/);
    expect(() => executionToken("root", TOKEN_STORE, 0, [], 1)).toThrow(/execution\.token-invalid/);
  });

  test("refuses a token that addresses another kind, scope, epoch or revision", () => {
    const plan = executionToken("plan", TOKEN_STORE, 5, ["wf-1", "p-1"], 2);
    expect(assertExecutionToken(plan, { kind: "plan", storeId: TOKEN_STORE, epoch: 5, key: ["wf-1", "p-1"] }).revision).toBe(2);
    expect(() => assertExecutionToken(plan, { kind: "workflow", storeId: TOKEN_STORE, epoch: 5, key: ["wf-1"] })).toThrow(
      /execution\.token-kind/,
    );
    expect(() => assertExecutionToken(plan, { kind: "plan", storeId: TOKEN_STORE, epoch: 5, key: ["wf-1", "p-2"] })).toThrow(
      /execution\.scope-mismatch/,
    );
    expect(() => assertExecutionToken(plan, { kind: "plan", storeId: OTHER_STORE, epoch: 5, key: ["wf-1", "p-1"] })).toThrow(
      /execution\.scope-mismatch/,
    );
    expect(() => assertExecutionToken(plan, { kind: "plan", storeId: TOKEN_STORE, epoch: 6, key: ["wf-1", "p-1"] })).toThrow(
      /store\.stale-epoch/,
    );
    expect(() =>
      assertExecutionToken(plan, { kind: "plan", storeId: TOKEN_STORE, epoch: 5, key: ["wf-1", "p-1"], revision: 3 }),
    ).toThrow(/execution\.stale-token/);
  });
});

/* ------------------------------------------------------------------------ *
 * C2 — one-transaction ownership and the empty execution initializer (§3/§4.1)
 * ------------------------------------------------------------------------ */

/** A complete frozen catalog input identity (§1) for the read cases. */
const FROZEN_PIN = {
  store_id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  entity_revision: 4,
  document_hash: "a".repeat(64),
  relation_hash: "b".repeat(64),
};

/**
 * One workflow with one plan, its active plan-pm session, execution lease and
 * sealed input written as raw domain rows: C3 owns the creation API, so this
 * fixture exercises the READER's assembly of §3 `ExecutionState` rather than a
 * second create path.
 */
function seedAuthorityGraph(db: StoreDb, epoch: number, options: { stateId?: string } = {}): void {
  db.prepare(
    "insert into execution_workflows(workflow_id, revision, creator_session_id, state_json, created_at, updated_at) " +
      "values ('wf-1', 4, 'host-1', ?, ?, ?)",
  ).run(
    JSON.stringify({
      id: options.stateId ?? "wf-1",
      schema_version: 1,
      type: "plan",
      status: "running",
      started_at: TS,
      updated_at: TS,
    }),
    TS,
    TS,
  );
  db.prepare("insert into execution_registry(workflow_id, entry_json) values ('wf-1', ?)").run(
    JSON.stringify({ id: "wf-1", type: "plan", started_at: TS, dir: "workflows/wf-1" }),
  );
  db.prepare(
    "insert into execution_plans(workflow_id, plan_id, revision, ordinal, state_json, coordination_json) " +
      "values ('wf-1', 'p-1', 6, 0, ?, ?)",
  ).run(
    JSON.stringify({ id: "p-1", title: "C2 plan", file: "plans/p-1.md", status: "InProgress" }),
    JSON.stringify({ progress: { status: "InProgress", summary: "c2", evidence_paths: [] } }),
  );
  db.prepare(
    "insert into execution_sessions(workflow_id, role, session_id, plan_id, epoch, revision, state, bound_at) " +
      "values ('wf-1', 'plan-pm', 's-1', 'p-1', ?, 1, 'active', ?)",
  ).run(epoch, TS);
  db.prepare(
    "insert into execution_leases(workflow_id, plan_id, revision, owner_epoch, lease_json) values ('wf-1', 'p-1', 2, ?, ?)",
  ).run(
    epoch,
    JSON.stringify({
      // The existing `ExecutionLease` identity fields (§3 DTO) plus the §2.2
      // ownership/observation fields the DB lease carries.
      holder: "host-1",
      claimed_at: TS,
      worktree_path: "/tmp/wt",
      working_branch: "feature/x",
      lease_id: "l-1",
      holder_session_id: "s-1",
      holder_role: "plan-pm",
      plan_worktree_path: "/tmp/wt",
      plan_branch: "feature/x",
      heartbeat_at: TS,
      status: "held",
    }),
  );
  db.prepare(
    "insert into execution_inputs(workflow_id, plan_id, revision, input_json, input_hash, catalog_pin_json) " +
      "values ('wf-1', 'p-1', 1, '{}', 'input-hash', ?)",
  ).run(JSON.stringify(FROZEN_PIN));
}

describe("execution-initialize: §3 create-only empty execution authority", () => {
  test("does not activate execution merely because the schema was upgraded", async () => {
    const upgraded = controlRoot("upgrade-is-not-activation");
    createV3Store(upgraded);
    await upgradeStore(upgraded);
    const handle = await openStore(upgraded, "read");
    try {
      expect(handle.execution?.authorityState).toBe("legacy");
    } finally {
      handle.close();
    }
    await expect(readExecutionState(upgraded)).rejects.toThrow(/execution\.not-active/);

    // A store that predates migration 4 has no execution authority at all — and
    // reading it never migrates it.
    const preMigration = controlRoot("pre-migration-read");
    createV3Store(preMigration);
    await expect(readExecutionState(preMigration)).rejects.toThrow(/execution\.not-active/);
    const after = rawDb(storePath(preMigration));
    try {
      expect(scalar(after, "select max(version) as v from schema_version")).toBe(3);
    } finally {
      after.close();
    }
  });

  test("initializes an empty active execution authority and bumps the epoch once", async () => {
    const { context, epoch } = await freshStore("initialize-empty");
    const initialized = await initializeExecutionAuthority(context);
    expect(initialized.storeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(initialized.epoch).toBe(epoch + 1);
    expect(initialized.token).toBe(`exec-v1:root:${initialized.storeId}:${epoch + 1}:W10K:2`);
    expect(initialized.data).toEqual({
      root: { version: 2, updated_at: initialized.data.root.updated_at, workflows: [] },
      workflows: [],
    });
    expect(initialized.data.root.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const raw = rawDb(storePath(context));
    try {
      expect(one(raw, "select authority_state, revision, manifest_id from execution_meta where id = 1")).toEqual({
        authority_state: "active",
        revision: 2,
        manifest_id: null,
      });
      expect(String(scalar(raw, "select activated_at from execution_meta where id = 1"))).toMatch(/Z$/);
      expect(one(raw, "select authority_state, authority_epoch, revision from store_meta where id = 1")).toEqual({
        authority_state: "active",
        authority_epoch: epoch + 1,
        revision: 1,
      });
    } finally {
      raw.close();
    }

    // Create-only: a second initialization never resets the live authority.
    await expect(initializeExecutionAuthority(context)).rejects.toThrow(/execution\.not-empty/);
    const unchanged = rawDb(storePath(context));
    try {
      expect(scalar(unchanged, "select revision from execution_meta where id = 1")).toBe(2);
      expect(scalar(unchanged, "select authority_epoch from store_meta where id = 1")).toBe(epoch + 1);
    } finally {
      unchanged.close();
    }
    // The state a reader sees agrees with what the initializer returned.
    expect(await readExecutionState(context)).toEqual(initialized);
  });

  test("activates an upgraded store without touching issue/catalog records", async () => {
    const context = controlRoot("initialize-upgraded-store");
    createV3Store(context);
    const prep = rawDb(storePath(context));
    try {
      // The fixture carries a historical catalog execution binding; an empty
      // execution workspace cannot have one.
      prep.exec("delete from catalog_execution_bindings");
    } finally {
      prep.close();
    }
    await upgradeStore(context);
    const initialized = await initializeExecutionAuthority(context);
    expect(initialized.epoch).toBe(2);
    expect(initialized.data.workflows).toEqual([]);

    const raw = rawDb(storePath(context));
    try {
      expect(scalar(raw, "select count(*) as n from issues")).toBe(1);
      expect(scalar(raw, "select count(*) as n from occurrences")).toBe(1);
      expect(scalar(raw, "select count(*) as n from catalog_entities")).toBe(3);
      expect(scalar(raw, "select count(*) as n from execution_workflows")).toBe(0);
      expect(
        one(raw, "select authority_state, authority_epoch, revision, catalog_revision from store_meta where id = 1"),
      ).toEqual({ authority_state: "active", authority_epoch: 2, revision: 8, catalog_revision: 3 });
    } finally {
      raw.close();
    }
  });

  test("refuses a live legacy execution source without touching the store", async () => {
    const { context, epoch } = await freshStore("initialize-legacy-source");
    writeFileSync(
      join(context.harnessDir, "status.json"),
      JSON.stringify({ version: 2, updated_at: "2026-01-02", workflows: [] }),
    );
    await expect(initializeExecutionAuthority(context)).rejects.toThrow(/execution\.not-empty/);

    // Snapshots, session envelopes and notes ledgers live under the workflow tree.
    rmSync(join(context.harnessDir, "status.json"));
    mkdirSync(join(context.harnessDir, "workflows", "wf-1"), { recursive: true });
    writeFileSync(join(context.harnessDir, "workflows", "wf-1", "snapshot.json"), "{}");
    await expect(initializeExecutionAuthority(context)).rejects.toThrow(/execution\.not-empty/);

    // Neither refusal committed anything.
    const raw = rawDb(storePath(context));
    try {
      expect(one(raw, "select authority_state, revision from execution_meta where id = 1")).toEqual({
        authority_state: "legacy",
        revision: 1,
      });
      expect(scalar(raw, "select authority_epoch from store_meta where id = 1")).toBe(epoch);
    } finally {
      raw.close();
    }

    // An EMPTY workflow tree is not a source: the empty workspace still initializes.
    rmSync(join(context.harnessDir, "workflows"), { recursive: true, force: true });
    expect((await initializeExecutionAuthority(context)).epoch).toBe(epoch + 1);
  });

  test("refuses a nonempty execution domain without clearing it", async () => {
    const { context, epoch } = await freshStore("initialize-nonempty-domain");
    const writer = await openStore(context, "write");
    try {
      seedExecutionGraph(writer.db);
    } finally {
      writer.close();
    }
    await expect(initializeExecutionAuthority(context)).rejects.toThrow(/execution\.not-empty/);

    const raw = rawDb(storePath(context));
    try {
      expect(scalar(raw, "select count(*) as n from execution_workflows")).toBe(1);
      expect(scalar(raw, "select count(*) as n from execution_plans")).toBe(2);
      expect(one(raw, "select authority_state, revision from execution_meta where id = 1")).toEqual({
        authority_state: "legacy",
        revision: 1,
      });
      expect(scalar(raw, "select authority_epoch from store_meta where id = 1")).toBe(epoch);
    } finally {
      raw.close();
    }
  });

  test("refuses a catalog execution binding as a nonempty execution workspace", async () => {
    const { context } = await freshStore("initialize-catalog-binding");
    const writer = await openStore(context, "write");
    try {
      writer.db
        .prepare(
          "insert into catalog_entities(kind,id,title,root_kind,relative_path,revision,registered_at,updated_at) " +
            "values ('plan','plan-1','Plan','plans','plans/plan-1.md',5,?,?)",
        )
        .run(TS, TS);
      writer.db
        .prepare(
          "insert into catalog_execution_bindings(workflow_id,catalog_kind,catalog_id,workflow_root_kind," +
            "workflow_relative_path,catalog_revision,input_hash,pin_json,operation_id) " +
            "values ('wf-legacy','plan','plan-1','plans','plans/plan-1.md',5,'input-hash-1','{}','op-bind-1')",
        )
        .run();
    } finally {
      writer.close();
    }
    await expect(initializeExecutionAuthority(context)).rejects.toThrow(/execution\.not-empty/);
  });

  test("refuses initialization on a staged issue/catalog store", async () => {
    const { context, epoch } = await freshStore("initialize-staged-store");
    const writer = await openStore(context, "write");
    try {
      writer.db.prepare("update store_meta set authority_state = 'staged' where id = 1").run();
    } finally {
      writer.close();
    }
    await expect(initializeExecutionAuthority(context)).rejects.toThrow(/store\.not-active/);

    const raw = rawDb(storePath(context));
    try {
      expect(scalar(raw, "select authority_state from execution_meta where id = 1")).toBe("legacy");
      expect(scalar(raw, "select authority_epoch from store_meta where id = 1")).toBe(epoch);
    } finally {
      raw.close();
    }
  });

  test("a nested transaction on the same store refuses and commits nothing", async () => {
    const { context, epoch } = await freshStore("reentrant-transaction");
    const refusal = await withExecutionTransaction(context, (tx) => {
      // A write the outer transaction WOULD commit if the boundary leaked.
      tx.db.prepare("update execution_meta set revision = 99 where id = 1").run();
      return withExecutionTransaction(context, () => "nested");
    }).then(
      () => {
        throw new Error("expected the nested transaction to be refused");
      },
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(ExecutionError);
    expect((refusal as ExecutionError).code).toBe("execution.reentrant");

    const raw = rawDb(storePath(context));
    try {
      expect(scalar(raw, "select revision from execution_meta where id = 1")).toBe(1);
      expect(scalar(raw, "select authority_epoch from store_meta where id = 1")).toBe(epoch);
    } finally {
      raw.close();
    }

    // The boundary is released afterwards: sequential transactions are not nested.
    const storeId = await withExecutionTransaction(context, (tx) => {
      expect(tx.execution.authorityState).toBe("legacy");
      return tx.storeId;
    });
    expect(storeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("reads the active authority as one assembled state graph", async () => {
    const { context, epoch } = await freshStore("read-populated");
    const initialized = await initializeExecutionAuthority(context);
    const writer = await openStore(context, "write");
    try {
      seedAuthorityGraph(writer.db, epoch + 1);
    } finally {
      writer.close();
    }

    const state = await readExecutionState(context);
    expect(state.storeId).toBe(initialized.storeId);
    expect(state.epoch).toBe(epoch + 1);
    expect(state.token).toBe(executionToken("root", initialized.storeId, epoch + 1, [], 2));
    expect(state.data.root).toEqual({
      version: 2,
      updated_at: initialized.data.root.updated_at,
      workflows: [{ id: "wf-1", type: "plan", started_at: TS, dir: "workflows/wf-1" }],
    });
    expect(state.data.workflows).toHaveLength(1);
    const [workflow] = state.data.workflows;
    expect(workflow.workflowToken).toBe(executionToken("workflow", initialized.storeId, epoch + 1, ["wf-1"], 4));
    expect(workflow.planTokens).toEqual({
      "p-1": executionToken("plan", initialized.storeId, epoch + 1, ["wf-1", "p-1"], 6),
    });
    expect(workflow.coordinator).toBeNull();
    expect(workflow.integrationLease).toBeNull();
    expect(workflow.plans).toHaveLength(1);
    const [plan] = workflow.plans;
    expect(plan.plan).toEqual({ id: "p-1", title: "C2 plan", file: "plans/p-1.md", status: "InProgress" });
    expect(plan.coordination).toEqual({
      revision: 6,
      progress: { status: "InProgress", summary: "c2", evidence_paths: [] },
    });
    expect(plan.session).toEqual({
      storeId: initialized.storeId,
      epoch: epoch + 1,
      workflowId: "wf-1",
      role: "plan-pm",
      sessionId: "s-1",
      planId: "p-1",
    });
    expect(plan.executionLease).toEqual({
      holder: "host-1",
      claimed_at: TS,
      worktree_path: "/tmp/wt",
      working_branch: "feature/x",
      lease_id: "l-1",
      holder_session_id: "s-1",
      holder_role: "plan-pm",
      plan_worktree_path: "/tmp/wt",
      plan_branch: "feature/x",
      heartbeat_at: TS,
      status: "held",
    });
    expect(plan.integrationLease).toBeNull();
    expect(plan.frozenInput).toEqual(FROZEN_PIN);
  });

  test("refuses to serve a workflow whose stored state does not describe its own key", async () => {
    const { context, epoch } = await freshStore("read-foreign-state");
    await initializeExecutionAuthority(context);
    const writer = await openStore(context, "write");
    try {
      seedAuthorityGraph(writer.db, epoch + 1, { stateId: "wf-other" });
    } finally {
      writer.close();
    }
    await expect(readExecutionState(context)).rejects.toThrow(/store\.corrupt/);
  });

  test("refuses a plan whose stored state does not describe its own key", async () => {
    const { context, epoch } = await freshStore("read-foreign-plan");
    await initializeExecutionAuthority(context);
    const writer = await openStore(context, "write");
    try {
      seedAuthorityGraph(writer.db, epoch + 1);
      writer.db
        .prepare("update execution_plans set state_json = ? where workflow_id = 'wf-1' and plan_id = 'p-1'")
        .run(JSON.stringify({ id: "p-other", status: "InProgress" }));
    } finally {
      writer.close();
    }
    await expect(readExecutionState(context)).rejects.toMatchObject({ code: "store.corrupt" });
  });

  test("refuses a frozen pin that is not a complete catalog execution identity", async () => {
    const { context, epoch } = await freshStore("read-malformed-pin");
    await initializeExecutionAuthority(context);
    const writer = await openStore(context, "write");
    try {
      seedAuthorityGraph(writer.db, epoch + 1);
      writer.db
        .prepare("update execution_inputs set catalog_pin_json = ? where workflow_id = 'wf-1' and plan_id = 'p-1'")
        .run(JSON.stringify({ ...FROZEN_PIN, document_hash: "" }));
    } finally {
      writer.close();
    }
    await expect(readExecutionState(context)).rejects.toMatchObject({ code: "store.corrupt" });
  });

  test("refuses a session row that contradicts the session identity contract", async () => {
    const { context, epoch } = await freshStore("read-malformed-session");
    await initializeExecutionAuthority(context);
    const writer = await openStore(context, "write");
    try {
      seedAuthorityGraph(writer.db, epoch + 1);
      writer.db
        .prepare("update execution_sessions set session_id = '' where workflow_id = 'wf-1' and session_id = 's-1'")
        .run();
    } finally {
      writer.close();
    }
    await expect(readExecutionState(context)).rejects.toMatchObject({ code: "store.corrupt" });
  });
});
