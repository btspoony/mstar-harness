/**
 * execution-ledgers.ts — the retained, file-native **workflow notes ledger**
 * (phase2b-execution-contract §5 "F1 — notes", S3).
 *
 * The ledger is `<control root>/workflows/<id>/notes.jsonl` — the same file the
 * v1 migration already emits (`migrate.ts` `NOTES_LEDGER_FILE`, one
 * `{kind:"note",ts,text}` line per legacy row note). Its disposition under the
 * active execution authority is **retain**: bytes stay files with identity,
 * provenance and append order (D11 — no DB copy of an accepted ledger record),
 * so this module never converts a note into a DB event and never rewrites
 * history to add metadata.
 *
 * ## What this module owns
 *
 * - `appendWorkflowNote` — the ONE append path. It is active-route only: the
 *   caller must hand in an `ExecutionSessionRef` that C1's
 *   `assertExecutionSessionCurrent` still accepts, and the note's provenance
 *   must be that bound session's own scope. Identity is never inferred from a
 *   model-supplied field, a cached selection or the note body: the record's
 *   `workflowId`/`sessionId` are checked against the session the engine is
 *   already authorizing, never used as its source.
 * - `normalizeWorkflowNotesCoverage` — a pure projection of the retained bytes
 *   into the inspectable facts a coverage producer (C3's manifest v2 / C2's
 *   `notes-v1` validator) needs: the canonical path, the file hash, the ordered
 *   historical lines with their `(source-file-sha256, line-index)` identity, the
 *   ordered accepted record ids with their line hashes, the unaccepted tail and
 *   the counts. It never reads or writes anything.
 *
 * ## Durability and ordering (contract §4.3)
 *
 * `appendWorkflowNote` takes the **maintenance exclusion** first and the
 * **per-workflow file lock** second (contract §4.3 order: maintenance → root →
 * workflow → local ledger → SQL; this writer takes no root lock and no SQL
 * write). Inside them the sequence is: prove the control root → resolve (and, if
 * genuinely absent and already authorized, materialize) the retained workflow
 * body dir → read → classify → dedup → C1's synchronous current-session
 * assertion → fsynced append. That assertion is the last step before the
 * byte-level mutation and there is no `await` between the two, so a stale
 * epoch, a revoked session or a foreign caller can never land a line. Append
 * success means fsynced bytes; nothing here is advertised as a distributed
 * transaction with the DB.
 *
 * This writer never materializes the control root, a root register or any
 * authority/snapshot file: the control root must already exist (as a real
 * directory), and the only thing an append may create is the retained
 * per-workflow **body dir** of the session's own workflow plus the one ledger
 * line inside it — and only AFTER the current-session guard has authorized the
 * call, so a stale, revoked or foreign session leaves no directory side effect.
 * No `status.json`, no `snapshot.json` and no other business file is ever
 * created here.
 *
 * ## Crash and replay semantics (S3)
 *
 * The accepted record set is the set of LF-terminated lines. A retry of the same
 * stable record id with the same body replays without appending; the same id
 * with a changed body conflicts; a trailing partial line is reconciled only
 * when it is a byte-prefix of the very record being written (the ledger then
 * ends up exactly as if that append had completed), and is otherwise refused
 * with every retained byte left in place. Accepted bytes are never silently
 * discarded and never duplicated.
 */
import {
  closeSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  type Stats,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalTarget, isNonEmptyString, isPlainObject, sha256Bytes } from "./coordination-write.js";
import { assertExecutionSessionCurrent } from "./execution-session.js";
import type { ExecutionContext, ExecutionSessionRef } from "./execution-store.js";
import { withStatusWriteLock } from "./lease.js";
import { NOTES_LEDGER_FILE } from "./migrate.js";
import { assertSafePathComponent, resolveWorkflowDir } from "./path.js";
import { storeDbPath, type StoreContext } from "./store-db.js";

