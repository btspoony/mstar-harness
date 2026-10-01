/**
 * CLI Slice-4 subcommands — thin engine-backed wrappers:
 *   mstar lint <target>, mstar design-md validate <dir>,
 *   mstar audit scaffold <findings-file> [--dir <out-dir>], mstar audit promote
 *   <audit-dir> --plans <ids>, mstar audit secret-scan [path], mstar audit supply-chain [path],
 *   <doc-path> [--knowledge-dir <dir>], mstar host detect --signals <list>,
 *   mstar skill lint <skill-dir>, mstar roles validate [--roles-dir <dir>]
 *   [--skills-dir <dir>].
 *
 * Exit-code contract (slice-2/3 convention): 0 = OK, 1 = violations / file
 * errors, 2 = usage (missing/invalid args). Each case runs the real CLI as a
 * subprocess against /tmp fixtures and asserts exit code + reported codes.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  initializeStore,
  openStore,
  readJson,
  scaffoldAuditPlan,
  validateAuditStatusBlocks,
} from "@mstar-harness/engine";
import { CLI_ROOT, runCli, withTempDir } from "./harness";
import {
  cliEnvelope,
  lintResults,
  lintViolationCodes,
  violationCodes,
  type RunResult,
} from "./support/cli-assertions";
import {
  DESIGN_LEVEL1,
  KNOWLEDGE_GOOD,
  SKILL_EPHEMERAL,
  SKILL_GOOD,
  SKILL_PLACEHOLDERS,
} from "./support/cli-content-fixtures";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    expect(String(cliEnvelope(result, "usage").message)).toContain("missing required argument 'target'");
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
    expect(String(cliEnvelope(result, "usage").message)).toContain("missing required argument 'target'");
  });
});

// ---------------------------------------------------------------------------
// mstar design-md validate
// ---------------------------------------------------------------------------

describe("mstar design-md validate — tokens / parity / completeness", () => {
  test("valid Level 1 DESIGN.md → tokens OK, completeness MVP, exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "DESIGN.md"), DESIGN_LEVEL1);
      const result = runCli(["design-md", "validate", dir]);
      expect(result.exitCode).toBe(0);
      const envelope = cliEnvelope(result, "ok", "design-md.validate.ok");
      expect(envelope.data?.ok).toBe(true);
      expect(envelope.data?.completeness).toMatchObject({ level: "MVP" });
    });
  });

  test("invalid token value → design-md.tokens.color-format, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "DESIGN.md"), DESIGN_LEVEL1.replace('"#ffffff"', '"not-a-color"'));
      const result = runCli(["design-md", "validate", dir]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("design-md.tokens.color-format");
    });
  });

  test("light/dark key mismatch → design-md.parity.missing-dark, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "DESIGN.md"), DESIGN_LEVEL1);
      // Dark theme missing gray-900 (and background-100 value differs).
      writeFileSync(
        join(dir, "DESIGN.dark.md"),
        DESIGN_LEVEL1.replace('gray-1000: "#171717"', 'gray-1000: "#000000"').replace('  gray-900: "#666666"\n', ""),
      );
      const result = runCli(["design-md", "validate", dir]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("design-md.parity.missing-dark");
    });
  });

  test("no DESIGN.md in dir → exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const result = runCli(["design-md", "validate", dir]);
      expect(result.exitCode).toBe(1);
      expect(cliEnvelope(result, "refused").message).toContain("design file not found");
    });
  });

  test("missing <dir> arg → usage, exit 2", () => {
    const result = runCli(["design-md", "validate"]);
    expect(result.exitCode).toBe(2);
    expect(String(cliEnvelope(result, "usage").message)).toContain("missing required argument 'dir'");
  });
});

// ---------------------------------------------------------------------------
// mstar compound validate
// ---------------------------------------------------------------------------

describe("mstar compound validate — knowledge-doc schema / index / scope", () => {
  test("valid knowledge doc → schema OK, exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const doc = join(dir, "doc.md");
      writeFileSync(doc, KNOWLEDGE_GOOD);
      const result = runCli(["compound", "validate", doc]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "compound.validate.ok").data?.ok).toBe(true);
    });
  });

  test("doc missing required field → compound.schema.missing-field, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const doc = join(dir, "doc.md");
      writeFileSync(doc, "---\ndate: 2026-08-08\n---\n");
      const result = runCli(["compound", "validate", doc]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("compound.schema.missing-field");
    });
  });

  test("--knowledge-dir without README index → compound.index.retired, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const doc = join(dir, "doc.md");
      writeFileSync(doc, KNOWLEDGE_GOOD);
      const knowledgeDir = join(dir, "knowledge");
      mkdirSync(knowledgeDir);
      const result = runCli(["compound", "validate", doc, "--knowledge-dir", knowledgeDir]);
      expect(result.exitCode).toBe(1);
      // The README index is retired in authority (state-projection contract
      // §4, P4 adjudication): compound.index.missing-readme is superseded by
      // the actionable retired-reader refusal.
      expect(cliEnvelope(result, "refused", "compound.index.retired").message).toContain("no longer a register");
    });
  });

  test("doc outside --knowledge-dir → compound.scope.outside, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const doc = join(dir, "doc.md");
      writeFileSync(doc, KNOWLEDGE_GOOD);
      const knowledgeDir = join(dir, "knowledge");
      mkdirSync(knowledgeDir);
      writeFileSync(join(knowledgeDir, "README.md"), "# Knowledge\n\n| Document | Source Plan | Description | Status |\n|---|---|---|---|\n");
      const result = runCli(["compound", "validate", doc, "--knowledge-dir", knowledgeDir]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("compound.scope.outside");
    });
  });

  test("doc inside --knowledge-dir with index row → README register retired (exit 1, scope still guarded)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const knowledgeDir = join(dir, "knowledge");
      mkdirSync(knowledgeDir);
      const doc = join(knowledgeDir, "doc.md");
      writeFileSync(doc, KNOWLEDGE_GOOD);
      writeFileSync(join(knowledgeDir, "README.md"), "# Knowledge\n\n| Document | Source Plan | Description | Status |\n|---|---|---|---|\n| [doc](doc.md) | 20260808-x | x | done |\n");
      const result = runCli(["compound", "validate", doc, "--knowledge-dir", knowledgeDir]);
      // The retired README reader refuses even when the row exists. The
      // separate outside-scope case above keeps the scope guard covered.
      expect(result.exitCode).toBe(1);
      const envelope = cliEnvelope(result, "refused", "compound.index.retired");
      expect(envelope.details?.violations?.map(({ code }) => code) ?? [envelope.code]).toEqual(["compound.index.retired"]);
    });
  });

  test("missing <doc-path> arg → usage, exit 2", () => {
    const result = runCli(["compound", "validate"]);
    expect(result.exitCode).toBe(2);
    expect(cliEnvelope(result, "usage", "command.invalid-input").message).toContain("docPath");
  });

  test("nonexistent doc → exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const result = runCli(["compound", "validate", join(dir, "nope.md")]);
      expect(result.exitCode).toBe(1);
      expect(cliEnvelope(result, "refused").message).toContain("not found");
    });
  });
});

// ---------------------------------------------------------------------------
// mstar host detect
// ---------------------------------------------------------------------------

describe("mstar host detect — tool-shape host matrix", () => {
  const cases: { signals: string; host: string }[] = [
    { signals: "subagent_type", host: "cursor" },
    { signals: "question", host: "opencode" },
    { signals: "task_subagent", host: "opencode" },
    { signals: "task_agent_batch,ask,hub", host: "omp" },
    { signals: "Agent,AgentSwarm", host: "kimi" },
    { signals: "Agent,EnterPlanMode,TodoWrite", host: "zcode" },
    { signals: "plan_slash,goal", host: "codex" },
  ];
  for (const { signals, host } of cases) {
    test(`${signals} → ${host}, exit 0`, () => {
      const result = runCli(["host", "detect", "--signals", signals]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result).data?.host).toBe(host);
    });
  }

  test("unknown signal token → usage, exit 2", () => {
    const result = runCli(["host", "detect", "--signals", "question,nope"]);
    expect(result.exitCode).toBe(2);
    expect(cliEnvelope(result).message).toBe('unknown signal "nope"');
  });

  test("empty --signals → usage, exit 2", () => {
    const result = runCli(["host", "detect", "--signals", ""]);
    expect(result.exitCode).toBe(2);
    expect(cliEnvelope(result).message).toBe("Too small: expected string to have >=1 characters");
  });

  test("missing --signals → usage, exit 2", () => {
    const result = runCli(["host", "detect"]);
    expect(result.exitCode).toBe(2);
    expect(cliEnvelope(result).message).toBe("error: required option '--signals <list>' not specified");
  });
});

// ---------------------------------------------------------------------------
// mstar skill lint
// ---------------------------------------------------------------------------

describe("mstar skill lint — frontmatter + five-question body + ephemeral citations", () => {
  test("well-formed skill → all checks OK, exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      mkdirSync(join(dir, "skill"));
      writeFileSync(join(dir, "skill", "SKILL.md"), SKILL_GOOD);
      const result = runCli(["skill", "lint", join(dir, "skill")]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "skill.lint.ok").data?.ok).toBe(true);
    });
  });

  test("body missing five-question sections → skill-authoring.five-question.*, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      mkdirSync(join(dir, "skill"));
      writeFileSync(
        join(dir, "skill", "SKILL.md"),
        "---\nname: sample-skill\ndescription: Validates harness fixtures during CLI smoke tests.\n---\n\n## Intro\n\nNo sections here.\n",
      );
      const result = runCli(["skill", "lint", join(dir, "skill")]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toEqual(expect.arrayContaining(["skill-authoring.five-question.load-order", "skill-authoring.five-question.evidence"]));
    });
  });

  test("bad frontmatter → lint.frontmatter.name.format, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      mkdirSync(join(dir, "skill"));
      writeFileSync(join(dir, "skill", "SKILL.md"), "---\nname: Bad-Name\n---\n\n## Load Order\n## Workflow\n## Decision Rules\n## Evidence\n## References\n");
      const result = runCli(["skill", "lint", join(dir, "skill")]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("lint.frontmatter.name.format");
    });
  });

  test("missing SKILL.md → exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      mkdirSync(join(dir, "skill"));
      const result = runCli(["skill", "lint", join(dir, "skill")]);
      expect(result.exitCode).toBe(1);
      expect(cliEnvelope(result, "refused").message).toContain("SKILL.md");
    });
  });

  test("missing <skill-dir> arg → usage, exit 2", () => {
    const result = runCli(["skill", "lint"]);
    expect(result.exitCode).toBe(2);
    expect(cliEnvelope(result, "usage", "command.invalid-input").message).toContain("skillDir");
  });

  test("concrete task-artifact citation → skill.ephemeral.task-artifact, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      mkdirSync(join(dir, "skill"));
      writeFileSync(join(dir, "skill", "SKILL.md"), SKILL_EPHEMERAL);
      const result = runCli(["skill", "lint", join(dir, "skill")]);
      expect(result.exitCode).toBe(1);
      const envelope = cliEnvelope(result, "refused");
      expect(violationCodes(result)).toContain("skill.ephemeral.task-artifact");
      expect(JSON.stringify(envelope)).toContain("task-3-report");
    });
  });

  test("concrete sdd deeplink → skill.ephemeral.sdd-deeplink, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      mkdirSync(join(dir, "skill"));
      writeFileSync(join(dir, "skill", "SKILL.md"), SKILL_EPHEMERAL);
      const result = runCli(["skill", "lint", join(dir, "skill")]);
      expect(result.exitCode).toBe(1);
      const envelope = cliEnvelope(result, "refused");
      expect(violationCodes(result)).toContain("skill.ephemeral.sdd-deeplink");
      expect(JSON.stringify(envelope)).toContain(".mstar/sdd/20260815-x");
    });
  });

  test("placeholder citation forms → ephemeral checklist OK, exit 0 (discrimination contract)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      mkdirSync(join(dir, "skill"));
      writeFileSync(join(dir, "skill", "SKILL.md"), SKILL_PLACEHOLDERS);
      const result = runCli(["skill", "lint", join(dir, "skill")]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "skill.lint.ok").data?.ok).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// project-root path resolution (audit-002: resolveCliPath adoption)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// mstar roles validate — mapping / load-order checks (audit-003)
// ---------------------------------------------------------------------------

describe("mstar roles validate — mapping / load-order checks (audit-003)", () => {
  /** Real mstar-roles skill dir of this checkout — a passing fixture by
   * definition of the drift-lint guard (Task 2 enforces the same corpus). */
  const REPO_ROLES_DIR = join(resolve(CLI_ROOT, "..", ".."), "skills", "mstar-roles");

  /** mstar-* sibling with no Load Order section (violates
   * roles.loadorder.section.missing). */
  const SIBLING_NO_LOAD_ORDER = `# mstar-foo

A topic skill body without a Load Order heading.
`;

  test("default flags validate the shipped corpus (exit 0, OK + counts)", () => {
    // cwd = packages/cli: resolveCliProjectRoot walks up to the monorepo root,
    // so --roles-dir defaults to <root>/skills/mstar-roles and --skills-dir to
    // <root>/skills — the real corpus must pass (same guarantee Task 2 guards).
    const result = runCli(["roles", "validate"], { cwd: resolve(CLI_ROOT, "..", "..") });
    expect(result.exitCode).toBe(0);
    const envelope = cliEnvelope(result, "ok", "roles.validate.ok");
    expect(envelope.data).toMatchObject({ ok: true, violations: [], siblingCount: expect.any(Number), loadOrderChecked: expect.any(Number) });
  });

  test("--roles-dir / --skills-dir overrides; load-order violation exits 1 with one row each", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const skillsRoot = join(dir, "skills");
      mkdirSync(join(skillsRoot, "mstar-foo"), { recursive: true });
      writeFileSync(join(skillsRoot, "mstar-foo", "SKILL.md"), SIBLING_NO_LOAD_ORDER);
      const result = runCli(["roles", "validate", "--roles-dir", REPO_ROLES_DIR, "--skills-dir", skillsRoot]);
      expect(result.exitCode).toBe(1);
      // Mapping still passes on the real roles dir — the failure is isolated to
      // the load-order lint so the row contract is asserted exactly.
      const envelope = cliEnvelope(result, "refused", "roles.loadorder.section.missing");
      expect(envelope.message).toContain('skill "mstar-foo"');
    });
  });

  test("empty roles dir — mapping violations, one row each (exit 1)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const result = runCli(["roles", "validate", "--roles-dir", dir, "--skills-dir", dir]);
      expect(result.exitCode).toBe(1);
      const violations = cliEnvelope(result, "refused").details?.violations ?? [];
      const missingReferences = violations.filter(({ code }) => code === "roles.mapping.reference.missing");
      expect(missingReferences.length).toBeGreaterThan(0);
    });
  });

  test("unreadable sibling SKILL.md is skipped best-effort (exit 0)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const skillsRoot = join(dir, "skills");
      // A directory named SKILL.md makes readFileSync throw (EISDIR)
      // deterministically — exercises the best-effort skip without
      // root-dependent chmod semantics.
      mkdirSync(join(skillsRoot, "mstar-foo", "SKILL.md"), { recursive: true });
      const result = runCli(["roles", "validate", "--roles-dir", REPO_ROLES_DIR, "--skills-dir", skillsRoot]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "roles.validate.ok").data).toMatchObject({ siblingCount: 0, loadOrderChecked: 0 });
    });
  });

  test("relative --roles-dir resolves against MSTAR_CLI_PROJECT_ROOT", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      // Copy the real roles dir into the fixture project root so the mapping
      // passes; the sibling scan then covers the copied mstar-roles SKILL.md.
      cpSync(REPO_ROLES_DIR, join(dir, "skills", "mstar-roles"), { recursive: true });
      const nested = join(dir, "nested", "deep");
      mkdirSync(nested, { recursive: true });
      const result = runCli(["roles", "validate", "--roles-dir", "skills/mstar-roles", "--skills-dir", join(dir, "skills")], {
        cwd: nested,
        env: { MSTAR_CLI_PROJECT_ROOT: dir },
      });
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "roles.validate.ok").data).toMatchObject({ siblingCount: 1, loadOrderChecked: 1 });
    });
  });
});

