/**
 * CLI `mstar worktree cleanup` — guarded worktree/branch reclamation
 * against real throwaway git repos.
 *
 * The pure planner is `planWorktreeCleanup` (engine); this
 * suite exercises the CLI wrapper only: probing Git/state + all known
 * harness snapshots, dry-run no-op by default, and --apply sequencing
 * (ordinary `git worktree remove` → re-probe → re-plan → `git branch -d`;
 * remote deletion = expected-OID compare-and-delete). Fixtures live under
 * `os.tmpdir()` and are NEVER pointed at this repository.
 *
 * Exit contract: 0 valid dry-run / successful eligible removals; 1
 * probe/mutation failure; 2 usage.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CLI_ROOT = join(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");

/**
 * Fixture git env: commit signing is disabled in-process via
 * GIT_CONFIG_COUNT (never by touching global/user git config).
 */
const GIT_FIXTURE_ENV = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
};

/** Spawn env with ambient harness env vars pinned out (see worktree-cli.test.ts). */
function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR" || key === "MSTAR_WORKING_BRANCH") {
      continue;
    }
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...GIT_FIXTURE_ENV, ...extra };
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Run the real CLI entry as a subprocess; cwd + env overrides per test. */
function runCli(args: string[], cwd: string, extraEnv: Record<string, string> = {}): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd,
    env: cliEnv(extraEnv),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** `verdict | kind | ref | reason` lines only — never headers or notes. */
function decisionRows(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter((line) => /^(keep|remove|refuse) \| /.test(line));
}

/** Evidence diagnostics only: ANSI-stripped `worktree cleanup: note: ` lines on stderr. */
function evidenceNotes(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
    .filter((line) => line.startsWith("worktree cleanup: note: "));
}

/** Actual child argv histogram — the membership cost of one CLI run. */
interface ProbeHistogram {
  ancestry: number;
  resolve: number;
  localMerged: number;
  positive: number;
  negative: number;
}

function membershipHistogram(entries: { cwd: string; argv: string[] }[]): ProbeHistogram {
  const counts: ProbeHistogram = { ancestry: 0, resolve: 0, localMerged: 0, positive: 0, negative: 0 };
  for (const entry of entries) {
    const argv = entry.argv;
    const text = argv.join(" ");
    if (argv[0] === "merge-base" && argv[1] === "--is-ancestor") counts.ancestry++;
    else if (argv[0] === "rev-parse" && argv[1] === "--verify" && argv[2] === "--quiet" && argv[argv.length - 1]?.endsWith("^{commit}")) counts.resolve++;
    else if (argv[0] === "branch" && argv[1] === "--merged") counts.localMerged++;
    else if (argv[0] === "for-each-ref" && text.includes("--merged") && argv[argv.length - 1] === "refs/remotes/origin") counts.positive++;
    else if (argv[0] === "for-each-ref" && text.includes("--no-merged") && argv[argv.length - 1] === "refs/remotes/origin") counts.negative++;
  }
  return counts;
}

function readGitLog(logPath: string): { cwd: string; argv: string[] }[] {
  return readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { cwd: string; argv: string[] });
}

/**
 * Git PATH shim: logs every child argv to a JSONL file outside any worktree,
 * then forwards to the real Git with identical argv/env/stdio. Optional
 * fault modes for fail-closed coverage:
 * - fault "positive"/"negative": reject that membership sweep with exit 128.
 * - vanish: delete a remote-tracking ref right after the inventory read and
 *   before the first membership sweep (race between inventory and evidence).
 * - dropTip: rewrite one branch's OID in the inventory stdout to a
 *   well-formed but absent object (tip the graph cannot answer for).
 */
function installGitShim(home: string, mode: { fault?: "positive" | "negative"; vanish?: string; dropTip?: string } = {}): {
  shimDir: string;
  logPath: string;
  env: Record<string, string>;
} {
  const shimDir = join(home, "git-shim");
  mkdirSync(shimDir, { recursive: true });
  const logPath = join(home, "git-log.jsonl");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(shimDir, "git"),
    `#!${process.execPath}
const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
appendFileSync(process.env.MSTAR_GIT_LOG, JSON.stringify({ cwd: process.cwd(), argv }) + "\\n");
const text = argv.join(" ");
const fault = process.env.MSTAR_GIT_FAULT || "";
if (fault === "positive" && text.includes("--merged") && text.includes("refs/remotes/origin")) process.exit(128);
if (fault === "negative" && text.includes("--no-merged")) process.exit(128);
const isSweep = argv[0] === "for-each-ref" && (text.includes("--merged") || text.includes("--no-merged"));
const vanish = process.env.MSTAR_GIT_VANISH_REF || "";
if (vanish !== "" && isSweep && !existsSync(process.env.MSTAR_GIT_LOG + ".vanished")) {
  const removed = spawnSync(process.env.MSTAR_REAL_GIT, ["update-ref", "-d", "refs/remotes/origin/" + vanish], { cwd: process.cwd() });
  if ((removed.status ?? 1) === 0) writeFileSync(process.env.MSTAR_GIT_LOG + ".vanished", "1");
}
const isInventory = argv[0] === "for-each-ref" && !isSweep && text.includes("refs/remotes/origin");
const dropTip = process.env.MSTAR_GIT_DROP_TIP || "";
if (dropTip !== "" && isInventory) {
  const out = spawnSync(process.env.MSTAR_REAL_GIT, argv, { cwd: process.cwd(), encoding: "utf8" });
  const lines = (out.stdout || "")
    .split("\\n")
    .filter((l) => l.trim() !== "")
    .map((l) => (l.startsWith("origin/" + dropTip + "\\t") ? "origin/" + dropTip + "\\t" + "0".repeat(40) : l));
  process.stdout.write(lines.length > 0 ? lines.join("\\n") + "\\n" : "");
  process.exit(out.status ?? 1);
}
const forwarded = spawnSync(process.env.MSTAR_REAL_GIT, argv, { stdio: "inherit" });
process.exit(forwarded.status ?? 1);
`,
  );
  chmodSync(join(shimDir, "git"), 0o755);
  const env: Record<string, string> = {
    PATH: `${shimDir}:${process.env.PATH ?? ""}`,
    MSTAR_GIT_LOG: logPath,
    MSTAR_REAL_GIT: realGit,
  };
  if (mode.fault !== undefined) env.MSTAR_GIT_FAULT = mode.fault;
  if (mode.vanish !== undefined) env.MSTAR_GIT_VANISH_REF = mode.vanish;
  if (mode.dropTip !== undefined) env.MSTAR_GIT_DROP_TIP = mode.dropTip;
  return { shimDir, logPath, env };
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Full ref inventory (refs + object names) — the byte-for-byte no-op assertion. */
function refInventory(cwd: string): string {
  return git(["for-each-ref", "--format=%(refname)%09%(objectname)"], cwd);
}

/** Parsed `git worktree list --porcelain` records (canonical paths as git spells them). */
interface WtRecord {
  path: string;
  branch: string | null;
  locked: boolean;
}

function worktreeList(cwd: string): WtRecord[] {
  const raw = git(["worktree", "list", "--porcelain"], cwd);
  const records: WtRecord[] = [];
  let current: WtRecord | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line === "") {
      if (current !== null) records.push(current);
      current = null;
    } else if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null, locked: false };
    } else if (line.startsWith("branch ")) {
      if (current !== null) current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line.startsWith("locked")) {
      if (current !== null) current.locked = true;
    }
  }
  if (current !== null) records.push(current);
  return records;
}

function wt(records: WtRecord[], suffix: string): WtRecord {
  const hit = records.find((record) => record.path.endsWith(suffix));
  if (hit === undefined) throw new Error(`fixture worktree ${suffix} not found in ${JSON.stringify(records)}`);
  return hit;
}

/**
 * Shared plan-row shapes (mirror the canonical PlanRow shape used by the
 * other CLI suites: id/title/file/status plus optional metadata/lease).
 */
const row = (id: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `Plan ${id}`,
  file: `plans/${id}.md`,
  status,
  ...extra,
});

function completedHandoff(sourceBranch: string, worktreePath: string): Record<string, unknown> {
  const sha = "a".repeat(40);
  const digest = "c".repeat(64);
  return {
    id: "handoff-cleanup",
    attempt: 1,
    state: "completed",
    submitted_by: "plan-session",
    submitted_at: "2026-09-15T00:00:00Z",
    source_branch: sourceBranch,
    source_sha: sha,
    worktree_path: worktreePath,
    review_base: "b".repeat(40),
    review_head: sha,
    qc: { decision: "Approve", reports: [{ path: "/tmp/qc1.md", sha256: digest }], consolidated: { path: "/tmp/qc.md", sha256: digest } },
    qa: { gate: "mandatory", decision: "pass", report: { path: "/tmp/qa.md", sha256: digest } },
    integration: {
      target_branch: "main",
      worktree_path: "/tmp/integration-wt",
      base_sha: sha,
      started_at: "2026-09-15T01:00:00Z",
      result_sha: sha,
      verified_at: "2026-09-15T01:30:00Z",
    },
    completed_at: "2026-09-15T02:00:00Z",
  };
}

type MutableCleanupSnapshot = Record<string, unknown> & { plans: Array<Record<string, unknown>> };

function updateWorkflow(root: string, id: string, update: (snapshot: MutableCleanupSnapshot) => void): void {
  const snapshotPath = join(root, "workflows", id, "snapshot.json");
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as MutableCleanupSnapshot;
  update(snapshot);
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
}

const lease = (worktreePath: string, workingBranch: string): Record<string, unknown> => ({
  holder: "cleanup-test",
  claimed_at: "2026-09-12",
  worktree_path: worktreePath,
  working_branch: workingBranch,
});

/**
 * Basic fixture: main worktree (harness root) + integration worktree
 * (running iteration wf-1) + Done+merged attached worktree + leased
 * InProgress worktree + Done dirty worktree + Done ignored-only-dirty
 * worktree + Done unmerged detached branch + one foreign worktree/branch
 * nothing records.
 */
