/**
 * planboard.test.ts — proof for the planboard grammar and its five findings.
 * Run with `bun test packages/engine/src/planboard.test.ts`.
 *
 * Fixture boards cover each finding and every malformed variant the closed
 * grammar names; the store-backed cases run against a real collaboration lane
 * in a temporary home, never a mock.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodeOs from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import {
  initializeCollaborationStore,
  writeCollaborationBinding,
} from "./collaboration-store.js";
import { captureIssue, closeIssue, type CaptureInput, type MutationContext } from "./issue.js";
import {
  PLANBOARD_FILE,
  checkPlanboard,
  parsePlanboard,
  type PlanboardFinding,
} from "./planboard.js";
import type { StoreContext } from "./store-db.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-planboard-test-"));
const HOME = join(ROOT, "home");
mkdirSync(HOME);

let homeSpy: { mockRestore(): void } | undefined;
beforeAll(() => {
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);
});
afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(ROOT, { recursive: true, force: true });
});

/** A fixture harness directory; `board` is written when given. */
function board(harnessDir: string, text: string): StoreContext {
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(join(harnessDir, PLANBOARD_FILE), text);
  return { harnessDir };
}

function codes(findings: readonly PlanboardFinding[]): string[] {
  return findings.map((finding) => finding.code);
}

describe("planboard grammar", () => {
  test("a well-formed board parses into its pointers", () => {
    const parsed = parsePlanboard(
      [
        "review_after: 2026-12-10",
        "",
        "## Captured",
        "",
        "- I-000001 \u2014 unblocks the cutover",
        "- I-000002 \u2014 ordering reason",
        "",
        "## Candidates",
        "",
        "- ? planboard gate \u2014 docs/adr/implemented/architecture/2026-11-26-retire-project-roadmap.md",
        "- ? another candidate \u2014 I-000004",
        "",
      ].join("\n"),
    );
    expect(parsed.findings).toEqual([]);
    expect(parsed.reviewAfter).toBe("2026-12-10");
    expect(parsed.issues).toEqual([
      { line: 5, id: "I-000001" },
      { line: 6, id: "I-000002" },
    ]);
    expect(parsed.candidates.map((entry) => entry.line)).toEqual([10, 11]);
  });

  test("a checkbox line is malformed", () => {
    const parsed = parsePlanboard(["review_after: 2026-12-10", "## Captured", "- [ ] I-000001 \u2014 todo"].join("\n"));
    expect(codes(parsed.findings)).toEqual(["malformed"]);
    expect(parsed.findings[0]!.line).toBe(3);
  });

  test("a second issue id on one line is malformed", () => {
    const parsed = parsePlanboard(
      ["review_after: 2026-12-10", "## Captured", "- I-000001 \u2014 unblocks I-000002"].join("\n"),
    );
    expect(parsed.findings.map(({ code, line }) => ({ code, line }))).toEqual([{ code: "malformed", line: 3 }]);
  });

  test("a candidate without evidence is malformed", () => {
    const parsed = parsePlanboard(["review_after: 2026-12-10", "## Candidates", "- ? unnamed candidate"].join("\n"));
    expect(parsed.findings.map(({ code, line }) => ({ code, line }))).toEqual([{ code: "malformed", line: 3 }]);
  });

  test("an empty candidate evidence is malformed", () => {
    const parsed = parsePlanboard(["review_after: 2026-12-10", "## Candidates", "- ? unnamed \u2014 "].join("\n"));
    expect(codes(parsed.findings)).toEqual(["malformed"]);
  });

  test("a 21st entry in a section is malformed and the first twenty are kept", () => {
    const entries = Array.from({ length: 21 }, (_, index) => `- I-${String(index + 1).padStart(6, "0")} \u2014 order ${index}`);
    const parsed = parsePlanboard(["review_after: 2026-12-10", "## Captured", ...entries].join("\n"));
    expect(parsed.issues).toHaveLength(20);
    expect(parsed.findings.map(({ code, line }) => ({ code, line }))).toEqual([{ code: "malformed", line: 23 }]);
  });

  test("an unknown heading is malformed", () => {
    const parsed = parsePlanboard(["review_after: 2026-12-10", "## History"].join("\n"));
    expect(parsed.findings.map(({ code, line }) => ({ code, line }))).toEqual([{ code: "malformed", line: 2 }]);
  });

  test("a repeated section is malformed", () => {
    const parsed = parsePlanboard(["review_after: 2026-12-10", "## Captured", "## Captured"].join("\n"));
    expect(parsed.findings.map(({ code, line }) => ({ code, line }))).toEqual([{ code: "malformed", line: 3 }]);
  });

  test("an issue line under `## Candidates` is malformed", () => {
    const parsed = parsePlanboard(
      ["review_after: 2026-12-10", "## Candidates", "- I-000001 \u2014 wrong section"].join("\n"),
    );
    expect(parsed.findings.map(({ code, line }) => ({ code, line }))).toEqual([{ code: "malformed", line: 3 }]);
  });

  test("a candidate line under `## Captured` is malformed", () => {
    const parsed = parsePlanboard(
      ["review_after: 2026-12-10", "## Captured", "- ? candidate \u2014 evidence"].join("\n"),
    );
    expect(parsed.findings.map(({ code, line }) => ({ code, line }))).toEqual([{ code: "malformed", line: 3 }]);
  });

  test("a status or history line is malformed", () => {
    const parsed = parsePlanboard(
      ["review_after: 2026-12-10", "## Captured", "status: delivered on 2026-11-01"].join("\n"),
    );
    expect(parsed.findings.map(({ code, line }) => ({ code, line }))).toEqual([{ code: "malformed", line: 3 }]);
  });

  test("a missing `review_after` is one file-level malformed finding", () => {
    const parsed = parsePlanboard(["## Captured", "- I-000001 \u2014 order"].join("\n"));
    expect(parsed.findings.map(({ code, line }) => ({ code, line }))).toEqual([{ code: "malformed", line: null }]);
  });

  test("an unparsable `review_after` is one file-level malformed finding", () => {
    const parsed = parsePlanboard(["review_after: 2026-13-40", "## Candidates", "- ? c \u2014 e"].join("\n"));
    expect(parsed.findings.map(({ code, line }) => ({ code, line }))).toEqual([{ code: "malformed", line: null }]);
  });

  test("a second `review_after` line is malformed", () => {
    const parsed = parsePlanboard(["review_after: 2026-12-10", "review_after: 2026-12-11"].join("\n"));
    expect(parsed.findings.map(({ code, line }) => ({ code, line }))).toEqual([{ code: "malformed", line: 2 }]);
  });
});

