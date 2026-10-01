import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { archiveStoreUpgradeFiles } from "./store-upgrade-archive.js";

function attestation() {
  return {
    version: 1,
    attestedAt: "2026-09-21T00:00:00.000Z",
    operator: { actor: "ops-engineer", authorizationRef: "D29" },
    consumers: [
      {
        entryId: "cli",
        kind: "cli" as const,
        entrypoint: "/usr/local/bin/mstar",
        runtime: "bun" as const,
        runtimeVersion: "1.4.0",
        version: "3.11.0",
        current: false,
        disposition: "upgraded" as const,
      },
      {
        entryId: "coordinator",
        kind: "coordinator" as const,
        entrypoint: "/Users/operator/.omp/plugin",
        runtime: "node" as const,
        runtimeVersion: "24.18.0",
        version: "3.11.0",
        current: true,
        disposition: "reloaded" as const,
      },
    ],
    stoppedSessions: [{ sessionId: "old-session", host: "omp", state: "stopped" as const }],
  };
}

test("raw archive preserves unreadable database and SQLite sidecar bytes before interpretation", async () => {
  const harnessDir = join(root, "fixture", ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const originals: Record<string, Buffer> = {
    [join(harnessDir, "store.db")]: Buffer.from("not a sqlite database\0\xff"),
    [join(harnessDir, "store.db-wal")]: Buffer.from([0, 1, 2, 255]),
    [join(harnessDir, "store.db-shm")]: Buffer.from([9, 8, 7]),
  };
  for (const [path, bytes] of Object.entries(originals)) writeFileSync(path, bytes);

  const archive = await archiveStoreUpgradeFiles({ harnessDir }, "unreadable-fixture", attestation());

  expect(archive.archivePath).toBe(join(harnessDir, "archived", "store-upgrade", "unreadable-fixture"));
  expect(archive.files).toHaveLength(Object.keys(originals).length);
  for (const record of archive.files) {
    const original = originals[record.sourcePath]!;
    const saved = readFileSync(record.archivePath);
    expect(saved).toEqual(original);
    expect(record.bytes).toBe(original.length);
    expect(record.sha256).toBe(createHash("sha256").update(original).digest("hex"));
  }
  const audit = JSON.parse(readFileSync(join(archive.archivePath, "audit.json"), "utf8"));
  expect(audit.quiescence).toBe("operator-attestation-stoppedSessions");
  expect(audit.exclusion).toBe("relies on operator declaration; not enforced by code");
  expect(audit.stoppedSessions).toEqual(attestation().stoppedSessions);
});

test("raw archive rejects a changed source during capture and publishes nothing", async () => {
  const harnessDir = join(root, "concurrent-fixture", ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const source = join(harnessDir, "store.db");
  const original = Buffer.from("stable initial bytes");
  writeFileSync(source, original);
  const archivePath = join(harnessDir, "archived", "store-upgrade", "changed-fixture");
  // A non-regular sidecar refuses before publication and leaves the database unchanged.
  mkdirSync(`${source}-wal`);
  await expect(archiveStoreUpgradeFiles({ harnessDir }, "changed-fixture", attestation())).rejects.toThrow(
    "source is not a regular file",
  );
  expect(readFileSync(source)).toEqual(original);
  expect(() => readFileSync(archivePath)).toThrow();
});

test("unwritable archive path refuses without modifying the source bytes", async () => {
  const harnessDir = join(root, "unwritable-fixture", ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const source = join(harnessDir, "store.db");
  const original = Buffer.from("preserve me");
  writeFileSync(source, original);
  writeFileSync(join(harnessDir, "archived"), "blocks archive directory creation");

  await expect(archiveStoreUpgradeFiles({ harnessDir }, "cannot-write", attestation())).rejects.toThrow("store upgrade archive refused");
  expect(readFileSync(source)).toEqual(original);
});
const root = mkdtempSync(join(tmpdir(), "mstar-store-upgrade-archive-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

