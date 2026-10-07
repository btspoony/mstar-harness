/**
 * execution-ledgers.test.ts — S3 fixtures for the retained workflow notes
 * ledger (phase2b-execution-contract §5 "F1 — notes").
 *
 * Every case runs against a real active execution store in its own temporary
 * control root (the same `initializeStore` → `initializeExecutionAuthority` →
 * `createExecutionWorkflow` → `bindExecutionSession` fixture other engine
 * suites use) plus real bytes on disk. Nothing is mocked: the ledger bytes,
 * the lock directories and the session/epoch rows are the real ones.
 *
 * Observables asserted here are preserved historical note content and order,
 * once-only note identities across concurrency and crash replay, append after
 * an unrecognized tail, stale/revoked authority, path trust and workflow locks.
 *
 * Resource discipline: the one fixture the ordinary cases share is built once
 * in `beforeAll`, and each case resets the retained bytes it needs with `seed`.
 * `node:sqlite` on this runtime releases a connection's descriptors only when
 * the connection object is collected, so a store per case would exhaust the
 * descriptor table of this process and turn a later store open into a spurious
 * `SQLITE_CANTOPEN`; the cases that genuinely need their own store (authority
 * mutation, a missing/symlinked body dir, the lock probe) each build one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  appendWorkflowNote,
  normalizeWorkflowNotesCoverage,
  workflowNotesLedgerPath,
  type WorkflowNote,
} from "./execution-ledgers.js";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  initializeExecutionAuthority,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionSessionRef,
} from "./execution-store.js";
import { initializeStore, storeDbPath, type StoreContext } from "./store-db.js";
import type { WorkflowEntry } from "./status.js";
import type { WorkflowSnapshot } from "./workflow.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "mstar-execution-ledgers-")));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const TS = "2026-09-22T00:00:00.000Z";
const WF = "20260922-notes-fixture";
const PLAN_ID = "p-1";
const COORDINATOR_ID = "host-notes";
const LEGACY_NOTE_TS = "2026-09-01T00:00:00.000Z";

/** One migrated historical line, exactly as `migrate.ts` serialized it. */
const LEGACY_LINE = `${JSON.stringify({ kind: "note", ts: LEGACY_NOTE_TS, text: "legacy migrated note" })}\n`;

/** The retained legacy snapshot of this workflow, with inline row notes. */
const LEGACY_SNAPSHOT = `${JSON.stringify(
  {
    schema_version: 1,
    id: WF,
    type: "plan",
    status: "running",
    started_at: TS,
    updated_at: TS,
    plans: [
      {
        id: PLAN_ID,
        title: `${PLAN_ID} title`,
        file: `plans/${PLAN_ID}.md`,
        status: "InProgress",
        notes: ["inline legacy row note", "second inline note"],
      },
    ],
  },
  null,
  2,
)}\n`;

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

type Fixture = {
  context: StoreContext;
  harnessDir: string;
  workflowDir: string;
  ledgerPath: string;
  /** The bound coordinator session (active, current epoch) and its caller context. */
  session: ExecutionSessionRef;
  coordContext: ExecutionContext;
  /** Plant the exact retained bytes an append under test must respect. */
  seed: (input: { ledger?: string; snapshot?: string }) => void;
};

function coordinatorCaller(): ExecutionCaller {
  return { sessionId: COORDINATOR_ID, role: "coordinator", workflowId: WF };
}

function callerContext(harnessDir: string, caller: ExecutionCaller): ExecutionContext {
  return { harnessDir, caller };
}

/** The workflow snapshot the DB creation accepts (plan rows, running lifecycle). */
function createdSnapshot(): WorkflowSnapshot {
  return {
    schema_version: 1,
    id: WF,
    type: "plan",
    status: "running",
    started_at: TS,
    updated_at: TS,
    plans: [{ id: PLAN_ID, title: `${PLAN_ID} title`, file: `plans/${PLAN_ID}.md`, status: "Todo" }],
    delivery_kind: "development",
    branch: { source: `feature/${WF}`, target: "main" },
  } as unknown as WorkflowSnapshot;
}

/**
 * One real active coordinator authority with a created workflow. The retained
 * workflow dir is NOT created here: cases that need it plant it through `seed`,
 * so "no directory side effect" stays observable.
 */
