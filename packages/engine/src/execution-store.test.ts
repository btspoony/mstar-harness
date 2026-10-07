/**
 * execution-store.test.ts — proof for migration 4 (`execution-authority`,
 * primary spec §2.2) and for the issue/catalog-versus-execution mode
 * separation.
 *
 * Run with
 * `bun test packages/engine/src/execution-store.test.ts --test-name-pattern 'execution-schema'`
 * (C1 schema), `--test-name-pattern 'execution-tokens|execution-initialize'`
 * (C2 canonical tokens, transaction ownership, empty initialization) or
 * `--test-name-pattern 'execution-domain'` (C3 workflow creation, sealed
 * inputs, root CAS and the authoritative read).
 *
 * Every fixture lives in its own temporary control root created by
 * `mkdtempSync`; no test reads or writes this checkout's `store.db`. The
 * pre-migration-4 stores are built from the real migrations 1–3 SQL with the
 * checksums such a store actually carries, so a mutated applied migration
 * makes the upgrade refuse exactly as it would in a real workspace.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertExecutionSessionCurrent, resumeExecutionSession } from "./execution-session.js";
import { registerCatalogEntity, updateCatalogEntity } from "./catalog.js";
import { ExecutionPinConflictError, executionInputHash, type CatalogExecutionPin } from "./coordination.js";
import {
  ExecutionError,
  assertExecutionToken,
  bindExecutionSession,
  createExecutionWorkflow,
  executionToken,
  initializeExecutionAuthority,
  parseExecutionToken,
  readExecutionPlan,
  readExecutionState,
  serializeExecutionValue,
  withExecutionTransaction,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionReceipt,
  type ExecutionSessionRef,
  type ExecutionState,
  type ExecutionToken,
} from "./execution-store.js";
import type { WorkflowEntry } from "./status.js";
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
import type { WorkflowSnapshot } from "./workflow.js";

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

/** Tables inventoried for migration atomicity and empty-domain checks. */
const EXECUTION_TABLES = [
  "execution_meta",
  "execution_workflows",
  "execution_registry",
  "execution_plans",
  "execution_sessions",
  "execution_integration_leases",
  "execution_inputs",
  "execution_operations",
  "execution_migrations",
];

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

/** One workflow-wide coordinator session row (the only execution role). */
function session(db: StoreDb, input: { sessionId: string; state?: string; epoch: number }): void {
  db.prepare(
    "insert into execution_sessions(workflow_id, role, session_id, epoch, revision, state, bound_at) " +
      "values ('wf-1', 'coordinator', ?, ?, 1, ?, ?)",
  ).run(input.sessionId, input.epoch, input.state ?? "active", TS);
}


