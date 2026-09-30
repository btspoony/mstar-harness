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
  backup: BackupReceipt;
  coverageDigest: string;
};

/** Derive the manifest, verified recovery point, and byte-backed coverage, then stage. */
export async function stageStoreUpgrade(input: StoreUpgradeInput): Promise<StagedStoreUpgrade> {
  const state = await probeStoreUpgradeState(input.context);
  if (!state.storeExists || state.verdict === "blocked") {
    throw new Error(`store upgrade is blocked: ${state.reasons.join(", ") || "store is unavailable"}`);
  }

  // A recovery point must precede schema upgrades as well as migration writes.
  const backup = await backupStore(input.context);
  if (state.schemaVersion !== null) await upgradeStore(input.context);

  const request = { ...input, operationId: `${input.operationId}-preview` };
  const manifest = await previewExecutionMigration(request);
  const manifestHash = executionManifestHash(manifest);
  const coverage = await collectExecutionCoverage({ ...request, operationId: `${input.operationId}-coverage`, manifest });
  await applyExecutionMigration({
    ...request,
    operationId: `${input.operationId}-apply`,
    manifest,
    manifestHash,
    backup,
    coverage,
  });
  return { ...input, manifest, manifestHash, backup, coverageDigest: coverage.digest };
}

/** Perform the one authority transition; source retirement remains a later call. */
export async function activateStoreUpgrade(
  staged: StagedStoreUpgrade,
  attestation: ActivationAttestation,
): Promise<ExecutionMigrationReceipt> {
  return activateExecutionMigration({
    context: staged.context,
    operator: staged.operator,
    inventoryPath: staged.inventoryPath,
    manifestId: staged.manifest.id,
    manifestHash: staged.manifestHash,
    attestation,
    operationId: `${staged.operationId}-activate`,
  });
}

/** Retire only after a separately completed activation call. */
export async function retireStoreUpgrade(staged: StagedStoreUpgrade): Promise<ExecutionMigrationReceipt> {
  return retireExecutionSources({
    context: staged.context,
    operator: staged.operator,
    inventoryPath: staged.inventoryPath,
    manifestId: staged.manifest.id,
    manifestHash: staged.manifestHash,
    operationId: `${staged.operationId}-retire`,
  });
}
