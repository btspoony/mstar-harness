import { join } from "node:path";
import { upgradeStore, type StoreContext } from "./store-db.js";
import { backupStore, type ActivationAttestation, type BackupReceipt } from "./store-activation.js";
import {
  activateExecutionMigration,
  applyExecutionMigration,
  collectExecutionCoverage,
  executionManifestHash,
  previewExecutionMigration,
  retireExecutionSources,
  type ExecutionManifest,
  type ExecutionMigrationReceipt,
} from "./execution-migrate.js";
import { probeStoreUpgradeState } from "./store-upgrade-state.js";

export type StoreUpgradeInput = {
  context: StoreContext;
  operator: string;
  operationId: string;
  inventoryPath?: string;
};

/** Durable output before the only irreversible authority transition. */
export type StagedStoreUpgrade = {
  context: StoreContext;
  operator: string;
  operationId: string;
  inventoryPath?: string;
  manifest: ExecutionManifest;
  manifestHash: string;
  /** Pre-schema recovery point; retained to recover a failed schema upgrade. */
  schemaBackup: BackupReceipt;
  /** Reviewed-schema recovery point required by apply's identity guard. */
  backup: BackupReceipt;
  coverageDigest: string;
};

/** Derive the manifest, verified recovery point, and byte-backed coverage, then stage. */
export async function stageStoreUpgrade(input: StoreUpgradeInput): Promise<StagedStoreUpgrade> {
  const state = await probeStoreUpgradeState(input.context);
  if (!state.storeExists || state.verdict === "blocked") {
    throw new Error(`store upgrade is blocked: ${state.reasons.join(", ") || "store is unavailable"}`);
  }

  // Keep a verified point before schema writes, then take a second point of
  // the migrated schema for apply's exact reviewed-store identity guard.
  const schemaBackup = await backupStore(input.context);
  if (state.schemaVersion !== null) await upgradeStore(input.context);
  const migrationBackup = await backupStore(input.context, {
    out: join(input.context.harnessDir, "archived", "store-migration", "backups", `${input.operationId}-reviewed.db`),
  });

  const request = { ...input, operationId: `${input.operationId}-preview` };
  const manifest = await previewExecutionMigration(request);
  const manifestHash = executionManifestHash(manifest);
  const coverage = await collectExecutionCoverage({ ...request, operationId: `${input.operationId}-coverage`, manifest });
  await applyExecutionMigration({
    ...request,
    operationId: `${input.operationId}-apply`,
    manifest,
    manifestHash,
    backup: migrationBackup,
    coverage,
  });
  return { ...input, manifest, manifestHash, schemaBackup, backup: migrationBackup, coverageDigest: coverage.digest };
}
/** Flip authority and retire reviewed sources under their existing guards. */
export async function activateStoreUpgrade(
  staged: StagedStoreUpgrade,
  attestation: ActivationAttestation,
): Promise<ExecutionMigrationReceipt> {
  await activateExecutionMigration({
    context: staged.context,
    operator: staged.operator,
    inventoryPath: staged.inventoryPath,
    manifestId: staged.manifest.id,
    manifestHash: staged.manifestHash,
    attestation,
    operationId: `${staged.operationId}-activate`,
  });
  return retireExecutionSources({
    context: staged.context,
    operator: staged.operator,
    inventoryPath: staged.inventoryPath,
    manifestId: staged.manifest.id,
    manifestHash: staged.manifestHash,
    operationId: `${staged.operationId}-retire`,
  });
}
