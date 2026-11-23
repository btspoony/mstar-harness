/**
 * note: The ADR acceptance matrix as executable evidence — one named case per ADR
 * criterion, delegating to the scenario that owns the proof instead of restating it.
 *
 * A delegated case runs in its own `bun test --test-name-pattern` child and must
 * EXECUTE (not skip, not filter out) with no failure. That is the whole point: a
 * green suite whose required case was renamed, deleted or skipped is not evidence,
 * so a missing owner case fails here by name.
 *
 * Two scenarios had no owner and live in this file: the delete-and-reclone of a
 * local checkout against a retained user-level store (criterion 1), and the
 * cross-authority move refusal boundary (criterion 7 — boundary only, never the
 * staged move the ADR asks for). Criterion 1 also delegates its five identity and
 * cutover owner scenarios, so a renamed or deleted one fails this criterion.
 *
 * Requires the locally built CLI (`bun run cli:build`) because the remote owner
 * suites spawn it, exactly like every other remote CLI suite.
 *
 * Run with `bun test packages/cli/test/collaboration-acceptance.test.ts`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
  captureIssue,
  ensureCollaborationAuthority,
  initializeStore,
  listIssues,
  openStore,
  readCollaborationAuthority,
  type StoreContext,
} from "@mstar-harness/engine";
import { FIXTURE_ISSUE_ID, REMOTE_PROJECT, RemoteCollaborationFixture } from "./support/remote-collaboration-fixture";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

/** note: One owner case: the file that holds it and its exact title. */
type OwnerCase = Readonly<{ file: string; title: string }>;

/** note: Per-criterion owners. Criterion 7 deliberately has none — it is unproven. */
const OWNERS: Readonly<Record<string, readonly OwnerCase[]>> = {
  "1. Local persistence and isolation": [
    { file: "packages/engine/src/collaboration-cutover.test.ts", title: "a replacement clone with no execution DB reads the same authority" },
    { file: "packages/engine/src/collaboration-identity.test.ts", title: "equivalent ssh scp https and default-port origins resolve to one repository" },
    { file: "packages/engine/src/collaboration-identity.test.ts", title: "nondefault port host fork and path case stay isolated" },
    { file: "packages/engine/src/collaboration-identity.test.ts", title: "a linked worktree reads the main checkout config and origin" },
    { file: "packages/engine/src/collaboration-identity.test.ts", title: "an origin-less repository needs an explicit repo id" },
  ],
  "2. Remote sandbox handoff": [
    { file: "packages/cli/test/remote-sandbox-handoff.test.ts", title: "remote handoff: B reconstructs the confirmed change and pushed Git after A is removed" },
    { file: "packages/engine/src/collaboration-store.test.ts", title: "a fresh bind creates the cache lane and a complete observation never touches local authority" },
    { file: "packages/engine/src/issue-sync/push.test.ts", title: "exactly one marker match is adopted, and the next plan is an update" },
    { file: "packages/engine/src/issue-sync/push.test.ts", title: "an unconfirmed create is never planned twice: the residue names both recoveries" },
  ],
  "3. Full round trip and adoption": [
    { file: "packages/cli/test/remote-host-roundtrip.test.ts", title: "the host cycle observes populated history, refuses every non-strict adoption, adopts once and reads it back" },
  ],
  "4. Honest failures and recovery": [
    { file: "packages/engine/src/collaboration-store.test.ts", title: "a changed provider base, a stale binding and a fork surface instead of a send or an overwrite" },
    { file: "packages/engine/src/collaboration-store.test.ts", title: "an absent, older or incomplete outbox never accepts an intent" },
    { file: "packages/engine/src/collaboration-store.test.ts", title: "a composite interrupted after confirmation replays only its execution acknowledgement" },
    { file: "packages/cli/test/remote-host-roundtrip.test.ts", title: "a lost response stays unconfirmed on missing or ambiguous lookup evidence and confirms only on a unique match" },
    { file: "packages/cli/test/remote-host-roundtrip.test.ts", title: "a competing provider effect is surfaced as a conflict, never overwritten" },
  ],
  "5. All read models and gates": [
    { file: "packages/engine/src/store-read.test.ts", title: "project, milestone, roadmap and flow reads use admitted snapshot evidence" },
    { file: "packages/engine/src/store-read.test.ts", title: "a current access check over an old traversal never serves a count, rollup or findings gate" },
    { file: "packages/cli/test/store-read.test.ts", title: "each source observation is stamped at its own snapshot, not at request time" },
    { file: "packages/cli/test/dashboard-server.test.ts", title: "a missing collaboration authority is a 503, never a 404 or an empty list" },
    { file: "packages/omp/test/store-cutover.test.ts", title: "a missing or staged store fails closed: the register write refuses by authority, never by shape" },
  ],
  "6. Migration and rebinding": [
    { file: "packages/engine/src/collaboration-cutover.test.ts", title: "stage copies exact keys, history, foreign keys and revisions without activating" },
    { file: "packages/engine/src/collaboration-cutover.test.ts", title: "a crash after the claim keeps it resumable and the source unfenced" },
    { file: "packages/engine/src/collaboration-cutover.test.ts", title: "a fence that committed before publication is resumed by the same activation" },
    { file: "packages/engine/src/collaboration-cutover.test.ts", title: "extraction leaves execution rows, tokens and the source epoch unchanged" },
    { file: "packages/engine/src/collaboration-cutover.test.ts", title: "a stale binding refuses a clone whose configured mode disagrees" },
    { file: "packages/engine/src/collaboration-cutover.test.ts", title: "two concurrent activations leave exactly one fence and one active authority" },
    { file: "packages/engine/src/collaboration-store.test.ts", title: "a rebind advances only through the reviewed lineage and never downgrades" },
    { file: "packages/engine/src/collaboration-store.test.ts", title: "an interruption at publication leaves the predecessor named and a retry completes" },
  ],
  "8. Provider isolation": [
    { file: "packages/cli/test/remote-provider-isolation.test.ts", title: "the bootstrap loop and one confirmed outbox effect run with zero provider attempts" },
    { file: "packages/cli/test/remote-provider-isolation.test.ts", title: "changed remote modules reach no provider client, credential lookup or outbound transport" },
  ],
};

