/**
 * CLI `mstar worktree cleanup` — guarded worktree/branch reclamation
 * (plan 20260912-cleanup-tool-sweep T2) against real throwaway git repos.
 *
 * The pure planner is `planWorktreeCleanup` (engine, T1 — reviewed); this
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
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const lease = (worktreePath: string, workingBranch: string): Record<string, unknown> => ({
  holder: "cleanup-test",
  claimed_at: "2026-09-12",
  worktree_path: worktreePath,
  working_branch: workingBranch,
});

/**
 * Basic fixture: main worktree (harness root) + integration worktree
 * (running iteration wf-1) + Done+merged attached worktree + leased
 * InProgress worktree + Done dirty worktree + Done unmerged detached
 * branch + one foreign worktree/branch nothing records.
 */
function basicFixture(prefix: string): {
  root: string;
  mainBranch: string;
  intWt: string;
  doneWt: string;
  wipWt: string;
  dirtyWt: string;
  foreignWt: string;
} {
  const root = tmpRoot(prefix);
  git(["init", "-q"], root);
  git(["config", "user.email", "cleanup-test@example.com"], root);
  git(["config", "user.name", "Cleanup Test"], root);
  writeFileSync(join(root, "base.txt"), "base\n");
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
        ],
      },
      null,
      2,
    ),
  );
  return { root: canonicalRoot, mainBranch, intWt: intPath, doneWt: donePath, wipWt: wipPath, dirtyWt: dirtyPath, foreignWt: wt(records, "wt-foreign").path };
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

describe("mstar worktree cleanup — dry-run is a byte-for-byte no-op", () => {
  test("prints verdict | kind | ref | reason for every candidate and changes nothing", () => {
    const fx = basicFixture("mstar-cleanup-dry-");
    try {
      const beforeRefs = refInventory(fx.root);
      const beforeWt = git(["worktree", "list", "--porcelain"], fx.root);
      const result = runCli(["worktree", "cleanup", "--workflow", "wf-1", "--harness", fx.root], fx.root);
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
      const result = runCli(["worktree", "cleanup", "--workflow", "wf-2", "--harness", fx.root, "--remote"], fx.root);
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
      expect(applied.stdout).not.toContain("apply: removed worktree");
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

  test("an unreadable known sibling snapshot refuses the probe (fail-closed), exit 1, nothing removed", () => {
    const fx = basicFixture("mstar-cleanup-badsnap-");
    try {
      const badDir = join(fx.root, "workflows", "wf-bad");
      execFileSync("mkdir", ["-p", badDir]);
      writeFileSync(join(badDir, "snapshot.json"), "{ not json");
      const applied = runCli(["worktree", "cleanup", "--workflow", "wf-1", "--harness", fx.root, "--apply"], fx.root);
      expect(applied.exitCode).toBe(1);
      expect(applied.stderr).toContain("worktree cleanup failed");
      expect(applied.stdout).not.toContain("apply: removed worktree");
      expect(git(["worktree", "list", "--porcelain"], fx.root)).toContain(fx.doneWt);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});