// ---------------------------------------------------------------------------
// mstar status validate — v2 root + workflow snapshot (audit-004 cutover)
// ---------------------------------------------------------------------------

/** Valid v2 root status.json (structure-only: no active workflows listed). */
const STATUS_V2_ROOT_OK = `{
  "version": 2,
  "updated_at": "2026-08-08",
  "workflows": []
}`;

/** v2 root listing a workflow whose snapshot is missing → fail-closed. */
const STATUS_V2_ROOT_MISSING_SNAPSHOT = `{
  "version": 2,
  "updated_at": "2026-08-08",
  "workflows": [{ "id": "wf-1", "type": "plan", "started_at": "2026-08-08", "dir": "workflows/wf-1" }]
}`;

/** v1-shaped root — hard cutover rejects it with the migrate hint. */
const STATUS_V1_ROOT = `{
  "version": 1,
  "updated_at": "2026-08-08",
  "plans": [],
  "residual_findings": {},
  "metadata": {}
}`;

/** Valid workflow snapshot (single plan row, no leases). */
function snapshotDoc(planRows: unknown[]): string {
  return JSON.stringify(
    {
      schema_version: 1,
      id: "wf-1",
      type: "plan",
      status: "running",
      started_at: "2026-08-08",
      updated_at: "2026-08-08",
      plans: planRows,
    },
    null,
    2,
  );
}

