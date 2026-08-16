/**
 * scripts/lint-ascii-literals.ts — src ASCII lint guard semantics (QC fix
 * wave 3: qc1 F-001 + qc2 W-1/S-2 + qc3 F-1). Pins:
 * - findings() reports each code non-ASCII char as file:line:col + U+XXXX;
 * - comment-only non-ASCII yields no findings (comments are stripped);
 * - scanDirs() recursively walks `.ts` files and aggregates findings;
 * - the real script exits 0 on the current clean src tree (the CI gate).
 *
 * The lint is line 1 of the two-layer ASCII defense; a regression in the
 * shared commentMask (false negative) would silently re-open the bun-bundle
 * misdecode bug class (iteration spec §7).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findings, scanDirs } from "./lint-ascii-literals.ts";

const SCRIPT = resolve(import.meta.dir, "lint-ascii-literals.ts");

describe("findings — hit report (file:line:col + code point)", () => {
  test("non-ASCII in a code literal is reported with line 1 / col 12", () => {
    expect(findings("src/x.ts", "const s = '中';\n")).toEqual([
      { file: "src/x.ts", line: 1, col: 12, char: "中", codePoint: "U+4E2D" },
    ]);
  });

  test("line/col advance across newlines; comment chars are not reported", () => {
    expect(findings("src/x.ts", "// 注释\nconst s = '中';\n")).toEqual([
      { file: "src/x.ts", line: 2, col: 12, char: "中", codePoint: "U+4E2D" },
    ]);
  });

  test("comment-only non-ASCII yields no findings", () => {
    expect(findings("src/x.ts", "// 注释\n")).toEqual([]);
    expect(findings("src/x.ts", "/* 块\n注释 */\n")).toEqual([]);
  });

  test("surrogate pair is reported per code unit (lint scans code units)", () => {
    const hits = findings("src/x.ts", 'const s = "😀";\n');
    expect(hits).toHaveLength(2);
    expect(hits[0].codePoint).toBe("U+D83D");
    expect(hits[1].codePoint).toBe("U+DE00");
  });
});

describe("scanDirs — recursive .ts scan over a directory tree", () => {
  test("aggregates findings from nested .ts files, skips clean and comment-only files", () => {
    const dir = mkdtempSync(join(tmpdir(), "mstar-lint-"));
    try {
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "a.ts"), "const a = 1; // fine\n");
      writeFileSync(join(dir, "b.ts"), "// 注释\n");
      writeFileSync(join(dir, "c.ts"), "const c = '中';\n");
      writeFileSync(join(dir, "sub/deep.ts"), "const d = '深';\n");

      const hits = scanDirs([dir]);
      expect(hits).toHaveLength(2);
      const files = hits.map((h) => h.file);
      expect(files.some((f) => f.endsWith("c.ts"))).toBe(true);
      expect(files.some((f) => f.endsWith("deep.ts"))).toBe(true);
      expect(hits.map((h) => h.char).sort()).toEqual(["中", "深"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lint-ascii-literals — exit-code contract", () => {
  test("real script exits 0 on the current clean src tree", () => {
    const proc = Bun.spawnSync([process.execPath, SCRIPT], { stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("lint:ascii-literals: OK");
  });
});