function basicFixture(prefix: string): {
  root: string;
  mainBranch: string;
  intWt: string;
  doneWt: string;
  wipWt: string;
  dirtyWt: string;
  ignoredWt: string;
  foreignWt: string;
} {
  const root = tmpRoot(prefix);
  git(["init", "-q"], root);
  git(["config", "user.email", "cleanup-test@example.com"], root);
  git(["config", "user.name", "Cleanup Test"], root);
  writeFileSync(join(root, "base.txt"), "base\n");
  writeFileSync(join(root, ".gitignore"), "secret.env\n");
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "base commit"], root);
  const mainBranch = git(["branch", "--show-current"], root);

  const intWt = join(root, "wt-integration");
  git(["worktree", "add", "-q", intWt, "-b", "iteration/wf-1"], root);

  const doneWt = join(root, "wt-done-a");
  git(["worktree", "add", "-q", doneWt, "-b", "feature/done-a"], root);
  writeFileSync(join(doneWt, "done.txt"), "done-a work\n");
  git(["add", "-A"], doneWt);
  git(["commit", "-q", "-m", "done-a work"], doneWt);
  git(["merge", "-q", "--no-ff", "-m", "merge done-a", "feature/done-a"], intWt);

  const wipWt = join(root, "wt-wip");
  git(["worktree", "add", "-q", wipWt, "-b", "feature/wip"], root);
  writeFileSync(join(wipWt, "wip.txt"), "wip work\n");
  git(["add", "-A"], wipWt);
  git(["commit", "-q", "-m", "wip work"], wipWt);

  const dirtyWt = join(root, "wt-dirty");
  git(["worktree", "add", "-q", dirtyWt, "-b", "feature/dirty"], root);
  writeFileSync(join(dirtyWt, "dirty.txt"), "dirty work\n");
  git(["add", "-A"], dirtyWt);
  git(["commit", "-q", "-m", "dirty work"], dirtyWt);
  writeFileSync(join(dirtyWt, "untracked.txt"), "untracked\n"); // dirty probe

  const ignoredWt = join(root, "wt-ignored");
  git(["worktree", "add", "-q", ignoredWt, "-b", "feature/ignored"], root);
  // The ONLY dirtiness is an ignored file: tracked/untracked state is clean.
  writeFileSync(join(ignoredWt, "secret.env"), "ignored secret\n");
  git(["merge", "-q", "--no-ff", "-m", "merge ignored", "feature/ignored"], intWt);

  // Detached unmerged branch: create via a temporary worktree, then remove
  // the worktree (branch stays, checked out nowhere).
  const tmpWt = join(root, "wt-tmp-unmerged");
  git(["worktree", "add", "-q", tmpWt, "-b", "feature/unmerged"], root);
  writeFileSync(join(tmpWt, "unmerged.txt"), "unmerged work\n");
  git(["add", "-A"], tmpWt);
  git(["commit", "-q", "-m", "unmerged work"], tmpWt);
  git(["worktree", "remove", tmpWt], root);

  const foreignWt = join(root, "wt-foreign");
  git(["worktree", "add", "-q", foreignWt, "-b", "feature/stranger"], root);

  // Canonical paths as git spells them (macOS /var vs /private/var).
  const records = worktreeList(root);
  const canonicalRoot = records[0]!.path; // main worktree is listed first
  const intPath = wt(records, "wt-integration").path;
  const donePath = wt(records, "wt-done-a").path;
  const wipPath = wt(records, "wt-wip").path;
  const dirtyPath = wt(records, "wt-dirty").path;
  const ignoredPath = wt(records, "wt-ignored").path;

  const workflowDir = join(root, "workflows", "wf-1");
  execFileSync("mkdir", ["-p", workflowDir]);
  writeFileSync(
    join(workflowDir, "snapshot.json"),
    JSON.stringify(
      {
        schema_version: 1,
        id: "wf-1",
        type: "iteration",
        status: "running",
        started_at: "2026-09-12",
        updated_at: "2026-09-12",
        branch: { base: mainBranch, integration: "iteration/wf-1", target: mainBranch },
        integration_worktree_path: intPath,
        plans: [
          row("plan-a", "Done", { metadata: { working_branch: "feature/done-a", worktree_path: donePath } }),
          row("plan-b", "InProgress", { execution_lease: lease(wipPath, "feature/wip") }),
          row("plan-c", "Done", { metadata: { working_branch: "feature/dirty", worktree_path: dirtyPath } }),
          row("plan-d", "Done", { metadata: { working_branch: "feature/unmerged" } }),
          row("plan-e", "Done", { metadata: { working_branch: "feature/ignored", worktree_path: ignoredPath } }),
        ],
      },
      null,
      2,
    ),
  );
  return { root: canonicalRoot, mainBranch, intWt: intPath, doneWt: donePath, wipWt: wipPath, dirtyWt: dirtyPath, ignoredWt: ignoredPath, foreignWt: wt(records, "wt-foreign").path };
}

/**
 * Terminal-iteration fixture with a local bare remote (P2 lane): local
 * integration branch merged into the default branch and pushed; no
 * integration worktree anymore. `--remote` may delete origin's copy.
 */
function remoteFixture(prefix: string): { root: string; bare: string; mainBranch: string } {
  const home = tmpRoot(prefix);
  const bare = join(home, "origin.git");
  git(["init", "-q", "--bare", bare], home);
  const root = join(home, "repo");
  git(["clone", "-q", bare, root], home);
  git(["config", "user.email", "cleanup-test@example.com"], root);
  git(["config", "user.name", "Cleanup Test"], root);
  writeFileSync(join(root, "base.txt"), "base\n");
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "base commit"], root);
  const mainBranch = git(["branch", "--show-current"], root);
  git(["push", "-q", "-u", "origin", mainBranch], root);

  const tmpWt = join(root, "wt-iter");
  git(["worktree", "add", "-q", tmpWt, "-b", "iteration/wf-2"], root);
  writeFileSync(join(tmpWt, "iter.txt"), "iteration work\n");
  git(["add", "-A"], tmpWt);
  git(["commit", "-q", "-m", "iteration work"], tmpWt);
  git(["push", "-q", "origin", "iteration/wf-2"], tmpWt);
  git(["merge", "-q", "--no-ff", "-m", "integrate wf-2", "iteration/wf-2"], root);
  git(["push", "-q", "origin", mainBranch], root);
  git(["worktree", "remove", tmpWt], root);
  git(["remote", "set-head", "origin", "-a"], root); // refs/remotes/origin/HEAD symref: a summary, not a branch candidate

  const workflowDir = join(root, "workflows", "wf-2");
  execFileSync("mkdir", ["-p", workflowDir]);
  writeFileSync(
    join(workflowDir, "snapshot.json"),
    JSON.stringify(
      {
        schema_version: 1,
        id: "wf-2",
        type: "iteration",
        status: "completed",
        started_at: "2026-09-11",
        ended_at: "2026-09-12",
        updated_at: "2026-09-12",
        branch: { base: mainBranch, integration: "iteration/wf-2", target: mainBranch },
        plans: [],
      },
      null,
      2,
    ),
  );
  return { root, bare, mainBranch };
}

/**
 * Probe-cost fixture: terminal iteration wf-3 with scoped remote candidates
 * and a controlled base landscape. B=5 distinct base strings (3 dangling;
 * 2 resolving to the SAME commit OID ⇒ V=1), R owned remote candidates
 * (default 4), of which one is owned by a dangling base (fail-closed), one
 * is a genuine non-ancestor, two are ancestors sharing a tip (same-tip case).
 * Unowned origin/<main> exists but needs no evidence row.
 *
 * `candidates` scales the candidate count without changing V (counts must
 * grow with B, never R×B); `extraDangling` adds 5 more dangling base
 * strings (B=10, still V=1) for the same scaling proof.
 */
function probeFixture(
  prefix: string,
  opts: { candidates?: number; extraDangling?: number } = {},
): { root: string; bare: string; mainBranch: string } {
  const candidates = opts.candidates ?? 4;
  const extraDangling = opts.extraDangling ?? 0;
  const home = tmpRoot(prefix);
  const bare = join(home, "origin.git");
  git(["init", "-q", "--bare", bare], home);
  const root = join(home, "repo");
  git(["clone", "-q", bare, root], home);
  git(["config", "user.email", "cleanup-test@example.com"], root);
  git(["config", "user.name", "Cleanup Test"], root);
  writeFileSync(join(root, "base.txt"), "base\n");
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "base commit"], root);
  const mainBranch = git(["branch", "--show-current"], root);
  git(["push", "-q", "-u", "origin", mainBranch], root);

  const tmpWt = join(root, "wt-tmp");
  git(["worktree", "add", "-q", tmpWt, "-b", "integration/wf-3"], root);
  writeFileSync(join(tmpWt, "int.txt"), "integration work\n");
  git(["add", "-A"], tmpWt);
  git(["commit", "-q", "-m", "integration commit"], tmpWt);
  const intTip = git(["rev-parse", "integration/wf-3"], tmpWt);
  git(["push", "-q", "origin", "integration/wf-3"], tmpWt);
  // The unmerged tip grows on a SEPARATE branch so the recorded base anchors
  // ("integration/wf-3") keep resolving to intTip both locally and remotely.
  const lateWt = join(root, "wt-late");
  git(["worktree", "add", "-q", lateWt, "-b", "feature/late", "integration/wf-3"], root);
  writeFileSync(join(lateWt, "late.txt"), "late work\n");
  git(["add", "-A"], lateWt);
  git(["commit", "-q", "-m", "unmerged commit"], lateWt);
  const unmergedTip = git(["rev-parse", "feature/late"], lateWt);
  git(["worktree", "remove", tmpWt], root);
  git(["worktree", "remove", lateWt], root);

  const merged: string[] = ["merged-1", "merged-2"];
  const unmerged: string[] = ["unmerged-1"];
  const danglingOwned: string[] = ["dangling-owner"];
  for (let i = 5; i <= candidates; i++) (i % 2 === 0 ? merged : unmerged).push(`extra-${i}`);
  // merged-1 is plan-a's working branch; merged-2 + extras ride its
  // track_branches (same owner ⇒ same base). unmerged-1 is plan-b's;
  // dangling-owner belongs to wf-gone under a dangling target anchor.
  const extraTracks = ["merged-2", ...merged.slice(2), ...unmerged.slice(1)];
  for (const branch of merged) git(["push", "-q", "origin", `${intTip}:refs/heads/${branch}`], root);
  for (const branch of unmerged) git(["push", "-q", "origin", `${unmergedTip}:refs/heads/${branch}`], root);
  for (const branch of danglingOwned) git(["push", "-q", "origin", `${intTip}:refs/heads/${branch}`], root);
  git(["remote", "set-head", "origin", "-a"], root);

  const writeSnapshot = (id: string, doc: Record<string, unknown>): void => {
    const dir = join(root, "workflows", id);
    execFileSync("mkdir", ["-p", dir]);
    writeFileSync(join(dir, "snapshot.json"), JSON.stringify(doc, null, 2));
  };
  const planRow = (id: string, extra: Record<string, unknown>): Record<string, unknown> => ({
    id,
    title: `Plan ${id}`,
    file: `plans/${id}.md`,
    status: "Done",
    ...extra,
  });
  writeSnapshot("wf-3", {
    schema_version: 1,
    id: "wf-3",
    type: "iteration",
    status: "completed",
    started_at: "2026-09-11",
    ended_at: "2026-09-12",
    updated_at: "2026-09-12",
    // Two DISTINCT base strings resolving to the SAME commit OID: V=1.
    branch: { base: "refs/heads/integration/wf-3", integration: "integration/wf-3", target: "refs/heads/integration/wf-3" },
    plans: [
      planRow("plan-a", { metadata: { working_branch: merged[0], track_branches: extraTracks } }),
      planRow("plan-b", { metadata: { working_branch: "unmerged-1" } }),
    ],
  });
  // Dangling anchors: iteration/old-a + iteration/old-b (+5 more when asked).
  writeSnapshot("wf-old", {
    schema_version: 1,
    id: "wf-old",
    type: "plan",
    status: "completed",
    started_at: "2026-09-10",
    ended_at: "2026-09-10",
    updated_at: "2026-09-10",
    branch: { integration: "iteration/old-a", target: "iteration/old-b" },
    plans: [],
  });
  // Owns `dangling-owner` under a dangling target anchor.
  writeSnapshot("wf-gone", {
    schema_version: 1,
    id: "wf-gone",
    type: "plan",
    status: "completed",
    started_at: "2026-09-10",
    ended_at: "2026-09-10",
    updated_at: "2026-09-10",
    branch: { base: "iteration/old-a", target: "iteration/deleted-base" },
    plans: [planRow("plan-x", { metadata: { working_branch: "dangling-owner" } })],
  });
  if (extraDangling > 0) {
    const danglingDoc = (id: string, integration: string, target: string): Record<string, unknown> => ({
      schema_version: 1,
      id,
      type: "plan",
      status: "completed",
      started_at: "2026-09-10",
      ended_at: "2026-09-10",
      updated_at: "2026-09-10",
      branch: { integration, target },
      plans: [],
    });
    writeSnapshot("wf-old2", danglingDoc("wf-old2", "iteration/old-d", "iteration/old-e"));
    writeSnapshot("wf-old3", danglingDoc("wf-old3", "iteration/old-f", "iteration/old-g"));
    writeSnapshot("wf-old4", danglingDoc("wf-old4", "iteration/old-h", "iteration/old-e"));
  }
  return { root, bare, mainBranch };
}

