import { join } from "node:path";
import { backupStore, type ActivationAttestation, type BackupReceipt } from "./store-activation.js";
import { openStore, upgradeStore, type StoreContext } from "./store-db.js";
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
import type { ExecutionCoverageSet } from "./execution-coverage.js";
import { probeStoreUpgradeState } from "./store-upgrade-state.js";
import { listPendingCatalogRegistrations, retireStaleCatalogExecutionsForMigration } from "./catalog-registration.js";


export type StoreUpgradeInput = {
  context: StoreContext;
  operator: string;
  operationId: string;
  /** Explicit operator disposition for any stale unpublished registration retired at staging. */
  catalogDeltaDisposition: string;
  inventoryPath?: string;
  /**
   * The operator's attestation. Coverage counts the declared stopped sessions
   * against the imported session owners; staging passes it through so the
   * coverage evidence sees the operator's declaration.
   */
  attestation?: ActivationAttestation;
};


type StagedStoreUpgradeBase = {
  context: StoreContext;
  operator: string;
  operationId: string;
  inventoryPath?: string;
  manifest: ExecutionManifest;
  manifestHash: string;
  coverageDigest: string;
};

/** Durable output before the only irreversible authority transition. */
export type StagedStoreUpgrade =
  | (StagedStoreUpgradeBase & {
      resumed: false;
      schemaBackup: BackupReceipt;
      backup: BackupReceipt;
    })
  | (StagedStoreUpgradeBase & {
      resumed: true;
    });

/** Take a verified pre-schema recovery point, then advance the store schema. */
export async function upgradeStoreWithRecoveryPoint(
  context: StoreContext,
  operationId: string,
): Promise<{ schemaVersion: number; schemaBackup: BackupReceipt }> {
  const state = await probeStoreUpgradeState(context);
  if (!state.storeExists || state.verdict === "blocked" || state.schemaVersion === null) {
    throw new Error(`store upgrade is blocked: ${state.reasons.join(", ") || "store is unavailable"}`);
  }
  const schemaBackup = await backupStore(context, {
    out: join(context.harnessDir, "archived", "store-migration", "backups", `${operationId}-pre-schema.db`),
  });
  const upgraded = await upgradeStore(context);
  return { schemaVersion: upgraded.schemaVersion, schemaBackup };
}

async function resumeStagedStoreUpgrade(input: StoreUpgradeInput, manifestId: string): Promise<StagedStoreUpgrade> {
  const store = await openStore(input.context, "read");
  try {
    const row = store.db
      .prepare("select manifest_hash, phase, manifest_json, coverage_json from execution_migrations where manifest_id = ?")
      .get(manifestId) as
      | { manifest_hash?: unknown; phase?: unknown; manifest_json?: unknown; coverage_json?: unknown }
      | undefined;
    if (
      row?.phase !== "staged" ||
      typeof row.manifest_hash !== "string" ||
      typeof row.manifest_json !== "string" ||
      typeof row.coverage_json !== "string"
    ) {
      throw new Error(
        `store upgrade found execution authority staged under ${JSON.stringify(manifestId)}, but its persisted staged migration ` +
          "record is missing or incomplete; do not re-preview or apply a different manifest",
      );
    }
    let manifest: ExecutionManifest;
    let coverage: ExecutionCoverageSet;
    try {
      manifest = JSON.parse(row.manifest_json) as ExecutionManifest;
      coverage = JSON.parse(row.coverage_json) as ExecutionCoverageSet;
    } catch {
      throw Object.assign(
        new Error("store upgrade found malformed JSON in the persisted staged manifest or coverage record"),
        { code: "store.upgrade-staged-record-malformed" },
      );
    }
    if (
      executionManifestHash(manifest) !== row.manifest_hash ||
      typeof coverage.digest !== "string" ||
      !/^[0-9a-f]{64}$/.test(coverage.digest)
    ) {
      throw new Error(
        `store upgrade found a staged migration ${JSON.stringify(manifestId)} whose persisted manifest or coverage identity is ` +
          "inconsistent; refusing to re-preview or apply another manifest",
      );
    }
    if (input.inventoryPath !== undefined && input.inventoryPath !== manifest.inventoryPath) {
      throw new Error(
        `store upgrade retry inventory ${JSON.stringify(input.inventoryPath)} does not match the staged manifest scope ` +
          `${JSON.stringify(manifest.inventoryPath)}; resume with the reviewed inventory or omit --inventory to use it`,
      );
    }
    return {
      context: input.context,
      operator: input.operator,
      operationId: input.operationId,
      ...(manifest.inventoryPath === null ? {} : { inventoryPath: manifest.inventoryPath }),
      manifest,
      manifestHash: row.manifest_hash,
      coverageDigest: coverage.digest,
      resumed: true,
    };
  } finally {
    store.close();
  }
}

/** Derive the manifest, verified recovery point, and byte-backed coverage, then stage. */
export async function stageStoreUpgrade(input: StoreUpgradeInput): Promise<StagedStoreUpgrade> {
  const state = await probeStoreUpgradeState(input.context);
  if (!state.storeExists || state.verdict === "blocked") {
    throw new Error(`store upgrade is blocked: ${state.reasons.join(", ") || "store is unavailable"}`);
  }
  if (state.executionAuthorityState === "staged") {
    if (state.manifestId === null || state.executionMigrationPhase !== "staged") {
      throw new Error("store upgrade found a staged execution authority without its matching recorded manifest; refusing to re-preview");
    }
    return await resumeStagedStoreUpgrade(input, state.manifestId);
  }

  // Each attempt owns distinct recovery artifacts; a prior partial attempt can
  // never make the next invocation fail solely because its backup exists.
  const { schemaBackup } = await upgradeStoreWithRecoveryPoint(input.context, input.operationId);
  const migrationBackup = await backupStore(input.context, {
    out: join(input.context.harnessDir, "archived", "store-migration", "backups", `${input.operationId}-reviewed.db`),
  });

  const request = { ...input, operationId: `${input.operationId}-preview` };
  // A stale, already-written registration cannot be reconciled against the
  // current catalog revision. Retire only that case before the read-only
  // preview; ordinary and reconcilable pending rows still refuse.
  const pending = await listPendingCatalogRegistrations(input.context);
  if (pending.length > 0) {
    await retireStaleCatalogExecutionsForMigration(
      input.context,
      pending.map((row) => row.operationId),
      input.catalogDeltaDisposition,
    );
  }

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
  return { ...input, manifest, manifestHash, schemaBackup, backup: migrationBackup, coverageDigest: coverage.digest, resumed: false };
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
    coverageDigest: staged.coverageDigest,
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
