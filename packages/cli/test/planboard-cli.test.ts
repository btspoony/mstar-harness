/**
 * CLI `mstar planboard check` — the envelope, the exit code and the
 * write-nothing promise.
 *
 * The command is a report, never a gate: every finding class and all of them
 * together still exit 0, and the store's bytes, the board's bytes and the file
 * list of `{HARNESS_DIR}` are identical before and after the run. Only a
 * malformed invocation keeps the CLI's usage exit, which the adapter owns.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  captureIssue,
  closeIssue,
  ensureCollaborationAuthority,
  initializeStore,
  resolveCollaborationLocation,
  type CaptureInput,
  type MutationContext,
} from "@mstar-harness/engine";
import { z } from "zod";
import { runCli, writeFixtureRepoId } from "./harness";

/** The parsed report envelope, validated at this boundary instead of cast. */
const reportSchema = z.object({
  status: z.string(),
  exitCode: z.number(),
  data: z.object({
    path: z.string().nullable(),
    reviewAfter: z.string().nullable(),
    codes: z.array(z.string()),
    findings: z.array(z.object({ code: z.string(), line: z.number().nullable(), storeCode: z.string().optional() })),
  }),
});

function report(stdout: string): z.infer<typeof reportSchema> {
  return reportSchema.parse(JSON.parse(stdout));
}

/** An invocation the adapter refused before execution: it carries no data. */
const usageSchema = z.object({ status: z.string(), code: z.string(), exitCode: z.number() });

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

/** The issue lane's revision, read without creating or migrating anything. */
function storeRevision(root: string): number {
  const location = resolveCollaborationLocation({ harnessDir: join(root, ".mstar") });
  const db = new DatabaseSync(location.dbPath, { readOnly: true });
  try {
    return (db.prepare("select revision from collaboration_meta where id = 1").get() as { revision: number }).revision;
  } finally {
    db.close();
  }
}

/** Everything a report must leave alone: the board's bytes and the harness file list. */
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

describe("mstar planboard check", () => {
  test("an absent board is a clean, exit-0 report", async () => {
    const root = fixtureRoot("mstar-planboard-cli-");
    try {
      const harness = join(root, ".mstar");
      await initializeStore({ harnessDir: harness }).then((handle) => handle.close());
      await ensureCollaborationAuthority({ harnessDir: harness });
      const before = harnessState(harness);
      const result = runCli(["planboard", "check"], { cwd: root });
      expect(result.exitCode).toBe(0);
      const reported = report(result.stdout);
      expect(reported.status).toBe("ok");
      expect(reported.exitCode).toBe(0);
      expect(reported.data).toEqual({
        path: null,
        reviewAfter: null,
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
        const result = runCli(["planboard", "check"], { cwd: root });
        expect(result.exitCode).toBe(0);
        expect(report(result.stdout).data.findings).toEqual([{ code: one.code, line: one.line }]);
        expect(harnessState(harness)).toBe(before);
        expect(storeRevision(root)).toBe(revision);
      }

      // All at once: one open line (no finding), a stale line, a missing line,
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
      const result = runCli(["planboard", "check"], { cwd: root });
      expect(result.exitCode).toBe(0);
      expect(report(result.stdout).data.findings).toEqual([
        { code: "stale", line: 5 },
        { code: "missing", line: 6 },
        { code: "malformed", line: 7 },
        { code: "overdue", line: 10 },
      ]);
      expect(harnessState(harness)).toBe(before);
      expect(storeRevision(root)).toBe(revision);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a refused issue store reports every issue line as unverified with the store code", () => {
    const root = fixtureRoot("mstar-planboard-cli-refused-");
    try {
      const harness = join(root, ".mstar");
      writeFileSync(
        join(harness, "planboard.md"),
        "review_after: 2099-01-01\n## Captured\n- I-000001 \u2014 first\n- I-000002 \u2014 second\n",
      );
      const before = harnessState(harness);
      const result = runCli(["planboard", "check"], { cwd: root });
      expect(result.exitCode).toBe(0);
      const findings = report(result.stdout).data.findings;
      expect(findings.map((finding) => ({ code: finding.code, line: finding.line }))).toEqual([
        { code: "unverified", line: 3 },
        { code: "unverified", line: 4 },
      ]);
      for (const finding of findings) expect(finding.storeCode).toMatch(/^collaboration\./);
      expect(harnessState(harness)).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a malformed invocation keeps the CLI usage exit", () => {
    const root = fixtureRoot("mstar-planboard-cli-usage-");
    try {
      for (const args of [["planboard", "verify"], ["planboard", "check", "--unknown", "x"]]) {
        const result = runCli(args, { cwd: root });
        expect(result.exitCode).toBe(2);
        expect(usageSchema.parse(JSON.parse(result.stdout)).status).toBe("usage");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
