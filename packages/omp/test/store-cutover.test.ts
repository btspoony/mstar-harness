/**
 * store-cutover.test.ts — G4b: the omp entrypoints' issue/catalog authority
 * boundary: what the store cutover refuses once it is the authority, and what
 * it leaves untouched.
 *
 * What the cutover has to prove (task brief §Proof), for BOTH owned omp
 * entrypoints (the `tool_call` pre-hook and the `mstar_status_validate` tool):
 *
 * 1. A retired register direct write is refused — but only once the store IS
 *    the authority. The DB-aware route is exercised against REAL stores built
 *    by the engine's own `initializeStore` / `openStore` (`node:sqlite`, real
 *    migrations): an ACTIVE store retires the register, a STAGED store and a
 *    missing store keep it (pre-activation, issue contract §7), and an
 *    unreadable store refuses fail-closed.
 * 2. The authority database (`store.db`, `-wal`, `-shm`) is never
 *    hand-writable.
 * 3. Unrelated validator behaviour is preserved: a status.json / snapshot
 *    write keeps its document validator and its hard/soft enforcement axis,
 *    and NEVER enters the store-backed route (no eager SQLite acquisition —
 *    the runtime probe of the single store path is counted).
 * 4. The runtime floor is read from the ACTUAL runtime (the Bun global first,
 *    never Bun's emulated `process.versions.node`): the injected below-floor
 *    cases pin the actionable Bun AND Node floors of the same code path.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStore, openStore } from "@mstar-harness/engine";
import type { StoreRuntimeInfo } from "@mstar-harness/engine";
import { zod } from "@oh-my-pi/pi-coding-agent";
import type { CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent";
import mstarGates, { storeRuntimeProbe as hookRuntimeProbe } from "../src/hooks/pre/mstar-gates";
import mstarStatusValidate, { storeRuntimeProbe as toolRuntimeProbe } from "../src/tools/mstar_status_validate/index";

const VALID_STATUS = JSON.stringify({ version: 2, updated_at: "2026-09-08", workflows: [] });
const VALID_REGISTER = JSON.stringify({ entries: {} });
const BAD_JSON = "{ not json";

/** The Bun global is not in the Node type set — one deliberate boundary read. */
const bunGlobal = (globalThis as unknown as { Bun?: { version: string } }).Bun;

/** Each omp entrypoint owns its probe seam (separate module, separate bundle). */
const runtimeProbes = [hookRuntimeProbe, toolRuntimeProbe];
const realRuntimeProbes = runtimeProbes.map((probe) => probe.info);
const roots: string[] = [];

afterEach(() => {
  runtimeProbes.forEach((probe, index) => {
    probe.info = realRuntimeProbes[index]!;
  });
});

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  harness: string;
  status: string;
  register: string;
  storeDb: string;
}

/** A default-layout harness fixture (`<root>/.mstar`); `enforcement` writes
 * the repo `.mstarc` the gates resolve through `resolveRepoEnforcement`. */
function makeHarness(id: string, enforcement?: "hard" | "soft"): Fixture {
  const root = mkdtempSync(join(tmpdir(), `omp-g4b-${id}-`));
  roots.push(root);
  const harness = join(root, ".mstar");
  mkdirSync(join(harness, "workflows"), { recursive: true });
  mkdirSync(join(harness, "projects", "_default"), { recursive: true });
  writeFileSync(join(harness, "status.json"), VALID_STATUS);
  if (enforcement !== undefined) writeFileSync(join(root, ".mstarc"), `[config]\nenforcement=${enforcement}\n`);
  return {
    root,
    harness,
    status: join(harness, "status.json"),
    register: join(harness, "projects", "_default", "residuals.json"),
    storeDb: join(harness, "store.db"),
  };
}

/** REAL active store (engine initializer, real migrations). */
async function seedActiveStore(harnessDir: string): Promise<void> {
  const handle = await initializeStore({ harnessDir });
  handle.close();
}

/** REAL staged store: initialized, then flipped back to `staged` through the
 * engine's own write handle (pre-activation, issue contract §7). */
async function seedStagedStore(harnessDir: string): Promise<void> {
  await seedActiveStore(harnessDir);
  const write = await openStore({ harnessDir }, "write");
  write.db.prepare("update store_meta set authority_state = 'staged' where id = 1").run();
  write.close();
}

