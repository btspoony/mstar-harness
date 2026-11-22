/** Command-owned CLI subprocess coverage; fixture and assertion contracts are preserved. */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, withTempDir } from "./harness";
import { cliEnvelope, expectUsageDiagnostic, lintResults, lintViolationCodes } from "./support/cli-assertions";

/** why: the ratchet diffs the working tree against this commit, so each test
 * edits one file after seeding and then lints what it wrote. */
function commitBase(dir: string, files: Record<string, string>): void {
  const git = (args: string[]): void => {
    execFileSync("git", [...args], { cwd: dir, stdio: "ignore" });
  };
  const identity = ["-c", "user.email=lint-cli-test@example.com", "-c", "user.name=Lint CLI Test", "-c", "commit.gpgsign=false"];
  git(["init", "-q"]);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  git([...identity, "add", "-A"]);
  git([...identity, "commit", "-q", "-m", "base"]);
}

// ---------------------------------------------------------------------------
// mstar lint
// ---------------------------------------------------------------------------

describe("mstar lint — content-type lints", () => {
  test("plan file with placeholder → lint.plan-quality.placeholder, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "20260808-bad-plan.md");
      writeFileSync(file, "# Plan\n\n## Goal\nShip TBD module.\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(1);
      expect(lintViolationCodes(result)).toContain("lint.plan-quality.placeholder");
    });
  });

  test("clean plan file → OK, exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "20260808-good-plan.md");
      writeFileSync(file, "# Plan\n\n## Goal\nShip the module.\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(0);
      expect(lintResults(result)[0]?.violations).toEqual([]);
    });
  });

  test("STRATEGY.md missing sections → lint.strategy.missing-section, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "STRATEGY.md");
      writeFileSync(file, "# Strategy\n\nNo sections here.\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(1);
      expect(lintViolationCodes(result)).toContain("lint.strategy.missing-section");
      expect(lintResults(result)[0]?.violations.map(({ message }) => message).join("\n")).toContain('"Vision"');
    });
  });

  test("STRATEGY.md with all required sections → exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "STRATEGY.md");
      writeFileSync(
        file,
        [
          "# Strategy",
          "",
          "## Vision",
          "## What we build",
          "## What we don't build",
          "## Guiding Principles",
          "## Technology Direction",
          "## Decision Log",
          "",
        ].join("\n"),
      );
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(0);
      expect(lintResults(result)[0]?.violations).toEqual([]);
    });
  });

  test("SKILL.md bad frontmatter → lint.frontmatter.*, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "SKILL.md");
      writeFileSync(file, "---\nname: My-Skill\n---\n\n# Body\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(1);
      expect(lintViolationCodes(result)).toEqual(expect.arrayContaining(["lint.frontmatter.name.format", "lint.frontmatter.description.missing"]));
    });
  });

  test("SKILL.md clean frontmatter → exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "SKILL.md");
      writeFileSync(
        file,
        "---\nname: sample-skill\ndescription: Validates harness fixtures during CLI smoke tests.\n---\n\n# Body\n",
      );
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(0);
      expect(lintResults(result)[0]?.violations).toEqual([]);
    });
  });

  test("task report prose without evidence → exit 0 (lint checks structure only)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "task-1-report.md");
      writeFileSync(file, "Did the work. Output looked fine.\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(0);
      expect(lintResults(result)[0]?.violations).toEqual([]);
    });
  });

  test("task report with bare Tests: N/A → lint.sdd-evidence.bare-tests-na, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "task-1-report.md");
      writeFileSync(file, "Tests: N/A\nDid the work.\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(1);
      expect(lintViolationCodes(result)).toContain("lint.sdd-evidence.bare-tests-na");
    });
  });

  for (const reason of ["Policy scope and trigger changed; exact changed lines checked.", "TBD"]) {
    test(`task report scoped-check ${reason === "TBD" ? "invalid reason → exit 1" : "valid → exit 0"}`, () => {
      withTempDir("mstar-slice4-cli-", (dir) => {
        const file = join(dir, "task-1-report.md");
        writeFileSync(file, `Verification mode: scoped-check
Changed files: skills/example/SKILL.md
Tests: N/A
Reason: ${reason}
Check command: rg -n 'scope' skills/example/SKILL.md
Check result: exit 0; changed scope line found.
`);
        const result = runCli(["lint", file]);
        expect(result.exitCode).toBe(reason === "TBD" ? 1 : 0);
        if (reason === "TBD") expect(lintViolationCodes(result)).toContain("lint.sdd-evidence.reason");
        else expect(lintResults(result)[0]?.violations).toEqual([]);
      });
    });
  }

  test("task report with full TDD triple → exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "task-1-report.md");
      writeFileSync(
        file,
        "## Evidence\n\nCovering test file(s): test/foo.test.ts\nCommand run: bun test test/foo.test.ts\n12 pass / 0 fail\n",
      );
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(0);
      expect(lintResults(result)[0]?.violations).toEqual([]);
    });
  });

  test("code file with temporary marker lacking removal path → lint.temporary.no-removal-path, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "hack.ts");
      writeFileSync(file, "// temporary: hack\nconst x = 1;\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(1);
      expect(lintViolationCodes(result)).toContain("lint.temporary.no-removal-path");
      expect(lintResults(result)[0]?.markers.join("\n")).toContain("temporary marker @1");
    });
  });

  test("code file with temporary marker + removal path → exit 0, marker printed", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "hack.ts");
      writeFileSync(file, "// temporary: shim — removal tracked in status.json\nconst x = 1;\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(0);
      const markers = lintResults(result)[0]?.markers.join("\n");
      expect(markers).toContain("temporary marker @1");
      expect(markers).toContain("removal: status.json");
    });
  });

  test("code file with a complete simplify marker → exit 0, marker printed", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.ts");
      writeFileSync(file, "// simplify: naive scan; upgrade: index the map\nconst y = 2;\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(0);
      expect(lintResults(result)[0]?.markers.join("\n")).toContain("simplify marker @1");
    });
  });

  test("simplify without an upgrade path → lint.simplify.no-upgrade-path, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.ts");
      writeFileSync(file, "// simplify: naive scan\nconst a = 1;\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(1);
      expect(lintViolationCodes(result)).toContain("lint.simplify.no-upgrade-path");
      expect(lintResults(result)[0]?.markers).toEqual([]);
    });
  });

  test("a marker opened mid-sentence with no bound → exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "server.ts");
      writeFileSync(file, "// refused. simplify: FIFO chain - one queue.\nconst a = 1;\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(1);
      expect(lintViolationCodes(result)).toContain("lint.simplify.no-upgrade-path");
    });
  });

  test("a bound on a continuation comment line → exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "server.ts");
      writeFileSync(file, "// refused. simplify: FIFO chain - one queue.\n// upgrade: per-route queues once a profile shows the queue.\nconst a = 1;\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(0);
      expect(lintResults(result)[0]?.markers.join("\n")).toContain("simplify marker @1");
    });
  });

  test("the #123 reference comments.md lists satisfies the bound → exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.ts");
      writeFileSync(file, "// simplify: naive scan\n// removal tracked in #123\nconst a = 1;\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(0);
      expect(lintViolationCodes(result)).toEqual([]);
    });
  });

  test("a code line carrying a bare residual word is not a bound → exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.ts");
      writeFileSync(file, "// simplify: naive scan\nconst residual = 1;\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(1);
      expect(lintViolationCodes(result)).toContain("lint.simplify.no-upgrade-path");
    });
  });

  test("a trailing marker after code keeps its same-line bound → exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.py");
      writeFileSync(file, "x = 1  # simplify: naive scan; upgrade: index the map\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(0);
      expect(lintResults(result)[0]?.markers.join("\n")).toContain("simplify marker @1");
    });
  });

  test("an `upgrade:` clause with no value does not satisfy the gate → exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.ts");
      writeFileSync(file, "// simplify: naive scan; upgrade:\nconst a = 1;\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(1);
      expect(lintViolationCodes(result)).toContain("lint.simplify.no-upgrade-path");
    });
  });

  test("a bound outside the block comment is not read (code after the close) → exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.ts");
      writeFileSync(file, '/* simplify: naive scan */ const p = "plans/y.md";\n');
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(1);
      expect(lintViolationCodes(result)).toContain("lint.simplify.no-upgrade-path");
    });
  });

  test("a trailing marker after code with no bound → lint.simplify.no-upgrade-path, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.sh");
      writeFileSync(file, "x=1  # simplify: naive scan\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(1);
      expect(lintViolationCodes(result)).toContain("lint.simplify.no-upgrade-path");
    });
  });

  test("untracked TODO and commented-out code → advisory markers, exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.ts");
      writeFileSync(
        file,
        "const a = 1;\n// TODO: later\nconst b = 2;\n// const x = 1;\nconst c = 3;\n",
      );
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(0);
      const markers = lintResults(result)[0]?.markers.join("\n");
      expect(markers).toContain("untracked TODO @2");
      expect(markers).toContain("commented-out code @4");
    });
  });

  test("unclassified comment → advisory marker, exit 0, one count line", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.ts");
      writeFileSync(file, "// returns the value\nconst x = f();\n// @generated by the bundler\nconst y = f();\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(0);
      expect(lintViolationCodes(result)).toEqual([]);
      const markers = lintResults(result)[0]?.markers.join("\n");
      expect(markers).toContain("unclassified comment @1: // returns the value");
      expect(markers).not.toContain("@3");
      expect(result.stderr.trim().split("\n")).toEqual(["unclassified comments: 1"]);
    });
  });

  test("a documentation block above an export is not reported, one above a local is", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.ts");
      writeFileSync(file, "/** Public API doc. */\nexport const a = 1;\n/** Local doc. */\nconst b = 2;\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(0);
      const markers = lintResults(result)[0]?.markers.join("\n");
      expect(markers).toContain("unclassified comment @3: /** Local doc. */");
      expect(markers).not.toContain("@1");
      expect(result.stderr.trim()).toBe("unclassified comments: 1");
    });
  });

  test("--diff-base fails the comment on an added line and not the one above it", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.ts");
      commitBase(dir, { "scan.ts": "// returns the value\nconst a = 1;\n" });
      writeFileSync(file, "// returns the value\nconst a = 1;\n// returns it again\nconst b = 2;\n");
      const result = runCli(["lint", file, "--diff-base", "HEAD"], { cwd: dir });
      expect(result.exitCode).toBe(1);
      expect(lintViolationCodes(result)).toEqual(["lint.comment.unclassified"]);
      expect(lintResults(result)[0]?.markers.join("\n")).toBe("unclassified comment @3: // returns it again");
      expect(result.stderr.trim()).toBe("unclassified comments: 1");
    });
  });

  test("--diff-base reports nothing for a file the change does not touch", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      commitBase(dir, { "scan.ts": "// returns the value\nconst a = 1;\n" });
      const result = runCli(["lint", join(dir, "scan.ts"), "--diff-base", "HEAD"], { cwd: dir });
      expect(result.exitCode).toBe(0);
      expect(lintResults(result)[0]?.markers).toEqual([]);
      expect(result.stderr.trim()).toBe("unclassified comments: 0");
    });
  });

  test("--diff-base fails a block comment whose interior line moved, and not one it left alone", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.ts");
      const blocks = (second: string): string =>
        `/*\n * kept prose\n */\nconst a = 1;\n/*\n * ${second}\n */\nconst b = 2;\n`;
      commitBase(dir, { "scan.ts": blocks("second prose") });
      writeFileSync(file, blocks("second prose, edited"));
      const result = runCli(["lint", file, "--diff-base", "HEAD"], { cwd: dir });
      expect(result.exitCode).toBe(1);
      expect(lintViolationCodes(result)).toEqual(["lint.comment.unclassified"]);
      expect(lintResults(result)[0]?.markers).toEqual(["unclassified comment @5: /*"]);
      expect(result.stderr.trim()).toBe("unclassified comments: 1");
    });
  });

  test("--diff-base reads a changed line whose body starts with `++` as content, not a header", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.ts");
      commitBase(dir, { "scan.ts": "const a = 1;\nconst keep = 0;\n" });
      writeFileSync(file, "const a = 1;\nconst s = `\n++ ${a}\n`;\nconst keep = 0;\n// returns it again\n");
      const result = runCli(["lint", file, "--diff-base", "HEAD"], { cwd: dir });
      expect(result.exitCode).toBe(1);
      expect(lintResults(result)[0]?.markers).toEqual(["unclassified comment @6: // returns it again"]);
    });
  });

  test("--diff-base follows a path containing a space", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan one.ts");
      commitBase(dir, { "scan one.ts": "const a = 1;\n" });
      writeFileSync(file, "const a = 1;\n// returns it again\n");
      const result = runCli(["lint", file, "--diff-base", "HEAD"], { cwd: dir });
      expect(result.exitCode).toBe(1);
      expect(lintViolationCodes(result)).toEqual(["lint.comment.unclassified"]);
    });
  });

  // why: git C-quotes a path holding a quote, a backslash or a tab even with
  // core.quotePath=false, and a checkout may set diff.noprefix=true. Either
  // would leave the map keyed by a path the caller never asks for, so an
  // unclassified comment would pass the ratchet.
  test("--diff-base decodes a quoted path, so the ratchet still keys it", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const name = 'scan "quoted" one.ts';
      const file = join(dir, name);
      commitBase(dir, { [name]: "const a = 1;\n" });
      writeFileSync(file, "const a = 1;\n// returns it again\n");
      const result = runCli(["lint", file, "--diff-base", "HEAD"], { cwd: dir });
      expect(result.exitCode).toBe(1);
      expect(lintViolationCodes(result)).toEqual(["lint.comment.unclassified"]);
    });
  });

  test("--diff-base decodes a quoted path holding a backslash and a tab", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const names = ["back\\slash.ts", "tab\there.ts"];
      const files = Object.fromEntries(names.map((name) => [name, "const a = 1;\n"]));
      commitBase(dir, files);
      for (const name of names) writeFileSync(join(dir, name), "const a = 1;\n// returns it again\n");
      for (const name of names) {
        const result = runCli(["lint", join(dir, name), "--diff-base", "HEAD"], { cwd: dir });
        expect(result.exitCode).toBe(1);
        expect(lintViolationCodes(result)).toEqual(["lint.comment.unclassified"]);
      }
    });
  });

  test("--diff-base keys a quoted path under diff.noprefix=true", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const name = 'scan "quoted".ts';
      const file = join(dir, name);
      commitBase(dir, { [name]: "const a = 1;\n" });
      execFileSync("git", ["config", "diff.noprefix", "true"], { cwd: dir, stdio: "ignore" });
      writeFileSync(file, "const a = 1;\n// returns it again\n");
      const result = runCli(["lint", file, "--diff-base", "HEAD"], { cwd: dir });
      expect(result.exitCode).toBe(1);
      expect(lintViolationCodes(result)).toEqual(["lint.comment.unclassified"]);
    });
  });

  test("--diff-base still reports nothing for an untouched file under diff.noprefix=true", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      commitBase(dir, { "scan.ts": "// returns the value\nconst a = 1;\n" });
      execFileSync("git", ["config", "diff.noprefix", "true"], { cwd: dir, stdio: "ignore" });
      const result = runCli(["lint", join(dir, "scan.ts"), "--diff-base", "HEAD"], { cwd: dir });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.trim()).toBe("unclassified comments: 0");
    });
  });

  test("a Python floor division is not a comment, so the ratchet passes it", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.py");
      commitBase(dir, { "scan.py": "def f(n, d):\n    return n / d\n" });
      writeFileSync(file, "def f(n, d):\n    return n // d\n");
      const result = runCli(["lint", file, "--diff-base", "HEAD"], { cwd: dir });
      expect(result.exitCode).toBe(0);
      expect(lintViolationCodes(result)).toEqual([]);
      expect(result.stderr.trim()).toBe("unclassified comments: 0");
    });
  });

  test("a hash comment holding a URL classifies in a Python file", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.py");
      commitBase(dir, { "scan.py": "x = 1\n" });
      writeFileSync(file, "x = 1\n# https://example.com/wire-format\n");
      const result = runCli(["lint", file, "--diff-base", "HEAD"], { cwd: dir });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.trim()).toBe("unclassified comments: 0");
    });
  });

  test("a shebang on the first line is not a ratcheted comment", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "run.sh");
      commitBase(dir, { "run.sh": "set -e\n" });
      writeFileSync(file, "#!/usr/bin/env bash\nset -e\n");
      const result = runCli(["lint", file, "--diff-base", "HEAD"], { cwd: dir });
      expect(result.exitCode).toBe(0);
      expect(lintViolationCodes(result)).toEqual([]);
      expect(result.stderr.trim()).toBe("unclassified comments: 0");
    });
  });

  test("an unclassified hash comment still fails the ratchet in a shell file", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "run.sh");
      commitBase(dir, { "run.sh": "set -e\n" });
      writeFileSync(file, "set -e\n# prints the value\n");
      const result = runCli(["lint", file, "--diff-base", "HEAD"], { cwd: dir });
      expect(result.exitCode).toBe(1);
      expect(lintViolationCodes(result)).toEqual(["lint.comment.unclassified"]);
    });
  });

  test("--diff-base without a changed line stays out of the way of a clean file", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.ts");
      commitBase(dir, { "scan.ts": "// returns the value\nconst a = 1;\n" });
      writeFileSync(file, "// returns the value\nconst a = 2;\n");
      const result = runCli(["lint", file, "--diff-base", "HEAD"], { cwd: dir });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.trim()).toBe("unclassified comments: 0");
    });
  });

  test("--diff-base with an unresolvable ref is a usage refusal", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.ts");
      commitBase(dir, { "scan.ts": "// returns the value\nconst a = 1;\n" });
      const result = runCli(["lint", file, "--diff-base", "no-such-ref"], { cwd: dir });
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("no-such-ref");
    });
  });

  test("a standalone URL line is classified, exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.ts");
      writeFileSync(file, "// https://example.com/wire-format\nconst a = 1;\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr.trim()).toBe("unclassified comments: 0");
    });
  });

  test("an unbounded `shortcut:` marker → lint.simplify.no-upgrade-path, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.ts");
      writeFileSync(file, "// shortcut: one queue\nconst a = 1;\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(1);
      expect(lintViolationCodes(result)).toEqual(["lint.simplify.no-upgrade-path"]);
      expect(lintResults(result)[0]?.violations[0]?.message).toContain("shortcut marker at line 1");
    });
  });

  test("a bounded `shortcut:` marker → exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.ts");
      writeFileSync(file, "// shortcut: one queue; upgrade: split per route\nconst a = 1;\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(0);
      expect(lintResults(result)[0]?.markers.join("\n")).toContain("shortcut marker @1");
    });
  });

  test("dir walk aggregates violations → exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "20260808-bad-plan.md"), "# Plan\n\n## Goal\nShip TBD.\n");
      writeFileSync(join(dir, "20260808-good-plan.md"), "# Plan\n\n## Goal\nShip it.\n");
      const result = runCli(["lint", dir]);
      expect(result.exitCode).toBe(1);
      const results = lintResults(result);
      expect(results.find(({ file }) => file.endsWith("20260808-good-plan.md"))?.violations).toEqual([]);
      expect(results.find(({ file }) => file.endsWith("20260808-bad-plan.md"))?.violations.map(({ code }) => code)).toContain("lint.plan-quality.placeholder");
    });
  });

  test("dir walk with only clean files → exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "20260808-good-plan.md"), "# Plan\n\n## Goal\nShip it.\n");
      writeFileSync(join(dir, "STRATEGY.md"), "# S\n\n## Vision\n## What we build\n## What we don't build\n## Guiding Principles\n## Technology Direction\n## Decision Log\n");
      const result = runCli(["lint", dir]);
      expect(result.exitCode).toBe(0);
      expect(lintResults(result).every(({ violations }) => violations.length === 0)).toBe(true);
    });
  });

  test("dir with no lintable files → note, exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "notes.txt"), "plain prose\n");
      const result = runCli(["lint", dir]);
      expect(result.exitCode).toBe(0);
      expect(lintResults(result)).toEqual([]);
    });
  });

  test("missing <target> arg → usage, exit 2", () => {
    const result = runCli(["lint"]);
    expect(result.exitCode).toBe(2);
    expectUsageDiagnostic(result, "target");
  });

  test("existing unclassifiable file → usage, exit 2", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "README.txt");
      writeFileSync(file, "prose\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(2);
      expect(cliEnvelope(result, "usage", "usage").message).toContain("unsupported file type");
    });
  });

  test("nonexistent target → exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const result = runCli(["lint", join(dir, "nope.ts")]);
      expect(result.exitCode).toBe(1);
      expect(cliEnvelope(result, "refused").message).toContain("lint target not found");
    });
  });
});

