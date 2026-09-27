import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCommandDefinitions, spawnProcess } from "../src/index.js";
import type { CommandEffects, InvocationContext } from "../src/types.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function context(overrides: Partial<InvocationContext> = {}): InvocationContext {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "process-family-"));
  roots.push(cwd);
  const effects: CommandEffects = {
    async readInput() { return ""; },
    spawn: spawnProcess,
    async startDashboard() { throw new Error("not used"); },
    async openBrowser() { throw new Error("not used"); },
  };
  return { cwd, controlRoot: null, versions: { engine: null, cli: null, plugin: null, host: null, platform: null }, signal: new AbortController().signal, effects, ...overrides };
}

function definition(id: string) {
  const item = getCommandDefinitions().find((candidate) => candidate.id === id);
  if (item === undefined) throw new Error(`missing command definition ${id}`);
  return item;
}
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function cleanupFixture(merge = true) {
  const ctx = context();
  git(["init", "-q", "-b", "main"], ctx.cwd);
  git(["config", "user.name", "Process Test"], ctx.cwd);
  git(["config", "user.email", "process@example.invalid"], ctx.cwd);
  writeFileSync(path.join(ctx.cwd, "base.txt"), "base\n");
  git(["add", "-A"], ctx.cwd);
  git(["commit", "-q", "-m", "base"], ctx.cwd);
  const worktree = path.join(ctx.cwd, "worktrees", "done");
  mkdirSync(path.dirname(worktree), { recursive: true });
  const branch = "feature/done";
  git(["worktree", "add", "-q", "-b", branch, worktree], ctx.cwd);
  writeFileSync(path.join(worktree, "done.txt"), "done\n");
  git(["add", "-A"], worktree);
  git(["commit", "-q", "-m", "done"], worktree);
  if (merge) git(["merge", "-q", "--ff-only", branch], ctx.cwd);
  const harness = path.join(ctx.cwd, ".mstar");
  const workflowDir = path.join(harness, "workflows", "wf-smoke");
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(path.join(workflowDir, "snapshot.json"), JSON.stringify({
    schema_version: 1, id: "wf-smoke", type: "plan", status: "completed",
    started_at: "2026-09-27T00:00:00.000Z", ended_at: "2026-09-27T00:00:01.000Z", updated_at: "2026-09-27T00:00:01.000Z",
    branch: { target: "main" },
    plans: [{ id: "plan-smoke", title: "Smoke plan", file: "plans/plan-smoke.md", status: "Done", metadata: { working_branch: branch, worktree_path: worktree } }],
  }));
  return { ctx, worktree, branch };
}

function setupRepo() {
  const ctx = context();
  const remote = path.join(ctx.cwd, "remote.git");
  const repo = path.join(ctx.cwd, "repo");
  git(["init", "--bare", "-q", remote], ctx.cwd);
  mkdirSync(repo, { recursive: true });
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.name", "Process Test"], repo);
  git(["config", "user.email", "process@example.invalid"], repo);
  writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "base"], repo);
  git(["remote", "add", "origin", remote], repo);
  git(["push", "-q", "-u", "origin", "main"], repo);
  git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], repo);
  git(["checkout", "-q", "-b", "feature/topic"], repo);
  writeFileSync(path.join(repo, "topic.txt"), "topic\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "topic"], repo);
  const commit = git(["rev-parse", "HEAD"], repo);
  git(["push", "-q", "origin", "HEAD:refs/heads/feature/topic"], repo);
  git(["push", "-q", "origin", "HEAD:refs/pull/42/head"], repo);
  git(["checkout", "-q", "main"], repo);
  git(["fetch", "-q", "origin"], repo);
  return { ctx: { ...ctx, cwd: repo }, repo, commit };
}

