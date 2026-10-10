import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withProtectedWrite } from "../src/coordination-write.js";
import { createFsStore } from "../src/store.js";

describe("FsStore protected aliases", () => {
  test("a json alias through a symlinked parent cannot create a not-yet-existing protected file (PR241-G4)", async () => {
    const root = mkdtempSync(join(tmpdir(), "coordination-alias-parent-"));
    try {
      const canonical = realpathSync(root);
      mkdirSync(join(canonical, "workflows"), { recursive: true });
      symlinkSync(canonical, join(canonical, "alias"), "dir");
      const snapshotPath = join(canonical, "workflows", "wf-symlink-parent", "snapshot.json");
      const snapshotAlias = join(canonical, "alias", "workflows", "wf-symlink-parent", "snapshot.json");
      const statusAlias = join(canonical, "alias", "status.json");
      const store = createFsStore(canonical);

      await expect(store.put({ kind: "json", key: snapshotAlias, payload: { id: "wf-symlink-parent" } })).rejects.toMatchObject({
        code: "coordination.direct-write-refused",
      });
      await expect(store.put({ kind: "json", key: statusAlias, payload: { version: 2 } })).rejects.toMatchObject({
        code: "coordination.direct-write-refused",
      });
      expect(existsSync(snapshotPath)).toBe(false);
      expect(existsSync(join(canonical, "status.json"))).toBe(false);

      const notesAlias = join(canonical, "alias", "notes.json");
      await store.put({ kind: "json", key: notesAlias, payload: { note: "escape hatch" } });
      await expect(store.get({ kind: "json", key: notesAlias })).resolves.toEqual({ note: "escape hatch" });
      await withProtectedWrite(snapshotPath, "put", () =>
        store.put({ kind: "json", key: snapshotAlias, payload: { id: "wf-symlink-parent" } }),
      );
      expect(existsSync(snapshotPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
