import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, SCHEMA_VERSION_TABLE_SQL, migrationChecksum } from "./store-db.js";

/** Build an isolated historical schema for migration tests, never live authority. */
export function historicalStore(harnessDir: string, schemaVersion: number): DatabaseSync {
  const db = new DatabaseSync(join(harnessDir, "store.db"));
  try {
    db.exec("pragma foreign_keys=on; begin immediate");
    db.exec(SCHEMA_VERSION_TABLE_SQL);
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= schemaVersion)) {
      db.exec(migration.sql);
      db.prepare("insert into schema_version values(?, ?, ?, ?)").run(
        migration.version, migration.name, migrationChecksum(migration), "2026-09-01T00:00:00Z",
      );
    }
    db.exec("update store_meta set authority_state='active' where id=1; commit");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