describe("mstar status validate — v2 root + workflow snapshot (hard cutover)", () => {
  test("valid v2 root → OK, exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "status.json"), STATUS_V2_ROOT_OK);
      const result = runCli(["status", "validate", join(dir, "status.json")]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "status.ok").data?.path).toBe(join(dir, "status.json"));
      expect(result.stderr).toBe("");
    });
  });

  test("v2 root listing a workflow whose snapshot is missing → snapshot-missing, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "status.json"), STATUS_V2_ROOT_MISSING_SNAPSHOT);
      const result = runCli(["status", "validate", join(dir, "status.json")]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("status.workflow.snapshot-missing");
    });
  });

  test("v1 root fails closed with the migrate hint, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "status.json"), STATUS_V1_ROOT);
      const result = runCli(["status", "validate", join(dir, "status.json")]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("status.migration-required");
    });
  });

  test("workflow snapshot path validates with the snapshot validator, exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const workflowDir = join(dir, "workflows", "wf-1");
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(join(workflowDir, "snapshot.json"), snapshotDoc([]));
      const result = runCli(["status", "validate", join(workflowDir, "snapshot.json")]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "status.ok").data?.path).toBe(join(workflowDir, "snapshot.json"));
    });
  });

  test("invalid snapshot (bad lifecycle type) → workflow.snapshot.invalid-type, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const workflowDir = join(dir, "workflows", "wf-1");
      mkdirSync(workflowDir, { recursive: true });
      const doc = JSON.parse(snapshotDoc([])) as Record<string, unknown>;
      doc.type = "sprint";
      writeFileSync(join(workflowDir, "snapshot.json"), JSON.stringify(doc, null, 2));
      const result = runCli(["status", "validate", join(workflowDir, "snapshot.json")]);
      expect(result.exitCode).toBe(1);
      expect(cliEnvelope(result, "refused", "workflow.snapshot.invalid-type").message).toContain("invalid-type");
    });
  });

  test("missing status file fails with exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const result = runCli(["status", "validate", join(dir, "nope.json")]);
      expect(result.exitCode).toBe(1);
      expect(cliEnvelope(result, "refused", "status.file-not-found").message).toContain("status file not found");
    });
  });
});

