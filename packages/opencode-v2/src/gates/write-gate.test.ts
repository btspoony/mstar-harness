import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Tool } from "@opencode/schema/tool";

import { writeBefore } from "./write";
import { loadWriteGateApi } from "../engine-seams";
import type { WriteBeforeEvent, WriteGateEngineApi } from "./write";
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
    ...(api === undefined ? {} : { loadEngine: async () => ({ api }) }),
    ...(logger === undefined ? {} : { logger }),
  }));
}


async function expectAuthorityRefusal(promise: Promise<unknown>, code: string) {
  const error = await promise.catch((caught) => caught);
  expect(error).toBeInstanceOf(Tool.Error);
  expect((error as Tool.Error).message).toContain(`[${code}]`);
  expect((error as Tool.Error).message).toContain("mstar issue");
  expect((error as Tool.Error).message).toContain("mstar plan prepare|progress|complete");
  expect((error as Tool.Error).message).toContain("mstar workflow phase|lifecycle|execution-policy|integration-worktree");
  expect((error as Tool.Error).message).toContain("mstar status workflow-close");
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
          body.run(event("write", { filePath: target, content: "unauthorized" })),
          "store.direct-write-refused",
        );
        expect(body.calls()).toBe(0);
        expect(readFileSync(target, "utf8")).toBe(original);
      }
    }
  });
  test("resolves a dangling symlink to a protected sidecar while allowing benign paths", async () => {
    const { root, harnessDir } = harness();
    const protectedTarget = join(harnessDir, "store.db-wal");
    expect(existsSync(protectedTarget)).toBe(false);
    const danglingLink = join(root, "outside-harness-dangle");
    symlinkSync(protectedTarget, danglingLink);
    const blocked = makeBody();

    await expectAuthorityRefusal(
      blocked.run(event("write", { filePath: danglingLink, content: "unauthorized" })),
      "store.direct-write-refused",
    );
    expect(blocked.calls()).toBe(0);
    expect(existsSync(protectedTarget)).toBe(false);

    const fresh = join(root, "fresh.txt");
    const freshBody = makeBody(() => writeFileSync(fresh, "fresh"));
    await freshBody.run(event("write", { filePath: fresh, content: "fresh" }));
    expect(readFileSync(fresh, "utf8")).toBe("fresh");

    const existing = join(root, "existing.txt");
    const existingAlias = join(root, "existing-alias.txt");
    writeFileSync(existing, "before");
    symlinkSync(existing, existingAlias);
    const aliasBody = makeBody(() => writeFileSync(existingAlias, "after"));
    await aliasBody.run(event("write", { filePath: existingAlias, content: "after" }));
    expect(readFileSync(existing, "utf8")).toBe("after");
  });
  test("resolves dangling symlink chains to protected targets", async () => {
    const { root, harnessDir } = harness();
    const protectedTarget = join(harnessDir, "store.db-wal");
    const inner = join(root, "inner");
    const outer = join(root, "outer");
    symlinkSync(protectedTarget, inner);
    symlinkSync("inner", outer);
    const body = makeBody();

    await expectAuthorityRefusal(
      body.run(event("write", { filePath: outer, content: "unauthorized" })),
      "store.direct-write-refused",
    );
    expect(body.calls()).toBe(0);
    expect(existsSync(protectedTarget)).toBe(false);
  });

  test("refuses cyclic symlink targets instead of allowing or hanging", async () => {
    const { root } = harness();
    const first = join(root, "cycle-a");
    const second = join(root, "cycle-b");
    symlinkSync("cycle-b", first);
    symlinkSync("cycle-a", second);
    const body = makeBody();

    await expect(body.run(event("write", { filePath: first, content: "unauthorized" }))).rejects.toBeInstanceOf(Tool.Error);
    expect(body.calls()).toBe(0);
  });



  test("classifies case-variant store sidecars and retired registers in both modes", async () => {
    const api = (await loadWriteGateApi()).api;
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
          body.run(event("write", { filePath: target, content: "unauthorized" })),
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
        registerBody.run(event("write", { filePath: register, content: "unauthorized" }), activeApi),
        "project.register.retired",
      );
      expect(registerBody.calls()).toBe(0);
      expect(readFileSync(register, "utf8")).toBe(registerBytes);
    }
  });

  test("refuses ACTIVE status and snapshot targets with unchanged bytes in both enforcement modes", async () => {
    const api = (await loadWriteGateApi()).api;
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
          body.run(event("write", { filePath: target, content: "unauthorized" }), activeApi),
          "execution.direct-write-refused",
        );
        expect(body.calls()).toBe(0);
        expect(readFileSync(target, "utf8")).toBe(original);
      }
    }
  });


  test("a pre-activation harness is no verdict for status/snapshot targets: the document lint decides", async () => {
    const api = (await loadWriteGateApi()).api;
    expect(api).not.toBeNull();
    const invalid = "not-json";
    // Issue #428 / PR #432 retired the file execution route: the engine's
    // route decision now only resolves ACTIVE or throws. A pre-activation
    // harness throws `store.not-initialized` — that is NO verdict, so the
    // compass-governed document lint below decides (hard: refused; soft:
    // warned) instead of the authority failing closed.
    for (const preActivationCode of ["store.not-initialized", "store.not-active"] as const) {
      const preActivationApi = {
        ...api!,
        resolveExecutionReadRoute: async () => {
          throw Object.assign(new Error(preActivationCode), { code: preActivationCode });
        },
      } as WriteGateEngineApi;

      const hard = harness("hard");
      const hardPath = join(hard.harnessDir, "status.json");
      const hardOriginal = readFileSync(hardPath, "utf8");
      const hardBody = makeBody(() => writeFileSync(hardPath, invalid));
      await expect(
        hardBody.run(event("write", { filePath: hardPath, content: invalid }), preActivationApi),
      ).rejects.toMatchObject({
        _tag: "Tool.Error",
        message: expect.stringContaining("[status.invalid-json]"),
      });
      expect(hardBody.calls()).toBe(0);
      expect(readFileSync(hardPath, "utf8")).toBe(hardOriginal);

      const soft = harness("soft");
      const softPath = join(soft.harnessDir, "status.json");
      const levels: string[] = [];
      const softBody = makeBody(() => writeFileSync(softPath, invalid));
      await softBody.run(
        event("write", { filePath: softPath, content: invalid }),
        preActivationApi,
        (level) => {
          levels.push(level);
        },
      );
      expect(softBody.calls()).toBe(1);
      expect(levels).toContain("warn");
    }
  });

  test("hard mode refuses invalid coordination writes; soft mode warns and proceeds", async () => {
    const hard = harness("hard");
    const hardPath = join(hard.harnessDir, "status.json");
    const hardOriginal = readFileSync(hardPath, "utf8");
    const invalid = "not-json";
    const hardBody = makeBody(() => writeFileSync(hardPath, invalid));
    await expect(hardBody.run(event("write", { filePath: hardPath, content: invalid }))).rejects.toMatchObject({
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
    const api = (await loadWriteGateApi()).api;
    await softBody.run(
      event("write", { filePath: softPath, content: invalid }),
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

    const api = (await loadWriteGateApi()).api;
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
    const api = (await loadWriteGateApi()).api;
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
    const api = (await loadWriteGateApi()).api;
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
    const api = (await loadWriteGateApi()).api;
    const validated: unknown[] = [];
    const testApi = {
      ...api!,
      validateStatusWriteDoc: (content: unknown, filePath: string, kind: "status" | "snapshot" | "register") => {
        validated.push(content);
        return api!.validateStatusWriteDoc(content, filePath, kind);
      },
    } as WriteGateEngineApi;
    await expect(run(event("edit", { filePath: statusPath, oldString: "missing", newString: "replacement", replaceAll: false }), testApi)).resolves.toBeUndefined();
    expect(validated).toEqual([undefined]);

    const benign = join(root, "notes.txt");
    const body = makeBody();
    await body.run(event("write", { filePath: benign, content: "ok" }), testApi);
    expect(body.calls()).toBe(1);
    expect(validated).toEqual([undefined]);
  });

  test("uses the V2 filePath field for write and edit targets, retaining path as a legacy fallback", async () => {
    const { harnessDir } = harness("hard");
    const filePath = join(harnessDir, "status.json");
    const activeApi = {
      ...(await loadWriteGateApi()).api!,
      resolveExecutionReadRoute: async () => "execution",
    } as WriteGateEngineApi;

    await expect(run(event("write", { filePath, content: "unauthorized" }), activeApi)).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringContaining("[execution.direct-write-refused]"),
    });
    await expect(run(event("edit", { filePath, oldString: "a", newString: "b" }), activeApi)).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringContaining("[execution.direct-write-refused]"),
    });
    await expect(run(event("write", { path: filePath, content: "legacy" }), activeApi)).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringContaining("[execution.direct-write-refused]"),
    });
  });

  test("normal write/edit and missing-path behavior follow the claimed seam contract", async () => {
    const { harnessDir, root } = harness("hard");
    const path = join(harnessDir, "status.json");
    const valid = JSON.stringify({ version: 2, updated_at: "2026-10-10", workflows: [] });
    await expect(run(event("write", { filePath: path, content: valid }))).resolves.toBeUndefined();
    await expect(run(event("edit", { filePath: path, oldString: "missing", newString: "replacement", replaceAll: false }))).resolves.toBeUndefined();
    await expect(run(event("write", { filePath: join(root, "ordinary.txt"), content: "ok" }))).resolves.toBeUndefined();

    await expect(run(event("write", { content: "no path" }))).rejects.toMatchObject({ _tag: "Tool.Error", message: expect.stringContaining("input.path") });
    await expect(run(event("edit", { filePath: 42 }))).rejects.toMatchObject({ _tag: "Tool.Error", message: expect.stringContaining("input.filePath") });
  });

  test("null engine seam refuses writes with the recovery that fits the failure", async () => {
    const missing = "The bundled engine loaded but does not export the gate exports this plugin build requires";
    await expect(Effect.runPromise(writeBefore(
      event("write", { filePath: "/tmp/unavailable-engine-target", content: "unauthorized" }),
      { loadEngine: async () => ({ api: null, failure: "exports-missing" }) },
    ))).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringMatching(/\[write\.engine-unavailable\][\s\S]*Reinstall @mstar-harness\/opencode-v2[\s\S]*reloading the host reproduces the same mismatch[\s\S]*No write was authorized/),
    });
    const caught = await Effect.runPromise(writeBefore(
      event("write", { filePath: "/tmp/unavailable-engine-target", content: "unauthorized" }),
      { loadEngine: async () => ({ api: null, failure: "exports-missing" }) },
    )).catch((error: Tool.Error) => error);
    expect((caught as Tool.Error).message).toContain(missing);
    expect((caught as Tool.Error).message).not.toMatch(/reload or restart the OpenCode host/i);
  });
  test("retains engine import failure cause and directs a reload", async () => {
    const cause = "Cannot find package '@mstar-harness/engine'";
    await expect(Effect.runPromise(writeBefore(
      event("write", { filePath: "/tmp/unavailable-engine-target", content: "unauthorized" }),
      { loadEngine: async () => { throw new Error(cause); } },
    ))).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringMatching(/\[write\.engine-unavailable\][\s\S]*Cannot find package[\s\S]*Reload or restart the OpenCode host[\s\S]*No write was authorized/),
    });
  });
  test("a cached rejected engine import refuses with the reload recovery on every write", () => {
    // An isolated process: mocking the engine module in-process leaks into the
    // sibling suites, and the rejection has to hit the real cached seam.
    const script = `
import { mock } from "bun:test";
mock.module("@mstar-harness/engine", () => { throw new Error("probe engine unavailable"); });
const logged = [];
console.error = (...args) => { logged.push(args.map(String).join(" ")); };
const { Effect } = await import("effect");
const { writeBefore } = await import(${JSON.stringify(new URL("./write.ts", import.meta.url).pathname)});
const event = { tool: "write", input: { filePath: "/tmp/cached-rejection-target", content: "x" }, sessionID: "s", agent: "a", messageID: "m", id: "c" };
const messages = [];
for (let attempt = 0; attempt < 2; attempt += 1) {
  messages.push(await Effect.runPromise(writeBefore(event, {})).catch((error) => error.message));
}
process.stdout.write(JSON.stringify({ messages, logged }));
`;
    const result = Bun.spawnSync([process.execPath, "-e", script], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
    expect(result.stderr.toString()).toBe("");
    const payload = JSON.parse(result.stdout.toString()) as { messages: string[]; logged: string[] };
    expect(payload.messages).toHaveLength(2);
    for (const message of payload.messages) {
      expect(message).toMatch(/\[write\.engine-unavailable\][\s\S]*Reload or restart the OpenCode host[\s\S]*cached for the process lifetime/);
    }
    // The cause is logged once, when the rejected load is cached.
    expect(payload.logged).toHaveLength(1);
    expect(payload.logged[0]).toContain("write gate exports unavailable: probe engine unavailable");
  });
});
