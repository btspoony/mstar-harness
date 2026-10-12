/**
 * execution-ledgers.test.ts — fixtures for the retained workflow notes ledger
 * (phase2b-execution-contract §5 "F1 — notes").
 *
 * The ledger is a plain append log: repeated ids append repeated records, one
 * framed `O_APPEND` write lands a record, a short append fails without repairing
 * or truncating anything, and readers skip blank/partial/unrecognized content and
 * continue. No lock is taken, so no lock directory is ever created.
 *
 * Every case runs against a real active execution store in its own temporary
 * control root (the same `initializeStore` → `createExecutionWorkflow` →
 * `bindExecutionSession` fixture other engine suites use) plus real bytes on
 * disk. Nothing is mocked: the ledger bytes and the session/epoch rows are the
 * real ones.
 *
 * Resource discipline: the one fixture the ordinary cases share is built once
 * in `beforeAll`, and each case resets the retained bytes it needs with `seed`.
 * `node:sqlite` on this runtime releases a connection's descriptors only when
 * the connection object is collected, so a store per case would exhaust the
 * descriptor table of this process and turn a later store open into a spurious
 * `SQLITE_CANTOPEN`; the cases that genuinely need their own store (authority
 * mutation, a missing/symlinked body dir) each build one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  readExecutionState,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionSessionRef,
} from "./execution-store.js";
import { initializeStore, storeDbPath, type StoreContext } from "./store-db.js";
import type { WorkflowEntry } from "./status.js";
import type { WorkflowSnapshot } from "./workflow.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "mstar-execution-ledgers-")));
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
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
  const initialized = await readExecutionState(context);
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

/** The framed bytes one append writes into an already-existing leaf. */
function framedLineOf(record: WorkflowNote): string {
  return `\n${lineOf(record)}`;
}

function ledgerBytes(fixture: Fixture): Buffer {
  return readFileSync(fixture.ledgerPath);
}