// ---------------------------------------------------------------------------
// mstar status tech-debt / findings-cleanup — issue-store authority (G2b)
// ---------------------------------------------------------------------------

/** A CaptureInput payload for the unscoped `mstar issue add` entry. */
function captureInputOf(occurrenceKey: string, severity: string): Record<string, unknown> {
  return {
    projectId: "_default",
    title: `Finding ${occurrenceKey}`,
    kind: "bug",
    severity,
    impact: "an acceptance is not met",
    acceptance: "the finding is fixed and verified",
    sourceIdentity: `slice4/${occurrenceKey}`,
    rootCauseKey: "slice4-root-cause",
    acceptanceKey: "slice4-acceptance",
    occurrenceKey,
    sourceKind: "qc",
    location: "packages/cli/src/index.ts",
    observedBehavior: "observed by the slice-4 fixture",
    evidence: ["fixture evidence"],
    discoveredAt: "2026-09-18T00:00:00Z",
  };
}

/**
 * An ACTIVE issue store under `dir` holding one unscoped OPEN issue; returns
 * the DB-assigned issue id. `store init` is create-only for a genuinely empty
 * workspace, so it runs before any register-shaped file exists.
 */
function seedIssueStore(dir: string, severity = "high"): string {
  const init = runCli(["store", "init", "--harness", dir]);
  expect(init.exitCode).toBe(0);
  const payloadPath = join(dir, "capture.json");
  writeFileSync(payloadPath, JSON.stringify(captureInputOf("occ-1", severity)), "utf8");
  const added = runCli([
    "issue", "add", "--harness", dir, "--operation-id", "slice4-capture-1", "--actor", "project-manager",
    "--file", payloadPath,
  ]);
  expect(added.exitCode).toBe(0);
  const envelope = JSON.parse(added.stdout) as { data?: { issueId?: unknown } };
  const issueId = envelope.data?.issueId;
  if (typeof issueId !== "string") throw new Error(`issue add returned no id: ${added.stdout}`);
  return issueId;
}