describe("planboard findings against a store", () => {
  test("an absent file is a clean board", async () => {
    const harnessDir = join(ROOT, "absent", ".mstar");
    mkdirSync(harnessDir, { recursive: true });
    expect(await checkPlanboard({ harnessDir })).toEqual({ path: null, reviewAfter: null, findings: [] });
  });

  test("a board with no pointer line is clean", async () => {
    const context = board(join(ROOT, "empty", ".mstar"), "review_after: 2099-01-01\n");
    expect(await checkPlanboard(context)).toEqual({
      path: join(context.harnessDir, PLANBOARD_FILE),
      reviewAfter: "2099-01-01",
      findings: [],
    });
  });

  test("a malformed line is not looked up, and a refused store leaves it unread", async () => {
    // No collaboration lane exists at this harness, so an issue lookup would refuse.
    const context = board(join(ROOT, "malformed", ".mstar"), [
      "review_after: 2099-01-01",
      "## Captured",
      "- [ ] I-000001 \u2014 todo",
    ].join("\n"));
    const result = await checkPlanboard(context);
    expect(result.findings.map(({ code, line }) => ({ code, line }))).toEqual([{ code: "malformed", line: 3 }]);
  });

  test("a refused store yields `unverified` for every issue line with the store code", async () => {
    const context = board(join(ROOT, "refused", ".mstar"), [
      "review_after: 2099-01-01",
      "## Captured",
      "- I-000001 \u2014 first",
      "- I-000002 \u2014 second",
    ].join("\n"));
    const result = await checkPlanboard(context);
    expect(codes(result.findings)).toEqual(["unverified", "unverified"]);
    expect(result.findings.map((finding) => finding.line)).toEqual([3, 4]);
    // Every issue line carries the store's own refusal code; none is read as open.
    for (const finding of result.findings) expect(finding.storeCode).toMatch(/^collaboration\./);
  });

  test("open, stale and missing issue lines report the right finding, and overdue follows `review_after`", async () => {
    const context = await liveStore("live");
    const open = await captureIssue(context, captureInput("planboard-open"), mutation("capture-open"));
    const closed = await captureIssue(context, captureInput("planboard-closed"), mutation("capture-closed"));
    await closeIssue(
      context,
      closed.issueId,
      "resolved",
      { reason: "accepted", references: ["qa/run.md"], alignmentRef: "QA gate: Approve" },
      { ...mutation("close-closed"), expectedRevision: closed.revision },
    );
    board(
      context.harnessDir,
      [
        "review_after: 2026-01-01",
        "",
        "## Captured",
        `- ${open.issueId} \u2014 still open`,
        `- ${closed.issueId} \u2014 already closed`,
        "- I-999999 \u2014 never captured",
        "",
        "## Candidates",
        "- ? an overdue candidate \u2014 docs/specs/example.md",
      ].join("\n"),
    );
    const result = await checkPlanboard(context, { today: "2026-06-01" });
    expect(result.findings.map(({ code, line }) => ({ code, line }))).toEqual([
      { code: "stale", line: 5 },
      { code: "missing", line: 6 },
      { code: "overdue", line: 9 },
    ]);
  });

  test("nothing is overdue while `review_after` is still ahead", async () => {
    const context = board(join(ROOT, "future", ".mstar"), [
      "review_after: 2099-01-01",
      "## Candidates",
      "- ? a candidate \u2014 docs/specs/example.md",
    ].join("\n"));
    expect((await checkPlanboard(context, { today: "2026-06-01" })).findings).toEqual([]);
  });

  test("a bad `review_after` decides no overdue finding", async () => {
    const context = board(join(ROOT, "baddate", ".mstar"), [
      "review_after: not-a-date",
      "## Candidates",
      "- ? a candidate \u2014 docs/specs/example.md",
    ].join("\n"));
    const result = await checkPlanboard(context, { today: "2026-06-01" });
    expect(result.findings.map(({ code, line }) => ({ code, line }))).toEqual([{ code: "malformed", line: null }]);
  });
});

