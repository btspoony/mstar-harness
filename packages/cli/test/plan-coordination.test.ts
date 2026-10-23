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
  delete env.MSTAR_EXECUTION_IDENTITY; delete env.DSH_SESSION_ID;
  if (caller) env.MSTAR_EXECUTION_IDENTITY = serializeExecutionValue(caller);
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
// The recovery text is operator copy: its first `mstar …` sentence is taken as
// the invocation, one layer of shell quoting is dropped, and each placeholder
// the caller binds is substituted. An unbound placeholder is a failure, never a
// silently skipped token.
function advertisedInvocation(recovery: string, bindings: ReadonlyArray<readonly [RegExp, string]>): string[] {
  const start = recovery.indexOf("mstar ");
  if (start < 0) throw new Error(`recovery names no mstar invocation: ${recovery}`);
  const from = recovery.slice(start + "mstar ".length);
  const boundary = from.search(/[.;]\s/);
  const clause = (boundary < 0 ? from : from.slice(0, boundary)).trim();
  const argv = clause.split(/\s+/).map((token) => {
    const cleaned = token.replace(/[.;,]+$/, "").replace(/^'|'$/g, "");
    const binding = bindings.find(([pattern]) => pattern.test(cleaned));
    return binding === undefined ? cleaned : binding[1];
  });
  const unbound = argv.filter((token) => /^<.*>$/.test(token));
  if (unbound.length > 0) throw new Error(`recovery advertises unbound placeholder(s) ${unbound.join(", ")}: ${recovery}`);
  // A `--help` argv exits 0 without running the verb: never accept it as a replay.
  if (argv.includes("--help") || argv.includes("-h")) throw new Error(`recovery advertises only the help route: ${recovery}`);
  return argv;
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
    expect(absent.json.message).toContain("verified binding");
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
  test("aggregated refusal names every missing plan issue entry field in one attempt", async () => {
    const f = await fixture(); await register(f); expect((await bind(f)).code).toBe(0);
    const incomplete = [{ title: "missing every other field" }, { title: "also incomplete" }];
    const path = join(f.root, "entries-incomplete.json"); write(path, JSON.stringify(incomplete));
    const missing = ["kind", "severity", "impact", "acceptance", "sourceIdentity", "rootCauseKey", "acceptanceKey",
      "occurrenceKey", "sourceKind", "location", "observedBehavior", "discoveredAt", "evidence"];
    // Both transports answer one payload in ONE refusal: the inline value is the
    // declared array schema's own refusal, the file route the engine's aggregated
    // per-entry problems — neither reveals one field per attempt.
    const inline = cli(["plan", "issue-add", "--plan", PLAN, "--entries", JSON.stringify(incomplete), "--expect", await token(f),
      "--operation", "issue-add-aggregate-inline", "--harness", f.harness], f, identity());
    expect(inline.code, inline.stdout).toBe(2); expect(inline.json.code).toBe("command.invalid-input");
    const paths = ((inline.json.details?.diagnostics ?? []) as Array<{ path?: string }>).map((entry) => entry.path ?? "");
    for (const index of [0, 1]) {
      for (const field of missing) expect(paths).toContain(`entries[${index}].${field}`);
    }
    const fromFile = cli(["plan", "issue-add", "--plan", PLAN, "--file", path, "--expect", await token(f),
      "--operation", "issue-add-aggregate-file", "--harness", f.harness], f, identity());
    expect(fromFile.code, fromFile.stdout).not.toBe(0);
    const problems = (fromFile.json.details?.problems ?? []) as Array<{ path?: string }>;
    expect(problems.map((entry) => entry.path)).toEqual(["entries[0]", "entries[1]"]);
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
  test("progress, issue-add and issue-close recoveries advertise an invocation the decoder accepts", async () => {
    const f = await fixture(); await register(f); expect((await bind(f)).code).toBe(0);
    // The advertised command is the proof, not its prose: each refusal's own
    // `recovery` is executed as-is (one layer of shell quoting removed) against
    // the same fixture and must succeed in that single invocation.
    const replay = (refusal: Result, bindings: ReadonlyArray<readonly [RegExp, string]>): Result => {
      const applied = cli(advertisedInvocation(String(refusal.json.details?.recovery ?? refusal.json.recovery ?? ""), bindings), f, identity());
      expect(applied.code, applied.stdout).toBe(0);
      return applied;
    };
    const progressDoc = { status: "InProgress", summary: "recovery replay", evidence_paths: [] };
    const addressing: ReadonlyArray<readonly [RegExp, string]> = [[/^<workflow-id>$/, WF], [/^<plan-id>$/, PLAN]];
    const progressRefused = cli(["plan", "progress", "--plan", PLAN, "--progress", JSON.stringify(progressDoc),
      "--expect", "stale-token", "--harness", f.harness], f, identity());
    expect(progressRefused.code).toBe(1);
    replay(progressRefused, [...addressing, [/^<json-progress-object>$/, JSON.stringify(progressDoc)]]);

    const entries = JSON.stringify([issuePayload("recovery-replay")]);
    const addRefused = cli(["plan", "issue-add", "--plan", PLAN, "--entries", entries,
      "--expect", "stale-token", "--harness", f.harness], f, identity());
    expect(addRefused.code).toBe(1);
    replay(addRefused, [...addressing, [/^<json-array>$/, entries]]);
    const captured = (await issues(f))[0]!;

    const evidence = join(f.root, "close-evidence.json");
    write(evidence, JSON.stringify({ reason: "verified fix", references: ["packages/commands/src/families/plan.ts"], alignmentRef: "test" }));
    const closeRefused = cli(["plan", "issue-close", "--plan", PLAN, "--issue", String(captured.id), "--disposition", "resolved",
      "--file", evidence, "--expect-issue", String(Number(captured.revision) + 1), "--harness", f.harness], f, identity());
    expect(closeRefused.code).toBe(1);
    replay(closeRefused, [
      ...addressing,
      [/^<issue-id>$/, String(captured.id)],
      [/^<disposition>$/, "resolved"],
      [/^<issue-revision>$/, String(captured.revision)],
      [/^<absolute-evidence\.json>$/, evidence],
    ]);
    const closed = cli(["issue", "list", "--disposition", "resolved", "--harness", f.harness], f);
    expect(closed.json.data?.items?.map((item: { id: string }) => item.id)).toEqual([captured.id]);
  });
});
