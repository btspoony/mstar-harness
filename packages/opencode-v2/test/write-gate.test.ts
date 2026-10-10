import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Tool } from "@opencode/schema/tool";

import { writeBefore } from "../src/gates/write";
import { loadWriteGateApi } from "../src/engine-seams";
import type { WriteBeforeEvent, WriteGateEngineApi } from "../src/gates/write";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(enforcement: "hard" | "soft" = "hard") {
  const root = mkdtempSync(join(tmpdir(), "opencode-v2-write-gate-"));
  roots.push(root);
  const harnessDir = join(root, ".mstar");
  mkdirSync(join(harnessDir, "workflows", "wf-1"), { recursive: true });
  mkdirSync(join(harnessDir, "projects", "_default"), { recursive: true });
  writeFileSync(join(harnessDir, "status.json"), JSON.stringify({ version: 2, updated_at: "2026-10-10", workflows: [] }));
  writeFileSync(join(root, ".mstarc"), `[config]\nenforcement=${enforcement}\n`);
  return { root, harnessDir };
}

const event = (tool: string, input: unknown): WriteBeforeEvent => ({ tool, input, sessionID: "session-1", agent: "fullstack-dev", messageID: "message-1", id: "call-1" });

async function run(
  eventValue: WriteBeforeEvent,
  api?: WriteGateEngineApi,
  logger?: (level: "info" | "warn" | "error", message: string) => void,
) {
  return Effect.runPromise(writeBefore(eventValue, {
    ...(api === undefined ? {} : { loadEngine: async () => api }),
    ...(logger === undefined ? {} : { logger }),
  }));
}

function makeBody(onAllowed: () => void = () => {}) {
  let calls = 0;
  return {
    run: async (
      value: WriteBeforeEvent,
      api?: WriteGateEngineApi,
      logger?: (level: "info" | "warn" | "error", message: string) => void,
    ) => {
      await run(value, api, logger);
      calls++;
      onAllowed();
    },
    calls: () => calls,
  };
}