/** Unreadable authority through the REAL engine channel: a directory where the
 * database file belongs (`openStore` refuses `store.corrupt`). */
async function corruptStore(harnessDir: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(harnessDir, `store.db${suffix}`), { force: true });
  mkdirSync(join(harnessDir, "store.db"), { recursive: true });
}

interface HookResult {
  block?: boolean;
  reason?: string;
}

type ToolCallHandler = (event: unknown) => Promise<HookResult | undefined>;

/** The omp pre-hook registers exactly one `tool_call` handler; this is it. */
function loadHandler(): ToolCallHandler {
  let handler: ToolCallHandler | undefined;
  const pi = {
    on: (_event: string, fn: ToolCallHandler) => {
      handler = fn;
    },
    logger: { warn: () => undefined, error: () => undefined },
  };
  // Host extension API stub — the hook only uses `on` + `logger` (same stub
  // shape the Gate-1 parity matrix uses).
  mstarGates(pi as never);
  if (handler === undefined) throw new Error("mstar-gates registered no tool_call handler");
  return handler;
}

function runWrite(handler: ToolCallHandler, path: string, content?: string, toolName = "write") {
  return handler({ toolName, toolCallId: "call-1", input: content === undefined ? { path } : { path, content } });
}

/** Count one entry's runtime-probe calls: the single store-backed route entry. */
function countStoreRoute(probe: { info: () => StoreRuntimeInfo }): () => number {
  let calls = 0;
  const real = probe.info;
  probe.info = () => {
    calls += 1;
    return real();
  };
  return () => calls;
}