/* ------------------------------------------------------------------------ *
 * Public shapes (§5)
 * ------------------------------------------------------------------------ */

/**
 * One new-format ledger record (§5). `id` is the caller's stable record
 * identity — the dedup key — and `workflowId`/`sessionId` are the provenance
 * the engine preserves; the note text carries no authority of any kind.
 */
export type WorkflowNote = Readonly<{
  version: 1;
  id: string;
  workflowId: string;
  sessionId: string;
  kind: "note";
  ts: string;
  text: string;
}>;

/** The append receipt: the record id and whether it was already accepted. */
export type WorkflowNoteAppendReceipt = Readonly<{ id: string; replayed: boolean }>;

/** Stable refusal codes of the notes ledger. */
export const EXECUTION_LEDGER_ERROR_CODES = [
  "execution-ledgers.record-invalid",
  "execution-ledgers.scope-mismatch",
  "execution-ledgers.id-conflict",
  "execution-ledgers.ledger-foreign",
  "execution-ledgers.tail-unreconciled",
  "execution-ledgers.target-untrusted",
] as const;

export type ExecutionLedgerErrorCode = (typeof EXECUTION_LEDGER_ERROR_CODES)[number];

/** Typed refusal with an actionable, stable code. */
export class ExecutionLedgerError extends Error {
  readonly code: ExecutionLedgerErrorCode;

  constructor(code: ExecutionLedgerErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "ExecutionLedgerError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------------ *
 * Canonical location
 * ------------------------------------------------------------------------ */

/**
 * The canonical control harness root that owns `context`'s store — resolved
 * from the store's own path (never from a caller-supplied root) and
 * canonicalized, exactly as `execution-migrate.ts`/`execution-store.ts` resolve
 * theirs, so every recorded path and every comparison is one spelling.
 */
function controlRootOf(context: StoreContext): string {
  return canonicalTarget(dirname(storeDbPath(context)));
}

/** One safe workflow-id path component, refused with this module's own code. */
function assertWorkflowId(workflowId: string, what = "workflow id"): void {
  try {
    assertSafePathComponent(workflowId, what);
  } catch (error) {
    throw new ExecutionLedgerError("execution-ledgers.record-invalid", (error as Error).message);
  }
}

/**
 * The canonical retained ledger path of one workflow: the configured
 * `{WORKFLOW_DIR}` (`.mstarc` overrides honored — the same resolver
 * `execution-store.ts` uses) plus `<workflowId>/notes.jsonl`. Pure path
 * resolution: nothing is created, and the leaf need not exist.
 */
export function workflowNotesLedgerPath(context: StoreContext, workflowId: string): string {
  assertWorkflowId(workflowId);
  const root = controlRootOf(context);
  return join(resolveWorkflowDir(root, { harnessDir: root }), workflowId, NOTES_LEDGER_FILE);
}

/* ------------------------------------------------------------------------ *
 * Record codec
 * ------------------------------------------------------------------------ */

const NOTE_KEYS = ["version", "id", "workflowId", "sessionId", "kind", "ts", "text"] as const;
const NOTE_KEY_ORDER = [...NOTE_KEYS].sort();

/** Parse the exact new-format record shape; anything else is `null`. */
function parseWorkflowNote(value: unknown): WorkflowNote | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== NOTE_KEY_ORDER.length || keys.some((key, index) => key !== NOTE_KEY_ORDER[index])) return null;
  if (value.version !== 1 || value.kind !== "note") return null;
  for (const field of ["id", "workflowId", "sessionId", "ts"] as const) {
    if (!isNonEmptyString(value[field])) return null;
  }
  if (typeof value.text !== "string") return null;
  return {
    version: 1,
    id: value.id as string,
    workflowId: value.workflowId as string,
    sessionId: value.sessionId as string,
    kind: "note",
    ts: value.ts as string,
    text: value.text,
  };
}