function captureInput(rootCauseKey: string): CaptureInput {
  return {
    projectId: "proj-a",
    title: "Planboard fixture issue",
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
    evidence: ["planboard fixture"],
    discoveredAt: "2026-09-18T10:00:00.000Z",
  };
}

function mutation(operationId: string): MutationContext {
  return { operationId, actor: "project-manager" };
}

/** A fixture harness with one active collaboration lane, as real activation writes it. */
async function liveStore(name: string): Promise<StoreContext> {
  const checkoutRoot = join(ROOT, name);
  mkdirSync(checkoutRoot, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: checkoutRoot, stdio: ["ignore", "ignore", "ignore"] });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${basename(checkoutRoot)}.git`], {
    cwd: checkoutRoot,
  });
  execFileSync(
    "git",
    ["config", `url.${checkoutRoot}.insteadOf`, `https://github.com/acme/${basename(checkoutRoot)}.git`],
    { cwd: checkoutRoot },
  );
  writeFileSync(join(checkoutRoot, ".mstarc"), "[collaboration]\nmode=local\n");
  const context: StoreContext = { harnessDir: join(checkoutRoot, ".mstar") };
  mkdirSync(context.harnessDir, { recursive: true });
  const location = resolveCollaborationLocation(context);
  await initializeCollaborationStore(location);
  const db = new DatabaseSync(location.dbPath);
  let storeId = "";
  let epoch = 0;
  try {
    db.prepare("update collaboration_meta set authority_state = 'active', activated_at = ? where id = 1").run(
      new Date().toISOString(),
    );
    const row = db.prepare("select store_id, authority_epoch from collaboration_meta where id = 1").get() as
      | { store_id?: unknown; authority_epoch?: unknown }
      | undefined;
    if (typeof row?.store_id === "string") storeId = row.store_id;
    if (typeof row?.authority_epoch === "number") epoch = row.authority_epoch;
  } finally {
    db.close();
  }
  writeCollaborationBinding(context, {
    repoKey: location.repoKey,
    mode: location.mode,
    storeId,
    epoch,
    binding: "active",
  });
  return context;
}
