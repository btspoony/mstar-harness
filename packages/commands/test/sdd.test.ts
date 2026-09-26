import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSddEvidenceRecord } from "@mstar-harness/engine";
import { getSddCommandDefinitions } from "../src/index.js";
import type { InvocationContext } from "../src/types.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
function invocation(cwd: string): InvocationContext {
  return {
    cwd,
    controlRoot: null,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { return { exitCode: 1, signal: null, stdout: "", stderr: "" }; },
      async startDashboard() { throw new Error("dashboard effect unavailable"); },
      async openBrowser() { throw new Error("browser effect unavailable"); },
    },
  };
}
function command(id: string) {
  const definition = getSddCommandDefinitions().find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`missing command definition ${id}`);
  return definition;
}
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("SDD command family", () => {
  test("registers six identities and excludes sdd exec", () => {
    const definitions = getSddCommandDefinitions();
    expect(definitions.map(({ id }) => id)).toEqual([
      "sdd.workspace", "sdd.task-brief", "sdd.review-package", "sdd.check-context",
      "sdd.evidence.capture", "sdd.evidence.verify",
    ]);
  });

  test("workspace creates the plan SDD directory", async () => {
    const root = tempDir("commands-sdd-workspace-");
    try {
      const result = await command("sdd.workspace").execute({ planId: "sample-plan", controlRoot: root }, invocation(root));
      expect(result.status).toBe("ok");
      const dir = (result as { data: { sddDir: string } }).data.sddDir;
      expect(existsSync(join(dir, ".gitignore"))).toBe(true);
      expect(dir).toContain(join(".mstar", "sdd", "sample-plan"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("task brief preserves missing-task exit 3", async () => {
    const root = tempDir("commands-sdd-brief-");
    try {
      const plan = join(root, "plan.md");
      writeFileSync(plan, "# Plan\n\n## Task 1: Present\nbody\n");
      const result = await command("sdd.task-brief").execute({ planFile: plan, taskNumber: "2", outfile: join(root, "brief.md") }, invocation(root));
      expect(result.status).toBe("refused");
      expect(result.exitCode).toBe(3);
      expect(readFileSync(join(root, "brief.md"), "utf8")).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("review package contains actual commits, stat and unified diff", async () => {
    const root = tempDir("commands-sdd-review-");
    try {
      git(["init", "-q"], root);
      git(["config", "user.email", "sdd-test@example.com"], root);
      git(["config", "user.name", "SDD Test"], root);
      writeFileSync(join(root, "tracked.txt"), "before\n");
      git(["add", "-A"], root);
      git(["commit", "-q", "-m", "base"], root);
      const base = git(["rev-parse", "HEAD"], root);
      writeFileSync(join(root, "tracked.txt"), "after\n");
      git(["add", "-A"], root);
      git(["commit", "-q", "-m", "changed"], root);
      const head = git(["rev-parse", "HEAD"], root);
      const outfile = join(root, "review.diff");
      const result = await command("sdd.review-package").execute({ base, head, outfile }, invocation(root));
      expect(result.status).toBe("ok");
      const contents = readFileSync(outfile, "utf8");
      expect(contents).toContain("## Commits");
      expect(contents).toContain("changed");
      expect(contents).toContain("## Files changed");
      expect(contents).toContain("tracked.txt");
      expect(contents).toContain("## Diff");
      expect(contents).toContain("-before\n+after");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stale SDD context and stale evidence are rejected", async () => {
    const root = tempDir("commands-sdd-stale-");
    try {
      const contextFile = join(root, "context.json");
      writeFileSync(contextFile, JSON.stringify({ planId: "plan", workingBranch: "feature/old", controlHarnessRoot: root }));
      const contextResult = await command("sdd.check-context").execute({ context: contextFile, kind: "source" }, invocation(root));
      expect(contextResult.status).not.toBe("ok");
      expect(contextResult.exitCode).not.toBe(0);

      const evidenceResult = validateSddEvidenceRecord({ schema: "mstar.sdd-evidence/v1", runId: "stale" });
      expect(evidenceResult.ok).toBe(false);
      expect(evidenceResult.violations.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