describe("mstar status tech-debt — open-issue rollup over the issue store", () => {
  test("rolls up the store's OPEN issues by severity and project, exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      seedIssueStore(dir);
      const result = runCli(["status", "tech-debt", "--harness", dir]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "status.ok").data).toMatchObject({
        total_open: 1,
        by_severity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
        by_project: { _default: 1 },
      });
    });
  });

  test("a missing store refuses instead of printing an empty rollup (exit 1)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const result = runCli(["status", "tech-debt", "--harness", dir]);
      expect(result.exitCode).toBe(1);
      expect(cliEnvelope(result, "refused", "store.not-initialized").data).toBeUndefined();
    });
  });

  test("a staged store is not the authority: the rollup refuses (exit 1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mstar-slice4-staged-"));
    try {
      const handle = await initializeStore({ harnessDir: dir });
      handle.close();
      const write = await openStore({ harnessDir: dir }, "write");
      write.db.prepare("update store_meta set authority_state = 'staged' where id = 1").run();
      write.close();
      // A read in THIS process first: a child's first read of a store the
      // runner just wrote intermittently fails to open (task-3 report §obs).
      const seal = await openStore({ harnessDir: dir }, "read");
      seal.close();

      const result = runCli(["status", "tech-debt", "--harness", dir]);
      expect(result.exitCode).toBe(1);
      expect(cliEnvelope(result, "refused", "store.not-active").data).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mstar status findings-cleanup — issue-linkage gate over the issue store", () => {
  test("an OPEN issue that is not linked to the plan does not block it (exit 0)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      seedIssueStore(dir, "critical");
      const result = runCli(["status", "findings-cleanup", "p1", "--harness", dir, "--mode", "zero-residual"]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "status.ok").data).toMatchObject({ planId: "p1", violations: [] });
    });
  });
  test("a missing store fails closed instead of passing as no findings (exit 1)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const result = runCli(["status", "findings-cleanup", "p1", "--harness", dir]);
      expect(result.exitCode).toBe(1);
      expect(cliEnvelope(result, "refused", "store.not-initialized").data).toBeUndefined();
    });
  });
  test("invalid --mode is a usage error before store access (exit 2)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const result = runCli(["status", "findings-cleanup", "p1", "--harness", dir, "--mode", "bogus"]);
      expect(result.exitCode).toBe(2);
      expect(cliEnvelope(result, "usage", "command.invalid-input").message).toContain("zero-residual");
    });
  });
});

