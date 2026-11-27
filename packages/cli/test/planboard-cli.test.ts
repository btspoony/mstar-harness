/** see packages/cli/test/planboard-cli.test.ts - CLI `mstar planboard check` — the envelope, the exit code and the write-nothing promise. The command is a report, never a gate: every finding class and all of them together still exit 0, and the store's bytes, the board's bytes and the file list of `{HARNESS_DIR}` are identical before and after the run. Only a malformed invocation keeps the CLI's usage exit, which the adapter owns. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  bindRemoteAuthority,
  captureIssue,
  closeIssue,
  ensureCollaborationAuthority,
  initializeCollaborationStore,
  initializeStore,
  resolveCollaborationLocation,
  type CaptureInput,
  type MutationContext,
  type StoreContext,
} from "@mstar-harness/engine";
import { createRemoteScope, REMOTE_IDS } from "../../engine/src/remote-scope.fixture.js";
import { z } from "zod";
import { runCli, writeFixtureRepoId } from "./harness";

/** see packages/cli/test/planboard-cli.test.ts - The parsed report envelope, validated at this boundary instead of cast. */
const reportSchema = z.object({
  status: z.string(),
  exitCode: z.number(),
  data: z.object({
    path: z.string().nullable(),
    reviewAfter: z.string().nullable(),
    captured: z.array(z.object({ line: z.number(), issueId: z.string(), reason: z.string() })),
    candidates: z.array(z.object({ line: z.number(), candidate: z.string(), evidence: z.string() })),
    codes: z.array(z.string()),
    findings: z.array(z.object({ code: z.string(), line: z.number().nullable(), storeCode: z.string().optional() })),
  }),
});

function report(stdout: string): z.infer<typeof reportSchema> {
  return reportSchema.parse(JSON.parse(stdout));
}

/** see packages/cli/test/planboard-cli.test.ts - An invocation the adapter refused before execution: it carries no data. */
const usageSchema = z.object({ status: z.string(), code: z.string(), exitCode: z.number(), message: z.string() });

function captureInput(rootCauseKey: string): CaptureInput {
  return {
    projectId: "proj-a",
    title: "Planboard CLI fixture",
    kind: "bug",
    severity: "medium",
    impact: "the board points at nothing",
    acceptance: "the board points at a live issue",
    sourceIdentity: "guides/implementation-notes.md",
    rootCauseKey,
    acceptanceKey: `${rootCauseKey}-accepted`,
    occurrenceKey: `${rootCauseKey}-run`,
    sourceKind: "qc",
    location: "packages/engine/src/planboard.ts:1",
    observedBehavior: "a stale pointer",
    evidence: ["planboard cli fixture"],
    discoveredAt: "2026-09-18T10:00:00.000Z",
  };
}

function mutation(operationId: string): MutationContext {
  return { operationId, actor: "project-manager" };
}

/** see packages/cli/test/planboard-cli.test.ts - The issue lane's revision, read without creating or migrating anything. */
function storeRevision(root: string | StoreContext): number {
  const context = typeof root === "string" ? { harnessDir: join(root, ".mstar") } : root;
  const location = resolveCollaborationLocation(context);
  const db = new DatabaseSync(location.dbPath, { readOnly: true });
  try {
    return (db.prepare("select revision from collaboration_meta where id = 1").get() as { revision: number }).revision;
  } finally {
    db.close();
  }
}

/** see packages/cli/test/planboard-cli.test.ts - Everything a report must leave alone: the board's bytes and the harness file list. */
function harnessState(harness: string): string {
  const board = join(harness, "planboard.md");
  return JSON.stringify({ files: readdirSync(harness).sort(), board: existsSync(board) ? readFileSync(board, "utf8") : null });
}

function fixtureRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  writeFixtureRepoId(root);
  mkdirSync(join(root, ".mstar"), { recursive: true });
  return root;
}

/** see packages/cli/test/planboard-cli.test.ts - The collaboration lane is user-level, so the spawned child and this process must resolve the SAME home; the spy covers this process and `HOME` reaches the child. */
const HOME = mkdtempSync(join(tmpdir(), "mstar-planboard-cli-home-"));
let homeSpy: { mockRestore(): void } | undefined;
beforeAll(() => {
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);
});
afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(HOME, { recursive: true, force: true });
});