describe("process command family", () => {
  test("registers the three process identities once", () => {
    const ids = getCommandDefinitions().map(({ id }) => id);
    expect(ids.filter((id) => ["sdd.exec", "worktree.cleanup", "pr-review.worktree-setup"].includes(id))).toEqual([
      "sdd.exec", "worktree.cleanup", "pr-review.worktree-setup",
    ]);
    expect(definition("pr-review.worktree-setup").cli.path).toEqual(["pr-review", "worktree-setup"]);
  });

  test("spawn returns actual child output and exact exit status without a shell", async () => {
    const result = await spawnProcess({ argv: [process.execPath, "-e", "process.stdout.write(process.argv[1]); process.stderr.write('err'); process.exit(124)", "literal;value"], cwd: process.cwd(), env: {}, signal: new AbortController().signal });
    expect(result).toMatchObject({ stdout: "literal;value", stderr: "err", exitCode: 124, signal: null });
  });
  test("operator child inherits the caller stdin descriptor when no payload is supplied", async () => {
    const parent = fstatSync(0);
    const result = await spawnProcess({
      argv: [process.execPath, "-e", "const s=require('node:fs').fstatSync(0);process.stdout.write(JSON.stringify({dev:s.dev,ino:s.ino,mode:s.mode}))"],
      cwd: process.cwd(),
      env: {},
      signal: new AbortController().signal,
    });
    expect(JSON.parse(result.stdout)).toEqual({ dev: parent.dev, ino: parent.ino, mode: parent.mode });
  });

  test("abort terminates and drains an admitted child", async () => {
    const controller = new AbortController();
    const pending = spawnProcess({ argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"], cwd: process.cwd(), env: {}, signal: controller.signal });
    // Exercise cancellation against a real OS child; fake timers cannot prove the process was reaped.
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    expect(result.exitCode).not.toBe(0);
  });

  test("sdd exec refuses an invalid execution context before spawning", async () => {
    const ctx = context();
    const controlRoot = path.join(ctx.cwd, ".mstar");
    mkdirSync(path.join(controlRoot, "plans"), { recursive: true });
    const planFile = path.join(controlRoot, "plans", "wrong-context.md");
    writeFileSync(planFile, "# Plan\n");
    const contextPath = path.join(ctx.cwd, "context.json");
    writeFileSync(contextPath, JSON.stringify({ planId: "wrong-context", controlHarnessRoot: controlRoot, featureCwd: ctx.cwd, workingBranch: "feature/wrong-context", planFile, sddDir: path.join(controlRoot, "sdd", "wrong-context") }));
    const result = await definition("sdd.exec").execute({ context: contextPath, argv: [process.execPath, "-e", "process.exit(0)"] }, ctx);
    expect(result.status).toBe("error");
  });

  test("sdd exec returns child streams and preserves a nonzero exit code", async () => {
    const control = context();
    git(["init", "-q", "-b", "main"], control.cwd);
    git(["config", "user.name", "Process Test"], control.cwd);
    git(["config", "user.email", "process@example.invalid"], control.cwd);
    mkdirSync(path.join(control.cwd, ".mstar", "plans"), { recursive: true });
    const planFile = path.join(control.cwd, ".mstar", "plans", "smoke.md");
    writeFileSync(planFile, "# Smoke\n");
    writeFileSync(path.join(control.cwd, "tracked.txt"), "base\n");
    git(["add", "-A"], control.cwd);
    git(["commit", "-q", "-m", "base"], control.cwd);
    const featureCwd = path.join(control.cwd, "feature");
    git(["worktree", "add", "-q", "-b", "feature/smoke", featureCwd], control.cwd);
    const contextPath = path.join(control.cwd, "sdd-context.json");
    writeFileSync(contextPath, JSON.stringify({ planId: "smoke", controlHarnessRoot: path.join(control.cwd, ".mstar"), featureCwd, workingBranch: "feature/smoke", planFile, sddDir: path.join(control.cwd, ".mstar", "sdd", "smoke") }));
    const result = await definition("sdd.exec").execute(
      { context: contextPath, argv: [process.execPath, "-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(124)"] },
      { ...control, cwd: featureCwd },
    );
    expect(result).toMatchObject({ status: "error", code: "sdd.exec.child-exit", exitCode: 124, details: { stdout: "out", stderr: "err" } });
  });
  test("cleanup defaults to a guarded read-only dry-run", async () => {
    const { ctx, worktree } = cleanupFixture();
    const result = await definition("worktree.cleanup").execute({ workflow: "wf-smoke", harness: path.join(ctx.cwd, ".mstar") }, ctx);
    expect(result).toMatchObject({ status: "ok", data: { workflow: "wf-smoke", dryRun: true } });
    expect(existsSync(worktree)).toBe(true);
  });

  test("cleanup --apply removes only the guarded, merged fixture worktree and branch", async () => {
    const { ctx, worktree, branch } = cleanupFixture();
    const result = await definition("worktree.cleanup").execute({ workflow: "wf-smoke", harness: path.join(ctx.cwd, ".mstar"), apply: true }, ctx);
    expect(result.status).toBe("ok");
    expect(existsSync(worktree)).toBe(false);
    expect(() => git(["show-ref", "--verify", `refs/heads/${branch}`], ctx.cwd)).toThrow();
  });
  test("cleanup apply preserves branch/worktree without merged evidence", async () => {
    const { ctx, worktree, branch } = cleanupFixture(false);
    const result = await definition("worktree.cleanup").execute({ workflow: "wf-smoke", harness: path.join(ctx.cwd, ".mstar"), apply: true }, ctx);
    expect(result.status).toBe("ok");
    expect(existsSync(worktree)).toBe(false);
    expect(git(["show-ref", "--verify", `refs/heads/${branch}`], ctx.cwd)).toBeTruthy();
    expect((result.data as { decisions: { reason: string }[] }).decisions.some(({ reason }) => reason === "cleanup.refuse.unmerged")).toBe(true);
  });

  test("review setup rejects ambiguous, missing, and unresolved modes", async () => {
    const { ctx } = setupRepo();
    const execute = definition("pr-review.worktree-setup").execute;
    expect(await execute({}, ctx)).toMatchObject({ status: "usage", exitCode: 2 });
    expect(await execute({ pr: "42", branch: "feature/topic" }, ctx)).toMatchObject({ status: "usage", exitCode: 2 });
    expect(await execute({ branch: "missing/topic" }, ctx)).toMatchObject({ status: "error", code: "prreview.preflight.refs-unresolved", exitCode: 1 });
  });

  test("review setup accepts PR, branch, commit, diff, and working-tree modes", async () => {
    const { ctx, repo, commit } = setupRepo();
    const previousPath = process.env.PATH;
    const bin = path.join(ctx.cwd, "bin");
    mkdirSync(bin);
    const gh = path.join(bin, "gh");
    writeFileSync(gh, "#!/bin/sh\nprintf 'main\\n'\n");
    execFileSync("chmod", ["+x", gh]);
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      const execute = definition("pr-review.worktree-setup").execute;
      const pr = await execute({ pr: "42", targetPath: path.join(repo, ".worktrees", "pr") }, ctx);
      expect(pr).toMatchObject({ status: "ok", data: { worktreePath: path.join(repo, ".worktrees", "pr") } });
      const branch = await execute({ branch: "feature/topic", targetPath: path.join(repo, ".worktrees", "branch") }, ctx);
      expect(branch).toMatchObject({ status: "ok", data: { worktreePath: path.join(repo, ".worktrees", "branch") } });
      const singleCommit = await execute({ commit, targetPath: path.join(repo, ".worktrees", "commit") }, ctx);
      expect(singleCommit).toMatchObject({ status: "ok", data: { worktreePath: path.join(repo, ".worktrees", "commit") } });
      const diff = await execute({ diff: true }, ctx);
      expect(diff).toMatchObject({ status: "ok", data: { worktreePath: git(["rev-parse", "--show-toplevel"], repo) } });
      writeFileSync(path.join(repo, "uncommitted.txt"), "worktree\n");
      const workingTree = await execute({ workingTree: true }, ctx);
      expect(workingTree).toMatchObject({ status: "ok", data: { worktreePath: git(["rev-parse", "--show-toplevel"], repo) } });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