/**
 * The canonical ledger line for a record (no LF): fixed key order, so the same
 * record always serializes to the same bytes and byte equality IS record
 * equality. Never derived from a caller's object key order or formatting.
 */
function canonicalNoteLine(note: WorkflowNote): string {
  return JSON.stringify({
    version: 1,
    id: note.id,
    workflowId: note.workflowId,
    sessionId: note.sessionId,
    kind: "note",
    ts: note.ts,
    text: note.text,
  });
}

/* ------------------------------------------------------------------------ *
 * Ledger scan — bytes only, never a whole-file rewrite
 * ------------------------------------------------------------------------ */

type LedgerLine =
  | Readonly<{ format: "legacy-note"; record: Readonly<{ kind: "note"; ts: string; text: string }> }>
  | Readonly<{ format: "versioned-note-v1"; record: WorkflowNote }>
  | Readonly<{ format: "unrecognized" }>;

const UNRECOGNIZED_LINE: LedgerLine = { format: "unrecognized" };

/**
 * Classify one LF-terminated line. A v1 `{kind:"note",ts,text}` line is the
 * historical format the migration emitted; a `version:1` record is this
 * module's format; everything else (including a `version` field that is not a
 * valid record) is unrecognized — reported, never guessed.
 */
function parseLedgerLine(bytes: Buffer): LedgerLine {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return UNRECOGNIZED_LINE;
  }
  const note = parseWorkflowNote(value);
  if (note !== null) return { format: "versioned-note-v1", record: note };
  if (
    isPlainObject(value) &&
    value.version === undefined &&
    value.kind === "note" &&
    typeof value.ts === "string" &&
    typeof value.text === "string"
  ) {
    return { format: "legacy-note", record: { kind: "note", ts: value.ts, text: value.text } };
  }
  return UNRECOGNIZED_LINE;
}

type LedgerScanLine = Readonly<{ index: number; bytes: Buffer; line: LedgerLine }>;

type LedgerScan = Readonly<{
  fileSha256: string;
  lines: readonly LedgerScanLine[];
  /** Bytes after the last LF — an unterminated (unaccepted) record, if any. */
  tail: Buffer;
  /** Byte offset where the complete-line region ends. */
  completeBytes: number;
}>;

/**
 * Scan retained bytes without decoding them as one string: lines are split on
 * the LF byte, hashed as bytes, and any trailing partial line is kept aside as
 * the unaccepted tail. Nothing is normalized, rewritten or dropped.
 */
function scanLedger(bytes: Buffer): LedgerScan {
  const lines: LedgerScanLine[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    const lineBytes = bytes.subarray(start, index);
    lines.push({ index: lines.length, bytes: lineBytes, line: parseLedgerLine(lineBytes) });
    start = index + 1;
  }
  return { fileSha256: sha256Bytes(bytes), lines, tail: bytes.subarray(start), completeBytes: start };
}

/* ------------------------------------------------------------------------ *
 * Append decision
 * ------------------------------------------------------------------------ */

type AppendDecision = Readonly<{ kind: "replay" | "append"; reconcileTail: boolean }>;

/**
 * Read → classify → dedup. The accepted records of a retained ledger are the
 * LF-terminated `version:1` lines; the historical legacy lines are preserved
 * content no new record can collide with.
 *
 * Refusals (all before any byte is written):
 * - an unrecognized complete line — this file holds content the notes ledger
 *   cannot classify, i.e. evidence of a second writer or of corruption;
 * - one accepted record id appearing more than once — an accepted record
 *   appears exactly once;
 * - a trailing unterminated line that is not a byte-prefix of the record being
 *   written — its acceptance cannot be decided, so it is never discarded;
 * - the same id with a different canonical body.
 */
