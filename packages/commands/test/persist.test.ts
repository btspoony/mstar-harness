import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  test("status replacement is explicit last-write-wins without a byte token", async () => {
    const { harness, store, context } = setup();
    const write = definition("persist.write");
    writeFileSync(join(harness, "status.json"), JSON.stringify(STATUS));
    const result = await write.execute({ kind: "status", key: "root", input: JSON.stringify(STATUS) }, context);
    expect(result).toMatchObject({ status: "ok", data: { kind: "status", key: "root" } });
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
  test("keys stay inside their kind namespace", async () => {
    const { root, store, context } = setup();
    const write = definition("persist.write");

    // Non-json kinds are logical names: a traversal segment, an absolute path,
    // or a nested path is refused before the store is reached — the same
    // verdict the store's own `assertSafePathComponent` gives, one layer earlier
    // and before any payload is read.
    for (const key of ["../escape", "nested/key", "/etc/passwd", "..", "."]) {
      const rejected = await write.execute({ kind: "review", key, input: JSON.stringify({ verdict: "x" }) }, context);
      expect(rejected).toMatchObject({ status: "refused", code: "persist.key-refused", exitCode: 1 });
    }
    // The read and delete faces apply the same contract.
    expect(await definition("persist.get").execute({ kind: "snapshot", key: "../escape" }, context))
      .toMatchObject({ status: "refused", code: "persist.key-refused" });
    expect(await definition("persist.delete").execute({ kind: "review", key: "a/b" }, context))
      .toMatchObject({ status: "refused", code: "persist.key-refused" });

    // json's key IS an absolute path (the store's escape hatch) — but a `..`
    // segment is refused before the store ever sees it, as it does there too.
    const escapeName = "mstar-persist-escape-probe.json";
    const traversal = await write.execute({ kind: "json", key: `${root}/../${escapeName}`, input: "{}" }, context);
    expect(traversal).toMatchObject({ status: "refused", code: "persist.key-refused" });
    expect(existsSync(join(dirname(root), escapeName))).toBe(false);
    // …and a non-absolute json key keeps its original refusal shape.
    const relative = await write.execute({ kind: "json", key: "relative/path.json", input: "{}" }, context);
    expect(relative).toMatchObject({ status: "refused", exitCode: 1 });
    expect(relative.message).toContain("absolute path");
  });

  test("aggregate validation declares governed schemas and arbitrary JSON as parse-only", async () => {
    const { root, context } = setup();
    const write = definition("persist.write");
    expect(Object.keys(write.payloads ?? {}).sort()).toEqual(["json", "review", "snapshot", "status"]);
    expect(write.payloads?.status?.schema.safeParse(STATUS).success).toBe(true);

    const invalid = await write.execute({ kind: "status", key: "root", input: JSON.stringify({ version: 2, workflows: "bad" }) }, context);
    expect(invalid).toMatchObject({ status: "refused", code: "persist.write-refused" });
    expect(invalid.message).toContain("updated_at");
    expect(invalid.message).toContain("workflows");
    const invalidReview = await write.execute({ kind: "review", key: "review", input: "{}" }, context);
    expect(invalidReview.status).toBe("refused");
    expect(invalidReview.message).toContain("schema");
    expect(invalidReview.message).toContain("findings");
    const arbitraryPath = join(root, "opaque.json");
    const stored = await write.execute({ kind: "json", key: arbitraryPath, input: JSON.stringify({ anything: [1, true] }) }, context);
    expect(stored.status).toBe("ok");
    const checked = await definition("persist.get").execute({ kind: "json", key: arbitraryPath, validate: true }, context);
    expect(checked).toMatchObject({ status: "ok", data: { validation: "parse-only", payload: { anything: [1, true] } } });
  });
});
