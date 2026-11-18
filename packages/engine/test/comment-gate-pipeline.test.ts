/**
 * why: the comment gate selects changed files in a shell pipeline (git diff ->
 * extension filter -> per-file lint). A path holding a space, a non-ASCII byte
 * or a shell metacharacter must arrive as ONE target: a selection that splits
 * on a blank or a newline silently skips the touched file and the gate reports
 * clean. This test pins the half of that contract Git owns - NUL-delimited
 * records under `--name-only -z` - and the filter that runs over them.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CODE_FILE_EXTENSIONS } from "../src/lint.js";

/** why: `.sh` and `.ts` are both code faces; `.md` is not, so a docs edit never enters the ratchet. */
const CODE_FILE = /[.](?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|sh|bash|zsh|rb|java|kt|swift)$/;

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function commit(repo: string, message: string): string {
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD").trim();
}

/** why: the pipeline reads NUL-terminated records, so the reader splits on NUL alone. */
function diffPaths(repo: string, base: string): string[] {
  const out = execFileSync("git", ["-C", repo, "diff", "--name-only", "-z", "--diff-filter=ACMR", base], { encoding: "utf8" });
  return out.split(String.fromCharCode(0)).filter((path) => path !== "");
}

describe("comment gate - selection pipeline over hostile paths", () => {
  test("spaced, non-ASCII and shell-hostile paths arrive as one target each", () => {
    const repo = join(mkdtempSync(join(tmpdir(), "comment-gate-pipeline-")), "repo");
    mkdirSync(repo, { recursive: true });
    try {
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.name", "Fixture");
      git(repo, "config", "user.email", "fixture@example.invalid");
      writeFileSync(join(repo, "README.md"), "fixture\n");
      const base = commit(repo, "fixture");
      // why: one hostile shape per name - a blank, a non-ASCII byte, a quote, and
      // shell metacharacters a blank-delimited xargs would split or expand.
      const changed = [
        "packages/a b.ts",
        "packages/na\u00efve.ts",
        "packages/weird'quote.ts",
        "packages/$dollar; semi.ts",
        "scripts/run me.sh",
        "packages/readme.md",
      ];
      for (const path of changed) {
        const file = join(repo, ...path.split("/"));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "export {};\n");
      }
      commit(repo, "hostile paths");
      const selected = diffPaths(repo, base).filter((path) => CODE_FILE.test(path)).sort();
      expect(selected).toEqual([
        "packages/$dollar; semi.ts",
        "packages/a b.ts",
        "packages/na\u00efve.ts",
        "packages/weird'quote.ts",
        "scripts/run me.sh",
      ]);
      // why: with Git's default path quoting the same diff is not a faithful
      // record - the non-ASCII name is octal-escaped, so a pipeline splitting that
      // output would lint a path that does not exist and skip the real file. `-z`
      // is what keeps the record raw whatever `core.quotePath` says.
      const quoted = git(repo, "-c", "core.quotePath=true", "diff", "--name-only", "--diff-filter=ACMR", base);
      expect(quoted).not.toContain("na\u00efve.ts");
      expect(quoted).toContain("\\303\\257");
      const rawWithQuoting = execFileSync("git", ["-C", repo, "-c", "core.quotePath=true", "diff", "--name-only", "-z", "--diff-filter=ACMR", base], { encoding: "utf8" });
      expect(rawWithQuoting).toContain("na\u00efve.ts");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the filter keeps the code face and drops a documentation edit", () => {
    expect(CODE_FILE.test("packages/a b.ts")).toBe(true);
    expect(CODE_FILE.test("scripts/run me.sh")).toBe(true);
    expect(CODE_FILE.test("packages/readme.md")).toBe(false);
  });
});

/**
 * why: the CI selector and the CLI collector each decide the code face; one
 * list owns it, and this pair breaks the moment the shell pattern and the
 * exported list disagree.
 */
describe("comment gate - one extension source", () => {
  const ciWorkflow = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");

  /** why: the CI selector is a shipped shell line, so the test reads the real pattern instead of restating it. */
  function ciSelectedExtensions(): string[] {
    const shellLine = /grep -zE '([^']+)'/.exec(ciWorkflow)?.at(1);
    expect(shellLine).toBeDefined();
    const group = /\\\.\(([^)]+)\)\$/.exec(shellLine as string)?.at(1);
    expect(group).toBeDefined();
    return (group as string).split("|").map((ext) => `.${ext}`).sort();
  }

  test("the CI selector pattern lists exactly the collector extensions", () => {
    expect(ciSelectedExtensions()).toEqual([...CODE_FILE_EXTENSIONS].sort());
  });
});

