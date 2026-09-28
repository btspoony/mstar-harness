import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsStore, initializeExecutionAuthority, initializeStore, setArtifactStore } from "@mstar-harness/engine";
import { getCommandDefinitions } from "../src/index.js";
import type { CommandDefinition, InvocationContext } from "../src/types.js";

const roots: string[] = [];
const originalStore = process.env.MSTAR_STORE_MODULE;

afterEach(() => {
  if (originalStore === undefined) delete process.env.MSTAR_STORE_MODULE;
  else process.env.MSTAR_STORE_MODULE = originalStore;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "commands-persist-"));
  roots.push(root);
  const harness = join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  const store = createFsStore(harness);
  delete process.env.MSTAR_STORE_MODULE;
  let protocolReads = 0;
  const context: InvocationContext = {
    cwd: root,
    controlRoot: root,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() { protocolReads += 1; return "{}"; },
      async spawn() { throw new Error("unexpected process effect"); },
      async openBrowser() { throw new Error("unexpected browser effect"); },
    },
  };
  setArtifactStore(store);
  return { root, harness, store, context, protocolReads: () => protocolReads };
}

function definition(id: string): CommandDefinition {
  const found = getCommandDefinitions().find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`missing command definition: ${id}`);
  return found;
}

const STATUS = { version: 2, updated_at: "2026-09-26", workflows: [] };

describe("persist command family", () => {
  test("registers default write under the stable persist.write tool identity", () => {
    expect(definition("persist.write").cli.path).toEqual(["persist", "write"]);
    expect(definition("persist.write").id.replace(/[.-]/g, "_")).toBe("persist_write");
  });

  test("writes from explicit input or file and rejects simultaneous sources without reading protocol input", async () => {
    const { root, store, context, protocolReads } = setup();
    const inputWrite = await definition("persist.write").execute({ kind: "json", key: join(root, "from-input.json"), input: JSON.stringify({ answer: 42 }) }, context);
    expect(inputWrite).toMatchObject({ status: "ok" });
    expect(await store.get({ kind: "json", key: join(root, "from-input.json") })).toEqual({ answer: 42 });

    const file = join(root, "payload.json");
    writeFileSync(file, JSON.stringify({ answer: 42 }));
    await definition("persist.write").execute({ kind: "json", key: join(root, "stored.json"), file }, context);
    expect(await store.get({ kind: "json", key: join(root, "stored.json") })).toEqual({ answer: 42 });

    const exclusive = await definition("persist.write").execute({ kind: "json", key: join(root, "other.json"), input: "{}", file }, context);
    expect(exclusive).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(protocolReads()).toBe(0);
  });

  test("surfaces stale coordinated CAS refusal from the engine", async () => {
    const { harness, store, context } = setup();
    const write = definition("persist.write");
    writeFileSync(join(harness, "status.json"), JSON.stringify(STATUS));
    const result = await write.execute({ kind: "status", key: "root", input: JSON.stringify(STATUS), expectVersion: `sha256:${"0".repeat(64)}` }, context);
    expect(result).toMatchObject({ status: "refused", exitCode: 1, code: "coordination.version-conflict" });
    expect(await store.get({ kind: "status", key: "root" })).toEqual(STATUS);
  });

  test("keeps protected deletion refusal and json-list restriction", async () => {
    const { context } = setup();
    const deletion = await definition("persist.delete").execute({ kind: "status", key: "root" }, context);
    expect(deletion.status).toBe("refused");
    expect(deletion.exitCode).toBe(1);

    const listing = await definition("persist.list").execute({ kind: "json" }, context);
    expect(listing).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    const retired = await definition("persist.write").execute({ kind: "residuals", key: "legacy", input: "{}" }, context);
    expect(retired).toMatchObject({ status: "refused", code: "persist.kind-retired", exitCode: 1 });
  });

  test("wraps --store module injection in the engine control-target guard", async () => {
    const { root, context } = setup();
    // A REAL active execution authority: the injected-store guard only vetoes
    // control targets while the canonical control root (process.cwd()'s
    // harness) has an active authority, so the fixture needs one on disk.
    const activeRoot = realpathSync(mkdtempSync(join(tmpdir(), "commands-persist-active-")));
    roots.push(activeRoot);
    const harness = join(activeRoot, ".mstar");
    mkdirSync(harness, { recursive: true });
    const handle = await initializeStore({ harnessDir: harness });
    handle.close();
    await initializeExecutionAuthority({ harnessDir: harness });
    const previousCwd = process.cwd();
    process.chdir(activeRoot);
    try {
      const storeModule = join(import.meta.dir, "fixtures", "memory-store.mjs");
      const { seed } = await import(storeModule);
      seed("status", "root", { version: 2, updated_at: "2026-09-26", workflows: [] });
      seed("json", join(root, "plain.json"), { answer: 42 });

      const flag = { store: storeModule };
      const getStatus = await definition("persist.get").execute({ kind: "status", key: "root", ...flag }, context);
      expect(getStatus.status).toBe("refused");
      expect(getStatus.message).toContain("ACTIVE");

      const deleteStatus = await definition("persist.delete").execute({ kind: "status", key: "root", ...flag }, context);
      expect(deleteStatus.status).toBe("refused");
      expect(deleteStatus.message).toContain("ACTIVE");

      const plain = await definition("persist.get").execute({ kind: "json", key: join(root, "plain.json"), ...flag }, context);
      expect(plain).toMatchObject({ status: "ok", data: { payload: { answer: 42 } } });
    } finally {
      process.chdir(previousCwd);
    }
  });

  test("get, list, and delete preserve store behavior", async () => {
    const { root, store, context } = setup();
    await store.put({ kind: "review", key: "z-key", payload: { value: 1 } });
    await store.put({ kind: "review", key: "a-key", payload: { value: 2 } });

    expect(await definition("persist.get").execute({ kind: "review", key: "z-key" }, context)).toMatchObject({ status: "ok", data: { payload: { value: 1 } } });
    expect(await definition("persist.list").execute({ kind: "review" }, context)).toMatchObject({ status: "ok", data: ["a-key", "z-key"] });
    expect(await definition("persist.delete").execute({ kind: "review", key: "z-key" }, context)).toMatchObject({ status: "ok", data: { deleted: true } });
    expect(await store.get({ kind: "review", key: "z-key" })).toBeUndefined();

    const missing = await definition("persist.get").execute({ kind: "json", key: join(root, "missing.json") }, context);
    expect(missing).toMatchObject({ status: "refused", code: "persist.not-found" });
  });
});
