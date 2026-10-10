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


async function expectAuthorityRefusal(promise: Promise<unknown>, code: string) {
  const error = await promise.catch((caught) => caught);
  expect(error).toBeInstanceOf(Tool.Error);
  expect((error as Tool.Error).message).toContain(`[${code}]`);
  expect((error as Tool.Error).message).toContain("mstar issue");
  expect((error as Tool.Error).message).toContain("mstar catalog");
  expect((error as Tool.Error).message).toContain("mstar store upgrade/migrate");
  expect((error as Tool.Error).message).toContain("project maintainer");
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
  test("refuses store.db and WAL/SHM sidecars with unchanged bytes in both enforcement modes", async () => {
    for (const mode of ["hard", "soft"] as const) {
      const { harnessDir } = harness(mode);
      for (const name of ["store.db", "store.db-wal", "store.db-shm"]) {
        const target = join(harnessDir, name);
        const original = `${name} protected bytes`;
        writeFileSync(target, original);
        const body = makeBody(() => writeFileSync(target, "unauthorized"));

        await expectAuthorityRefusal(
          body.run(event("write", { path: target, content: "unauthorized" })),
          "store.direct-write-refused",
        );
        expect(body.calls()).toBe(0);
        expect(readFileSync(target, "utf8")).toBe(original);
      }
    }
  });

  test("classifies case-variant store sidecars and retired registers in both modes", async () => {
    const api = await loadWriteGateApi();
    expect(api).not.toBeNull();
    const activeApi = {
      ...api!,
      withStoreRead: async () => ({}),
    } as WriteGateEngineApi;

    for (const mode of ["hard", "soft"] as const) {
      const { harnessDir } = harness(mode);
      for (const name of ["Store.db", "Store.db-wal", "Store.db-shm"]) {
        const target = join(harnessDir, name);
        const original = `${name} case-folded bytes`;
        writeFileSync(target, original);
        const body = makeBody(() => writeFileSync(target, "unauthorized"));
        await expectAuthorityRefusal(
          body.run(event("write", { path: target, content: "unauthorized" })),
          "store.direct-write-refused",
        );
        expect(body.calls()).toBe(0);
        expect(readFileSync(target, "utf8")).toBe(original);
      }

      const register = join(harnessDir, "projects", "_default", "RESIDUALS.json");
      const registerBytes = "retired register bytes";
      writeFileSync(register, registerBytes);
      const registerBody = makeBody(() => writeFileSync(register, "unauthorized"));
      await expectAuthorityRefusal(
        registerBody.run(event("write", { path: register, content: "unauthorized" }), activeApi),
        "project.register.retired",
      );
      expect(registerBody.calls()).toBe(0);
      expect(readFileSync(register, "utf8")).toBe(registerBytes);
    }
  });

  test("refuses ACTIVE status and snapshot targets with unchanged bytes in both enforcement modes", async () => {
    const api = await loadWriteGateApi();
    expect(api).not.toBeNull();
    const activeApi = {
      ...api!,
      resolveExecutionReadRoute: async () => "execution",
    } as WriteGateEngineApi;

    for (const mode of ["hard", "soft"] as const) {
      const { harnessDir } = harness(mode);
      const targets = [
        join(harnessDir, "status.json"),
        join(harnessDir, "workflows", "wf-1", "snapshot.json"),
      ];
      for (const target of targets) {
        const original = `protected bytes ${target}`;
        writeFileSync(target, original);
        const body = makeBody(() => writeFileSync(target, "unauthorized"));
        await expectAuthorityRefusal(
          body.run(event("write", { path: target, content: "unauthorized" }), activeApi),
          "execution.direct-write-refused",
        );
        expect(body.calls()).toBe(0);
        expect(readFileSync(target, "utf8")).toBe(original);
      }
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

  test("omitted replaceAll defaults to a unique-match edit and validates synthesized post-state", async () => {
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
    const body = makeBody();

    await expect(
      body.run(event("edit", { path, oldString: "\"version\":2", newString: "not-json" }), testApi),
    ).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringContaining("[status.invalid-json]"),
    });
    expect(inputs).toEqual([expect.stringContaining("not-json")]);
    expect(body.calls()).toBe(0);
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
