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
 * disk. The store, the session/epoch rows, the ledger bytes and every child
 * process are the real ones; the only instrumented thing is this module's own
 * sink, spied from the test file for the two boundaries that need a deterministic
 * interleaving (a peer's partial write, an inode replacement) and for a short
 * write. Production exposes no hook, option or environment knob for any of
 * them: the writer requests the whole frame and never reads the invocation
 * environment.
 *
 * Resource discipline: the one fixture the ordinary cases share is built once
 * in `beforeAll`, and each case resets the retained bytes it needs with `seed`.
 * `node:sqlite` on this runtime releases a connection's descriptors only when
 * the connection object is collected, so a store per case would exhaust the
 * descriptor table of this process and turn a later store open into a spurious
 * `SQLITE_CANTOPEN`; the cases that genuinely need their own store (authority
 * mutation, a missing/symlinked body dir) each build one.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
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
  WORKFLOW_NOTES_COMPACTION_MARKER_KIND,
  WORKFLOW_NOTES_LEDGER_MAX_BYTES,
  WORKFLOW_NOTES_LEDGER_READ_BYTES,
  appendWorkflowNote,
  normalizeWorkflowNotesCoverage,
  workflowNotesLedgerPath,
  type WorkflowNote,
} from "./execution-ledgers.js";
import { sha256Bytes } from "./coordination-write.js";
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

/** The real platform functions, captured as values before any spy replaces them. */
const realFstatSync = nodeFs.fstatSync;
const realWriteSync = nodeFs.writeSync;
const realFsyncSync = nodeFs.fsyncSync;
const realRenameSync = nodeFs.renameSync;
const realWriteFileSync = nodeFs.writeFileSync;

/**
 * The sink boundaries this suite instruments: the single write call and the two
 * observations that frame it.
 */
type SinkHooks = Readonly<{
  /** Ask the descriptor write for this many bytes instead of the whole frame. */
  writeRequestedBytes?: number;
  /** Run once inside this ledger's own open→write window, before the frame lands. */
  onOpenVerified?: Readonly<{ ledgerPath: string; run: (ledgerPath: string) => void }>;
  /** Replace this ledger with a differently-named inode after its frame is fsynced. */
  replaceAfterFsync?: string;
}>;

/**
 * Whether `fd` currently names exactly this path — the writer's own ledger
 * descriptor rather than some other module's (the store's, say). Identity is
 * compared the same way the production path-identity check compares it, so an
 * instrumented boundary only ever fires for the append under test.
 */
function fdNamesPath(fd: number, path: string): boolean {
  try {
    const opened = realFstatSync(fd);
    const current = nodeFs.lstatSync(path);
    return opened.dev === current.dev && opened.ino === current.ino;
  } catch {
    return false;
  }
}

/**
 * Test-only instrumentation of this module's own platform calls, scoped to one
 * callback and always restored.
 *
 * Production reads no invocation environment and exposes no hook, export, option
 * or test mode, so the cases that need a deterministic boundary or a short write
 * install their own `node:fs` spies here. `spyOn` replaces the function on the
 * shared namespace, which is exactly what this module's own `node:fs` import
 * resolves through.
 */