/**
 * All-dangling fixture: U=3 dangling base strings, R owned remote targets,
 * NO resolvable evidence base at all — local membership and remote sweeps
 * must be skipped entirely (0 membership spawns for unresolved bases).
 */
function danglingFixture(prefix: string, targetCount: number): { root: string; bare: string; mainBranch: string } {
  const home = tmpRoot(prefix);
  const bare = join(home, "origin.git");
  git(["init", "-q", "--bare", bare], home);
  const root = join(home, "repo");
  git(["clone", "-q", bare, root], home);
  git(["config", "user.email", "cleanup-test@example.com"], root);
  git(["config", "user.name", "Cleanup Test"], root);
  writeFileSync(join(root, "base.txt"), "base\n");
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "base commit"], root);
  const mainBranch = git(["branch", "--show-current"], root);
  git(["push", "-q", "-u", "origin", mainBranch], root);
  const tmpWt = join(root, "wt-tmp");
  git(["worktree", "add", "-q", tmpWt, "-b", "integration/wf-d"], root);
  writeFileSync(join(tmpWt, "int.txt"), "work\n");
  git(["add", "-A"], tmpWt);
  git(["commit", "-q", "-m", "integration commit"], tmpWt);
  const intTip = git(["rev-parse", "integration/wf-d"], tmpWt);
  git(["worktree", "remove", tmpWt], root);
  const targets: string[] = [];
  for (let i = 1; i <= targetCount; i++) {
    const name = `owned-${i}`;
    git(["push", "-q", "origin", `${intTip}:refs/heads/${name}`], root);
    targets.push(name);
  }
  git(["remote", "set-head", "origin", "-a"], root);
  const writeSnapshot = (id: string, doc: Record<string, unknown>): void => {
    const dir = join(root, "workflows", id);
    execFileSync("mkdir", ["-p", dir]);
    writeFileSync(join(dir, "snapshot.json"), JSON.stringify(doc, null, 2));
  };
  const planRow = (id: string, extra: Record<string, unknown>): Record<string, unknown> => ({
    id,
    title: `Plan ${id}`,
    file: `plans/${id}.md`,
    status: "Done",
    ...extra,
  });
  writeSnapshot("wf-d", {
    schema_version: 1,
    id: "wf-d",
    type: "plan",
    status: "completed",
    started_at: "2026-09-10",
    ended_at: "2026-09-10",
    updated_at: "2026-09-10",
    branch: { integration: "iteration/gone-a", target: "iteration/gone-b" },
    plans: [planRow("plan-1", { metadata: { track_branches: targets.slice(0, 6) } }), planRow("plan-2", { metadata: { track_branches: targets.slice(6) } })],
  });
  writeSnapshot("wf-d2", {
    schema_version: 1,
    id: "wf-d2",
    type: "plan",
    status: "completed",
    started_at: "2026-09-10",
    ended_at: "2026-09-10",
    updated_at: "2026-09-10",
    branch: { integration: "iteration/gone-c", target: "iteration/gone-b" },
    plans: [],
  });
  return { root, bare, mainBranch };
}

