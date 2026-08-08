/**
 * CLI Slice-4 subcommands — thin engine-backed wrappers:
 *   mstar lint <target>, mstar design-md validate <dir>,
 *   mstar audit scaffold <findings-file> [--dir <out-dir>], mstar compound validate
 *   <doc-path> [--knowledge-dir <dir>], mstar host detect --signals <list>,
 *   mstar skill lint <skill-dir>.
 *
 * Exit-code contract (slice-2/3 convention): 0 = OK, 1 = violations / file
 * errors, 2 = usage (missing/invalid args). Each case runs the real CLI as a
 * subprocess against /tmp fixtures and asserts exit code + reported codes.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateAuditStatusBlocks } from "@mstar-harness/engine";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");

/** Spawn env with ambient harness env vars pinned out (same as the other
 * CLI suites — engine dir resolution must not leak into fixtures). */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR" || key === "MSTAR_WORKING_BRANCH") {
      continue;
    }
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Run the real CLI entry as a subprocess; cwd + env overrides per test. */
function runCli(args: string[], cwd: string = CLI_ROOT): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd,
    env: cliEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** Temp dir per test, cleaned up after. */
function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "mstar-slice4-cli-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Full Level 1 design frontmatter (same shape as the engine's FM_LEVEL1
 * fixture — audits as MVP; tokens pass). */
const DESIGN_LEVEL1 = `---
version: 0.1.0
name: "Acme Design"
description: "Acme Design is a minimal, high-contrast design system. This is the Light theme."
colors:
  background-100: "#ffffff"
  gray-1000: "#171717"
  gray-900: "#666666"
  blue-700: "#0066ff"
  red-700: "#e60000"
  amber-700: "#ffaa00"
typography:
  copy-16:
    fontFamily: Geist Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
  heading-32:
    fontFamily: Geist Sans
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.02em
spacing:
  base: 4px
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  6: 24px
rounded:
  sm: 6px
---
`;

/** Valid skill fixture: lowercase-hyphen name, third-person trigger
 * description, all five body questions answered. */
const SKILL_GOOD = `---
name: sample-skill
description: Validates harness fixtures during CLI smoke tests.
---

## Load Order

Read this skill when running smoke fixtures.

## Workflow

Create fixtures, run the CLI, assert exit codes.

## Decision Rules

Never mutate the control worktree.

## Evidence

A green CLI run is the success criterion.

## References

Open the engine tests when a fixture drifts.
`;

/** Knowledge-track doc that passes validateSchemaYaml. */
const KNOWLEDGE_GOOD = `---
module: engine
date: 2026-08-01
problem_type: best_practice
category: best-practices
severity: medium
---
`;

// ---------------------------------------------------------------------------
// mstar lint
// ---------------------------------------------------------------------------