// ---------------------------------------------------------------------------
// mstar lint --type provenance
// ---------------------------------------------------------------------------

describe("mstar lint --type provenance", () => {
  test("forced provenance scan flags dated plan id + harness path with lines, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "task-1-report.md");
      writeFileSync(
        file,
        [
          "## Evidence",
          "",
          "removal tracked in plan 20991231-sample-plan",
          "deeplink .mstar/plans/20991231-sample-plan/tasks.md",
          "",
        ].join("\n"),
      );
      const result = runCli(["lint", "--type", "provenance", file]);
      expect(result.exitCode).toBe(1);
      const violations = lintResults(result)[0]?.violations ?? [];
      expect(violations.map(({ code }) => code)).toEqual(expect.arrayContaining(["lint.provenance.plan-id", "lint.provenance.harness-path"]));
      expect(violations.map(({ message }) => message).join("\n")).toContain("line 3");
      expect(violations.map(({ message }) => message).join("\n")).toContain("line 4");
      expect(violations.map(({ message }) => message).join("\n")).toContain("20991231-sample-plan");
    });
  });

  test("forced provenance scan passes synthetic example and placeholder forms, exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "notes.md");
      writeFileSync(
        file,
        [
          "removal tracked in plan 20991231-example-plan",
          "placeholder shapes: task-N-plan, <plan-id>, {plan-id}",
          "version token 20260908-v3.9.0 stays out",
          "layout lines: .mstar/plans/, .mstar/status.json",
        ].join("\n"),
      );
      const result = runCli(["lint", "--type", "provenance", file]);
      expect(result.exitCode).toBe(0);
      expect(lintResults(result)[0]?.violations).toEqual([]);
    });
  });

  test("forced provenance dir walk applies to every collected file, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "20991231-real-plan.md"), "# Plan\n\n## Goal\nTracked in 20991231-sample-plan.\n");
      writeFileSync(join(dir, "20991231-clean-plan.md"), "# Plan\n\n## Goal\nPlaceholder <plan-id> only.\n");
      const result = runCli(["lint", "--type", "provenance", dir]);
      expect(result.exitCode).toBe(1);
      const results = lintResults(result);
      expect(results.find(({ file }) => file.endsWith("20991231-real-plan.md"))?.violations.map(({ code }) => code)).toContain("lint.provenance.plan-id");
      expect(results.find(({ file }) => file.endsWith("20991231-clean-plan.md"))?.violations).toEqual([]);
    });
  });

  test("forced provenance dir walk collects ordinary-named .md files (not the classifier face only)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      // README.md / notes.md are unclassifiable to the ordinary classifier
      // (previously dropped from dir walks entirely); .txt stays off the
      // calibrated .md/.ts face even with a real-shaped token.
      writeFileSync(join(dir, "README.md"), "removal tracked in plan 20991231-sample-plan\n");
      writeFileSync(join(dir, "notes.md"), "clean prose\n");
      writeFileSync(join(dir, "notes.txt"), "tracked in plan 20991231-sample-plan\n");
      const result = runCli(["lint", "--type", "provenance", dir]);
      expect(result.exitCode).toBe(1);
      const results = lintResults(result);
      expect(results.find(({ file }) => file.endsWith("README.md"))?.violations.map(({ code }) => code)).toContain("lint.provenance.plan-id");
      expect(results.find(({ file }) => file.endsWith("notes.md"))?.violations).toEqual([]);
      expect(results.some(({ file }) => file.endsWith("notes.txt"))).toBe(false);
    });
  });

  test("unknown --type value → usage listing includes provenance, exit 2", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "notes.md");
      writeFileSync(file, "prose\n");
      const result = runCli(["lint", "--type", "nope", file]);
      expect(result.exitCode).toBe(2);
      expect(cliEnvelope(result, "usage", "usage").message).toContain("provenance");
    });
  });

  test("--type provenance without a target → usage, exit 2", () => {
    const result = runCli(["lint", "--type", "provenance"]);
    expect(result.exitCode).toBe(2);
    expectUsageDiagnostic(result, "target");
  });
});
