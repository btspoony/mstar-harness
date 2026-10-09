/** Command-owned CLI subprocess coverage; fixture and assertion contracts are preserved. */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, withTempDir } from "./harness";
import { cliEnvelope, expectUsageDiagnostic, lintResults, lintViolationCodes } from "./support/cli-assertions";

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

  test("task report without TDD triple → lint.sdd-tdd.missing-*, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "task-1-report.md");
      writeFileSync(file, "Did the work. Output looked fine.\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(1);
      expect(lintViolationCodes(result)).toEqual(expect.arrayContaining(["lint.sdd-tdd.missing-tests", "lint.sdd-tdd.missing-command", "lint.sdd-tdd.missing-output"]));
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

  test("code file with simplify marker → advisory only, exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const file = join(dir, "scan.ts");
      writeFileSync(file, "// simplify: naive scan; upgrade: index the map\nconst y = 2;\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(0);
      expect(lintResults(result)[0]?.markers.join("\n")).toContain("simplify marker @1");
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
