/**
 * Project-root path resolution for relative dev-command args: skills-root
 * walk-up, workspaces/monorepo member, single-package consumer, terminal
 * cwd fallback, and the all-six parameterized subprocess proof.
 * Moved from slice4-cli.test.ts during the command-owner test split.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, withTempDir } from "./harness";
import { cliEnvelope, lintResults, type RunResult } from "./support/cli-assertions";
import { DESIGN_LEVEL1, KNOWLEDGE_GOOD, SKILL_GOOD } from "./support/cli-content-fixtures";

describe("project-root path resolution — relative dev-command args (audit-002)", () => {
  test("relative skill dir + MSTAR_CLI_PROJECT_ROOT → found from a nested cwd (exit 0)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
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
      expect(cliEnvelope(result, "ok", "skill.lint.ok").data).toMatchObject({ ok: true, violations: [], exempt: false });
    });
  });

  test("scrubbed env + nested member cwd → workspaces walk-up reaches the monorepo root (exit 0)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
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
      expect(cliEnvelope(result, "ok", "skill.lint.ok").data).toMatchObject({ ok: true, violations: [], exempt: false });
    });
  });

  test("single-package consumer: nested cwd resolves to the nearest package.json root (exit 0)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer-app" }));
      mkdirSync(join(dir, "skills", "mstar-audit"), { recursive: true });
      writeFileSync(join(dir, "skills", "mstar-audit", "SKILL.md"), SKILL_GOOD);
      const nested = join(dir, "src", "deep");
      mkdirSync(nested, { recursive: true });
      const result = runCli(["skill", "lint", "skills/mstar-audit"], { cwd: nested });
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "skill.lint.ok").data).toMatchObject({ ok: true, violations: [], exempt: false });
    });
  });

  test("outside any package.json tree → cwd-relative terminal fallback (exit 1)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      // no package.json anywhere above the fixture — relative args stay
      // cwd-relative by terminal fallback, so the arg must NOT find the
      // fixture under the bare cwd.
      const result = runCli(["skill", "lint", "skills/mstar-audit"], { cwd: dir });
      expect(result.exitCode).toBe(1);
      const refusal = cliEnvelope(result, "refused");
      expect(refusal.message).toContain("SKILL.md not found");
      expect(refusal.message).toContain(join(dir, "skills", "mstar-audit"));
    });
  });

  test("absolute skill dir is unchanged even with MSTAR_CLI_PROJECT_ROOT set", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      mkdirSync(join(dir, "elsewhere"), { recursive: true });
      writeFileSync(join(dir, "elsewhere", "SKILL.md"), SKILL_GOOD);
      const result = runCli(["skill", "lint", join(dir, "elsewhere")], {
        env: { MSTAR_CLI_PROJECT_ROOT: join(dir, "nope") },
      });
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "skill.lint.ok").data).toMatchObject({ ok: true, violations: [], exempt: false });
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
**Task budget (implement / ops rounds)**: S — one focused implementer round
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
    /** Expected exit for the case (default 0); shown in the test title. */
    exit?: number;
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
        expect(cliEnvelope(result, "ok", "skill.lint.ok").data).toMatchObject({ ok: true, violations: [], exempt: false });
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
        expect(lintResults(result)[0]).toMatchObject({ file: join(_dir, "strategy", "STRATEGY.md"), violations: [] });
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
        expect(cliEnvelope(result, "ok", "dispatch.validate.ok").data).toMatchObject({ ok: true, violations: [] });
      },
    },
    {
      name: "compound validate <relative doc> + <relative --knowledge-dir>",
      // compound.index.retired (state-projection contract §4) makes the
      // --knowledge-dir form refuse with exit 1 regardless of path resolution,
      // so this case pins exit 1. The resolution property this matrix guards
      // is still proven: schema OK requires the doc to resolve under the
      // project root, and scope guard OK requires BOTH the doc and the
      // --knowledge-dir to resolve there (a cwd-relative resolution would
      // report compound.scope.outside instead).
      exit: 1,
      args: ["compound", "validate", "knowledge/doc.md", "--knowledge-dir", "knowledge"],
      setup: (dir) => {
        mkdirSync(join(dir, "knowledge"), { recursive: true });
        writeFileSync(join(dir, "knowledge", "doc.md"), KNOWLEDGE_GOOD);
        writeFileSync(join(dir, "knowledge", "README.md"), "# Knowledge\n\n| Document | Source Plan | Description | Status |\n|---|---|---|---|\n| [doc](doc.md) | 20260808-x | x | done |\n");
      },
      assert: (_dir, result) => {
        expect(result.exitCode).toBe(1);
        const envelope = cliEnvelope(result, "refused", "compound.index.retired");
        expect(envelope.details?.violations?.map(({ code }) => code)).toContain("compound.index.retired");
        expect(envelope.details?.violations?.map(({ code }) => code)).not.toContain("compound.scope.outside");
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
        expect(cliEnvelope(result, "ok", "design-md.validate.ok").data).toMatchObject({ ok: true, completeness: { level: "MVP" } });
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
        expect(cliEnvelope(result, "ok", "audit.scaffold.ok").data).toMatchObject({
          outDir: join(dir, "out"),
          files: ["001-fix-n-1-query.md"],
        });
        // --dir "out" resolved against the project root, not the nested cwd.
        expect(existsSync(join(dir, "out", "001-fix-n-1-query.md"))).toBe(true);
        expect(existsSync(join(dir, "out", "README.md"))).toBe(true);
      },
    },
  ];

  for (const c of cases) {
    test(`relative path args resolve against the project root — ${c.name} (exit ${c.exit ?? 0})`, () => {
      withTempDir("mstar-slice4-cli-", (dir) => {
        c.setup(dir);
        const nested = join(dir, "nested", "deep");
        mkdirSync(nested, { recursive: true });
        const result = runCli(c.args, { cwd: nested, env: { MSTAR_CLI_PROJECT_ROOT: dir } });
        c.assert(dir, result);
      });
    });
  }
});
