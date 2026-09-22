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
 * Observables asserted here are the contract's: preserved legacy bytes and
 * order, the canonical versioned record format, append order, once-only
 * accepted records across concurrency and crash replay, refusal of an
 * unreconcilable tail without discarding accepted bytes, stale/revoked
 * authority refusal with no directory side effect, target trust (symlink)
 * refusal, the workflow file lock, the untouched inline row notes, and the
 * normalized coverage facts C3 pins.
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
import { createHash } from "node:crypto";
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
const PLAN_PM_ID = "host-notes-plan";
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
  /** A second, distinct active session of the same workflow (raw plan-pm row). */
  planSession: ExecutionSessionRef;
  planContext: ExecutionContext;
  /** Plant the exact retained bytes an append under test must respect. */
  seed: (input: { ledger?: string; snapshot?: string }) => void;
};

function coordinatorCaller(): ExecutionCaller {
  return { sessionId: COORDINATOR_ID, role: "coordinator", workflowId: WF, planId: null };
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
 * One real active authority with a created workflow and two distinct active
 * sessions. The retained workflow dir is NOT created here: the cases that need
 * it plant it through `seed`, so "no directory side effect" stays observable.
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
    planId: null,
    role: "coordinator",
    expected: workflow.workflowToken,
    operationId: `bind-${label}`,
  });
  // The second session is a real active `execution_sessions` row of the same
  // workflow (the raw fixture row the store's own tests use) so the ledger can
  // be shown to keep two distinct sessions' provenance apart.
  const raw = new DatabaseSync(storeDbPath(context));
  try {
    raw
      .prepare(
        "insert into execution_sessions(workflow_id, role, session_id, plan_id, epoch, revision, state, bound_at) " +
          "values (?, 'plan-pm', ?, ?, ?, 1, 'active', ?)",
      )
      .run(WF, PLAN_PM_ID, PLAN_ID, bound.data.epoch, TS);
  } finally {
    raw.close();
  }
  const planCaller: ExecutionCaller = { sessionId: PLAN_PM_ID, role: "plan-pm", workflowId: WF, planId: PLAN_ID };
  const planSession: ExecutionSessionRef = {
    storeId: bound.data.storeId,
    epoch: bound.data.epoch,
    workflowId: WF,
    role: "plan-pm",
    sessionId: PLAN_PM_ID,
    planId: PLAN_ID,
  };
  const workflowDir = join(harnessDir, "workflows", WF);
  return {
    context,
    harnessDir,
    workflowDir,
    ledgerPath: join(workflowDir, "notes.jsonl"),
    session: bound.data,
    coordContext: callerContext(harnessDir, caller),
    planSession,
    planContext: callerContext(harnessDir, planCaller),
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

function sha256OfText(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** Every LF-terminated line of the retained bytes, in order. */
function completeLines(bytes: Buffer | null): string[] {
  if (bytes === null) return [];
  const text = bytes.toString("utf8");
  return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n").slice(0, -1);
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

  test("appends one versioned record after the preserved legacy bytes and never rewrites history", async () => {
    shared.seed({ ledger: LEGACY_LINE, snapshot: LEGACY_SNAPSHOT });
    const snapshotPath = join(shared.workflowDir, "snapshot.json");
    const snapshotBefore = readFileSync(snapshotPath);

    const first = await appendWorkflowNote(shared.coordContext, shared.session, note("note-1", "first note"));
    expect(first).toEqual({ id: "note-1", replayed: false });

    const after = readFileSync(shared.ledgerPath);
    expect(after.subarray(0, LEGACY_LINE.length).toString("utf8")).toBe(LEGACY_LINE);
    expect(completeLines(after)).toEqual([LEGACY_LINE.slice(0, -1), lineOf(note("note-1", "first note")).slice(0, -1)]);

    // Same id, same body: a replay — no second line, no byte change.
    const replay = await appendWorkflowNote(shared.coordContext, shared.session, note("note-1", "first note"));
    expect(replay).toEqual({ id: "note-1", replayed: true });
    expect(readFileSync(shared.ledgerPath).equals(after)).toBe(true);

    // The inline PlanRow notes of the retained snapshot are a distinct core
    // field: this writer never touches them.
    expect(readFileSync(snapshotPath).equals(snapshotBefore)).toBe(true);
    const snapshotDoc = JSON.parse(snapshotBefore.toString("utf8")) as { plans: Array<{ notes: string[] }> };
    expect(snapshotDoc.plans[0]!.notes).toEqual(["inline legacy row note", "second inline note"]);
  });

  test("keeps each distinct bound session's provenance in one ledger", async () => {
    shared.seed({ ledger: "" });
    await appendWorkflowNote(shared.coordContext, shared.session, note("coordinator-note", "from the coordinator"));
    await appendWorkflowNote(
      shared.planContext,
      shared.planSession,
      note("plan-note", "from the plan session", { sessionId: PLAN_PM_ID }),
    );
    const facts = normalizeWorkflowNotesCoverage({
      workflowId: WF,
      path: shared.ledgerPath,
      bytes: readFileSync(shared.ledgerPath),
    });
    expect(facts.acceptedIds).toEqual(["coordinator-note", "plan-note"]);
    expect(facts.records.map((record) => record.record.sessionId)).toEqual([COORDINATOR_ID, PLAN_PM_ID]);
    expect(facts.records.map((record) => record.record.workflowId)).toEqual([WF, WF]);
  });

  test("a fresh workflow's first note creates only its own body dir", async () => {
    // A workflow created through the DB route has no retained dir yet.
    const fresh = await notesFixture("fresh-workflow");
    expect(existsSync(fresh.workflowDir)).toBe(false);

    const accepted = await appendWorkflowNote(fresh.coordContext, fresh.session, note("note-first", "first note"));
    expect(accepted).toEqual({ id: "note-first", replayed: false });
    expect(existsSync(fresh.workflowDir)).toBe(true);
    expect(completeLines(readFileSync(fresh.ledgerPath))).toEqual([lineOf(note("note-first", "first note")).slice(0, -1)]);
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
    const before = readFileSync(shared.ledgerPath);
    const refusal = await refusalOf(() =>
      appendWorkflowNote(shared.coordContext, shared.session, note("note-1", "changed body")),
    );
    expect(refusal.code).toBe("execution-ledgers.id-conflict");
    expect(readFileSync(shared.ledgerPath).equals(before)).toBe(true);
  });

  test("an accepted id recorded twice refuses the append", async () => {
    shared.seed({ ledger: `${lineOf(note("note-dup", "body"))}${lineOf(note("note-dup", "other body"))}` });
    const before = readFileSync(shared.ledgerPath);
    const refusal = await refusalOf(() =>
      appendWorkflowNote(shared.coordContext, shared.session, note("note-new", "fresh")),
    );
    expect(refusal.code).toBe("execution-ledgers.ledger-foreign");
    expect(readFileSync(shared.ledgerPath).equals(before)).toBe(true);
  });

  test("a crash-cut partial line of the same record is reconciled into exactly one accepted line", async () => {
    const target = note("note-crash", "interrupted append");
    const full = lineOf(target);

    // A crash after the JSON bytes but before the LF.
    shared.seed({ ledger: `${LEGACY_LINE}${full.slice(0, -1)}` });
    const completed = await appendWorkflowNote(shared.coordContext, shared.session, target);
    expect(completed).toEqual({ id: "note-crash", replayed: false });
    const bytes = readFileSync(shared.ledgerPath);
    expect(bytes.subarray(0, LEGACY_LINE.length).toString("utf8")).toBe(LEGACY_LINE);
    expect(completeLines(bytes)).toEqual([LEGACY_LINE.slice(0, -1), full.slice(0, -1)]);
    expect(bytes.toString("utf8").endsWith("\n")).toBe(true);

    // A crash in the middle of the same record's bytes.
    shared.seed({ ledger: `${LEGACY_LINE}${full.slice(0, 24)}` });
    const reconciled = await appendWorkflowNote(shared.coordContext, shared.session, target);
    expect(reconciled).toEqual({ id: "note-crash", replayed: false });
    expect(completeLines(readFileSync(shared.ledgerPath))).toEqual([LEGACY_LINE.slice(0, -1), full.slice(0, -1)]);

    // The same retry again is a plain replay: the accepted record is not duplicated.
    const retried = await appendWorkflowNote(shared.coordContext, shared.session, target);
    expect(retried).toEqual({ id: "note-crash", replayed: true });
    expect(completeLines(readFileSync(shared.ledgerPath))).toHaveLength(2);
  });

  test("an unterminated tail that is not this record's partial refuses without discarding bytes", async () => {
    const seedText = `${LEGACY_LINE}{"version":1,"id":"zz-other"`;
    shared.seed({ ledger: seedText });
    const before = readFileSync(shared.ledgerPath);
    const refusal = await refusalOf(() =>
      appendWorkflowNote(shared.coordContext, shared.session, note("note-1", "body")),
    );
    expect(refusal.code).toBe("execution-ledgers.tail-unreconciled");
    expect(readFileSync(shared.ledgerPath).equals(before)).toBe(true);
    expect(readFileSync(shared.ledgerPath).toString("utf8")).toBe(seedText);
  });

  test("a foreign or malformed retained line refuses the append", async () => {
    shared.seed({ ledger: `${LEGACY_LINE}${JSON.stringify({ kind: "something-else", payload: 1 })}\n` });
    const before = readFileSync(shared.ledgerPath);
    const foreign = await refusalOf(() =>
      appendWorkflowNote(shared.coordContext, shared.session, note("note-1", "body")),
    );
    expect(foreign.code).toBe("execution-ledgers.ledger-foreign");
    expect(readFileSync(shared.ledgerPath).equals(before)).toBe(true);

    shared.seed({ ledger: `${LEGACY_LINE}not json at all\n` });
    const malformedBefore = readFileSync(shared.ledgerPath);
    const malformed = await refusalOf(() =>
      appendWorkflowNote(shared.coordContext, shared.session, note("note-1", "body")),
    );
    expect(malformed.code).toBe("execution-ledgers.ledger-foreign");
    expect(readFileSync(shared.ledgerPath).equals(malformedBefore)).toBe(true);
  });

  test("concurrent distinct accepted records each appear exactly once in append order", async () => {
    shared.seed({ ledger: "" });
    const [first, second] = await Promise.all([
      appendWorkflowNote(shared.coordContext, shared.session, note("note-a", "alpha")),
      appendWorkflowNote(shared.coordContext, shared.session, note("note-b", "beta")),
    ]);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(false);
    const lines = completeLines(readFileSync(shared.ledgerPath));
    expect(lines).toHaveLength(2);
    expect(new Set(lines)).toEqual(
      new Set([lineOf(note("note-a", "alpha")).slice(0, -1), lineOf(note("note-b", "beta")).slice(0, -1)]),
    );
    const facts = normalizeWorkflowNotesCoverage({
      workflowId: WF,
      path: shared.ledgerPath,
      bytes: readFileSync(shared.ledgerPath),
    });
    // The file's own order IS the accepted append order, with no duplicate id.
    const ids = lines.map((line) => {
      const record = JSON.parse(line) as { id: string };
      return record.id;
    });
    expect(facts.acceptedIds).toEqual(ids);
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
    expect(readFileSync(fixture.ledgerPath).toString("utf8")).toBe(LEGACY_LINE);

    rawRun(fixture.context, "update store_meta set authority_epoch = authority_epoch + 1 where id = 1");
    const stale = await refusalOf(() =>
      appendWorkflowNote(fixture.coordContext, fixture.session, note("note-1", "stale epoch")),
    );
    expect(stale.code).toBe("store.stale-epoch");
    expect(readFileSync(fixture.ledgerPath).toString("utf8")).toBe(LEGACY_LINE);
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
    expect(readFileSync(outsideFile).toString("utf8")).toBe("");
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
      expect(readFileSync(shared.ledgerPath).toString("utf8")).toBe(LEGACY_LINE);
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
    expect(facts.counts).toEqual({ historical: 1, accepted: 2 });
    expect(facts.tail).toBeNull();
    expect(facts.duplicateIds).toEqual([]);
    expect(facts.acceptedIds).toEqual(["note-1", "note-2"]);
    expect(facts.records.map((record) => record.lineIndex)).toEqual([1, 2]);
    expect(facts.records[0]!.record).toEqual(first);
    expect(facts.records[0]!.sha256).toBe(sha256OfText(lineOf(first).slice(0, -1)));

    // Historical identity is (source-file-sha256, line-index) and the line hash
    // is over the exact line bytes excluding the final LF.
    expect(facts.historical).toHaveLength(1);
    const historical = facts.historical[0]!;
    expect(historical.identity).toEqual({ sourceFileSha256: facts.fileSha256!, lineIndex: 0 });
    expect(historical.bytes).toBe(LEGACY_LINE.length - 1);
    expect(historical.format).toBe("legacy-note");
    expect(historical.record).toEqual({ kind: "note", ts: LEGACY_NOTE_TS, text: "legacy migrated note" });
    expect(historical.sha256).toBe(sha256OfText(LEGACY_LINE.slice(0, -1)));
  });

  test("reports an absent ledger, an unaccepted tail and duplicated ids instead of hiding them", () => {
    const absent = normalizeWorkflowNotesCoverage({ workflowId: WF, path: "/fixture/notes.jsonl", bytes: null });
    expect(absent.format).toBe("absent");
    expect(absent.fileSha256).toBeNull();
    expect(absent.counts).toEqual({ historical: 0, accepted: 0 });
    expect(absent.acceptedIds).toEqual([]);

    const line = lineOf(note("note-1", "one"));
    const tailText = '{"version":1,"id":"note-2"';
    const withTail = normalizeWorkflowNotesCoverage({
      workflowId: WF,
      path: "/fixture/notes.jsonl",
      bytes: Buffer.from(`${line}${tailText}`, "utf8"),
    });
    expect(withTail.format).toBe("versioned");
    expect(withTail.acceptedIds).toEqual(["note-1"]);
    expect(withTail.tail).toEqual({ sha256: sha256OfText(tailText), bytes: tailText.length });

    const withDuplicate = normalizeWorkflowNotesCoverage({
      workflowId: WF,
      path: "/fixture/notes.jsonl",
      bytes: Buffer.from(`${line}${line}`, "utf8"),
    });
    expect(withDuplicate.acceptedIds).toEqual(["note-1", "note-1"]);
    expect(withDuplicate.duplicateIds).toEqual(["note-1"]);
  });
});
