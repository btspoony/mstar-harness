import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, mkdtempSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { storeDbPath, type StoreContext } from "./store-db.js";
import { withExecutionMaintenanceLock } from "./store-activation.js";
import { withStatusWriteLock } from "./lease.js";

export type StoreUpgradeArchive = {
  archivePath: string;
  files: Array<{ sourcePath: string; archivePath: string; bytes: number; sha256: string }>;
};

/**
 * Copy and verify raw store files before any recovery path can displace them.
 * This intentionally does not parse SQLite or staged metadata.
 */
export async function archiveStoreUpgradeFiles(context: StoreContext, operationId: string): Promise<StoreUpgradeArchive> {
  const dbPath = storeDbPath(context);
  const root = dirname(dbPath);
  const parent = join(root, "archived", "store-upgrade");
  const archivePath = join(parent, operationId);
  let temporaryPath: string | undefined;
  try {
    mkdirSync(parent, { recursive: true });
    if (existsSync(archivePath)) throw new Error(`archive already exists at ${archivePath}`);
    temporaryPath = mkdtempSync(join(parent, `.${operationId}.tmp-`));
    return await withExecutionMaintenanceLock(context, () =>
      withStatusWriteLock(join(root, "status.json"), () => {
        const candidates = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
        const files: StoreUpgradeArchive["files"] = [];
        for (const sourcePath of candidates) {
          if (!existsSync(sourcePath)) continue;
          const stat = statSync(sourcePath);
          if (!stat.isFile()) throw new Error(`source is not a regular file: ${sourcePath}`);
          const outputPath = join(temporaryPath!, relative(root, sourcePath));
          mkdirSync(dirname(outputPath), { recursive: true });
          copyFileSync(sourcePath, outputPath);
          const original = readFileSync(sourcePath);
          const archived = readFileSync(outputPath);
          const originalDigest = createHash("sha256").update(original).digest("hex");
          const archivedDigest = createHash("sha256").update(archived).digest("hex");
          if (original.length !== archived.length || originalDigest !== archivedDigest) {
            throw new Error(`verification failed for ${sourcePath}: size or SHA-256 mismatch`);
          }
          files.push({ sourcePath, archivePath: join(archivePath, relative(root, sourcePath)), bytes: archived.length, sha256: archivedDigest });
        }
        if (files.length === 0) throw new Error("no store files were present to preserve");
        renameSync(temporaryPath!, archivePath);
        return { archivePath, files };
      }),
    );
  } catch (error) {
    if (temporaryPath !== undefined) rmSync(temporaryPath, { recursive: true, force: true });
    throw new Error(`store upgrade archive refused: ${error instanceof Error ? error.message : String(error)}`);
  }
}
