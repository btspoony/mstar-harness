/**
 * why: the comment gate selects changed files in a shell pipeline (git diff ->
 * extension filter -> NUL handoff). A path holding a space, a non-ASCII byte
 * or a shell metacharacter must arrive as ONE target: a selection that splits
 * on a blank or a newline silently skips the touched file and the gate reports
 * clean. This test runs the SHIPPED selector against those names, so removing a
 * NUL-safety step from it fails here instead of leaving a green suite that only
 * re-implements the pipeline in JavaScript.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_FILE_EXTENSIONS } from "../src/lint.js";

/** why: the shipped selector is the only place that decides; the test holds no copy of it. */
const SELECT_SCRIPT = fileURLToPath(new URL("../../../scripts/comment-gate-select.sh", import.meta.url));

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function commit(repo: string, message: string): string {
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD").trim();
}

/** why: the selector emits NUL records, so the reader splits on NUL alone - a
 * whitespace split here would hide exactly the splitting the script must avoid. */
function selectedByShippedPipeline(repo: string, base: string): string[] {
  const out = execFileSync("bash", [SELECT_SCRIPT, base], { cwd: repo, encoding: "utf8" });
  return out.split(String.fromCharCode(0)).filter((path) => path !== "");
}

describe("comment gate - selection pipeline over hostile paths", () => {
  test("the shipped selector emits each hostile path as one NUL record", () => {
    const repo = join(mkdtempSync(join(tmpdir(), "comment-gate-pipeline-")), "repo");
    mkdirSync(repo, { recursive: true });
    try {
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.name", "Fixture");
      git(repo, "config", "user.email", "fixture@example.invalid");
      writeFileSync(join(repo, "README.md"), "fixture\n");
      const base = commit(repo, "fixture");
      // why: one hostile shape per name - a blank, a non-ASCII byte, a quote, and
      // shell metacharacters a blank-delimited consumer would split or expand.
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
      expect(selectedByShippedPipeline(repo, base).sort()).toEqual([
        "packages/$dollar; semi.ts",
        "packages/a b.ts",
        "packages/na\u00efve.ts",
        "packages/weird'quote.ts",
        "scripts/run me.sh",
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the record stays raw where plain --name-only would quote it", () => {
    const repo = join(mkdtempSync(join(tmpdir(), "comment-gate-quoting-")), "repo");
    mkdirSync(repo, { recursive: true });
    try {
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.name", "Fixture");
      git(repo, "config", "user.email", "fixture@example.invalid");
      writeFileSync(join(repo, "README.md"), "fixture\n");
      const base = commit(repo, "fixture");
      mkdirSync(join(repo, "packages"), { recursive: true });
      writeFileSync(join(repo, "packages", "na\u00efve.ts"), "export {};\n");
      commit(repo, "non-ascii");
      // why: with Git's default path quoting the plain diff is not a faithful
      // record - the non-ASCII name is octal-escaped - so a selector that dropped
      // `-z` would hand the lint a path that does not exist and skip the real one.
      const quoted = git(repo, "-c", "core.quotePath=true", "diff", "--name-only", "--diff-filter=ACMR", base);
      expect(quoted).not.toContain("na\u00efve.ts");
      expect(quoted).toContain("\\303\\257");
      expect(selectedByShippedPipeline(repo, base)).toEqual(["packages/na\u00efve.ts"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

/**
 * why: the selector and the CLI collector each decide the code face; the script
 * owns the extension pattern, and this pair breaks the moment either side
 * drifts.
 */
describe("comment gate - one extension source", () => {
  const selector = readFileSync(SELECT_SCRIPT, "utf8");

  /** why: the extension list is a shipped case pattern, so the test reads it rather than restating it. */
  function selectorExtensions(): string[] {
    const patternLine = selector.split("\n").find((line) => /\*\.tsx?\|/.test(line));
    expect(patternLine).toBeDefined();
    return [...(patternLine as string).matchAll(/\*\.([a-z]+)/g)].map((match) => `.${match[1]}`).sort();
  }

  test("the selector pattern lists exactly the collector extensions", () => {
    expect(selectorExtensions()).toEqual([...CODE_FILE_EXTENSIONS].sort());
  });
});
