import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeStore, MIGRATIONS, migrationChecksum, MIGRATION_1_SQL, SCHEMA_VERSION_TABLE_SQL } from "./store-db.js";
import { probeStoreUpgradeState } from "./store-upgrade-state.js";

async function fixture(): Promise<{ dir: string; db: DatabaseSync }> {
  const dir = mkdtempSync(join(tmpdir(), "mstar-upgrade-state-"));
  const store = await initializeStore({ harnessDir: dir });
  store.close();
  const db = new DatabaseSync(join(dir, "store.db"));
  db.exec("update execution_meta set authority_state = 'active', manifest_id = 'manifest-1' where id = 1");
  db.prepare("insert into execution_migrations(manifest_id, manifest_hash, phase, manifest_json, created_at, updated_at) values (?, ?, ?, '{}', ?, ?)")
    .run("manifest-1", "hash-1", "retired", "now", "now");
  return { dir, db };
}

function migrationOneFixture(): { dir: string; db: DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), "mstar-upgrade-state-v1-"));
  const db = new DatabaseSync(join(dir, "store.db"));
  const migration = MIGRATIONS[0]!;
  db.exec(SCHEMA_VERSION_TABLE_SQL);
  db.exec(MIGRATION_1_SQL);
  db.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)").run(
    migration.version,
    migration.name,
    migrationChecksum(migration),
    "now",
  );
  return { dir, db };
}

describe("probeStoreUpgradeState", () => {
  test("reports current when both independent authorities are active", async () => {
    const { dir, db } = await fixture();
    try {
      db.close();
      const result = await probeStoreUpgradeState({ harnessDir: dir });
      expect(result).toMatchObject({ storeExists: true, storeAuthorityState: "active", executionAuthorityState: "active", manifestId: "manifest-1", pendingCatalogOperations: { count: 0, ids: [] }, verdict: "up-to-date", reasons: [] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("reports empty active authority current without a migration retirement record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mstar-upgrade-state-empty-"));
    const store = await initializeStore({ harnessDir: dir });
    store.db.exec("update execution_meta set authority_state = 'active', manifest_id = null where id = 1");
    store.close();
    try {
      const result = await probeStoreUpgradeState({ harnessDir: dir });
      expect(result).toMatchObject({
        executionAuthorityState: "active",
        executionMigrationPhase: null,
        verdict: "up-to-date",
        reasons: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("keeps ACTIVE authority upgrade-required until recorded retirement is complete", async () => {
    const { dir, db } = await fixture();
    try {
      db.prepare("update execution_migrations set phase = 'active' where manifest_id = 'manifest-1'").run();
      db.close();
      const result = await probeStoreUpgradeState({ harnessDir: dir });
      expect(result).toMatchObject({
        executionAuthorityState: "active",
        executionMigrationPhase: "active",
        verdict: "upgrade-required",
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("keeps schema work pending for ACTIVE authority with retained migration history", async () => {
    const { dir, db } = await fixture();
    try {
      db.prepare("delete from schema_version where version = ?").run(MIGRATIONS.length);
      db.close();
      const result = await probeStoreUpgradeState({ harnessDir: dir });
      expect(result).toMatchObject({
        executionAuthorityState: "active",
        executionMigrationPhase: "retired",
        verdict: "upgrade-required",
        reasons: ["schema-upgrade-pending"],
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("requires upgrade for legacy execution authority, independently of store authority", async () => {
    const { dir, db } = await fixture();
    try {
      db.exec("update execution_meta set authority_state = 'legacy', manifest_id = null where id = 1");
      db.close();
      const result = await probeStoreUpgradeState({ harnessDir: dir });
      expect(result.storeAuthorityState).toBe("active");
      expect(result.executionAuthorityState).toBe("legacy");
      expect(result.verdict).toBe("upgrade-required");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("pending catalog operations are reported but do not block the upgrade", async () => {
    const { dir, db } = await fixture();
    try {
      const insert = db.prepare("insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, created_at, updated_at) values (?, ?, ?, '{}', '{}', '{}', ?, ?)");
      for (const phase of ["prepared", "execution-written", "aborted", "committed"]) {
        insert.run(`op-${phase}`, "hash", phase, "now", "now");
      }
      db.exec("update execution_meta set authority_state = 'legacy', manifest_id = null where id = 1");
      db.close();
      const result = await probeStoreUpgradeState({ harnessDir: dir });
      expect(result.pendingCatalogOperations).toEqual({
        count: 3,
        ids: ["op-aborted", "op-execution-written", "op-prepared"],
      });
      expect(result.verdict).toBe("upgrade-required");
      expect(result.verdict).not.toBe("blocked");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("blocks a missing store without creating it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mstar-upgrade-state-missing-"));
    try {
      const result = await probeStoreUpgradeState({ harnessDir: dir });
      expect(result.verdict).toBe("blocked");
      expect(result.reasons).toEqual(["store-missing"]);
      expect(result.storeExists).toBe(false);
      expect(existsSync(join(dir, "store.db"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("reports migration-one schema readiness without querying absent catalog tables", async () => {
    const { dir, db } = migrationOneFixture();
    try {
      db.close();
      const result = await probeStoreUpgradeState({ harnessDir: dir });
      expect(result).toMatchObject({
        storeExists: true,
        schemaVersion: 1,
        storeAuthorityState: "staged",
        executionAuthorityState: null,
        pendingCatalogOperations: { count: 0, ids: [] },
        verdict: "upgrade-required",
        reasons: ["schema-upgrade-pending"],
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
