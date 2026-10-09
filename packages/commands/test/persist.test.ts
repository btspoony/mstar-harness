import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFsStore, initializeExecutionAuthority, initializeStore, setArtifactStore } from "@mstar-harness/engine";
import { getPersistCommandDefinitions } from "../src/families/persist.js";
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
  const found = getPersistCommandDefinitions().find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`missing command definition: ${id}`);
  return found;
}

const REVIEW = { schema: "mstar.review/v1", verdict: "ship it", summary_md: "Review summary.", findings: [] };

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

  test("status and snapshot are rejected by every verb before injected-store loading", async () => {
    const { root, context } = setup();
    const marker = join(root, "store-calls.log");
    const storeModule = join(root, "spy-store.mjs");
    const markerLiteral = JSON.stringify(marker);
    writeFileSync(storeModule, [
      `import { appendFileSync } from "node:fs";`,
      `const marker = ${markerLiteral};`,
      `const record = (value) => appendFileSync(marker, value);`,
      `export function createArtifactStore() { record("factory"); return {`,
      `async put(doc) { record("put:" + doc.kind); },`,
      `async get(ref) { record("get:" + ref.kind); return { value: ref.kind }; },`,
      `async list(kind) { record("list:" + kind); return []; },`,
      `async delete(ref) { record("delete:" + ref.kind); },`,
      `}; }`,
    ].join("\n"));

    const cases = [
      ["persist.write", (kind: string) => ({ kind, key: "root", input: "{}", store: storeModule })],
      ["persist.get", (kind: string) => ({ kind, key: "root", store: storeModule })],
      ["persist.list", (kind: string) => ({ kind, store: storeModule })],
      ["persist.delete", (kind: string) => ({ kind, key: "root", store: storeModule })],
    ] as const;
    for (const kind of ["status", "snapshot"]) {
      for (const [commandId, makeInput] of cases) {
        const result = await definition(commandId).execute(makeInput(kind), context);
        expect(result).toMatchObject({
          status: "usage",
          code: "command.invalid-input",
          exitCode: 2,
          message: "kind must be review or json",
        });
        expect(existsSync(marker)).toBe(false);
      }
    }
  });

  test("keeps json-list restriction and retired residuals refusal", async () => {
    const { context } = setup();
    const listing = await definition("persist.list").execute({ kind: "json" }, context);
    expect(listing).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    const retired = await definition("persist.write").execute({ kind: "residuals", key: "legacy", input: "{}" }, context);
    expect(retired).toMatchObject({ status: "refused", code: "persist.kind-retired", exitCode: 1 });
  });

  test("preserves unrelated JSON reads through injected stores under ACTIVE authority", async () => {
    const { root, context } = setup();
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
      seed("json", join(root, "plain.json"), { answer: 42 });
      const plain = await definition("persist.get").execute(
        { kind: "json", key: join(root, "plain.json"), store: storeModule },
        context,
      );
      expect(plain).toMatchObject({ status: "ok", data: { payload: { answer: 42 } } });
    } finally {
      process.chdir(previousCwd);
    }
  });

  test("review CRUD and JSON write/get/delete keep their command behavior", async () => {
    const { root, store, context } = setup();
    const reviewWrite = await definition("persist.write").execute({
      kind: "review", key: "review-created", input: JSON.stringify(REVIEW),
    }, context);
    expect(reviewWrite).toMatchObject({ status: "ok", data: { kind: "review", key: "review-created" } });
    expect(await store.get({ kind: "review", key: "review-created" })).toEqual(REVIEW);

    await store.put({ kind: "review", key: "z-key", payload: { value: 1 } });
    await store.put({ kind: "review", key: "a-key", payload: { value: 2 } });
    expect(await definition("persist.get").execute({ kind: "review", key: "z-key" }, context)).toMatchObject({ status: "ok", data: { payload: { value: 1 } } });
    expect(await definition("persist.list").execute({ kind: "review" }, context)).toMatchObject({ status: "ok", data: ["a-key", "review-created", "z-key"] });
    expect(await definition("persist.delete").execute({ kind: "review", key: "z-key" }, context)).toMatchObject({ status: "ok", data: { deleted: true } });
    expect(await store.get({ kind: "review", key: "z-key" })).toBeUndefined();

    const jsonPath = join(root, "json-body.json");
    expect(await definition("persist.write").execute({ kind: "json", key: jsonPath, input: JSON.stringify({ answer: 42 }) }, context))
      .toMatchObject({ status: "ok", data: { kind: "json", key: jsonPath } });
    expect(await definition("persist.get").execute({ kind: "json", key: jsonPath }, context))
      .toMatchObject({ status: "ok", data: { payload: { answer: 42 } } });
    expect(await definition("persist.delete").execute({ kind: "json", key: jsonPath }, context))
      .toMatchObject({ status: "ok", data: { deleted: true } });
    expect(await store.get({ kind: "json", key: jsonPath })).toBeUndefined();

    const missing = await definition("persist.get").execute({ kind: "json", key: join(root, "missing.json") }, context);
    expect(missing).toMatchObject({ status: "refused", code: "persist.not-found" });
  });
  test("keys stay inside their kind namespace", async () => {
    const { root, context } = setup();
    const write = definition("persist.write");

    // Review keys are logical names, so traversal, absolute and nested paths
    // are refused before a payload reaches the store.
    for (const key of ["../escape", "nested/key", "/etc/passwd", "..", "."]) {
      const rejected = await write.execute({ kind: "review", key, input: JSON.stringify({ verdict: "x" }) }, context);
      expect(rejected).toMatchObject({ status: "refused", code: "persist.key-refused", exitCode: 1 });
    }
    // Review reads and deletes enforce the same key component boundary.
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
    expect(Object.keys(write.payloads ?? {}).sort()).toEqual(["json", "review"]);
    expect(write.payloads?.review?.schema.safeParse(REVIEW).success).toBe(true);

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