function decideAppend(scan: LedgerScan, note: WorkflowNote): AppendDecision {
  const canonical = canonicalNoteLine(note);
  const accepted = new Map<string, string>();
  for (const entry of scan.lines) {
    if (entry.line.format === "unrecognized") {
      throw new ExecutionLedgerError(
        "execution-ledgers.ledger-foreign",
        `the retained notes ledger holds a line (index ${entry.index}) that is neither a legacy note nor a version:1 record. ` +
          `A notes ledger is appended only through appendWorkflowNote; nothing was written.`,
      );
    }
    if (entry.line.format === "legacy-note") continue;
    if (accepted.has(entry.line.record.id)) {
      throw new ExecutionLedgerError(
        "execution-ledgers.ledger-foreign",
        `the retained notes ledger records the accepted id ${JSON.stringify(entry.line.record.id)} more than once ` +
          `(line index ${entry.index}). An accepted record appears exactly once; nothing was written.`,
      );
    }
    accepted.set(entry.line.record.id, canonicalNoteLine(entry.line.record));
  }

  const reconcileTail = scan.tail.length > 0;
  // A trailing unterminated line is this record's own partial write only when
  // it is a byte-prefix of the exact line about to be written; the subarray
  // below is length-clamped, so a longer tail can never compare equal.
  const line = Buffer.from(`${canonical}\n`, "utf8");
  if (reconcileTail && !line.subarray(0, scan.tail.length).equals(scan.tail)) {
    throw new ExecutionLedgerError(
      "execution-ledgers.tail-unreconciled",
      `the retained notes ledger ends with an unterminated line that is not a partial write of record ` +
        `${JSON.stringify(note.id)}; its acceptance cannot be decided, so every retained byte is left in place and ` +
        `nothing was written. Reconcile the ledger explicitly before appending.`,
    );
  }

  const existing = accepted.get(note.id);
  if (existing === undefined) return { kind: "append", reconcileTail };
  if (existing !== canonical) {
    throw new ExecutionLedgerError(
      "execution-ledgers.id-conflict",
      `record id ${JSON.stringify(note.id)} is already accepted with a different body. A record id is an idempotency key, ` +
        `not a reusable slot; nothing was written.`,
    );
  }
  return { kind: "replay", reconcileTail };
}

/* ------------------------------------------------------------------------ *
 * Durable byte-level commit
 * ------------------------------------------------------------------------ */

/** Write the whole line, tolerating a short write; `offset < 0` means O_APPEND. */
function writeAll(fd: number, line: Buffer, offset: number): void {
  let written = 0;
  while (written < line.length) {
    written += writeSync(fd, line, written, line.length - written, offset < 0 ? null : offset + written);
  }
}