describe("mstar planboard check", () => {
  test("an absent board is a clean, exit-0 report", async () => {
    const root = fixtureRoot("mstar-planboard-cli-");
    try {
      const harness = join(root, ".mstar");
      await initializeStore({ harnessDir: harness }).then((handle) => handle.close());
      await ensureCollaborationAuthority({ harnessDir: harness });
      const before = harnessState(harness);
      const result = runCli(["planboard", "check"], { cwd: root, env: { HOME } });
      expect(result.exitCode).toBe(0);
      const reported = report(result.stdout);
      expect(reported.status).toBe("ok");
      expect(reported.exitCode).toBe(0);
      expect(reported.data).toEqual({
        path: null,
        reviewAfter: null,
        captured: [],
        candidates: [],
        codes: ["malformed", "stale", "missing", "overdue", "unverified"],
        findings: [],
      });
      expect(harnessState(harness)).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("each finding class, and all of them together, exits 0 and writes nothing", async () => {
    const root = fixtureRoot("mstar-planboard-cli-");
    const harness = join(root, ".mstar");
    try {
      await initializeStore({ harnessDir: harness }).then((handle) => handle.close());
      await ensureCollaborationAuthority({ harnessDir: harness });
      const store = { harnessDir: harness };
      const open = await captureIssue(store, captureInput("cli-open"), mutation("cli-capture-open"));
      const closed = await captureIssue(store, captureInput("cli-closed"), mutation("cli-capture-closed"));
      await closeIssue(
        store,
        closed.issueId,
        "resolved",
        { reason: "accepted", references: ["qa/run.md"], alignmentRef: "QA gate: Approve" },
        { ...mutation("cli-close-closed"), expectedRevision: closed.revision },
      );

      const cases: Array<{ board: string; code: string; line: number }> = [
        { board: "review_after: 2026-01-01\n## Captured\n- [ ] I-000001 \u2014 todo\n", code: "malformed", line: 3 },
        { board: `review_after: 2099-01-01\n## Captured\n- ${closed.issueId} \u2014 closed\n`, code: "stale", line: 3 },
        { board: "review_after: 2099-01-01\n## Captured\n- I-999999 \u2014 absent\n", code: "missing", line: 3 },
        { board: "review_after: 2020-01-01\n## Candidates\n- ? a candidate \u2014 docs/specs/example.md\n", code: "overdue", line: 3 },
      ];
      for (const one of cases) {
        writeFileSync(join(harness, "planboard.md"), one.board);
        const before = harnessState(harness);
        const revision = storeRevision(root);
        const result = runCli(["planboard", "check"], { cwd: root, env: { HOME } });
        expect(result.exitCode).toBe(0);
        expect(report(result.stdout).data.findings).toEqual([{ code: one.code, line: one.line }]);
        expect(harnessState(harness)).toBe(before);
        expect(storeRevision(root)).toBe(revision);
      }

      // see packages/cli/test/planboard-cli.test.ts - // All at once: one open line (no finding), a stale line, a missing line,
      // a malformed line and an overdue candidate. Findings sort by line.
      writeFileSync(
        join(harness, "planboard.md"),
        [
          "review_after: 2020-01-01",
          "",
          "## Captured",
          `- ${open.issueId} \u2014 still open`,
          `- ${closed.issueId} \u2014 already closed`,
          "- I-999999 \u2014 never captured",
          "- [ ] I-000001 \u2014 a checkbox is not a pointer",
          "",
          "## Candidates",
          "- ? an overdue candidate \u2014 docs/specs/example.md",
        ].join("\n"),
      );
      const before = harnessState(harness);
      const revision = storeRevision(root);
      const result = runCli(["planboard", "check"], { cwd: root, env: { HOME } });
      expect(result.exitCode).toBe(0);
      const combined = report(result.stdout).data;
      expect(combined.findings).toEqual([
        { code: "stale", line: 5 },
        { code: "missing", line: 6 },
        { code: "malformed", line: 7 },
        { code: "overdue", line: 10 },
      ]);
      // see packages/cli/test/planboard-cli.test.ts - // invariant: The board's well-formed pointers travel in the envelope, so a
      // caller that runs only the verb still reads the ordering and the
      // candidates — the findings say which of them drifted.
      expect(combined.captured).toEqual([
        { line: 4, issueId: open.issueId, reason: "still open" },
        { line: 5, issueId: closed.issueId, reason: "already closed" },
        { line: 6, issueId: "I-999999", reason: "never captured" },
      ]);
      expect(combined.candidates).toEqual([
        { line: 10, candidate: "an overdue candidate", evidence: "docs/specs/example.md" },
      ]);
      expect(harnessState(harness)).toBe(before);
      expect(storeRevision(root)).toBe(revision);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unverified, malformed and overdue together in one run, exit 0, nothing written", async () => {
    // see packages/cli/test/planboard-cli.test.ts - // why: `unverified` means the one store this run reads refused, and that
    // refuses EVERY issue line (a refused read is never a stale or missing one),
    // so the joint run pairs it with the two findings the parser decides alone;
    // the store-backed joint run above covers stale+missing+malformed+overdue.
    // The lane belongs to the fixture's own checkout, so the run and the revision
    // read both address that checkout — a fresh temp dir would have no lane.
    const fixture = createRemoteScope(HOME, "planboard-cli-joint");
    const harness = fixture.harness;
    const root = fixture.repo;
    try {
      const commit = fixture.publish();
      // see packages/cli/test/planboard-cli.test.ts - // A published selector with no admitted observation: every issue read refuses.
      await bindRemoteAuthority(fixture.context(), fixture.batch(commit));
      writeFileSync(
        join(harness, "planboard.md"),
        [
          "review_after: 2020-01-01",
          "",
          "## Captured",
          `- ${REMOTE_IDS.issueRef} \u2014 an issue this store cannot answer for`,
          "- [ ] I-000001 \u2014 a checkbox is not a pointer",
          "",
          "## Candidates",
          "- ? an overdue candidate \u2014 docs/specs/example.md",
        ].join("\n"),
      );
      const before = harnessState(harness);
      // see packages/cli/test/planboard-cli.test.ts - // The bind wrote this selection's cache, so the remote lane has a revision.
      const revision = storeRevision(fixture.context());
      const result = runCli(["planboard", "check"], { cwd: root, env: { HOME } });
      expect(result.exitCode).toBe(0);
      const reported = report(result.stdout).data;
      expect(reported.findings.map(({ code, line }) => ({ code, line }))).toEqual([
        { code: "unverified", line: 4 },
        { code: "malformed", line: 5 },
        { code: "overdue", line: 8 },
      ]);
      expect(reported.findings[0]!.storeCode).toMatch(/^remote\.|^collaboration\./);
      // see packages/cli/test/planboard-cli.test.ts - // invariant: The pointers the parse accepted travel even when the read refused.
      expect(reported.captured).toEqual([{ line: 4, issueId: REMOTE_IDS.issueRef, reason: "an issue this store cannot answer for" }]);
      expect(reported.candidates).toEqual([
        { line: 8, candidate: "an overdue candidate", evidence: "docs/specs/example.md" },
      ]);
      expect(harnessState(harness)).toBe(before);
      expect(storeRevision(fixture.context())).toBe(revision);
    } finally {
      // see packages/cli/test/planboard-cli.test.ts - // note: The fixture's checkout and lane live under the shared HOME.
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  test("a refused issue store reports every issue line as unverified, with its code, writing nothing", async () => {
    const root = fixtureRoot("mstar-planboard-cli-refused-");
    const harness = join(root, ".mstar");
    try {
      // see packages/cli/test/planboard-cli.test.ts - // why: A STAGED collaboration lane is a real store with a real revision that
      // refuses every ordinary issue read, so the refused-read case can compare
      // the revision it started with instead of merely claiming nothing was written.
      await initializeCollaborationStore(resolveCollaborationLocation({ harnessDir: harness }));
      writeFileSync(
        join(harness, "planboard.md"),
        "review_after: 2099-01-01\n## Captured\n- I-000001 \u2014 first\n- I-000002 \u2014 second\n",
      );
      const before = harnessState(harness);
      const revision = storeRevision(root);
      const result = runCli(["planboard", "check"], { cwd: root, env: { HOME } });
      expect(result.exitCode).toBe(0);
      const reported = report(result.stdout).data;
      expect(reported.findings.map(({ code, line }) => ({ code, line }))).toEqual([
        { code: "unverified", line: 3 },
        { code: "unverified", line: 4 },
      ]);
      for (const finding of reported.findings) expect(finding.storeCode).toMatch(/^collaboration\./);
      // see packages/cli/test/planboard-cli.test.ts - // invariant: A refused read still reports the pointers it parsed.
      expect(reported.captured).toEqual([
        { line: 3, issueId: "I-000001", reason: "first" },
        { line: 4, issueId: "I-000002", reason: "second" },
      ]);
      expect(reported.candidates).toEqual([]);
      expect(harnessState(harness)).toBe(before);
      expect(storeRevision(root)).toBe(revision);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unresolved harness root refuses instead of reading a stray planboard", async () => {
    // see packages/cli/test/planboard-cli.test.ts - // why: Outside Git with no explicit harness, a plain `./planboard.md` is not
    // this project's board. The verb must say so, not report a clean board.
    const root = mkdtempSync(join(tmpdir(), "mstar-planboard-cli-noharness-"));
    try {
      writeFileSync(join(root, "planboard.md"), "review_after: 2099-01-01\n## Captured\n- I-000001 \u2014 stray\n");
      const before = readFileSync(join(root, "planboard.md"), "utf8");
      const result = runCli(["planboard", "check"], { cwd: root, env: { HOME } });
      expect(result.exitCode).toBe(1);
      const refused = usageSchema.parse(JSON.parse(result.stdout));
      expect(refused).toMatchObject({ status: "refused", code: "planboard.harness-unresolved", exitCode: 1 });
      // see packages/cli/test/planboard-cli.test.ts - // The refusal states the recovery inline, as every family's envelope does.
      expect(refused.message).toContain("--harness");
      expect(readFileSync(join(root, "planboard.md"), "utf8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a malformed invocation keeps the CLI usage exit", () => {
    const root = fixtureRoot("mstar-planboard-cli-usage-");
    try {
      for (const args of [["planboard", "verify"], ["planboard", "check", "--unknown", "x"]]) {
        const result = runCli(args, { cwd: root, env: { HOME } });
        expect(result.exitCode).toBe(2);
        expect(usageSchema.parse(JSON.parse(result.stdout)).status).toBe("usage");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