async function notesFixture(label: string): Promise<Fixture> {
  const harnessDir = mkdtempSync(join(ROOT, `${label}-`));
  const context: StoreContext = { harnessDir };
  const handle = await initializeStore(context);
  handle.close();
  const initialized = await initializeExecutionAuthority(context);
  const caller = coordinatorCaller();
  const created = await createExecutionWorkflow(callerContext(harnessDir, caller), {
    entry: { id: WF, type: "plan", started_at: TS, dir: `workflows/${WF}` } as WorkflowEntry,
    snapshot: createdSnapshot(),
    expected: initialized.token,
    operationId: `create-${label}`,
  });
  const workflow = created.data.workflows[0]!;
  const bound = await bindExecutionSession(callerContext(harnessDir, caller), {
    workflowId: WF,
    expected: workflow.workflowToken,
    operationId: `bind-${label}`,
  });
  const workflowDir = join(harnessDir, "workflows", WF);
  return {
    context,
    harnessDir,
    workflowDir,
    ledgerPath: join(workflowDir, "notes.jsonl"),
    session: bound.data,
    coordContext: callerContext(harnessDir, caller),
    seed: (input) => {
      mkdirSync(workflowDir, { recursive: true });
      if (input.ledger !== undefined) writeFileSync(join(workflowDir, "notes.jsonl"), input.ledger);
      if (input.snapshot !== undefined) writeFileSync(join(workflowDir, "snapshot.json"), input.snapshot);
    },
  };
}

/** The one fixture the ordinary cases share; each case resets it with `seed`. */
let shared: Fixture;
beforeAll(async () => {
  shared = await notesFixture("shared");
});

function note(id: string, text: string, overrides: Partial<WorkflowNote> = {}): WorkflowNote {
  return { version: 1, id, workflowId: WF, sessionId: COORDINATOR_ID, kind: "note", ts: TS, text, ...overrides };
}

/** The canonical wire line of one record (pins the versioned format independently). */
function lineOf(record: WorkflowNote): string {
  return `${JSON.stringify({
    version: 1,
    id: record.id,
    workflowId: record.workflowId,
    sessionId: record.sessionId,
    kind: "note",
    ts: record.ts,
    text: record.text,
  })}\n`;
}

async function refusalOf(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run();
  } catch (error) {
    const failure = error as { code?: unknown; message?: unknown };
    return { code: typeof failure.code === "string" ? failure.code : "", message: String(failure.message ?? "") };
  }
  throw new Error("expected the call to refuse");
}

