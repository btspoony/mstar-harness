/**
 * runCliCommand — the single execFileSync wrapper Task 2 folds the three
 * adapter wrappers (runCommand / runOmp / runDsh) into. Contract pinned here:
 * - argv is passed verbatim (shell-safe — no shell parsing; `command[0]` is
 *   the binary, `command.slice(1)` the args array),
 * - dry-run never spawns a process and returns "",
 * - cwd / timeoutMs / env pass through; defaults = no overrides,
 * - stdout returned as a utf8 string; non-zero exit throws.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCliCommand } from "../src/exec";

const NODE = process.execPath;

describe("runCliCommand", () => {
  test("returns the command stdout as a utf8 string (no opts)", () => {
    const out = runCliCommand([NODE, "-e", "process.stdout.write('héllo')"]);
    expect(out).toBe("héllo");
  });

  test("passes argv verbatim — no shell parsing of metacharacters", () => {
    const arg = "a; $HOME && $(whoami) | b";
    const out = runCliCommand([NODE, "-e", "process.stdout.write(process.argv[1])", arg]);
    expect(out).toBe(arg);
  });

  test("dryRun returns '' and never spawns (missing binary would throw)", () => {
    expect(runCliCommand(["/no/such/binary-xyz"], { dryRun: true })).toBe("");
  });

  test("dryRun ignores timeoutMs — returns '' without spawning", () => {
    expect(
      runCliCommand(["/no/such/binary-xyz", "arg"], { dryRun: true, timeoutMs: 50 }),
    ).toBe("");
  });

  test("cwd option is honored", () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-cwd-"));
    try {
      const out = runCliCommand([NODE, "-e", "process.stdout.write(process.cwd())"], { cwd: dir });
      // macOS tmpdir is under /var, a symlink to /private/var — the child's
      // process.cwd() reports the resolved real path, so compare via realpathSync.
      expect(out).toBe(realpathSync(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("env option replaces the spawned process env", () => {
    const out = runCliCommand([NODE, "-e", "process.stdout.write(process.env.EXEC_TEST_VAR ?? 'unset')"], {
      env: { EXEC_TEST_VAR: "hello" },
    });
    expect(out).toBe("hello");
  });

  test("timeoutMs kills a stalled child (ETIMEDOUT)", () => {
    // Deliberate real-timer integration: the child must actually stall so
    // execFileSync's timeout fires. Fake timers cannot drive a subprocess —
    // the timeout contract (ETIMEDOUT + SIGTERM kill) only exists against the
    // platform clock (same rationale as dsh-adapter.test.ts:471's sleep-based
    // stalled-forward test).
    expect(() =>
      runCliCommand([NODE, "-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 100 }),
    ).toThrow(/ETIMEDOUT/);
  });

  test("non-zero exit throws", () => {
    expect(() => runCliCommand([NODE, "-e", "process.exit(3)"])).toThrow();
  });

  test("stderr is not part of the returned stdout", () => {
    const out = runCliCommand([
      NODE,
      "-e",
      "process.stderr.write('boom'); process.stdout.write('ok')",
    ]);
    expect(out).toBe("ok");
  });
});