/** Fsync one directory's own entry (used only when this append created a file). */
function fsyncDirectory(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Append exactly one line and fsync it. `keepBytes === null` appends to the
 * existing (or newly created) file; a number truncates an unaccepted partial
 * tail away first, which only ever happens when those bytes are a prefix of the
 * line being written. Both forms are a single open → write → fsync → close;
 * bytes outside the written region are never touched.
 */
function commitNoteLine(path: string, keepBytes: number | null, line: Buffer, created: boolean): void {
  if (keepBytes === null) {
    const fd = openSync(path, "a");
    try {
      writeAll(fd, line, -1);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } else {
    const fd = openSync(path, "r+");
    try {
      ftruncateSync(fd, keepBytes);
      writeAll(fd, line, keepBytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  if (created) fsyncDirectory(dirname(path));
}

/* ------------------------------------------------------------------------ *
 * Target trust
 * ------------------------------------------------------------------------ */

/**
 * One directory this writer needs to already be a real directory: never a
 * symlink and never a non-directory. The control root is never materialized —
 * an append retains a body, it does not re-scaffold the harness.
 */
function assertRealDirectory(path: string, what: string): void {
  let info: Stats | null = null;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (info === null) {
    throw new ExecutionLedgerError(
      "execution-ledgers.target-untrusted",
      `${what} at ${path} does not exist; a retained body append never creates it.`,
    );
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ExecutionLedgerError(
      "execution-ledgers.target-untrusted",
      `${what} at ${path} is not a real directory (a symlink or a non-directory is not a retained ledger home).`,
    );
  }
}

/**
 * Resolve the retained per-workflow **body dir** before the append. It must be
 * a real directory or genuinely absent; a symlink or a non-directory refuses
 * (the write could otherwise land outside the control root).
 *
 * When it is absent, the authorized current session is proven BEFORE anything
 * is created: an authorized session may materialize its own workflow's body dir
 * (durably — the dir, then its parent entry, is fsynced), while a stale,
 * revoked, foreign or mismatched session refuses with no directory side effect
 * at all. Only the body dir is created — never a snapshot, a root register or
 * any other authority file, and never a second workflow's dir.
 */
function prepareWorkflowBodyDir(context: ExecutionContext, session: ExecutionSessionRef, dir: string): void {
  let info: Stats | null = null;
  try {
    info = lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (info !== null) {
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ExecutionLedgerError(
        "execution-ledgers.target-untrusted",
        `the retained workflow dir at ${dir} is not a real directory (a symlink or a non-directory is not a retained ledger home).`,
      );
    }
    return;
  }
  assertExecutionSessionCurrent(context, session);
  mkdirSync(dir, { recursive: true });
  fsyncDirectory(dirname(dir));
}

/**
 * The retained ledger path is either absent (the first note creates it) or a
 * real regular file: a symlinked or non-regular leaf is refused rather than
 * appended through, so this write can never land outside the control root.
 */
function readLedgerBytes(path: string): Buffer | null {
  let info: Stats | null = null;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (info === null) return null;
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ExecutionLedgerError(
      "execution-ledgers.target-untrusted",
      `${path} is not a regular file (a symlink or a non-file has no retained bytes to append to).`,
    );
  }
  return readFileSync(path);
}

/* ------------------------------------------------------------------------ *
 * Locking (§4.3)
 * ------------------------------------------------------------------------ */

const LEDGER_LOCK_WAIT_MS = 30_000;

/** The bounded wait of this writer; the test-runner-gated override lets a fixture prove the lock without a 30s run. */
function ledgerLockWaitMs(): number {
  if (process.env.MSTAR_STORE_TEST_RUNNER === "1") {
    const parsed = Number.parseInt(process.env.MSTAR_EXECUTION_LEDGER_LOCK_WAIT_MS ?? "", 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return LEDGER_LOCK_WAIT_MS;
}

/**
 * The §4.3 outer **maintenance exclusion**, keyed EXACTLY like
 * `withExecutionMaintenanceLock` in `execution-migrate.ts` and
 * `execution-recovery.ts` (`<root>/.execution-maintenance/execution-migration`,
 * which `withStatusWriteLock` turns into
 * `<root>/.execution-maintenance/.status-write.lockdir`). The three spellings
 * must stay identical: an activation, a restore or a migration never
 * interleaves with a cooperative ledger append, and the append never
 * interleaves with them.
 */
async function withExecutionMaintenanceLock<T>(context: StoreContext, fn: () => Promise<T>): Promise<T> {
  const key = join(controlRootOf(context), ".execution-maintenance", "execution-migration");
  mkdirSync(dirname(key), { recursive: true });
  return withStatusWriteLock(key, fn, { timeoutMs: ledgerLockWaitMs() });
}

/*
 * The per-workflow file lock around the append is `withStatusWriteLock` on the
 * ledger path itself: its lockdir lands in `<workflow dir>` (dirname of the
 * ledger), i.e. the same per-workflow status lock every snapshot/ledger writer
 * of that workflow takes, and it is removed again on release. It is acquired
 * only after the body dir exists, and every read/classify/dedup/append step of
 * one workflow runs inside it.
 */

/* ------------------------------------------------------------------------ *
 * Append (§5)
 * ------------------------------------------------------------------------ */

/** Validate one incoming record and its provenance against the bound session. */
function assertNoteScope(session: ExecutionSessionRef, note: WorkflowNote): void {
  assertWorkflowId(session.workflowId, "execution session workflow id");
  const record = parseWorkflowNote(note);
  if (record === null) {
    throw new ExecutionLedgerError(
      "execution-ledgers.record-invalid",
      `a note is exactly {version:1,id,workflowId,sessionId,kind:"note",ts,text} with non-empty id/workflowId/sessionId/ts ` +
        `and a string text.`,
    );
  }
  if (record.workflowId !== session.workflowId || record.sessionId !== session.sessionId) {
    throw new ExecutionLedgerError(
      "execution-ledgers.scope-mismatch",
      `the note records provenance ${JSON.stringify(record.workflowId)}/${JSON.stringify(record.sessionId)}, but the bound ` +
        `session is ${JSON.stringify(session.workflowId)}/${JSON.stringify(session.sessionId)}. Provenance is the bound ` +
        `session's own scope — it is never taken from the record; nothing was written.`,
    );
  }
}

/**
 * Append one note to the workflow's retained ledger, or replay an already
 * accepted record id.
 *
 * Active route only. Inside the maintenance exclusion the order is: prove the
 * control root exists → resolve the retained workflow body dir (creating it only
 * after the current-session guard has authorized a genuinely absent one) → take
 * the per-workflow lock → read the retained bytes → classify → dedup → the SAME
 * synchronous current-session guard again, immediately before the fsynced
 * append. A stale epoch, a revoked/suspended session, a foreign caller or a
 * mismatched scope therefore refuses with the store's own codes (or this
 * module's), every retained byte stays in place, and an unauthorized session
 * leaves no directory side effect behind.
 */
export async function appendWorkflowNote(
  context: ExecutionContext,
  session: ExecutionSessionRef,
  note: WorkflowNote,
): Promise<WorkflowNoteAppendReceipt> {
  assertNoteScope(session, note);
  const line = Buffer.from(`${canonicalNoteLine(note)}\n`, "utf8");
  const ledgerPath = workflowNotesLedgerPath(context, session.workflowId);
  return withExecutionMaintenanceLock(context, async () => {
    assertRealDirectory(controlRootOf(context), "the control root");
    prepareWorkflowBodyDir(context, session, dirname(ledgerPath));
    return withStatusWriteLock(
      ledgerPath,
      async () => {
        const retained = readLedgerBytes(ledgerPath);
        const scan = retained === null ? null : scanLedger(retained);
        const decision = scan === null ? ({ kind: "append", reconcileTail: false } as const) : decideAppend(scan, note);
        // The final synchronous identity check, immediately before the mutation.
        assertExecutionSessionCurrent(context, session);
        const keepBytes = scan !== null && decision.reconcileTail ? scan.completeBytes : null;
        if (decision.kind === "append" || keepBytes !== null) {
          commitNoteLine(ledgerPath, keepBytes, line, retained === null);
        }
        return { id: note.id, replayed: decision.kind === "replay" };
      },
      { timeoutMs: ledgerLockWaitMs() },
    );
  });
}

/* ------------------------------------------------------------------------ *
 * Coverage facts (C3 / C2 `notes-v1`)
 * ------------------------------------------------------------------------ */

/**
 * One retained historical line: its coverage identity is the retained file's
 * own byte hash plus the line index, and its line hash is over the exact line
 * bytes excluding the final LF.
 */
export type WorkflowNoteHistoricalRecord = Readonly<{
  identity: Readonly<{ sourceFileSha256: string; lineIndex: number }>;
  sha256: string;
  bytes: number;
  format: "legacy-note" | "unrecognized";
  record: Readonly<{ kind: string; ts: string; text: string }> | null;
}>;

/** One accepted new-format record, in append order. */
export type WorkflowNoteAcceptedRecord = Readonly<{
  id: string;
  lineIndex: number;
  sha256: string;
  bytes: number;
  record: WorkflowNote;
}>;

/** The normalized, inspectable facts of one retained notes surface. */
export type WorkflowNotesCoverageFacts = Readonly<{
  version: 1;
  protocol: "notes-v1";
  workflowId: string;
  path: string;
  format: "absent" | "legacy" | "versioned" | "mixed";
  bytes: number;
  fileSha256: string | null;
  historical: readonly WorkflowNoteHistoricalRecord[];
  records: readonly WorkflowNoteAcceptedRecord[];
  /** Accepted record ids, in append order — the ordered identity C3 pins. */
  acceptedIds: readonly string[];
  /** Accepted ids recorded more than once; a non-empty list refuses coverage. */
  duplicateIds: readonly string[];
  counts: Readonly<{ historical: number; accepted: number }>;
  /** Bytes after the last LF — an unaccepted, unterminated tail, if present. */
  tail: Readonly<{ sha256: string; bytes: number }> | null;
}>;

/**
 * Pure projection of one retained notes ledger's bytes into coverage facts.
 * Input bytes are the caller's own fresh read (C3 owns safe IO and the
 * existence/symlink/root checks); this function hashes and classifies them and
 * writes nothing. An unrecognized or duplicated line is reported rather than
 * hidden, so a validator can refuse instead of reading corruption as absence.
 */
export function normalizeWorkflowNotesCoverage(input: {
  workflowId: string;
  path: string;
  bytes: Uint8Array | null;
}): WorkflowNotesCoverageFacts {
  if (input.bytes === null) {
    return {
      version: 1,
      protocol: "notes-v1",
      workflowId: input.workflowId,
      path: input.path,
      format: "absent",
      bytes: 0,
      fileSha256: null,
      historical: [],
      records: [],
      acceptedIds: [],
      duplicateIds: [],
      counts: { historical: 0, accepted: 0 },
      tail: null,
    };
  }
  const buffer = Buffer.isBuffer(input.bytes)
    ? input.bytes
    : Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  const scan = scanLedger(buffer);
  const historical: WorkflowNoteHistoricalRecord[] = [];
  const records: WorkflowNoteAcceptedRecord[] = [];
  const acceptedIds: string[] = [];
  const duplicateIds: string[] = [];
  let legacy = 0;
  let versioned = 0;
  for (const entry of scan.lines) {
    const digest = sha256Bytes(entry.bytes);
    if (entry.line.format === "legacy-note") {
      legacy += 1;
      historical.push({
        identity: { sourceFileSha256: scan.fileSha256, lineIndex: entry.index },
        sha256: digest,
        bytes: entry.bytes.length,
        format: "legacy-note",
        record: entry.line.record,
      });
      continue;
    }
    if (entry.line.format === "unrecognized") {
      historical.push({
        identity: { sourceFileSha256: scan.fileSha256, lineIndex: entry.index },
        sha256: digest,
        bytes: entry.bytes.length,
        format: "unrecognized",
        record: null,
      });
      continue;
    }
    versioned += 1;
    if (acceptedIds.includes(entry.line.record.id) && !duplicateIds.includes(entry.line.record.id)) {
      duplicateIds.push(entry.line.record.id);
    }
    acceptedIds.push(entry.line.record.id);
    records.push({
      id: entry.line.record.id,
      lineIndex: entry.index,
      sha256: digest,
      bytes: entry.bytes.length,
      record: entry.line.record,
    });
  }
  const format =
    legacy === 0 && versioned === 0 ? "absent" : legacy === 0 ? "versioned" : versioned === 0 ? "legacy" : "mixed";
  return {
    version: 1,
    protocol: "notes-v1",
    workflowId: input.workflowId,
    path: input.path,
    format,
    bytes: buffer.length,
    fileSha256: scan.fileSha256,
    historical,
    records,
    acceptedIds,
    duplicateIds,
    counts: { historical: historical.length, accepted: records.length },
    tail: scan.tail.length === 0 ? null : { sha256: sha256Bytes(scan.tail), bytes: scan.tail.length },
  };
}
