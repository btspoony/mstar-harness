/**
 * ACTIVE plan-coordination contract. Dispositions: migrated — coordinator bind,
 * Prepare configuration/refresh, and progress; retained — ACTIVE/file-route
 * transport refusal and retired verbs; deleted — legacy --session binding,
 * snapshot readbacks/assumptions, report-only snapshot lifecycle, and retired
 * Prepare-amendment live subjects.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { initializeStore, readExecutionAuthority, serializeExecutionValue, type ExecutionIdentity, type StoreContext } from "@mstar-harness/engine";

const CLI_ROOT = resolve(import.meta.dir, "..");
const ENTRY = join(CLI_ROOT, "src/index.ts");
const WORKFLOW = "wf-plan-coordination";
const PLAN = "plan-coordination";
const SESSION = "coord-plan-coordination";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

interface Fixture { root: string; harness: string; context: StoreContext; worktree: string }
interface Result { code: number | null; stdout: string; stderr: string; json: Record<string, any> }
function write(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}
function identity(sessionId = SESSION): ExecutionIdentity {
  return { source: "local", sessionId, workflowId: WORKFLOW, role: "coordinator" };
}
async function fixture(): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plan-coordination-")));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  const harness = join(root, ".mstar");
  mkdirSync(join(harness, "plans"), { recursive: true });
  write(join(harness, "plans", `${PLAN}.md`), `# Plan coordination\n\n**plan_id:** ${PLAN}\n`);
  const context = { harnessDir: harness };
  const store = await initializeStore(context);
  store.close();
  const worktree = join(root, "feature");
  execFileSync("git", ["worktree", "add", "-q", "-b", "feature/plan-coordination", worktree], { cwd: root });
  return { root, harness, context, worktree };
}
function cli(args: string[], f: Fixture, who?: ExecutionIdentity): Result {
  const env: Record<string, string | undefined> = { ...process.env, MSTAR_HARNESS_DIR: f.harness };
  delete env.MSTAR_EXECUTION_IDENTITY;
  if (who) env.MSTAR_EXECUTION_IDENTITY = serializeExecutionValue(who);
  const p = Bun.spawnSync([process.execPath, "run", ENTRY, ...args], { cwd: f.root, env, stdout: "pipe", stderr: "pipe" });
  const stdout = p.stdout.toString();
  let json: Record<string, any> = {};
  try { json = JSON.parse(stdout) as Record<string, any>; } catch {}
  return { code: p.exitCode, stdout, stderr: p.stderr.toString(), json };
}
async function register(f: Fixture): Promise<void> {
  const initial = await readExecutionAuthority(f.context);
  const result = cli(["workflow", "register", "--workflow", WORKFLOW, "--plan-id", PLAN, "--plan-title", "Plan coordination", "--plan-file", `plans/${PLAN}.md`, "--delivery-kind", "development", "--branch-source", "feature/plan-coordination", "--branch-target", "main", "--expect", initial.token, "--operation", "register", "--harness", f.harness], f, identity());
  expect(result.code, result.stdout).toBe(0);
}
async function planToken(f: Fixture): Promise<string> {
  return (await readExecutionAuthority(f.context, { workflowId: WORKFLOW, planId: PLAN })).token;
}
async function bind(f: Fixture, who = identity()): Promise<Result> {
  const state = await readExecutionAuthority(f.context);
  if (!("workflows" in state.data)) throw new Error("workflow authority missing");
  const row = state.data.workflows.find((entry) => entry.state.id === WORKFLOW);
  if (!row) throw new Error("workflow row missing");
  return cli(["plan", "bind", "--execution", "--workflow", WORKFLOW, "--coordinator", "--expect", row.workflowToken, "--operation", `bind-${who.sessionId}`, "--harness", f.harness], f, who);
}
function prepareArgs(f: Fixture, path: string, branch: string, token: string, operation: string): string[] {
  return ["plan", "prepare", "--plan", PLAN, "--worktree-path", path, "--working-branch", branch,
    "--qa-gate", "mandatory", "--findings-cleanup", "allow-residual", "--expect", token,
    "--operation", operation, "--harness", f.harness];
}

describe("mstar plan — ACTIVE coordinator operations", () => {
  test("bind records the creator identity and refuses foreign or missing identity", async () => {
    const f = await fixture();
    await register(f);
    const bound = await bind(f);
    expect(bound.code, bound.stdout).toBe(0);
    const state = await readExecutionAuthority(f.context);
    if (!("workflows" in state.data)) throw new Error("workflow authority missing after bind");
    expect(state.data.workflows.find((entry) => entry.state.id === WORKFLOW)?.coordinator?.sessionId).toBe(SESSION);
    const foreign = await bind(f, identity("foreign-coordinator"));
    expect(foreign.code).toBe(1);
    expect(foreign.json.status).toBe("refused");
    const unbound = cli(["plan", "prepare", "--plan", PLAN, "--worktree-path", f.worktree,
      "--working-branch", "feature/plan-coordination", "--expect", await planToken(f),
      "--operation", "unbound", "--harness", f.harness], f);
    expect(unbound.code).toBe(2);
    expect(unbound.json).toMatchObject({ command: "plan.prepare", status: "usage", code: "command.invalid-input" });
    expect(unbound.json.message).toContain("minted identity");
  });

  test("prepare, source-changed refresh, and progress mutate the ACTIVE plan", async () => {
    const f = await fixture();
    await register(f);
    expect((await bind(f)).code).toBe(0);
    const first = cli(prepareArgs(f, f.worktree, "feature/plan-coordination", await planToken(f), "prepare-1"), f, identity());
    expect(first.code, first.stdout).toBe(0);
    expect(first.json.command).toBe("plan.prepare");
    const changedPath = join(f.root, "feature-changed");
    execFileSync("git", ["worktree", "add", "-q", "-b", "feature/plan-coordination-changed", changedPath], { cwd: f.root });
    const refreshed = cli(prepareArgs(f, changedPath, "feature/plan-coordination-changed", await planToken(f), "prepare-refresh"), f, identity());
    expect(refreshed.code, refreshed.stdout).toBe(0);
    expect(refreshed.json.command).toBe("plan.prepare");
    const progressPath = join(f.root, "progress.json");
    write(progressPath, JSON.stringify({ status: "InProgress", summary: "Coordinator start record", evidence_paths: [] }));
    const progress = cli(["plan", "progress", "--plan", PLAN, "--file", progressPath, "--expect", await planToken(f),
      "--operation", "progress-1", "--harness", f.harness], f, identity());
    expect(progress.code, progress.stdout).toBe(0);
    expect(progress.json.command).toBe("plan.progress");
    const stored = await readExecutionAuthority(f.context, { workflowId: WORKFLOW, planId: PLAN });
    if (!("plan" in stored.data)) throw new Error("the ACTIVE plan read did not return a plan view");
    expect(stored.data.plan.status).toBe("InProgress");
  });

  test("ACTIVE authority refuses legacy transport and retired verbs", async () => {
    const f = await fixture();
    await register(f);
    const legacy = cli(["plan", "bind", "--coordinator", "--workflow", WORKFLOW, "--session-id", "legacy"], f);
    expect(legacy.code).toBe(2);
    expect(legacy.json.status).toBe("usage");
    const retired = cli(["plan", "handoff"], f, identity());
    expect(retired.code).not.toBe(0);
    expect(retired.stdout + retired.stderr).toMatch(/unknown|retired|usage/i);
  });
});