describe("OpenCode V2 structured-write gate", () => {
  test("refuses direct store authority writes in both enforcement modes before body execution", async () => {
    for (const mode of ["hard", "soft"] as const) {
      const { harnessDir } = harness(mode);
      const db = join(harnessDir, "store.db");
      const original = "protected bytes";
      writeFileSync(db, original);
      const body = makeBody(() => writeFileSync(db, "replacement"));

      await expect(body.run(event("write", { path: db, content: "replacement" }))).rejects.toMatchObject({
        _tag: "Tool.Error",
        message: expect.stringContaining("[store.direct-write-refused]"),
      });
      expect(body.calls()).toBe(0);
      expect(readFileSync(db, "utf8")).toBe(original);
    }
  });

  test("classifies case-variant store and retired register authority names", async () => {
    const { harnessDir } = harness("soft");
    const api = await loadWriteGateApi();
    expect(api).not.toBeNull();
    const activeApi = {
      ...api!,
      withStoreRead: async () => ({}),
    } as WriteGateEngineApi;
    const body = makeBody();

    await expect(body.run(event("write", { path: join(harnessDir, "Store.db"), content: "x" }))).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringContaining("[store.direct-write-refused]"),
    });
    await expect(body.run(event("write", { path: join(harnessDir, "Store.db-wal"), content: "x" }))).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringContaining("[store.direct-write-refused]"),
    });
    await expect(body.run(event("write", { path: join(harnessDir, "projects", "_default", "RESIDUALS.json"), content: "{}" }), activeApi)).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringContaining("[project.register.retired]"),
    });
  });

  test("refuses ACTIVE execution documents in both enforcement modes without mutating them", async () => {
    const api = await loadWriteGateApi();
    expect(api).not.toBeNull();
    const activeApi = {
      ...api!,
      resolveExecutionReadRoute: async () => "execution",
    } as WriteGateEngineApi;

    for (const mode of ["hard", "soft"] as const) {
      const { harnessDir } = harness(mode);
      const statusPath = join(harnessDir, "status.json");
      const original = readFileSync(statusPath, "utf8");
      const body = makeBody(() => writeFileSync(statusPath, "unauthorized"));
      await expect(body.run(event("write", { path: statusPath, content: "unauthorized" }), activeApi)).rejects.toMatchObject({
        _tag: "Tool.Error",
        message: expect.stringContaining("[execution.direct-write-refused]"),
      });
      expect(body.calls()).toBe(0);
      expect(readFileSync(statusPath, "utf8")).toBe(original);
    }
  });

  test("hard mode refuses invalid coordination writes; soft mode warns and proceeds", async () => {
    const hard = harness("hard");
    const hardPath = join(hard.harnessDir, "status.json");
    const hardOriginal = readFileSync(hardPath, "utf8");
    const invalid = "not-json";
    const hardBody = makeBody(() => writeFileSync(hardPath, invalid));
    await expect(hardBody.run(event("write", { path: hardPath, content: invalid }))).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringContaining("[status.invalid-json]"),
    });
    expect(hardBody.calls()).toBe(0);
    expect(readFileSync(hardPath, "utf8")).toBe(hardOriginal);

    const soft = harness("soft");
    const softPath = join(soft.harnessDir, "status.json");
    const messages: string[] = [];
    const levels: string[] = [];
    const softBody = makeBody(() => writeFileSync(softPath, invalid));
    const api = await loadWriteGateApi();
    await softBody.run(
      event("write", { path: softPath, content: invalid }),
      api!,
      (level, message) => {
        levels.push(level);
        messages.push(message);
      },
    );
    expect(softBody.calls()).toBe(1);
    expect(levels).toContain("warn");
    expect(messages.join("\\n")).toContain("status.invalid-json");
    expect(readFileSync(softPath, "utf8")).toBe(invalid);
  });

  test("post-state synthesis rejects an edit that corrupts an otherwise valid document", async () => {
    const { harnessDir } = harness("hard");
    const path = join(harnessDir, "status.json");
    const current = JSON.stringify({ version: 2, updated_at: "2026-10-10", workflows: [] });
    writeFileSync(path, current);
    const body = makeBody();

    const api = await loadWriteGateApi();
    const inputs: unknown[] = [];
    const testApi = {
      ...api!,
      validateStatusWriteDoc: (content: unknown, filePath: string, kind: "status" | "snapshot" | "register") => {
        inputs.push(content);
        return api!.validateStatusWriteDoc(content, filePath, kind);
      },
    } as WriteGateEngineApi;
    await expect(body.run(event("edit", { path, oldString: "\"version\":2", newString: "not-json", replaceAll: true }), testApi)).rejects.toBeInstanceOf(Tool.Error);
    expect(inputs).toEqual([expect.stringContaining("not-json")]);
    expect(body.calls()).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(current);
  });

  test("edit replacement strings preserve substitution tokens literally in post-state", async () => {
    const { harnessDir } = harness("hard");
    const path = join(harnessDir, "status.json");
    const current = JSON.stringify({ version: 2, updated_at: "2026-10-10", workflows: [] });
    writeFileSync(path, current);
    const api = await loadWriteGateApi();
    const inputs: unknown[] = [];
    const testApi = {
      ...api!,
      validateStatusWriteDoc: (content: unknown, filePath: string, kind: "status" | "snapshot" | "register") => {
        inputs.push(content);
        return api!.validateStatusWriteDoc(content, filePath, kind);
      },
    } as WriteGateEngineApi;

    await expect(
      run(event("edit", { path, oldString: "\"version\":2", newString: "$&", replaceAll: false }), testApi),
    ).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringContaining("[status.invalid-json]"),
    });
    expect(inputs).toEqual([expect.stringContaining("$&")]);
    expect(readFileSync(path, "utf8")).toBe(current);

  });

  test("non-composable edits validate the existing document and benign writes do not read or refuse", async () => {
    const { harnessDir, root } = harness("hard");
    const valid = JSON.stringify({ version: 2, updated_at: "2026-10-10", workflows: [] });
    const statusPath = join(harnessDir, "status.json");
    writeFileSync(statusPath, valid);
    const api = await loadWriteGateApi();
    const validated: unknown[] = [];
    const testApi = {
      ...api!,
      validateStatusWriteDoc: (content: unknown, filePath: string, kind: "status" | "snapshot" | "register") => {
        validated.push(content);
        return api!.validateStatusWriteDoc(content, filePath, kind);
      },
    } as WriteGateEngineApi;
    await expect(run(event("edit", { path: statusPath, oldString: "missing", newString: "replacement", replaceAll: false }), testApi)).resolves.toBeUndefined();
    expect(validated).toEqual([undefined]);

    const benign = join(root, "notes.txt");
    const body = makeBody();
    await body.run(event("write", { path: benign, content: "ok" }), testApi);
    expect(body.calls()).toBe(1);
    expect(validated).toEqual([undefined]);
  });

  test("normal write/edit and missing-path behavior follow the claimed seam contract", async () => {
    const { harnessDir, root } = harness("hard");
    const path = join(harnessDir, "status.json");
    const valid = JSON.stringify({ version: 2, updated_at: "2026-10-10", workflows: [] });
    await expect(run(event("write", { path, content: valid }))).resolves.toBeUndefined();
    await expect(run(event("edit", { path, oldString: "missing", newString: "replacement", replaceAll: false }))).resolves.toBeUndefined();
    await expect(run(event("write", { path: join(root, "ordinary.txt"), content: "ok" }))).resolves.toBeUndefined();

    await expect(run(event("write", { content: "no path" }))).rejects.toMatchObject({ _tag: "Tool.Error", message: expect.stringContaining("input.path") });
    await expect(run(event("edit", { path: 42 }))).rejects.toMatchObject({ _tag: "Tool.Error", message: expect.stringContaining("input.path") });
  });
});
