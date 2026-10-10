/**
 * Execution routing — the ACTIVE-only read authority and its refusals.
 *
 * Authority: primary spec §4.3/§5 on the landed execution authority. Issue #428
 * retired the pre-activation FILE route, so the discrimination this suite
 * proves is no longer "which of two routes answers" but "the one ACTIVE route
 * answers, and everything else is a typed refusal that names its recovery":
 *
 * - an ACTIVE store answers `resolveExecutionReadRoute` / `resolveCurrentAuthority`
 *   / `readExecutionSource` from the execution DB;
 * - a store that is ABSENT refuses `store.not-initialized` with the TWO-path
 *   bootstrap recovery (`mstar harness scaffold` + `mstar store init` for a
 *   genuinely empty workspace, or `mstar store upgrade` for a workspace holding
 *   historical file state) — never leftover JSON;
 * - a store that is PRESENT but not ACTIVE (`legacy`/`staged`) refuses
 *   `execution.not-active` naming `mstar store upgrade`;
 * - a store that EXISTS and cannot be read refuses through its own frozen
 *   `store.*` code (`store.corrupt` / `store.busy`) instead of degrading;
 * - the read-only MIGRATION importer entry points stay reachable, so a workspace
 *   holding historical file state is never stranded.
 *
 * Every case runs the REAL modules against a REAL `node:sqlite` store in a
 * per-test temporary root — no mocked database and no fixture-written verdict.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readExecutionAuthority } from "./execution-read.js";
import { existsSync } from "node:fs";
import { initializeExecutionAuthority, readExecutionState } from "./execution-store.js";
import { captureProjectionSources } from "./projection.js";
import { backupStore } from "./store-activation.js";
import { initializeStore, openStore, type StoreContext } from "./store-db.js";
import { upgradeStoreMinimal } from "./store-upgrade-minimal.js";
import {
  queryDashboard,
  readExecutionSource,
  resolveCurrentAuthority,
  resolveExecutionReadRoute,
  withStoreRead,
} from "./store-read.js";

type Fixture = { root: string; harnessDir: string; context: StoreContext };

/** A temp workspace shaped like a real one: a harness root under its own dir. */
function workspace(prefix: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const harnessDir = join(root, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  return { root, harnessDir, context: { harnessDir } };
}

/** `initializeStore` creates the store ACTIVE (issue #428: init activates). */
async function activeStore(fx: Fixture): Promise<void> {
  const handle = await initializeStore(fx.context);
  handle.close();
}

/** Flip the recorded authority state directly; the store keeps its data. */
async function setAuthorityState(fx: Fixture, state: "legacy" | "staged" | "active"): Promise<void> {
  const handle = await openStore(fx.context, "write");
  try {
    handle.db.prepare("update execution_meta set authority_state = ? where id = 1").run(state);
  } finally {
    handle.close();
  }
}

async function refusalOf(work: () => Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await work();
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error("expected a refusal");
}

const fixtures: Fixture[] = [];
function tracked(fx: Fixture): Fixture {
  fixtures.push(fx);
  return fx;
}
afterEach(() => {
  for (const fx of fixtures.splice(0)) rmSync(fx.root, { recursive: true, force: true });
  delete process.env.MSTAR_STORE_TEST_RUNNER;
  delete process.env.MSTAR_STORE_BUSY_TIMEOUT_MS;
});

describe("execution-route \u2014 the ACTIVE store is the only read authority", () => {
  test("an ACTIVE store answers the route, the verdict and the source read from the DB", async () => {
    const fx = tracked(workspace("exec-route-active-"));
    await activeStore(fx);

    expect(await resolveExecutionReadRoute(fx.context)).toBe("execution");
    const verdict = await resolveCurrentAuthority(fx.context);
    expect(verdict.route).toBe("execution");
    // The durable generation travels with the verdict so a commit boundary can
    // re-assert it; the retired file route had no generation and is gone.
    expect(verdict.handle.storeId).toBeString();
    expect(verdict.handle.epoch).toBeGreaterThan(0);

    const served = await readExecutionSource(fx.context);
    expect(served.route).toBe("execution");
    expect(served.read).toEqual(await readExecutionAuthority(fx.context));
  });

  test("a malformed address is refused before any route verdict can answer it", async () => {
    const fx = tracked(workspace("exec-route-address-"));
    await activeStore(fx);
    // A lone plan id is not an address: the plan key is (workflowId, planId).
    expect(await refusalOf(() => readExecutionSource(fx.context, { planId: "plan-a" }))).toMatchObject({
      code: "coordination.invalid-input",
    });
  });
});

describe("execution-route \u2014 every non-ACTIVE store is a typed refusal with recovery", () => {
  test("an ABSENT store refuses store.not-initialized with BOTH bootstrap recovery paths", async () => {
    const fx = tracked(workspace("exec-route-absent-"));
    // No store file at all: the retired file route must never answer with
    // leftover JSON, and the refusal must name the two supported bootstraps.
    for (const run of [
      () => resolveExecutionReadRoute(fx.context),
      () => resolveCurrentAuthority(fx.context),
      () => readExecutionSource(fx.context),
      () => readExecutionAuthority(fx.context),
    ]) {
      const refusal = await refusalOf(run);
      expect(refusal.code).toBe("store.not-initialized");
      expect(refusal.message).toContain("mstar harness scaffold");
      expect(refusal.message).toContain("mstar store init");
      expect(refusal.message).toContain("mstar store upgrade");
      expect(refusal.message).toContain("pre-activation file route is retired");
    }
  });

  test("a PRESENT but non-ACTIVE store refuses execution.not-active naming `mstar store upgrade`", async () => {
    for (const state of ["legacy", "staged"] as const) {
      const fx = tracked(workspace(`exec-route-${state}-`));
      await activeStore(fx);
      await setAuthorityState(fx, state);

      for (const run of [
        () => resolveExecutionReadRoute(fx.context),
        () => resolveCurrentAuthority(fx.context),
        () => readExecutionSource(fx.context),
      ]) {
        const refusal = await refusalOf(run);
        expect(refusal.code).toBe("execution.not-active");
        expect(refusal.message).toContain(state);
        expect(refusal.message).toContain("mstar store upgrade");
        expect(refusal.message).toContain("pre-activation file route is retired");
      }
      // The DB adapter keeps its own authority-state vocabulary.
      expect(await refusalOf(() => readExecutionAuthority(fx.context))).toMatchObject({ code: "execution.not-active" });
    }
  });

  test("a store that EXISTS and cannot be read refuses store.corrupt, never leftover JSON", async () => {
    const fx = tracked(workspace("exec-route-corrupt-"));
    await activeStore(fx);
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(fx.harnessDir, `store.db${suffix}`), { force: true });
    mkdirSync(join(fx.harnessDir, "store.db"));

    expect(await refusalOf(() => resolveExecutionReadRoute(fx.context))).toMatchObject({ code: "store.corrupt" });
    expect(await refusalOf(() => readExecutionSource(fx.context))).toMatchObject({ code: "store.corrupt" });
  });

  test("a store another writer holds past the bounded wait refuses store.busy", async () => {
    const fx = tracked(workspace("exec-route-busy-"));
    const held = tracked(workspace("exec-route-busy-holder-"));
    let holder: DatabaseSync | undefined;
    try {
      await activeStore(fx);
      // The copy is how this suite obtains store bytes this process has not
      // already mapped, so a competing writer can genuinely hold the file.
      await backupStore(fx.context, { out: join(held.harnessDir, "store.db") });
      holder = new DatabaseSync(join(held.harnessDir, "store.db"));
      holder.exec("pragma busy_timeout=0");
      holder.exec("pragma journal_mode=delete");
      holder.exec("begin exclusive");
      holder.prepare("select count(*) as n from store_meta").get();
      process.env.MSTAR_STORE_TEST_RUNNER = "1";
      process.env.MSTAR_STORE_BUSY_TIMEOUT_MS = "50";

      expect(await refusalOf(() => resolveExecutionReadRoute(held.context))).toMatchObject({ code: "store.busy" });
      expect(await refusalOf(() => readExecutionSource(held.context))).toMatchObject({ code: "store.busy" });
    } finally {
      try {
        holder?.exec("rollback");
      } catch {
        // the exclusive section may already be gone
      }
      holder?.close();
    }
  });
});