async function withSinkInstrumentation<T>(hooks: SinkHooks, run: () => Promise<T>): Promise<T> {
  const spies: Array<{ mockRestore: () => void }> = [];
  if (hooks.writeRequestedBytes !== undefined) {
    const cap = hooks.writeRequestedBytes;
    spies.push(
      spyOn(nodeFs, "writeSync").mockImplementation((((fd: number, buffer: Buffer, offset: number, _length: number, position: number | null) =>
        realWriteSync(fd, buffer, offset, cap, position)) as never)),
    );
  }
  if (hooks.onOpenVerified !== undefined) {
    const { ledgerPath, run: interleave } = hooks.onOpenVerified;
    spies.push(
      spyOn(nodeFs, "fstatSync").mockImplementation(((fd: number) => {
        const opened = realFstatSync(fd);
        if (opened.isFile() && fdNamesPath(fd, ledgerPath)) interleave(ledgerPath);
        return opened;
      }) as never),
    );
  }
  if (hooks.replaceAfterFsync !== undefined) {
    const ledgerPath = hooks.replaceAfterFsync;
    spies.push(
      spyOn(nodeFs, "fsyncSync").mockImplementation(((fd: number) => {
        const synced = realFsyncSync(fd);
        if (fdNamesPath(fd, ledgerPath)) replaceLedgerAtBoundary(ledgerPath, "after-fsync");
        return synced;
      }) as never),
    );
  }
  try {
    return await run();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

/** Replace one path with a new inode carrying this test's own marker bytes. */
function replaceLedgerAtBoundary(path: string, stage: "before-commit" | "after-fsync"): void {
  const displaced = `${path}.displaced-${stage}`;
  const replacement = `${path}.replacement-${stage}`;
  realRenameSync(path, displaced);
  realWriteFileSync(replacement, `replacement inode canonical bytes (${stage})\n`);
  realRenameSync(replacement, path);
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
    // A short write (full filesystem, resource limit) is reproduced at the call
    // boundary: the same descriptor write is asked for 12 of the frame's bytes.
    const refusal = await withSinkInstrumentation(
      { writeRequestedBytes: 12 },
      () => refusalOf(() => appendWorkflowNote(shared.coordContext, shared.session, target)),
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
    // The boundary is reproduced at the writer's own last path observation: the
    // replacement happens inside the production open→verify sequence, and the
    // writer must refuse rather than accept a different inode.
    const refusal = await withSinkInstrumentation(
      {
        onOpenVerified: {
          ledgerPath: shared.ledgerPath,
          run: (ledgerPath) => replaceLedgerAtBoundary(ledgerPath, "before-commit"),
        },
      },
      () => refusalOf(() => appendWorkflowNote(shared.coordContext, shared.session, note("note-1", "body"))),
    );
    expect(refusal.code).toBe("execution-ledgers.target-replaced");
    expect(ledgerBytes(shared).toString("utf8")).toBe("replacement inode canonical bytes (before-commit)\n");
    expect(readFileSync(`${shared.ledgerPath}.displaced-before-commit`, "utf8")).toBe(original);
  });

  test("an atomic replacement after fsync refuses instead of issuing a success receipt", async () => {
    const original = `${LEGACY_LINE}${lineOf(note("note-fsync", "before replacement"))}`;
    shared.seed({ ledger: original });
    const refusal = await withSinkInstrumentation(
      { replaceAfterFsync: shared.ledgerPath },
      () => refusalOf(() => appendWorkflowNote(shared.coordContext, shared.session, note("note-fsync", "after fsync"))),
    );
    expect(refusal.code).toBe("execution-ledgers.target-replaced");
    expect(ledgerBytes(shared).toString("utf8")).toBe("replacement inode canonical bytes (after-fsync)\n");
    const displaced = readFileSync(`${shared.ledgerPath}.displaced-after-fsync`, "utf8");
    expect(displaced).toContain(lineOf(note("note-fsync", "after fsync")));
    expect(ledgerBytes(shared).toString("utf8")).not.toContain('"id":"note-fsync"');
  });

  test("a peer's partial write between the creator's open and its write still leaves the note readable", async () => {
    // Deterministic interleaving of two real writers: the creator opens the
    // absent leaf, this process's spy lets a REAL child process write a partial
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
    await withSinkInstrumentation(
      {
        onOpenVerified: {
          ledgerPath: fixture.ledgerPath,
          // A REAL child process writes a partial record into the leaf the
          // creator has just opened and verified, in its own process.
          run: (ledgerPath) => {
            spawnSync("bun", [peerScript, ledgerPath], { stdio: "ignore" });
          },
        },
      },
      () => appendWorkflowNote(fixture.coordContext, fixture.session, target),
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
 * Consumer-visible safety: hostile ambient test-control values
 * ------------------------------------------------------------------------ */

/** What the hostile-cwd driver reports back through its JSON stdout. */
type HostileAppendResult = Readonly<{
  ok: boolean;
  receipt?: { id: string };
  code?: string;
  message?: string;
  ambientControlKey: string | null;
}>;

/**
 * Run one ordinary authenticated `appendWorkflowNote` in a REAL Bun child whose
 * invocation cwd carries the given synthetic `.env`. The child's own environment
 * never exports a control key — the `.env` is the only carrier, which is exactly
 * how the reported attack works: Bun loads a directory-local `.env` before any
 * application code runs, so the key names only have to be plausible.
 */
function hostileAppendChild(fixture: Fixture, envLines: readonly string[], cwd: string): HostileAppendResult {
  writeFileSync(join(cwd, ".env"), `${envLines.join("\n")}\n`);
  const driver = join(cwd, "append-driver.mjs");
  writeFileSync(
    driver,
    `
import { appendWorkflowNote } from ${JSON.stringify(join(SRC_DIR, "execution-ledgers.ts"))};
const [harnessDir, sessionJson, id] = process.argv.slice(2);
const session = JSON.parse(sessionJson);
const context = { harnessDir, caller: { sessionId: session.sessionId, role: session.role, workflowId: session.workflowId } };
const ambientControlKey = process.env.MSTAR_STORE_TEST_RUNNER ?? null;
try {
  const receipt = await appendWorkflowNote(context, session, {
    version: 1, id, workflowId: session.workflowId, sessionId: session.sessionId,
    kind: "note", ts: "2026-09-22T00:00:00.000Z", text: "ordinary authenticated note",
  });
  process.stdout.write(JSON.stringify({ ok: true, receipt, ambientControlKey }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error?.code, message: String(error?.message), ambientControlKey }));
}
`,
  );
  const childEnv: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR"] as const) {
    const value = process.env[key];
    if (value !== undefined) childEnv[key] = value;
  }
  const child = spawnSync("bun", [driver, fixture.harnessDir, JSON.stringify(fixture.session), "note-hostile-env"], {
    cwd,
    env: childEnv,
    encoding: "utf8",
  });
  expect(child.stderr).toBe("");
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as HostileAppendResult;
}

/** The full hostile key set one `.env` can carry, aimed at this very ledger. */
function hostileEnvLines(fixture: Fixture, keys: readonly string[]): string[] {
  const values: Record<string, string> = {
    MSTAR_STORE_TEST_RUNNER: "1",
    MSTAR_LEDGER_PEER_PARTIAL_SCRIPT: "./payload.ts",
    MSTAR_LEDGER_REPLACE_BEFORE_COMMIT: fixture.ledgerPath,
    MSTAR_LEDGER_REPLACE_AFTER_FSYNC: fixture.ledgerPath,
    MSTAR_LEDGER_WRITE_CAPACITY_BYTES: "12",
  };
  return keys.map((key) => `${key}=${values[key]}`);
}

describe("execution-ledgers: hostile ambient environment", () => {
  test("test-control values in the invocation cwd .env execute nothing", async () => {
    // The ordinary fixture the other cases share: the append under attack is the
    // same ordinary, authenticated append every one of them exercises.
    shared.seed({ ledger: "" });
    const cwd = join(ROOT, "hostile-cwd-exec");
    mkdirSync(cwd, { recursive: true });
    const marker = join(cwd, "payload-marker.txt");
    const sentinel = "HOSTILE-ENV-PAYLOAD-RAN";
    writeFileSync(
      join(cwd, "payload.ts"),
      `
import { writeFileSync } from "node:fs";
writeFileSync(new URL("./payload-marker.txt", import.meta.url), ${JSON.stringify(sentinel)} + "\\n");
`,
    );

    // The control key AND the script key, exactly the pair the deleted
    // production seam executed; no replace key, so the seam's own early return
    // cannot hide the subprocess path.
    const result = hostileAppendChild(
      shared,
      hostileEnvLines(shared, ["MSTAR_STORE_TEST_RUNNER", "MSTAR_LEDGER_PEER_PARTIAL_SCRIPT"]),
      cwd,
    );
    // Precondition, not the assertion: the hostile `.env` really did reach the
    // launcher, so this case cannot pass vacuously.
    expect(result.ambientControlKey).toBe("1");

    // The ordinary authenticated append still lands its own complete framed record.
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.receipt).toEqual({ id: "note-hostile-env" });
    const facts = factsOf(shared);
    expect(facts.format).toBe("versioned");
    expect(facts.records.map((entry) => entry.record.id)).toEqual(["note-hostile-env"]);
    expect(facts.counts).toEqual({ historical: 0, records: 1, unrecognized: 0 });
    expect(facts.tail).toBeNull();
    expect(ledgerBytes(shared).toString("utf8")).toBe(framedLineOf(note("note-hostile-env", "ordinary authenticated note")));

    // Nothing ambient executed and nothing ambient wrote.
    expect(existsSync(marker)).toBe(false);
    expect(ledgerBytes(shared).toString("utf8")).not.toContain(sentinel);
  }, 30_000);

  test("test-control values in the invocation cwd .env cannot replace or shorten an ordinary append", async () => {
    // A clean fixture of its own: the shared one legitimately retains a
    // historical snapshot and the two displaced inodes of the replacement
    // regressions, so only a fresh body dir can assert "nothing else appeared".
    const fixture = await notesFixture("hostile-env-mutate");
    fixture.seed({ ledger: "" });
    const cwd = join(ROOT, "hostile-cwd-mutate");
    mkdirSync(cwd, { recursive: true });
    expect(readdirSync(fixture.workflowDir)).toEqual(["notes.jsonl"]);

    // Both inode-replacement keys name THIS ledger, and the write-capacity key
    // asks for 12 bytes: the deleted family would have replaced the leaf with
    // `replacement inode canonical bytes` and cut the frame in half.
    const result = hostileAppendChild(
      fixture,
      hostileEnvLines(fixture, [
        "MSTAR_STORE_TEST_RUNNER",
        "MSTAR_LEDGER_REPLACE_BEFORE_COMMIT",
        "MSTAR_LEDGER_REPLACE_AFTER_FSYNC",
        "MSTAR_LEDGER_WRITE_CAPACITY_BYTES",
      ]),
      cwd,
    );
    expect(result.ambientControlKey).toBe("1");
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.receipt).toEqual({ id: "note-hostile-env" });

    // The whole frame landed, in the ledger the caller named, with no displaced
    // or replacement inode and no shortened write anywhere in the body dir.
    expect(ledgerBytes(fixture).toString("utf8")).toBe(framedLineOf(note("note-hostile-env", "ordinary authenticated note")));
    expect(readdirSync(fixture.workflowDir)).toEqual(["notes.jsonl"]);
    const facts = factsOf(fixture);
    expect(facts.format).toBe("versioned");
    expect(facts.tail).toBeNull();
  }, 30_000);
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

/* ------------------------------------------------------------------------ *
 * Compaction: the size ceiling, the disclosure marker and the read window
 * ------------------------------------------------------------------------ */

/** One LF-terminated line of a retained ledger, counted the way the reader splits it. */
function retainedLines(bytes: Buffer): string[] {
  return bytes.toString("utf8").split("\n");
}

/** The final non-empty retained line, parsed. */
function finalRow(bytes: Buffer): Record<string, unknown> {
  const rows = retainedLines(bytes).filter((line) => line.length > 0);
  return JSON.parse(rows[rows.length - 1]!) as Record<string, unknown>;
}

describe("execution-ledgers: compaction at the ledger size ceiling", () => {
  test("an append over the ceiling leaves the exact final-row marker and keeps the triggering note whole", async () => {
    // The shared fixture, reseeded: one store for the whole suite, as every other
    // ordinary case does (the driver's descriptors are released only by GC).
    const fixture = shared;
    // A retained ledger already past the ceiling: historical migrated lines, so
    // the dropped facts are classifiable content rather than one blob.
    const lineBytes = Buffer.byteLength(LEGACY_LINE, "utf8");
    const seededLines = Math.ceil(WORKFLOW_NOTES_LEDGER_MAX_BYTES / lineBytes) + 1;
    const seeded = LEGACY_LINE.repeat(seededLines);
    fixture.seed({ ledger: seeded });
    const target = note("note-trigger", "triggering note after the ceiling");
    const before = Buffer.concat([Buffer.from(seeded, "utf8"), Buffer.from(framedLineOf(target), "utf8")]);
    expect(before.length).toBeGreaterThan(WORKFLOW_NOTES_LEDGER_MAX_BYTES);

    expect(await appendWorkflowNote(fixture.coordContext, fixture.session, target)).toEqual({ id: target.id });

    const retained = ledgerBytes(fixture);
    // Compaction kept the newest complete lines plus the marker: the retained
    // ledger is back inside the read window, not the ceiling.
    expect(retained.length).toBeLessThanOrEqual(WORKFLOW_NOTES_LEDGER_READ_BYTES);
    const marker = finalRow(retained);
    expect(Object.keys(marker)).toEqual(["version", "kind", "ts", "workflowId", "dropped", "prefixSha256"]);
    expect(marker.version).toBe(1);
    // The constant owns the kind the reader and the writer agree on.
    expect(marker.kind).toBe(WORKFLOW_NOTES_COMPACTION_MARKER_KIND);
    expect(marker.workflowId).toBe(WF);
    expect(String(marker.ts)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const dropped = marker.dropped as Record<string, number>;
    // The dropped prefix is whole seeded lines: bytes, lines and historical
    // notes are three views of the same removed region.
    const droppedLines = dropped.bytes! / lineBytes;
    expect(Number.isInteger(droppedLines)).toBe(true);
    expect(dropped).toEqual({
      bytes: dropped.bytes,
      lines: droppedLines,
      records: 0,
      historical: droppedLines,
      unrecognized: 0,
    });
    expect(dropped.bytes).toBeGreaterThan(0);
    // The digest describes exactly the removed prefix, derived from the bytes
    // the append actually left behind before compaction.
    expect(marker.prefixSha256).toBe(sha256Bytes(before.subarray(0, dropped.bytes)));

    const facts = factsOf(fixture);
    // The marker is a disclosure, never a note and never an unrecognized line.
    expect(facts.compaction).toEqual(marker as never);
    // The retained ledger holds the newest complete lines that fit the window:
    // every seeded line the compaction did not drop, plus the triggering note.
    expect(facts.counts).toEqual({ historical: seededLines - droppedLines, records: 1, unrecognized: 0 });
    expect(facts.records.map((entry) => entry.record.id)).toEqual([target.id]);
    expect(facts.records[0]!.record.text).toBe(target.text);
    expect(facts.readWindow).toEqual({ offset: 0, totalBytes: retained.length, truncated: false });
  }, 30_000);

  test("a single oversize triggering note stays whole and is disclosed by tail-read truncation", async () => {
    const fixture = shared;
    fixture.seed({ ledger: LEGACY_LINE });
    // One note larger than the ceiling: the recorded exception to the target
    // size, disclosed by the truncated tail read rather than by another bound.
    const target = note("note-oversize", "x".repeat(WORKFLOW_NOTES_LEDGER_MAX_BYTES + 1024));
    await appendWorkflowNote(fixture.coordContext, fixture.session, target);

    const retained = ledgerBytes(fixture);
    expect(retained.length).toBeGreaterThan(WORKFLOW_NOTES_LEDGER_READ_BYTES);
    const marker = finalRow(retained);
    expect(marker.kind).toBe(WORKFLOW_NOTES_COMPACTION_MARKER_KIND);
    expect((marker.dropped as Record<string, number>).historical).toBe(1);
    expect((marker.dropped as Record<string, number>).records).toBe(0);

    // A tail read of the retained ledger still reaches the final-row marker.
    const readBytes = Math.min(retained.length, WORKFLOW_NOTES_LEDGER_READ_BYTES);
    const offset = retained.length - readBytes;
    const window = retained.subarray(offset + retained.subarray(offset).indexOf(0x0a) + 1);
    const facts = normalizeWorkflowNotesCoverage({
      workflowId: WF,
      path: fixture.ledgerPath,
      bytes: window,
      readWindow: { offset: retained.length - window.length, totalBytes: retained.length, truncated: true },
    });
    expect(facts.readWindow).toEqual({ offset: retained.length - window.length, totalBytes: retained.length, truncated: true });
    expect(facts.compaction?.kind).toBe(WORKFLOW_NOTES_COMPACTION_MARKER_KIND);
    expect(facts.compaction).toEqual(marker as never);
    // Counts describe the disclosed window: the note is cut, the marker is not
    // a record, and the tail is the marker's own final LF.
    expect(facts.counts).toEqual({ historical: 0, records: 0, unrecognized: 0 });
    expect(facts.tail).toBeNull();
  }, 30_000);

  test("a peer frame appended between the compaction read and its rename is not deleted", async () => {
    const fixture = shared;
    const lineBytes = Buffer.byteLength(LEGACY_LINE, "utf8");
    fixture.seed({ ledger: LEGACY_LINE.repeat(Math.ceil(WORKFLOW_NOTES_LEDGER_MAX_BYTES / lineBytes) + 1) });
    const target = note("note-during-read", "triggering note");
    const peer = note("note-peer", "peer frame appended during the read");
    const originalReadFileSync = nodeFs.readFileSync;
    let injected = false;
    // The ordinary append is lock-free, so a peer frame can reach the leaf after
    // the compactor took its snapshot. Landing it deterministically inside that
    // window is what proves the rewrite is abandoned instead of overwriting it.
    const spy = spyOn(nodeFs, "readFileSync").mockImplementation(((...args: Parameters<typeof nodeFs.readFileSync>) => {
      const bytes = originalReadFileSync(...args);
      if (!injected && typeof args[0] === "string" && args[0].endsWith("notes.jsonl")) {
        injected = true;
        nodeFs.appendFileSync(args[0], framedLineOf(peer));
      }
      return bytes;
    }) as typeof nodeFs.readFileSync);
    try {
      await appendWorkflowNote(fixture.coordContext, fixture.session, target);
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);
    const facts = factsOf(fixture);
    // Both frames are still readable: the abandoned compaction deleted neither.
    expect(facts.records.map((entry) => entry.record.id)).toEqual([target.id, peer.id]);
    expect(facts.compaction).toBeNull();
    // The ledger is still over its ceiling; the next append past it retries.
    expect(ledgerBytes(fixture).length).toBeGreaterThan(WORKFLOW_NOTES_LEDGER_MAX_BYTES);
  }, 30_000);

  test("a ledger carrying two markers compacts to exactly one final-row marker", async () => {
    const fixture = shared;
    const lineBytes = Buffer.byteLength(LEGACY_LINE, "utf8");
    const markerRow = (ts: string): string => JSON.stringify({
      version: 1,
      kind: WORKFLOW_NOTES_COMPACTION_MARKER_KIND,
      ts,
      workflowId: WF,
      dropped: { bytes: 1, lines: 1, records: 0, historical: 1, unrecognized: 0 },
      prefixSha256: "0".repeat(64),
    });
    // Two earlier passes: the first marker ended the ledger, later appends made
    // it an interior line, and a second marker ends it again.
    const seedLines = Math.ceil(WORKFLOW_NOTES_LEDGER_MAX_BYTES / lineBytes) + 1;
    const half = Math.ceil(seedLines / 2);
    fixture.seed({
      ledger:
        `${LEGACY_LINE.repeat(half)}${markerRow("2026-09-30T00:00:00.000Z")}\n` +
        `${LEGACY_LINE.repeat(seedLines - half)}${markerRow("2026-09-30T01:00:00.000Z")}\n`,
    });
    const target = note("note-recompact", "triggering note after two markers");
    await appendWorkflowNote(fixture.coordContext, fixture.session, target);

    const rows = retainedLines(ledgerBytes(fixture)).filter((line) => line.length > 0);
    const markers = rows.filter((line) => line.includes(WORKFLOW_NOTES_COMPACTION_MARKER_KIND));
    expect(markers).toHaveLength(1);
    expect(rows[rows.length - 1]).toBe(markers[0]!);
    const facts = factsOf(fixture);
    expect(facts.compaction).not.toBeNull();
    expect(facts.records.map((entry) => entry.record.id)).toEqual([target.id]);
    expect(facts.counts.unrecognized).toBe(0);
  }, 30_000);
});
