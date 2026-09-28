import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSddEvidenceFromFile, verifySddEvidence } from "../../cli/src/sdd-evidence.js";
import { getSddCommandDefinitions } from "../src/index.js";
import type { InvocationContext } from "../src/types.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
function invocation(cwd: string, evidence = false): InvocationContext {
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
      ...(evidence ? {
        captureSddEvidence: captureSddEvidenceFromFile,
        verifySddEvidence,
      } : {}),
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

function integrityOk(result: unknown): boolean | null {
  if (result === null || typeof result !== "object" || !("data" in result)) return null;
  const data = result.data;
  if (data === null || typeof data !== "object" || !("integrity" in data)) return null;
  const integrity = data.integrity;
  if (integrity === null || typeof integrity !== "object" || !("ok" in integrity)) return null;
  return typeof integrity.ok === "boolean" ? integrity.ok : null;
}

function evidenceRunId(result: unknown): string | null {
  if (result === null || typeof result !== "object" || !("data" in result)) return null;
  const data = result.data;
  if (data === null || typeof data !== "object" || !("record" in data)) return null;
  const record = data.record;
  return record !== null && typeof record === "object" && "runId" in record && typeof record.runId === "string"
    ? record.runId
    : null;
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

  test("verify rejects stale-versioned records without mutation and accepts valid evidence", async () => {
    const root = tempDir("commands-sdd-evidence-");
    const previousCwd = process.cwd();
    try {
      const contextFile = join(root, "context.json");
      writeFileSync(contextFile, JSON.stringify({ planId: "plan", workingBranch: "feature/old", controlHarnessRoot: root }));
      const contextResult = await command("sdd.check-context").execute({ context: contextFile, kind: "source" }, invocation(root));
      expect(contextResult.status).not.toBe("ok");
      expect(contextResult.exitCode).not.toBe(0);

      const staleSddDir = join(root, ".mstar", "sdd", "stale-plan");
      const staleRun = "0b9e6c1e-7a1b-4c2a-9d3e-1f2a3b4c5d6e";
      const staleRecordPath = join(staleSddDir, "evidence", staleRun, "record.json");
      mkdirSync(join(staleSddDir, "evidence", staleRun), { recursive: true });
      const staleBytes = JSON.stringify({ schema: "mstar.sdd-evidence/v2", runId: staleRun });
      writeFileSync(staleRecordPath, staleBytes);
      const staleRunDir = join(staleSddDir, "evidence", staleRun);
      const staleEntries = readdirSync(staleRunDir).sort();
      const stale = await command("sdd.evidence.verify").execute({
        sddDir: staleSddDir, plan: "stale-plan", task: "task-1", run: staleRun,
      }, invocation(root, true));
      expect(stale.status).toBe("ok");
      expect(integrityOk(stale)).toBe(false);
      expect(readFileSync(staleRecordPath, "utf8")).toBe(staleBytes);
      expect(readdirSync(staleRunDir).sort()).toEqual(staleEntries);

      const fixture = evidenceWorkspace(root);
      process.chdir(fixture.feature);
      const captured = await command("sdd.evidence.capture").execute({
        request: fixture.requestPath,
        argv: [process.execPath, "-e", "process.stdout.write('verified')"],
      }, invocation(fixture.feature, true));
      expect(captured.status).toBe("ok");
      const runId = evidenceRunId(captured);
      expect(runId).not.toBeNull();
      const verified = await command("sdd.evidence.verify").execute({
        sddDir: fixture.sddDir, plan: "plan", task: "task-1", run: runId!,
      }, invocation(fixture.feature, true));
      expect(verified.status).toBe("ok");
      expect(integrityOk(verified)).toBe(true);

      const failedCapture = await command("sdd.evidence.capture").execute({
        request: fixture.requestPath,
        argv: [process.execPath, "-e", "process.exit(3)"],
      }, invocation(fixture.feature, true));
      expect(failedCapture.status).toBe("error");
      expect(failedCapture.exitCode).toBe(3);
      // The failed run still leaves a record; verifying it must NOT read as
      // assessmentPassed even though there is no target (applicability
      // "not-assessed") — the recorded outcome gates the flag.
      const failedDetails = (failedCapture as { details?: { record?: { runId?: string } } }).details;
      const failedRunId = failedDetails?.record !== null && typeof failedDetails?.record === "object"
        ? (failedDetails.record as { runId?: string }).runId
        : undefined;
      expect(failedRunId).toBeString();
      const failedVerify = await command("sdd.evidence.verify").execute({
        sddDir: fixture.sddDir, plan: "plan", task: "task-1", run: failedRunId!,
      }, invocation(fixture.feature, true));
      expect(failedVerify.status).toBe("ok");
      expect((failedVerify.data as { outcome: string }).outcome).toBe("failed");
      expect((failedVerify.data as { assessmentPassed: boolean }).assessmentPassed).toBe(false);
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
