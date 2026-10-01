import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { archiveStoreUpgradeFiles } from "./store-upgrade-archive.js";

const root = mkdtempSync(join(tmpdir(), "mstar-store-upgrade-archive-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("raw archive preserves unreadable database and SQLite sidecar bytes before interpretation", async () => {
  const harnessDir = join(root, "fixture", ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const originals: Record<string, Buffer> = {
    [join(harnessDir, "store.db")]: Buffer.from("not a sqlite database\0\xff"),
    [join(harnessDir, "store.db-wal")]: Buffer.from([0, 1, 2, 255]),
    [join(harnessDir, "store.db-shm")]: Buffer.from([9, 8, 7]),
  };
  for (const [path, bytes] of Object.entries(originals)) writeFileSync(path, bytes);

  const archive = await archiveStoreUpgradeFiles({ harnessDir }, "unreadable-fixture");

  expect(archive.archivePath).toBe(join(harnessDir, "archived", "store-upgrade", "unreadable-fixture"));
  expect(archive.files).toHaveLength(Object.keys(originals).length);
  for (const record of archive.files) {
    const original = originals[record.sourcePath]!;
    const saved = readFileSync(record.archivePath);
    expect(saved).toEqual(original);
    expect(record.bytes).toBe(original.length);
    expect(record.sha256).toBe(createHash("sha256").update(original).digest("hex"));
  }
});

test("unwritable archive path refuses without modifying the source bytes", async () => {
  const harnessDir = join(root, "unwritable-fixture", ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const source = join(harnessDir, "store.db");
  const original = Buffer.from("preserve me");
  writeFileSync(source, original);
  writeFileSync(join(harnessDir, "archived"), "blocks archive directory creation");

  await expect(archiveStoreUpgradeFiles({ harnessDir }, "cannot-write")).rejects.toThrow("store upgrade archive refused");
  expect(readFileSync(source)).toEqual(original);
});