async function withEnv<T>(vars: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(vars).map((key) => [key, process.env[key]] as const));
  const runner = process.env.MSTAR_STORE_TEST_RUNNER;
  process.env.MSTAR_STORE_TEST_RUNNER = "1";
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  try {
    return await run();
  } finally {
    if (runner === undefined) delete process.env.MSTAR_STORE_TEST_RUNNER;
    else process.env.MSTAR_STORE_TEST_RUNNER = runner;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Mutate the fixture's own store rows directly (epoch bump / session revocation). */
function rawRun(context: StoreContext, sql: string): void {
  const db = new DatabaseSync(storeDbPath(context));
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------------ *
 * Location and byte preservation
 * ------------------------------------------------------------------------ */

describe("execution-ledgers: canonical location and retained bytes", () => {
  test("resolves the canonical notes.jsonl path under the control root", () => {
    expect(workflowNotesLedgerPath(shared.context, WF)).toBe(join(shared.harnessDir, "workflows", WF, "notes.jsonl"));
  });

  test("preserves historical notes and inline row notes while appending once", async () => {
    shared.seed({ ledger: LEGACY_LINE, snapshot: LEGACY_SNAPSHOT });
    const first = await appendWorkflowNote(shared.coordContext, shared.session, note("note-1", "first note"));
    expect(first).toEqual({ id: "note-1", replayed: false });
    const replay = await appendWorkflowNote(shared.coordContext, shared.session, note("note-1", "first note"));
    expect(replay).toEqual({ id: "note-1", replayed: true });
    const facts = normalizeWorkflowNotesCoverage({
      workflowId: WF, path: shared.ledgerPath, bytes: readFileSync(shared.ledgerPath),
    });
    expect(facts.acceptedIds).toEqual(["note-1"]);
    expect(facts.records[0]!.record.text).toBe("first note");
    expect(facts.historical[0]!.record).toEqual({ kind: "note", ts: LEGACY_NOTE_TS, text: "legacy migrated note" });
    const snapshotDoc = JSON.parse(readFileSync(join(shared.workflowDir, "snapshot.json"), "utf8")) as { plans: Array<{ notes: string[] }> };
    expect(snapshotDoc.plans[0]!.notes).toEqual(["inline legacy row note", "second inline note"]);
  });

  test("records coordinator provenance in the workflow ledger", async () => {
    shared.seed({ ledger: "" });
    await appendWorkflowNote(shared.coordContext, shared.session, note("coordinator-note", "from the coordinator"));
    const facts = normalizeWorkflowNotesCoverage({
      workflowId: WF,
      path: shared.ledgerPath,
      bytes: readFileSync(shared.ledgerPath),
    });
    expect(facts.acceptedIds).toEqual(["coordinator-note"]);
    expect(facts.records.map((record) => record.record.sessionId)).toEqual([COORDINATOR_ID]);
    expect(facts.records.map((record) => record.record.workflowId)).toEqual([WF]);
  });

  test("a fresh workflow's first note creates only its own body dir", async () => {
    // A workflow created through the DB route has no retained dir yet.
    const fresh = await notesFixture("fresh-workflow");
    expect(existsSync(fresh.workflowDir)).toBe(false);

    const accepted = await appendWorkflowNote(fresh.coordContext, fresh.session, note("note-first", "first note"));
    expect(accepted).toEqual({ id: "note-first", replayed: false });
    expect(existsSync(fresh.workflowDir)).toBe(true);
    const facts = normalizeWorkflowNotesCoverage({
      workflowId: WF, path: fresh.ledgerPath, bytes: readFileSync(fresh.ledgerPath),
    });
    expect(facts.acceptedIds).toEqual(["note-first"]);
    expect(facts.records[0]!.record.text).toBe("first note");
    // The body dir holds the retained ledger and nothing else: no snapshot, no
    // session envelope, no root register, no authority file.
    expect(readdirSync(fresh.workflowDir)).toEqual(["notes.jsonl"]);
    expect(existsSync(join(fresh.harnessDir, "status.json"))).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * Dedup, conflict, crash replay
 * ------------------------------------------------------------------------ */

describe("execution-ledgers: identity, dedup and crash boundaries", () => {
  test("same id with a changed body conflicts and leaves every byte untouched", async () => {
    shared.seed({ ledger: "" });
    await appendWorkflowNote(shared.coordContext, shared.session, note("note-1", "original body"));
    const refusal = await refusalOf(() =>
      appendWorkflowNote(shared.coordContext, shared.session, note("note-1", "changed body")),
    );
    expect(refusal.code).toBe("execution-ledgers.id-conflict");
    const facts = normalizeWorkflowNotesCoverage({
      workflowId: WF, path: shared.ledgerPath, bytes: readFileSync(shared.ledgerPath),
    });
    expect(facts.records.map((entry) => ({ id: entry.record.id, text: entry.record.text }))).toEqual([
      { id: "note-1", text: "original body" },
    ]);
  });

  test("duplicate historical accepted ids do not block preserving and appending", async () => {
    const retained = `${lineOf(note("note-dup", "body"))}${lineOf(note("note-dup", "other body"))}`;
    shared.seed({ ledger: retained });
    const receipt = await appendWorkflowNote(shared.coordContext, shared.session, note("note-new", "fresh"));
    expect(receipt).toEqual({ id: "note-new", replayed: false });
    const facts = normalizeWorkflowNotesCoverage({
      workflowId: WF, path: shared.ledgerPath, bytes: readFileSync(shared.ledgerPath),
    });
    expect(facts.records.map((entry) => entry.record.text)).toEqual(["body", "other body", "fresh"]);
    expect(facts.acceptedIds).toEqual(["note-dup", "note-dup", "note-new"]);
  });

  test("preserves crash tails and accepts the requested note only once", async () => {
    const target = note("note-crash", "interrupted append");
    const full = lineOf(target);
    for (const [tail, replayed] of [[full.slice(0, -1), true], [full.slice(0, 24), false]] as const) {
      shared.seed({ ledger: `${LEGACY_LINE}${tail}` });
      expect(await appendWorkflowNote(shared.coordContext, shared.session, target)).toEqual({ id: target.id, replayed });
      expect(await appendWorkflowNote(shared.coordContext, shared.session, target)).toEqual({ id: target.id, replayed: true });
      const facts = normalizeWorkflowNotesCoverage({
        workflowId: WF, path: shared.ledgerPath, bytes: readFileSync(shared.ledgerPath),
      });
      expect(facts.acceptedIds).toEqual([target.id]);
      expect(facts.records[0]!.record.text).toBe(target.text);
      expect(facts.duplicateIds).toEqual([]);
      expect(facts.tail).toBeNull();
      expect(facts.counts.unrecognized).toBe(replayed ? 0 : 1);
    }
  });

  test("replay preserves an unrecognized partial tail without duplicating an accepted note", async () => {
    const target = note("note-heal", "already accepted");
    const full = lineOf(target);
    shared.seed({ ledger: `${full}${full.slice(0, 20)}` });
    expect(await appendWorkflowNote(shared.coordContext, shared.session, target)).toEqual({ id: target.id, replayed: true });
    const next = await appendWorkflowNote(shared.coordContext, shared.session, note("note-next", "after the tail"));
    expect(next).toEqual({ id: "note-next", replayed: false });
    const facts = normalizeWorkflowNotesCoverage({
      workflowId: WF, path: shared.ledgerPath, bytes: readFileSync(shared.ledgerPath),
    });
    expect(facts.acceptedIds).toEqual(["note-heal", "note-next"]);
    expect(facts.duplicateIds).toEqual([]);
    expect(facts.counts.unrecognized).toBe(1);
  });

  test("a leaf replaced between the read and the commit refuses the changed destination", async () => {
    const target = note("note-1", "body");
    shared.seed({ ledger: `${LEGACY_LINE}${lineOf(target).slice(0, 25)}` });
    const refusal = await withEnv({ MSTAR_LEDGER_REPLACE_BEFORE_COMMIT: shared.ledgerPath }, () =>
      refusalOf(() => appendWorkflowNote(shared.coordContext, shared.session, target)),
    );
    expect(refusal.code).toBe("execution-ledgers.target-replaced");
    const facts = normalizeWorkflowNotesCoverage({
      workflowId: WF, path: shared.ledgerPath, bytes: readFileSync(shared.ledgerPath),
    });
    expect(facts.acceptedIds).toEqual([]);
  });

  test("in-place content edits do not gate an append or cause retained content to be truncated", async () => {
    const target = note("note-1", "body");
    for (const retained of [LEGACY_LINE, `${LEGACY_LINE}${lineOf(target).slice(0, 25)}`]) {
      shared.seed({ ledger: retained });
      const receipt = await withEnv(
        { MSTAR_LEDGER_REPLACE_BEFORE_COMMIT: shared.ledgerPath, MSTAR_LEDGER_REPLACE_MODE: "in-place" },
        () => appendWorkflowNote(shared.coordContext, shared.session, target),
      );
      expect(receipt).toEqual({ id: target.id, replayed: false });
      const facts = normalizeWorkflowNotesCoverage({
        workflowId: WF, path: shared.ledgerPath, bytes: readFileSync(shared.ledgerPath),
      });
      expect(facts.acceptedIds).toEqual([target.id]);
      expect(facts.records[0]!.record.text).toBe("body");
      expect(facts.counts.unrecognized).toBeGreaterThan(0);
    }
  });

  test("an unrelated incomplete tail is preserved as history and does not block a new note", async () => {
    shared.seed({ ledger: `${LEGACY_LINE}{"version":1,"id":"zz-other"` });
    expect(await appendWorkflowNote(shared.coordContext, shared.session, note("note-1", "body"))).toEqual({
      id: "note-1", replayed: false,
    });
    const facts = normalizeWorkflowNotesCoverage({
      workflowId: WF, path: shared.ledgerPath, bytes: readFileSync(shared.ledgerPath),
    });
    expect(facts.acceptedIds).toEqual(["note-1"]);
    expect(facts.counts.unrecognized).toBe(1);
    expect(facts.tail).toBeNull();
  });

  test("unknown historical entries are preserved when appending", async () => {
    for (const unknown of [JSON.stringify({ kind: "something-else", payload: 1 }), "not json at all"]) {
      const retained = `${LEGACY_LINE}${unknown}\n`;
      shared.seed({ ledger: retained });
      const receipt = await appendWorkflowNote(shared.coordContext, shared.session, note("note-1", "body"));
      expect(receipt).toEqual({ id: "note-1", replayed: false });
      const facts = normalizeWorkflowNotesCoverage({
        workflowId: WF, path: shared.ledgerPath, bytes: readFileSync(shared.ledgerPath),
      });
      expect(facts.counts).toEqual({ historical: 2, accepted: 1, unrecognized: 1 });
      expect(facts.acceptedIds).toEqual(["note-1"]);
      expect(facts.historical[0]!.record).toEqual({ kind: "note", ts: LEGACY_NOTE_TS, text: "legacy migrated note" });
    }
  });

  test("concurrent distinct accepted records each appear exactly once in append order", async () => {
    shared.seed({ ledger: "" });
    const [first, second] = await Promise.all([
      appendWorkflowNote(shared.coordContext, shared.session, note("note-a", "alpha")),
      appendWorkflowNote(shared.coordContext, shared.session, note("note-b", "beta")),
    ]);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(false);
    const facts = normalizeWorkflowNotesCoverage({
      workflowId: WF,
      path: shared.ledgerPath,
      bytes: readFileSync(shared.ledgerPath),
    });
    expect(facts.records.map((entry) => ({ id: entry.record.id, text: entry.record.text })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "note-a", text: "alpha" }, { id: "note-b", text: "beta" },
    ]);
    expect(facts.duplicateIds).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * Authority, scope and target trust
 * ------------------------------------------------------------------------ */

describe("execution-ledgers: stale authority, scope and target trust", () => {
  test("a revoked session or a stale epoch refuses before any byte is written", async () => {
    const fixture = await notesFixture("revoked-and-stale");
    fixture.seed({ ledger: LEGACY_LINE });

    rawRun(
      fixture.context,
      `update execution_sessions set state = 'revoked' where workflow_id = '${WF}' and session_id = '${COORDINATOR_ID}'`,
    );
    const revoked = await refusalOf(() =>
      appendWorkflowNote(fixture.coordContext, fixture.session, note("note-1", "revoked session")),
    );
    expect(revoked.code).toBe("execution.session-unavailable");

    rawRun(fixture.context, "update store_meta set authority_epoch = authority_epoch + 1 where id = 1");
    const stale = await refusalOf(() =>
      appendWorkflowNote(fixture.coordContext, fixture.session, note("note-1", "stale epoch")),
    );
    expect(stale.code).toBe("store.stale-epoch");
    const facts = normalizeWorkflowNotesCoverage({
      workflowId: WF, path: fixture.ledgerPath, bytes: readFileSync(fixture.ledgerPath),
    });
    expect(facts.acceptedIds).toEqual([]);
    expect(facts.historical[0]!.record).toEqual({ kind: "note", ts: LEGACY_NOTE_TS, text: "legacy migrated note" });
  });

  test("an unauthorized, mismatched or stale call refuses before any IO or directory side effect", async () => {
    const fixture = await notesFixture("no-side-effect");
    const foreignWorkflow = await refusalOf(() =>
      appendWorkflowNote(fixture.coordContext, fixture.session, note("note-1", "body", { workflowId: "other-workflow" })),
    );
    expect(foreignWorkflow.code).toBe("execution-ledgers.scope-mismatch");

    const foreignSession = await refusalOf(() =>
      appendWorkflowNote(fixture.coordContext, fixture.session, note("note-1", "body", { sessionId: "other-session" })),
    );
    expect(foreignSession.code).toBe("execution-ledgers.scope-mismatch");

    const emptyId = await refusalOf(() => appendWorkflowNote(fixture.coordContext, fixture.session, note("", "body")));
    expect(emptyId.code).toBe("execution-ledgers.record-invalid");

    const unknownVersion = { ...note("note-1", "body"), version: 2 } as unknown as WorkflowNote;
    const versionRefusal = await refusalOf(() =>
      appendWorkflowNote(fixture.coordContext, fixture.session, unknownVersion),
    );
    expect(versionRefusal.code).toBe("execution-ledgers.record-invalid");

    // A stale epoch on a workflow with NO retained dir: the guard runs before
    // the body dir is created, so a refused session leaves no side effect.
    rawRun(fixture.context, "update store_meta set authority_epoch = authority_epoch + 1 where id = 1");
    const stale = await refusalOf(() =>
      appendWorkflowNote(fixture.coordContext, fixture.session, note("note-1", "stale epoch")),
    );
    expect(stale.code).toBe("store.stale-epoch");
    expect(existsSync(fixture.workflowDir)).toBe(false);
    expect(existsSync(join(fixture.harnessDir, "status.json"))).toBe(false);
  });

  test("a missing control root refuses with no directory side effect at all", async () => {
    // No store, no root: the call must not create the lock key's parent either.
    const missingRoot = join(ROOT, "missing-control-root");
    const context: ExecutionContext = { harnessDir: missingRoot, caller: coordinatorCaller() };
    const session: ExecutionSessionRef = {
      storeId: "store-missing",
      epoch: 1,
      workflowId: WF,
      role: "coordinator",
      sessionId: COORDINATOR_ID,
    };
    const refusal = await refusalOf(() => appendWorkflowNote(context, session, note("note-1", "body")));
    expect(refusal.code).toBe("execution-ledgers.target-untrusted");
    expect(existsSync(missingRoot)).toBe(false);
  });

  test("a symlinked workflow dir or ledger leaf refuses instead of writing through the link", async () => {
    const dirLink = await notesFixture("symlink-dir");
    const outside = join(dirLink.harnessDir, "outside");
    mkdirSync(join(dirLink.harnessDir, "workflows"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, dirLink.workflowDir, "dir");
    const dirRefusal = await refusalOf(() =>
      appendWorkflowNote(dirLink.coordContext, dirLink.session, note("note-1", "through the link")),
    );
    expect(dirRefusal.code).toBe("execution-ledgers.target-untrusted");
    expect(existsSync(join(outside, "notes.jsonl"))).toBe(false);

    const leafLink = await notesFixture("symlink-leaf");
    const outsideFile = join(leafLink.harnessDir, "outside-notes.jsonl");
    writeFileSync(outsideFile, "");
    leafLink.seed({});
    symlinkSync(outsideFile, leafLink.ledgerPath);
    const leafRefusal = await refusalOf(() =>
      appendWorkflowNote(leafLink.coordContext, leafLink.session, note("note-1", "through the link")),
    );
    expect(leafRefusal.code).toBe("execution-ledgers.target-untrusted");
  });

  test("holds the per-workflow file lock around read, dedup and append", async () => {
    shared.seed({ ledger: LEGACY_LINE });
    const lockDir = join(shared.workflowDir, ".status-write.lockdir");
    mkdirSync(lockDir);
    try {
      const blocked = await withEnv({ MSTAR_EXECUTION_LEDGER_LOCK_WAIT_MS: "60" }, () =>
        refusalOf(() => appendWorkflowNote(shared.coordContext, shared.session, note("note-1", "blocked"))),
      );
      expect(blocked.message).toContain(".status-write.lockdir");
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
    const accepted = await appendWorkflowNote(shared.coordContext, shared.session, note("note-1", "after release"));
    expect(accepted).toEqual({ id: "note-1", replayed: false });
  });
});

/* ------------------------------------------------------------------------ *
 * Coverage facts (C3)
 * ------------------------------------------------------------------------ */

describe("execution-ledgers: normalized coverage facts", () => {
  test("projects legacy and versioned records with file-hash identity in order", () => {
    const first = note("note-1", "one");
    const second = note("note-2", "two");
    const bytes = Buffer.from(`${LEGACY_LINE}${lineOf(first)}${lineOf(second)}`, "utf8");
    const path = `/fixture/workflows/${WF}/notes.jsonl`;
    const facts = normalizeWorkflowNotesCoverage({ workflowId: WF, path, bytes });

    expect(facts.version).toBe(1);
    expect(facts.protocol).toBe("notes-v1");
    expect(facts.workflowId).toBe(WF);
    expect(facts.path).toBe(path);
    expect(facts.format).toBe("mixed");
    expect(facts.bytes).toBe(bytes.length);
    expect(facts.counts).toEqual({ historical: 1, accepted: 2, unrecognized: 0 });
    expect(facts.tail).toBeNull();
    expect(facts.duplicateIds).toEqual([]);
    expect(facts.acceptedIds).toEqual(["note-1", "note-2"]);
    expect(facts.records.map((record) => record.lineIndex)).toEqual([1, 2]);
    expect(facts.records[0]!.record).toEqual(first);

    // Historical entries retain their ordered line identity and note content.
    expect(facts.historical).toHaveLength(1);
    const historical = facts.historical[0]!;
    expect(historical.identity.lineIndex).toBe(0);
    expect(historical.bytes).toBe(LEGACY_LINE.length - 1);
    expect(historical.format).toBe("legacy-note");
    expect(historical.record).toEqual({ kind: "note", ts: LEGACY_NOTE_TS, text: "legacy migrated note" });
  });

  test("distinguishes an absent, an empty and an unrecognized-only ledger", () => {
    const absent = normalizeWorkflowNotesCoverage({ workflowId: WF, path: "/fixture/notes.jsonl", bytes: null });
    expect(absent.format).toBe("absent");
    expect(absent.fileSha256).toBeNull();
    expect(absent.counts).toEqual({ historical: 0, accepted: 0, unrecognized: 0 });
    expect(absent.acceptedIds).toEqual([]);

    // A present, zero-byte ledger is a DIFFERENT fact: it has bytes (and a byte
    // hash) but no retained line, so coverage never reads it as no file at all.
    const empty = normalizeWorkflowNotesCoverage({
      workflowId: WF,
      path: "/fixture/notes.jsonl",
      bytes: Buffer.from("", "utf8"),
    });
    expect(empty.format).toBe("empty");
    expect(empty.bytes).toBe(0);
    expect(empty.counts).toEqual({ historical: 0, accepted: 0, unrecognized: 0 });

    // Content the ledger cannot classify is named, not folded into "absent".
    const foreignOnly = normalizeWorkflowNotesCoverage({
      workflowId: WF,
      path: "/fixture/notes.jsonl",
      bytes: Buffer.from("not json at all\n", "utf8"),
    });
    expect(foreignOnly.format).toBe("unrecognized");
    expect(foreignOnly.counts).toEqual({ historical: 1, accepted: 0, unrecognized: 1 });
    expect(foreignOnly.historical[0]!.format).toBe("unrecognized");

    const mixedForeign = normalizeWorkflowNotesCoverage({
      workflowId: WF,
      path: "/fixture/notes.jsonl",
      bytes: Buffer.from(`${LEGACY_LINE}not json at all\n`, "utf8"),
    });
    expect(mixedForeign.format).toBe("mixed");
    expect(mixedForeign.counts).toEqual({ historical: 2, accepted: 0, unrecognized: 1 });
  });

  test("reports an unaccepted tail and duplicated ids instead of hiding them", () => {
    const line = lineOf(note("note-1", "one"));
    const tailText = '{"version":1,"id":"note-2"';
    const withTail = normalizeWorkflowNotesCoverage({
      workflowId: WF,
      path: "/fixture/notes.jsonl",
      bytes: Buffer.from(`${line}${tailText}`, "utf8"),
    });
    expect(withTail.format).toBe("versioned");
    expect(withTail.acceptedIds).toEqual(["note-1"]);
    expect(withTail.tail?.bytes).toBe(tailText.length);

    const withDuplicate = normalizeWorkflowNotesCoverage({
      workflowId: WF,
      path: "/fixture/notes.jsonl",
      bytes: Buffer.from(`${line}${line}`, "utf8"),
    });
    expect(withDuplicate.acceptedIds).toEqual(["note-1", "note-1"]);
    expect(withDuplicate.duplicateIds).toEqual(["note-1"]);
  });
});
