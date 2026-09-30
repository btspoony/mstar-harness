import { existsSync } from "node:fs";
import { MIGRATIONS, openStore, storeDbPath, type StoreContext } from "./store-db.js";

export type StoreUpgradeReason = "store-missing" | "schema-upgrade-pending" | "execution-authority-legacy" | "execution-authority-staged";

export type StoreUpgradeState = {
  storeExists: boolean;
  schemaVersion: number | null;
  storeAuthorityState: string | null;
  executionAuthorityState: string | null;
  manifestId: string | null;
  pendingCatalogOperations: { count: number; ids: string[] };
  verdict: "up-to-date" | "upgrade-required" | "blocked";
  reasons: StoreUpgradeReason[];
};

/** Inspect upgrade readiness without creating or migrating the store. */
export async function probeStoreUpgradeState(context: StoreContext): Promise<StoreUpgradeState> {
  const dbPath = storeDbPath(context);
  if (!existsSync(dbPath)) {
    return {
      storeExists: false,
      schemaVersion: null,
      storeAuthorityState: null,
      executionAuthorityState: null,
      manifestId: null,
      pendingCatalogOperations: { count: 0, ids: [] },
      verdict: "blocked",
      reasons: ["store-missing"],
    };
  }

  const store = await openStore(context, "read");
  try {
    const metadata = store.db.prepare("select authority_state from store_meta where id = 1").get() as
      | { authority_state?: unknown }
      | undefined;
    const operations = store.schemaVersion >= 2
      ? store.db
          .prepare("select operation_id from catalog_operations where phase != 'committed' order by operation_id")
          .all() as Array<{ operation_id?: unknown }>
      : [];
    const reasons: StoreUpgradeReason[] = [];
    const execution = store.execution;
    if (store.schemaVersion < MIGRATIONS.length) reasons.push("schema-upgrade-pending");
    if (execution?.authorityState === "legacy") reasons.push("execution-authority-legacy");
    if (execution?.authorityState === "staged") reasons.push("execution-authority-staged");
    return {
      storeExists: true,
      schemaVersion: store.schemaVersion,
      storeAuthorityState: typeof metadata?.authority_state === "string" ? metadata.authority_state : null,
      executionAuthorityState: execution?.authorityState ?? null,
      manifestId: execution?.manifestId ?? null,
      pendingCatalogOperations: {
        count: operations.length,
        ids: operations.flatMap((row) => typeof row.operation_id === "string" ? [row.operation_id] : []),
      },
      verdict: reasons.length === 0 && execution?.authorityState === "active" ? "up-to-date" : "upgrade-required",
      reasons,
    };
  } finally {
    store.close();
  }
}