function factsOf(fixture: Fixture, bytes: Buffer = ledgerBytes(fixture)) {
  return normalizeWorkflowNotesCoverage({ workflowId: WF, path: fixture.ledgerPath, bytes });
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
 * Location, framing and byte preservation
 * ------------------------------------------------------------------------ */

describe("execution-ledgers: canonical location and framed bytes", () => {
  test("resolves the canonical notes.jsonl path under the control root", () => {
    expect(workflowNotesLedgerPath(shared.context, WF)).toBe(join(shared.harnessDir, "workflows", WF, "notes.jsonl"));
  });

  test("preserves historical notes and inline row notes while appending one framed record", async () => {
    shared.seed({ ledger: LEGACY_LINE, snapshot: LEGACY_SNAPSHOT });
    const receipt = await appendWorkflowNote(shared.coordContext, shared.session, note("note-1", "first note"));
    expect(receipt).toEqual({ id: "note-1" });
    // The retained historical bytes and the inline row notes are untouched.
    expect(ledgerBytes(shared).toString("utf8")).toBe(`${LEGACY_LINE}${framedLineOf(note("note-1", "first note"))}`);
    const facts = factsOf(shared);
    expect(facts.records.map((entry) => entry.record.text)).toEqual(["first note"]);
    expect(facts.historical.map((entry) => entry.record)).toEqual([
      { kind: "note", ts: LEGACY_NOTE_TS, text: "legacy migrated note" },
    ]);
    const snapshotDoc = JSON.parse(readFileSync(join(shared.workflowDir, "snapshot.json"), "utf8")) as { plans: Array<{ notes: string[] }> };
    expect(snapshotDoc.plans[0]!.notes).toEqual(["inline legacy row note", "second inline note"]);
  });

  test("creates a fresh leaf with its own boundary byte and no lock directory", async () => {
    const fresh = await notesFixture("fresh-workflow");
    expect(existsSync(fresh.workflowDir)).toBe(false);

    const receipt = await appendWorkflowNote(fresh.coordContext, fresh.session, note("note-first", "first note"));
    expect(receipt).toEqual({ id: "note-first" });
    // The creator's frame carries the same boundary as every other append: the
    // leaf is not private between the open and the write.
    expect(ledgerBytes(fresh).toString("utf8")).toBe(`\n${lineOf(note("note-first", "first note"))}`);
    // The body dir holds the retained ledger and nothing else: no snapshot, no
    // session envelope, no authority file, and no lock directory.
    expect(readdirSync(fresh.workflowDir)).toEqual(["notes.jsonl"]);
    expect(existsSync(join(fresh.harnessDir, "status.json"))).toBe(false);
    expect(existsSync(join(fresh.harnessDir, ".execution-maintenance"))).toBe(false);
  });

  test("records coordinator provenance in the workflow ledger", async () => {
    shared.seed({ ledger: "" });
    await appendWorkflowNote(shared.coordContext, shared.session, note("coordinator-note", "from the coordinator"));
    const facts = factsOf(shared);
    expect(facts.records.map((entry) => entry.record.sessionId)).toEqual([COORDINATOR_ID]);
    expect(facts.records.map((entry) => entry.record.workflowId)).toEqual([WF]);
  });
});

/* ------------------------------------------------------------------------ *
 * Plain log semantics: duplicates, partial tails, short writes
 * ------------------------------------------------------------------------ */

describe("execution-ledgers: plain-log append semantics", () => {
  test("a repeated id appends a second record instead of replaying", async () => {
    shared.seed({ ledger: "" });
    expect(await appendWorkflowNote(shared.coordContext, shared.session, note("note-dup", "first body"))).toEqual({ id: "note-dup" });
    expect(await appendWorkflowNote(shared.coordContext, shared.session, note("note-dup", "first body"))).toEqual({ id: "note-dup" });
    expect(await appendWorkflowNote(shared.coordContext, shared.session, note("note-dup", "a different body"))).toEqual({ id: "note-dup" });
    const facts = factsOf(shared);
    expect(facts.records.map((entry) => entry.record.text)).toEqual(["first body", "first body", "a different body"]);
    expect(facts.records.map((entry) => entry.id)).toEqual(["note-dup", "note-dup", "note-dup"]);
    expect(facts.counts.unrecognized).toBe(0);
  });

  test("a record appended after a partial peer line is still its own readable record", async () => {
    // A peer stopped mid-record: no LF, so its bytes are an unterminated tail.
    const partial = '{"version":1,"id":"peer-partial","text":"neve';
    shared.seed({ ledger: `${LEGACY_LINE}${partial}` });

    expect(await appendWorkflowNote(shared.coordContext, shared.session, note("note-after", "after the partial"))).toEqual({ id: "note-after" });
    // Every retained byte survives, and the boundary LF terminates the peer's
    // partial line rather than fusing it with this record.
    expect(ledgerBytes(shared).toString("utf8")).toBe(`${LEGACY_LINE}${partial}${framedLineOf(note("note-after", "after the partial"))}`);

    const facts = factsOf(shared);
    expect(facts.records.map((entry) => entry.record.text)).toEqual(["after the partial"]);
    expect(facts.counts.unrecognized).toBe(1);
    expect(facts.tail).toBeNull();

    // A further record keeps the same property.
    expect(await appendWorkflowNote(shared.coordContext, shared.session, note("note-next", "and the next"))).toEqual({ id: "note-next" });
    expect(factsOf(shared).records.map((entry) => entry.record.text)).toEqual(["after the partial", "and the next"]);
  });

  test("readers skip blank and unrecognized lines and continue to later records", async () => {
    shared.seed({ ledger: `\nnot json at all\n\n${lineOf(note("note-real", "real body"))}\n${JSON.stringify({ kind: "something-else" })}\n` });
    const facts = factsOf(shared);
    expect(facts.records.map((entry) => entry.record.id)).toEqual(["note-real"]);
    expect(facts.counts).toEqual({ historical: 2, records: 1, unrecognized: 2 });
    expect(facts.format).toBe("mixed");

    // The same reader continues past that content when a new record lands.
    expect(await appendWorkflowNote(shared.coordContext, shared.session, note("note-later", "after noise"))).toEqual({ id: "note-later" });
    expect(factsOf(shared).records.map((entry) => entry.record.id)).toEqual(["note-real", "note-later"]);
  });

  test("a short append refuses and never repairs or truncates a peer's bytes", async () => {
    const peer = note("note-peer", "peer body");
    shared.seed({ ledger: lineOf(peer) });
    const before = ledgerBytes(shared);
    const target = note("note-short", "a body long enough to be cut");
    const refusal = await withEnv({ MSTAR_LEDGER_WRITE_CAPACITY_BYTES: "12" }, () =>
      refusalOf(() => appendWorkflowNote(shared.coordContext, shared.session, target)),
    );
    expect(refusal.code).toBe("execution-ledgers.append-short");
    const after = ledgerBytes(shared);
    // The peer's complete record is byte-identical, and exactly the bytes the
    // short write accepted were appended — nothing was rolled back or repaired.
    expect(after.subarray(0, before.length)).toEqual(before);
    expect(after.toString("utf8")).toBe(`${before.toString("utf8")}${framedLineOf(target).slice(0, 12)}`);

    // The damage is confined to that attempt: its partial bytes stay visible as
    // one unrecognized line, and the next append still lands after them.
    expect(await appendWorkflowNote(shared.coordContext, shared.session, note("note-after-short", "after the short write"))).toEqual({
      id: "note-after-short",
    });
    const facts = factsOf(shared);
    expect(facts.records.map((entry) => entry.record.id)).toEqual(["note-peer", "note-after-short"]);
    expect(facts.counts.unrecognized).toBe(1);
    expect(facts.tail).toBeNull();
  });

  test("an opened ledger replaced by a new inode refuses before writing", async () => {
    const original = `${LEGACY_LINE}${lineOf(note("note-1", "body"))}`;
    shared.seed({ ledger: original });
    const refusal = await withEnv({ MSTAR_LEDGER_REPLACE_BEFORE_COMMIT: shared.ledgerPath }, () =>
      refusalOf(() => appendWorkflowNote(shared.coordContext, shared.session, note("note-1", "body"))),
    );
    expect(refusal.code).toBe("execution-ledgers.target-replaced");
    expect(ledgerBytes(shared).toString("utf8")).toBe("replacement inode canonical bytes\n");
    expect(readFileSync(`${shared.ledgerPath}.displaced`, "utf8")).toBe(original);
  });

  test("a peer's partial write between the creator's open and its write still leaves the note readable", async () => {
    // Deterministic interleaving of the two real writers: the creator opens the
    // absent leaf, this process's seam lets a REAL child process write a partial
    // record into it, and only then does the creator write its own frame.
    const fixture = await notesFixture("creator-peer-interleave");
    expect(existsSync(fixture.workflowDir)).toBe(false);
    const partial = '{"version":1,"id":"peer-partial","workflowId":"' + WF + '","sessionId":"peer","kind":"note","ts":"' + TS + '","text":"neve';
    const peerScript = join(ROOT, "peer-partial.mjs");
    writeFileSync(
      peerScript,
      `
import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2], ${JSON.stringify(partial)}, "utf8");
`,
    );

    const target = note("note-creator", "creator body");
    await withEnv({ MSTAR_LEDGER_PEER_PARTIAL_SCRIPT: peerScript }, () =>
      appendWorkflowNote(fixture.coordContext, fixture.session, target),
    );

    // Every peer byte survives, and the creator's acknowledged note is still its
    // own readable record rather than fused to the peer's unterminated JSON.
    const text = ledgerBytes(fixture).toString("utf8");
    expect(text.startsWith(partial)).toBe(true);
    const facts = factsOf(fixture);
    expect(facts.records.map((entry) => entry.record.id)).toEqual(["note-creator"]);
    expect(facts.records[0]!.record.text).toBe("creator body");
    expect(facts.counts.unrecognized).toBe(1);
    expect(facts.tail).toBeNull();
  }, 30_000);

  test("an append takes no lock, so a leftover lock directory is irrelevant", async () => {
    const fixture = await notesFixture("leftover-lockdir");
    fixture.seed({ ledger: LEGACY_LINE });
    // A directory from the retired lock protocol: ordinary appends neither read,
    // respect nor remove it.
    const leftover = join(fixture.workflowDir, ".status-write.lockdir");
    mkdirSync(leftover);
    expect(await appendWorkflowNote(fixture.coordContext, fixture.session, note("note-1", "unblocked"))).toEqual({ id: "note-1" });
    expect(existsSync(leftover)).toBe(true);
    expect(factsOf(fixture).records.map((entry) => entry.record.id)).toEqual(["note-1"]);
  });
});

/* ------------------------------------------------------------------------ *
 * Concurrency: real child processes
 * ------------------------------------------------------------------------ */

describe("execution-ledgers: concurrent real processes", () => {
  test("barrier-released child processes each land their own readable record", async () => {
    const fixture = await notesFixture("concurrent-children");
    fixture.seed({ ledger: "" });
    const childCount = 6;
    const worker = join(ROOT, "append-worker.mjs");
    writeFileSync(
      worker,
      `
import { appendWorkflowNote } from ${JSON.stringify(join(SRC_DIR, "execution-ledgers.ts"))};
const [harnessDir, sessionJson, index] = process.argv.slice(2);
const session = JSON.parse(sessionJson);
const context = { harnessDir, caller: { sessionId: session.sessionId, role: session.role, workflowId: session.workflowId } };
// Announce readiness, then block on the parent's release line: every child
// appends only after all of them are waiting, so the writes truly overlap.
process.stdout.write("ready\\n");
const reader = Bun.stdin.stream().getReader();
await reader.read();
reader.releaseLock();
const receipt = await appendWorkflowNote(context, session, {
  version: 1, id: \`child-\${index}\`, workflowId: session.workflowId, sessionId: session.sessionId,
  kind: "note", ts: "2026-09-22T00:00:00.000Z", text: \`child \${index} body\`,
});
process.stdout.write(JSON.stringify(receipt));
`,
    );
    const children = Array.from({ length: childCount }, (_, index) => {
      const child = spawn("bun", [worker, fixture.harnessDir, JSON.stringify(fixture.session), String(index)], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let announced: () => void = () => {};
      const ready = new Promise<void>((resolve) => { announced = resolve; });
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.includes("ready\n")) announced();
      });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
      return {
        index,
        ready,
        write: (line: string) => child.stdin.write(line),
        done: closed.then((status) => ({ status, stdout, stderr })),
      };
    });
    // Release every child only once each one has reached the barrier.
    await Promise.all(children.map((child) => child.ready));
    for (const child of children) child.write("go\n");

    const results = await Promise.all(children.map((child) => child.done));
    for (const [position, result] of results.entries()) {
      expect(result.stderr).toBe("");
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.slice("ready\n".length))).toEqual({ id: `child-${position}` });
    }

    const facts = factsOf(fixture);
    expect(facts.counts.unrecognized).toBe(0);
    expect(facts.tail).toBeNull();
    expect([...facts.records.map((entry) => entry.id)].sort()).toEqual(
      Array.from({ length: childCount }, (_, index) => `child-${index}`).sort(),
    );
  }, 60_000);
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
    expect(ledgerBytes(fixture).toString("utf8")).toBe(LEGACY_LINE);
    expect(factsOf(fixture).records).toEqual([]);
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
    expect(existsSync(join(fixture.harnessDir, ".execution-maintenance"))).toBe(false);
  });

  test("a missing control root refuses with no directory side effect at all", async () => {
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
    expect(readFileSync(outsideFile, "utf8")).toBe("");
  });
});

