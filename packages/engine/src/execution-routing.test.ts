/**
 * Execution routing — protected-file vetoes and failure closure (plan task W5).
 *
 * Authority: primary spec §4.3 (root/path containment and protected writes) and
 * §5 (failure matrix), on the landed W1–W4 execution authority. Every case runs
 * against the REAL modules, the REAL `node:sqlite` driver and REAL Git
 * worktrees in per-test temporary roots — no mocked database, no mocked
 * filesystem, and no injected failure that the production code could not meet:
 *
 * - `execution-protected-route`: with the control harness's execution authority
 *   ACTIVE, root/snapshot/session file persistence is refused — through the
 *   authorized protected-write context, through a raw store call, through an
 *   injected `ArtifactStore` and before payload validation — while the
 *   legacy/staged route keeps writing exactly as before and no execution row is
 *   created.
 * - `execution-path-safety`: a `json`/symlinked alias of a protected document,
 *   a symlinked parent directory and a store rooted in a foreign workspace
 *   cannot reach the retired documents (classification is by CANONICAL target,
 *   never by basename).
 * - `execution-unavailable`: an active store that is corrupt, schema-drifted or
 *   held past the bounded wait refuses the file route instead of falling back
 *   to JSON.
 *
 * The fixture is a real Git main worktree with `.mstar`: the route guards
 * resolve the CONTROL harness root through `storeDbPath` (main worktree → that
 * harness), so these cases exercise the production resolution instead of an
 * environment override.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readArtifactBytes, withProtectedWrite } from "./coordination-write.js";
import {
  amendPrepareWorkflow,
  mutatePlanCoordination,
  readCoordinatedArtifact,
  readPlanCoordination,
  replaceCoordinatedArtifact,
  sessionFilePath,
  showPrepareWorkflow,
} from "./coordination.js";
import { initializeExecutionAuthority, readExecutionState } from "./execution-store.js";
import { scanActiveLifecycleBranches } from "./lifecycle-branches.js";
import { createFsStore, setArtifactStore, type ArtifactDoc, type ArtifactRef, type ArtifactStore } from "./store.js";
import { initializeStore, openStore, type StoreContext } from "./store-db.js";
import { backupStore } from "./store-activation.js";
import { registerWorkflow, unregisterWorkflow, type WorkflowEntry } from "./status.js";
import {
  closeWorkflow,
  planWorkflowSnapshot,
  readWorkflowSnapshot,
  registerPlanWorkflow,
  writeWorkflowSnapshot,
  type RegisterPlanWorkflowOptions,
  type WorkflowSnapshot,
} from "./workflow.js";

const WORKFLOW_ID = "20260920-routing-workflow";
const PLANTED_ID = "20260920-planted-leftover";

type Fixture = { root: string; harnessDir: string; context: StoreContext };

/** A temp workspace shaped like a real one: a Git main worktree with `.mstar`. */
function workspace(prefix: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const harnessDir = join(root, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  return { root, harnessDir, context: { harnessDir } };
}

async function withStore(fx: Fixture): Promise<void> {
  const handle = await initializeStore(fx.context);
  handle.close();
}

/** Active issue/catalog store AND an ACTIVE execution authority. */
async function activeExecution(fx: Fixture): Promise<void> {
  await withStore(fx);
  await initializeExecutionAuthority(fx.context);
}

/** Flip the recorded execution authority state directly (the store keeps its data). */
async function setExecutionState(fx: Fixture, state: "legacy" | "staged" | "active"): Promise<void> {
  const handle = await openStore(fx.context, "write");
  try {
    handle.db.prepare("update execution_meta set authority_state = ? where id = 1").run(state);
  } finally {
    handle.close();
  }
}

function scalar(context: StoreContext, sql: string): unknown {
  const db = new DatabaseSync(join(context.harnessDir, "store.db"), { readOnly: true });
  try {
    const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
    return row === undefined ? undefined : Object.values(row)[0];
  } finally {
    db.close();
  }
}

function planOptions(fx: Fixture, workflowId: string): RegisterPlanWorkflowOptions {
  return {
    harnessDir: fx.harnessDir,
    plan: { id: `${workflowId}-plan`, title: "A routing plan", file: "plans/routing.md" },
    deliveryKind: "development",
    branchSource: "feature/routing",
    branchTarget: "main",
  };
}

/**
 * Leftover root/snapshot JSON written by a retired (pre-activation) file route
 * — the exact bytes a reader could mistake for authority, and the witness the
 * migration reads. Planted AFTER activation with raw fs writes: the file route
 * itself is what these cases prove unusable.
 */
function plantLeftovers(fx: Fixture, workflowId: string): { statusPath: string; snapshotPath: string; json: string } {
  const statusPath = join(fx.harnessDir, "status.json");
  const snapshotPath = join(fx.harnessDir, "workflows", workflowId, "snapshot.json");
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(
    statusPath,
    `${JSON.stringify(
      { version: 2, updated_at: "2026-09-01", workflows: [{ id: workflowId, type: "plan", status: "running" }] },
      null,
      2,
    )}\n`,
  );
  const json = `${JSON.stringify(
    planWorkflowSnapshot(workflowId, planOptions(fx, workflowId), "2026-09-01T00:00:00.000Z"),
    null,
    2,
  )}\n`;
  writeFileSync(snapshotPath, json);
  return { statusPath, snapshotPath, json };
}

/**
 * The session envelope a retired (pre-activation) file route left behind. It is
 * planted with raw fs writes for the same reason the leftover root/snapshot
 * are: the coordinated entries read it ONLY as the anchor that names the
 * control harness, and the file route that would have created it is what these
 * cases prove unusable.
 */
function plantSessionEnvelope(fx: Fixture): string {
  const sessionPath = sessionFilePath(fx.harnessDir, PLANTED_ID, "coordinator", "leftover-session");
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(
    sessionPath,
    `${JSON.stringify(
      {
        schema_version: 1,
        role: "coordinator",
        session_id: "leftover-session",
        workflow_id: PLANTED_ID,
        harness_root: fx.harnessDir,
      },
      null,
      2,
    )}\n`,
  );
  return sessionPath;
}

/** Injected store that records every durable write (nothing reaches a file). */
function recordingStore(): ArtifactStore & { puts: ArtifactDoc[] } {
  const puts: ArtifactDoc[] = [];
  return {
    puts,
    async put(doc: ArtifactDoc): Promise<void> {
      puts.push(doc);
    },
    async get(): Promise<undefined> {
      return undefined;
    },
  };
}

function requiredDelete(store: ArtifactStore): (ref: ArtifactRef) => Promise<void> {
  const remove = store.delete;
  if (remove === undefined) throw new Error("the FsStore under test must implement delete");
  return (ref) => remove.call(store, ref);
}

async function refusalOf(work: () => Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await work();
    throw new Error("expected a refusal");
  } catch (error) {
    return error as { code?: string; message?: string };
  }
}

