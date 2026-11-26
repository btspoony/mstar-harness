/**
 * planboard.test.ts — proof for the planboard grammar and its five findings.
 * Run with `bun test packages/engine/src/planboard.test.ts`.
 *
 * Fixture boards cover each finding and every malformed variant the closed
 * grammar names; the store-backed cases run against a real collaboration lane
 * (local and remote) in a temporary home, never a mock.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodeOs from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import { initializeCollaborationStore, openCollaborationStore, writeCollaborationBinding } from "./collaboration-store.js";
import { bindRemoteAuthority, ingestRemoteObservation } from "./collaboration-remote.js";
import {
  completeSnapshot,
  createRemoteScope,
  positiveCheck,
  REMOTE_IDS,
  submission,
} from "./remote-scope.fixture.js";
import { captureIssue, closeIssue, type CaptureInput, type MutationContext } from "./issue.js";
import { PLANBOARD_FILE, checkPlanboard, parsePlanboard, type PlanboardFinding } from "./planboard.js";
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

function pairs(findings: readonly PlanboardFinding[]): Array<{ code: string; line: number | null }> {
  return findings.map(({ code, line }) => ({ code, line }));
}

function parse(linesOfText: readonly string[]) {
  return parsePlanboard(linesOfText.join("\n"));
}

describe("planboard grammar", () => {
  test("a well-formed board parses into its pointers", () => {
    const parsed = parse([
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
    ]);
    expect(parsed.findings).toEqual([]);
    expect(parsed.reviewAfter).toBe("2026-12-10");
    expect(parsed.issues).toEqual([
      { line: 5, id: "I-000001", reason: "unblocks the cutover" },
      { line: 6, id: "I-000002", reason: "ordering reason" },
    ]);
    expect(parsed.candidates.map((entry) => entry.line)).toEqual([10, 11]);
  });

  test("a stable issue reference is a legal pointer id", () => {
    const parsed = parse([
      "review_after: 2026-12-10",
      "## Captured",
      `- ${REMOTE_IDS.issueRef} \u2014 adopted finding`,
    ]);
    expect(parsed.findings).toEqual([]);
    expect(parsed.issues[0]!.id).toBe(REMOTE_IDS.issueRef);
  });

  test("a checkbox line is malformed", () => {
    expect(pairs(parse(["review_after: 2026-12-10", "## Captured", "- [ ] I-000001 \u2014 todo"]).findings)).toEqual([
      { code: "malformed", line: 3 },
    ]);
  });

  test("a second issue id on one line is malformed", () => {
    expect(pairs(parse(["review_after: 2026-12-10", "## Captured", "- I-000001 \u2014 unblocks I-000002"]).findings)).toEqual([
      { code: "malformed", line: 3 },
    ]);
  });

  test("a candidate without evidence is malformed", () => {
    expect(pairs(parse(["review_after: 2026-12-10", "## Candidates", "- ? unnamed candidate"]).findings)).toEqual([
      { code: "malformed", line: 3 },
    ]);
  });

  test("an empty candidate evidence is malformed", () => {
    expect(codes(parse(["review_after: 2026-12-10", "## Candidates", "- ? unnamed \u2014 "]).findings)).toEqual(["malformed"]);
  });

  test("a candidate naming prose instead of evidence is malformed", () => {
    expect(pairs(parse(["review_after: 2026-12-10", "## Candidates", "- ? a candidate \u2014 not evidence"]).findings)).toEqual([
      { code: "malformed", line: 3 },
    ]);
  });

  test("a candidate with whitespace-only text is malformed", () => {
    expect(codes(parse(["review_after: 2026-12-10", "## Candidates", "- ?    \u2014 docs/specs/example.md"]).findings)).toEqual([
      "malformed",
    ]);
  });

  test("a candidate line carrying a second issue id is malformed", () => {
    expect(pairs(parse(["review_after: 2026-12-10", "## Candidates", "- ? I-000001 \u2014 I-000002"]).findings)).toEqual([
      { code: "malformed", line: 3 },
    ]);
  });

  test("evidence wrapped in prose is malformed even when it names an issue", () => {
    for (const evidence of ["see I-000001 for context", "I-000001 and more", "per docs/specs/a.md, plus"]) {
      const parsed = parse(["review_after: 2026-12-10", "## Candidates", `- ? a candidate \u2014 ${evidence}`]);
      expect(pairs(parsed.findings)).toEqual([{ code: "malformed", line: 3 }]);
      expect(parsed.candidates).toEqual([]);
    }
    // invariant: No punctuation exception exists — the validated value is the
    // emitted value, so a suffixed token is malformed rather than normalized.
    expect(pairs(parse(["review_after: 2026-12-10", "## Candidates", "- ? ok \u2014 I-000001;"]).findings)).toEqual([
      { code: "malformed", line: 3 },
    ]);
  });

  test("a candidate may name an ADR record and a bare issue id as evidence", () => {
    expect(
      parse([
        "review_after: 2026-12-10",
        "## Candidates",
        "- ? first \u2014 2026-11-26-retire-project-roadmap",
        "- ? second \u2014 I-000004",
      ]).findings,
    ).toEqual([]);
  });

  test("a 21st entry in a section is malformed and the first twenty are kept", () => {
    const entries = Array.from({ length: 21 }, (_, index) => `- I-${String(index + 1).padStart(6, "0")} \u2014 order ${index}`);
    const parsed = parse(["review_after: 2026-12-10", "## Captured", ...entries]);
    expect(parsed.issues).toHaveLength(20);
    // One section-level finding, not one per excess line.
    expect(pairs(parsed.findings)).toEqual([{ code: "malformed", line: 23 }]);
  });

  test("an unknown heading is malformed and closes the open section", () => {
    const parsed = parse(["review_after: 2026-12-10", "## Captured", "## History", "- I-000001 \u2014 mislaid pointer"]);
    expect(pairs(parsed.findings)).toEqual([
      { code: "malformed", line: 3 },
      { code: "malformed", line: 4 },
    ]);
    // invariant: The pointer under the unknown heading is never looked up.
    expect(parsed.issues).toEqual([]);
  });

  test("a repeated section is malformed", () => {
    expect(pairs(parse(["review_after: 2026-12-10", "## Captured", "## Captured"]).findings)).toEqual([
      { code: "malformed", line: 3 },
    ]);
  });

  test("an issue line under `## Candidates` is malformed", () => {
    expect(pairs(parse(["review_after: 2026-12-10", "## Candidates", "- I-000001 \u2014 wrong section"]).findings)).toEqual([
      { code: "malformed", line: 3 },
    ]);
  });

  test("a candidate line under `## Captured` is malformed", () => {
    expect(pairs(parse(["review_after: 2026-12-10", "## Captured", "- ? candidate \u2014 docs/specs/example.md"]).findings)).toEqual([
      { code: "malformed", line: 3 },
    ]);
  });

  test("a status or history line is malformed", () => {
    expect(pairs(parse(["review_after: 2026-12-10", "## Captured", "status: delivered on 2026-11-01"]).findings)).toEqual([
      { code: "malformed", line: 3 },
    ]);
  });

  test("a missing `review_after` is one file-level malformed finding", () => {
    expect(pairs(parse(["## Captured", "- I-000001 \u2014 order"]).findings)).toEqual([{ code: "malformed", line: null }]);
  });

  test("an unparsable `review_after` is one file-level malformed finding", () => {
    expect(pairs(parse(["review_after: 2026-13-40", "## Candidates", "- ? c \u2014 docs/specs/example.md"]).findings)).toEqual([
      { code: "malformed", line: null },
    ]);
  });

  test("a second `review_after` invalidates the date", () => {
    const parsed = parse([
      "review_after: 2026-01-01",
      "review_after: 2026-12-11",
      "## Candidates",
      "- ? a candidate \u2014 docs/specs/example.md",
    ]);
    expect(pairs(parsed.findings)).toEqual([{ code: "malformed", line: null }]);
    // invariant: No valid date, so nothing is overdue.
    expect(parsed.reviewAfter).toBeNull();
  });

  test("a `review_after` after a heading invalidates the date", () => {
    const parsed = parse(["## Captured", "review_after: 2026-01-01"]);
    expect(pairs(parsed.findings)).toEqual([{ code: "malformed", line: null }]);
    expect(parsed.reviewAfter).toBeNull();
  });
});

describe("planboard findings against a store", () => {
  test("an absent file is a clean board", async () => {
    const harnessDir = join(ROOT, "absent", ".mstar");
    mkdirSync(harnessDir, { recursive: true });
    expect(await checkPlanboard({ harnessDir })).toEqual({
      path: null,
      reviewAfter: null,
      captured: [],
      candidates: [],
      findings: [],
    });
  });

  test("a board with no pointer line is clean and reports no finding", async () => {
    const context = board(join(ROOT, "empty", ".mstar"), "review_after: 2099-01-01\n");
    expect(await checkPlanboard(context)).toEqual({
      path: join(context.harnessDir, PLANBOARD_FILE),
      reviewAfter: "2099-01-01",
      captured: [],
      candidates: [],
      findings: [],
    });
  });

  test("a clean board still reports its pointers, which the check never hides", async () => {
    const context = await liveStore("pointers");
    const open = await captureIssue(context, captureInput("pointers-open"), mutation("capture-pointing"));
    board(
      context.harnessDir,
      [
        "review_after: 2099-01-01",
        "## Captured",
        `- ${open.issueId} \u2014 the order the PM intends`,
        "## Candidates",
        "- ? a later candidate \u2014 docs/specs/example.md",
      ].join("\n"),
    );
    const result = await checkPlanboard(context, { today: "2026-06-01" });
    expect(result.findings).toEqual([]);
    expect(result.captured).toEqual([{ line: 3, issueId: open.issueId, reason: "the order the PM intends" }]);
    expect(result.candidates).toEqual([{ line: 5, candidate: "a later candidate", evidence: "docs/specs/example.md" }]);
  });

  test("a malformed line is not looked up, and a refused store leaves it unread", async () => {
    // No collaboration lane exists at this harness, so an issue lookup would refuse.
    const context = board(join(ROOT, "malformed", ".mstar"), [
      "review_after: 2099-01-01",
      "## Captured",
      "- [ ] I-000001 \u2014 todo",
    ].join("\n"));
    expect(pairs((await checkPlanboard(context)).findings)).toEqual([{ code: "malformed", line: 3 }]);
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
    expect(pairs(result.findings)).toEqual([
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

  test("invalid date declarations decide no overdue finding", async () => {
    const boards: Array<[string, readonly string[]]> = [
      ["baddate", ["review_after: not-a-date", "## Candidates", "- ? a candidate \u2014 docs/specs/example.md"]],
      [
        "duplicate",
        ["review_after: 2020-01-01", "review_after: 2020-01-02", "## Candidates", "- ? a candidate \u2014 docs/specs/example.md"],
      ],
      ["misplaced", ["## Candidates", "review_after: 2020-01-01", "- ? a candidate \u2014 docs/specs/example.md"]],
    ];
    for (const [name, text] of boards) {
      const context = board(join(ROOT, name, ".mstar"), text.join("\n"));
      const result = await checkPlanboard(context, { today: "2026-06-01" });
      expect(codes(result.findings)).toEqual(["malformed"]);
      expect(result.reviewAfter).toBeNull();
    }
  });

  test("a stable reference resolves against the local store that holds it", async () => {
    const context = await liveStore("local-ref");
    const captured = await captureIssue(context, captureInput("local-ref-open"), mutation("capture-local-ref"));
    const store = await openCollaborationStore(context, "read");
    let issueRef: string;
    try {
      issueRef = (store.db.prepare("select issue_ref from issues where id = ?").get(captured.issueId) as { issue_ref: string }).issue_ref;
    } finally {
      store.close();
    }
    board(
      context.harnessDir,
      ["review_after: 2099-01-01", "## Captured", `- ${issueRef} \u2014 written in remote mode, read locally`].join("\n"),
    );
    // invariant: A completed local read that DID look at `issue_ref` reports the
    // disposition, never `missing` — a board written under a remote selection must
    // survive the selection returning to local.
    expect((await checkPlanboard(context)).findings).toEqual([]);

    // A reference the lane does not hold is a completed answer: missing.
    board(
      context.harnessDir,
      ["review_after: 2099-01-01", "## Captured", `- ${REMOTE_IDS.secondIssueRef} \u2014 not in this lane`].join("\n"),
    );
    expect(pairs((await checkPlanboard(context)).findings)).toEqual([{ code: "missing", line: 3 }]);
  });

  test("a lane-level refusal answers every issue line from one read", async () => {
    const context = await liveStore("lane-once");
    const first = await captureIssue(context, captureInput("lane-a"), mutation("capture-lane-a"));
    const second = await captureIssue(context, captureInput("lane-b"), mutation("capture-lane-b"));
    board(
      context.harnessDir,
      ["review_after: 2099-01-01", "## Captured", `- ${first.issueId} \u2014 first`, `- ${second.issueId} \u2014 second`].join("\n"),
    );
    // note: A staged lane is the reachable lane-level refusal on a local store.
    const location = resolveCollaborationLocation(context);
    const db = new DatabaseSync(location.dbPath);
    try {
      db.prepare("update collaboration_meta set authority_state = 'staged' where id = 1").run();
    } finally {
      db.close();
    }
    const result = await checkPlanboard(context);
    expect(result.findings.map(({ code, line, storeCode }) => ({ code, line, storeCode }))).toEqual([
      { code: "unverified", line: 3, storeCode: "collaboration.not-active" },
      { code: "unverified", line: 4, storeCode: "collaboration.not-active" },
    ]);
  });

  test("a remote lane-level refusal answers every line from one open, without a per-id reopen", async () => {
    const fixture = createRemoteScope(ROOT, "planboard-remote-once");
    const commit = fixture.publish();
    const context = fixture.context();
    await bindRemoteAuthority(context, fixture.batch(commit));
    // A published selector with no admitted observation: opening the view refuses.
    board(
      context.harnessDir,
      [
        "review_after: 2099-01-01",
        "## Captured",
        `- ${REMOTE_IDS.issueRef} \u2014 first`,
        `- ${REMOTE_IDS.secondIssueRef} \u2014 second`,
        "- I-000001 \u2014 third, a display id no remote snapshot addresses",
      ].join("\n"),
    );
    const findings = (await checkPlanboard(context)).findings;
    // invariant: The lane-level cause answers all three, so nothing reopened and
    // no line was re-decided against a cache that never answered.
    expect(findings.map(({ code, line }) => ({ code, line }))).toEqual([
      { code: "unverified", line: 3 },
      { code: "unverified", line: 4 },
      { code: "unverified", line: 5 },
    ]);
    const codes = new Set(findings.map((finding) => finding.storeCode));
    expect(codes.size).toBe(1);
    expect([...codes][0]).toMatch(/^remote\.|^collaboration\./);
  });

  test("a remote board line reports stale, missing and open from the admitted snapshot", async () => {
    const fixture = createRemoteScope(ROOT, "planboard-remote");
    const commit = fixture.publish();
    const context = fixture.context();
    await bindRemoteAuthority(context, fixture.batch(commit));
    const check = positiveCheck();
    await ingestRemoteObservation(context, submission(commit, check, completeSnapshot(check), 0));

    board(
      context.harnessDir,
      [
        "review_after: 2099-01-01",
        "## Captured",
        `- ${REMOTE_IDS.issueRef} \u2014 open in the admitted snapshot`,
      ].join("\n"),
    );
    // The admitted issue is open, so the line reports nothing — not `unverified`.
    expect((await checkPlanboard(context)).findings).toEqual([]);

    // A reference the snapshot does not carry is a completed answer: missing.
    board(
      context.harnessDir,
      ["review_after: 2099-01-01", "## Captured", `- ${REMOTE_IDS.secondIssueRef} \u2014 absent from this snapshot`].join("\n"),
    );
    expect(pairs((await checkPlanboard(context)).findings)).toEqual([{ code: "missing", line: 3 }]);
  });

  test("a remote line whose admitted issue is no longer open is stale", async () => {
    const fixture = createRemoteScope(ROOT, "planboard-refixture");
    const commit = fixture.publish();
    const context = fixture.context();
    await bindRemoteAuthority(context, fixture.batch(commit));
    const check = positiveCheck();
    const base = completeSnapshot(check);
    const closed = base.issues.map((issue) =>
      issue.mstar === null ? issue : { ...issue, mstar: { ...issue.mstar, fields: { ...issue.mstar.fields, disposition: "resolved" } } },
    );
    await ingestRemoteObservation(context, submission(commit, check, { ...base, issues: closed }, 0));

    board(
      context.harnessDir,
      ["review_after: 2099-01-01", "## Captured", `- ${REMOTE_IDS.issueRef} \u2014 delivered already`].join("\n"),
    );
    const findings = (await checkPlanboard(context)).findings;
    expect(pairs(findings)).toEqual([{ code: "stale", line: 3 }]);
    expect(findings[0]!.issueId).toBe(REMOTE_IDS.issueRef);
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
  execFileSync("git", ["config", `url.${checkoutRoot}.insteadOf`, `https://github.com/acme/${basename(checkoutRoot)}.git`], {
    cwd: checkoutRoot,
  });
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