describe("mstar lint — content-type lints", () => {
  test("plan file with placeholder → lint.plan-quality.placeholder, exit 1", () => {
    withTempDir((dir) => {
      const file = join(dir, "20260808-bad-plan.md");
      writeFileSync(file, "# Plan\n\n## Goal\nShip TBD module.\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("lint.plan-quality.placeholder");
      expect(result.stderr).toContain("FAIL");
    });
  });

  test("clean plan file → OK, exit 0", () => {
    withTempDir((dir) => {
      const file = join(dir, "20260808-good-plan.md");
      writeFileSync(file, "# Plan\n\n## Goal\nShip the module.\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("OK");
      expect(result.stderr).toBe("");
    });
  });

  test("STRATEGY.md missing sections → lint.strategy.missing-section, exit 1", () => {
    withTempDir((dir) => {
      const file = join(dir, "STRATEGY.md");
      writeFileSync(file, "# Strategy\n\nNo sections here.\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("lint.strategy.missing-section");
      expect(result.stderr).toContain('"Vision"');
    });
  });

  test("STRATEGY.md with all required sections → exit 0", () => {
    withTempDir((dir) => {
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
      expect(result.stdout).toContain("OK");
    });
  });

  test("SKILL.md bad frontmatter → lint.frontmatter.*, exit 1", () => {
    withTempDir((dir) => {
      const file = join(dir, "SKILL.md");
      writeFileSync(file, "---\nname: My-Skill\n---\n\n# Body\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("lint.frontmatter.name.format");
      expect(result.stderr).toContain("lint.frontmatter.description.missing");
    });
  });

  test("SKILL.md clean frontmatter → exit 0", () => {
    withTempDir((dir) => {
      const file = join(dir, "SKILL.md");
      writeFileSync(
        file,
        "---\nname: sample-skill\ndescription: Validates harness fixtures during CLI smoke tests.\n---\n\n# Body\n",
      );
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("OK");
    });
  });

  test("task report without TDD triple → lint.sdd-tdd.missing-*, exit 1", () => {
    withTempDir((dir) => {
      const file = join(dir, "task-1-report.md");
      writeFileSync(file, "Did the work. Output looked fine.\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("lint.sdd-tdd.missing-tests");
      expect(result.stderr).toContain("lint.sdd-tdd.missing-command");
      expect(result.stderr).toContain("lint.sdd-tdd.missing-output");
    });
  });

  test("task report with full TDD triple → exit 0", () => {
    withTempDir((dir) => {
      const file = join(dir, "task-1-report.md");
      writeFileSync(
        file,
        "## Evidence\n\nCovering test file(s): test/foo.test.ts\nCommand run: bun test test/foo.test.ts\n12 pass / 0 fail\n",
      );
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("OK");
    });
  });

  test("code file with temporary marker lacking removal path → lint.temporary.no-removal-path, exit 1", () => {
    withTempDir((dir) => {
      const file = join(dir, "hack.ts");
      writeFileSync(file, "// temporary: hack\nconst x = 1;\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("lint.temporary.no-removal-path");
      expect(result.stdout).toContain("temporary marker @1");
    });
  });

  test("code file with temporary marker + removal path → exit 0, marker printed", () => {
    withTempDir((dir) => {
      const file = join(dir, "hack.ts");
      writeFileSync(file, "// temporary: shim — removal tracked in status.json\nconst x = 1;\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("temporary marker @1");
      expect(result.stdout).toContain("removal: status.json");
      expect(result.stderr).toBe("");
    });
  });

  test("code file with simplify marker → advisory only, exit 0", () => {
    withTempDir((dir) => {
      const file = join(dir, "scan.ts");
      writeFileSync(file, "// simplify: naive scan; upgrade: index the map\nconst y = 2;\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("simplify marker @1");
      expect(result.stderr).toBe("");
    });
  });

  test("dir walk aggregates violations → exit 1", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "20260808-bad-plan.md"), "# Plan\n\n## Goal\nShip TBD.\n");
      writeFileSync(join(dir, "20260808-good-plan.md"), "# Plan\n\n## Goal\nShip it.\n");
      const result = runCli(["lint", dir]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("20260808-good-plan.md: OK");
      expect(result.stderr).toContain("20260808-bad-plan.md: FAIL");
    });
  });

  test("dir walk with only clean files → exit 0", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "20260808-good-plan.md"), "# Plan\n\n## Goal\nShip it.\n");
      writeFileSync(join(dir, "STRATEGY.md"), "# S\n\n## Vision\n## What we build\n## What we don't build\n## Guiding Principles\n## Technology Direction\n## Decision Log\n");
      const result = runCli(["lint", dir]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    });
  });

  test("dir with no lintable files → note, exit 0", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "notes.txt"), "plain prose\n");
      const result = runCli(["lint", dir]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("no lintable files");
    });
  });

  test("missing <target> arg → usage, exit 2", () => {
    const result = runCli(["lint"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: lint <target>");
  });

  test("existing unclassifiable file → usage, exit 2", () => {
    withTempDir((dir) => {
      const file = join(dir, "README.txt");
      writeFileSync(file, "prose\n");
      const result = runCli(["lint", file]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("unsupported file type");
    });
  });

  test("nonexistent target → exit 1", () => {
    withTempDir((dir) => {
      const result = runCli(["lint", join(dir, "nope.ts")]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("lint target not found");
    });
  });
});

// ---------------------------------------------------------------------------
// mstar design-md validate
// ---------------------------------------------------------------------------

describe("mstar design-md validate — tokens / parity / completeness", () => {
  test("valid Level 1 DESIGN.md → tokens OK, completeness MVP, exit 0", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "DESIGN.md"), DESIGN_LEVEL1);
      const result = runCli(["design-md", "validate", dir]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("design-md validate (tokens): OK");
      expect(result.stdout).toContain("design-md completeness level: MVP");
    });
  });

  test("invalid token value → design-md.tokens.color-format, exit 1", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "DESIGN.md"), DESIGN_LEVEL1.replace('"#ffffff"', '"not-a-color"'));
      const result = runCli(["design-md", "validate", dir]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("design-md.tokens.color-format");
    });
  });

  test("light/dark key mismatch → design-md.parity.missing-dark, exit 1", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "DESIGN.md"), DESIGN_LEVEL1);
      // Dark theme missing gray-900 (and background-100 value differs).
      writeFileSync(
        join(dir, "DESIGN.dark.md"),
        DESIGN_LEVEL1.replace('gray-1000: "#171717"', 'gray-1000: "#000000"').replace('  gray-900: "#666666"\n', ""),
      );
      const result = runCli(["design-md", "validate", dir]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("design-md.parity.missing-dark");
    });
  });

  test("no DESIGN.md in dir → exit 1", () => {
    withTempDir((dir) => {
      const result = runCli(["design-md", "validate", dir]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("design file not found");
    });
  });

  test("missing <dir> arg → usage, exit 2", () => {
    const result = runCli(["design-md", "validate"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: design-md validate <dir>");
  });
});

// ---------------------------------------------------------------------------
// mstar audit scaffold
// ---------------------------------------------------------------------------

describe("mstar audit scaffold — plan directory from findings JSON", () => {
  const FINDINGS = [
    { title: "Fix N+1 query", priority: "P1", effort: "M", risk: "HIGH", category: "perf", dependsOn: "002", description: "Queries explode on the dashboard." },
    { title: "Add index", priority: "P2", effort: "XS", risk: "LOW", category: "tech-debt", description: "Index the audit table." },
  ];

  test("valid findings → plan files + README created, exit 0", () => {
    withTempDir((dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify(FINDINGS));
      const outDir = join(dir, "audit-2026-08-08");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", outDir]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("audit scaffold: OK");
      expect(result.stdout).toContain("created: 001-fix-n-1-query.md");
      expect(result.stdout).toContain("created: 002-add-index.md");
      expect(existsSync(join(outDir, "001-fix-n-1-query.md"))).toBe(true);
      expect(existsSync(join(outDir, "002-add-index.md"))).toBe(true);
      expect(existsSync(join(outDir, "README.md"))).toBe(true);
      // Status block carries the mapped fields (description → Impact section).
      const plan = readFileSync(join(outDir, "001-fix-n-1-query.md"), "utf8");
      expect(plan).toContain("## Impact");
      expect(plan).toContain("Queries explode on the dashboard.");
      expect(plan).toContain("- **Priority**: P1");
      // dependsOn "002" (scaffolded numbering scheme) renders as the
      // documented plans/NNN-*.md form — no dangling Evidence heading either.
      expect(plan).toContain("- **Depends on**: plans/002-*.md");
      expect(plan).not.toContain("## Evidence");
    });
  });

  test("scaffolded plans round-trip through the engine's validateAuditStatusBlocks", () => {
    withTempDir((dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify(FINDINGS));
      const outDir = join(dir, "audit-2026-08-08");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", outDir]);
      expect(result.exitCode).toBe(0);
      for (const file of ["001-fix-n-1-query.md", "002-add-index.md"]) {
        const gate = validateAuditStatusBlocks(readFileSync(join(outDir, file), "utf8"));
        expect({ file, ok: gate.ok, violations: gate.violations.map((v) => v.code) }).toEqual({ file, ok: true, violations: [] });
      }
    });
  });

  test("Planned at carries the repo short SHA resolved at scaffold time", () => {
    withTempDir((dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify(FINDINGS));
      const outDir = join(dir, "audit-2026-08-08");
      // cwd = this repo checkout → git rev-parse --short HEAD resolves
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", outDir]);
      expect(result.exitCode).toBe(0);
      const plan = readFileSync(join(outDir, "001-fix-n-1-query.md"), "utf8");
      const plannedAt = /- \*\*Planned at\*\*: commit `([0-9a-f]{7,40})`, \d{4}-\d{2}-\d{2}/.exec(plan);
      expect(plannedAt).not.toBeNull();
      expect(plannedAt![1]).not.toBe("unknown");
    });
  });

  test("--sha override wins over git resolution; outside a repo the fallback is 'unknown'", () => {
    withTempDir((dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify(FINDINGS));
      const outDir = join(dir, "audit-2026-08-08");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", outDir, "--sha", "deadbee"]);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(outDir, "001-fix-n-1-query.md"), "utf8")).toContain("- **Planned at**: commit `deadbee`,");
    });
    withTempDir((dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify(FINDINGS));
      // cwd = a temp dir outside any git repo → documented "unknown" fallback
      const result = runCli(["audit", "scaffold", findingsFile], dir);
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(dir, "audit-2026-08-08", "001-fix-n-1-query.md"))).toBe(true);
      const plan = readFileSync(join(dir, "audit-2026-08-08", "001-fix-n-1-query.md"), "utf8");
      expect(plan).toContain("- **Planned at**: commit `unknown`,");
      // the "unknown" fallback still round-trips through the validator
      expect(validateAuditStatusBlocks(plan).ok).toBe(true);
    });
  });

  test("--date derives the audit-<date> directory name when --dir is omitted", () => {
    withTempDir((dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify(FINDINGS));
      const result = runCli(["audit", "scaffold", findingsFile, "--date", "2026-07-01"], dir);
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(dir, "audit-2026-07-01", "README.md"))).toBe(true);
      expect(existsSync(join(dir, "audit-2026-07-01", "001-fix-n-1-query.md"))).toBe(true);
    });
  });

  test("invalid dependsOn → usage, exit 2", () => {
    withTempDir((dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify([{ title: "X", priority: "P1", effort: "M", risk: "LOW", category: "perf", dependsOn: "plan-002.md", description: "d" }]));
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("dependsOn must be");
    });
  });

  test("malformed JSON → usage, exit 2", () => {
    withTempDir((dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, "not json");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("not valid JSON");
    });
  });

  test("non-array JSON → usage, exit 2", () => {
    withTempDir((dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, "{}");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("must be a JSON array");
    });
  });

  test("invalid enum value → usage, exit 2", () => {
    withTempDir((dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify([{ title: "X", priority: "P9", effort: "M", risk: "LOW", category: "perf", description: "d" }]));
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("priority must be one of P1|P2|P3");
    });
  });

  test("missing required fields → usage, exit 2", () => {
    withTempDir((dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify([{ title: "X", priority: "P1", effort: "M", risk: "LOW", category: "perf" }]));
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("non-empty title and description");
    });
  });

  test("missing args → usage, exit 2", () => {
    const result = runCli(["audit", "scaffold"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: audit scaffold <findings-file>");
  });

  test("nonexistent findings file → exit 1", () => {
    withTempDir((dir) => {
      const result = runCli(["audit", "scaffold", join(dir, "nope.json"), "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("findings file not found");
    });
  });
});

// ---------------------------------------------------------------------------
// mstar compound validate
// ---------------------------------------------------------------------------

describe("mstar compound validate — knowledge-doc schema / index / scope", () => {
  test("valid knowledge doc → schema OK, exit 0", () => {
    withTempDir((dir) => {
      const doc = join(dir, "doc.md");
      writeFileSync(doc, KNOWLEDGE_GOOD);
      const result = runCli(["compound", "validate", doc]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("compound validate (schema): OK");
    });
  });

  test("doc missing required field → compound.schema.missing-field, exit 1", () => {
    withTempDir((dir) => {
      const doc = join(dir, "doc.md");
      writeFileSync(doc, "---\ndate: 2026-08-08\n---\n");
      const result = runCli(["compound", "validate", doc]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("compound.schema.missing-field");
    });
  });

  test("--knowledge-dir without README index → compound.index.missing-readme, exit 1", () => {
    withTempDir((dir) => {
      const doc = join(dir, "doc.md");
      writeFileSync(doc, KNOWLEDGE_GOOD);
      const knowledgeDir = join(dir, "knowledge");
      mkdirSync(knowledgeDir);
      const result = runCli(["compound", "validate", doc, "--knowledge-dir", knowledgeDir]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("compound.index.missing-readme");
    });
  });

  test("doc outside --knowledge-dir → compound.scope.outside, exit 1", () => {
    withTempDir((dir) => {
      const doc = join(dir, "doc.md");
      writeFileSync(doc, KNOWLEDGE_GOOD);
      const knowledgeDir = join(dir, "knowledge");
      mkdirSync(knowledgeDir);
      writeFileSync(join(knowledgeDir, "README.md"), "# Knowledge\n\n| Document | Source Plan | Description | Status |\n|---|---|---|---|\n");
      const result = runCli(["compound", "validate", doc, "--knowledge-dir", knowledgeDir]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("compound.scope.outside");
    });
  });

  test("doc inside --knowledge-dir with index row → all OK, exit 0", () => {
    withTempDir((dir) => {
      const knowledgeDir = join(dir, "knowledge");
      mkdirSync(knowledgeDir);
      const doc = join(knowledgeDir, "doc.md");
      writeFileSync(doc, KNOWLEDGE_GOOD);
      writeFileSync(join(knowledgeDir, "README.md"), "# Knowledge\n\n| Document | Source Plan | Description | Status |\n|---|---|---|---|\n| [doc](doc.md) | 20260808-x | x | done |\n");
      const result = runCli(["compound", "validate", doc, "--knowledge-dir", knowledgeDir]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("compound validate (schema): OK");
      expect(result.stdout).toContain("compound validate (index rows): OK");
      expect(result.stdout).toContain("compound validate (scope guard): OK");
    });
  });

  test("missing <doc-path> arg → usage, exit 2", () => {
    const result = runCli(["compound", "validate"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: compound validate <doc-path>");
  });

  test("nonexistent doc → exit 1", () => {
    withTempDir((dir) => {
      const result = runCli(["compound", "validate", join(dir, "nope.md")]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("knowledge doc not found");
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
      expect(result.stdout).toContain(`host: ${host}`);
    });
  }

  test("unknown signal token → usage, exit 2", () => {
    const result = runCli(["host", "detect", "--signals", "question,nope"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown signal "nope"');
  });

  test("empty --signals → usage, exit 2", () => {
    const result = runCli(["host", "detect", "--signals", ""]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: host detect --signals <comma-list>");
  });

  test("missing --signals → usage, exit 2", () => {
    const result = runCli(["host", "detect"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: host detect --signals <comma-list>");
  });
});

// ---------------------------------------------------------------------------
// mstar skill lint
// ---------------------------------------------------------------------------

describe("mstar skill lint — frontmatter + five-question body", () => {
  test("well-formed skill → both checks OK, exit 0", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "skill"));
      writeFileSync(join(dir, "skill", "SKILL.md"), SKILL_GOOD);
      const result = runCli(["skill", "lint", join(dir, "skill")]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("skill lint (frontmatter): OK");
      expect(result.stdout).toContain("skill lint (five questions): OK");
    });
  });

  test("body missing five-question sections → skill-authoring.five-question.*, exit 1", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "skill"));
      writeFileSync(
        join(dir, "skill", "SKILL.md"),
        "---\nname: sample-skill\ndescription: Validates harness fixtures during CLI smoke tests.\n---\n\n## Intro\n\nNo sections here.\n",
      );
      const result = runCli(["skill", "lint", join(dir, "skill")]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("skill-authoring.five-question.load-order");
      expect(result.stderr).toContain("skill-authoring.five-question.evidence");
    });
  });

  test("bad frontmatter → lint.frontmatter.name.format, exit 1", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "skill"));
      writeFileSync(join(dir, "skill", "SKILL.md"), "---\nname: Bad-Name\n---\n\n## Load Order\n## Workflow\n## Decision Rules\n## Evidence\n## References\n");
      const result = runCli(["skill", "lint", join(dir, "skill")]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("lint.frontmatter.name.format");
    });
  });

  test("missing SKILL.md → exit 1", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "skill"));
      const result = runCli(["skill", "lint", join(dir, "skill")]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("SKILL.md not found");
    });
  });

  test("missing <skill-dir> arg → usage, exit 2", () => {
    const result = runCli(["skill", "lint"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: skill lint <skill-dir>");
  });
});