/** The stable refusal code of a SYNCHRONOUS legacy reader (which the callers
 * under test do not wrap in a promise), `""` when the error carries none. */
function refusalCodeOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
    return "";
  }
  throw new Error("expected a refusal");
}

afterEach(() => {
  setArtifactStore(undefined);
  delete process.env.MSTAR_STORE_TEST_RUNNER;
  delete process.env.MSTAR_STORE_BUSY_TIMEOUT_MS;
});

describe("execution-protected-route — an ACTIVE execution authority retires the file route", () => {
  test("refuses direct and authorized persistence of the retired root and snapshot, leaving the bytes untouched", async () => {
    const fx = workspace("exec-routing-direct-");
    try {
      await activeExecution(fx);
      const leftovers = plantLeftovers(fx, PLANTED_ID);
      const store = createFsStore(fx.harnessDir);
      const remove = requiredDelete(store);
      const statusBefore = readFileSync(leftovers.statusPath);
      const snapshotBefore = readFileSync(leftovers.snapshotPath);
      const payload = { version: 2, updated_at: "2000-01-01", workflows: [] };

      // (a) The authorized protected-write context is NOT a way around the veto.
      expect(
        await refusalOf(() =>
          withProtectedWrite(leftovers.statusPath, "put", () => store.put({ kind: "status", key: "root", payload })),
        ),
      ).toMatchObject({ code: "execution.direct-write-refused" });

      // (b) A raw put refuses with the SAME authority code: discrimination
      // precedes the protected-write authorization check.
      expect(await refusalOf(() => store.put({ kind: "status", key: "root", payload }))).toMatchObject({
        code: "execution.direct-write-refused",
      });

      // (c) delete is the same route, on both protected kinds.
      expect(
        await refusalOf(() =>
          withProtectedWrite(leftovers.snapshotPath, "delete", () => remove({ kind: "snapshot", key: PLANTED_ID })),
        ),
      ).toMatchObject({ code: "execution.direct-write-refused" });
      expect(await refusalOf(() => remove({ kind: "status", key: "root" }))).toMatchObject({
        code: "execution.direct-write-refused",
      });

      expect(readFileSync(leftovers.statusPath)).toEqual(statusBefore);
      expect(readFileSync(leftovers.snapshotPath)).toEqual(snapshotBefore);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("refuses an injected ArtifactStore through the routed producers and before payload validation", async () => {
    const fx = workspace("exec-routing-injected-");
    try {
      await activeExecution(fx);
      const leftovers = plantLeftovers(fx, PLANTED_ID);
      const snapshotBefore = readFileSync(leftovers.snapshotPath);
      const statusBefore = readFileSync(leftovers.statusPath);

      // (a) The producer writes a snapshot AND a root entry: an INJECTED store
      // records nothing, and no file appears anywhere.
      const injected = recordingStore();
      setArtifactStore(injected);
      expect(await refusalOf(() => registerPlanWorkflow(WORKFLOW_ID, planOptions(fx, WORKFLOW_ID)))).toMatchObject({
        code: "execution.direct-write-refused",
      });
      expect(injected.puts).toEqual([]);
      expect(existsSync(join(fx.harnessDir, "workflows", WORKFLOW_ID))).toBe(false);

      // (b) Authority discrimination precedes the payload checks: an invalid
      // snapshot, an invalid close timestamp and a bare root entry all refuse
      // with the authority code instead of a payload error.
      const snapshotDir = join(fx.harnessDir, "workflows", PLANTED_ID);
      expect(await refusalOf(() => writeWorkflowSnapshot({} as WorkflowSnapshot, snapshotDir))).toMatchObject({
        code: "execution.direct-write-refused",
      });
      expect(await refusalOf(() => closeWorkflow(PLANTED_ID, snapshotDir, { endedAt: "not-a-date" }))).toMatchObject({
        code: "execution.direct-write-refused",
      });
      expect(
        await refusalOf(() =>
          registerWorkflow(join(fx.harnessDir, "status.json"), { id: "wf-bare" } as WorkflowEntry),
        ),
      ).toMatchObject({ code: "execution.direct-write-refused" });
      expect(await refusalOf(() => unregisterWorkflow(join(fx.harnessDir, "status.json"), PLANTED_ID))).toMatchObject({
        code: "execution.direct-write-refused",
      });

      expect(readFileSync(leftovers.snapshotPath)).toEqual(snapshotBefore);
      expect(readFileSync(leftovers.statusPath)).toEqual(statusBefore);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("keeps the legacy and staged route as the sole writer, with no execution row created", async () => {
    for (const state of ["legacy", "staged"] as const) {
      const fx = workspace(`exec-routing-${state}-`);
      try {
        await withStore(fx);
        if (state === "staged") await setExecutionState(fx, "staged");
        const store = createFsStore(fx.harnessDir);
        setArtifactStore(store);

        const produced = await registerPlanWorkflow(WORKFLOW_ID, planOptions(fx, WORKFLOW_ID));
        expect(existsSync(produced.snapshotPath)).toBe(true);
        const rootDoc = JSON.parse(readFileSync(join(fx.harnessDir, "status.json"), "utf8")) as {
          workflows: Array<{ id: string }>;
        };
        expect(rootDoc.workflows.map((entry) => entry.id)).toEqual([WORKFLOW_ID]);

        // The snapshot reader still serves the file as authority.
        expect(readWorkflowSnapshot(dirname(produced.snapshotPath)).snapshot.id).toBe(WORKFLOW_ID);

        // The direct protected path still writes inside the authorized context.
        await withProtectedWrite(join(fx.harnessDir, "status.json"), "put", () =>
          store.put({ kind: "status", key: "root", payload: rootDoc }),
        );

        // The file route is the SOLE writer of these documents.
        expect(scalar(fx.context, "select count(*) as n from execution_workflows")).toBe(0);

        await unregisterWorkflow(join(fx.harnessDir, "status.json"), WORKFLOW_ID);
        const after = JSON.parse(readFileSync(join(fx.harnessDir, "status.json"), "utf8")) as { workflows: unknown[] };
        expect(after.workflows).toEqual([]);

        // The probe re-reads the authority on every call — the CONNECTION is
        // reused, the VERDICT is not: activating the execution domain flips the
        // same workspace to refused, with no restart and no cache staleness.
        await setExecutionState(fx, "active");
        expect(await refusalOf(() => store.put({ kind: "status", key: "root", payload: rootDoc }))).toMatchObject({
          code: "execution.direct-write-refused",
        });
        expect(
          await refusalOf(async () => readWorkflowSnapshot(dirname(produced.snapshotPath))),
        ).toMatchObject({ code: "execution.consumer-not-ready" });
      } finally {
        rmSync(fx.root, { recursive: true, force: true });
      }
    }
  });

  test("refuses the synchronous legacy authority readers while migration's byte witnesses stay readable", async () => {
    const fx = workspace("exec-routing-reads-");
    try {
      await activeExecution(fx);
      const leftovers = plantLeftovers(fx, PLANTED_ID);
      const snapshotDir = dirname(leftovers.snapshotPath);

      // The canonical snapshot authority reader refuses: a consumer may not
      // observe leftover JSON as validated state.
      let code = "";
      try {
        readWorkflowSnapshot(snapshotDir);
        throw new Error("expected a refusal");
      } catch (error) {
        code = (error as { code?: string }).code ?? "";
      }
      expect(code).toBe("execution.consumer-not-ready");

      // Migration's explicit byte-witness read is a diagnostic, not an
      // authority read: it still returns the exact bytes and version.
      const bytes = readArtifactBytes(leftovers.snapshotPath);
      expect(bytes?.payload).toEqual(JSON.parse(leftovers.json));
      expect(String(bytes?.version)).toMatch(/^sha256:[0-9a-f]{64}$/);

      // A real consumer of that reader (the L1 lifecycle register scan) refuses
      // instead of reporting state it read from leftover JSON.
      const scan = scanActiveLifecycleBranches(fx.harnessDir, null);
      expect(scan.kind).toBe("refusal");
      expect(scan.kind === "refusal" ? scan.code : "").toBe("worktree.l1.lifecycle-snapshot-unreadable");

      // The DB adapter is the route the consumer must take instead.
      const state = await readExecutionState(fx.context);
      expect(state.data.root.version).toBe(2);
      expect(state.data.workflows).toEqual([]);
      expect(String(state.token)).toMatch(/^exec-v1:root:/);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("refuses a direct store read of the retired root and snapshot, including a json alias", async () => {
    const fx = workspace("exec-routing-get-");
    try {
      await activeExecution(fx);
      const leftovers = plantLeftovers(fx, PLANTED_ID);
      const store = createFsStore(fx.harnessDir);
      const statusBefore = readFileSync(leftovers.statusPath);
      const snapshotBefore = readFileSync(leftovers.snapshotPath);

      const refs: ArtifactRef[] = [
        { kind: "status", key: "root" },
        { kind: "snapshot", key: PLANTED_ID },
        // A `json` alias resolves to the same canonical target: the same channel.
        { kind: "json", key: leftovers.statusPath },
        { kind: "json", key: leftovers.snapshotPath },
      ];
      for (const ref of refs) {
        expect(await refusalOf(() => store.get(ref))).toMatchObject({ code: "execution.consumer-not-ready" });
      }
      // The seam refuses to SERVE the bytes; it never removes or rewrites them.
      expect(readFileSync(leftovers.statusPath)).toEqual(statusBefore);
      expect(readFileSync(leftovers.snapshotPath)).toEqual(snapshotBefore);

      // The same refusals do not reach a legacy/staged harness: there the seam
      // keeps reading exactly what it read before.
      const legacy = workspace("exec-routing-get-legacy-");
      try {
        await withStore(legacy);
        plantLeftovers(legacy, PLANTED_ID);
        const legacyStore = createFsStore(legacy.harnessDir);
        expect(await legacyStore.get({ kind: "status", key: "root" })).toMatchObject({ version: 2 });
        expect(await legacyStore.get({ kind: "snapshot", key: PLANTED_ID })).toMatchObject({ id: PLANTED_ID });
        expect(await legacyStore.get({ kind: "review", key: "not-written" })).toBeUndefined();
      } finally {
        rmSync(legacy.root, { recursive: true, force: true });
      }
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

describe("execution-entry-boundary — the veto is decided before any payload validation", () => {
  test("every coordinated entry refuses on authority before its request, revision, id, ref, CAS-token or version-token checks", async () => {
    const fx = workspace("exec-routing-entry-");
    try {
      await activeExecution(fx);
      const leftovers = plantLeftovers(fx, PLANTED_ID);
      const sessionPath = plantSessionEnvelope(fx);
      const statusPath = join(fx.harnessDir, "status.json");
      const statusBefore = readFileSync(statusPath);
      const snapshotBefore = readFileSync(leftovers.snapshotPath);

      // mutatePlanCoordination: an unknown operation, an invalid revision and
      // an unexpected request key all sit BEHIND the veto.
      const requests = [
        { sessionPath, planId: PLANTED_ID, expectedRevision: 1, operation: { kind: "no-such-operation" } },
        { sessionPath, planId: PLANTED_ID, expectedRevision: -1, operation: { kind: "progress", progress: {} } },
        {
          sessionPath,
          planId: PLANTED_ID,
          expectedRevision: 1,
          operation: { kind: "progress", progress: {} },
          unexpected: true,
        },
      ];
      for (const request of requests) {
        expect(await refusalOf(() => mutatePlanCoordination(request as never))).toMatchObject({
          code: "execution.direct-write-refused",
        });
      }

      // unregisterWorkflow: the `id` payload check is behind the veto.
      expect(await refusalOf(() => unregisterWorkflow(statusPath, ""))).toMatchObject({
        code: "execution.direct-write-refused",
      });

      // replaceCoordinatedArtifact: the ref shape and the CAS token are behind it.
      expect(
        await refusalOf(() =>
          replaceCoordinatedArtifact({
            harnessRoot: fx.harnessDir,
            ref: { kind: "json", key: "" },
            payload: null,
            expectedVersion: "not-a-version",
            sessionPath,
          }),
        ),
      ).toMatchObject({ code: "execution.direct-write-refused" });

      // amendPrepareWorkflow: both byte-version tokens are behind it.
      expect(
        await refusalOf(() =>
          amendPrepareWorkflow({
            sessionPath,
            expectedSnapshotVersion: "bogus",
            expectedCompassVersion: "bogus",
            patch: {} as never,
          }),
        ),
      ).toMatchObject({ code: "execution.direct-write-refused" });

      // The PM-adjudicated authoritative read wrappers carry the SAME verdict at
      // their OWN entry boundary, ahead of their scope work.
      const reads = [
        () => showPrepareWorkflow({ sessionPath, unexpected: 1 } as never),
        () => readPlanCoordination(sessionPath, 42 as never),
        () => readCoordinatedArtifact(fx.harnessDir, { kind: "json", key: "" }),
      ];
      for (const read of reads) {
        expect(await refusalOf(read)).toMatchObject({ code: "execution.consumer-not-ready" });
      }

      expect(readFileSync(statusPath)).toEqual(statusBefore);
      expect(readFileSync(leftovers.snapshotPath)).toEqual(snapshotBefore);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("the lifecycle scan refuses an active harness at entry, before the register it enumerates is read", async () => {
    const fx = workspace("exec-routing-scan-entry-");
    try {
      await activeExecution(fx);
      // A register the pre-fix scan answers `ok` for: its ONLY entry is the
      // governing workflow, so no sibling snapshot read happens. The veto is
      // therefore decided at the scan's own boundary, not inherited later.
      mkdirSync(join(fx.harnessDir, "workflows", WORKFLOW_ID), { recursive: true });
      writeFileSync(
        join(fx.harnessDir, "status.json"),
        `${JSON.stringify({
          version: 2,
          updated_at: "2026-09-01",
          workflows: [{ id: WORKFLOW_ID, type: "plan", status: "running" }],
        })}\n`,
      );

      const scan = scanActiveLifecycleBranches(fx.harnessDir, WORKFLOW_ID);
      expect(scan.kind).toBe("refusal");
      expect(scan.kind === "refusal" ? scan.code : "").toBe("worktree.l1.lifecycle-snapshot-unreadable");
      expect(scan.kind === "refusal" ? scan.detail : "").toContain("execution.consumer-not-ready");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

describe("execution-path-safety — canonical-target classification, not basenames", () => {
  test("refuses a symlinked alias of the retired root document without touching the alias target", async () => {
    const fx = workspace("exec-routing-alias-");
    try {
      await activeExecution(fx);
      const leftovers = plantLeftovers(fx, PLANTED_ID);
      const alias = join(fx.harnessDir, "alias-status.json");
      symlinkSync(leftovers.statusPath, alias);
      const store = createFsStore(fx.harnessDir);
      const before = readFileSync(leftovers.statusPath);

      expect(
        await refusalOf(() =>
          withProtectedWrite(alias, "put", () =>
            store.put({ kind: "json", key: alias, payload: { version: 2, updated_at: "2000-01-01", workflows: [] } }),
          ),
        ),
      ).toMatchObject({ code: "execution.direct-write-refused" });
      expect(readFileSync(leftovers.statusPath)).toEqual(before);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("refuses a snapshot reached through a symlinked workflow directory", async () => {
    const fx = workspace("exec-routing-symlink-dir-");
    try {
      await activeExecution(fx);
      const leftovers = plantLeftovers(fx, PLANTED_ID);
      const aliasDir = join(fx.harnessDir, "wf-alias");
      symlinkSync(dirname(leftovers.snapshotPath), aliasDir);
      const store = createFsStore(fx.harnessDir);
      const before = readFileSync(leftovers.snapshotPath);

      expect(
        await refusalOf(() =>
          withProtectedWrite(join(aliasDir, "snapshot.json"), "put", () =>
            store.put({
              kind: "json",
              key: join(aliasDir, "snapshot.json"),
              payload: { schema_version: 1, id: PLANTED_ID, type: "plan", status: "running" },
            }),
          ),
        ),
      ).toMatchObject({ code: "execution.direct-write-refused" });
      expect(readFileSync(leftovers.snapshotPath)).toEqual(before);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("a worktree-local decoy store cannot authorize a write to the control harness's documents", async () => {
    const fx = workspace("exec-routing-worktree-");
    const container = mkdtempSync(join(tmpdir(), "exec-routing-worktree-link-"));
    const wtRoot = join(container, "linked");
    try {
      await activeExecution(fx);
      execFileSync("git", ["-c", "user.name=mstar", "-c", "user.email=mstar@example.com", "commit", "--allow-empty", "-q", "-m", "seed"], {
        cwd: fx.root,
      });
      execFileSync("git", ["worktree", "add", "-q", wtRoot, "HEAD"], { cwd: fx.root });
      const wtHarness = join(wtRoot, ".mstar");
      mkdirSync(wtHarness, { recursive: true });
      // The linked worktree carries its own store copy whose execution
      // authority is LEGACY — a decoy. The route guard must judge the target by
      // the CONTROL harness (this repo's main worktree), never by that copy.
      await backupStore(fx.context, { out: join(wtHarness, "store.db") });
      const decoy = new DatabaseSync(join(wtHarness, "store.db"));
      try {
        decoy.exec("update execution_meta set authority_state = 'legacy' where id = 1");
      } finally {
        decoy.close();
      }
      const wtFx: Fixture = { root: wtRoot, harnessDir: wtHarness, context: { harnessDir: wtHarness } };
      const leftovers = plantLeftovers(wtFx, PLANTED_ID);
      const before = readFileSync(leftovers.snapshotPath);

      expect(
        await refusalOf(() =>
          writeWorkflowSnapshot(
            planWorkflowSnapshot(PLANTED_ID, planOptions(wtFx, PLANTED_ID), "2026-09-01T00:00:00.000Z"),
            dirname(leftovers.snapshotPath),
          ),
        ),
      ).toMatchObject({ code: "execution.direct-write-refused" });
      expect(readFileSync(leftovers.snapshotPath)).toEqual(before);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
      rmSync(container, { recursive: true, force: true });
    }
  });

  test("a store rooted in a foreign workspace cannot write the active harness's documents", async () => {
    const fx = workspace("exec-routing-foreign-");
    const foreign = workspace("exec-routing-other-");
    try {
      await activeExecution(fx);
      await withStore(foreign);
      const leftovers = plantLeftovers(fx, PLANTED_ID);
      const before = readFileSync(leftovers.snapshotPath);
      // The foreign store is the ACTIVE store while the target belongs to `fx`.
      setArtifactStore(createFsStore(foreign.harnessDir));

      expect(
        await refusalOf(() =>
          writeWorkflowSnapshot(
            planWorkflowSnapshot(PLANTED_ID, planOptions(fx, PLANTED_ID), "2026-09-01T00:00:00.000Z"),
            dirname(leftovers.snapshotPath),
          ),
        ),
      ).toMatchObject({ code: "execution.direct-write-refused" });
      expect(readFileSync(leftovers.snapshotPath)).toEqual(before);
      expect(existsSync(join(foreign.harnessDir, "workflows", PLANTED_ID))).toBe(false);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
      rmSync(foreign.root, { recursive: true, force: true });
    }
  });
});

describe("execution-unavailable — an unusable store refuses instead of falling back to JSON", () => {
  test("a corrupt active store refuses the file route and writes nothing", async () => {
    const fx = workspace("exec-routing-corrupt-");
    try {
      await activeExecution(fx);
      const leftovers = plantLeftovers(fx, PLANTED_ID);
      const before = readFileSync(leftovers.statusPath);
      for (const suffix of ["-wal", "-shm"]) {
        rmSync(join(fx.harnessDir, `store.db${suffix}`), { force: true });
      }
      writeFileSync(join(fx.harnessDir, "store.db"), "this is not a sqlite database\n");
      const store = createFsStore(fx.harnessDir);

      expect(
        await refusalOf(() =>
          withProtectedWrite(leftovers.statusPath, "put", () =>
            store.put({ kind: "status", key: "root", payload: { version: 2, updated_at: "2000-01-01", workflows: [] } }),
          ),
        ),
      ).toMatchObject({ code: "store.corrupt" });
      expect(readFileSync(leftovers.statusPath)).toEqual(before);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("a schema-drifted active store refuses the file route and writes nothing", async () => {
    const fx = workspace("exec-routing-drift-");
    try {
      await activeExecution(fx);
      const leftovers = plantLeftovers(fx, PLANTED_ID);
      const before = readFileSync(leftovers.statusPath);
      const handle = await openStore(fx.context, "write");
      try {
        handle.db
          .prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)")
          .run(999, "from-the-future", "0".repeat(64), "2026-09-20T00:00:00.000Z");
      } finally {
        handle.close();
      }
      const store = createFsStore(fx.harnessDir);

      const refusal = await refusalOf(() =>
        withProtectedWrite(leftovers.statusPath, "put", () =>
          store.put({ kind: "status", key: "root", payload: { version: 2, updated_at: "2000-01-01", workflows: [] } }),
        ),
      );
      expect(refusal.code).toBe("store.schema-unsupported");
      expect(readFileSync(leftovers.statusPath)).toEqual(before);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("a store held past the bounded wait refuses the file route and writes nothing", async () => {
    const fx = workspace("exec-routing-busy-");
    const held = workspace("exec-routing-busy-holder-");
    let holder: DatabaseSync | undefined;
    try {
      await activeExecution(fx);
      // The copy is how this suite obtains store bytes this process has not
      // already mapped (`backupStore` = the landed consistent `VACUUM INTO`), so
      // a competing writer can genuinely hold the file: a BUSY refusal is
      // observable only against a store no open handle already owns.
      await backupStore(fx.context, { out: join(held.harnessDir, "store.db") });
      const statusPath = join(held.harnessDir, "status.json");
      writeFileSync(statusPath, `${JSON.stringify({ version: 2, updated_at: "2026-09-01", workflows: [] })}\n`);
      const before = readFileSync(statusPath);

      // Another writer holds the whole database (rollback-journal mode, so a
      // competing reader really waits instead of reading the WAL snapshot).
      holder = new DatabaseSync(join(held.harnessDir, "store.db"));
      holder.exec("pragma busy_timeout=0");
      holder.exec("pragma journal_mode=delete");
      holder.exec("begin exclusive");
      holder.prepare("select count(*) as n from store_meta").get();
      process.env.MSTAR_STORE_TEST_RUNNER = "1";
      process.env.MSTAR_STORE_BUSY_TIMEOUT_MS = "50";
      const store = createFsStore(held.harnessDir);

      const refusal = await refusalOf(() =>
        withProtectedWrite(statusPath, "put", () =>
          store.put({ kind: "status", key: "root", payload: { version: 2, updated_at: "2000-01-01", workflows: [] } }),
        ),
      );
      expect(refusal.code).toBe("store.busy");
      expect(readFileSync(statusPath)).toEqual(before);
    } finally {
      try {
        holder?.exec("rollback");
      } catch {
        // the exclusive section may already be gone
      }
      holder?.close();
      rmSync(fx.root, { recursive: true, force: true });
      rmSync(held.root, { recursive: true, force: true });
    }
  });

  test("a content-corrupt active store refuses the read route too, never serving leftover JSON", async () => {
    const fx = workspace("exec-routing-corrupt-read-");
    try {
      await activeExecution(fx);
      const leftovers = plantLeftovers(fx, PLANTED_ID);
      for (const suffix of ["-wal", "-shm"]) {
        rmSync(join(fx.harnessDir, `store.db${suffix}`), { force: true });
      }
      writeFileSync(join(fx.harnessDir, "store.db"), "this is not a sqlite database\n");

      let code = "";
      try {
        readWorkflowSnapshot(dirname(leftovers.snapshotPath));
        throw new Error("expected a refusal");
      } catch (error) {
        code = (error as { code?: string }).code ?? "";
      }
      expect(code).toBe("store.corrupt");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("a never-initialized harness keeps the legacy route: no store file means no authority verdict", async () => {
    const fx = workspace("exec-routing-never-initialized-");
    try {
      const leftovers = plantLeftovers(fx, PLANTED_ID);
      const store = createFsStore(fx.harnessDir);
      expect(existsSync(join(fx.harnessDir, "store.db"))).toBe(false);

      // Nothing to read means nothing to refuse: the file route is the only
      // route, exactly as it was before the guards existed (§2.1: absence is
      // not an authority verdict).
      expect(readWorkflowSnapshot(dirname(leftovers.snapshotPath)).snapshot.id).toBe(PLANTED_ID);
      await withProtectedWrite(leftovers.statusPath, "put", () =>
        store.put({ kind: "status", key: "root", payload: { version: 2, updated_at: "2000-01-01", workflows: [] } }),
      );
      const written = JSON.parse(readFileSync(leftovers.statusPath, "utf8")) as { updated_at: string };
      expect(written.updated_at).toBe("2000-01-01");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("a store that exists but cannot be read refuses the READ route too, never serving leftover JSON", async () => {
    const fx = workspace("exec-routing-unreadable-read-");
    try {
      await activeExecution(fx);
      const leftovers = plantLeftovers(fx, PLANTED_ID);
      const statusBefore = readFileSync(leftovers.statusPath);
      // A path that exists but is not a readable database — the driver class
      // (SQLITE_CANTOPEN) an unopenable store reports. It is an EXISTING store,
      // so it is refused; only a missing one keeps the legacy path.
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(join(fx.harnessDir, `store.db${suffix}`), { recursive: true, force: true });
      }
      mkdirSync(join(fx.harnessDir, "store.db"));
      const store = createFsStore(fx.harnessDir);

      expect(refusalCodeOf(() => readWorkflowSnapshot(dirname(leftovers.snapshotPath)))).toBe("store.corrupt");

      // The same verdict on the public store seam and on the write route.
      expect(await refusalOf(() => store.get({ kind: "status", key: "root" }))).toMatchObject({ code: "store.corrupt" });
      expect(
        await refusalOf(() =>
          withProtectedWrite(leftovers.statusPath, "put", () =>
            store.put({ kind: "status", key: "root", payload: { version: 2, updated_at: "2000-01-01", workflows: [] } }),
          ),
        ),
      ).toMatchObject({ code: "store.corrupt" });
      expect(readFileSync(leftovers.statusPath)).toEqual(statusBefore);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("a store held past the bounded wait refuses the read route instead of serving leftover JSON", async () => {
    const fx = workspace("exec-routing-busy-read-");
    const held = workspace("exec-routing-busy-read-holder-");
    let holder: DatabaseSync | undefined;
    try {
      await activeExecution(fx);
      // The same construction the busy WRITE case uses: the copy is how this
      // suite obtains store bytes this process has not already mapped, so a
      // competing writer can genuinely hold the file.
      await backupStore(fx.context, { out: join(held.harnessDir, "store.db") });
      const leftovers = plantLeftovers(held, PLANTED_ID);
      const snapshotBefore = readFileSync(leftovers.snapshotPath);

      holder = new DatabaseSync(join(held.harnessDir, "store.db"));
      holder.exec("pragma busy_timeout=0");
      holder.exec("pragma journal_mode=delete");
      holder.exec("begin exclusive");
      holder.prepare("select count(*) as n from store_meta").get();
      process.env.MSTAR_STORE_TEST_RUNNER = "1";
      process.env.MSTAR_STORE_BUSY_TIMEOUT_MS = "50";

      expect(refusalCodeOf(() => readWorkflowSnapshot(dirname(leftovers.snapshotPath)))).toBe("store.busy");
      expect(readFileSync(leftovers.snapshotPath)).toEqual(snapshotBefore);
    } finally {
      try {
        holder?.exec("rollback");
      } catch {
        // the exclusive section may already be gone
      }
      holder?.close();
      rmSync(fx.root, { recursive: true, force: true });
      rmSync(held.root, { recursive: true, force: true });
    }
  });
});