const scratchRoots: string[] = [];

afterAll(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function escapeTitle(title: string): string {
  return title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** note: One test case as the JUnit report recorded it. */
type ReportedCase = Readonly<{ name: string; skipped: boolean; failed: boolean }>;

/**
 * note: Run one named case in its own `bun test` child and report what the JUnit
 * file says actually executed. A missing case exits non-zero and reports nothing;
 * `executed` is the only evidence a required case ran.
 */
function runOwnerCase(owner: OwnerCase): { executed: string[]; failures: string[]; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "mstar-acceptance-"));
  scratchRoots.push(dir);
  const reportPath = join(dir, "junit.xml");
  const child = Bun.spawnSync(
    [
      process.execPath, "test", owner.file,
      "-t", escapeTitle(owner.title),
      "--reporter=junit", `--reporter-outfile=${reportPath}`,
    ],
    { cwd: REPO_ROOT, env: { ...process.env }, stdout: "pipe", stderr: "pipe", timeout: 240_000 },
  );
  const stderr = child.stderr.toString();
  // note: A child killed on this run's own deadline proves nothing about the case.
  if (child.exitCode === null) throw new Error(`${owner.file} :: "${owner.title}" did not finish within 240s\n${stderr}`);
  // invariant: The child's own verdict is part of the evidence — a non-zero exit is a failure
  // even when the JUnit file reports the named testcase as passing (a suite-level error, or a
  // second failure outside this run's filter, exits non-zero).
  if (child.exitCode !== 0) {
    throw new Error(`${owner.file} :: "${owner.title}" exited ${String(child.exitCode)}\n${stderr}`);
  }
  let xml = "";
  try {
    xml = readFileSync(reportPath, "utf8");
  } catch {
    // note: No report at all means no case ran; the empty `executed` list fails by name below.
  }
  const cases: ReportedCase[] = xml
    .split("<testcase ")
    .slice(1)
    .map((chunk) => {
      const name = /name="([^"]*)"/.exec(chunk)?.[1] ?? "";
      const body = chunk.split("</testcase>")[0] ?? chunk;
      return { name: decodeEntities(name), skipped: body.includes("<skipped"), failed: body.includes("<failure") };
    });
  return {
    executed: cases.filter((entry) => !entry.skipped && !entry.failed).map((entry) => entry.name),
    failures: cases.filter((entry) => entry.failed).map((entry) => entry.name),
    stderr,
  };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&");
}

