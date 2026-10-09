/**
 * Protected-writers CAS family.
 *
 * The coordinator's file-route plan writer is retired (the ACTIVE execution
 * authority owns plan operations now), but the coordinated-artifact replacement
 * path it shares with the persist family survives: the root status is replaced
 * under the write lock, a root that registers a coordinated workflow is refused
 * on either side, the retired residuals register is never a write target, and an
 * unauthorized coordinator cannot replace a snapshot. The catalog execution pin
 * and registration-gate cases that drove the removed `prepare`/`bind` file
 * transport are covered by the ACTIVE route's own suites.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCoordinatedArtifact, replaceCoordinatedArtifact } from "../src/coordination.js";
import { withProtectedWrite } from "../src/coordination-write.js";
import { createFsStore } from "../src/store.js";
import {
  PROJECT_ID,
  WORKFLOW_ID,
  afterEachCleanup,
  errorCodeOf,
  makeFixture,
  readJson,
  writeJson,
} from "./support/coordination-fixtures.js";

afterEach(() => afterEachCleanup());

describe("protected-writers", () => {
  const STATUS_REF = { kind: "status", key: "root" } as const;

  test("the root status is replaced under the write lock without a byte-version precondition", async () => {
    const fixture = makeFixture();
    const harnessRoot = realpathSync(fixture.harness);
    const statusPath = join(harnessRoot, "status.json");
    const empty = { version: 2, updated_at: "2026-09-16", workflows: [] };

    // An intervening prose/formatting edit is not a refusal condition.
    writeFileSync(statusPath, `${readFileSync(statusPath, "utf8")}\n`);
    const replaced = await replaceCoordinatedArtifact({
      harnessRoot,
      ref: STATUS_REF,
      payload: empty,
    });
    expect(replaced.payload).toEqual(empty);
    expect((await readCoordinatedArtifact(harnessRoot, STATUS_REF)).payload).toEqual(empty);
  });

  test("a root that registers a coordinated workflow is refused on either side", async () => {
    const fixture = makeFixture();
    const harnessRoot = realpathSync(fixture.harness);
    const statusPath = join(harnessRoot, "status.json");
    // The fixture workflow carries a coordination block, so the root that
    // registers it is a "coordinated workflow" the whole-writer cutover refuses.
    writeJson(fixture.snapshotPath, {
      ...readJson(fixture.snapshotPath),
      coordination: {
        coordinator: { session_id: "fixture-coordinator", session_file: join(fixture.workflowDir, "sessions", "coordinator-fixture-coordinator.json"), bound_at: "2026-09-15T00:00:00Z" },
      },
    });
    const coordinated = readJson(statusPath);
    if (!Array.isArray(coordinated.workflows)) throw new Error("fixture root has no workflows array");
    const registered = coordinated.workflows;

    // Current side: the root on disk registers a coordinated workflow.
    expect(
      await errorCodeOf(() =>
        replaceCoordinatedArtifact({
          harnessRoot,
          ref: STATUS_REF,
          payload: coordinated,
        }),
      ),
    ).toBe("coordination.scoped-writer-required");
    expect(readJson(statusPath)).toEqual(coordinated);

    // Proposed side: the current root registers nothing coordinated, the
    // replacement would re-register the coordinated workflow.
    const plain = { version: 2, updated_at: "2026-09-17", workflows: [] };
    writeJson(statusPath, plain);
    expect(
      await errorCodeOf(() =>
        replaceCoordinatedArtifact({
          harnessRoot,
          ref: STATUS_REF,
          payload: { ...plain, workflows: registered },
        }),
      ),
    ).toBe("coordination.scoped-writer-required");
    expect(readJson(statusPath)).toEqual(plain);
  });

  test("a project register replacement is retired and refused outright", async () => {
    const fixture = makeFixture();
    const harnessRoot = realpathSync(fixture.harness);

    // A register that predates coordination is migration history: the
    // replacement surface refuses the retired kind before any CAS.
    const legacyRegister = { entries: { "plan-b": [] } };
    writeJson(fixture.registerPath, legacyRegister);
    expect(
      await errorCodeOf(() =>
        replaceCoordinatedArtifact({
          harnessRoot,
          ref: { kind: "residuals", key: PROJECT_ID } as never,
          payload: { entries: {} },
        }),
      ),
    ).toBe("coordination.store");
    // The retired kind is never a write target: the legacy file is untouched.
    expect(readJson(fixture.registerPath)).toEqual(legacyRegister);
  });

  test("uncoordinated kinds refuse explicitly and only the coordinator replaces a snapshot", async () => {
    const fixture = makeFixture();
    const harnessRoot = realpathSync(fixture.harness);

    // Kinds that keep their own writer are refused, never silently no-oped.
    for (const ref of [{ kind: "review", key: "plan-a" } as const, { kind: "json", key: join(harnessRoot, "loose.json") } as const]) {
      expect(
        await errorCodeOf(() => replaceCoordinatedArtifact({ harnessRoot, ref, payload: {} })),
      ).toBe("coordination.scoped-writer-required");
    }

    // A coordinated snapshot is replaceable by the coordinator only: a session
    // that is not the workflow's live coordinator is refused before the payload
    // is even considered.
    const snapshotRef = { kind: "snapshot", key: WORKFLOW_ID } as const;
    const snapshotPath = join(harnessRoot, "workflows", WORKFLOW_ID, "snapshot.json");
    const snapshot = readJson(snapshotPath);
    const foreign = join(fixture.workflowDir, "sessions", "coordinator-foreign.json");
    writeJson(foreign, {
      schema_version: 1,
      role: "coordinator",
      session_id: "foreign",
      workflow_id: WORKFLOW_ID,
      harness_root: fixture.harness,
    });
    for (const sessionPath of [undefined, foreign]) {
      expect(
        await errorCodeOf(() =>
          replaceCoordinatedArtifact({ harnessRoot, ref: snapshotRef, payload: snapshot, sessionPath }),
        ),
      ).not.toBe(undefined);
    }
  });

  test("a json alias through a symlinked parent cannot create a not-yet-existing protected file (PR241-G4)", async () => {
    const root = mkdtempSync(join(tmpdir(), "coordination-alias-parent-"));
    try {
      // The protected ROOT exists (`workflows/`) but the leaf does not, and the
      // alias parent is a symlink onto the canonical root itself. A class
      // decision that falls back to the lexical path lets that alias land
      // outside the protected prefix and create the protected file.
      const canonical = realpathSync(root);
      mkdirSync(join(canonical, "workflows"), { recursive: true });
      symlinkSync(canonical, join(canonical, "alias"), "dir");
      const snapshotPath = join(canonical, "workflows", WORKFLOW_ID, "snapshot.json");
      const snapshotAlias = join(canonical, "alias", "workflows", WORKFLOW_ID, "snapshot.json");
      const statusAlias = join(canonical, "alias", "status.json");
      const store = createFsStore(canonical);

      await expect(store.put({ kind: "json", key: snapshotAlias, payload: { id: WORKFLOW_ID } })).rejects.toMatchObject({
        code: "coordination.direct-write-refused",
      });
      await expect(store.put({ kind: "json", key: statusAlias, payload: { version: 2 } })).rejects.toMatchObject({
        code: "coordination.direct-write-refused",
      });
      // Refuse-before-write: neither protected document nor its directory exists.
      expect(existsSync(snapshotPath)).toBe(false);
      expect(existsSync(join(canonical, "status.json"))).toBe(false);

      // Unprotected aliases still write (the walk must not over-block), and the
      // protected path itself stays writable from the authorized context.
      await store.put({ kind: "json", key: join(canonical, "alias", "notes.json"), payload: { note: "escape hatch" } });
      const notes = await store.get<Record<string, string>>({ kind: "json", key: join(canonical, "alias", "notes.json") });
      expect(notes).toEqual({ note: "escape hatch" });
      await withProtectedWrite(snapshotPath, "put", () => store.put({ kind: "json", key: snapshotAlias, payload: { id: WORKFLOW_ID } }));
      expect(existsSync(snapshotPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
