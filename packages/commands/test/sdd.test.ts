import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createExecutionWorkflow,
  initializeStore,
  readExecutionState,
  registerCatalogEntity,
  resolveSddExecutionContext,
  SddScriptError,
} from "@mstar-harness/engine";
import { getSddCommandDefinitions } from "../src/index.js";
import { failed } from "../src/families/sdd.js";
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

function evidenceWorkspace(root: string) {
  const primary = join(root, "primary");
  mkdirSync(primary);
  git(["init", "-q"], primary);
  git(["checkout", "-q", "-b", "main"], primary);
  git(["config", "user.email", "sdd-command-test@example.com"], primary);
  git(["config", "user.name", "SDD Command Test"], primary);
  writeFileSync(join(primary, "source.txt"), "source\n");
  git(["add", "."], primary);
  git(["commit", "-q", "-m", "fixture"], primary);
  const control = join(root, "control");
  git(["worktree", "add", "-q", "-b", "control/plan", control], primary);
  const feature = join(root, "feature");
  git(["worktree", "add", "-q", "-b", "feature/plan", feature], primary);
  const harness = join(control, ".mstar");
  const planFile = join(harness, "plans", "plan.md");
  const sddDir = join(harness, "sdd", "plan");
  mkdirSync(join(harness, "plans"), { recursive: true });
  mkdirSync(sddDir, { recursive: true });
  writeFileSync(planFile, "# plan\n");
  const requestPath = join(root, "request.json");
  writeFileSync(requestPath, JSON.stringify({
    context: {
      planId: "plan",
      controlHarnessRoot: harness,
      featureCwd: feature,
      workingBranch: "feature/plan",
      planFile,
      sddDir,
    },
    taskId: "task-1",
    coverage: {
      acIds: ["AC-1"],
      behavior: "record a successful child",
      declaration: "reviewed",
      sourceRationale: "source is declared",
      dependencyRationale: "no external dependency",
      runtimeRationale: "absolute node executable",
      environmentRationale: "selected environment keys",
    },
    inputs: [{ path: "source.txt", kind: "file", purpose: "source" }],
    environmentKeys: ["CI"],
  }));
  return { feature, harness, planFile, sddDir, requestPath };
}

/**
 * The resolver reads workflow facts from the ACTIVE execution authority
 * (issue #428), so a fixture whose contexts must RESOLVE seeds its store:
 * one registered workflow with a Todo row (registered, no feature scope —
 * the resolver's branch-alignment arm).
 */
async function seedResolvedAuthority(harness: string): Promise<void> {
  const context = { harnessDir: harness };
  (await initializeStore(context)).close();
  await registerCatalogEntity(
    context,
    { kind: "plan", id: "plan", title: "plan", rootKind: "plans", relativePath: "plans/plan.md" },
    { operationId: "catalog-plan", actor: "commands-sdd.test" },
  );
  await createExecutionWorkflow(
    { harnessDir: harness, caller: { sessionId: "creator-plan", role: "coordinator", workflowId: "wf-plan" } },
    {
      entry: { id: "wf-plan", type: "plan", started_at: "2026-01-01T00:00:00.000Z", dir: "workflows/wf-plan" },
      snapshot: {
        schema_version: 1,
        id: "wf-plan",
        type: "plan",
        status: "running",
        started_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        delivery_kind: "development",
        plans: [{ id: "plan", title: "plan", file: "plans/plan.md", status: "Todo" }],
      },
      expected: (await readExecutionState(context)).token,
      operationId: "seed-wf-plan",
    },
  );
}

describe("SDD command family", () => {
  test("SDD refusal preserves engine code and verbatim first line", () => {
    const result = failed("sdd.check-context", Object.assign(new Error("engine SDD refusal detail"), { code: "sdd.engine-refused" }));
    expect(result.status).toBe("refused");
    expect(result.code).toBe("sdd.engine-refused");
    expect(result.message.split("\n", 1)[0]).toBe("engine SDD refusal detail");
    expect(result.details).toHaveProperty("helpRoute");
  });

  test("a non-standard SDD refusal exit is preserved through the shared factory", () => {
    const result = failed("sdd.task-brief", new SddScriptError("task 3 not found in the plan document", 3));
    expect(result).toMatchObject({ status: "refused", code: "sdd.task-brief.refused", exitCode: 3 });
    if (result.status === "ok") throw new Error("expected a refusal");
    expect(result.message.split("\n")[0]).toBe("task 3 not found in the plan document");
    expect(result.message).toContain("Help: mstar sdd task-brief --help");
    expect(result.details).toMatchObject({ helpRoute: "mstar sdd task-brief --help" });
  });

  test("the SDD usage exit 2 stays a usage envelope with exit 2", () => {
    const result = failed("sdd.workspace", new SddScriptError("PLAN_ID is required", 2));
    expect(result).toMatchObject({ status: "usage", code: "usage", exitCode: 2 });
    if (result.status !== "usage") throw new Error("expected usage envelope");
    expect(result.message.split("\n")[0]).toBe("PLAN_ID is required");
    expect(result.details).toMatchObject({
      helpRoute: "mstar sdd workspace --help",
      recovery: "Run mstar sdd workspace --help and correct the flagged input. Owning skill: mstar-sdd.",
    });
  });

  test("registers the four remaining identities and excludes sdd exec", () => {
    const definitions = getSddCommandDefinitions();
    expect(definitions.map(({ id }) => id)).toEqual([
      "sdd.workspace", "sdd.task-brief", "sdd.review-package", "sdd.check-context",
    ]);
  });

  test("derived context copy ignores unrelated caller fields", async () => {
    const root = tempDir("commands-sdd-derived-context-");
    const previousCwd = process.cwd();
    try {
      const fixture = evidenceWorkspace(root);
      await seedResolvedAuthority(fixture.harness);
      const contextFile = join(root, "context.json");
      const declared = {
        planId: "plan",
        controlHarnessRoot: fixture.harness,
        featureCwd: fixture.feature,
        workingBranch: "feature/plan",
        planFile: fixture.planFile,
        sddDir: fixture.sddDir,
        untrustedCaller: { sessionId: "not-an-identity" },
      };
      writeFileSync(contextFile, JSON.stringify(declared));
      process.chdir(fixture.feature);
      const derived = await resolveSddExecutionContext(declared as never);
      expect(derived).not.toBe(declared);
      expect(Object.keys(derived).sort()).toEqual([
        "controlHarnessRoot", "featureCwd", "planFile", "planId", "sddDir", "workingBranch",
      ]);
      const result = await command("sdd.check-context").execute(
        { context: contextFile, kind: "source" },
        invocation(fixture.feature),
      );
      expect(result).toMatchObject({ status: "ok", data: { kind: "source", planId: "plan" } });
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
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

  test("task brief preserves missing-task exit 3 and writes nothing", async () => {
    const root = tempDir("commands-sdd-brief-");
    try {
      const plan = join(root, "plan.md");
      const outfile = join(root, "brief.md");
      writeFileSync(plan, "# Plan\n\n## Task 1: Present\nbody\n");
      const result = await command("sdd.task-brief").execute({ planFile: plan, taskNumber: "2", outfile }, invocation(root));
      expect(result.status).toBe("refused");
      expect(result.exitCode).toBe(3);
      expect(result.message).toContain("task 2 not found");
      expect(existsSync(outfile)).toBe(false);
      expect(existsSync(join(root, ".mstar", "sdd"))).toBe(false);
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
});