// ---------------------------------------------------------------------------
// mstar status backlog-register / backlog-close — removed in G2b
// ---------------------------------------------------------------------------

describe("mstar status backlog-register / backlog-close — retired verbs name the replacement", () => {
  for (const [verb, replacement] of [
    ["backlog-register", "plan issue-add"],
    ["backlog-close", "plan issue-close"],
  ] as const) {
    test(`${verb}: refuses with the migration path and writes no register (exit 1)`, () => {
      withTempDir("mstar-slice4-cli-", (dir) => {
        const result = runCli(["status", verb], { cwd: dir });
        expect(cliEnvelope(result, "refused", "status.verb-retired").message).toContain(`mstar ${replacement}`);
        expect(existsSync(join(dir, "projects"))).toBe(false);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// mstar status archive-residuals — removed (audit-004 cutover, re-pointed G2b)
// ---------------------------------------------------------------------------

describe("mstar status archive-residuals — removed command names the replacement", () => {
  test("invocation errors and names the issue-store replacement (exit 1)", () => {
    const result = runCli(["status", "archive-residuals"]);
    expect(cliEnvelope(result, "refused", "status.verb-retired").message).toContain("mstar plan issue-close");
  });
});

// ---------------------------------------------------------------------------
// mstar lease verify-integration — snapshot top-level merge lease (audit-004)
// ---------------------------------------------------------------------------

const LEASE_VALID = {
  holder: "Main",
  claimed_at: "2026-08-16",
  plan_id: "20260816-audit-004",
  source_branch: "feature/20260816-audit-004-validator-cli",
  target_branch: "spec_integration_branch",
};

const LEASE_MISSING_HOLDER = { ...LEASE_VALID } as Record<string, unknown>;
delete LEASE_MISSING_HOLDER.holder;

/** Snapshot with a top-level integration_merge_lease (or none). */
function leaseSnapshot(lease: unknown): string {
  return JSON.stringify(
    {
      schema_version: 1,
      id: "wf-1",
      type: "iteration",
      status: "running",
      started_at: "2026-08-08",
      updated_at: "2026-08-16",
      plans: [],
      ...(lease === undefined ? {} : { integration_merge_lease: lease }),
    },
    null,
    2,
  );
}

function withMergeLeaseSnapshot(lease: unknown, fn: (dir: string) => void): void {
  withTempDir("mstar-slice4-cli-", (dir) => {
    const workflowDir = join(dir, "workflows", "wf-1");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(workflowDir, "snapshot.json"), leaseSnapshot(lease));
    fn(dir);
  });
}

describe("mstar lease verify-integration — snapshot top-level integration_merge_lease (audit-004)", () => {
  test("valid lease prints holder and passes (exit 0)", () => {
    withMergeLeaseSnapshot(LEASE_VALID, (dir) => {
      const result = runCli(["lease", "verify-integration", "--workflow", "wf-1", "--harness", dir]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "lease.verify-integration.ok").data?.lease).toMatchObject({ holder: "Main" });
    });
  });

  test("absent lease is the valid unclaimed state (exit 0)", () => {
    withMergeLeaseSnapshot(undefined, (dir) => {
      const result = runCli(["lease", "verify-integration", "--workflow", "wf-1", "--harness", dir]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "lease.verify-integration.ok").data?.claimed).toBe(false);
    });
  });

  test("null lease is a tombstone and fails with the engine code (exit 1)", () => {
    withMergeLeaseSnapshot(null, (dir) => {
      const result = runCli(["lease", "verify-integration", "--workflow", "wf-1", "--harness", dir]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("lease.merge-lease.invalid");
    });
  });

  test("lease missing a required field fails with the engine code (exit 1)", () => {
    withMergeLeaseSnapshot(LEASE_MISSING_HOLDER, (dir) => {
      const result = runCli(["lease", "verify-integration", "--workflow", "wf-1", "--harness", dir]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("lease.merge-lease.missing-holder");
    });
  });

  test("missing --workflow is a usage error (exit 2)", () => {
    const result = runCli(["lease", "verify-integration"]);
    expect(result.exitCode).toBe(2);
    expect(String(cliEnvelope(result, "usage").message)).toContain("required option '--workflow <id>' not specified");
  });
});

// ---------------------------------------------------------------------------
// mstar worktree qc-alignment — byte-identical alignment fields (audit-004)
// ---------------------------------------------------------------------------

/** One QC Assignment fixture with the three alignment fields — canonical
 * combined `Review range / Diff basis` label form (the PM template shape,
 * real QC/QA packs use it). */
function qcAssignmentFixture(planId: string, range: string): string {
  return `## Assignment
**Execute as**: qc-specialist
**Task category**: logic
**plan_id**: ${planId}
**Review range / Diff basis**: ${range}
`;
}

/** Separate-label Assignment fixture (non-canonical form, still accepted). */
function qcAssignmentSeparateFixture(planId: string, range: string): string {
  return `## Assignment
**Execute as**: qc-specialist
**Task category**: logic
**plan_id**: ${planId}
**Review range**: ${range}
**Diff basis**: ${range}
`;
}

describe("mstar worktree qc-alignment — QC/QA alignment fields (audit-004)", () => {
  test("real-shape tri pack: 3 assignments, canonical combined label, byte-identical (exit 0)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      for (const name of ["qc1.md", "qc2.md", "qc3.md"]) {
        writeFileSync(join(dir, name), qcAssignmentFixture("20260816-audit-004", "merge-base: main + tip: HEAD"));
      }
      const result = runCli(["worktree", "qc-alignment", join(dir, "qc1.md"), join(dir, "qc2.md"), join(dir, "qc3.md")]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "worktree.qc-alignment.ok").data?.assignments).toHaveLength(3);
    });
  });

  test("separate-label form still parses as aligned (exit 0)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "qc1.md"), qcAssignmentSeparateFixture("20260816-audit-004", "merge-base: main + tip: HEAD"));
      writeFileSync(join(dir, "qc2.md"), qcAssignmentSeparateFixture("20260816-audit-004", "merge-base: main + tip: HEAD"));
      const result = runCli(["worktree", "qc-alignment", join(dir, "qc1.md"), join(dir, "qc2.md")]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "worktree.qc-alignment.ok").data?.assignments).toHaveLength(2);
    });
  });

  test("a differing Diff basis fails with qc.alignment.mismatch (exit 1)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "qc1.md"), qcAssignmentFixture("20260816-audit-004", "merge-base: main + tip: HEAD"));
      writeFileSync(join(dir, "qc2.md"), qcAssignmentFixture("20260816-audit-004", "merge-base: main + tip: HEAD~1"));
      const result = runCli(["worktree", "qc-alignment", join(dir, "qc1.md"), join(dir, "qc2.md")]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toEqual(["qc.alignment.mismatch", "qc.alignment.mismatch"]);
    });
  });
  test("assignment missing an alignment field fails with qc.alignment.field.missing (exit 1)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      // Separate-label variant with the Diff basis line removed (the combined
      // form cannot drop a single range field).
      const incomplete = qcAssignmentSeparateFixture("20260816-audit-004", "merge-base: main + tip: HEAD").replace(
        "**Diff basis**: merge-base: main + tip: HEAD\n",
        "",
      );
      writeFileSync(join(dir, "qc1.md"), incomplete);
      const result = runCli(["worktree", "qc-alignment", join(dir, "qc1.md")]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toEqual(["qc.alignment.field.missing"]);
    });
  });

  test("no assignment files is a usage error (exit 2)", () => {
    const result = runCli(["worktree", "qc-alignment"]);
    expect(result.exitCode).toBe(2);
    expect(String(cliEnvelope(result, "usage").message)).toContain("missing required argument 'files'");
  });
});

