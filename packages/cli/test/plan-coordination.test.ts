/**
 * ACTIVE plan-coordination coverage. Dispositions: migrated — coordinator bind,
 * Prepare configuration/refresh, progress, issue capture/replay and close guards;
 * retained — ACTIVE/file-route refusal and retired verbs; deleted — legacy
 * --session, snapshot/status readback assumptions, report-only snapshot lifecycle,
 * and retired Prepare-amendment live subjects.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { initializeStore, readExecutionAuthority, serializeExecutionValue, type ExecutionIdentity, type StoreContext } from "@mstar-harness/engine";
const ROOT = resolve(import.meta.dir, "..");
const ENTRY = join(ROOT, "src/index.ts");
const WF = "wf-plan-coordination", PLAN = "plan-coordination", SESSION = "coord-plan-coordination";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
interface Fixture { root: string; harness: string; context: StoreContext; worktree: string }
interface Result { code: number | null; stdout: string; stderr: string; json: Record<string, any> }
function write(path: string, contents: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents); }
function identity(sessionId = SESSION, workflowId = WF): ExecutionIdentity { return { source: "local", sessionId, workflowId, role: "coordinator" }; }
async function fixture(): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plan-coordination-"))); roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  const harness = join(root, ".mstar"); mkdirSync(join(harness, "plans"), { recursive: true });
  write(join(harness, "plans", `${PLAN}.md`), `# Plan coordination\n\n**plan_id:** ${PLAN}\n`);
  const context = { harnessDir: harness }; const store = await initializeStore(context); store.close();
  const worktree = join(root, "feature"); execFileSync("git", ["worktree", "add", "-q", "-b", "feature/plan-coordination", worktree], { cwd: root });
  return { root, harness, context, worktree };
}
function cli(args: string[], f: Fixture, caller?: ExecutionIdentity): Result {
  const env: Record<string, string | undefined> = { ...process.env, MSTAR_HARNESS_DIR: f.harness };
  delete env.MSTAR_EXECUTION_IDENTITY; if (caller) env.MSTAR_EXECUTION_IDENTITY = serializeExecutionValue(caller);
  const proc = Bun.spawnSync([process.execPath, "run", ENTRY, ...args], { cwd: f.root, env, stdout: "pipe", stderr: "pipe" });
  const stdout = proc.stdout.toString(); let json: Record<string, any> = {};
  try { json = JSON.parse(stdout) as Record<string, any>; } catch {}
  return { code: proc.exitCode, stdout, stderr: proc.stderr.toString(), json };
}
async function register(f: Fixture, wf = WF, id = PLAN, title = "Plan coordination", branch = "feature/plan-coordination"): Promise<void> {
  const file = `plans/${id}.md`; write(join(f.harness, file), `# ${title}\n\n**plan_id:** ${id}\n`);
  const before = await readExecutionAuthority(f.context); const session = wf === WF ? SESSION : "peer-coordinator";
  const result = cli(["workflow", "register", "--workflow", wf, "--plan-id", id, "--plan-title", title, "--plan-file", file,
    "--delivery-kind", "development", "--branch-source", branch, "--branch-target", "main", "--expect", before.token,
    "--operation", `register-${wf}`, "--harness", f.harness], f, identity(session, wf));
  expect(result.code, result.stdout).toBe(0);
}
async function token(f: Fixture, wf = WF, id = PLAN): Promise<string> { return (await readExecutionAuthority(f.context, { workflowId: wf, planId: id })).token; }
async function bind(f: Fixture, who = identity()): Promise<Result> {
  const state = await readExecutionAuthority(f.context);
  if (!("workflows" in state.data)) throw new Error("workflow authority missing");
  const row = state.data.workflows.find((item) => item.state.id === who.workflowId);
  if (!row) throw new Error("workflow row missing");
  return cli(["plan", "bind", "--execution", "--workflow", who.workflowId, "--coordinator", "--expect", row.workflowToken,
    "--operation", `bind-${who.sessionId}`, "--harness", f.harness], f, who);
}
function prepareArgs(f: Fixture, id: string, path: string, branch: string, expectToken: string, op: string): string[] {
  return ["plan", "prepare", "--plan", id, "--worktree-path", path, "--working-branch", branch, "--qa-gate", "mandatory",
    "--findings-cleanup", "allow-residual", "--expect", expectToken, "--operation", op, "--harness", f.harness];
}
function issuePayload(key: string): object { return { projectId: "proj-coordination", title: `Finding ${key}`, kind: "bug", severity: "high",
  impact: "acceptance is unmet", acceptance: "finding fixed and verified", sourceIdentity: `coordination/${key}`, rootCauseKey: key,
  acceptanceKey: `${key}-acceptance`, occurrenceKey: `${key}-occurrence`, sourceKind: "qc", location: "packages/cli/src/index.ts",
  observedBehavior: "observed in the CLI", evidence: ["test fixture"], discoveredAt: "2026-10-10T00:00:00Z" }; }
async function addIssue(f: Fixture, wf: string, id: string, key: string): Promise<Result> {
  const path = join(f.root, `${key}.json`); write(path, JSON.stringify([issuePayload(key)]));
  return cli(["plan", "issue-add", "--plan", id, "--file", path, "--expect", await token(f, wf, id), "--operation", `issue-add-${key}`,
    "--harness", f.harness], f, identity(wf === WF ? SESSION : "peer-coordinator", wf));
}
async function issues(f: Fixture): Promise<Record<string, any>[]> {
  const result = cli(["issue", "list", "--harness", f.harness], f); expect(result.code, result.stdout).toBe(0);
  const items = result.json.data?.items; if (!Array.isArray(items)) throw new Error(`no issue items: ${result.stdout}`); return items;
}

describe("mstar plan — ACTIVE coordinator operations", () => {
  test("bind records creator identity and refuses foreign or missing identity", async () => {
    const f = await fixture(); await register(f); const bound = await bind(f); expect(bound.code, bound.stdout).toBe(0);
    const state = await readExecutionAuthority(f.context); if (!("workflows" in state.data)) throw new Error("workflow authority missing");
    expect(state.data.workflows.find((item) => item.state.id === WF)?.coordinator?.sessionId).toBe(SESSION);
    const foreign = await bind(f, identity("foreign-coordinator")); expect(foreign.code).toBe(1); expect(foreign.json.status).toBe("refused");
    const absent = cli(["plan", "prepare", "--plan", PLAN, "--worktree-path", f.worktree, "--working-branch", "feature/plan-coordination",
      "--expect", await readExecutionAuthority(f.context, { workflowId: WF, planId: PLAN }).then((r) => r.token), "--operation", "unbound", "--harness", f.harness], f);
    expect(absent.code).toBe(2); expect(absent.json).toMatchObject({ command: "plan.prepare", status: "usage", code: "command.invalid-input" });
    expect(absent.json.message).toContain("minted identity");
  });
  test("prepare, changed-source refresh, and progress update ACTIVE plan", async () => {
    const f = await fixture(); await register(f); expect((await bind(f)).code).toBe(0);
    const prepared = cli(prepareArgs(f, PLAN, f.worktree, "feature/plan-coordination", await token(f), "prepare-1"), f, identity());
    expect(prepared.code, prepared.stdout).toBe(0);
    const changed = join(f.root, "feature-changed"); execFileSync("git", ["worktree", "add", "-q", "-b", "feature/plan-coordination-changed", changed], { cwd: f.root });
    const refreshed = cli(prepareArgs(f, PLAN, changed, "feature/plan-coordination-changed", await token(f), "prepare-refresh"), f, identity());
    expect(refreshed.code, refreshed.stdout).toBe(0);
    const path = join(f.root, "progress.json"); write(path, JSON.stringify({ status: "InProgress", summary: "Coordinator start", evidence_paths: [] }));
    const progress = cli(["plan", "progress", "--plan", PLAN, "--file", path, "--expect", await token(f), "--operation", "progress-1", "--harness", f.harness], f, identity());
    expect(progress.code, progress.stdout).toBe(0);
    const stored = await readExecutionAuthority(f.context, { workflowId: WF, planId: PLAN });
    if (!("plan" in stored.data)) throw new Error("ACTIVE plan view missing"); expect(stored.data.plan.status).toBe("InProgress");
  });
  test("issue capture and exact replay retain one issue id", async () => {
    const f = await fixture(); await register(f); expect((await bind(f)).code).toBe(0);
    const first = await addIssue(f, WF, PLAN, "capture-replay"); expect(first.code, first.stdout).toBe(0);
    const original = (await issues(f))[0]!; expect(original.title).toBe("Finding capture-replay");
    const replay = await addIssue(f, WF, PLAN, "capture-replay"); expect(replay.code, replay.stdout).toBe(0);
    const after = await issues(f); expect(after).toHaveLength(1); expect(after[0]!.id).toBe(original.id);
    expect(replay.json.data.replayed).toBe(true);
  });
  test("stale issue CAS leaves it open and foreign plan close is refused", async () => {
    const f = await fixture(); await register(f); expect((await bind(f)).code).toBe(0);
    const added = await addIssue(f, WF, PLAN, "close-scope"); expect(added.code, added.stdout).toBe(0); const issue = (await issues(f))[0]!;
    const evidence = join(f.root, "evidence.json"); write(evidence, JSON.stringify({ reason: "verified fix", references: ["packages/cli/src/index.ts"], alignmentRef: "test" }));
    const close = async (id: string, wf: string, revision: number, op: string) => ["plan", "issue-close", "--plan", id, "--issue", String(issue.id),
      "--disposition", "resolved", "--file", evidence, "--expect-issue", String(revision), "--expect", await token(f, wf, id), "--operation", op, "--harness", f.harness];
    const stale = cli(await close(PLAN, WF, Number(issue.revision) + 1, "stale-close"), f, identity());
    expect(stale.code).toBe(1); expect(stale.json.code).toBe("issue.revision-conflict"); expect((await issues(f))[0]!.disposition).toBe("open");
    const peerWorkflow = "wf-plan-coordination-peer", peerPlan = "plan-coordination-peer", peerPath = join(f.root, "peer-feature");
    execFileSync("git", ["worktree", "add", "-q", "-b", "feature/plan-coordination-peer", peerPath], { cwd: f.root });
    await register(f, peerWorkflow, peerPlan, "Peer plan", "feature/plan-coordination-peer");
    const peer = identity("peer-coordinator", peerWorkflow); expect((await bind(f, peer)).code).toBe(0);
    const foreign = cli(await close(peerPlan, peerWorkflow, Number(issue.revision), "foreign-close"), f, peer);
    expect(foreign.code).toBe(1); expect(foreign.json.code).toBe("issue.scope-refused"); expect((await issues(f))[0]!.disposition).toBe("open");
  });
  test("ACTIVE authority refuses legacy transport and retired verbs", async () => {
    const f = await fixture(); await register(f);
    const legacy = cli(["plan", "bind", "--coordinator", "--workflow", WF, "--session-id", "legacy"], f); expect(legacy.code).toBe(2); expect(legacy.json.status).toBe("usage");
    const retired = cli(["plan", "handoff"], f, identity()); expect(retired.code).not.toBe(0); expect(retired.stdout + retired.stderr).toMatch(/unknown|retired|usage/i);
  });
  test("retired workflow verbs are absent from CLI help", () => {
    const result = Bun.spawnSync([process.execPath, "run", ENTRY, "workflow", "--help"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    for (const verb of ["show-prepare", "amend-prepare", "recover-coordinator"]) {
      expect(result.stdout.toString()).not.toContain(verb);
    }
  });
});
