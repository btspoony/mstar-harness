import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeStore } from "./store-db.js";
import { probeStoreUpgradeState } from "./store-upgrade-state.js";

async function fixture(): Promise<{ dir: string; db: DatabaseSync }> {
  const dir = mkdtempSync(join(tmpdir(), "mstar-upgrade-state-"));
  const store = await initializeStore({ harnessDir: dir });
  store.close();
  const db = new DatabaseSync(join(dir, "store.db"));
  db.exec("update store_meta set authority_state = 'active' where id = 1");
  db.exec("update execution_meta set authority_state = 'active', manifest_id = 'manifest-1' where id = 1");
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
      db.prepare("insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, created_at, updated_at) values (?, ?, 'prepared', '{}', '{}', '{}', ?, ?)").run("op-pending", "hash", "now", "now");
      db.exec("update execution_meta set authority_state = 'legacy', manifest_id = null where id = 1");
      db.close();
      const result = await probeStoreUpgradeState({ harnessDir: dir });
      expect(result.pendingCatalogOperations).toEqual({ count: 1, ids: ["op-pending"] });
      expect(result.verdict).toBe("upgrade-required");
      expect(result.verdict).not.toBe("blocked");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
