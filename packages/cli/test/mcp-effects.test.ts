import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createMcpEffects } from "../src/mcp/effects.js";
import { startBounded } from "../src/browser-opener.js";

function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), { kill: () => true }) as unknown as ChildProcess;
}

describe("bounded browser opener", () => {
  test("rejects with capability.browser.unavailable when the opener never starts", async () => {
    // A platform opener that never emits `spawn` or `error` must not pend.
    const child = fakeChild();
    const started = Date.now();
    const error = await startBounded("opener", () => child, undefined, 20).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "capability.browser.unavailable" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("rejects with command.cancelled and kills the child when the request aborts", async () => {
    let killed = false;
    const child = Object.assign(new EventEmitter(), {
      kill: () => {
        killed = true;
        return true;
      },
    }) as unknown as ChildProcess;
    const controller = new AbortController();
    const pending = startBounded("opener", () => child, controller.signal, 5_000);
    controller.abort();
    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "command.cancelled" });
    expect(killed).toBe(true);
  });

  test("resolves once the opener reports spawn", async () => {
    const child = fakeChild();
    const pending = startBounded("opener", () => child, undefined, 5_000);
    child.emit("spawn");
    await expect(pending).resolves.toBeUndefined();
  });
});

describe("mcp process effects", () => {
  test("survives a child that exits before draining the piped stdin payload", async () => {
    // Issue #441: the MCP server spawns with a piped stdin; a child that exits
    // first closes the read end, so the stdin write raises EPIPE — unhandled it
    // crashed the whole MCP process instead of reporting the child's exit code.
    const result = await createMcpEffects([]).spawn({
      argv: [process.execPath, "-e", "process.exit(0)"],
      cwd: process.cwd(),
      env: {},
      stdin: "x".repeat(1024 * 1024),
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ exitCode: 0, signal: null });
  });

  test("a missing executable rejects with the shared process.not-found shape", async () => {
    // see packages/commands/src/families/pr.ts
    // why: `pr merge-gate` builds its install hint off the `executable` field;
    // an MCP-side ENOENT that keeps the raw spawn message would lose the name.
    const error = await createMcpEffects([]).spawn({
      argv: ["mstar-no-such-executable-for-test"],
      cwd: process.cwd(),
      env: {},
      signal: new AbortController().signal,
    }).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "process.not-found", exitCode: 127, executable: "mstar-no-such-executable-for-test" });
  });

  test("a vanished working directory refuses as a directory fault, not a missing executable", async () => {
    // see packages/commands/src/effects/process.ts
    // why: the spawn error names argv[0] even when the directory is what
    // vanished, so classifying it as a missing binary tells the operator to
    // install a tool that is already installed.
    const cwd = path.join(os.tmpdir(), "mstar-effects-vanished-workspace");
    const error = await createMcpEffects([]).spawn({
      argv: [process.execPath, "-e", "0"],
      cwd,
      env: {},
      signal: new AbortController().signal,
    }).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "process.cwd-not-found", details: { cwd } });
    expect(error).not.toHaveProperty("executable");
  });

  test("a missing executable in an existing directory still reports process.not-found", async () => {
    // see packages/commands/src/effects/process.ts
    // why: the directory probe must not swallow the genuine missing-binary case.
    const error = await createMcpEffects([]).spawn({
      argv: ["mstar-no-such-executable-for-test"],
      cwd: os.tmpdir(),
      env: {},
      signal: new AbortController().signal,
    }).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "process.not-found", executable: "mstar-no-such-executable-for-test" });
  });
});
