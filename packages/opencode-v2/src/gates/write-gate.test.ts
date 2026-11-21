import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import * as Engine from "@mstar-harness/engine";
import { Tool } from "@opencode/schema/tool";

import { writeBefore } from "./write";
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
    ...(api === undefined ? {} : { engine: api }),
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
/** A fake engine whose collaboration probe answers the named verdict. */
function collaborationApi(
  probe: { kind: "active" } | { kind: "staged" | "absent" | "unavailable"; code: string; message: string },
): WriteGateEngineApi {
  return {
    ...Engine,
    probeCollaborationAuthority: async () =>
      probe.kind === "active"
        ? ({ kind: "active", authority: {} } as never)
        : (probe as never),
  } as WriteGateEngineApi;
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

function expectPreservedStatus(path: string) {
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
    updated_at: "2026-10-10",
    workflows: [],
  });
}

describe("OpenCode V2 structured-write gate", () => {
  test("refuses store.db and WAL/SHM sidecar writes in both enforcement modes", async () => {
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
        expect(readFileSync(target, "utf8")).toContain("protected bytes");
        expect(readFileSync(target, "utf8")).not.toContain("unauthorized");
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
    const freshBody = makeBody(() => writeFileSync(fresh, "marker=fresh-write\n"));
    await freshBody.run(event("write", { filePath: fresh, content: "marker=fresh-write\n" }));
    expect(freshBody.calls()).toBe(1);
    expect(existsSync(fresh)).toBe(true);
    expect(readFileSync(fresh, "utf8")).toContain("fresh-write");

    const existing = join(root, "existing.txt");
    const existingAlias = join(root, "existing-alias.txt");
    writeFileSync(existing, "marker=before\n");
    symlinkSync(existing, existingAlias);
    const aliasBody = makeBody(() => writeFileSync(existingAlias, "marker=after\n"));
    await aliasBody.run(event("write", { filePath: existingAlias, content: "marker=after\n" }));
    expect(aliasBody.calls()).toBe(1);
    expect(readFileSync(existing, "utf8")).toContain("after");
    expect(readFileSync(existing, "utf8")).not.toContain("before");
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
    const activeApi = collaborationApi({ kind: "active" });

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
        expect(readFileSync(target, "utf8")).toContain("case-folded bytes");
        expect(readFileSync(target, "utf8")).not.toContain("unauthorized");
      }

      const register = join(harnessDir, "projects", "_default", "RESIDUALS.json");
      const registerBytes = JSON.stringify({ fixture: "retired-register", retained: true });
      writeFileSync(register, registerBytes);
      const registerBody = makeBody(() => writeFileSync(register, "unauthorized"));
      await expectAuthorityRefusal(
        registerBody.run(event("write", { filePath: register, content: "unauthorized" }), activeApi),
        "project.register.retired",
      );
      expect(registerBody.calls()).toBe(0);
      expect(JSON.parse(readFileSync(register, "utf8")).retained).toBe(true);
    }
  });

  test("collaboration source combinations refuse registers by their own cause in both modes", async () => {
    const verdicts = [
      { probe: { kind: "absent", code: "collaboration.not-initialized", message: "no lane" }, cause: "collaboration.not-initialized" },
      { probe: { kind: "staged", code: "collaboration.not-active", message: "staged lane" }, cause: "collaboration.not-active" },
      { probe: { kind: "unavailable", code: "collaboration.unreadable", message: "broken lane" }, cause: "collaboration.unreadable" },
    ] as const;

    for (const mode of ["hard", "soft"] as const) {
      for (const verdict of verdicts) {
        const { harnessDir } = harness(mode);
        const register = join(harnessDir, "projects", "_default", "residuals.json");
        writeFileSync(register, JSON.stringify({ entries: {} }));
        const body = makeBody(() => writeFileSync(register, "unauthorized"));

        await expectAuthorityRefusal(
          body.run(event("write", { filePath: register, content: "unauthorized" }), collaborationApi(verdict.probe)),
          "store.authority-unavailable",
        );
        expect(body.calls()).toBe(0);
        const message = await body.run(
          event("write", { filePath: register, content: "unauthorized" }),
          collaborationApi(verdict.probe),
        ).catch((error: Tool.Error) => error.message);
        expect(message).toContain(verdict.cause);
      }
    }
  });

  test("a register reached through a symlink alias is judged by the bytes it lands on", async () => {
    const { root, harnessDir } = harness("hard");
    const register = join(harnessDir, "projects", "_default", "residuals.json");
    writeFileSync(register, JSON.stringify({ entries: {} }));
    const alias = join(root, "aliases");
    mkdirSync(alias, { recursive: true });
    const aliasPath = join(alias, "carry-over.json");
    symlinkSync(register, aliasPath);
    const body = makeBody(() => writeFileSync(register, "unauthorized"));

    await expectAuthorityRefusal(
      body.run(event("write", { filePath: aliasPath, content: "unauthorized" }), collaborationApi({ kind: "active" })),
      "project.register.retired",
    );
    expect(body.calls()).toBe(0);
  });

  test("refuses ACTIVE status and snapshot writes in both enforcement modes", async () => {
    const activeApi = {
      ...Engine,
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
        expect(readFileSync(target, "utf8")).toContain("protected bytes");
        expect(readFileSync(target, "utf8")).not.toContain("unauthorized");
      }
    }
  });


  test("a pre-activation harness is no verdict for status/snapshot targets: the document lint decides", async () => {
    const invalid = "not-json";
    // Issue #428 / PR #432 retired the file execution route: the engine's
    // route decision now only resolves ACTIVE or throws. A pre-activation
    // harness throws `store.not-initialized` — that is NO verdict, so the
    // compass-governed document lint below decides (hard: refused; soft:
    // warned) instead of the authority failing closed.
    for (const preActivationCode of ["store.not-initialized", "store.not-active"] as const) {
      const preActivationApi = {
        ...Engine,
        resolveExecutionReadRoute: async () => {
          throw Object.assign(new Error(preActivationCode), { code: preActivationCode });
        },
      } as WriteGateEngineApi;

      const hard = harness("hard");
      const hardPath = join(hard.harnessDir, "status.json");
      const hardBody = makeBody(() => writeFileSync(hardPath, invalid));
      await expect(
        hardBody.run(event("write", { filePath: hardPath, content: invalid }), preActivationApi),
      ).rejects.toMatchObject({
        _tag: "Tool.Error",
        message: expect.stringContaining("[status.invalid-json]"),
      });
      expect(hardBody.calls()).toBe(0);
      expectPreservedStatus(hardPath);

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
    const invalid = "not-json";
    const hardBody = makeBody(() => writeFileSync(hardPath, invalid));
    await expect(hardBody.run(event("write", { filePath: hardPath, content: invalid }))).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringContaining("[status.invalid-json]"),
    });
    expect(hardBody.calls()).toBe(0);
    expectPreservedStatus(hardPath);

    const soft = harness("soft");
    const softPath = join(soft.harnessDir, "status.json");
    const messages: string[] = [];
    const levels: string[] = [];
    const softBody = makeBody(() => writeFileSync(softPath, invalid));
    await softBody.run(
      event("write", { filePath: softPath, content: invalid }),
      Engine,
      (level, message) => {
        levels.push(level);
        messages.push(message);
      },
    );
    expect(softBody.calls()).toBe(1);
    expect(levels).toContain("warn");
    expect(messages.join("\\n")).toContain("status.invalid-json");
    expect(() => JSON.parse(readFileSync(softPath, "utf8"))).toThrow();
  });

  test("post-state synthesis rejects an edit that corrupts an otherwise valid document", async () => {
    const { harnessDir } = harness("hard");
    const path = join(harnessDir, "status.json");
    const current = JSON.stringify({ version: 2, updated_at: "2026-10-10", workflows: [] });
    writeFileSync(path, current);
    const body = makeBody();

    const inputs: unknown[] = [];
    const testApi = {
      ...Engine,
      validateStatusWriteDoc: (content: unknown, filePath: string, kind: "status" | "snapshot" | "register") => {
        inputs.push(content);
        return Engine.validateStatusWriteDoc(content, filePath, kind);
      },
    } as WriteGateEngineApi;
    await expect(body.run(event("edit", { path, oldString: "\"version\":2", newString: "not-json", replaceAll: true }), testApi)).rejects.toBeInstanceOf(Tool.Error);
    expect(inputs).toEqual([expect.stringContaining("not-json")]);
    expect(body.calls()).toBe(0);
    expectPreservedStatus(path);
  });

  test("edit replacement strings preserve substitution tokens literally in post-state", async () => {
    const { harnessDir } = harness("hard");
    const path = join(harnessDir, "status.json");
    const current = JSON.stringify({ version: 2, updated_at: "2026-10-10", workflows: [] });
    writeFileSync(path, current);
    const inputs: unknown[] = [];
    const testApi = {
      ...Engine,
      validateStatusWriteDoc: (content: unknown, filePath: string, kind: "status" | "snapshot" | "register") => {
        inputs.push(content);
        return Engine.validateStatusWriteDoc(content, filePath, kind);
      },
    } as WriteGateEngineApi;

    await expect(
      run(event("edit", { path, oldString: "\"version\":2", newString: "$&", replaceAll: false }), testApi),
    ).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringContaining("[status.invalid-json]"),
    });
    expect(inputs).toEqual([expect.stringContaining("$&")]);
    expectPreservedStatus(path);

  });

  test("omitted replaceAll defaults to a unique-match edit and validates synthesized post-state", async () => {
    const { harnessDir } = harness("hard");
    const path = join(harnessDir, "status.json");
    const current = JSON.stringify({ version: 2, updated_at: "2026-10-10", workflows: [] });
    writeFileSync(path, current);
    const inputs: unknown[] = [];
    const testApi = {
      ...Engine,
      validateStatusWriteDoc: (content: unknown, filePath: string, kind: "status" | "snapshot" | "register") => {
        inputs.push(content);
        return Engine.validateStatusWriteDoc(content, filePath, kind);
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
    expectPreservedStatus(path);
  });

  test("non-composable edits validate the existing document and benign writes do not read or refuse", async () => {
    const { harnessDir, root } = harness("hard");
    const valid = JSON.stringify({ version: 2, updated_at: "2026-10-10", workflows: [] });
    const statusPath = join(harnessDir, "status.json");
    writeFileSync(statusPath, valid);
    const validated: unknown[] = [];
    const testApi = {
      ...Engine,
      validateStatusWriteDoc: (content: unknown, filePath: string, kind: "status" | "snapshot" | "register") => {
        validated.push(content);
        return Engine.validateStatusWriteDoc(content, filePath, kind);
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
      ...Engine,
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

  test("normal write/edit and missing-path behavior follow the gate contract", async () => {
    const { harnessDir, root } = harness("hard");
    const path = join(harnessDir, "status.json");
    const valid = JSON.stringify({ version: 2, updated_at: "2026-10-10", workflows: [] });
    await expect(run(event("write", { filePath: path, content: valid }))).resolves.toBeUndefined();
    await expect(run(event("edit", { filePath: path, oldString: "missing", newString: "replacement", replaceAll: false }))).resolves.toBeUndefined();
    await expect(run(event("write", { filePath: join(root, "ordinary.txt"), content: "ok" }))).resolves.toBeUndefined();

    await expect(run(event("write", { content: "no path" }))).rejects.toMatchObject({ _tag: "Tool.Error", message: expect.stringContaining("input.path") });
    await expect(run(event("edit", { filePath: 42 }))).rejects.toMatchObject({ _tag: "Tool.Error", message: expect.stringContaining("input.filePath") });
  });

});
