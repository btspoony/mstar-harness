import { existsSync } from "node:fs";
import { openStore, storeDbPath, type StoreContext } from "./store-db.js";

export type StoreUpgradeReason = "store-missing" | "execution-authority-legacy" | "execution-authority-staged";

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
    const operations = store.db
      .prepare("select operation_id from catalog_operations where phase not in ('committed', 'aborted') order by operation_id")
      .all() as Array<{ operation_id?: unknown }>;
    const execution = store.execution;
    const reasons: StoreUpgradeReason[] = [];
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