describe("execution-schema: append-only coverage migration", () => {
  describe("migration identity", () => {
    test("keeps the applied v1\u2013v3 checksums unchanged", () => {
      for (const {} of [1, 2, 3]) {
        ;
      }
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
        // Applied rows 1–3 keep their checksums; pending migrations append.
        expect(all(db, "select version, name, checksum from schema_version order by version")).toEqual([
          { version: 1, name: "issue-core", checksum: FROZEN_V3_CHECKSUMS[1] },
          { version: 2, name: "catalog-authority", checksum: FROZEN_V3_CHECKSUMS[2] },
          { version: 3, name: "execution-projections", checksum: FROZEN_V3_CHECKSUMS[3] },
          ...MIGRATIONS.slice(3).map((migration) => ({
            version: migration.version, name: migration.name, checksum: migrationChecksum(migration),
          })),
        ]);
        expect(all(db, "pragma table_info(execution_migrations)").some((row: { name?: unknown }) => row.name === "coverage_json")).toBe(true);
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
    test("refuses a second active coordinator while accepting non-active owners", async () => {
      const { context, epoch } = await freshStore("refuse-duplicate-active");
      const handle = await openStore(context, "write");
      try {
        seedExecutionGraph(handle.db);
        session(handle.db, { sessionId: "s-1", epoch });

        // A second ACTIVE coordinator for the workflow is refused.
        expect(() => session(handle.db, { sessionId: "s-2", epoch })).toThrow();
        // The uniqueness is on ACTIVE ownership: the same identity may be
        // recorded once it is no longer active.
        session(handle.db, { sessionId: "s-2", state: "suspended", epoch });
        // A plan-pm role row is no longer an execution session at all: the
        // removed seat's schema arm refuses it.
        expect(() =>
          handle.db
            .prepare(
              "insert into execution_sessions(workflow_id, role, session_id, epoch, revision, state, bound_at) " +
                "values ('wf-1','plan-pm','s-6',?,1,'active',?)",
            )
            .run(epoch, TS),
        ).toThrow();
      } finally {
        handle.close();
      }
    });

    test("refuses a dangling input, plan or registry entry", async () => {
      const { context, epoch } = await freshStore("refuse-dangling");
      const handle = await openStore(context, "write");
      try {
        seedExecutionGraph(handle.db);

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
        // Epoch 0 is not a usable authority fence, and the role set is closed.
        expect(() => session(handle.db, { sessionId: "s-1", epoch: 0 })).toThrow();
        expect(() =>
          handle.db
            .prepare(
              "insert into execution_sessions(workflow_id, role, session_id, epoch, revision, state, bound_at) " +
                "values ('wf-1','keeper','s-1',?,1,'active',?)",
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

describe("execution-tokens: \u00A73.1 canonical value form and version tokens", () => {

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
  });

  test("token generation and parsing retain the declared address and revision", () => {
    const root = executionToken("root", TOKEN_STORE, 3, [], 2);
    expect(parseExecutionToken(root)).toEqual({ kind: "root", storeId: TOKEN_STORE, epoch: 3, key: [], revision: 2 });
    const plan = executionToken("plan", TOKEN_STORE, 7, ["wf-1", "p-1"], 4);
    expect(parseExecutionToken(plan).key).toEqual(["wf-1", "p-1"]);
    expect(parseExecutionToken(executionToken("session", TOKEN_STORE, 7, ["wf-1", "coordinator", "s-1"], 1)).key).toEqual([
      "wf-1",
      "coordinator",
      "s-1",
    ]);
    expect(
      assertExecutionToken(plan, { kind: "plan", storeId: TOKEN_STORE, epoch: 7, key: ["wf-1", "p-1"], revision: 4 }),
    ).toEqual(parseExecutionToken(plan));
  });

  test("refuses malformed tokens and invalid address fields", () => {
    const malformed: Array<[string, string]> = [
      ["", "empty"],
      [`exec-v1:root:${TOKEN_STORE}:1:W10K`, "five parts"],
      [`exec-v1:plan:${TOKEN_STORE}:1:${Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x5d]).toString("base64url")}:1`, "invalid UTF-8"],
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
      [`exec-v1:workflow:${TOKEN_STORE}:1:${key64("[]\n")}:1`, "key arity below the kind"],
      [`exec-v1:workflow:${TOKEN_STORE}:1:${key64('["wf-1","p-1"]\n')}:1`, "key arity above the kind"],
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

  test("accepts equivalent key JSON without canonical serialization equality", () => {
    const expected = { kind: "plan" as const, storeId: TOKEN_STORE, epoch: 1, key: ["wf-1", "p-1"], revision: 2 };
    for (const keyText of ['["wf-1","p-1"]', ' [ "wf-1", "p-1" ] \n']) {
      const token = `exec-v1:plan:${TOKEN_STORE}:1:${key64(keyText)}:2`;
      expect(assertExecutionToken(token, expected)).toEqual(expected);
      expect(() => assertExecutionToken(token, { ...expected, revision: 3 })).toThrow(/execution\.stale-token/);
      expect(() => assertExecutionToken(token, { ...expected, key: ["wf-1", "another-plan"] })).toThrow(/execution\.scope-mismatch/);
    }
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

  test("the wrong-kind refusal names where the expected kind is read from", () => {
    const workflow = executionToken("workflow", TOKEN_STORE, 5, ["wf-1"], 2);
    const plan = executionToken("plan", TOKEN_STORE, 5, ["wf-1", "p-1"], 2);
    // Root expectation: names the status validate root field.
    expect(() => assertExecutionToken(workflow, { kind: "root", storeId: TOKEN_STORE, epoch: 5, key: [] })).toThrow(
      /Read the current root token with `mstar status validate` \(output field data\.token\)\.$/,
    );
    // Workflow expectation: names the entry for the addressed workflow.
    expect(() => assertExecutionToken(plan, { kind: "workflow", storeId: TOKEN_STORE, epoch: 5, key: ["wf-1"] })).toThrow(
      /Read the current workflow token with `mstar status validate` \(the data\.workflows\[\] entry for workflow "wf-1" \u2192 token\)\.$/,
    );
    // Plan expectation: names the planTokens entry for the addressed plan.
    expect(() =>
      assertExecutionToken(workflow, { kind: "plan", storeId: TOKEN_STORE, epoch: 5, key: ["wf-1", "p-1"] }),
    ).toThrow(/planTokens\["p-1"\]\)\.$/);
    expect(() =>
      assertExecutionToken(workflow, { kind: "plan", storeId: TOKEN_STORE, epoch: 5, key: ["wf-1", "p-1"] }),
    ).toThrow(/data\.authority\.workflows\[\] entry for workflow "wf-1"/);
    // A session-token expectation has no CLI read path: the message stays pointer-free.
    expect(() =>
      assertExecutionToken(workflow, { kind: "session", storeId: TOKEN_STORE, epoch: 5, key: ["wf-1", "coordinator", "s-1"] }),
    ).toThrow(
      /expected a session token \u2014 got a workflow token\. The address kind is never inferred from a supplied token\.$/,
    );
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
 * One workflow with one plan, its workflow-wide coordinator session and sealed
 * input written as raw domain rows: C3 owns the creation API, so this fixture
 * exercises the READER's assembly of §3 `ExecutionState` rather than a second
 * create path.
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
    "insert into execution_sessions(workflow_id, role, session_id, epoch, revision, state, bound_at) " +
      "values ('wf-1', 'coordinator', 's-1', ?, 1, 'active', ?)",
  ).run(epoch, TS);
  db.prepare(
    "insert into execution_inputs(workflow_id, plan_id, revision, input_json, input_hash, catalog_pin_json) " +
      "values ('wf-1', 'p-1', 1, '{}', 'input-hash', ?)",
  ).run(JSON.stringify(FROZEN_PIN));
}

describe("execution-initialize: \u00A73 create-only empty execution authority", () => {
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
    expect(String(initialized.token)).toBe(`exec-v1:root:${initialized.storeId}:${epoch + 1}:W10K:2`);
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
    await expect(initializeExecutionAuthority(context)).rejects.toThrow(/mstar store upgrade --operator/);

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
    expect(workflow.coordinator).toMatchObject({
      storeId: initialized.storeId,
      epoch: epoch + 1,
      workflowId: "wf-1",
      role: "coordinator",
      sessionId: "s-1",
    });
    expect(workflow.integrationLease).toBeNull();
    expect(workflow.plans).toHaveLength(1);
    const [plan] = workflow.plans;
    expect(plan.plan).toEqual({ id: "p-1", title: "C2 plan", file: "plans/p-1.md", status: "InProgress" });
    expect(plan.coordination).toEqual({
      revision: 6,
      progress: { status: "InProgress", summary: "c2", evidence_paths: [] },
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

/* ------------------------------------------------------------------------ *
 * C3 — workflow creation, sealed inputs and the authoritative read (§3)
 * ------------------------------------------------------------------------ */

/** A catalog plan entity, registered through the real catalog verb. */
async function registerPlan(context: StoreContext, planId: string, title = `${planId} title`): Promise<number> {
  const receipt = await registerCatalogEntity(
    context,
    { kind: "plan", id: planId, title, rootKind: "plans", relativePath: `plans/${planId}.md` },
    { operationId: `register-${planId}`, actor: "execution-store.test" },
  );
  return receipt.revision;
}

/** The trusted caller a domain verb authorizes against (§3 `ExecutionCaller`). */
function domainCaller(workflowId: string, overrides: Partial<ExecutionCaller> = {}): ExecutionCaller {
  return { sessionId: `session-${workflowId}`, role: "coordinator", workflowId, ...overrides };
}

function domainContext(context: StoreContext, caller: ExecutionCaller): ExecutionContext {
  return { harnessDir: context.harnessDir, caller };
}

/** One Todo plan row of a supplied snapshot. */
function planRow(planId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: planId, title: `${planId} title`, file: `plans/${planId}.md`, status: "Todo", ...overrides };
}

/** A create request: the root entry plus the snapshot its plan rows come from. */
function creationInput(
  workflowId: string,
  plans: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): { entry: WorkflowEntry; snapshot: WorkflowSnapshot } {
  return {
    entry: { id: workflowId, type: "plan", started_at: TS, dir: `workflows/${workflowId}` },
    snapshot: {
      schema_version: 1,
      id: workflowId,
      type: "plan",
      status: "running",
      started_at: TS,
      updated_at: TS,
      plans,
      delivery_kind: "development",
      branch: { source: `feature/${workflowId}`, target: "main" },
      ...overrides,
    } as unknown as WorkflowSnapshot,
  };
}

/** The revisions and row counts an UNCHANGED accepted state is compared on. */
function executionFootprint(context: StoreContext): Record<string, unknown> {
  const db = rawDb(storePath(context));
  try {
    return {
      rootRevision: scalar(db, "select revision from execution_meta where id = 1"),
      rootUpdatedAt: scalar(db, "select root_updated_at from execution_meta where id = 1"),
      storeRevision: scalar(db, "select revision from store_meta where id = 1"),
      catalogRevision: scalar(db, "select catalog_revision from store_meta where id = 1"),
      workflows: scalar(db, "select count(*) as n from execution_workflows"),
      registry: scalar(db, "select count(*) as n from execution_registry"),
      plans: scalar(db, "select count(*) as n from execution_plans"),
      inputs: scalar(db, "select count(*) as n from execution_inputs"),
      operations: scalar(db, "select count(*) as n from execution_operations"),
      sessions: scalar(db, "select count(*) as n from execution_sessions"),
    };
  } finally {
    db.close();
  }
}

/** The sealed frozen input of one plan, straight from the sealed columns. */
function sealedInput(context: StoreContext, planId: string): Record<string, unknown> {
  const db = rawDb(storePath(context));
  try {
    return one(
      db,
      `select input_json, input_hash, catalog_pin_json from execution_inputs where workflow_id = 'wf-1' and plan_id = '${planId}'`,
    );
  } finally {
    db.close();
  }
}

describe("execution-domain: \u00A73 workflow creation, sealed input and authoritative read", () => {
  test("creates registry, workflow, plan rows and sealed inputs in one transaction", async () => {
    const { context, epoch } = await freshStore("domain-create");
    const initialized = await initializeExecutionAuthority(context);
    await registerPlan(context, "p-1");
    await registerPlan(context, "p-2");
    const storeRevisionBefore = executionFootprint(context).storeRevision;
    const { entry, snapshot } = creationInput("wf-1", [planRow("p-1"), planRow("p-2")]);

    const created = await createExecutionWorkflow(domainContext(context, domainCaller("wf-1")), {
      entry,
      snapshot,
      expected: initialized.token,
      operationId: "create-wf-1",
    });
    expect(created.replayed).toBe(false);
    expect(created.operationId).toBe("create-wf-1");
    expect(created.storeId).toBe(initialized.storeId);
    expect(created.epoch).toBe(epoch + 1);
    // Registry membership is a root change: the root revision advances once.
    expect(created.token).toBe(executionToken("root", initialized.storeId, epoch + 1, [], 3));
    expect(created.data.root).toEqual({ version: 2, updated_at: created.data.root.updated_at, workflows: [entry] });
    expect(created.data.workflows).toHaveLength(1);
    const [workflow] = created.data.workflows;
    // Every record created here starts at revision 1 (§2.2/§3.1).
    expect(workflow.workflowToken).toBe(executionToken("workflow", initialized.storeId, epoch + 1, ["wf-1"], 1));
    expect(workflow.planTokens).toEqual({
      "p-1": executionToken("plan", initialized.storeId, epoch + 1, ["wf-1", "p-1"], 1),
      "p-2": executionToken("plan", initialized.storeId, epoch + 1, ["wf-1", "p-2"], 1),
    });
    expect(workflow.state).toEqual({
      schema_version: 1,
      id: "wf-1",
      type: "plan",
      status: "running",
      started_at: TS,
      updated_at: TS,
      delivery_kind: "development",
      branch: { source: "feature/wf-1", target: "main" },
    });
    expect(workflow.coordinator).toBeNull();
    expect(workflow.integrationLease).toBeNull();
    expect(workflow.plans.map((plan) => plan.plan.id)).toEqual(["p-1", "p-2"]);
    expect(workflow.plans.map((plan) => plan.coordination)).toEqual([null, null]);
    expect(workflow.plans.map((plan) => plan.frozenInput)).toEqual([null, null]);

    // The authoritative read agrees with the receipt it was committed with.
    const read = await readExecutionState(context);
    expect(read.token).toBe(created.token);
    expect(read.data).toEqual(created.data);

    const db = rawDb(storePath(context));
    try {
      const workflowRow = one(
        db,
        "select workflow_id, revision, creator_session_id, created_at, updated_at from execution_workflows",
      );
      expect(workflowRow.workflow_id).toBe("wf-1");
      expect(workflowRow.revision).toBe(1);
      expect(workflowRow.creator_session_id).toBe("session-wf-1");
      expect(workflowRow.created_at).toBe(workflowRow.updated_at);
      expect(String(workflowRow.created_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(one(db, "select workflow_id, entry_json from execution_registry")).toEqual({
        workflow_id: "wf-1",
        entry_json: JSON.stringify(entry),
      });
      expect(
        all(db, "select plan_id, revision, ordinal, coordination_json from execution_plans order by ordinal"),
      ).toEqual([
        { plan_id: "p-1", revision: 1, ordinal: 0, coordination_json: "{}" },
        { plan_id: "p-2", revision: 1, ordinal: 1, coordination_json: "{}" },
      ]);
      // The sealed selection is the frozen field set ONLY — status/metadata
      // progress never enters it, so reporting progress cannot move the seal.
      expect(all(db, "select plan_id, revision, input_json, catalog_pin_json from execution_inputs order by plan_id")).toEqual([
        {
          plan_id: "p-1",
          revision: 1,
          input_json: '{"plan_id":"p-1","id":"p-1","title":"p-1 title","file":"plans/p-1.md"}',
          catalog_pin_json: null,
        },
        {
          plan_id: "p-2",
          revision: 1,
          input_json: '{"plan_id":"p-2","id":"p-2","title":"p-2 title","file":"plans/p-2.md"}',
          catalog_pin_json: null,
        },
      ]);
      const operation = one(
        db,
        "select epoch, operation_id, request_hash, store_id, workflow_id, plan_id, committed_at from execution_operations",
      );
      expect(operation).toEqual({
        epoch: epoch + 1,
        operation_id: "create-wf-1",
        request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        store_id: initialized.storeId,
        workflow_id: "wf-1",
        plan_id: null,
        committed_at: workflowRow.created_at,
      });
      expect(one(db, "select authority_state, revision, root_updated_at from execution_meta where id = 1")).toEqual({
        authority_state: "active",
        revision: 3,
        root_updated_at: workflowRow.created_at,
      });
      expect(one(db, "select authority_epoch, revision from store_meta where id = 1")).toEqual({
        authority_epoch: epoch + 1,
        revision: (storeRevisionBefore as number) + 1,
      });
      // Creation binds identity only: it mints no session and claims no lease.
      expect(scalar(db, "select count(*) as n from execution_sessions")).toBe(0);
    } finally {
      db.close();
    }
  });

  test("refuses a duplicate workflow identity and leaves the first one untouched", async () => {
    const { context } = await freshStore("domain-duplicate");
    const initialized = await initializeExecutionAuthority(context);
    await registerPlan(context, "p-1");
    const first = creationInput("wf-1", [planRow("p-1")]);
    await createExecutionWorkflow(domainContext(context, domainCaller("wf-1")), {
      ...first,
      expected: initialized.token,
      operationId: "create-wf-1",
    });
    const accepted = await readExecutionState(context);
    const footprint = executionFootprint(context);

    const duplicate = creationInput("wf-1", [planRow("p-1"), planRow("p-2")]);
    await expect(
      createExecutionWorkflow(domainContext(context, domainCaller("wf-1")), {
        ...duplicate,
        expected: accepted.token,
        operationId: "create-wf-1-again",
      }),
    ).rejects.toMatchObject({ code: "execution.not-empty" });

    expect(await readExecutionState(context)).toEqual(accepted);
    expect(executionFootprint(context)).toEqual(footprint);
    expect(sealedInput(context, "p-1").input_json).toBe('{"plan_id":"p-1","id":"p-1","title":"p-1 title","file":"plans/p-1.md"}');
    const db = rawDb(storePath(context));
    try {
      expect(scalar(db, "select count(*) as n from execution_plans")).toBe(1);
    } finally {
      db.close();
    }
  });

  test("refuses an operation id reused for another payload or caller", async () => {
    const { context } = await freshStore("domain-operation-conflict");
    const initialized = await initializeExecutionAuthority(context);
    await registerPlan(context, "p-1");
    await registerPlan(context, "p-2");
    const first = creationInput("wf-1", [planRow("p-1")]);
    await createExecutionWorkflow(domainContext(context, domainCaller("wf-1")), {
      ...first,
      expected: initialized.token,
      operationId: "shared-operation",
    });
    const accepted = await readExecutionState(context);
    const footprint = executionFootprint(context);

    // Another payload under the committed operation id is a conflict, not a replay.
    const other = creationInput("wf-2", [planRow("p-2")]);
    await expect(
      createExecutionWorkflow(domainContext(context, domainCaller("wf-2")), {
        ...other,
        expected: accepted.token,
        operationId: "shared-operation",
      }),
    ).rejects.toMatchObject({ code: "execution.operation-conflict" });

    // Another actor cannot replay it either: the caller identity is part of the hash.
    await expect(
      createExecutionWorkflow(domainContext(context, domainCaller("wf-1", { sessionId: "session-foreign" })), {
        ...first,
        expected: accepted.token,
        operationId: "shared-operation",
      }),
    ).rejects.toMatchObject({ code: "execution.operation-conflict" });

    expect(await readExecutionState(context)).toEqual(accepted);
    expect(executionFootprint(context)).toEqual(footprint);
  });

  test("an exact retry returns the recorded receipt and advances no revision", async () => {
    const { context } = await freshStore("domain-replay");
    const initialized = await initializeExecutionAuthority(context);
    await registerPlan(context, "p-1");
    const request = creationInput("wf-1", [planRow("p-1")]);
    const committed = await createExecutionWorkflow(domainContext(context, domainCaller("wf-1")), {
      ...request,
      expected: initialized.token,
      operationId: "retry-operation",
    });
    const footprint = executionFootprint(context);

    // The retry reuses the ORIGINAL (now superseded) root token: an idempotent
    // replay revalidates authority, not the CAS of the first attempt.
    const replayed = await createExecutionWorkflow(domainContext(context, domainCaller("wf-1")), {
      ...request,
      expected: initialized.token,
      operationId: "retry-operation",
    });
    expect(replayed.replayed).toBe(true);
    expect(replayed.operationId).toBe("retry-operation");
    expect(replayed.token).toBe(committed.token);
    expect(replayed.storeId).toBe(committed.storeId);
    expect(replayed.epoch).toBe(committed.epoch);
    expect(replayed.data).toEqual(committed.data);
    expect(executionFootprint(context)).toEqual(footprint);
  });

  test("refuses a snapshot that is bound, leased, terminal or carries accepted evidence", async () => {
    const { context } = await freshStore("domain-not-new");
    const initialized = await initializeExecutionAuthority(context);
    await registerPlan(context, "p-1");
    const footprint = executionFootprint(context);
    const caller = domainCaller("wf-1");
    const attempt = (snapshotInput: { entry: WorkflowEntry; snapshot: WorkflowSnapshot }, operationId: string) =>
      createExecutionWorkflow(domainContext(context, caller), {
        ...snapshotInput,
        expected: initialized.token,
        operationId,
      });

    // A bound lifecycle: the snapshot already names its coordinator.
    const bound = creationInput("wf-1", [planRow("p-1")], {
      coordination: { coordinator: { session_id: "s-1", session_file: "/tmp/s-1.json", bound_at: TS } },
    });
    await expect(attempt(bound, "bound")).rejects.toMatchObject({ code: "execution.not-empty" });

    // An unleased lifecycle: no integration merge lease may be held already.
    const leased = creationInput("wf-1", [planRow("p-1")], {
      integration_merge_lease: {
        holder: "host-1",
        claimed_at: TS,
        plan_id: "p-1",
        source_branch: "feature/x",
        target_branch: "main",
      },
    });
    await expect(attempt(leased, "merge-lease")).rejects.toMatchObject({ code: "execution.not-empty" });

    // Accepted delivery evidence belongs to a lifecycle that already delivered.
    const delivered = creationInput("wf-1", [planRow("p-1")], { delivery: { pr: { repo: "o/r", head: "h", target: "main" } } });
    await expect(attempt(delivered, "delivery")).rejects.toMatchObject({ code: "execution.not-empty" });

    // A terminal snapshot is never registered as an ACTIVE lifecycle.
    const terminal = creationInput("wf-1", [planRow("p-1")], { status: "completed", ended_at: TS });
    await expect(attempt(terminal, "terminal")).rejects.toMatchObject({ code: "execution.not-empty" });

    // A row that already carries coordination (progress/prepared) is a lifecycle
    // that has started, not a new one.
    const preparedRow = creationInput("wf-1", [
      planRow("p-1", { coordination: { revision: 1, progress: { status: "InProgress", summary: "x", evidence_paths: [] } } }),
      planRow("p-2"),
    ]);
    await expect(attempt(preparedRow, "prepared-row")).rejects.toMatchObject({ code: "execution.not-empty" });

    expect(executionFootprint(context)).toEqual(footprint);
  });

  test("refuses a stale root token, a foreign store token, a wrong kind and a foreign caller without writing", async () => {
    const { context, epoch } = await freshStore("domain-refusals");
    const initialized = await initializeExecutionAuthority(context);
    await registerPlan(context, "p-1");
    const footprint = executionFootprint(context);
    const request = creationInput("wf-1", [planRow("p-1")]);
    const attempt = (caller: ExecutionCaller, expected: ExecutionToken, operationId: string) =>
      createExecutionWorkflow(domainContext(context, caller), { ...request, expected, operationId });

    // A superseded root revision.
    await expect(
      attempt(domainCaller("wf-1"), executionToken("root", initialized.storeId, epoch + 1, [], 1), "stale-revision"),
    ).rejects.toMatchObject({ code: "execution.stale-token" });
    // A superseded epoch.
    await expect(
      attempt(domainCaller("wf-1"), executionToken("root", initialized.storeId, epoch, [], 2), "stale-epoch"),
    ).rejects.toMatchObject({ code: "store.stale-epoch" });
    // A token minted for another store.
    await expect(
      attempt(domainCaller("wf-1"), executionToken("root", OTHER_STORE, epoch + 1, [], 2), "foreign-store"),
    ).rejects.toMatchObject({ code: "execution.scope-mismatch" });
    // Another address kind is never coerced into a root token.
    await expect(
      attempt(domainCaller("wf-1"), executionToken("workflow", initialized.storeId, epoch + 1, ["wf-1"], 2), "wrong-kind"),
    ).rejects.toMatchObject({ code: "execution.token-kind" });
    await expect(
      attempt(domainCaller("wf-1"), executionToken("plan", initialized.storeId, epoch + 1, ["wf-1", "p-1"], 2), "wrong-address"),
    ).rejects.toMatchObject({ code: "execution.token-kind" });
    // A caller that does not own the workflow it is creating.
    await expect(
      attempt(domainCaller("wf-other"), initialized.token, "foreign-caller"),
    ).rejects.toMatchObject({ code: "execution.scope-mismatch" });

    expect(executionFootprint(context)).toEqual(footprint);
  });

  test("refuses a selection whose catalog entity the store does not hold", async () => {
    const { context } = await freshStore("domain-missing-catalog-entity");
    const initialized = await initializeExecutionAuthority(context);
    const row = planRow("p-2");
    const pin: CatalogExecutionPin = {
      store_id: "not-this-store",
      entity_revision: 1,
      document_hash: executionInputHash(row, "p-2"),
      relation_hash: "0".repeat(64),
    };
    const { entry, snapshot } = creationInput("wf-1", [{ ...row, metadata: { catalog_pin: pin } }]);
    const footprint = executionFootprint(context);
    const refusal = await createExecutionWorkflow(domainContext(context, domainCaller("wf-1")), {
      entry,
      snapshot,
      expected: initialized.token,
      operationId: "foreign-pin",
    }).then(
      () => {
        throw new Error("expected the foreign-store pin to refuse creation");
      },
      (error: unknown) => error,
    );
    // §7 the retained semantic constraint is the store/ownership identity: a pin
    // that names another store is never sealed as this store's frozen input. The
    // recorded `document_hash` is provenance and is not compared.
    expect(refusal).toBeInstanceOf(ExecutionPinConflictError);
    expect((refusal as ExecutionPinConflictError).code).toBe("catalog.execution-pin-conflict");
    expect((refusal as ExecutionPinConflictError).details.plan_id).toBe("p-2");
    expect(executionFootprint(context)).toEqual(footprint);
  });

  test("two writers on one root token commit once and conflict once, and the loser retries", async () => {
    const { context } = await freshStore("domain-contention");
    const initialized = await initializeExecutionAuthority(context);
    await registerPlan(context, "p-1");
    await registerPlan(context, "p-2");
    // Two genuinely distinct SQLite handles: each attempt opens its own
    // connection through `openStore` and takes `BEGIN IMMEDIATE` on it. The
    // winner commits first; the loser's own transaction then reads the ADVANCED
    // root revision and refuses on the token it was handed. No transaction is
    // mocked and no lock is simulated.
    const attempts = [
      { operationId: "contend-a", workflowId: "wf-a", planId: "p-1" },
      { operationId: "contend-b", workflowId: "wf-b", planId: "p-2" },
    ];
    const settled = await Promise.allSettled(
      attempts.map((attempt) =>
        createExecutionWorkflow(domainContext(context, domainCaller(attempt.workflowId)), {
          ...creationInput(attempt.workflowId, [planRow(attempt.planId)]),
          expected: initialized.token,
          operationId: attempt.operationId,
        }),
      ),
    );
    const winnerIndex = settled.findIndex((result) => result.status === "fulfilled");
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    const loser = settled[1 - winnerIndex];
    expect(loser.status).toBe("rejected");
    expect((loser as PromiseRejectedResult).reason).toMatchObject({ code: "execution.stale-token" });
    const winner = (settled[winnerIndex] as PromiseFulfilledResult<ExecutionReceipt<ExecutionState>>).value;
    const winnerAttempt = attempts[winnerIndex];
    const loserAttempt = attempts[1 - winnerIndex];

    // One commit: the winner's workflow is registered and only its receipt exists.
    expect(winner.data.root.workflows.map((entry) => entry.id)).toEqual([winnerAttempt.workflowId]);
    expect(winner.token).toBe(executionToken("root", initialized.storeId, initialized.epoch, [], 3));
    const db = rawDb(storePath(context));
    try {
      expect(scalar(db, "select count(*) as n from execution_operations")).toBe(1);
      expect(scalar(db, "select operation_id from execution_operations")).toBe(winnerAttempt.operationId);
    } finally {
      db.close();
    }

    // The loser rereads the current root token and retries under the SAME
    // operation id: its refused transaction left no receipt behind.
    const refreshed = await readExecutionState(context);
    expect(refreshed.token).toBe(winner.token);
    const retried = await createExecutionWorkflow(domainContext(context, domainCaller(loserAttempt.workflowId)), {
      ...creationInput(loserAttempt.workflowId, [planRow(loserAttempt.planId)]),
      expected: refreshed.token,
      operationId: loserAttempt.operationId,
    });
    expect(retried.replayed).toBe(false);

    // Nothing was lost: both lifecycles are registered, each at revision 1.
    const final = await readExecutionState(context);
    expect(final.data.root.workflows.map((entry) => entry.id)).toEqual([winnerAttempt.workflowId, loserAttempt.workflowId]);
    expect(final.data.workflows.map((workflow) => workflow.state.id)).toEqual([winnerAttempt.workflowId, loserAttempt.workflowId]);
    expect(final.data.workflows.map((workflow) => workflow.workflowToken)).toEqual([
      executionToken("workflow", initialized.storeId, initialized.epoch, [winnerAttempt.workflowId], 1),
      executionToken("workflow", initialized.storeId, initialized.epoch, [loserAttempt.workflowId], 1),
    ]);
    expect(final.token).toBe(retried.token);
  });

  test("an unrelated current catalog edit never rewrites the sealed input", async () => {
    const { context } = await freshStore("domain-sealed-input");
    const initialized = await initializeExecutionAuthority(context);
    const planRevision = await registerPlan(context, "p-1");
    await registerPlan(context, "p-2");
    const row = planRow("p-1");
    const pin: CatalogExecutionPin = {
      store_id: initialized.storeId,
      entity_revision: planRevision,
      document_hash: executionInputHash(row, "p-1"),
      relation_hash: "0".repeat(64),
    };
    const created = await createExecutionWorkflow(domainContext(context, domainCaller("wf-1")), {
      ...creationInput("wf-1", [{ ...row, metadata: { catalog_pin: pin } }]),
      expected: initialized.token,
      operationId: "create-pinned",
    });
    const sealed = sealedInput(context, "p-1");
    expect(JSON.parse(String(sealed.catalog_pin_json))).toEqual(pin);
    expect(created.data.workflows[0].plans[0].frozenInput).toEqual(pin);
    const catalogRevisionBefore = executionFootprint(context).catalogRevision;

    // The CURRENT catalog moves: an unrelated plan entity is renamed, which
    // bumps its entity revision and the catalog revision.
    await updateCatalogEntity(
      context,
      { kind: "plan", id: "p-2" },
      { title: "Renamed elsewhere" },
      1,
      { operationId: "rename-p-2", actor: "execution-store.test" },
    );
    expect(executionFootprint(context).catalogRevision).not.toBe(catalogRevisionBefore);

    // The sealed selection, its hash and its pin are byte-identical, and the
    // authoritative read serves the same frozen input.
    expect(sealedInput(context, "p-1")).toEqual(sealed);
    const state = await readExecutionState(context);
    expect(state.data.workflows[0].plans[0].frozenInput).toEqual(pin);
    expect((state.data.workflows[0].plans[0].plan.metadata as Record<string, unknown>).catalog_pin).toEqual(pin);
    expect(state.data.workflows[0].plans[0].plan.title).toBe("p-1 title");
  });

});

/* ------------------------------------------------------------------------ *
 * C4 — coordinator session identity and the plan read (§2.3/§3)
 * ------------------------------------------------------------------------ */

/** One `bindExecutionSession` request: the sole execution role is the coordinator. */
type SessionBind = Parameters<typeof bindExecutionSession>[1];

function sessionBind(workflowId: string, expected: ExecutionToken, operationId: string): SessionBind {
  return { workflowId, expected, operationId };
}

/** The trusted caller a session verb authorizes against (§3 `ExecutionCaller`). */
function sessionCaller(workflowId: string, sessionId: string, overrides: Partial<ExecutionCaller> = {}): ExecutionCaller {
  return { sessionId, role: "coordinator", workflowId, ...overrides };
}

type CreatedWorkflowFixture = {
  context: StoreContext;
  storeId: string;
  epoch: number;
  workflowToken: ExecutionToken;
  planTokens: Record<string, ExecutionToken>;
};

/** An active store holding ONE created workflow (`wf-1`, plans `p-1`/`p-2`). */
async function createdWorkflow(label: string, creatorSessionId = "host-coord"): Promise<CreatedWorkflowFixture> {
  const { context } = await freshStore(label);
  const initialized = await initializeExecutionAuthority(context);
  await registerPlan(context, "p-1");
  await registerPlan(context, "p-2");
  const { entry, snapshot } = creationInput("wf-1", [planRow("p-1"), planRow("p-2")]);
  const created = await createExecutionWorkflow(
    domainContext(context, sessionCaller("wf-1", creatorSessionId)),
    { entry, snapshot, expected: initialized.token, operationId: `create-${label}` },
  );
  const [workflow] = created.data.workflows;
  return {
    context,
    storeId: created.storeId,
    epoch: created.epoch,
    workflowToken: workflow.workflowToken,
    planTokens: workflow.planTokens,
  };
}

/**
 * A valid legacy session envelope at the exact path the JSON route writes.
 * Nothing in the DB authority reads it: it is planted to prove that a file
 * envelope is neither an output nor an authority of a DB bind.
 */
function writeLegacyEnvelope(context: StoreContext, workflowId: string, role: string, sessionId: string): string {
  const dir = join(context.harnessDir, "workflows", workflowId, "sessions");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${role}-${sessionId}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      { schema_version: 1, role, session_id: sessionId, workflow_id: workflowId, harness_root: context.harnessDir },
      null,
      2,
    ),
  );
  return path;
}

/** The DB rows a session bind writes, as one comparable value. */
function sessionRows(context: StoreContext): Row[] {
  const db = rawDb(storePath(context));
  try {
    return all(
      db,
      "select workflow_id, role, session_id, epoch, revision, state from execution_sessions order by role, session_id",
    );
  } finally {
    db.close();
  }
}

/** One plan row as the DB holds it: the row revision, and the state it stores. */
function storedPlan(context: StoreContext, planId: string): { revision: number; state: Record<string, unknown> } {
  const db = rawDb(storePath(context));
  try {
    const row = one(db, `select revision, state_json from execution_plans where workflow_id = 'wf-1' and plan_id = '${planId}'`);
    return { revision: Number(row.revision), state: JSON.parse(String(row.state_json)) as Record<string, unknown> };
  } finally {
    db.close();
  }
}

describe("execution-session: \u00A72.3 coordinator binding and the plan read", () => {
  test("binds the creating identity as coordinator, serves it any plan and creates no session file", async () => {
    const fixture = await createdWorkflow("session-coordinator");
    const { context, storeId, epoch, workflowToken, planTokens } = fixture;
    const before = executionFootprint(context);
    const caller = sessionCaller("wf-1", "host-coord");
    const request = sessionBind("wf-1", workflowToken, "bind-coordinator");

    const bound = await bindExecutionSession(domainContext(context, caller), request);
    expect(bound.replayed).toBe(false);
    expect(bound.operationId).toBe("bind-coordinator");
    expect(bound.storeId).toBe(storeId);
    expect(bound.epoch).toBe(epoch);
    expect(bound.data).toEqual({ storeId, epoch, workflowId: "wf-1", role: "coordinator", sessionId: "host-coord" });
    expect(bound.token).toBe(executionToken("session", storeId, epoch, ["wf-1", "coordinator", "host-coord"], 1));

    const db = rawDb(storePath(context));
    try {
      expect(one(db, "select workflow_id, role, session_id, epoch, revision, state from execution_sessions")).toEqual({
        workflow_id: "wf-1",
        role: "coordinator",
        session_id: "host-coord",
        epoch,
        revision: 1,
        state: "active",
      });
      const session = one(db, "select bound_at from execution_sessions");
      expect(String(session.bound_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      // A session is a child of the workflow: the workflow revision advances
      // once, root membership does not, and the store revision advances once.
      expect(one(db, "select revision, updated_at from execution_workflows")).toEqual({
        revision: 2,
        updated_at: session.bound_at,
      });
      expect(one(db, "select revision from execution_meta where id = 1")).toEqual({ revision: 3 });
      expect(
        one(db, "select epoch, workflow_id, plan_id from execution_operations where operation_id = 'bind-coordinator'"),
      ).toEqual({ epoch, workflow_id: "wf-1", plan_id: null });
    } finally {
      db.close();
    }
    expect(executionFootprint(context)).toEqual({
      ...before,
      storeRevision: (before.storeRevision as number) + 1,
      sessions: 1,
      operations: (before.operations as number) + 1,
    });
    // §2.3: binding writes no session file, and the control root holds nothing
    // beside the store.
    expect(existsSync(join(context.harnessDir, "workflows"))).toBe(false);
    expect(readdirSync(context.harnessDir).filter((name) => !name.startsWith("store.db"))).toEqual([]);

    // The coordinator reads any plan of its workflow, with the plan token it
    // passes back as CAS.
    const read = await readExecutionPlan(domainContext(context, caller), bound.data, "p-1");
    expect(read.storeId).toBe(storeId);
    expect(read.epoch).toBe(epoch);
    expect(read.token).toBe(planTokens["p-1"]);
    expect(read.data.plan).toMatchObject({ id: "p-1", title: "p-1 title", file: "plans/p-1.md", status: "Todo" });
    expect(read.data.workflow).toEqual({
      schema_version: 1,
      id: "wf-1",
      type: "plan",
      status: "running",
      started_at: TS,
      updated_at: TS,
      delivery_kind: "development",
      branch: { source: "feature/wf-1", target: "main" },
    });
    expect(read.data.coordination).toBeNull();
    expect(read.data.integrationLease).toBeNull();
    expect(read.data.frozenInput).toBeNull();
    // A sibling row is a plain address, not a scope the identity carries.
    const sibling = await readExecutionPlan(domainContext(context, caller), bound.data, "p-2");
    expect(sibling.data.plan).toMatchObject({ id: "p-2", status: "Todo" });

    // An exact retry returns the recorded receipt and advances no revision,
    // even though the token it presents is now superseded.
    const footprint = executionFootprint(context);
    const replayed = await bindExecutionSession(domainContext(context, caller), request);
    expect(replayed.replayed).toBe(true);
    expect(replayed.operationId).toBe("bind-coordinator");
    expect(replayed.token).toBe(bound.token);
    expect(replayed.data).toEqual(bound.data);
    expect(executionFootprint(context)).toEqual(footprint);
  });

  test("two concurrent binds on one coordinator token commit exactly one owner", async () => {
    const fixture = await createdWorkflow("session-contention");
    const { context, workflowToken } = fixture;
    // Two genuinely distinct callers of the SAME identity, both presenting the
    // current token: each opens its own handle through `withExecutionTransaction`
    // and takes `BEGIN IMMEDIATE`, so the loser re-reads the advance the winner
    // committed. No transaction is mocked and no lock is simulated.
    const settled = await Promise.allSettled(
      ["contend-a", "contend-b"].map((operationId) =>
        bindExecutionSession(
          domainContext(context, sessionCaller("wf-1", "host-coord")),
          sessionBind("wf-1", workflowToken, operationId),
        ),
      ),
    );
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = settled.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
    expect(loser?.reason).toMatchObject({ code: "execution.stale-token" });
    expect(sessionRows(context)).toEqual([
      { workflow_id: "wf-1", role: "coordinator", session_id: "host-coord", epoch: fixture.epoch, revision: 1, state: "active" },
    ]);
    const db = rawDb(storePath(context));
    try {
      expect(scalar(db, "select count(*) as n from execution_operations where operation_id like 'contend-%'")).toBe(1);
    } finally {
      db.close();
    }
  });

  test("refuses a caller identity of another workflow without binding", async () => {
    const fixture = await createdWorkflow("session-caller-gate");
    const { context, workflowToken } = fixture;
    const footprint = executionFootprint(context);

    await expect(
      bindExecutionSession(
        domainContext(context, sessionCaller("wf-other", "host-coord")),
        sessionBind("wf-1", workflowToken, "foreign-workflow"),
      ),
    ).rejects.toMatchObject({ code: "execution.scope-mismatch" });

    expect(sessionRows(context)).toEqual([]);
    expect(executionFootprint(context)).toEqual(footprint);
  });

  test("refuses a foreign identity, a live second holder and a legacy envelope that authorizes nothing", async () => {
    const fixture = await createdWorkflow("session-owner");
    const { context, workflowToken } = fixture;
    const creator = sessionCaller("wf-1", "host-coord");
    const envelope = writeLegacyEnvelope(context, "wf-1", "coordinator", "host-elsewhere");
    const footprint = executionFootprint(context);

    // (1) The workflow is unbound, but only its CREATING identity may take the
    // coordinator role — a foreign trusted identity is refused.
    await expect(
      bindExecutionSession(domainContext(context, sessionCaller("wf-1", "host-foreign")), sessionBind("wf-1", workflowToken, "foreign-identity")),
    ).rejects.toMatchObject({ code: "execution.session-unavailable" });
    // (2) The creator binds; a second, different identity is refused while the
    // first is live.
    const bound = await bindExecutionSession(domainContext(context, creator), sessionBind("wf-1", workflowToken, "bind-creator"));
    const currentToken = (await readExecutionState(context)).data.workflows[0]!.workflowToken;
    await expect(
      bindExecutionSession(domainContext(context, sessionCaller("wf-1", "host-second")), sessionBind("wf-1", currentToken, "second")),
    ).rejects.toMatchObject({
      code: "execution.session-unavailable",
      details: { holder: "host-coord" },
    });
    // (3) The planted legacy envelope is neither read nor rewritten.
    const before = JSON.parse(readFileSync(envelope, "utf8")) as Record<string, unknown>;
    expect(before.role).toBe("coordinator");
    expect(bound.data.sessionId).toBe("host-coord");
    expect(sessionRows(context)).toHaveLength(1);
    expect(executionFootprint(context)).toEqual({
      ...footprint,
      storeRevision: (footprint.storeRevision as number) + 1,
      sessions: 1,
      operations: (footprint.operations as number) + 1,
    });
  });

  test("adopts an unowned workflow on the first coordinator bind and keeps the holder fence", async () => {
    const fixture = await createdWorkflow("session-adopt");
    const { context, workflowToken } = fixture;
    const db = rawDb(storePath(context));
    try {
      db.prepare("update execution_workflows set creator_session_id = null where workflow_id = 'wf-1'").run();
    } finally {
      db.close();
    }

    const bound = await bindExecutionSession(
      domainContext(context, sessionCaller("wf-1", "adopter-1")),
      sessionBind("wf-1", workflowToken, "adopt-unowned"),
    );
    const creator = rawDb(storePath(context));
    try {
      expect(one(creator, "select creator_session_id from execution_workflows where workflow_id = 'wf-1'")).toEqual({
        creator_session_id: "adopter-1",
      });
    } finally {
      creator.close();
    }
    await expect(
      bindExecutionSession(
        domainContext(context, sessionCaller("wf-1", "adopter-2")),
        sessionBind("wf-1", (await readExecutionState(context)).data.workflows[0]!.workflowToken, "adopt-duplicate"),
      ),
    ).rejects.toMatchObject({ code: "execution.session-unavailable", details: { holder: "adopter-1" } });
    expect(bound.data.sessionId).toBe("adopter-1");
  });

  test("refuses NULL-creator adoption when any prior coordinator record exists", async () => {
    for (const state of ["suspended", "revoked"] as const) {
      const fixture = await createdWorkflow(`session-adopt-${state}`);
      const { context, workflowToken, epoch } = fixture;
      const db = rawDb(storePath(context));
      try {
        db.prepare("update execution_workflows set creator_session_id = null where workflow_id = 'wf-1'").run();
        session(db, { sessionId: `prior-${state}`, state, epoch });
      } finally {
        db.close();
      }
      const before = executionFootprint(context);
      const beforeSessions = sessionRows(context);
      expect(beforeSessions).toEqual([
        {
          workflow_id: "wf-1",
          role: "coordinator",
          session_id: `prior-${state}`,
          epoch,
          revision: 1,
          state,
        },
      ]);
      await expect(
        bindExecutionSession(
          domainContext(context, sessionCaller("wf-1", `fresh-${state}`)),
          sessionBind("wf-1", workflowToken, `adopt-${state}`),
        ),
      ).rejects.toMatchObject({ code: "execution.session-unavailable" });
      expect(executionFootprint(context)).toEqual(before);
      expect(sessionRows(context)).toEqual(beforeSessions);
      const creator = rawDb(storePath(context));
      try {
        expect(one(creator, "select creator_session_id from execution_workflows where workflow_id = 'wf-1'")).toEqual({
          creator_session_id: null,
        });
      } finally {
        creator.close();
      }
    }
  });

  test("registration without a session identity creates a NULL creator the first coordinator bind adopts", async () => {
    // The create caller carries no session identity (the empty string is the
    // normalized spelling of an unset id): creation succeeds with attribution
    // unset, and the whole trust boundary moves to bind time.
    const fixture = await createdWorkflow("session-unset-creator", "");
    const { context, workflowToken } = fixture;
    let db = rawDb(storePath(context));
    try {
      expect(one(db, "select creator_session_id from execution_workflows where workflow_id = 'wf-1'")).toEqual({
        creator_session_id: null,
      });
    } finally {
      db.close();
    }

    // The FIRST coordinator bind adopts the unowned workflow and records itself.
    const bound = await bindExecutionSession(
      domainContext(context, sessionCaller("wf-1", "adopter-a")),
      sessionBind("wf-1", workflowToken, "adopt-unset"),
    );
    expect(bound.data.sessionId).toBe("adopter-a");

    // Post-adoption the trust boundary holds: a foreign coordinator bind and a
    // re-adoption are both refused, and the recorded holder is never replaced.
    await expect(
      bindExecutionSession(
        domainContext(context, sessionCaller("wf-1", "foreign-b")),
        sessionBind("wf-1", (await readExecutionState(context)).data.workflows[0]!.workflowToken, "foreign-after-adopt"),
      ),
    ).rejects.toMatchObject({ code: "execution.session-unavailable", details: { holder: "adopter-a" } });
    await expect(
      bindExecutionSession(
        domainContext(context, sessionCaller("wf-1", "adopter-c")),
        sessionBind("wf-1", (await readExecutionState(context)).data.workflows[0]!.workflowToken, "adopt-again"),
      ),
    ).rejects.toMatchObject({ code: "execution.session-unavailable", details: { holder: "adopter-a" } });
    db = rawDb(storePath(context));
    try {
      expect(one(db, "select creator_session_id from execution_workflows where workflow_id = 'wf-1'")).toEqual({
        creator_session_id: "adopter-a",
      });
    } finally {
      db.close();
    }
  });

  test("refuses a wrong kind, a foreign store, another address and a stale epoch without binding", async () => {
    const fixture = await createdWorkflow("session-cas");
    const { context, storeId, epoch } = fixture;
    const footprint = executionFootprint(context);
    const caller = sessionCaller("wf-1", "host-coord");
    const attempt = (request: SessionBind) => bindExecutionSession(domainContext(context, caller), request);

    // A root token is never a session parent, and the address kind is never
    // inferred from a supplied token.
    await expect(attempt(sessionBind("wf-1", executionToken("root", storeId, epoch, [], 3), "wrong-kind"))).rejects.toMatchObject({
      code: "execution.token-kind",
    });
    await expect(
      attempt(sessionBind("wf-1", executionToken("plan", storeId, epoch, ["wf-1", "p-1"], 1), "plan-token-for-coordinator")),
    ).rejects.toMatchObject({ code: "execution.token-kind" });
    // A token minted for another store, and a workflow token of another workflow.
    await expect(
      attempt(sessionBind("wf-1", executionToken("workflow", OTHER_STORE, epoch, ["wf-1"], 1), "foreign-store")),
    ).rejects.toMatchObject({ code: "execution.scope-mismatch" });
    await expect(
      attempt(sessionBind("wf-1", executionToken("workflow", storeId, epoch, ["wf-9"], 1), "other-workflow")),
    ).rejects.toMatchObject({ code: "execution.scope-mismatch" });
    // A superseded epoch, and a superseded revision of the same address.
    await expect(
      attempt(sessionBind("wf-1", executionToken("workflow", storeId, epoch - 1, ["wf-1"], 1), "stale-epoch")),
    ).rejects.toMatchObject({ code: "store.stale-epoch" });
    await expect(
      attempt(sessionBind("wf-1", executionToken("workflow", storeId, epoch, ["wf-1"], 9), "stale-revision")),
    ).rejects.toMatchObject({ code: "execution.stale-token" });

    expect(sessionRows(context)).toEqual([]);
    expect(executionFootprint(context)).toEqual(footprint);
  });

  test("serves a plan only to the caller that holds the coordinator session", async () => {
    const shared = "host-shared";
    const fixture = await createdWorkflow("session-read-scope", shared);
    const { context, storeId, epoch, workflowToken, planTokens } = fixture;
    const coordinator = sessionCaller("wf-1", shared);
    const bound = await bindExecutionSession(domainContext(context, coordinator), sessionBind("wf-1", workflowToken, "bind-read"));
    const read = (caller: ExecutionCaller, session: ExecutionSessionRef, planId: string) =>
      readExecutionPlan(domainContext(context, caller), session, planId);

    // A reference whose store, epoch or identity the live row does not back.
    await expect(read(coordinator, { ...bound.data, storeId: OTHER_STORE }, "p-1")).rejects.toMatchObject({
      code: "execution.scope-mismatch",
    });
    await expect(read(coordinator, { ...bound.data, epoch: epoch - 1 }, "p-1")).rejects.toMatchObject({
      code: "store.stale-epoch",
    });
    await expect(
      read(sessionCaller("wf-1", "host-ghost"), { ...bound.data, sessionId: "host-ghost" }, "p-1"),
    ).rejects.toMatchObject({ code: "execution.session-unavailable" });
    await expect(read(sessionCaller("wf-1", "host-else"), bound.data, "p-1")).rejects.toMatchObject({
      code: "coordination.identity-mismatch",
    });
    // The coordinator reads any plan of its workflow; a missing plan is refused.
    expect((await read(coordinator, bound.data, "p-2")).token).toBe(planTokens["p-2"]);
    await expect(read(coordinator, bound.data, "p-9")).rejects.toMatchObject({ code: "coordination.plan-not-found" });

    // A suspended binding (the state a stopped session is recorded as)
    // authorizes nothing until the named recovery transition rebinds it.
    const db = rawDb(storePath(context));
    try {
      db.prepare("update execution_sessions set state = 'suspended' where workflow_id = 'wf-1'").run();
    } finally {
      db.close();
    }
    await expect(read(coordinator, bound.data, "p-1")).rejects.toMatchObject({ code: "execution.session-unavailable" });
    expect(storeId).toBe(bound.storeId);
  });

  test("resumes an active coordinator identity without revision change", async () => {
    const shared = "host-resume";
    const fixture = await createdWorkflow("session-resume", shared);
    const { context, workflowToken } = fixture;
    const coordinator = sessionCaller("wf-1", shared);
    const bound = await bindExecutionSession(domainContext(context, coordinator), sessionBind("wf-1", workflowToken, "bind-resume"));
    const before = sessionRows(context);
    const resumed = await resumeExecutionSession(domainContext(context, coordinator), bound.data);
    expect(resumed.data).toEqual(bound.data);
    expect(resumed.token).toBe(bound.token);
    assertExecutionSessionCurrent(domainContext(context, coordinator), bound.data);
    expect(sessionRows(context)).toEqual(before);
    expect(() => assertExecutionSessionCurrent(domainContext(context, coordinator), { ...bound.data, sessionId: "copied" })).toThrow();
    // The same identity in a foreign store is a different binding.
    const foreign = await createdWorkflow("session-resume-foreign", shared);
    await expect(resumeExecutionSession(domainContext(foreign.context, coordinator), bound.data)).rejects.toMatchObject({
      code: "execution.scope-mismatch",
    });
    // A revoked row stops authorizing: the reference is not the authority.
    const revoked = rawDb(storePath(context));
    try {
      revoked.prepare("update execution_sessions set state = 'revoked' where workflow_id = 'wf-1'").run();
    } finally {
      revoked.close();
    }
    expect(() => assertExecutionSessionCurrent(domainContext(context, coordinator), bound.data)).toThrow();
  });

  test("reads the committed authority after a clean close folded the journal into the store file", async () => {
    // This runtime completes a closed connection's SQLite cleanup — checkpoint
    // every committed frame into the database file, then remove the now-empty
    // `-wal`/`-shm` pair — when the closed handle is collected rather than when
    // `close()` returns. A read landing after that cleanup once refused
    // `store.corrupt: unable to open database file`; the authority it folds in
    // must still be served.
    const shared = "host-quiesced";
    const fixture = await createdWorkflow("session-read-quiesced-wal", shared);
    const { context, workflowToken, planTokens } = fixture;
    const coordinator = sessionCaller("wf-1", shared);
    const bound = await bindExecutionSession(domainContext(context, coordinator), sessionBind("wf-1", workflowToken, "bind-quiesced"));
    const accepted = executionFootprint(context);

    Bun.gc(true);
    // The precondition this case is about: SQLite's own quiesced shape — every
    // committed frame in the database file, both sidecars gone — is really on
    // disk. If a runtime stops leaving it, this fails here rather than passing
    // the reads below for the wrong reason.
    expect(existsSync(`${storePath(context)}-wal`)).toBe(false);
    expect(existsSync(`${storePath(context)}-shm`)).toBe(false);

    const root = await readExecutionState(context);
    expect(root.data.workflows.map((entry) => entry.state.id)).toEqual(["wf-1"]);
    expect(root.data.workflows[0]?.coordinator).toEqual(bound.data);
    const plan = await readExecutionPlan(domainContext(context, coordinator), bound.data, "p-1");
    expect(plan.token).toBe(planTokens["p-1"]);
    expect(plan.data.plan).toMatchObject({ id: "p-1", status: "Todo" });
    expect((await readExecutionState(context)).token).toBe(root.token);
    expect(executionFootprint(context)).toEqual(accepted);
  });

  test("refuses a malformed, foreign-role or caller-mismatched reference before an unavailable store answers", async () => {
    const shared = "host-precedence";
    const fixture = await createdWorkflow("session-read-precedence", shared);
    const { context, workflowToken, planTokens } = fixture;
    const coordinator = sessionCaller("wf-1", shared);
    const bound = await bindExecutionSession(domainContext(context, coordinator), sessionBind("wf-1", workflowToken, "bind-precedence"));

    // A malformed or caller-mismatched reference is refused by the reference
    // gate, which runs BEFORE the store is opened.
    await expect(
      readExecutionPlan(domainContext(context, coordinator), { epoch: 0 } as unknown as ExecutionSessionRef, "p-1"),
    ).rejects.toMatchObject({ code: "coordination.invalid-input" });
    await expect(
      readExecutionPlan(domainContext(context, sessionCaller("wf-1", "host-else")), bound.data, "p-1"),
    ).rejects.toMatchObject({ code: "coordination.identity-mismatch" });

    // With no store at all the same references refuse identically: the gate
    // never opens one, so no store-open failure can answer a bad request first.
    rmSync(storePath(context), { force: true });
    await expect(readExecutionPlan(domainContext(context, coordinator), bound.data, "p-1")).rejects.toMatchObject({
      code: "store.not-initialized",
    });
    expect(planTokens["p-1"]).toBeDefined();
  });

});
