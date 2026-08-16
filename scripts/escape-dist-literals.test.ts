/**
 * scripts/escape-dist-literals.ts — dist escaper guard semantics (QC fix
 * wave 3: qc1 F-001 + qc2 W-1/S-2 + qc3 F-1). Pins:
 * - non-ASCII OUTSIDE comments is escaped to `\uXXXX` (value-identical);
 * - non-ASCII INSIDE comments is left untouched;
 * - idempotency — escaping the escaped output changes nothing (the real
 *   script run twice on a file leaves the bytes identical, second run clean).
 *
 * The escaper is the bundler-level half of the two-layer ASCII defense
 * (bun build re-normalizes `\uXXXX` back to raw UTF-8 in string literals);
 * removing it from the CLI build must turn the bundle-smoke fix-hint
 * assertion red.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { escapeLiterals } from "./escape-dist-literals.ts";

const SCRIPT = resolve(import.meta.dir, "escape-dist-literals.ts");

describe("escapeLiterals — non-ASCII outside comments", () => {
  test("escapes a non-ASCII char in a string literal to \\uXXXX", () => {
    const { out, count } = escapeLiterals('const s = "中";');
    expect(out).toBe('const s = "\\u4e2d";');
    expect(count).toBe(1);
  });

  test("escapes an em-dash with a zero-padded 4-digit escape", () => {
    const { out } = escapeLiterals('const s = "—";');
    expect(out).toBe('const s = "\\u2014";');
  });

  test("escapes BOTH sides of a surrogate pair (code-unit semantics)", () => {
    const { out, count } = escapeLiterals('const s = "😀";');
    expect(out).toBe('const s = "\\ud83d\\ude00";');
    expect(count).toBe(2);
  });
});

describe("escapeLiterals — comments are skipped", () => {
  test("non-ASCII in a line comment stays raw", () => {
    const src = "// 中文注释\nconst s = 'x';\n";
    const { out, count } = escapeLiterals(src);
    expect(out).toBe(src);
    expect(count).toBe(0);
  });

  test("string escaped, comment kept raw, count only counts the string", () => {
    const { out, count } = escapeLiterals('const s = "—"; // 中文\n');
    expect(out).toBe('const s = "\\u2014"; // 中文\n');
    expect(count).toBe(1);
  });
});

describe("escapeLiterals — idempotency", () => {
  test("escaping the escaped output is a no-op", () => {
    const src = 'const s = "—"; // 中文\nconst t = `模板`;\n';
    const once = escapeLiterals(src);
    const twice = escapeLiterals(once.out);
    expect(twice.out).toBe(once.out);
    expect(twice.count).toBe(0);
  });

  test("real script run twice on a file leaves bytes identical and second run clean", () => {
    const dir = mkdtempSync(join(tmpdir(), "mstar-escape-"));
    const file = join(dir, "out.js");
    const src = 'const s = "—"; // 中文\n';
    writeFileSync(file, src);
    try {
      const first = Bun.spawnSync([process.execPath, SCRIPT, file], { stdout: "pipe", stderr: "pipe" });
      expect(first.exitCode).toBe(0);
      const afterFirst = readFileSync(file);
      expect(afterFirst.toString("utf8")).toBe('const s = "\\u2014"; // 中文\n');

      const second = Bun.spawnSync([process.execPath, SCRIPT, file], { stdout: "pipe", stderr: "pipe" });
      expect(second.exitCode).toBe(0);
      expect(second.stdout.toString()).toContain("clean");

      const afterSecond = readFileSync(file);
      expect(afterSecond.equals(afterFirst)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