describe("execution-route \u2014 the migration importer entry points stay reachable", () => {
  test("a staged store is upgraded in place and then answers the ACTIVE route", async () => {
    const fx = tracked(workspace("exec-route-migrate-"));
    await activeStore(fx);
    await setAuthorityState(fx, "staged");
    expect(await refusalOf(() => readExecutionSource(fx.context))).toMatchObject({ code: "execution.not-active" });

    // `store upgrade` is the one supported recovery the refusal names: it flips
    // the recorded authority back to ACTIVE and the same read then answers.
    const upgraded = await upgradeStoreMinimal({ context: fx.context, operator: "fixture-operator", operationId: "route-upgrade" });
    expect(upgraded.authorityState).toBe("active");
    const handle = await openStore(fx.context, "read");
    try {
      expect(handle.execution?.authorityState).toBe("active");
    } finally {
      handle.close();
    }
    expect(await resolveExecutionReadRoute(fx.context)).toBe("execution");
  });

  test("a workspace holding historical file state activates through the importer", async () => {
    const fx = tracked(workspace("exec-route-import-"));
    // A harness root that predates the store: recognizable historical bytes are
    // present, no store.db exists, and the importer is the supported path.
    writeFileSync(
      join(fx.harnessDir, "status.json"),
      `${JSON.stringify({ version: 2, updated_at: "2026-09-01", workflows: [] }, null, 2)}\n`,
    );
    const bootstrapRefusal = await refusalOf(() => readExecutionSource(fx.context));
    expect(bootstrapRefusal.code).toBe("store.not-initialized");
    expect(bootstrapRefusal.message).toContain("mstar store upgrade");

    // The empty-workspace route correctly REFUSES a non-empty historical
    // surface — which is exactly why the absent-store refusal must name the
    // importer as the second recovery path.
    expect(await refusalOf(() => initializeExecutionAuthority(fx.context))).toMatchObject({ code: "execution.not-empty" });
    const imported = await upgradeStoreMinimal({ context: fx.context, operator: "fixture-operator", operationId: "route-import" });
    expect(imported.authorityState).toBe("active");
    const state = await readExecutionState(fx.context);
    expect(state.data.workflows).toEqual([]);
    // The importer reads historical bytes as SOURCES and never deletes them.
    expect(existsSync(join(fx.harnessDir, "status.json"))).toBe(true);
    expect(await resolveExecutionReadRoute(fx.context)).toBe("execution");
  });

  test("the projection capture uses the ACTIVE graph, and refuses a store that is not ACTIVE", async () => {
    const fx = tracked(workspace("exec-route-projection-"));
    await activeStore(fx);
    const active = await captureProjectionSources(fx.context);
    expect(active.diagnostics).toEqual([]);
    expect(active.sources.map((source) => source.sourceKey)).toContain("root:harness:execution/registry");

    await setAuthorityState(fx, "legacy");
    expect(await refusalOf(() => captureProjectionSources(fx.context))).toMatchObject({ code: "execution.not-active" });
    // A projection-consuming read surfaces the same typed cause.
    expect(await refusalOf(() => withStoreRead(fx.context, queryDashboard("workflows")))).toMatchObject({
      code: "execution.not-active",
    });
  });
});