/* ------------------------------------------------------------------------ *
 * Coverage facts
 * ------------------------------------------------------------------------ */

describe("execution-ledgers: normalized coverage facts", () => {
  test("projects legacy and new-format records with file-hash identity in order", () => {
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
    expect(facts.counts).toEqual({ historical: 1, records: 2, unrecognized: 0 });
    expect(facts.tail).toBeNull();
    expect(facts.records.map((entry) => entry.lineIndex)).toEqual([1, 2]);
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
    expect(absent.counts).toEqual({ historical: 0, records: 0, unrecognized: 0 });

    // A present, zero-byte ledger is a DIFFERENT fact: it has bytes (and a byte
    // hash) but no retained line, so coverage never reads it as no file at all.
    const empty = normalizeWorkflowNotesCoverage({
      workflowId: WF,
      path: "/fixture/notes.jsonl",
      bytes: Buffer.from("", "utf8"),
    });
    expect(empty.format).toBe("empty");
    expect(empty.bytes).toBe(0);
    expect(empty.counts).toEqual({ historical: 0, records: 0, unrecognized: 0 });

    // A blank-only surface is the writer's own framing: skipped, not corruption.
    const blanks = normalizeWorkflowNotesCoverage({
      workflowId: WF,
      path: "/fixture/notes.jsonl",
      bytes: Buffer.from("\n\n", "utf8"),
    });
    expect(blanks.format).toBe("empty");
    expect(blanks.counts).toEqual({ historical: 0, records: 0, unrecognized: 0 });

    // Content the ledger cannot classify is named, not folded into "absent".
    const foreignOnly = normalizeWorkflowNotesCoverage({
      workflowId: WF,
      path: "/fixture/notes.jsonl",
      bytes: Buffer.from("not json at all\n", "utf8"),
    });
    expect(foreignOnly.format).toBe("unrecognized");
    expect(foreignOnly.counts).toEqual({ historical: 1, records: 0, unrecognized: 1 });
    expect(foreignOnly.historical[0]!.format).toBe("unrecognized");

    const mixedForeign = normalizeWorkflowNotesCoverage({
      workflowId: WF,
      path: "/fixture/notes.jsonl",
      bytes: Buffer.from(`${LEGACY_LINE}not json at all\n`, "utf8"),
    });
    expect(mixedForeign.format).toBe("mixed");
    expect(mixedForeign.counts).toEqual({ historical: 2, records: 0, unrecognized: 1 });
  });

  test("reports a partial tail and repeated ids as physical facts", () => {
    const line = lineOf(note("note-1", "one"));
    const tailText = '{"version":1,"id":"note-2"';
    const withTail = normalizeWorkflowNotesCoverage({
      workflowId: WF,
      path: "/fixture/notes.jsonl",
      bytes: Buffer.from(`${line}${tailText}`, "utf8"),
    });
    expect(withTail.format).toBe("versioned");
    expect(withTail.records.map((entry) => entry.id)).toEqual(["note-1"]);
    expect(withTail.tail?.bytes).toBe(tailText.length);

    const withRepeat = normalizeWorkflowNotesCoverage({
      workflowId: WF,
      path: "/fixture/notes.jsonl",
      bytes: Buffer.from(`${line}${line}`, "utf8"),
    });
    // A repeated id is two ordinary records — the log claims no dedup.
    expect(withRepeat.records.map((entry) => entry.id)).toEqual(["note-1", "note-1"]);
    expect(withRepeat.counts).toEqual({ historical: 0, records: 2, unrecognized: 0 });
  });
});
