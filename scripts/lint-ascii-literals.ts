/**
 * ASCII literal lint — `bun run lint:ascii-literals`.
 *
 * Scans `packages/engine/src` + `packages/cli/src` TypeScript for non-ASCII
 * characters in CODE (comments are stripped first). The check exists because
 * bun 1.2.17 misdecodes raw multi-byte UTF-8 in regex/string literals when
 * executing the 366KB `// @bun` CLI bundle (iteration spec §7): node on the
 * same bundle, a direct engine-dist import, and small files all decode
 * correctly — only the bundled runtime path breaks. Every src-side literal
 * must therefore be a pure-ASCII `\uXXXX` escape (runtime string value is
 * identical).
 *
 * Comment stripping is a naive state machine: `//` line comments and
 * block comments (slash-star … star-slash) are dropped, but never inside
 * single/double-quoted or backtick strings (so URLs like "https://..."
 * do not false-trigger). Tests, skills, docs, and changelogs are
 * intentionally out of scope — UTF-8 is legal and necessary on the
 * data/display side (spec §7.4); this lint guards the one bug class that
 * actually breaks the bundle.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { commentMask } from "./ascii-literal-utils.ts";

const ROOT = resolve(import.meta.dir, "..");
const SCAN_DIRS = ["packages/engine/src", "packages/cli/src"];

function collectTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collectTsFiles(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
}

interface Finding {
  file: string;
  line: number;
  col: number;
  char: string;
  codePoint: string;
}

export function findings(file: string, src: string): Finding[] {
  const mask = commentMask(src);
  const out: Finding[] = [];
  let line = 1;
  let col = 1;
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) > 0x7f && mask[i] === 0) {
      const ch = src[i];
      out.push({
        file,
        line,
        col,
        char: ch,
        codePoint: `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
      });
    }
    if (src[i] === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return out;
}

/** Recursively scan every `.ts` file under `dirRoots` and return all code-literal findings. */
export function scanDirs(dirRoots: string[]): Finding[] {
  const all: Finding[] = [];
  for (const dir of dirRoots) {
    const files: string[] = [];
    collectTsFiles(dir, files);
    for (const file of files) {
      all.push(...findings(file, readFileSync(file, "utf8")));
    }
  }
  return all;
}

if (import.meta.main) {
  const all = scanDirs(SCAN_DIRS.map((dir) => join(ROOT, dir)));

  if (all.length > 0) {
    console.error(`lint:ascii-literals: ${all.length} non-ASCII character(s) in code literals (comments excluded):`);
    for (const f of all) {
      console.error(`  ${f.file}:${f.line}:${f.col}: ${f.char} (${f.codePoint})`);
    }
    console.error("escape every literal to \\uXXXX (e.g. — → \\u2014) — bun misdecodes raw UTF-8 in the CLI bundle");
    process.exit(1);
  }
  console.log("lint:ascii-literals: OK — no non-ASCII characters in src code literals");
}
