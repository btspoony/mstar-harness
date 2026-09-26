import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createMcpEffects } from "../src/effects.js";

const request = (cwd: string, signal: AbortSignal, argv: readonly string[], stdin?: string) => ({
  argv,
  cwd,
  env: process.env as Record<string, string>,
  signal,
  ...(stdin === undefined ? {} : { stdin }),
});

test("MCP process effects preserve bounded stdin, normal exit and cancellation", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mcp-effects-"));
  try {
    const effects = createMcpEffects([]);
    const completed = await effects.spawn(request(cwd, new AbortController().signal, [process.execPath, "-e", "process.stdin.on('data', d => process.stdout.write(d)); process.stdin.on('end', () => process.stderr.write('done'))"], "payload"));
    assert.deepEqual(completed, { exitCode: 0, signal: null, stdout: "payload", stderr: "done" });

    const exactExit = await effects.spawn(request(cwd, new AbortController().signal, [process.execPath, "-e", "process.exit(127)"]));
    assert.equal(exactExit.exitCode, 127);

    const reservedExit = await effects.spawn(request(cwd, new AbortController().signal, [process.execPath, "-e", "process.exit(124)"]));
    assert.equal(reservedExit.exitCode, 124);
    await assert.rejects(effects.spawn(request(cwd, new AbortController().signal, [process.execPath, "-e", "process.stdout.write(Buffer.alloc(1024 * 1024 + 1))"])), (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, "command.effect-unavailable");
      return true;
    });

    const controller = new AbortController();
    const pending = effects.spawn(request(cwd, controller.signal, [process.execPath, "-e", "setInterval(() => {}, 1000)"]));
    setTimeout(() => controller.abort(), 30);
    const cancelled = await pending;
    assert.equal(cancelled.exitCode, 143);
    assert.equal(cancelled.signal, "SIGTERM");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("MCP process effects surface missing executable as exact child exit 127", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mcp-effects-"));
  try {
    const effects = createMcpEffects([]);
    await assert.rejects(effects.spawn(request(cwd, new AbortController().signal, [path.join(cwd, "missing-child")])), (error: NodeJS.ErrnoException & { exitCode?: number }) => {
      assert.equal(error.code, "process.not-found");
      assert.equal(error.exitCode, 127);
      return true;
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("MCP stdin reads the request-local payload once and rejects absent input", async () => {
  const effects = createMcpEffects([]);
  await effects.withInput({ input: "explicit payload" }, async () => {
    assert.equal(await effects.readInput(), "explicit payload");
    await assert.rejects(effects.readInput(), /only be consumed once/);
  });
  await effects.withInput({}, async () => assert.rejects(effects.readInput(), /explicit input string/));
});

test("MCP reports unavailable special effects as named capability refusals", async () => {
  const effects = createMcpEffects([]);
  await assert.rejects(effects.captureSddEvidence("", []), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "command.effect-unavailable");
    assert.match(error.message, /sdd-evidence\.capture/);
    return true;
  });
});