/** note: One criterion's evidence: every owner case executed exactly once, and nothing failed. */
function expectOwners(criterion: string): void {
  for (const owner of OWNERS[criterion]!) {
    const evidence = runOwnerCase(owner);
    // invariant: A renamed, deleted or skipped owner case fails HERE by name, so a green
    // suite can never stand in for a criterion whose proof is missing.
    if (evidence.executed.length === 1 && evidence.executed[0] === owner.title && evidence.failures.length === 0) continue;
    throw new Error(
      `${owner.file} :: "${owner.title}" did not execute — executed ${JSON.stringify(evidence.executed)}, ` +
        `failures ${JSON.stringify(evidence.failures)}\n${evidence.stderr.trim()}`,
    );
  }
}

describe("collaboration authority — ADR acceptance", () => {
  test("criterion 1 — a local checkout deleted and recloned reads its seeded records with the retained user store and no execution state", async () => {
    // note: The identity/cutover owners first, so a renamed or deleted one fails this criterion by name.
    expectOwners("1. Local persistence and isolation");

    const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-acceptance-reclone-")));
    scratchRoots.push(root);
    const home = join(root, "home");
    mkdirSync(home);
    // invariant: The user-level store lives under a fixture HOME; the real home is never read.
    const restore = spyOn(nodeOs, "homedir").mockImplementation(() => home);
    try {
      const git = (cwd: string, ...args: string[]): string =>
        execFileSync("git", args, {
          cwd,
          // invariant: A minimal environment — no GIT_DIR / GIT_WORK_TREE / GIT_CONFIG_* from the
          // invoking shell may select the repository or the config this fixture exercises.
          env: {
            PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            HOME: home,
            TMPDIR: process.env.TMPDIR ?? tmpdir(),
            TZ: "UTC",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: devNull,
            GIT_TERMINAL_PROMPT: "0",
          },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      const origin = "https://github.com/acme/acceptance-reclone.git";
      const bare = join(root, "origin.git");
      git(root, "init", "-q", "--bare", bare);
      const publisher = join(root, "publisher");
      mkdirSync(publisher);
      git(publisher, "init", "-q", "-b", "main");
      git(publisher, "config", "user.name", "Acceptance Test");
      git(publisher, "config", "user.email", "acceptance@example.test");
      writeFileSync(join(publisher, ".mstarc"), "[collaboration]\nmode=local\n");
      git(publisher, "add", ".mstarc");
      git(publisher, "commit", "-q", "-m", "declare local collaboration");
      git(publisher, "push", "-q", bare, "HEAD:refs/heads/main");
      const checkout = (name: string): StoreContext => {
        const dir = join(root, name);
        git(root, "clone", "-q", "--branch", "main", "-c", `url.${bare}.insteadOf=${origin}`, origin, dir);
        mkdirSync(join(dir, ".mstar"), { recursive: true });
        return { harnessDir: join(dir, ".mstar"), checkoutRoot: dir };
      };

      const first = checkout("first");
      (await initializeStore(first)).close();
      const published = await ensureCollaborationAuthority(first);
      await captureIssue(
        first,
        {
          projectId: "p-one",
          title: "Reclone finding",
          kind: "bug",
          severity: "high",
          impact: "the record outlives the checkout",
          acceptance: "a replacement checkout reads it",
          sourceIdentity: "review/acceptance-reclone",
          rootCauseKey: "root-acceptance-reclone",
          acceptanceKey: "accept-acceptance-reclone",
          occurrenceKey: "occurrence-acceptance-reclone",
          sourceKind: "test",
          location: "packages/cli/test/collaboration-acceptance.test.ts",
          observedBehavior: "the first checkout wrote it",
          evidence: ["reclone"],
          discoveredAt: "2026-11-21T00:00:00.000Z",
        },
        { operationId: "acceptance-reclone-capture", actor: "project-manager" },
      );
      const seeded = await listIssues(first, {});
      expect(seeded.items.map((issue) => issue.title)).toEqual(["Reclone finding"]);

      // invariant: The checkout is GONE, not merely unbound: the record survives only in the
      // retained user-level store the replacement clone resolves to.
      rmSync(first.checkoutRoot!, { recursive: true, force: true });
      expect(existsSync(first.checkoutRoot!)).toBe(false);

      const second = checkout("second");
      expect(existsSync(join(second.harnessDir, "store.db"))).toBe(false);
      const authority = await readCollaborationAuthority(second);
      expect(authority).toMatchObject({ state: "active", storeId: published.storeId, epoch: published.epoch });
      const recovered = await listIssues(second, {});
      expect(recovered.items.map((issue) => issue.title)).toEqual(["Reclone finding"]);
      // invariant: Execution state is NOT restored with it — the replacement clone starts fresh.
      await expect(openStore(second, "read")).rejects.toMatchObject({ code: "store.not-initialized" });
    } finally {
      restore.mockRestore();
    }
  }, 240_000);

  test("criterion 2 — remote sandbox handoff is proven by its owner scenarios", () => {
    expectOwners("2. Remote sandbox handoff");
  }, 240_000);

  test("criterion 3 — the full round trip and adoption is proven by its owner scenario", () => {
    expectOwners("3. Full round trip and adoption");
  }, 240_000);

  test("criterion 4 — honest failures and recovery are proven by their owner scenarios", () => {
    expectOwners("4. Honest failures and recovery");
  }, 240_000);

  test("criterion 5 — every read model and gate is proven by its owner scenarios", () => {
    expectOwners("5. All read models and gates");
  }, 240_000);

  test("criterion 6 — migration and rebinding are proven by their owner scenarios, including mid-cutover interruption and a concurrent conflict", () => {
    expectOwners("6. Migration and rebinding");
  }, 240_000);

  test("criterion 7 — boundary only: a remote project move refuses collaboration.mode-unavailable and leaves the observed issue and source generation unchanged", () => {
    // note: The ADR asks for a staged cross-authority move with interruption recovery. This
    // asserts only the refusal boundary at the shipped CLI: no staged move, no relation
    // resolution, no IssueRef preservation across authorities. Criterion 7 stays unproven.
    const fixture = new RemoteCollaborationFixture("acceptance-move-boundary");
    const moveOperation = "11111111-1111-4111-8111-1111111111aa";
    try {
      fixture.publish(1);
      const sandbox = fixture.sandbox("boundary");
      expect(sandbox.bind(fixture.verify()).exitCode).toBe(0);
      expect(sandbox.init().exitCode).toBe(0);
      expect(sandbox.observe(fixture.observe(REMOTE_PROJECT, 0)).exitCode).toBe(0);

      // note: The observed source issue is the subject of the move: it must still read the same
      // after the refusal, which is what makes the refusal non-destructive rather than silent.
      const readIssue = () =>
        sandbox.runJson([
          "issue", "show",
          "--id", FIXTURE_ISSUE_ID,
          "--project", REMOTE_PROJECT.localProjectId,
          "--harness", sandbox.harness,
        ]);
      const issueBefore = readIssue();
      expect(issueBefore.exitCode).toBe(0);
      expect(issueBefore.data).toMatchObject({ kind: "provider-only", issueRef: null, projectId: REMOTE_PROJECT.localProjectId });
      const statusBefore = sandbox.status();
      expect(statusBefore.data.binding, statusBefore.result.stderr).toMatchObject({ state: "bound", generation: 1 });

      const moved = sandbox.runJson([
        "issue", "move",
        "--id", FIXTURE_ISSUE_ID,
        "--expect", "1",
        "--expect-store", "0",
        "--actor", "project-manager",
        "--operation-id", moveOperation,
        "--harness", sandbox.harness,
        "--payload", JSON.stringify({ projectId: REMOTE_PROJECT.localProjectId, reason: "elsewhere" }),
      ]);
      expect(moved.exitCode).toBe(1);
      expect(moved.code).toBe("collaboration.mode-unavailable");

      // invariant: The same source generation still selects the same authority — nothing was
      // re-pointed, re-bound or advanced by the refused move.
      const statusAfter = sandbox.status();
      expect(statusAfter.data.selector).toEqual(statusBefore.data.selector);
      expect(statusAfter.data.binding).toEqual(statusBefore.data.binding);
      // invariant: The observed issue is unchanged and still not adopted or moved.
      expect(readIssue().data).toEqual(issueBefore.data);
      // invariant: The refusal froze no intent at all — the named operation id has no recorded
      // intent, and the project's pending queue is empty.
      const recorded = sandbox.runJson([
        "store", "collaboration", "remote", "outbox-show",
        "--harness", sandbox.harness, "--operation", moveOperation,
      ]);
      expect(recorded.exitCode).toBe(1);
      expect(recorded.code).toBe("remote.intent-not-found");
      const pending = sandbox.runJson([
        "store", "collaboration", "remote", "outbox-pending",
        "--harness", sandbox.harness, "--project", REMOTE_PROJECT.localProjectId,
      ]);
      expect(pending.exitCode).toBe(0);
      expect(pending.data).toMatchObject({ generation: 1, intents: [] });
    } finally {
      fixture.dispose();
    }
  }, 240_000);

  test("criterion 8 — provider isolation is proven by its owner scenarios", () => {
    expectOwners("8. Provider isolation");
  }, 240_000);
});
