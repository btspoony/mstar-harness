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
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readJson, scaffoldAuditPlan, validateAuditStatusBlocks, validateProjectRegister } from "@mstar-harness/engine";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");

/** Spawn env with ambient harness env vars pinned out (same as the other
 * CLI suites — engine dir resolution must not leak into fixtures).
 * MSTAR_CLI_PROJECT_ROOT / INIT_CWD are pinned too: `resolveCliPath`
 * (audit-002) reads them ahead of PWD, so an ambient value would redirect
 * every relative-path fixture spuriously. TZ is pinned to the test process's
 * own frame (residual 20260827-qa-tzflake-cli-slice4): `bun test` runs this
 * process in UTC when TZ is unset, while a bare subprocess would fall back to
 * the system zone — the two frames diverge across the local calendar-day
 * boundary (00:00–08:00 in positive-offset zones), breaking the backlog
 * `registered_at`/`closed_at` date assertions. An explicit ambient TZ is
 * propagated so both sides always share one frame. */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key === "MSTAR_HARNESS_DIR" ||
      key === "MSTAR_CONTROL_ROOT" ||
      key === "SDD_DIR" ||
      key === "MSTAR_WORKING_BRANCH" ||
      key === "MSTAR_CLI_PROJECT_ROOT" ||
      key === "INIT_CWD"
    ) {
      continue;
    }
    if (value !== undefined) env[key] = value;
  }
  env.TZ = process.env.TZ ?? "UTC";
  return env;
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Run the real CLI entry as a subprocess; cwd + env overrides per test. */
function runCli(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: opts.cwd ?? CLI_ROOT,
    env: { ...cliEnv(), ...opts.env },
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

/** Skill body fixture: concrete ephemeral citations (task artifact +
 * sdd deeplink) inside an otherwise five-question-complete skill. */
const SKILL_EPHEMERAL = `---
name: sample-skill
description: Validates harness fixtures during CLI smoke tests.
---

## Load Order

Read this skill when running smoke fixtures.

## Workflow

Create fixtures, run the CLI, assert exit codes. See task-3-report for the
prior run.

## Decision Rules

Never mutate the control worktree. Check .mstar/sdd/20260815-x/ before edits.

## Evidence

A green CLI run is the success criterion.

## References

Open the engine tests when a fixture drifts.
`;

/** Skill body fixture: placeholder citation forms only — the
 * discrimination contract (zero false positives) requires these to pass. */
const SKILL_PLACEHOLDERS = `---
name: sample-skill
description: Validates harness fixtures during CLI smoke tests.
---

## Load Order

Read this skill when running smoke fixtures.

## Workflow

Create fixtures, run the CLI, assert exit codes. task-N-report and
{SDD_DIR}/task-N-report.md are templates; .mstar/sdd/<plan-id>/ is a
deeplink template too.

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
      // (--date pinned: without it the audit-<date> dir derives from "today", a calendar flake)
      const result = runCli(["audit", "scaffold", findingsFile, "--date", "2026-08-08"], { cwd: dir });
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
      const result = runCli(["audit", "scaffold", findingsFile, "--date", "2026-07-01"], { cwd: dir });
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

  test("JSON null root → usage, exit 2 (typeof null === 'object' must not reach the object branch)", () => {
    withTempDir((dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, "null");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("must be a JSON array or an object with a findings array");
    });
  });

  test("empty JSON object without findings → usage, exit 2", () => {
    withTempDir((dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, "{}");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("must be a JSON array or an object with a findings array");
    });
  });

  test("object with findings: null → usage, exit 2", () => {
    withTempDir((dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify({ findings: null }));
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("must be a JSON array or an object with a findings array");
    });
  });

  test("object form with needsVerification + hardeningChecked renders the security sections", () => {
    withTempDir((dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(
        findingsFile,
        JSON.stringify({
          findings: FINDINGS,
          needsVerification: [{ lead: "SSRF in webhook fetcher", how: "confirm caller supplies the URL", evidence: "src/hooks.ts:77" }],
          hardeningChecked: [
            { kind: "Hardening", text: "no CSP header - middleware escapes all output" },
            { kind: "Checked and clean", text: "orders SQL sink parameterized end to end" },
          ],
        }),
      );
      const outDir = join(dir, "audit-2026-08-08");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", outDir]);
      expect(result.exitCode).toBe(0);
      const readme = readFileSync(join(outDir, "README.md"), "utf8");
      expect(readme).toContain("## Needs verification");
      expect(readme).toContain("- SSRF in webhook fetcher: confirm caller supplies the URL (src/hooks.ts:77)");
      expect(readme).toContain("## Hardening & checked notes");
      expect(readme).toContain("- Hardening: no CSP header - middleware escapes all output");
      expect(readme).toContain("- Checked and clean: orders SQL sink parameterized end to end");
    });
  });

  test("invalid hardeningChecked kind → usage, exit 2", () => {
    withTempDir((dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(
        findingsFile,
        JSON.stringify({
          findings: FINDINGS,
          hardeningChecked: [{ kind: "Note", text: "x" }],
        }),
      );
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("kind must be one of Hardening|Checked and clean");
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
// mstar audit promote

// ---------------------------------------------------------------------------
// mstar audit secret-scan / supply-chain — deterministic static checks
// ---------------------------------------------------------------------------

describe("mstar audit secret-scan — tracked-file credential scan", () => {
  test("seeded secret in a tracked file → finding JSON + exit 1", () => {
    withTempDir((dir) => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      mkdirSync(join(dir, "sub"), { recursive: true });
      // Inert filler matching the AWS whole-match shape (AKIA + 16 alnum).
      // Split literal: keep the raw source free of the full contiguous token
      // (GitHub push protection treats test values as live credentials).
      const awsKey = "AKIAIOSFODNN7" + "EXAMPLE";
      writeFileSync(join(dir, "sub", "config.ts"), `token = "${awsKey}"\n`);
      writeFileSync(join(dir, ".env.production"), "SECRET=placeholder\n");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      const result = runCli(["audit", "secret-scan", dir]);
      expect(result.exitCode).toBe(1);
      // 3 hits: the whole-match AWS shape + the VALUE_PATTERNS `token` row on
      // the same line, plus the never-commit `.env.production` filename.
      expect(result.stderr).toContain("secret-scan: 3 findings");
      // Finding shape: {file, line, type} only — Hard Rule 4, never a value.
      const aws = result.stdout.split("\n").find((l) => l.startsWith("{") && l.includes("aws-access-key"));
      expect(aws).toBeDefined();
      expect(JSON.parse(aws!)).toEqual({ file: join(dir, "sub", "config.ts"), line: 1, type: "aws-access-key" });
      const envHit = result.stdout.split("\n").find((l) => l.startsWith("{") && l.includes("env-file"));
      expect(envHit).toBeDefined();
      expect(JSON.parse(envHit!).line).toBe(1);
      for (const line of result.stdout.split("\n").filter((l) => l.startsWith("{"))) {
        expect(JSON.parse(line).file).toBeDefined();
        expect(JSON.parse(line).line).toBeGreaterThan(0);
        expect(JSON.parse(line).type).toBeDefined();
      }
      // Hard Rule 4 at the shipped boundary: the seeded raw values must be
      // absent from BOTH output streams (qc1 W-006).
      expect(result.stdout + result.stderr).not.toContain(awsKey);
      expect(result.stdout + result.stderr).not.toContain("SECRET=placeholder");
    });
  });

  test("clean repo → exit 0, no finding lines", () => {
    withTempDir((dir) => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "main.ts"), `const key = process.env.API_KEY;\n`);
      execFileSync("git", ["add", "-A"], { cwd: dir });
      const result = runCli(["audit", "secret-scan", dir]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("secret-scan: clean");
      expect(result.stdout).not.toContain("{\"file\"");
    });
  });

  test("untracked files are not scanned; path argument must be a directory → exit 2", () => {
    withTempDir((dir) => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "leak.ts"), `token = "xoxb-123456789-abcdefghij"
`);
      // NOT staged → not tracked → not scanned
      const result = runCli(["audit", "secret-scan", dir]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("clean");
      const bad = runCli(["audit", "secret-scan", join(dir, "no-such-dir")]);
      expect(bad.exitCode).toBe(2);
      expect(bad.stderr).toContain("not a directory");
    });
  });

  test("nested path argument resolves tracked files under it (qc1 W-001)", () => {
    withTempDir((dir) => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      // Leak lives in a NESTED package dir; scan target is that dir.
      const pkg = join(dir, "packages", "engine");
      mkdirSync(pkg, { recursive: true });
      // Synthetic Stripe live-key, split so the raw source never holds the
      // full contiguous token (GitHub push-protection false positive).
      const stripeKey = "sk_live_" + "Z9y8X7W6V5U4T3S2R1Q0P9O8N7";
      writeFileSync(join(pkg, "leak.ts"), `token = "${stripeKey}"\n`);
      writeFileSync(join(dir, "readme.md"), "harmless\n");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      const result = runCli(["audit", "secret-scan", pkg]);
      expect(result.exitCode).toBe(1);
      const stripe = result.stdout.split("\n").find((l) => l.startsWith("{") && l.includes("stripe-live-key"));
      expect(stripe).toBeDefined();
      expect(JSON.parse(stripe!)).toEqual({ file: join(pkg, "leak.ts"), line: 1, type: "stripe-live-key" });
    });
  });

  test("non-git directory → exit 2, not a clean exit 0 (qc1 W-002 / qc3 W-1)", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "main.ts"), `const ok = 1;\n`);
      const result = runCli(["audit", "secret-scan", dir]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("not a git repository or git unavailable");
    });
  });

  test("unreadable tracked file forces non-zero even with no findings (qc1 W-002)", () => {
    withTempDir((dir) => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      const locked = join(dir, "locked.txt");
      writeFileSync(locked, "benign content\n");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      chmodSync(locked, 0o000);
      try {
        const result = runCli(["audit", "secret-scan", dir]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("failed to read");
        expect(result.stderr).toContain("1 tracked file");
      } finally {
        chmodSync(locked, 0o644);
      }
    });
  });
});

describe("mstar audit supply-chain — lockfile + workflow checks", () => {
  test("lockfile missing at root → lockfile-missing finding + exit 1", () => {
    withTempDir((dir) => {
      const result = runCli(["audit", "supply-chain", dir]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("audit.supply.lockfile-missing");
      expect(result.stdout).toContain('"kind":"lockfile-missing"');
    });
  });

  test("two root lockfiles → lockfile-duplicate finding + exit 1", () => {
    withTempDir((dir) => {
      for (const name of ["package-lock.json", "yarn.lock"]) writeFileSync(join(dir, name), "{}\n");
      const result = runCli(["audit", "supply-chain", dir]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('"kind":"lockfile-duplicate"');
    });
  });

  test("single lockfile + SHA-pinned workflow → clean, exit 0", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "bun.lock"), "{}\n");
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      const sha = "a".repeat(40);
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        ["name: ci", "on:", "  push:", "jobs:", "  build:", "    steps:", `      - uses: actions/checkout@${sha}`].join("\n") + "\n",
      );
      const result = runCli(["audit", "supply-chain", dir]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("supply-chain: OK");
      expect(result.stdout).toContain("supply-chain: OK");
      expect(result.stdout).not.toContain('{"kind"');
    });
  });
});

// ---------------------------------------------------------------------------

describe("mstar audit promote — v2 workflow registration for selected plans", () => {
  /** Scaffold an audit dir with two plan files under a temp root and return
   * `{ harnessDir, outDir }` (outDir under harnessDir/plans/, the documented
   * `{PLAN_DIR}/audit-<date>/` layout). */
  function scaffoldFixture(dir: string): { harnessDir: string; outDir: string } {
    const harnessDir = join(dir, "harness");
    const outDir = join(harnessDir, "plans", "audit-2026-08-08");
    scaffoldAuditPlan(
      outDir,
      [
        {
          title: "Fix N+1 query in order list",
          category: "perf",
          impact: "Every order-list render issues 1+N queries.",
          effort: "M",
          risk: "MED",
          confidence: "HIGH",
          evidence: ["src/orders.ts:42"],
          priority: "P1",
        },
        {
          title: "Rotate leaked AWS keys",
          category: "security",
          impact: "Credentials in git history.",
          effort: "S",
          risk: "HIGH",
          confidence: "HIGH",
          evidence: ["src/config.ts:3"],
          priority: "P1",
        },
      ],
      { date: "2026-08-08" },
    );
    return { harnessDir, outDir };
  }

  test("selected plan → snapshot with one Todo row + status.json type plan, exit 0", () => {
    withTempDir((dir) => {
      const { harnessDir, outDir } = scaffoldFixture(dir);
      const result = runCli(["audit", "promote", outDir, "--plans", "001", "--harness", harnessDir]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("audit promote: OK");
      expect(result.stdout).toContain("workflow audit-2026-08-08");

      // snapshot has exactly the selected plan as a Todo row
      const snapshotPath = join(harnessDir, "workflows", "audit-2026-08-08", "snapshot.json");
      expect(existsSync(snapshotPath)).toBe(true);
      expect(result.stdout).toContain(snapshotPath);
      const snapshot = readJson(snapshotPath);
      expect(snapshot.type).toBe("plan");
      expect(snapshot.status).toBe("running");
      const plans = snapshot.plans as Array<Record<string, unknown>>;
      expect(plans).toHaveLength(1);
      expect(plans[0]).toMatchObject({
        id: "001-fix-n-1-query-in-order-list",
        title: "Fix N+1 query in order list",
        file: "audit-2026-08-08/001-fix-n-1-query-in-order-list.md",
        status: "Todo",
      });

      // root status.json registers the workflow as type: plan
      const status = readJson(join(harnessDir, "status.json"));
      expect(status.version).toBe(2);
      const entry = (status.workflows as Array<Record<string, unknown>>).find(
        (w) => w.id === "audit-2026-08-08",
      );
      expect(entry).toMatchObject({ type: "plan", dir: "workflows/audit-2026-08-08" });
      expect(entry?.started_at).toBe(snapshot.started_at);
    });
  });

  test("missing <audit-dir> or --plans → usage, exit 2", () => {
    const noDir = runCli(["audit", "promote"]);
    expect(noDir.exitCode).toBe(2);
    expect(noDir.stderr).toContain("usage: audit promote <audit-dir> --plans <ids>");

    const noPlans = runCli(["audit", "promote", "audit-2026-08-08"]);
    expect(noPlans.exitCode).toBe(2);
    expect(noPlans.stderr).toContain("usage: audit promote <audit-dir> --plans <ids>");
  });

  test("missing harness → exit 1 with the --harness / MSTAR_HARNESS_DIR message", () => {
    withTempDir((dir) => {
      const { outDir } = scaffoldFixture(dir);
      const result = runCli(["audit", "promote", outDir, "--plans", "001"], { cwd: dir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("pass --harness or set MSTAR_HARNESS_DIR");
    });
  });

  test("--workflow override sets the workflow id", () => {
    withTempDir((dir) => {
      const { harnessDir, outDir } = scaffoldFixture(dir);
      const result = runCli([
        "audit",
        "promote",
        outDir,
        "--plans",
        "001",
        "--workflow",
        "audit-2026-08-08-custom",
        "--harness",
        harnessDir,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("workflow audit-2026-08-08-custom");
      expect(
        existsSync(join(harnessDir, "workflows", "audit-2026-08-08-custom", "snapshot.json")),
      ).toBe(true);
    });
  });

  test("re-promote of the same workflow id → exit 1, names the snapshot path, first rows intact", () => {
    withTempDir((dir) => {
      const { harnessDir, outDir } = scaffoldFixture(dir);
      const first = runCli(["audit", "promote", outDir, "--plans", "001", "--harness", harnessDir]);
      expect(first.exitCode).toBe(0);

      const snapshotPath = join(harnessDir, "workflows", "audit-2026-08-08", "snapshot.json");
      const before = readJson(snapshotPath);

      // Second promote (different subset) must refuse with exit 1 and name
      // the existing snapshot path — no silent whole-rewrite.
      const second = runCli(["audit", "promote", outDir, "--plans", "002", "--harness", harnessDir]);
      expect(second.exitCode).toBe(1);
      expect(second.stderr).toContain("already exists");
      expect(second.stderr).toContain(snapshotPath);

      // First rows intact.
      const after = readJson(snapshotPath);
      expect(after.started_at).toBe(before.started_at);
      const plans = after.plans as Array<Record<string, unknown>>;
      expect(plans).toHaveLength(1);
      expect(plans[0]).toMatchObject({ id: "001-fix-n-1-query-in-order-list", status: "Todo" });
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

describe("mstar skill lint — frontmatter + five-question body + ephemeral citations", () => {
  test("well-formed skill → all checks OK, exit 0", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "skill"));
      writeFileSync(join(dir, "skill", "SKILL.md"), SKILL_GOOD);
      const result = runCli(["skill", "lint", join(dir, "skill")]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("skill lint (frontmatter): OK");
      expect(result.stdout).toContain("skill lint (five questions): OK");
      expect(result.stdout).toContain("skill lint (ephemeral citations): OK");
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

  test("concrete task-artifact citation → skill.ephemeral.task-artifact, exit 1", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "skill"));
      writeFileSync(join(dir, "skill", "SKILL.md"), SKILL_EPHEMERAL);
      const result = runCli(["skill", "lint", join(dir, "skill")]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("skill lint (ephemeral citations): FAIL");
      expect(result.stderr).toContain("skill.ephemeral.task-artifact");
      expect(result.stderr).toContain('"task-3-report"');
      expect(result.stderr).toContain("line 12");
    });
  });

  test("concrete sdd deeplink → skill.ephemeral.sdd-deeplink, exit 1", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "skill"));
      writeFileSync(join(dir, "skill", "SKILL.md"), SKILL_EPHEMERAL);
      const result = runCli(["skill", "lint", join(dir, "skill")]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("skill.ephemeral.sdd-deeplink");
      expect(result.stderr).toContain('".mstar/sdd/20260815-x"');
      expect(result.stderr).toContain("line 17");
    });
  });

  test("placeholder citation forms → ephemeral checklist OK, exit 0 (discrimination contract)", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "skill"));
      writeFileSync(join(dir, "skill", "SKILL.md"), SKILL_PLACEHOLDERS);
      const result = runCli(["skill", "lint", join(dir, "skill")]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("skill lint (ephemeral citations): OK");
    });
  });
});

// ---------------------------------------------------------------------------
// project-root path resolution (audit-002: resolveCliPath adoption)
// ---------------------------------------------------------------------------

describe("project-root path resolution — relative dev-command args (audit-002)", () => {
  test("relative skill dir + MSTAR_CLI_PROJECT_ROOT → found from a nested cwd (exit 0)", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "skills", "mstar-audit"), { recursive: true });
      writeFileSync(join(dir, "skills", "mstar-audit", "SKILL.md"), SKILL_GOOD);
      // cwd is nested below the fixture root: the relative arg must resolve
      // against MSTAR_CLI_PROJECT_ROOT, not the process cwd (the bug class
      // this regression guards: `bun run cli:dev skill lint skills/mstar-audit`
      // used to look under packages/cli/skills/...).
      const result = runCli(["skill", "lint", "skills/mstar-audit"], {
        cwd: join(dir, "skills"),
        env: { MSTAR_CLI_PROJECT_ROOT: dir },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("skill lint (frontmatter): OK");
      expect(result.stdout).toContain("skill lint (five questions): OK");
      expect(result.stdout).toContain("skill lint (ephemeral citations): OK");
      expect(result.stderr).not.toContain("SKILL.md not found");
    });
  });

  test("scrubbed env + nested member cwd → workspaces walk-up reaches the monorepo root (exit 0)", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mono", workspaces: ["packages/*"] }));
      const member = join(dir, "packages", "cli");
      mkdirSync(member, { recursive: true });
      mkdirSync(join(dir, "skills", "mstar-audit"), { recursive: true });
      writeFileSync(join(dir, "skills", "mstar-audit", "SKILL.md"), SKILL_GOOD);
      // member manifest carries no workspaces — the walk must skip it and
      // keep going up to the root `workspaces` marker (the `bun run --cwd
      // packages/cli dev` shape: env unset, process cwd = packages/cli).
      writeFileSync(join(member, "package.json"), JSON.stringify({ name: "@mono/cli" }));
      const result = runCli(["skill", "lint", "skills/mstar-audit"], { cwd: member });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("skill lint (frontmatter): OK");
      expect(result.stderr).not.toContain("SKILL.md not found");
    });
  });

  test("single-package consumer: nested cwd resolves to the nearest package.json root (exit 0)", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer-app" }));
      mkdirSync(join(dir, "skills", "mstar-audit"), { recursive: true });
      writeFileSync(join(dir, "skills", "mstar-audit", "SKILL.md"), SKILL_GOOD);
      const nested = join(dir, "src", "deep");
      mkdirSync(nested, { recursive: true });
      const result = runCli(["skill", "lint", "skills/mstar-audit"], { cwd: nested });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("skill lint (frontmatter): OK");
    });
  });

  test("outside any package.json tree → cwd-relative terminal fallback (exit 1)", () => {
    withTempDir((dir) => {
      // no package.json anywhere above the fixture — relative args stay
      // cwd-relative by terminal fallback, so the arg must NOT find the
      // fixture under the bare cwd.
      const result = runCli(["skill", "lint", "skills/mstar-audit"], { cwd: dir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("SKILL.md not found");
      expect(result.stderr).toContain(join(dir, "skills", "mstar-audit"));
    });
  });

  test("absolute skill dir is unchanged even with MSTAR_CLI_PROJECT_ROOT set", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "elsewhere"), { recursive: true });
      writeFileSync(join(dir, "elsewhere", "SKILL.md"), SKILL_GOOD);
      const result = runCli(["skill", "lint", join(dir, "elsewhere")], {
        env: { MSTAR_CLI_PROJECT_ROOT: join(dir, "nope") },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("skill lint (frontmatter): OK");
    });
  });
});

