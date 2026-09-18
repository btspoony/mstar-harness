/**
 * store-cutover.test.ts — G4b: the OpenCode plugin's issue/catalog authority
 * boundary: what the store cutover refuses once it is the authority, and
 * what it leaves untouched.
 *
 * The OpenCode binding owns the same two refusals as the omp write gate and
 * the ZCode hook, in this host's GateResult dialect (`hardBlocked: true` —
 * OpenCode's `tool.execute.before` returns void, so a refusal-capable caller
 * must act on the structured result):
 *
 * 1. `{HARNESS_DIR}/store.db` (`-wal`/`-shm`) is never hand-writable.
 * 2. A project register is decided by the DB-aware authority route against
 *    REAL stores built by the engine (`initializeStore` / `openStore`, real
 *    `node:sqlite` migrations): active → `project.register.retired`, staged
 *    or missing → pre-activation (the register validator still answers, issue
 *    contract §7), unreadable → `store.authority-unavailable`.
 * 3. Status/snapshot linting is untouched and never enters the store route
 *    (no eager SQLite acquisition — the runtime probe is counted).
 * 4. The runtime floor comes from the ACTUAL runtime (engine
 *    `detectStoreRuntime`: the Bun global first, never Bun's emulated
 *    `process.versions.node`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStore, openStore } from "@mstar-harness/engine";
import type { StoreRuntimeInfo } from "@mstar-harness/engine";
import {
  MorningStarHarnessPlugin,
  storeApiLoader,
  storeRuntimeOverride,
  validateStatusWrite,
  type StatusLogger,
} from "../src/mstar.js";

/** Ambient MSTAR_HARNESS_DIR would redirect every `.mstar` fixture — pinned out. */
const ENV_KEY = "MSTAR_HARNESS_DIR";
let previousEnv: string | undefined;
beforeEach(() => {
  previousEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});
afterEach(() => {
  if (previousEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = previousEnv;
});

const realStoreApiLoad = storeApiLoader.load;
const projects: string[] = [];

afterEach(() => {
  storeApiLoader.load = realStoreApiLoad;
  storeRuntimeOverride.info = null;
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
});

const validStatus = { version: 2, updated_at: "2026-09-08", workflows: [] };
const validRegister = { entries: {} };
const invalidRegister = { entries: { "plan-a": { id: "R1" } } };

/** Temp project rooted in a real git work tree (harness resolution boundary),
 * with the default `.mstar` layout. */
function makeHarnessProject(): { project: string; harness: string; statusPath: string; registerPath: string; storeDb: string } {
  const project = mkdtempSync(join(tmpdir(), "mstar-opencode-g4b-"));
  projects.push(project);
  execFileSync("git", ["init", "-q", project], { stdio: "ignore" });
  const harness = join(project, ".mstar");
  mkdirSync(join(harness, "workflows"), { recursive: true });
  mkdirSync(join(harness, "projects", "_default"), { recursive: true });
  const statusPath = join(harness, "status.json");
  writeFileSync(statusPath, JSON.stringify(validStatus, null, 2));
  return {
    project,
    harness,
    statusPath,
    registerPath: join(harness, "projects", "_default", "residuals.json"),
    storeDb: join(harness, "store.db"),
  };
}

/** REAL active store through the engine's own initializer. */
async function seedActiveStore(harness: string): Promise<void> {
  const handle = await initializeStore({ harnessDir: harness });
  handle.close();
}

async function seedStagedStore(harness: string): Promise<void> {
  await seedActiveStore(harness);
  const write = await openStore({ harnessDir: harness }, "write");
  write.db.prepare("update store_meta set authority_state = 'staged' where id = 1").run();
  write.close();
}

/** Unreadable authority through the REAL engine channel (`store.corrupt`). */
function corruptStore(harness: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(harness, `store.db${suffix}`), { force: true });
  mkdirSync(join(harness, "store.db"), { recursive: true });
}

/** Capture `[mstar-harness]` log lines by level. */
function capture(): { entries: Array<[string, string]>; log: StatusLogger } {
  const entries: Array<[string, string]> = [];
  return { entries, log: (level, message) => entries.push([level, message]) };
}

/** Count the plugin's store-API loads: the single store-backed route entry. */
function countStoreRoute(): () => number {
  let calls = 0;
  const real = storeApiLoader.load;
  storeApiLoader.load = () => {
    calls += 1;
    return real();
  };
  return () => calls;
}