function mockPi(cwd: string): CustomToolAPI {
  return {
    cwd,
    zod,
    exec: async () => {
      throw new Error("exec is not used by this spec");
    },
    ui: {} as CustomToolAPI["ui"],
    hasUI: false,
    logger: {
      warn: () => undefined,
      error: () => undefined,
      info: () => undefined,
      debug: () => undefined,
    } as CustomToolAPI["logger"],
    typebox: {} as CustomToolAPI["typebox"],
    arktype: {} as CustomToolAPI["arktype"],
    pi: {} as CustomToolAPI["pi"],
    pushPendingAction: () => undefined,
  };
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function runTool(cwd: string, params: Record<string, unknown>): Promise<ToolResult> {
  const tool: CustomTool = mstarStatusValidate(mockPi(cwd));
  return (await tool.execute("call-1", params, undefined, undefined as never, undefined)) as ToolResult;
}

function textOf(result: ToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

describe("omp write gate — authority paths refuse, documents keep their validator (G4b)", () => {
  test("an ACTIVE store retires the register: the direct write is refused in hard AND soft mode", async () => {
    for (const enforcement of ["hard", "soft"] as const) {
      const fixture = makeHarness(`active-${enforcement}`, enforcement);
      await seedActiveStore(fixture.harness);
      const handler = loadHandler();

      // Register bytes that ARE document-valid prove the refusal is the
      // authority route, not a shape violation.
      const blocked = await runWrite(handler, fixture.register, VALID_REGISTER);
      expect(blocked?.block).toBe(true);
      expect(blocked?.reason).toContain("project.register.retired");
      expect(blocked?.reason).toContain("store.db");
      expect(blocked?.reason).toContain("mstar issue add|close");
      expect(blocked?.reason).not.toContain("status.invalid-json");
    }
  });

  test("an unreadable authority refuses fail-closed (corrupt store), never a silent pass", async () => {
    const fixture = makeHarness("corrupt", "soft");
    await corruptStore(fixture.harness);
    const handler = loadHandler();

    const blocked = await runWrite(handler, fixture.register, VALID_REGISTER);
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("store.authority-unavailable");
    expect(blocked?.reason).toContain("store.corrupt");
  });

  test("pre-activation keeps the register authoritative: missing AND staged stores fall through", async () => {
    for (const state of ["missing", "staged"] as const) {
      const fixture = makeHarness(state, "hard");
      if (state === "staged") await seedStagedStore(fixture.harness);
      const handler = loadHandler();

      // The document validator still decides — and the enforcement axis with it.
      expect(await runWrite(handler, fixture.register, VALID_REGISTER)).toBeUndefined();
      const invalid = await runWrite(handler, fixture.register, BAD_JSON);
      expect(invalid?.reason).toContain("status.invalid-json");
    }
  });

  test("the authority database is never hand-writable (store.db / -wal / -shm, any mode)", async () => {
    const fixture = makeHarness("store-file", "soft");
    await seedActiveStore(fixture.harness);
    const handler = loadHandler();

    for (const target of [fixture.storeDb, `${fixture.storeDb}-wal`, `${fixture.storeDb}-shm`]) {
      const blocked = await runWrite(handler, target, "not a database");
      expect(blocked?.block).toBe(true);
      expect(blocked?.reason).toContain("store.direct-write-refused");
      expect(blocked?.reason).toContain("mstar store init|upgrade|migrate");
    }
    // A same-named file OUTSIDE any harness root is not the authority.
    expect(await runWrite(handler, join(fixture.root, "nested", "store.db"), "x")).toBeUndefined();
  });

  test("a CASE-VARIANT authority basename (Store.db) is refused like the file itself (FW-3)", async () => {
    const fixture = makeHarness("store-case", "soft");
    await seedActiveStore(fixture.harness);
    const handler = loadHandler();

    // On a case-insensitive volume (Darwin/APFS) this write lands on the
    // authority database itself; the folded basename match refuses it on a
    // case-sensitive volume too (the authority name is volume-invariant).
    const blocked = await runWrite(handler, join(fixture.harness, "Store.db"), "not a database");
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("store.direct-write-refused");
  });

  test("a CASE-VARIANT register (RESIDUALS.json) takes the authority route (FW-3)", async () => {
    const fixture = makeHarness("register-case", "soft");
    await seedActiveStore(fixture.harness);
    const handler = loadHandler();

    const blocked = await runWrite(
      handler,
      join(fixture.harness, "projects", "_default", "RESIDUALS.json"),
      VALID_REGISTER,
    );
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("project.register.retired");
  });

  test("a CASE-VARIANT register on the pre-activation fall-through keeps its document validator (qc2-F-005)", async () => {
    for (const state of ["missing", "staged"] as const) {
      const fixture = makeHarness(state, "hard");
      if (state === "staged") await seedStagedStore(fixture.harness);
      const handler = loadHandler();
      const caseVariant = join(fixture.harness, "projects", "_default", "RESIDUALS.json");

      // The FW-3 folded shape walk classifies the case-variant basename as a
      // register document (dsh parity): the register shape validator decides —
      // not the authority route, not silence.
      expect(await runWrite(handler, caseVariant, VALID_REGISTER)).toBeUndefined();
      const invalid = await runWrite(handler, caseVariant, BAD_JSON);
      expect(invalid?.reason).toContain("status.invalid-json");
    }
  });

  test("a below-floor ACTUAL runtime refuses with that runtime's own actionable floor", async () => {
    const fixture = makeHarness("below-floor", "hard");
    const handler = loadHandler();

    hookRuntimeProbe.info = (): StoreRuntimeInfo => ({ isBun: true, version: "1.3.14" });
    const bun = await runWrite(handler, fixture.register, VALID_REGISTER);
    expect(bun?.reason).toContain("store.authority-unavailable");
    expect(bun?.reason).toContain("store.runtime-unsupported");
    expect(bun?.reason).toContain("Bun >=1.4.0");

    hookRuntimeProbe.info = (): StoreRuntimeInfo => ({ isBun: false, version: "24.17.0" });
    const node = await runWrite(handler, fixture.register, VALID_REGISTER);
    expect(node?.reason).toContain("store.authority-unavailable");
    expect(node?.reason).toContain("Node >=24.18.0");
    // A refused probe writes nothing.
    expect(existsSync(fixture.storeDb)).toBe(false);
  });

  test("the runtime probe reports the ACTUAL runtime, never Bun's emulated Node version", () => {
    const detected = hookRuntimeProbe.info();
    expect(detected.isBun).toBe(true);
    expect(detected.version).toBe(bunGlobal?.version ?? "");
    // Bun emulates a DIFFERENT `process.versions.node`; a probe that read it
    // would certify this process as Node (and, on Bun <1.4.0, would certify
    // the wrong floor entirely instead of refusing).
    expect(process.versions.node).not.toBe(detected.version);
  });

  test("a symlink alias that resolves into the harness IS the authority it points at (S-G4b-03)", async () => {
    const fixture = makeHarness("alias", "hard");
    await seedActiveStore(fixture.harness);
    writeFileSync(fixture.register, VALID_REGISTER);
    const handler = loadHandler();
    const aliases = join(fixture.root, "aliases");
    mkdirSync(aliases, { recursive: true });

    // The authority database and a retired register, under aliases OUTSIDE the
    // harness tree: both resolve into it, so both are refused like the files
    // themselves (document-valid register bytes prove the route, not a shape
    // violation).
    const storeAlias = join(aliases, "cache.db");
    symlinkSync(fixture.storeDb, storeAlias);
    const store = await runWrite(handler, storeAlias, "not a database");
    expect(store?.block).toBe(true);
    expect(store?.reason).toContain("store.direct-write-refused");

    const registerAlias = join(aliases, "carry-over.json");
    symlinkSync(fixture.register, registerAlias);
    const register = await runWrite(handler, registerAlias, VALID_REGISTER);
    expect(register?.block).toBe(true);
    expect(register?.reason).toContain("project.register.retired");

    // A DANGLING alias still names the authority file a write would create.
    const fresh = makeHarness("alias-dangling", "soft");
    const pending = join(fresh.root, "pending.db");
    symlinkSync(fresh.storeDb, pending);
    const created = await runWrite(loadHandler(), pending, "not a database");
    expect(created?.block).toBe(true);
    expect(created?.reason).toContain("store.direct-write-refused");

    // Nothing non-authority changed: an unrelated alias passes silently, and
    // the canonical documents keep their own validator + (absent) authority.
    writeFileSync(join(fixture.root, "notes.md"), "# notes\n");
    const notesAlias = join(aliases, "notes.md");
    symlinkSync(join(fixture.root, "notes.md"), notesAlias);
    expect(await runWrite(handler, notesAlias, BAD_JSON)).toBeUndefined();
    expect((await runWrite(handler, fixture.status, BAD_JSON))?.reason).toContain("status.invalid-json");
  });

  test("a pre-activation register whose alias lands on an ACTIVE harness's register is vetoed (stricter-wins)", async () => {
    // RV-2: the source harness is pre-activation (legacy route), but its
    // register is a symlink to ANOTHER harness's register whose store is
    // active — the write lands there with only the source authority checked.
    // The landed context's authority refusals veto the legacy fall-through.
    const source = makeHarness("cross-src-legacy", "hard");
    const dest = makeHarness("cross-dest-active", "soft");
    await seedActiveStore(dest.harness);
    writeFileSync(dest.register, VALID_REGISTER);
    symlinkSync(dest.register, source.register);
    const handler = loadHandler();

    const vetoed = await runWrite(handler, source.register, VALID_REGISTER);
    expect(vetoed?.block).toBe(true);
    // Document-valid register bytes prove the veto is the landed authority
    // route, not a shape violation.
    expect(vetoed?.reason).toContain("project.register.retired");

    // Both contexts pre-activation keep the legacy path (issue contract §7):
    // the landed register's own document validator decides, on the source's
    // enforcement axis.
    const legacyDest = makeHarness("cross-dest-legacy", "soft");
    writeFileSync(legacyDest.register, VALID_REGISTER);
    const legacySource = makeHarness("cross-src-legacy-2", "hard");
    symlinkSync(legacyDest.register, legacySource.register);
    expect(await runWrite(loadHandler(), legacySource.register, VALID_REGISTER)).toBeUndefined();
    const invalid = await runWrite(loadHandler(), legacySource.register, BAD_JSON);
    expect(invalid?.reason).toContain("status.invalid-json");
  });

  test("non-store targets never enter the store route (no eager SQLite acquisition)", async () => {
    const fixture = makeHarness("lazy", "hard");
    const handler = loadHandler();
    const storeRouteCalls = countStoreRoute(hookRuntimeProbe);

    expect(await runWrite(handler, join(fixture.root, "README.md"), "# notes")).toBeUndefined();
    expect((await runWrite(handler, fixture.status, BAD_JSON))?.reason).toContain("status.invalid-json");
    expect((await runWrite(handler, fixture.status, VALID_STATUS))).toBeUndefined();
    expect(await runWrite(handler, join(fixture.harness, "workflows", "wf-a", "snapshot.json"), BAD_JSON)).toMatchObject(
      { block: true },
    );
    expect(storeRouteCalls()).toBe(0);
    expect(existsSync(fixture.storeDb)).toBe(false);

    // The register target is the one path that DOES consult the authority.
    await runWrite(handler, fixture.register, VALID_REGISTER);
    expect(storeRouteCalls()).toBeGreaterThan(0);
  });
});

describe("omp mstar_status_validate — DB-aware register route (G4b)", () => {
  test("store-backed register: refused through the DB-aware route, not shape-checked", async () => {
    const fixture = makeHarness("tool-active", "soft");
    await seedActiveStore(fixture.harness);
    const reads = countStoreRoute(toolRuntimeProbe);

    const result = await runTool(fixture.root, { path: fixture.register });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("project.register.retired");
    expect(textOf(result)).not.toContain("project.register.invalid");
    expect(reads()).toBeGreaterThan(0);
  });

  test("unreadable authority: refused with the engine refusal, never an empty verdict", async () => {
    const fixture = makeHarness("tool-corrupt", "soft");
    await corruptStore(fixture.harness);

    const result = await runTool(fixture.root, { path: fixture.register });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("store.authority-unavailable");
    expect(textOf(result)).toContain("store.corrupt");
  });

  test("pre-activation register: the register validator still answers (hard AND soft)", async () => {
    const fixture = makeHarness("tool-legacy", "soft");
    const reads = countStoreRoute(toolRuntimeProbe);

    writeFileSync(fixture.register, VALID_REGISTER);
    const valid = await runTool(fixture.root, { path: fixture.register });
    expect(valid.isError).not.toBe(true);
    expect(textOf(valid)).toContain("register valid");

    writeFileSync(fixture.register, JSON.stringify({ entries: "not-an-array" }));
    const invalid = await runTool(fixture.root, { path: fixture.register });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toContain("project.register.");
    // The route was consulted (to learn the state) but the store was never
    // acquired into an answering read of retired data.
    expect(reads()).toBeGreaterThan(0);
    expect(existsSync(fixture.storeDb)).toBe(false);
  });

  test("a symlink alias that resolves into the harness answers as the authority (S-G4b-03)", async () => {
    const fixture = makeHarness("tool-alias", "soft");
    await seedActiveStore(fixture.harness);
    writeFileSync(fixture.register, VALID_REGISTER);
    const aliases = join(fixture.root, "aliases");
    mkdirSync(aliases, { recursive: true });
    const storeAlias = join(aliases, "cache.db");
    symlinkSync(fixture.storeDb, storeAlias);
    const registerAlias = join(aliases, "carry-over.json");
    symlinkSync(fixture.register, registerAlias);

    const store = await runTool(fixture.root, { path: storeAlias });
    expect(store.isError).toBe(true);
    expect(textOf(store)).toContain("store.direct-write-refused");

    const register = await runTool(fixture.root, { path: registerAlias });
    expect(register.isError).toBe(true);
    expect(textOf(register)).toContain("project.register.retired");
    expect(textOf(register)).not.toContain("project.register.invalid");

    // Non-authority verdicts are unchanged (canonical status.json included).
    const status = await runTool(fixture.root, { path: fixture.status });
    expect(status.isError).not.toBe(true);
    expect(textOf(status)).toContain("status.json valid");
  });

  test("store.db target is refused; status + snapshot validation is unchanged", async () => {
    const fixture = makeHarness("tool-store-file", "soft");
    await seedActiveStore(fixture.harness);

    const storeFile = await runTool(fixture.root, { path: fixture.storeDb });
    expect(storeFile.isError).toBe(true);
    expect(textOf(storeFile)).toContain("store.direct-write-refused");

    const status = await runTool(fixture.root, { path: fixture.status });
    expect(status.isError).not.toBe(true);
    expect(textOf(status)).toContain("status.json valid");

    const reads = countStoreRoute(toolRuntimeProbe);
    const snapshotPath = join(fixture.harness, "workflows", "wf-a", "snapshot.json");
    mkdirSync(join(snapshotPath, ".."), { recursive: true });
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        schema_version: 1,
        id: "wf-a",
        type: "plan",
        status: "running",
        started_at: "2026-09-01",
        updated_at: "2026-09-08",
        plans: [],
      }),
    );
    const snapshot = await runTool(fixture.root, { path: snapshotPath });
    expect(snapshot.isError).not.toBe(true);
    expect(textOf(snapshot)).toContain("snapshot valid");
    expect(reads()).toBe(0);
  });
});