describe("mstar worktree cleanup — bounded evidence probes", () => {
  test("default dry run spawns zero ancestry and zero remote-membership probes", () => {
    const fx = probeFixture("mstar-cleanup-probe-default-");
    const home = dirname(fx.root);
    const shim = installGitShim(home);
    try {
      const result = runCli(["worktree", "cleanup", "--workflow", "wf-3", "--harness", fx.root], fx.root, shim.env);
      expect(result.exitCode).toBe(0);
      const counts = membershipHistogram(readGitLog(shim.logPath));
      expect(counts.ancestry).toBe(0);
      expect(counts.positive).toBe(0);
      expect(counts.negative).toBe(0);
      // Local membership is unconditional (engine contract); V=1 ⇒ exactly one.
      expect(counts.localMerged).toBe(1);
      expect(counts.resolve).toBe(5);
      // Without --remote there are NO remote candidates and no remote rows.
      expect(result.stdout).not.toContain("| remote-branch |");
      // Local integration branch is still judged with unconditional membership.
      expect(result.stdout).toContain("remove | local-branch | integration/wf-3 | cleanup.remove.merged");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--remote batches membership: zero pair spawns, bounded sweeps, owner-base row equivalence", () => {
    const fx = probeFixture("mstar-cleanup-probe-remote-");
    const home = dirname(fx.root);
    const shim = installGitShim(home);
    try {
      // Full-sweep mode: dangling-owner is owned by wf-gone, outside wf-3's
      // default universe — its fail-closed row needs the full sweep.
      const result = runCli(["worktree", "cleanup", "--workflow", "wf-3", "--harness", fx.root, "--remote", "--all-workflows"], fx.root, shim.env);
      expect(result.exitCode).toBe(0);
      const counts = membershipHistogram(readGitLog(shim.logPath));
      expect(counts.ancestry).toBe(0);
      expect(counts.resolve).toBe(5); // B base resolutions, once per distinct string
      expect(counts.localMerged).toBeLessThanOrEqual(1); // ≤V, V=1 (two aliases share one OID)
      expect(counts.positive).toBeLessThanOrEqual(1);
      expect(counts.negative).toBeLessThanOrEqual(1);
      // Owner-base rows only (never the R×B matrix): same verdicts the
      // pre-change probe printed for these stable facts.
      expect(result.stdout).toContain("remove | remote-branch | origin/merged-1 | cleanup.remove.merged");
      expect(result.stdout).toContain("remove | remote-branch | origin/merged-2 | cleanup.remove.merged");
      expect(result.stdout).toContain("refuse | remote-branch | origin/unmerged-1 | cleanup.refuse.unmerged");
      expect(result.stdout).toContain("refuse | remote-branch | origin/dangling-owner | cleanup.refuse.unmerged");
      // Fail-closed: an unresolvable owner base never yields a row.
      expect(result.stdout).not.toContain("remove | remote-branch | origin/dangling-owner");
      // Note bound: 3 base notes + 2 candidate summaries ≤ B+R = 9, with
      // separate indeterminate / not-an-ancestor labels.
      const notes = evidenceNotes(result.stderr);
      expect(notes.length).toBeLessThanOrEqual(5 + 4);
      expect(notes.filter((note) => note.includes("does not resolve")).length).toBe(3);
      expect(notes.some((note) => note.includes("not-an-ancestor"))).toBe(true);
      expect(notes.some((note) => note.includes("indeterminate"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("scaling candidates never multiplies membership spawns by the base count", () => {
    const fx = probeFixture("mstar-cleanup-probe-scale-", { candidates: 24, extraDangling: 1 });
    const home = dirname(fx.root);
    const shim = installGitShim(home);
    try {
      const result = runCli(["worktree", "cleanup", "--workflow", "wf-3", "--harness", fx.root, "--remote"], fx.root, shim.env);
      expect(result.exitCode).toBe(0);
      const counts = membershipHistogram(readGitLog(shim.logPath));
      // B=10 distinct base strings, V=1, R=24: counts grow with B only.
      expect(counts.ancestry).toBe(0);
      expect(counts.resolve).toBe(10);
      expect(counts.localMerged).toBeLessThanOrEqual(1);
      expect(counts.positive).toBeLessThanOrEqual(1);
      expect(counts.negative).toBeLessThanOrEqual(1);
      expect(result.stdout).toContain("remove | remote-branch | origin/extra-6 | cleanup.remove.merged");
      expect(result.stdout).toContain("refuse | remote-branch | origin/extra-5 | cleanup.refuse.unmerged");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);

  test("all-dangling bases: exactly U base notes, +R candidate summaries with --remote, zero membership spawns", () => {
    const fx = danglingFixture("mstar-cleanup-probe-dangling-", 12);
    const home = dirname(fx.root);
    try {
      const plain = installGitShim(home);
      const dry = runCli(["worktree", "cleanup", "--workflow", "wf-d", "--harness", fx.root], fx.root, plain.env);
      expect(dry.exitCode).toBe(0);
      const dryCounts = membershipHistogram(readGitLog(plain.logPath));
      expect(dryCounts.ancestry).toBe(0);
      expect(dryCounts.localMerged).toBe(0);
      expect(dryCounts.positive).toBe(0);
      expect(dryCounts.negative).toBe(0);
      const dryNotes = evidenceNotes(dry.stderr);
      expect(dryNotes).toHaveLength(3); // exactly U base notes, nothing else

      const remote = installGitShim(home);
      const withRemote = runCli(["worktree", "cleanup", "--workflow", "wf-d", "--harness", fx.root, "--remote"], fx.root, remote.env);
      expect(withRemote.exitCode).toBe(0);
      const remoteCounts = membershipHistogram(readGitLog(remote.logPath));
      expect(remoteCounts.ancestry).toBe(0);
      expect(remoteCounts.localMerged).toBe(0); // 0 membership calls for unresolved bases
      expect(remoteCounts.positive).toBe(0);
      expect(remoteCounts.negative).toBe(0);
      const remoteNotes = evidenceNotes(withRemote.stderr);
      expect(remoteNotes).toHaveLength(3 + 12); // U base notes + R candidate summaries
      for (let i = 1; i <= 12; i++) {
        expect(withRemote.stdout).toContain(`refuse | remote-branch | origin/owned-${i} | cleanup.refuse.unmerged`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);

  test("--verbose prints per-pair details with the same decisions and the same Git histogram", () => {
    const fx = probeFixture("mstar-cleanup-probe-verbose-");
    const home = dirname(fx.root);
    const plain = installGitShim(home);
    const verbose = installGitShim(home);
    try {
      const quiet = runCli(["worktree", "cleanup", "--workflow", "wf-3", "--harness", fx.root, "--remote", "--all-workflows"], fx.root, plain.env);
      const loud = runCli(["worktree", "cleanup", "--workflow", "wf-3", "--harness", fx.root, "--remote", "--all-workflows", "--verbose"], fx.root, verbose.env);
      expect(quiet.exitCode).toBe(0);
      expect(loud.exitCode).toBe(0);
      expect(decisionRows(loud.stdout)).toEqual(decisionRows(quiet.stdout));
      expect(membershipHistogram(readGitLog(verbose.logPath))).toEqual(membershipHistogram(readGitLog(plain.logPath)));
      // Per-pair details for the named negative and missing-base pair —
      // presence of diagnostics, not a wording snapshot.
      expect(loud.stderr).toContain("not an ancestor");
      expect(loud.stderr).toContain("dangling-owner");
      expect(evidenceNotes(quiet.stderr).some((note) => note.includes("not an ancestor"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);

  test("fail-closed controls: absent tip, failed positive sweep, failed negative sweep", () => {
    // A tip the graph cannot answer for (absent OID substituted in the
      // inventory row) is indeterminate — never silently negative.
      const dropped = probeFixture("mstar-cleanup-probe-droptip-");
      const dropShim = installGitShim(dirname(dropped.root), { dropTip: "unmerged-1" });
      const dropRun = runCli(["worktree", "cleanup", "--workflow", "wf-3", "--harness", dropped.root, "--remote"], dropped.root, dropShim.env);
      expect(dropRun.exitCode).toBe(0);
      expect(dropRun.stdout).toContain("refuse | remote-branch | origin/unmerged-1 | cleanup.refuse.unmerged");
      expect(dropRun.stdout).not.toContain("remove | remote-branch | origin/unmerged-1");
      rmSync(dirname(dropped.root), { recursive: true, force: true });

      // A failed positive sweep leaves that base's pairs indeterminate —
      // no fabricated negative, no removal rows.
      const positive = probeFixture("mstar-cleanup-probe-faultpos-");
      const positiveShim = installGitShim(dirname(positive.root), { fault: "positive" });
      const positiveRun = runCli(["worktree", "cleanup", "--workflow", "wf-3", "--harness", positive.root, "--remote"], positive.root, positiveShim.env);
      expect(positiveRun.exitCode).toBe(0);
      expect(positiveRun.stdout).toContain("refuse | remote-branch | origin/merged-1 | cleanup.refuse.unmerged");
      expect(positiveRun.stdout).not.toContain("remove | remote-branch | origin/merged-");
      rmSync(dirname(positive.root), { recursive: true, force: true });

      // A failed negative sweep retains positive evidence; only the
      // residual pair becomes indeterminate.
      const negative = probeFixture("mstar-cleanup-probe-faultneg-");
      const negativeShim = installGitShim(dirname(negative.root), { fault: "negative" });
      const negativeRun = runCli(["worktree", "cleanup", "--workflow", "wf-3", "--harness", negative.root, "--remote"], negative.root, negativeShim.env);
      expect(negativeRun.exitCode).toBe(0);
      expect(negativeRun.stdout).toContain("remove | remote-branch | origin/merged-1 | cleanup.remove.merged");
      expect(negativeRun.stderr).toContain("note: remote unmerged-1: indeterminate 1");
      expect(negativeRun.stdout).toContain("refuse | remote-branch | origin/unmerged-1 | cleanup.refuse.unmerged");
      rmSync(dirname(negative.root), { recursive: true, force: true });
  }, 60000);

  test("a remote-tracking ref vanishing between inventory and evidence is indeterminate, not negative", () => {
    const fx = probeFixture("mstar-cleanup-probe-vanish-");
    const home = dirname(fx.root);
    const shim = installGitShim(home, { vanish: "unmerged-1" });
    try {
      const result = runCli(["worktree", "cleanup", "--workflow", "wf-3", "--harness", fx.root, "--remote"], fx.root, shim.env);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("refuse | remote-branch | origin/unmerged-1 | cleanup.refuse.unmerged");
      expect(result.stdout).not.toContain("remove | remote-branch | origin/unmerged-1");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);

  test("same tip OID across candidates: only the branch its own sweep attests is positive", () => {
    // merged-1 and merged-2 share one tip OID. If merged-2's ref vanishes
    // between inventory and the sweeps, only merged-1 is attested by the
    // positive sweep. Evidence must never carry merged-1's attestation over
    // to merged-2 by tip identity: merged-2 stays indeterminate (refuse),
    // never cleanup.remove.merged.
    const fx = probeFixture("mstar-cleanup-probe-sametip-");
    const home = dirname(fx.root);
    const shim = installGitShim(home, { vanish: "merged-2" });
    try {
      const result = runCli(["worktree", "cleanup", "--workflow", "wf-3", "--harness", fx.root, "--remote"], fx.root, shim.env);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("remove | remote-branch | origin/merged-1 | cleanup.remove.merged");
      expect(result.stdout).toContain("refuse | remote-branch | origin/merged-2 | cleanup.refuse.unmerged");
      expect(result.stdout).not.toContain("remove | remote-branch | origin/merged-2");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
});

/**
 * Terminal-iteration fixture for apply ordering: integration worktree still
 * present (branch iteration/wf-9, unmerged into main — squash-merge era) plus
 * a Done plan worktree whose branch is merged ONLY into the integration
 * branch. Both worktrees are remove-eligible (worktree removal is not gated
 * by merged evidence); the plan branch's `git branch -d` evidence base is the
 * integration checkout.
 */
function terminalIntegrationFixture(prefix: string): { root: string; mainBranch: string; intWt: string; doneWt: string } {
  const root = tmpRoot(prefix);
  git(["init", "-q"], root);
  git(["config", "user.email", "cleanup-test@example.com"], root);
  git(["config", "user.name", "Cleanup Test"], root);
  writeFileSync(join(root, "base.txt"), "base\n");
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "base commit"], root);
  const mainBranch = git(["branch", "--show-current"], root);

  const intWt = join(root, "wt-integration");
  git(["worktree", "add", "-q", intWt, "-b", "iteration/wf-9"], root);

  const doneWt = join(root, "wt-done-a");
  git(["worktree", "add", "-q", doneWt, "-b", "feature/done-a"], root);
  writeFileSync(join(doneWt, "done.txt"), "done-a work\n");
  git(["add", "-A"], doneWt);
  git(["commit", "-q", "-m", "done-a work"], doneWt);
  // Merged ONLY into the integration branch — never into main.
  git(["merge", "-q", "--no-ff", "-m", "merge done-a", "feature/done-a"], intWt);

  const records = worktreeList(root);
  const canonicalRoot = records[0]!.path;
  const intPath = wt(records, "wt-integration").path;
  const donePath = wt(records, "wt-done-a").path;

  const workflowDir = join(root, "workflows", "wf-9");
  execFileSync("mkdir", ["-p", workflowDir]);
  writeFileSync(
    join(workflowDir, "snapshot.json"),
    JSON.stringify(
      {
        schema_version: 1,
        id: "wf-9",
        type: "iteration",
        status: "completed",
        started_at: "2026-09-11",
        ended_at: "2026-09-12",
        updated_at: "2026-09-12",
        branch: { base: mainBranch, integration: "iteration/wf-9", target: mainBranch },
        integration_worktree_path: intPath,
        plans: [row("plan-a", "Done", { metadata: { working_branch: "feature/done-a", worktree_path: donePath } })],
      },
      null,
      2,
    ),
  );
  return { root: canonicalRoot, mainBranch, intWt: intPath, doneWt: donePath };
}

describe("mstar worktree cleanup — dry-run is a byte-for-byte no-op", () => {
  test("prints verdict | kind | ref | reason for every candidate and changes nothing", () => {
    const fx = basicFixture("mstar-cleanup-dry-");
    try {
      const beforeRefs = refInventory(fx.root);
      const beforeWt = git(["worktree", "list", "--porcelain"], fx.root);
      // Full-sweep visibility assertions (foreign rows, main keep rows) run
      // in --all-workflows mode; the default universe is workflow-scoped.
      const result = runCli(["worktree", "cleanup", "--workflow", "wf-1", "--harness", fx.root, "--all-workflows"], fx.root);
      expect(result.exitCode).toBe(0);
      // Eligible Done+merged attached worktree removes; its branch refuses checked-out until replan.
      expect(result.stdout).toContain(`remove | worktree | ${fx.doneWt} | cleanup.remove.merged`);
      expect(result.stdout).toContain("refuse | local-branch | feature/done-a | cleanup.refuse.checked-out");
      // Active lease refuses by path and by branch.
      expect(result.stdout).toContain(`refuse | worktree | ${fx.wipWt} | cleanup.refuse.active-lease`);
      expect(result.stdout).toContain("refuse | local-branch | feature/wip | cleanup.refuse.active-lease");
      // Dirty worktree refuses.
      expect(result.stdout).toContain(`refuse | worktree | ${fx.dirtyWt} | cleanup.refuse.dirty-worktree`);
      // Foreign worktree/branch (nothing records them) refuse.
      expect(result.stdout).toContain(`refuse | worktree | ${fx.foreignWt} | cleanup.refuse.foreign-worktree`);
      expect(result.stdout).toContain("refuse | local-branch | feature/stranger | cleanup.refuse.foreign-branch");
      // Unmerged Done branch retains (no squash inference).
      expect(result.stdout).toContain("refuse | local-branch | feature/unmerged | cleanup.refuse.unmerged");
      // Non-terminal integration owner refuses (running iteration wf-1).
      expect(result.stdout).toContain("refuse | local-branch | iteration/wf-1 | cleanup.refuse.non-terminal");
      expect(result.stdout).toContain(`refuse | worktree | ${fx.intWt} | cleanup.refuse.non-terminal`);
      // Default branch + main worktree keep.
      expect(result.stdout).toContain(`keep | worktree | ${fx.root} | cleanup.keep.main-worktree`);
      expect(result.stdout).toContain(`keep | local-branch | ${fx.mainBranch} | cleanup.keep.protected-ref`);
      // Byte-for-byte no-op.
      expect(refInventory(fx.root)).toBe(beforeRefs);
      expect(git(["worktree", "list", "--porcelain"], fx.root)).toBe(beforeWt);
    } finally {
      chmodSync(fx.root, 0o755);
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("--remote adds remote candidates; dry-run still fetches/prunes/writes nothing", () => {
    const fx = remoteFixture("mstar-cleanup-dry-remote-");
    try {
      const beforeRefs = refInventory(fx.root);
      const beforeBare = refInventory(fx.bare);
      const result = runCli(["worktree", "cleanup", "--workflow", "wf-2", "--harness", fx.root, "--remote", "--all-workflows"], fx.root);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("remove | local-branch | iteration/wf-2 | cleanup.remove.merged");
      expect(result.stdout).toContain("remove | remote-branch | origin/iteration/wf-2 | cleanup.remove.merged");
      expect(result.stdout).toContain(`keep | remote-branch | origin/${fx.mainBranch} | cleanup.keep.protected-ref`);
      expect(result.stdout).not.toContain("| remote-branch | origin/HEAD |"); // symref summary never becomes a candidate
      expect(refInventory(fx.root)).toBe(beforeRefs);
      expect(refInventory(fx.bare)).toBe(beforeBare);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
      rmSync(fx.bare, { recursive: true, force: true });
    }
  });
});

describe("mstar worktree cleanup — apply executes exactly the current remove rows", () => {
  test("removes the eligible attached worktree, then its newly unchecked-out branch; retains unmerged/leased/dirty/foreign", () => {
    const fx = basicFixture("mstar-cleanup-apply-");
    try {
      const result = runCli(["worktree", "cleanup", "--workflow", "wf-1", "--harness", fx.root, "--apply"], fx.root);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`apply: removed worktree ${fx.doneWt}`);
      expect(result.stdout).toContain("apply: deleted branch feature/done-a");
      // The eligible worktree and its branch are gone.
      expect(git(["worktree", "list", "--porcelain"], fx.root)).not.toContain(fx.doneWt);
      expect(git(["for-each-ref", "refs/heads/feature/done-a"], fx.root)).toBe("");
      // Everything refused stays byte-identical in place.
      const records = worktreeList(fx.root);
      expect(wt(records, "wt-wip").path).toBe(fx.wipWt);
      expect(wt(records, "wt-dirty").path).toBe(fx.dirtyWt);
      expect(wt(records, "wt-foreign").path).toBe(fx.foreignWt);
      expect(wt(records, "wt-integration").path).toBe(fx.intWt);
      for (const branch of ["feature/wip", "feature/dirty", "feature/unmerged", "feature/stranger", "iteration/wf-1"]) {
        expect(git(["for-each-ref", `refs/heads/${branch}`], fx.root)).not.toBe("");
      }
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("terminal iteration: plan branch merged only into integration IS deleted from the integration checkout, integration worktree removed last", () => {
    // Bugbot HIGH: a single-pass apply removed the integration worktree (the
    // plan branch's `git branch -d` evidence base) before the branch pass, so
    // the deletion fell back to the main worktree where `-d` merges into main
    // HEAD and a squash-merge-era branch refuses. The apply must sequence:
    // other worktrees → re-probe/re-plan → branch -d from the evidence-base
    // checkout → then the deferred integration worktree.
    const fx = terminalIntegrationFixture("mstar-cleanup-terminal-");
    try {
      const applied = runCli(["worktree", "cleanup", "--workflow", "wf-9", "--harness", fx.root, "--apply"], fx.root);
      expect(applied.exitCode).toBe(0);
      // The branch WAS deleted — its deletion cwd was the integration checkout.
      expect(applied.stdout).toContain("apply: deleted branch feature/done-a");
      expect(git(["for-each-ref", "refs/heads/feature/done-a"], fx.root)).toBe("");
      // The integration worktree is removed too — AFTER the branch deletion.
      expect(applied.stdout).toContain(`apply: removed worktree ${fx.intWt}`);
      const branchLine = applied.stdout.indexOf("apply: deleted branch feature/done-a");
      const integrationLine = applied.stdout.indexOf(`apply: removed worktree ${fx.intWt}`);
      expect(integrationLine).toBeGreaterThan(branchLine);
      expect(git(["worktree", "list", "--porcelain"], fx.root)).not.toContain(fx.intWt);
      expect(git(["worktree", "list", "--porcelain"], fx.root)).not.toContain(fx.doneWt);
      // The unmerged integration branch itself retains (no squash inference).
      // At re-plan time the deferred integration worktree is still present, so
      // the branch refuses checked-out (pre-fix it re-planned as unmerged) —
      // the retained end state is identical either way.
      expect(applied.stdout).toContain("refuse | local-branch | iteration/wf-9 | cleanup.refuse.checked-out");
      expect(applied.stdout).toContain("refuse | local-branch | iteration/wf-9 | cleanup.refuse.unmerged");
      expect(git(["for-each-ref", "refs/heads/iteration/wf-9"], fx.root)).not.toBe("");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("terminal iteration merged into target: one apply removes the deferred worktree and its branch", () => {
    const fx = terminalIntegrationFixture("mstar-cleanup-terminal-merged-");
    try {
      git(["merge", "-q", "--no-ff", "-m", "merge integration", "iteration/wf-9"], fx.root);
      // Run inside the removal candidate to also exercise the surviving cwd.
      const applied = runCli(["worktree", "cleanup", "--workflow", "wf-9", "--harness", fx.root, "--apply"], fx.intWt);
      expect(applied.exitCode).toBe(0);
      expect(git(["for-each-ref", "refs/heads/feature/done-a"], fx.root)).toBe("");
      expect(git(["for-each-ref", "refs/heads/iteration/wf-9"], fx.root)).toBe("");
      expect(worktreeList(fx.root)).toHaveLength(1);
      const removed = applied.stdout.indexOf(`apply: removed worktree ${fx.intWt}`);
      expect(removed).toBeGreaterThan(applied.stdout.indexOf("apply: deleted branch feature/done-a"));
      expect(applied.stdout.indexOf("apply: deleted branch iteration/wf-9")).toBeGreaterThan(removed);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("a failed deferred worktree removal retains its merged branch", () => {
    const fx = terminalIntegrationFixture("mstar-cleanup-deferred-failure-");
    const adminDir = join(fx.root, ".git", "worktrees", "wt-integration");
    try {
      git(["merge", "-q", "--no-ff", "-m", "merge integration", "iteration/wf-9"], fx.root);
      chmodSync(adminDir, 0o555);
      const applied = runCli(["worktree", "cleanup", "--workflow", "wf-9", "--harness", fx.root, "--apply"], fx.root);
      expect(applied.exitCode).toBe(1);
      expect(applied.stderr).toContain(`apply: failed worktree ${fx.intWt}`);
      expect(applied.stdout).not.toContain("apply: deleted branch iteration/wf-9");
      expect(git(["for-each-ref", "refs/heads/iteration/wf-9"], fx.root)).not.toBe("");
      expect(git(["worktree", "list", "--porcelain"], fx.root)).toContain(fx.intWt);
    } finally {
      chmodSync(adminDir, 0o755);
    }
  });
  test("a completed Done handoff restores historical branch and worktree ownership", () => {
    const fx = basicFixture("mstar-cleanup-handoff-");
    try {
      updateWorkflow(fx.root, "wf-1", (snapshot) => {
        const plan = snapshot.plans[0];
        delete plan.metadata;
        plan.coordination = {
          revision: 3,
          session: { session_id: "plan-session", session_file: "/tmp/plan-session.json", bound_at: "2026-09-15T00:00:00Z" },
          handoff: completedHandoff("feature/done-a", fx.doneWt),
        };
      });

      const dry = runCli(["worktree", "cleanup", "--workflow", "wf-1", "--harness", fx.root], fx.root);
      if (dry.exitCode !== 0) throw new Error(dry.stderr);
      expect(dry.stdout).toContain(`remove | worktree | ${fx.doneWt} | cleanup.remove.merged`);
      expect(dry.stdout).toContain("refuse | local-branch | feature/done-a | cleanup.refuse.checked-out");
      const applied = runCli(["worktree", "cleanup", "--workflow", "wf-1", "--harness", fx.root, "--apply"], fx.root);
      expect(applied.exitCode).toBe(0);
      expect(applied.stdout).toContain(`apply: removed worktree ${fx.doneWt}`);
      expect(git(["worktree", "list", "--porcelain"], fx.root)).not.toContain(fx.doneWt);
      expect(git(["for-each-ref", "refs/heads/feature/done-a"], fx.root)).toBe("");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("a completed handoff on a non-Done row grants no cleanup ownership", () => {
    const fx = basicFixture("mstar-cleanup-handoff-nondone-");
    try {
      updateWorkflow(fx.root, "wf-1", (snapshot) => {
        const plan = snapshot.plans[0];
        delete plan.metadata;
        plan.status = "InProgress";
        plan.coordination = {
          revision: 3,
          session: { session_id: "plan-session", session_file: "/tmp/plan-session.json", bound_at: "2026-09-15T00:00:00Z" },
          handoff: completedHandoff("feature/done-a", fx.doneWt),
        };
      });
      const result = runCli(
        ["worktree", "cleanup", "--workflow", "wf-1", "--harness", fx.root, "--all-workflows", "--apply"],
        fx.root,
      );
      if (result.exitCode !== 0) throw new Error(result.stderr);
      expect(result.stdout).not.toContain(`apply: removed worktree ${fx.doneWt}`);
      expect(git(["worktree", "list", "--porcelain"], fx.root)).toContain(fx.doneWt);
      expect(git(["for-each-ref", "refs/heads/feature/done-a"], fx.root)).not.toBe("");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("conflicting completed Done handoffs remain ambiguous and refuse removal", () => {
    const fx = basicFixture("mstar-cleanup-handoff-conflict-");
    try {
      updateWorkflow(fx.root, "wf-1", (snapshot) => {
        const plan = snapshot.plans[0];
        delete plan.metadata;
        plan.coordination = {
          revision: 3,
          session: { session_id: "plan-session", session_file: "/tmp/plan-session.json", bound_at: "2026-09-15T00:00:00Z" },
          handoff: completedHandoff("feature/done-a", fx.doneWt),
        };
      });
      const sibling = join(fx.root, "workflows", "wf-other");
      execFileSync("mkdir", ["-p", sibling]);
      writeFileSync(
        join(sibling, "snapshot.json"),
        JSON.stringify({
          schema_version: 1,
          id: "wf-other",
          type: "plan",
          status: "completed",
          started_at: "2026-09-12",
          ended_at: "2026-09-12",
          updated_at: "2026-09-12",
          branch: { source: "feature/done-a", target: fx.mainBranch },
          plans: [row("other-plan", "Done", { coordination: { revision: 3, handoff: completedHandoff("feature/done-a", fx.doneWt) } })],
        }),
      );
      const result = runCli(["worktree", "cleanup", "--workflow", "wf-1", "--harness", fx.root, "--apply"], fx.root);
      if (result.exitCode !== 0) throw new Error(result.stderr);
      expect(result.stdout).toContain(`refuse | worktree | ${fx.doneWt} | cleanup.refuse.foreign-worktree`);
      expect(git(["worktree", "list", "--porcelain"], fx.root)).toContain(fx.doneWt);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
  test("a malformed handoff cannot authorize branch or worktree removal", () => {
    const fx = basicFixture("mstar-cleanup-handoff-malformed-");
    try {
      updateWorkflow(fx.root, "wf-1", (snapshot) => {
        const plan = snapshot.plans[0];
        delete plan.metadata;
        plan.coordination = {
          revision: 3,
          handoff: { state: "completed", source_branch: "feature/done-a", worktree_path: fx.doneWt },
        };
      });
      const result = runCli(["worktree", "cleanup", "--workflow", "wf-1", "--harness", fx.root, "--apply"], fx.root);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toContain(`apply: removed worktree ${fx.doneWt}`);
      expect(git(["worktree", "list", "--porcelain"], fx.root)).toContain(fx.doneWt);
      expect(git(["for-each-ref", "refs/heads/feature/done-a"], fx.root)).not.toBe("");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("a worktree whose only dirtiness is ignored content is removed safely", () => {
    const fx = basicFixture("mstar-cleanup-ignored-");
    try {
      const dry = runCli(["worktree", "cleanup", "--workflow", "wf-1", "--harness", fx.root], fx.root);
      expect(dry.exitCode).toBe(0);
      expect(dry.stdout).toContain(`remove | worktree | ${fx.ignoredWt} | cleanup.remove.merged`);
      expect(dry.stdout).not.toContain(`refuse | worktree | ${fx.ignoredWt} | cleanup.refuse.dirty-worktree`);

      const applied = runCli(["worktree", "cleanup", "--workflow", "wf-1", "--harness", fx.root, "--apply"], fx.root);
      expect(applied.exitCode).toBe(0);
      expect(applied.stdout).toContain(`apply: removed worktree ${fx.ignoredWt}`);
      expect(git(["worktree", "list", "--porcelain"], fx.root)).not.toContain(fx.ignoredWt);
      expect(git(["for-each-ref", "refs/heads/feature/ignored"], fx.root)).toBe("");
      expect(() => readFileSync(join(fx.ignoredWt, "secret.env"), "utf8")).toThrow();
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("--worktree scopes worktree candidates; an explicit assertion attributes a released-lease worktree via its recorded branch", () => {
    const root = tmpRoot("mstar-cleanup-assert-");
    try {
      git(["init", "-q"], root);
      git(["config", "user.email", "cleanup-test@example.com"], root);
      git(["config", "user.name", "Cleanup Test"], root);
      writeFileSync(join(root, "base.txt"), "base\n");
      git(["add", "-A"], root);
      git(["commit", "-q", "-m", "base commit"], root);
      const mainBranch = git(["branch", "--show-current"], root);
      const doneWt = join(root, "wt-done");
      git(["worktree", "add", "-q", doneWt, "-b", "feature/done"], root);
      writeFileSync(join(doneWt, "done.txt"), "work\n");
      git(["add", "-A"], doneWt);
      git(["commit", "-q", "-m", "work"], doneWt);
      git(["merge", "-q", "--no-ff", "-m", "merge", "feature/done"], root);
      const donePath = wt(worktreeList(root), "wt-done").path;
      // Row records ONLY the branch (lease already released, no worktree_path).
      const workflowDir = join(root, "workflows", "wf-1");
      execFileSync("mkdir", ["-p", workflowDir]);
      writeFileSync(
        join(workflowDir, "snapshot.json"),
        JSON.stringify(
          {
            schema_version: 1,
            id: "wf-1",
            type: "plan",
            status: "completed",
            started_at: "2026-09-11",
            ended_at: "2026-09-12",
            updated_at: "2026-09-12",
            branch: { base: mainBranch, target: mainBranch },
            plans: [row("plan-a", "Done", { metadata: { working_branch: "feature/done" } })],
          },
          null,
          2,
        ),
      );

      // Without the assertion the path claims nothing → foreign refusal.
      const foreign = runCli(["worktree", "cleanup", "--workflow", "wf-1", "--harness", root], root);
      expect(foreign.exitCode).toBe(0);
      expect(foreign.stdout).toContain(`refuse | worktree | ${donePath} | cleanup.refuse.foreign-worktree`);
      expect(git(["worktree", "list", "--porcelain"], root)).toContain(donePath);

      // With the verified --worktree assertion (matched to the recorded
      // branch) the worktree is attributed, removed, and its branch follows.
      const applied = runCli(
        ["worktree", "cleanup", "--workflow", "wf-1", "--harness", root, "--apply", "--worktree", donePath],
        root,
      );
      expect(applied.exitCode).toBe(0);
      expect(applied.stdout).toContain(`apply: removed worktree ${donePath}`);
      expect(applied.stdout).toContain("apply: deleted branch feature/done");
      expect(git(["worktree", "list", "--porcelain"], root)).not.toContain(donePath);
      expect(git(["for-each-ref", "refs/heads/feature/done"], root)).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a lease added between planning and mutation refuses the removal (re-probe re-reads snapshots)", () => {
    const fx = basicFixture("mstar-cleanup-lease-change-");
    try {
      const dry = runCli(["worktree", "cleanup", "--workflow", "wf-1", "--harness", fx.root], fx.root);
      expect(dry.stdout).toContain(`remove | worktree | ${fx.doneWt} | cleanup.remove.merged`);

      // Owner re-claims the worktree: the row re-opens (InProgress) and takes
      // an execution lease (a Done row must not carry a lease per the
      // canonical validator — the re-claim re-opens the row).
      const snapshotPath = join(fx.root, "workflows", "wf-1", "snapshot.json");
      const doc = JSON.parse(readFileSync(snapshotPath, "utf8")) as { plans: Array<Record<string, unknown>> };
      doc.plans[0]!.status = "InProgress";
      doc.plans[0]!.execution_lease = lease(fx.doneWt, "feature/done-a");
      writeFileSync(snapshotPath, JSON.stringify(doc, null, 2));

      const applied = runCli(["worktree", "cleanup", "--workflow", "wf-1", "--harness", fx.root, "--apply"], fx.root);
      expect(applied.exitCode).toBe(0); // refusal, not a mutation failure: nothing was attempted
      expect(applied.stdout).toContain(`refuse | worktree | ${fx.doneWt} | cleanup.refuse.active-lease`);
      expect(applied.stdout).not.toContain(`apply: removed worktree ${fx.doneWt}`);
      expect(git(["worktree", "list", "--porcelain"], fx.root)).toContain(fx.doneWt);
      expect(git(["for-each-ref", "refs/heads/feature/done-a"], fx.root)).not.toBe("");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("a failed worktree removal exits 1 and leaves its branch checked-out/refused", () => {
    const fx = basicFixture("mstar-cleanup-failrem-");
    try {
      // Undeletable worktree ADMIN entry (.git/worktrees/<name>): the no-force
      // removal fails while the branch registration survives — git never
      // unregisters the branch, so the re-probe cannot delete it.
      const adminDir = join(fx.root, ".git", "worktrees", "wt-done-a");
      chmodSync(adminDir, 0o555);
      const applied = runCli(["worktree", "cleanup", "--workflow", "wf-1", "--harness", fx.root, "--apply"], fx.root);
      expect(applied.exitCode).toBe(1);
      expect(applied.stderr).toContain(`apply: failed worktree ${fx.doneWt}`);
      // The worktree registration and its branch both survive; the branch was never deleted.
      expect(git(["worktree", "list", "--porcelain"], fx.root)).toContain(fx.doneWt);
      expect(git(["for-each-ref", "refs/heads/feature/done-a"], fx.root)).not.toBe("");
      expect(applied.stdout).not.toContain("apply: deleted branch feature/done-a");
    } finally {
      chmodSync(join(fx.root, ".git", "worktrees", "wt-done-a"), 0o755);
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

describe("mstar worktree cleanup — remote deletion is an expected-OID compare-and-delete", () => {
  test("deletes a merged remote branch with --apply --remote", () => {
    const fx = remoteFixture("mstar-cleanup-remote-ok-");
    try {
      const result = runCli(
        ["worktree", "cleanup", "--workflow", "wf-2", "--harness", fx.root, "--remote", "--apply"],
        fx.root,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("apply: deleted remote origin/iteration/wf-2");
      expect(result.stdout).toContain("apply: deleted branch iteration/wf-2");
      expect(git(["for-each-ref", "refs/heads/iteration/wf-2"], fx.bare)).toBe("");
      expect(git(["for-each-ref", "refs/heads/iteration/wf-2"], fx.root)).toBe("");
      expect(git(["for-each-ref", `refs/heads/${fx.mainBranch}`], fx.bare)).not.toBe("");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
      rmSync(fx.bare, { recursive: true, force: true });
    }
  });

  test("a remote tip moved since the observed OID refuses: facts-changed, exit 1, branch kept, no retry", () => {
    const fx = remoteFixture("mstar-cleanup-remote-moved-");
    try {
      const dry = runCli(["worktree", "cleanup", "--workflow", "wf-2", "--harness", fx.root, "--remote"], fx.root);
      expect(dry.stdout).toContain("remove | remote-branch | origin/iteration/wf-2 | cleanup.remove.merged");

      // The remote moves to a new, unmerged tip AFTER planning — pushed from
      // a SECOND clone, so this repo's remote-tracking ref stays stale at the
      // observed incarnation (cleanup never fetches; worktree refs would be
      // shared and would mask the guard).
      const second = join(dirname(fx.root), "second-clone");
      git(["clone", "-q", fx.bare, second], dirname(fx.root));
      git(["config", "user.email", "cleanup-test@example.com"], second);
      git(["config", "user.name", "Cleanup Test"], second);
      git(["checkout", "-q", "iteration/wf-2"], second);
      writeFileSync(join(second, "late.txt"), "late work\n");
      git(["add", "-A"], second);
      git(["commit", "-q", "-m", "late work"], second);
      git(["push", "-q", "origin", "iteration/wf-2"], second);
      const movedTip = git(["rev-parse", "iteration/wf-2"], second);

      const applied = runCli(
        ["worktree", "cleanup", "--workflow", "wf-2", "--harness", fx.root, "--remote", "--apply"],
        fx.root,
      );
      expect(applied.exitCode).toBe(1);
      expect(applied.stderr).toContain("cleanup.refuse.facts-changed");
      expect(applied.stdout).not.toContain("apply: deleted remote");
      // The remote branch survives at the moved tip; no retry with a newer OID.
      expect(git(["rev-parse", "refs/heads/iteration/wf-2"], fx.bare)).toBe(movedTip);
    } finally {
      rmSync(dirname(fx.root), { recursive: true, force: true }); // home: root + bare + second clone
    }
  });
});

describe("mstar worktree cleanup — exit contract", () => {
  test("missing --workflow is usage, exit 2", () => {
    const result = runCli(["worktree", "cleanup"], tmpRoot("mstar-cleanup-usage-"));
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: worktree cleanup --workflow <id>");
  });

  test("unknown workflow is a probe failure, exit 1", () => {
    const fx = basicFixture("mstar-cleanup-nowf-");
    try {
      const result = runCli(["worktree", "cleanup", "--workflow", "no-such-wf", "--harness", fx.root], fx.root);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worktree cleanup failed");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("an unreadable SELECTED snapshot refuses the probe (fail-closed), exit 1, nothing removed", () => {
    const fx = basicFixture("mstar-cleanup-badsnap-");
    try {
      writeFileSync(join(fx.root, "workflows", "wf-1", "snapshot.json"), "{ not json");
      const applied = runCli(["worktree", "cleanup", "--workflow", "wf-1", "--harness", fx.root, "--apply"], fx.root);
      expect(applied.exitCode).toBe(1);
      expect(applied.stderr).toContain("worktree cleanup failed");
      expect(applied.stdout).not.toContain("apply: removed worktree");
      expect(git(["worktree", "list", "--porcelain"], fx.root)).toContain(fx.doneWt);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("an unparsable UNRELATED sibling no longer aborts the plan, and withholds every removal by default", () => {
    const fx = basicFixture("mstar-cleanup-badsibling-");
    try {
      const badDir = join(fx.root, "workflows", "wf-bad");
      execFileSync("mkdir", ["-p", badDir]);
      const badPath = join(badDir, "snapshot.json");
      writeFileSync(badPath, "{ not json");

      // Full sweep: the foreign-visibility rows need --all-workflows; the
      // unreadable-sibling withholding applies in every mode.
      const dry = runCli(["worktree", "cleanup", "--workflow", "wf-1", "--harness", fx.root, "--all-workflows"], fx.root);
      expect(dry.exitCode).toBe(0);
      expect(dry.stderr).toContain("cannot be parsed");
      expect(dry.stderr).toContain("wf-bad/snapshot.json");
      // The incomplete safety set withholds the eligible row instead of
      // failing the command; unowned candidates keep refusing as before.
      expect(dry.stdout).toContain(`refuse | worktree | ${fx.doneWt} | cleanup.refuse.unreadable-snapshot`);
      expect(dry.stdout).not.toContain("remove | ");
      expect(dry.stdout).toContain(`refuse | worktree | ${fx.foreignWt} | cleanup.refuse.foreign-worktree`);
      expect(dry.stdout).toContain("refuse | local-branch | feature/stranger | cleanup.refuse.foreign-branch");

      const applied = runCli(["worktree", "cleanup", "--workflow", "wf-1", "--harness", fx.root, "--apply"], fx.root);
      expect(applied.exitCode).toBe(0);
      expect(applied.stdout).not.toContain("apply: removed worktree");
      expect(git(["worktree", "list", "--porcelain"], fx.root)).toContain(fx.doneWt);
      // Cleanup never repairs, rewrites or removes the unreadable sibling.
      expect(readFileSync(badPath, "utf8")).toBe("{ not json");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("--ignore-unreadable-snapshots is the operator assertion that restores the removals", () => {
    const fx = basicFixture("mstar-cleanup-badsibling-ignore-");
    try {
      const badDir = join(fx.root, "workflows", "wf-bad");
      execFileSync("mkdir", ["-p", badDir]);
      const badPath = join(badDir, "snapshot.json");
      writeFileSync(badPath, "{ not json");

      const applied = runCli(
        ["worktree", "cleanup", "--workflow", "wf-1", "--harness", fx.root, "--apply", "--ignore-unreadable-snapshots"],
        fx.root,
      );
      expect(applied.exitCode).toBe(0);
      expect(applied.stdout).toContain(`apply: removed worktree ${fx.doneWt}`);
      expect(git(["worktree", "list", "--porcelain"], fx.root)).not.toContain(fx.doneWt);
      // The assertion changes the judgement only: the sibling bytes stay put.
      expect(readFileSync(badPath, "utf8")).toBe("{ not json");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("a schema-invalid sibling is kept in degraded form: its protection survives and the plan still runs", () => {
    const fx = basicFixture("mstar-cleanup-badschema-");
    try {
      const badDir = join(fx.root, "workflows", "wf-bad-schema");
      execFileSync("mkdir", ["-p", badDir]);
      // Parseable JSON, invalid snapshot (type/status/dates/plans missing).
      // The readable handoff still contributes protective ownership, but the
      // degraded row cannot authorize removal regardless of its Done state.
      writeFileSync(
        join(badDir, "snapshot.json"),
        JSON.stringify({
          schema_version: 1,
          id: "wf-bad-schema",
          plans: [row("plan-protective", "Done", { coordination: { handoff: completedHandoff("feature/done-a", fx.doneWt) } })],
        }),
      );

      const dry = runCli(
        ["worktree", "cleanup", "--workflow", "wf-1", "--harness", fx.root, "--all-workflows"],
        fx.root,
      );
      expect(dry.exitCode).toBe(0);
      // feature/done-a is owned, Done and merged (removable by wf-1 alone),
      // but the degraded sibling's retained handoff is converted to protective
      // metadata while its untrusted Done state becomes InProgress.
      expect(dry.stderr).toContain("kept in degraded form");
      expect(dry.stderr).toContain("workflow.snapshot.missing-type");
      expect(dry.stdout).toContain(`refuse | worktree | ${fx.doneWt} | cleanup.refuse.foreign-worktree`);
      // The schema-invalid sibling never aborts the plan: it still prints whole.
      expect(dry.stdout).not.toContain(`remove | worktree | ${fx.doneWt} | cleanup.remove.merged`);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

/**
 * Candidate-scope fixture: two standalone-plan workflows with explicit
 *   `feature/a1-track-1/2/3`, ambiguous track `feature/a1-ambiguous` (also
 *   claimed by B), and an asserted worktree `wt-a1`.
 * - a2 (Done): working branch `feature/a2-work` + worktree `wt-a2` — a
 *   SIBLING row a1's scope must not select.
 * Workflow B (`wf-b`, RUNNING plan) owns `wt-b`/`feature/b-work` under an
 * ACTIVE lease, tracks `feature/b-track` and `feature/a1-ambiguous`, and its
 * base anchor PROTECTS `feature/a1-track-1` — B's safety declarations must
 * refuse/keep in-scope A targets in every mode.
 * `wt-lost` hosts a1's recorded track `feature/a1-track-3` but records NO
 * path (discovery-only candidate); `wt-foreign`/`feature/stranger` are
 * wholly unrecorded.
 */
function scopeFixture(prefix: string): {
  root: string;
  mainBranch: string;
  wtA1: string;
  wtA2: string;
  wtB: string;
  wtLost: string;
  wtForeign: string;
} {
  const root = tmpRoot(prefix);
  git(["init", "-q"], root);
  git(["config", "user.email", "cleanup-test@example.com"], root);
  git(["config", "user.name", "Cleanup Test"], root);
  writeFileSync(join(root, "base.txt"), "base\n");
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "base commit"], root);
  const mainBranch = git(["branch", "--show-current"], root);

  // Retained tracks anchored at the base commit stay ancestors of main (merged).
  for (const branch of ["feature/a1-track-1", "feature/a1-track-2", "feature/a1-ambiguous", "feature/b-track"]) {
    git(["branch", branch, mainBranch], root);
  }

  const addMergedWorktree = (name: string, branch: string): string => {
    const wtPath = join(root, name);
    git(["worktree", "add", "-q", wtPath, "-b", branch], root);
    writeFileSync(join(wtPath, `${name}.txt`), `${name} work\n`);
    git(["add", "-A"], wtPath);
    git(["commit", "-q", "-m", `${name} work`], wtPath);
    git(["merge", "-q", "--no-ff", "-m", `merge ${branch}`, branch], root);
    return wt(worktreeList(root), name).path;
  };
  const wtA1 = addMergedWorktree("wt-a1", "feature/a1-work");
  const wtA2 = addMergedWorktree("wt-a2", "feature/a2-work");
  const wtB = addMergedWorktree("wt-b", "feature/b-work");
  // wt-lost checks out a1's RETAINED TRACK; the worktree path is recorded nowhere.
  git(["branch", "feature/a1-track-3", `${mainBranch}~1`], root);
  const wtLostRaw = join(root, "wt-lost");
  git(["worktree", "add", "-q", wtLostRaw, "feature/a1-track-3"], root);
  writeFileSync(join(wtLostRaw, "lost.txt"), "lost work\n");
  git(["add", "-A"], wtLostRaw);
  git(["commit", "-q", "-m", "lost work"], wtLostRaw);
  git(["merge", "-q", "--no-ff", "-m", "merge a1-track-3", "feature/a1-track-3"], root);
  const wtLost = wt(worktreeList(root), "wt-lost").path;
  const wtForeign = addMergedWorktree("wt-foreign", "feature/stranger");

  const workflows = join(root, "workflows");
  execFileSync("mkdir", ["-p", join(workflows, "wf-a"), join(workflows, "wf-b")]);
  // Canonical main-worktree path as git spells it (macOS /var vs /private/var).
  const canonicalRoot = worktreeList(root)[0]!.path;
  writeFileSync(
    join(workflows, "wf-a", "snapshot.json"),
    JSON.stringify(
      {
        schema_version: 1,
        id: "wf-a",
        type: "plan",
        status: "completed",
        started_at: "2026-09-10",
        ended_at: "2026-09-11",
        updated_at: "2026-09-11",
        branch: { base: mainBranch, target: mainBranch },
        plans: [
          row("plan-a1", "Done", {
            metadata: {
              working_branch: "feature/a1-work",
              track_branches: [
                "feature/a1-work", // duplicate identical claim — must stay one owner
                "feature/a1-track-1",
                "feature/a1-track-2",
                "feature/a1-track-3",
                "feature/a1-ambiguous", // cross-owner: B also records it
              ],
              worktree_path: wtA1,
            },
          }),
          row("plan-a2", "Done", { metadata: { working_branch: "feature/a2-work", worktree_path: wtA2 } }),
        ],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(workflows, "wf-b", "snapshot.json"),
    JSON.stringify(
      {
        schema_version: 1,
        id: "wf-b",
        type: "plan",
        status: "running",
        started_at: "2026-09-12",
        updated_at: "2026-09-12",
        // B's base anchor PROTECTS an in-scope A track (cross-workflow safety).
        branch: { base: "feature/a1-track-1", target: mainBranch },
        plans: [
          row("plan-b1", "InProgress", {
            execution_lease: lease(wtB, "feature/b-work"),
            metadata: { track_branches: ["feature/a1-ambiguous", "feature/b-track"] },
          }),
        ],
      },
      null,
      2,
    ),
  );
  return { root: canonicalRoot, mainBranch, wtA1, wtA2, wtB, wtLost, wtForeign };
}

describe("mstar worktree cleanup — candidate scope", () => {
  test("default dry run lists exactly workflow A's candidates (exact array)", () => {
    const fx = scopeFixture("mstar-cleanup-scope-default-");
    try {
      const result = runCli(["worktree", "cleanup", "--workflow", "wf-a", "--harness", fx.root], fx.root);
      expect(result.exitCode).toBe(0);
      expect(decisionRows(result.stdout)).toEqual([
        `remove | worktree | ${fx.wtA1} | cleanup.remove.merged`,
        `remove | worktree | ${fx.wtA2} | cleanup.remove.merged`,
        // Discovered only via its recorded checked-out branch: visible, unowned, refused.
        `refuse | worktree | ${fx.wtLost} | cleanup.refuse.foreign-worktree`,
        `refuse | local-branch | feature/a1-ambiguous | cleanup.refuse.foreign-branch`,
        // B's base anchor keeps this A track even in A's own scope.
        "keep | local-branch | feature/a1-track-1 | cleanup.keep.protected-ref",
        "remove | local-branch | feature/a1-track-2 | cleanup.remove.merged",
        "refuse | local-branch | feature/a1-track-3 | cleanup.refuse.checked-out",
        "refuse | local-branch | feature/a1-work | cleanup.refuse.checked-out",
        // a2's branch IS an A candidate (its own row); B/unrecorded omitted.
        "refuse | local-branch | feature/a2-work | cleanup.refuse.checked-out",
      ]);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("--all-workflows restores the full sweep with cross-workflow safety intact (exact array)", () => {
    const fx = scopeFixture("mstar-cleanup-scope-all-");
    try {
      const result = runCli(["worktree", "cleanup", "--workflow", "wf-a", "--harness", fx.root, "--all-workflows"], fx.root);
      expect(result.exitCode).toBe(0);
      expect(decisionRows(result.stdout)).toEqual([
        `keep | worktree | ${fx.root} | cleanup.keep.main-worktree`,
        `remove | worktree | ${fx.wtA1} | cleanup.remove.merged`,
        `remove | worktree | ${fx.wtA2} | cleanup.remove.merged`,
        `refuse | worktree | ${fx.wtB} | cleanup.refuse.active-lease`,
        `refuse | worktree | ${fx.wtForeign} | cleanup.refuse.foreign-worktree`,
        `refuse | worktree | ${fx.wtLost} | cleanup.refuse.foreign-worktree`,
        "refuse | local-branch | feature/a1-ambiguous | cleanup.refuse.foreign-branch",
        "keep | local-branch | feature/a1-track-1 | cleanup.keep.protected-ref",
        "remove | local-branch | feature/a1-track-2 | cleanup.remove.merged",
        "refuse | local-branch | feature/a1-track-3 | cleanup.refuse.checked-out",
        "refuse | local-branch | feature/a1-work | cleanup.refuse.checked-out",
        "refuse | local-branch | feature/a2-work | cleanup.refuse.checked-out",
        "refuse | local-branch | feature/b-track | cleanup.refuse.non-terminal",
        "refuse | local-branch | feature/b-work | cleanup.refuse.active-lease",
        "refuse | local-branch | feature/stranger | cleanup.refuse.foreign-branch",
        `keep | local-branch | ${fx.mainBranch} | cleanup.keep.protected-ref`,
      ]);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("--worktree narrows worktrees and selects branches only by exact retained owner", () => {
    const fx = scopeFixture("mstar-cleanup-scope-wt-");
    try {
      const result = runCli(["worktree", "cleanup", "--workflow", "wf-a", "--harness", fx.root, "--worktree", fx.wtA1], fx.root);
      expect(result.exitCode).toBe(0);
      expect(decisionRows(result.stdout)).toEqual([
        `remove | worktree | ${fx.wtA1} | cleanup.remove.merged`,
        // a1's exact claim set: ambiguous (matching claim) stays visible but
        // unowned; a1's retained tracks survive — including the one checked
        // out in the un-asserted wt-lost.
        "refuse | local-branch | feature/a1-ambiguous | cleanup.refuse.foreign-branch",
        "keep | local-branch | feature/a1-track-1 | cleanup.keep.protected-ref",
        "remove | local-branch | feature/a1-track-2 | cleanup.remove.merged",
        "refuse | local-branch | feature/a1-track-3 | cleanup.refuse.checked-out",
        "refuse | local-branch | feature/a1-work | cleanup.refuse.checked-out",
        // NOT selected: sibling row a2 (worktree nor branch), any B row,
        // the unrecorded worktree/branch, the default branch.
      ]);
      expect(result.stdout).not.toContain(`| ${fx.wtA2} |`);
      expect(result.stdout).not.toContain("feature/a2-work");
      expect(result.stdout).not.toContain(fx.wtB);
      expect(result.stdout).not.toContain("feature/b-work");
      expect(result.stdout).not.toContain("feature/b-track");
      expect(result.stdout).not.toContain(fx.wtForeign);
      expect(result.stdout).not.toContain("feature/stranger");
      expect(result.stdout).not.toContain(`keep | worktree | ${fx.root}`);
      expect(result.stdout).not.toContain(`| ${fx.mainBranch} |`);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("repeated --worktree paths behave exactly like one", () => {
    const fx = scopeFixture("mstar-cleanup-scope-repeat-");
    try {
      const single = runCli(["worktree", "cleanup", "--workflow", "wf-a", "--harness", fx.root, "--worktree", fx.wtA1], fx.root);
      const repeated = runCli(
        ["worktree", "cleanup", "--workflow", "wf-a", "--harness", fx.root, "--worktree", fx.wtA1, "--worktree", fx.wtA1],
        fx.root,
      );
      expect(single.exitCode).toBe(0);
      expect(repeated.exitCode).toBe(0);
      expect(decisionRows(repeated.stdout)).toEqual(decisionRows(single.stdout));
      // One diagnostic per distinct path at most — a duplicate adds none.
      expect(evidenceNotes(repeated.stderr)).toEqual(evidenceNotes(single.stderr));
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("--all-workflows --worktree narrows by exact owner, not a workflow override", () => {
    const fx = scopeFixture("mstar-cleanup-scope-allwt-");
    try {
      const result = runCli(
        ["worktree", "cleanup", "--workflow", "wf-a", "--harness", fx.root, "--all-workflows", "--worktree", fx.wtB],
        fx.root,
      );
      expect(result.exitCode).toBe(0);
      expect(decisionRows(result.stdout)).toEqual([
        // The asserted B worktree is inspected under the SAME guards.
        `refuse | worktree | ${fx.wtB} | cleanup.refuse.active-lease`,
        // Exact owner (wf-b, plan-b1): its tracks plus the ambiguous branch
        // that carries a matching claim (still unowned).
        "refuse | local-branch | feature/a1-ambiguous | cleanup.refuse.foreign-branch",
        "refuse | local-branch | feature/b-track | cleanup.refuse.non-terminal",
        "refuse | local-branch | feature/b-work | cleanup.refuse.active-lease",
      ]);
      expect(result.stdout).not.toContain(fx.wtA1);
      expect(result.stdout).not.toContain("feature/a1-track-2");
      expect(result.stdout).not.toContain(fx.wtA2);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("a missing or out-of-universe asserted path emits one diagnostic and fabricates no target", () => {
    const fx = scopeFixture("mstar-cleanup-scope-missing-");
    try {
      const missing = runCli(
        ["worktree", "cleanup", "--workflow", "wf-a", "--harness", fx.root, "--worktree", "/definitely/not/a/worktree"],
        fx.root,
      );
      expect(missing.exitCode).toBe(0);
      expect(decisionRows(missing.stdout)).toEqual([]);
      const missingNotes = evidenceNotes(missing.stderr);
      expect(missingNotes).toHaveLength(1);
      expect(missingNotes[0]).toContain("does not match an inventoried worktree");

      // The B worktree asserted under workflow A is outside A's universe.
      const foreignPath = runCli(["worktree", "cleanup", "--workflow", "wf-a", "--harness", fx.root, "--worktree", fx.wtB], fx.root);
      expect(foreignPath.exitCode).toBe(0);
      expect(decisionRows(foreignPath.stdout)).toEqual([]);
      const foreignNotes = evidenceNotes(foreignPath.stderr);
      expect(foreignNotes).toHaveLength(1);
      expect(foreignNotes[0]).toContain("outside workflow wf-a");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("assertion recovery attributes the path-less recorded worktree; discovery alone only refuses", () => {
    const fx = scopeFixture("mstar-cleanup-scope-recover-");
    try {
      // Default mode discovers wt-lost via its recorded branch — refused unowned.
      const dry = runCli(["worktree", "cleanup", "--workflow", "wf-a", "--harness", fx.root], fx.root);
      expect(dry.stdout).toContain(`refuse | worktree | ${fx.wtLost} | cleanup.refuse.foreign-worktree`);
      expect(dry.stdout).not.toContain(`remove | worktree | ${fx.wtLost}`);

      // The verified assertion attributes it via the recorded checked-out
      // branch — and nothing else becomes owned by that recovery.
      const result = runCli(["worktree", "cleanup", "--workflow", "wf-a", "--harness", fx.root, "--worktree", fx.wtLost], fx.root);
      expect(result.exitCode).toBe(0);
      expect(decisionRows(result.stdout)).toEqual([
        `remove | worktree | ${fx.wtLost} | cleanup.remove.merged`,
        "refuse | local-branch | feature/a1-ambiguous | cleanup.refuse.foreign-branch",
        "keep | local-branch | feature/a1-track-1 | cleanup.keep.protected-ref",
        "remove | local-branch | feature/a1-track-2 | cleanup.remove.merged",
        "refuse | local-branch | feature/a1-track-3 | cleanup.refuse.checked-out",
        "refuse | local-branch | feature/a1-work | cleanup.refuse.checked-out",
      ]);
      expect(result.stdout).not.toContain("feature/a2-work");
      expect(result.stdout).not.toContain("feature/b-track");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("--apply keeps the retained owner set across the removed worktree's re-probe", () => {
    const fx = scopeFixture("mstar-cleanup-scope-apply-");
    try {
      const applied = runCli(
        ["worktree", "cleanup", "--workflow", "wf-a", "--harness", fx.root, "--apply", "--worktree", fx.wtA1],
        fx.root,
      );
      expect(applied.exitCode).toBe(0);
      // Pass 1 removes the asserted worktree; after the re-probe the SAME
      // owner key (wf-a, plan-a1) still selects its working branch and
      // retained merged track — even though the path is gone.
      expect(applied.stdout).toContain(`apply: removed worktree ${fx.wtA1}`);
      expect(applied.stdout).toContain("apply: deleted branch feature/a1-work");
      expect(applied.stdout).toContain("apply: deleted branch feature/a1-track-2");
      expect(git(["worktree", "list", "--porcelain"], fx.root)).not.toContain(fx.wtA1);
      expect(git(["for-each-ref", "refs/heads/feature/a1-work"], fx.root)).toBe("");
      expect(git(["for-each-ref", "refs/heads/feature/a1-track-2"], fx.root)).toBe("");
      // The sibling row a2 is NEVER selected by a1's owner key.
      expect(applied.stdout).not.toContain(`apply: removed worktree ${fx.wtA2}`);
      expect(applied.stdout).not.toContain("apply: deleted branch feature/a2-work");
      expect(git(["worktree", "list", "--porcelain"], fx.root)).toContain(fx.wtA2);
      expect(git(["for-each-ref", "refs/heads/feature/a2-work"], fx.root)).not.toBe("");
      // Protected, ambiguous, checked-out and B-owned branches all survive.
      for (const branch of ["feature/a1-track-1", "feature/a1-track-3", "feature/a1-ambiguous", "feature/b-track", "feature/b-work", "feature/stranger"]) {
        expect(git(["for-each-ref", `refs/heads/${branch}`], fx.root)).not.toBe("");
      }
      expect(git(["worktree", "list", "--porcelain"], fx.root)).toContain(fx.wtLost);
      expect(git(["worktree", "list", "--porcelain"], fx.root)).toContain(fx.wtB);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }, 30000);
  test("--apply keeps an otherwise eligible worktree that contains only ignored files", () => {
    const fx = scopeFixture("mstar-cleanup-ignored-");
    try {
      writeFileSync(join(fx.root, ".git", "info", "exclude"), "ignored-only.txt\n");
      writeFileSync(join(fx.wtA1, "ignored-only.txt"), "must survive\n");

      const applied = runCli(
        ["worktree", "cleanup", "--workflow", "wf-a", "--harness", fx.root, "--apply", "--worktree", fx.wtA1],
        fx.root,
      );
      expect(applied.exitCode).toBe(0);
      expect(applied.stdout).toContain(`refuse | worktree | ${fx.wtA1} | cleanup.refuse.dirty`);
      expect(applied.stdout).not.toContain(`apply: removed worktree ${fx.wtA1}`);
      expect(readFileSync(join(fx.wtA1, "ignored-only.txt"), "utf8")).toBe("must survive\n");
      expect(git(["worktree", "list", "--porcelain"], fx.root)).toContain(fx.wtA1);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

});