// ---------------------------------------------------------------------------
// all six resolveCliPath adoptions — parameterized subprocess proof (F-S2)
// ---------------------------------------------------------------------------

describe("project-root path resolution — all six dev commands with relative args (audit-002 F-S2)", () => {
  /** Minimal well-formed writable assignment (same shape as the engine fixture). */
  const ASSIGNMENT_GOOD = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/foo
**Plan Path**: .mstar/plans/20260808-example.md
`;

  const AUDIT_FINDINGS = [
    { title: "Fix N+1 query", priority: "P1", effort: "M", risk: "HIGH", category: "perf", dependsOn: "002", description: "Queries explode on the dashboard." },
  ];

  // Every documented dev command that resolves a relative path arg through
  // resolveCliPath (all 8 adoption sites): fixture under the project root,
  // relative arg(s), process cwd nested below the root, MSTAR_CLI_PROJECT_ROOT
  // pinned to the root. Exit 0 + output landing under the root (NOT the nested
  // cwd) prove the arg went through resolveCliPath end-to-end, not
  // cwd-relative resolution.
  const cases: {
    name: string;
    args: string[];
    setup: (dir: string) => void;
    assert: (dir: string, result: RunResult) => void;
  }[] = [
    {
      name: "skill lint <relative skill dir>",
      args: ["skill", "lint", "skills/mstar-audit"],
      setup: (dir) => {
        mkdirSync(join(dir, "skills", "mstar-audit"), { recursive: true });
        writeFileSync(join(dir, "skills", "mstar-audit", "SKILL.md"), SKILL_GOOD);
      },
      assert: (_dir, result) => {
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("skill lint (frontmatter): OK");
        expect(result.stderr).not.toContain("SKILL.md not found");
      },
    },
    {
      name: "lint <relative STRATEGY.md>",
      args: ["lint", "strategy/STRATEGY.md"],
      setup: (dir) => {
        mkdirSync(join(dir, "strategy"), { recursive: true });
        writeFileSync(
          join(dir, "strategy", "STRATEGY.md"),
          ["# Strategy", "", "## Vision", "## What we build", "## What we don't build", "## Guiding Principles", "## Technology Direction", "## Decision Log", ""].join("\n"),
        );
      },
      assert: (_dir, result) => {
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("OK");
        expect(result.stderr).toBe("");
      },
    },
    {
      name: "dispatch validate <relative assignment file>",
      args: ["dispatch", "validate", "assignments/assignment.md"],
      setup: (dir) => {
        mkdirSync(join(dir, "assignments"), { recursive: true });
        writeFileSync(join(dir, "assignments", "assignment.md"), ASSIGNMENT_GOOD);
      },
      assert: (_dir, result) => {
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("dispatch validate: OK");
        expect(result.stderr).toBe("");
      },
    },
    {
      name: "compound validate <relative doc> + <relative --knowledge-dir>",
      args: ["compound", "validate", "knowledge/doc.md", "--knowledge-dir", "knowledge"],
      setup: (dir) => {
        mkdirSync(join(dir, "knowledge"), { recursive: true });
        writeFileSync(join(dir, "knowledge", "doc.md"), KNOWLEDGE_GOOD);
        writeFileSync(join(dir, "knowledge", "README.md"), "# Knowledge\n\n| Document | Source Plan | Description | Status |\n|---|---|---|---|\n| [doc](doc.md) | 20260808-x | x | done |\n");
      },
      assert: (_dir, result) => {
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("compound validate (schema): OK");
        expect(result.stdout).toContain("compound validate (index rows): OK");
        expect(result.stdout).toContain("compound validate (scope guard): OK");
      },
    },
    {
      name: "design-md validate <relative design dir>",
      args: ["design-md", "validate", "design"],
      setup: (dir) => {
        mkdirSync(join(dir, "design"), { recursive: true });
        writeFileSync(join(dir, "design", "DESIGN.md"), DESIGN_LEVEL1);
      },
      assert: (_dir, result) => {
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("design-md validate (tokens): OK");
        expect(result.stdout).toContain("design-md completeness level: MVP");
      },
    },
    {
      name: "audit scaffold <relative findings file> + <relative --dir>",
      args: ["audit", "scaffold", "findings/findings.json", "--dir", "out", "--sha", "deadbee"],
      setup: (dir) => {
        mkdirSync(join(dir, "findings"), { recursive: true });
        writeFileSync(join(dir, "findings", "findings.json"), JSON.stringify(AUDIT_FINDINGS));
      },
      assert: (dir, result) => {
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("audit scaffold: OK");
        expect(result.stdout).toContain("created: 001-fix-n-1-query.md");
        // --dir "out" resolved against the project root, not the nested cwd.
        expect(existsSync(join(dir, "out", "001-fix-n-1-query.md"))).toBe(true);
        expect(existsSync(join(dir, "out", "README.md"))).toBe(true);
      },
    },
  ];

  for (const c of cases) {
    test(`relative path args resolve against the project root — ${c.name} (exit 0)`, () => {
      withTempDir((dir) => {
        c.setup(dir);
        const nested = join(dir, "nested", "deep");
        mkdirSync(nested, { recursive: true });
        const result = runCli(c.args, { cwd: nested, env: { MSTAR_CLI_PROJECT_ROOT: dir } });
        c.assert(dir, result);
      });
    });
  }
});

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
    const result = runCli(["roles", "validate"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("roles validate (mapping): OK");
    expect(result.stdout).toContain("roles validate (load order): OK");
    expect(result.stdout).toMatch(/roles validate: OK \(\d+ violations?, \d+ sibling skills? scanned; load-order over \d+, core exempt\)/);
    expect(result.stderr).toBe("");
  });

  test("--roles-dir / --skills-dir overrides; load-order violation exits 1 with one row each", () => {
    withTempDir((dir) => {
      const skillsRoot = join(dir, "skills");
      mkdirSync(join(skillsRoot, "mstar-foo"), { recursive: true });
      writeFileSync(join(skillsRoot, "mstar-foo", "SKILL.md"), SIBLING_NO_LOAD_ORDER);
      const result = runCli(["roles", "validate", "--roles-dir", REPO_ROLES_DIR, "--skills-dir", skillsRoot]);
      expect(result.exitCode).toBe(1);
      // Mapping still passes on the real roles dir — the failure is isolated to
      // the load-order lint so the row contract is asserted exactly.
      expect(result.stdout).toContain("roles validate (mapping): OK");
      expect(result.stderr).toContain("roles validate (load order): FAIL (1 violation)");
      expect(result.stderr).toContain("roles.loadorder.section.missing");
      expect(result.stderr).toContain('skill "mstar-foo"');
      expect(result.stdout).toContain("roles validate: FAIL (1 violation, 1 sibling skill scanned; load-order over 1)");
    });
  });

  test("empty roles dir — mapping violations, one row each (exit 1)", () => {
    withTempDir((dir) => {
      const result = runCli(["roles", "validate", "--roles-dir", dir, "--skills-dir", dir]);
      expect(result.exitCode).toBe(1);
      // Row-cardinality pin: the FAIL header count must equal the number of
      // reference.missing violation rows on stderr (printChecklist emits one
      // row per violation), and the stdout summary must agree.
      const header = /roles validate \(mapping\): FAIL \((\d+) violations?\)/.exec(result.stderr);
      expect(header).not.toBeNull();
      const declared = Number(header![1]);
      expect(declared).toBeGreaterThan(0);
      expect((result.stderr.match(/roles\.mapping\.reference\.missing/g) ?? []).length).toBe(declared);
      expect(result.stdout).toContain(
        `roles validate: FAIL (${declared} violations, 0 sibling skills scanned; load-order over 0)`,
      );
    });
  });

  test("unreadable sibling SKILL.md is skipped best-effort (exit 0)", () => {
    withTempDir((dir) => {
      const skillsRoot = join(dir, "skills");
      // A directory named SKILL.md makes readFileSync throw (EISDIR)
      // deterministically — exercises the best-effort skip without
      // root-dependent chmod semantics.
      mkdirSync(join(skillsRoot, "mstar-foo", "SKILL.md"), { recursive: true });
      const result = runCli(["roles", "validate", "--roles-dir", REPO_ROLES_DIR, "--skills-dir", skillsRoot]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("roles validate (load order): OK");
      expect(result.stdout).toContain("roles validate: OK (0 violations, 0 sibling skills scanned; load-order over 0)");
    });
  });

  test("relative --roles-dir resolves against the project root (F-S2 pattern)", () => {
    withTempDir((dir) => {
      // Copy the real roles dir into the fixture project root so the mapping
      // passes; the sibling scan then covers the copied mstar-roles SKILL.md.
      cpSync(REPO_ROLES_DIR, join(dir, "skills", "mstar-roles"), { recursive: true });
      const nested = join(dir, "nested", "deep");
      mkdirSync(nested, { recursive: true });
      const result = runCli(["roles", "validate", "--roles-dir", "skills/mstar-roles"], {
        cwd: nested,
        env: { MSTAR_CLI_PROJECT_ROOT: dir },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("roles validate (mapping): OK");
      expect(result.stdout).toContain("roles validate (load order): OK");
      expect(result.stdout).toContain("roles validate: OK (0 violations, 1 sibling skill scanned; load-order over 1)");
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
    withTempDir((dir) => {
      writeFileSync(join(dir, "status.json"), STATUS_V2_ROOT_OK);
      const result = runCli(["status", "validate", join(dir, "status.json")]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`${join(dir, "status.json")}: OK`);
      expect(result.stderr).toBe("");
    });
  });

  test("v2 root listing a workflow whose snapshot is missing → snapshot-missing, exit 1", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "status.json"), STATUS_V2_ROOT_MISSING_SNAPSHOT);
      const result = runCli(["status", "validate", join(dir, "status.json")]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("status.workflow.snapshot-missing");
    });
  });

  test("v1 root fails closed with the migrate hint, exit 1", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "status.json"), STATUS_V1_ROOT);
      const result = runCli(["status", "validate", join(dir, "status.json")]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("status.migration-required");
      expect(result.stderr).toContain("mstar migrate");
    });
  });

  test("workflow snapshot path validates with the snapshot validator, exit 0", () => {
    withTempDir((dir) => {
      const workflowDir = join(dir, "workflows", "wf-1");
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(join(workflowDir, "snapshot.json"), snapshotDoc([]));
      const result = runCli(["status", "validate", join(workflowDir, "snapshot.json")]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`${join(workflowDir, "snapshot.json")}: OK`);
    });
  });

  test("invalid snapshot (bad lifecycle type) → workflow.snapshot.invalid-type, exit 1", () => {
    withTempDir((dir) => {
      const workflowDir = join(dir, "workflows", "wf-1");
      mkdirSync(workflowDir, { recursive: true });
      const doc = JSON.parse(snapshotDoc([])) as Record<string, unknown>;
      doc.type = "sprint";
      writeFileSync(join(workflowDir, "snapshot.json"), JSON.stringify(doc, null, 2));
      const result = runCli(["status", "validate", join(workflowDir, "snapshot.json")]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("workflow.snapshot.invalid-type");
    });
  });

  test("missing status file fails with exit 1", () => {
    withTempDir((dir) => {
      const result = runCli(["status", "validate", join(dir, "nope.json")]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("status file not found");
    });
  });
});

// ---------------------------------------------------------------------------
// mstar status tech-debt — project-register rollup (audit-004 cutover)
// ---------------------------------------------------------------------------

/** Project register whose one open residual rolls up to total_open 1. */
const REGISTER_ONE_OPEN = JSON.stringify(
  {
    entries: {
      "demo-plan": [
        {
          id: "R1",
          title: "Fix ordering bug",
          severity: "high",
          lifecycle: "open",
          decision: "accept",
          target: "next-iteration",
          source: "qc",
          scope: "plan",
          owner: "dev",
          tracking: "ticket",
        },
      ],
    },
  },
  null,
  2,
);

/** Write `projects/<id>/residuals.json` under `dir`; returns the project dir. */
function writeRegister(dir: string, projectId: string, content: string): string {
  const projectDir = join(dir, "projects", projectId);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "residuals.json"), content);
  return dir;
}

describe("mstar status tech-debt — project-register rollup (v3 relocation)", () => {
  test("prints the rollup over the project registers and exits 0 (informational)", () => {
    withTempDir((dir) => {
      writeRegister(dir, "_default", REGISTER_ONE_OPEN);
      const result = runCli(["status", "tech-debt", join(dir, "projects")]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("total_open: 1");
      expect(result.stdout).toContain('by_severity: {"critical":0,"high":1,"medium":0,"low":0,"nit":0}');
      expect(result.stdout).toContain('by_target: {"next-iteration":1}');
      expect(result.stdout).toContain('by_plan: {"demo-plan":1}');
      expect(result.stdout).toContain("source of truth");
      expect(result.stderr).toBe("");
    });
  });

  test("no open entries → empty rollup, informational exit 0 (never DRIFT)", () => {
    withTempDir((dir) => {
      writeRegister(dir, "_default", JSON.stringify({ entries: {} }));
      const result = runCli(["status", "tech-debt", join(dir, "projects")]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("total_open: 0");
      expect(result.stdout).toContain("source of truth");
    });
  });

  test("missing project dir fails with exit 1", () => {
    withTempDir((dir) => {
      const result = runCli(["status", "tech-debt", join(dir, "nope")]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("project dir not found");
    });
  });
});

// ---------------------------------------------------------------------------
// mstar status findings-cleanup — project-register gate (audit-004 cutover)
// ---------------------------------------------------------------------------

/** Register with one open non-critical residual under plan p1 — allow-residual passes. */
const REGISTER_CLEANUP_ALLOW_PASS = JSON.stringify(
  {
    entries: {
      p1: [
        {
          id: "R1",
          title: "Style nit follow-up",
          severity: "low",
          lifecycle: "open",
          decision: "accept",
          target: "next-iteration",
          source: "qc",
          scope: "plan",
          owner: "dev",
          tracking: "ticket",
        },
      ],
    },
  },
  null,
  2,
);

/** Same register but the residual is critical — allow-residual blocks Approve. */
const REGISTER_CLEANUP_ALLOW_FAIL = REGISTER_CLEANUP_ALLOW_PASS.replace('"severity": "low"', '"severity": "critical"');

/** Register with a fixable open residual — zero-residual blocks it. */
const REGISTER_CLEANUP_ZERO_FAIL = REGISTER_CLEANUP_ALLOW_PASS.replace('"severity": "low"', '"severity": "medium"').replace(
  '"target": "next-iteration"',
  '"target": ""',
);

describe("mstar status findings-cleanup — project-register cleanup-mode gate (v3 relocation)", () => {
  test("allow-residual with non-critical open residual passes (exit 0)", () => {
    withTempDir((dir) => {
      writeRegister(dir, "_default", REGISTER_CLEANUP_ALLOW_PASS);
      const result = runCli(["status", "findings-cleanup", "p1", "--harness", dir]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("findings-cleanup p1: OK");
    });
  });

  test("allow-residual with an unresolved critical fails (exit 1)", () => {
    withTempDir((dir) => {
      writeRegister(dir, "_default", REGISTER_CLEANUP_ALLOW_FAIL);
      const result = runCli(["status", "findings-cleanup", "p1", "--harness", dir]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("findings-cleanup p1: FAIL (1 violation)");
      expect(result.stderr).toContain("findings.allow-residual-critical");
    });
  });

  test("zero-residual mode blocks a fixable open residual (exit 1)", () => {
    withTempDir((dir) => {
      writeRegister(dir, "_default", REGISTER_CLEANUP_ZERO_FAIL);
      const result = runCli(["status", "findings-cleanup", "p1", "--harness", dir, "--mode", "zero-residual"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("findings.zero-residual-open-fixable");
    });
  });

  test("no register entries for the plan → gate passes (exit 0)", () => {
    withTempDir((dir) => {
      writeRegister(dir, "_default", JSON.stringify({ entries: {} }));
      const result = runCli(["status", "findings-cleanup", "p1", "--harness", dir]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("findings-cleanup p1: OK");
    });
  });

  test("missing project register fails with exit 1", () => {
    withTempDir((dir) => {
      const result = runCli(["status", "findings-cleanup", "p1", "--harness", dir]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("project register not found");
    });
  });

  test("invalid --mode is a usage error (exit 1)", () => {
    withTempDir((dir) => {
      writeRegister(dir, "_default", REGISTER_CLEANUP_ALLOW_PASS);
      const result = runCli(["status", "findings-cleanup", "p1", "--harness", dir, "--mode", "bogus"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid --mode bogus");
    });
  });
});

// ---------------------------------------------------------------------------
// mstar status backlog-register / backlog-close — project-register backlog
// (plan 20260826-backlog-register-cli Task 3; engine APIs from Task 1)
// ---------------------------------------------------------------------------

/** Local calendar date YYYY-MM-DD — same convention as the CLI's `registered_at` fill. */
function todayLocal(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** One deferred-PR residual JSON string (nine fields; provenance is CLI-filled). */
function backlogEntryJson(id: string, pr: string): string {
  return JSON.stringify({
    id,
    title: `pr-deep-review ${pr}`,
    severity: "low",
    source: "pr-deep-review batch input",
    scope: `deep review of ${pr} in a new pr-deep-review session`,
    decision: "defer",
    owner: "project-manager",
    target: "next session",
    tracking: "pr-deep-review backlog",
  });
}

/** Read `projects/<id>/residuals.json` under `dir` as a parsed object. */
function readRegister(dir: string, projectId = "_default"): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "projects", projectId, "residuals.json"), "utf8")) as Record<string, unknown>;
}

describe("mstar status backlog-register — project-register backlog append (engine-backed)", () => {
  test("valid --entry JSON registers entries under the used key, prints the key, exit 0", () => {
    withTempDir((dir) => {
      const key = "pr-deep-review-2026-08-26";
      const result = runCli([
        "status", "backlog-register", "--harness", dir, "--key", key,
        "--entry", backlogEntryJson(`${key}-1`, "owner/repo#123"),
        "--entry", backlogEntryJson(`${key}-2`, "owner/repo#456"),
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`under key ${key}`);
      expect(result.stderr).toBe("");

      const register = readRegister(dir);
      const entries = (register.entries as Record<string, unknown[]>)[key] as Array<Record<string, unknown>>;
      expect(entries).toHaveLength(2);
      for (const entry of entries) {
        for (const field of ["id", "title", "severity", "source", "scope", "decision", "owner", "target", "tracking", "source_plan", "registered_at"]) {
          expect(entry).toHaveProperty(field);
        }
        expect(entry.source_plan).toBe(key);
        expect(entry.registered_at).toBe(todayLocal());
      }
      expect(validateProjectRegister(register).ok).toBe(true);
    });
  });

  test("missing --project defaults to _default", () => {
    withTempDir((dir) => {
      const key = "pr-deep-review-2026-08-26";
      const result = runCli([
        "status", "backlog-register", "--harness", dir, "--key", key,
        "--entry", backlogEntryJson(`${key}-1`, "owner/repo#123"),
      ]);
      expect(result.exitCode).toBe(0);
      const register = readRegister(dir, "_default");
      expect((register.entries as Record<string, unknown[]>)[key]).toHaveLength(1);
    });
  });

  test("no --entry is rejected with a clear error (exit 1)", () => {
    withTempDir((dir) => {
      const result = runCli(["status", "backlog-register", "--harness", dir, "--key", "k1"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("at least one --entry is required");
    });
  });

  test("invalid --entry JSON is rejected (exit 1)", () => {
    withTempDir((dir) => {
      const result = runCli(["status", "backlog-register", "--harness", dir, "--key", "k1", "--entry", "{not json"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not valid JSON");
    });
  });

  test("explicit --project <non-_default> registers + validates under the given project id (exit 0)", () => {
    withTempDir((dir) => {
      const key = "pr-deep-review-2026-08-26";
      const result = runCli([
        "status", "backlog-register", "--harness", dir, "--project", "myproj", "--key", key,
        "--entry", backlogEntryJson(`${key}-1`, "owner/repo#123"),
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`under key ${key}`);
      expect(result.stderr).toBe("");

      const register = readRegister(dir, "myproj");
      const entries = (register.entries as Record<string, unknown[]>)[key] as Array<Record<string, unknown>>;
      expect(entries).toHaveLength(1);
      expect(validateProjectRegister(register).ok).toBe(true);
    });
  });

  test("--project ../evil is rejected by the id sanitizer (exit 1, no write)", () => {
    withTempDir((dir) => {
      const result = runCli([
        "status", "backlog-register", "--harness", dir, "--project", "../evil", "--key", "k1",
        "--entry", backlogEntryJson("k1-1", "owner/repo#123"),
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid project id");
    });
  });

  test("--project /abs is rejected by the id sanitizer (exit 1, no write)", () => {
    withTempDir((dir) => {
      const result = runCli([
        "status", "backlog-register", "--harness", dir, "--project", "/abs", "--key", "k1",
        "--entry", backlogEntryJson("k1-1", "owner/repo#123"),
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid project id");
    });
  });
});

describe("mstar status backlog-close — project-register backlog close (engine-backed)", () => {
  test("closes the entry in place (lifecycle resolved + closed_at + closure_note), exit 0", () => {
    withTempDir((dir) => {
      const key = "pr-deep-review-2026-08-26";
      const id = `${key}-1`;
      const registerResult = runCli([
        "status", "backlog-register", "--harness", dir, "--key", key,
        "--entry", backlogEntryJson(id, "owner/repo#123"),
      ]);
      expect(registerResult.exitCode).toBe(0);

      const result = runCli(["status", "backlog-close", "--harness", dir, "--key", key, "--id", id]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`resolved entry ${id}`);

      const register = readRegister(dir);
      const entry = ((register.entries as Record<string, unknown[]>)[key] as Array<Record<string, unknown>>)[0];
      expect(entry.lifecycle).toBe("resolved");
      expect(entry.closed_at).toBe(todayLocal());
      expect(entry.closure_note).toBe("closed by backlog close");
      expect(validateProjectRegister(register).ok).toBe(true);
    });
  });

  test("absent entry id fails loud (exit 1)", () => {
    withTempDir((dir) => {
      const key = "pr-deep-review-2026-08-26";
      const registerResult = runCli([
        "status", "backlog-register", "--harness", dir, "--key", key,
        "--entry", backlogEntryJson(`${key}-1`, "owner/repo#123"),
      ]);
      expect(registerResult.exitCode).toBe(0);

      const result = runCli(["status", "backlog-close", "--harness", dir, "--key", key, "--id", "no-such-id"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not found");
    });
  });

  test("closing an already-resolved entry is a no-op re-stamp (exit 0, stays resolved) — engine behavior", () => {
    withTempDir((dir) => {
      const key = "pr-deep-review-2026-08-26";
      const id = `${key}-1`;
      const registerResult = runCli([
        "status", "backlog-register", "--harness", dir, "--key", key,
        "--entry", backlogEntryJson(id, "owner/repo#123"),
      ]);
      expect(registerResult.exitCode).toBe(0);

      const first = runCli(["status", "backlog-close", "--harness", dir, "--key", key, "--id", id]);
      expect(first.exitCode).toBe(0);

      const second = runCli(["status", "backlog-close", "--harness", dir, "--key", key, "--id", id]);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain(`resolved entry ${id}`);

      const register = readRegister(dir);
      const entry = ((register.entries as Record<string, unknown[]>)[key] as Array<Record<string, unknown>>)[0];
      expect(entry.lifecycle).toBe("resolved");
      expect(validateProjectRegister(register).ok).toBe(true);
    });
  });

  test("backlog-close --project ../evil is rejected by the id sanitizer (exit 1)", () => {
    withTempDir((dir) => {
      const result = runCli([
        "status", "backlog-close", "--harness", dir, "--project", "../evil", "--key", "k1", "--id", "x",
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid project id");
    });
  });
});
// ---------------------------------------------------------------------------
// mstar status archive-residuals — removed in v3 (audit-004 cutover)
// ---------------------------------------------------------------------------

describe("mstar status archive-residuals — removed command names the replacement", () => {
  test("invocation errors and names the project-register replacement (exit 1)", () => {
    const result = runCli(["status", "archive-residuals"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("status archive-residuals: removed in v3");
    expect(result.stderr).toContain("projects/<id>/residuals.json");
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
  withTempDir((dir) => {
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
      expect(result.stdout).toContain("integration_merge_lease valid (holder Main)");
    });
  });

  test("absent lease is the valid unclaimed state (exit 0)", () => {
    withMergeLeaseSnapshot(undefined, (dir) => {
      const result = runCli(["lease", "verify-integration", "--workflow", "wf-1", "--harness", dir]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("no integration_merge_lease (unclaimed)");
    });
  });

  test("null lease is a tombstone and fails with the engine code (exit 1)", () => {
    withMergeLeaseSnapshot(null, (dir) => {
      const result = runCli(["lease", "verify-integration", "--workflow", "wf-1", "--harness", dir]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("lease verify-integration: FAIL (1 violation)");
      expect(result.stderr).toContain("lease.merge-lease.invalid");
    });
  });

  test("lease missing a required field fails with the engine code (exit 1)", () => {
    withMergeLeaseSnapshot(LEASE_MISSING_HOLDER, (dir) => {
      const result = runCli(["lease", "verify-integration", "--workflow", "wf-1", "--harness", dir]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("lease verify-integration: FAIL (1 violation)");
      expect(result.stderr).toContain("lease.merge-lease.missing-holder");
    });
  });

  test("missing --workflow is a usage error (exit 2)", () => {
    const result = runCli(["lease", "verify-integration"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: lease verify-integration --workflow <id>");
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
    withTempDir((dir) => {
      for (const name of ["qc1.md", "qc2.md", "qc3.md"]) {
        writeFileSync(join(dir, name), qcAssignmentFixture("20260816-audit-004", "merge-base: main + tip: HEAD"));
      }
      const result = runCli(["worktree", "qc-alignment", join(dir, "qc1.md"), join(dir, "qc2.md"), join(dir, "qc3.md")]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("worktree qc-alignment: OK (3 assignments, 3 fields byte-identical)");
    });
  });

  test("separate-label form still parses as aligned (exit 0)", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "qc1.md"), qcAssignmentSeparateFixture("20260816-audit-004", "merge-base: main + tip: HEAD"));
      writeFileSync(join(dir, "qc2.md"), qcAssignmentSeparateFixture("20260816-audit-004", "merge-base: main + tip: HEAD"));
      const result = runCli(["worktree", "qc-alignment", join(dir, "qc1.md"), join(dir, "qc2.md")]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("worktree qc-alignment: OK (2 assignments, 3 fields byte-identical)");
    });
  });

  test("a differing Diff basis fails with qc.alignment.mismatch (exit 1)", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "qc1.md"), qcAssignmentFixture("20260816-audit-004", "merge-base: main + tip: HEAD"));
      writeFileSync(join(dir, "qc2.md"), qcAssignmentFixture("20260816-audit-004", "merge-base: main + tip: HEAD~1"));
      const result = runCli(["worktree", "qc-alignment", join(dir, "qc1.md"), join(dir, "qc2.md")]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worktree qc-alignment: FAIL (2 violations)");
      expect(result.stderr).toContain('"Review range" is not byte-identical');
      expect(result.stderr).toContain('"Diff basis" is not byte-identical');
    });
  });

  test("assignment missing an alignment field fails with qc.alignment.field.missing (exit 1)", () => {
    withTempDir((dir) => {
      // Separate-label variant with the Diff basis line removed (the combined
      // form cannot drop a single range field).
      const incomplete = qcAssignmentSeparateFixture("20260816-audit-004", "merge-base: main + tip: HEAD").replace(
        "**Diff basis**: merge-base: main + tip: HEAD\n",
        "",
      );
      writeFileSync(join(dir, "qc1.md"), incomplete);
      const result = runCli(["worktree", "qc-alignment", join(dir, "qc1.md")]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("qc.alignment.field.missing");
      expect(result.stderr).toContain('missing "Diff basis" header field');
      expect(result.stderr).not.toContain('missing "Review range" header field');
    });
  });

  test("no assignment files is a usage error (exit 2)", () => {
    const result = runCli(["worktree", "qc-alignment"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: worktree qc-alignment <assignment-file>...");
  });
});

// ---------------------------------------------------------------------------
// mstar host skill-root — per-host resolution matrix (audit-004)
// ---------------------------------------------------------------------------

describe("mstar host skill-root — loaded skill-root resolution (audit-004)", () => {
  test("opencode resolves to the package-internal harness-skills mount (exit 0)", () => {
    const result = runCli(["host", "skill-root", "--host", "opencode", "--skill", "mstar-roles"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("harness-skills/mstar-roles");
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
    expect(result.stdout).toContain("~/.cursor/plugins/local/morning-star-harness/skills/mstar-roles/references/opencode.md");
  });

  test("omp resolves to the skill:// URI form (exit 0)", () => {
    const result = runCli(["host", "skill-root", "--host", "omp", "--skill", "mstar-roles"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("skill://mstar-roles");
  });

  test("pi prints the deferred-resolution notice shape (exit 0)", () => {
    const result = runCli(["host", "skill-root", "--host", "pi", "--skill", "mstar-roles"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("deferred: pi has no plugin API in v1");
  });

  test("dsh resolves to the bundled skill dir form (exit 0)", () => {
    const result = runCli(["host", "skill-root", "--host", "dsh", "--skill", "mstar-roles"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("$DSH_BUNDLED_SKILL_DIR/mstar-roles");
  });

  test("empty --skill value is a usage error (exit 2)", () => {
    const result = runCli(["host", "skill-root", "--host", "opencode", "--skill="]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--skill must be a non-empty skill name");
  });

  test("unknown host is a usage error (exit 2)", () => {
    const result = runCli(["host", "skill-root", "--host", "bogus", "--skill", "mstar-roles"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown host "bogus"');
  });
});
