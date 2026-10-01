import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { storeDbPath, type StoreContext } from "./store-db.js";
import { validateActivationAttestation, type ActivationAttestation } from "./store-activation.js";

export type StoreUpgradeArchive = {
  archivePath: string;
  files: Array<{ sourcePath: string; archivePath: string; bytes: number; sha256: string }>;
};

/**
 * Preserve an unreadable store's raw image. This is not a restoration backup:
 * the operator's validated stoppedSessions declaration is the quiescence
 * boundary, not code-enforced writer exclusion.
 */
export async function archiveStoreUpgradeFiles(
  context: StoreContext,
  operationId: string,
  attestation: ActivationAttestation,
): Promise<StoreUpgradeArchive> {
  const validated = validateActivationAttestation(attestation);
  const dbPath = storeDbPath(context);
  const root = dirname(dbPath);
  const parent = join(root, "archived", "store-upgrade");
  const archivePath = join(parent, operationId);
  let temporaryPath: string | undefined;
  try {
    mkdirSync(parent, { recursive: true });
    if (existsSync(archivePath)) throw new Error(`archive already exists at ${archivePath}`);
    temporaryPath = mkdtempSync(join(parent, `.${operationId}.tmp-`));
    const candidates = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
    const files: StoreUpgradeArchive["files"] = [];
    const initial = candidates.filter(existsSync).map((sourcePath) => {
      // lstat, not stat: a sidecar that is a link to another file would
      // otherwise have its target's bytes captured as SQLite sidecar data,
      // publishing an archive that misrepresents the store image.
      const stat = lstatSync(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`source is not a regular file: ${sourcePath}`);
      const bytes = readFileSync(sourcePath);
      return { sourcePath, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
    if (initial.length === 0) throw new Error("no store files were present to preserve");
    for (const source of initial) {
      const outputPath = join(temporaryPath, relative(root, source.sourcePath));
      mkdirSync(dirname(outputPath), { recursive: true });
      copyFileSync(source.sourcePath, outputPath);
      const archived = readFileSync(outputPath);
      const sourceNow = readFileSync(source.sourcePath);
      const archivedDigest = createHash("sha256").update(archived).digest("hex");
      const sourceNowDigest = createHash("sha256").update(sourceNow).digest("hex");
      if (
        archived.length !== source.bytes.length ||
        archivedDigest !== source.sha256 ||
        sourceNow.length !== source.bytes.length ||
        sourceNowDigest !== source.sha256
      ) {
        throw new Error(`concurrent writer or verification mismatch while capturing ${source.sourcePath}`);
      }
      files.push({
        sourcePath: source.sourcePath,
        archivePath: join(archivePath, relative(root, source.sourcePath)),
        bytes: archived.length,
        sha256: archivedDigest,
      });
    }
    writeFileSync(
      join(temporaryPath, "audit.json"),
      `${JSON.stringify({
        version: 1,
        capture: "raw-unreadable-store",
        quiescence: "operator-attestation-stoppedSessions",
        exclusion: "relies on operator declaration; not enforced by code",
        stoppedSessions: validated.stoppedSessions,
        files: files.map(({ sourcePath, archivePath: savedPath, bytes, sha256 }) => ({
          sourcePath,
          archivePath: savedPath,
          bytes,
          sha256,
        })),
      })}\n`,
      { flag: "wx" },
    );
    renameSync(temporaryPath, archivePath);
    return { archivePath, files };
  } catch (error) {
    if (temporaryPath !== undefined) rmSync(temporaryPath, { recursive: true, force: true });
    throw new Error(`store upgrade archive refused: ${error instanceof Error ? error.message : String(error)}`);
  }
}