// ---------------------------------------------------------------------------
// mstar host skill-root — per-host resolution matrix (audit-004)
// ---------------------------------------------------------------------------

describe("mstar host skill-root — loaded skill-root resolution (audit-004)", () => {
  test("opencode resolves to the package-internal harness-skills mount (exit 0)", () => {
    const result = runCli(["host", "skill-root", "--host", "opencode", "--skill", "mstar-roles"]);
    expect(result.exitCode).toBe(0);
    expect(cliEnvelope(result, "ok", "host.skill-root.ok").data?.root).toBe("harness-skills/mstar-roles");
  });

  test("cursor resolves with a skill-relative path suffix (exit 0)", () => {
    const result = runCli([
      "host",
      "skill-root",
      "--host",
      "cursor",
      "--skill",
      "mstar-roles",
      "--rel",
      "references/opencode.md",
    ]);
    expect(result.exitCode).toBe(0);
    expect(cliEnvelope(result, "ok", "host.skill-root.ok").data?.root).toContain("references/opencode.md");
  });

  test("omp resolves to the skill:// URI form (exit 0)", () => {
    const result = runCli(["host", "skill-root", "--host", "omp", "--skill", "mstar-roles"]);
    expect(result.exitCode).toBe(0);
    expect(cliEnvelope(result, "ok", "host.skill-root.ok").data?.root).toBe("skill://mstar-roles");
  });

  test("pi prints the deferred-resolution notice shape (exit 0)", () => {
    const result = runCli(["host", "skill-root", "--host", "pi", "--skill", "mstar-roles"]);
    expect(result.exitCode).toBe(0);
    expect(cliEnvelope(result, "ok", "host.skill-root.ok").data?.root).toContain("deferred: pi has no plugin API in v1");
  });

  test("dsh resolves to the bundled skill dir form (exit 0)", () => {
    const result = runCli(["host", "skill-root", "--host", "dsh", "--skill", "mstar-roles"]);
    expect(result.exitCode).toBe(0);
    expect(cliEnvelope(result, "ok", "host.skill-root.ok").data?.root).toBe("$DSH_BUNDLED_SKILL_DIR/mstar-roles");
  });

  test("empty --skill value is a usage error (exit 2)", () => {
    const result = runCli(["host", "skill-root", "--host", "opencode", "--skill="]);
    expect(result.exitCode).toBe(2);
    expect(cliEnvelope(result, "usage", "command.invalid-input").message).toContain("characters");
  });

  test("unknown host is a usage error (exit 2)", () => {
    const result = runCli(["host", "skill-root", "--host", "bogus", "--skill", "mstar-roles"]);
    expect(result.exitCode).toBe(2);
    expect(cliEnvelope(result, "usage", "command.invalid-input").message).toContain('unknown host "bogus"');
  });
});
