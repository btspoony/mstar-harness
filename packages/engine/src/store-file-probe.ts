/**
 * store-file-probe.ts — TEST-ONLY: observe a store file without changing it.
 *
 * Shared by the store suites and by `store-test-runtime.ts`, which is bundled
 * with `bun build --target node` and executed as a child process, so this module
 * acquires no SQLite driver at import time and imports no test APIs: the caller
 * passes the driver's constructor in (`DatabaseSync`).
 */
import { existsSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

/**
 * The store file's own bytes: WAL in the header, and no `-wal`/`-shm` beside it.
 * The shape SQLite's own clean close leaves behind. An unreadable file is not
 * quiesced; the read that raised the error keeps the reporting.
 */
export function isQuiescedWalStoreFile(dbPath: string): boolean {
  try {
    const header = readFileSync(dbPath).subarray(0, 100);
    return header[18] === 2 && header[19] === 2 && !existsSync(`${dbPath}-wal`) && !existsSync(`${dbPath}-shm`);
  } catch {
    return false;
  }
}

/**
 * Read a store file without changing it, through the real driver.
 *
 * SQLite reads a WAL database THROUGH its `-wal` file, so a store whose last
 * clean close folded the journal into the database file cannot be read by a
 * plain read-only open at all: node:sqlite creates that empty journal inside its
 * own open, while Bun refuses with SQLITE_CANTOPEN "unable to open database
 * file". The `immutable` form reads the same bytes without the WAL machinery,
 * which is exact for the quiesced shape - the database file holds the whole
 * committed state - so it is tried only for that shape: every other store keeps
 * the ordinary read-only open, and a broken file still reports its own error.
 */
export function withRawRead<T>(Open: typeof DatabaseSync, dbPath: string, run: (db: DatabaseSync) => T): T {
  const read = (spec: string): T => {
    const db = new Open(spec, { readOnly: true });
    try {
      return run(db);
    } finally {
      db.close();
    }
  };
  try {
    return read(dbPath);
  } catch (error) {
    if (!isQuiescedWalStoreFile(dbPath)) throw error;
    return read(`file:${dbPath}?immutable=1`);
  }
}