describe("opencode authority boundary — store/retired-register direct writes (G4b)", () => {
  test("an ACTIVE store retires the register: refused unconditionally, no enforcement flag involved", async () => {
    const fixture = makeHarnessProject(); // no compass, no `.mstarc` — soft by default
    await seedActiveStore(fixture.harness);
    const { entries, log } = capture();

    // Document-VALID register bytes prove the refusal is the authority route.
    const result = await validateStatusWrite(fixture.registerPath, { doc: validRegister, log });
    expect(result?.ok).toBe(false);
    expect(result?.hardBlocked).toBe(true);
    expect(result?.violations.map((violation) => violation.code)).toEqual(["project.register.retired"]);
    expect(entries.filter(([level]) => level === "error").length).toBe(1);
    expect(entries[0]![1]).toContain("project.register.retired");
  });

  test("an unreadable authority refuses fail-closed with the engine refusal", async () => {
    const fixture = makeHarnessProject();
    corruptStore(fixture.harness);
    const { entries, log } = capture();

    const result = await validateStatusWrite(fixture.registerPath, { doc: validRegister, log });
    expect(result?.hardBlocked).toBe(true);
    expect(result?.violations[0]!.code).toBe("store.authority-unavailable");
    expect(result?.violations[0]!.message).toContain("store.corrupt");
    expect(entries.some(([level]) => level === "error")).toBe(true);
  });

  test("pre-activation keeps the register validator AND the enforcement axis", async () => {
    for (const state of ["missing", "staged"] as const) {
      const fixture = makeHarnessProject();
      if (state === "staged") await seedStagedStore(fixture.harness);
      const { entries, log } = capture();

      const invalid = await validateStatusWrite(fixture.registerPath, { doc: invalidRegister, log });
      expect(invalid?.ok).toBe(false);
      expect(invalid?.hardBlocked).toBe(false); // soft-mode register lint — warn only
      expect(invalid?.violations.some((violation) => violation.code.startsWith("project.register."))).toBe(true);
      expect(entries.every(([level]) => level === "warn")).toBe(true);

      const valid = await validateStatusWrite(fixture.registerPath, { doc: validRegister, log });
      expect(valid?.ok).toBe(true);
      expect(valid?.hardBlocked).toBe(false);
    }
  });

  test("the authority database is never hand-writable (store.db / -wal / -shm)", async () => {
    const fixture = makeHarnessProject();
    await seedActiveStore(fixture.harness);

    for (const target of [fixture.storeDb, `${fixture.storeDb}-wal`, `${fixture.storeDb}-shm`]) {
      const { entries, log } = capture();
      const result = await validateStatusWrite(target, { doc: "not a database", log });
      expect(result?.ok).toBe(false);
      expect(result?.hardBlocked).toBe(true);
      expect(result?.violations[0]!.code).toBe("store.direct-write-refused");
      expect(entries.some(([level, message]) => level === "error" && message.includes("store.direct-write-refused"))).toBe(
        true,
      );
    }
    // A same-named file outside a harness root is not the authority.
    expect(await validateStatusWrite(join(fixture.project, "store.db"), { doc: "x" })).toBeNull();
  });

  test("a below-floor ACTUAL runtime refuses with that runtime's own floor", async () => {
    const fixture = makeHarnessProject();
    const { log } = capture();

    storeRuntimeOverride.info = (): StoreRuntimeInfo => ({ isBun: true, version: "1.3.14" });
    const bun = await validateStatusWrite(fixture.registerPath, { doc: validRegister, log });
    expect(bun?.violations[0]!.code).toBe("store.authority-unavailable");
    expect(bun?.violations[0]!.message).toContain("Bun >=1.4.0");

    storeRuntimeOverride.info = (): StoreRuntimeInfo => ({ isBun: false, version: "24.17.0" });
    const node = await validateStatusWrite(fixture.registerPath, { doc: validRegister, log });
    expect(node?.violations[0]!.message).toContain("Node >=24.18.0");
  });

  test("the route reports the ACTUAL runtime, never Bun's emulated Node version, and refuses a stub engine", async () => {
    // No override: the plugin asks the engine for the actual runtime.
    expect(storeRuntimeOverride.info).toBeNull();
    const api = await storeApiLoader.load();
    const detected = api!.detectStoreRuntime();
    expect(detected.isBun).toBe(true);
    expect(detected.version).not.toBe(process.versions.node);

    // An engine without the store API refuses the register path instead of
    // dropping the plugin (the engine-absent contract this file shares).
    storeApiLoader.load = async () => null;
    const fixture = makeHarnessProject();
    const { entries, log } = capture();
    const result = await validateStatusWrite(fixture.registerPath, { doc: validRegister, log });
    expect(result?.hardBlocked).toBe(true);
    expect(result?.violations[0]!.code).toBe("store.authority-unavailable");
    expect(result?.violations[0]!.message).toContain("no issue-store API");
    expect(entries.some(([level]) => level === "error")).toBe(true);
  });

  test("status/snapshot linting is untouched and never enters the store route", async () => {
    const fixture = makeHarnessProject();
    const reads = countStoreRoute();
    const { entries, log } = capture();

    const valid = await validateStatusWrite(fixture.statusPath, { doc: validStatus, log });
    expect(valid?.ok).toBe(true);

    const invalid = await validateStatusWrite(fixture.statusPath, {
      doc: { version: 2, updated_at: "2026-09-08", workflows: [{ id: "wf-1", type: "sprint" }] },
      log,
    });
    expect(invalid?.ok).toBe(false);
    expect(invalid?.violations[0]!.code).toBe("status.workflow.invalid-type");

    const snapshotPath = join(fixture.harness, "workflows", "wf-a", "snapshot.json");
    mkdirSync(join(snapshotPath, ".."), { recursive: true });
    writeFileSync(snapshotPath, JSON.stringify({ schema_version: 1, id: "wf-a", type: "sprint" }));
    const snapshot = await validateStatusWrite(snapshotPath, { log });
    expect(snapshot?.ok).toBe(false);
    expect(snapshot?.violations.length).toBeGreaterThan(0);

    expect(reads()).toBe(0);
    expect(entries.some(([level]) => level === "error")).toBe(false);

    // Only the register target consults the authority.
    await validateStatusWrite(fixture.registerPath, { doc: validRegister, log });
    expect(reads()).toBeGreaterThan(0);
  });

  test("a symlink alias that resolves into the harness is the authority itself (S-G4b-03)", async () => {
    const fixture = makeHarnessProject(); // no compass — soft by default
    await seedActiveStore(fixture.harness);
    writeFileSync(fixture.registerPath, JSON.stringify(validRegister));
    const aliases = join(fixture.project, "aliases");
    mkdirSync(aliases, { recursive: true });
    const storeAlias = join(aliases, "cache.db");
    symlinkSync(fixture.storeDb, storeAlias);
    const registerAlias = join(aliases, "carry-over.json");
    symlinkSync(fixture.registerPath, registerAlias);

    // Both aliases land on authority files: refused unconditionally, as the
    // files themselves are (document-valid register bytes prove the route).
    const store = await validateStatusWrite(storeAlias, { doc: "not a database" });
    expect(store?.hardBlocked).toBe(true);
    expect(store?.violations[0]!.code).toBe("store.direct-write-refused");

    const register = await validateStatusWrite(registerAlias, { doc: validRegister });
    expect(register?.hardBlocked).toBe(true);
    expect(register?.violations[0]!.code).toBe("project.register.retired");

    // Non-authority behaviour is unchanged: an unrelated alias stays ungated,
    // and the canonical status.json keeps its document validator.
    writeFileSync(join(fixture.project, "notes.md"), "# notes\n");
    const notesAlias = join(aliases, "notes.md");
    symlinkSync(join(fixture.project, "notes.md"), notesAlias);
    expect(await validateStatusWrite(notesAlias, { doc: "x" })).toBeNull();
    const invalidStatus = await validateStatusWrite(fixture.statusPath, {
      doc: { version: 2, updated_at: "2026-09-08", workflows: [{ id: "wf-1", type: "sprint" }] },
    });
    expect(invalidStatus?.ok).toBe(false);
    expect(invalidStatus?.violations[0]!.code).toBe("status.workflow.invalid-type");
  });

  test("plugin wiring: a store.db write through tool.execute.before is refused, never silent", async () => {
    const fixture = makeHarnessProject();
    await seedActiveStore(fixture.harness);
    const plugin = await MorningStarHarnessPlugin();
    const beforeWrite = plugin["tool.execute.before"];
    const errors: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };
    try {
      await beforeWrite!(
        { tool: "write", sessionID: "s1", callID: "c1" },
        { args: { filePath: fixture.storeDb, content: "not a database" } },
      );
    } finally {
      console.error = original;
    }
    expect(errors.some((line) => line.includes("store.direct-write-refused"))).toBe(true);
    expect(errors.some((line) => line.includes("hard-gate blocked (hardBlocked=true)"))).toBe(true);
  });

  test("plugin wiring: an edit touching a retired register is refused too (not only writes)", async () => {
    const fixture = makeHarnessProject();
    await seedActiveStore(fixture.harness);
    writeFileSync(fixture.registerPath, JSON.stringify(validRegister));
    const plugin = await MorningStarHarnessPlugin();
    const beforeWrite = plugin["tool.execute.before"];
    const errors: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };
    try {
      await beforeWrite!(
        { tool: "edit", sessionID: "s1", callID: "c1" },
        { args: { filePath: fixture.registerPath, oldString: "{}", newString: '{"plan-a":[{"id":"R1"}]}' } },
      );
    } finally {
      console.error = original;
    }
    expect(errors.some((line) => line.includes("project.register.retired"))).toBe(true);
  });
});
