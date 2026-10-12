/**
 * execution-ledgers.ts — the retained, file-native **workflow notes ledger**
 * (phase2b-execution-contract §5 "F1 — notes", S3).
 *
 * The ledger is `<control root>/workflows/<id>/notes.jsonl` — the same file the
 * v1 migration already emits (`migrate.ts` `NOTES_LEDGER_FILE`, one
 * `{kind:"note",ts,text}` line per legacy row note). It is a plain append-only
 * process log, **not** an accepted-operation ledger: bytes stay files with
 * provenance and append order (no DB copy of a note), a record id is caller
 * metadata rather than a dedup key, and this module never converts a note into a
 * DB event and never rewrites history to add metadata.
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
 *   into the inspectable facts a coverage producer needs: the canonical path,
 *   the file hash, the ordered historical lines with their
 *   `(source-file-sha256, line-index)` identity, the ordered records with their
 *   line hashes, the unaccepted tail and the counts. It never reads or writes
 *   anything.
 *
 * ## One framed append — no lock, no read (contract §4.3)
 *
 * `appendWorkflowNote` proves the control root exists, resolves (and, when
 * genuinely absent and already authorized, materializes) the retained workflow
 * body dir, then takes C1's synchronous current-session assertion immediately
 * before a **single `O_APPEND` write** of the complete framed record. There is
 * no file lock, no maintenance exclusion, no whole-file read, no dedup
 * decision, no tail repair, no truncation and no rewrite of a peer's bytes: one
 * write call lands the whole frame or reports the short append. **Every** frame
 * carries a leading LF, including the one that creates the leaf, so its line
 * survives when a peer wrote a partial record after the open and before this
 * write; the boundary never depends on the leaf having been empty. A stale
 * epoch, a revoked session or a foreign caller refuses before any byte is
 * written, and append success means the frame is fsynced.
 *
 * ## Leaf trust
 *
 * The retained leaf is opened with `O_NOFOLLOW` and verified with `fstat`: it
 * must be a regular file. A symlinked leaf, a non-file, a symlinked body dir and
 * a missing control root refuse instead of being followed or materialized.
 *
 * ## Reader and failure semantics (S3)
 *
 * Repeated ids and repeated submissions append repeated records — the log makes
 * no replay or conflict promise. A short append leaves exactly the bytes that
 * landed and reports the failure; it never removes or repairs a peer's bytes.
 * Readers tolerate blank, unrecognized and truncated records and continue to
 * later valid records, so a partial record never blocks a later append and a
 * record boundary always survives an earlier partial record.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
  writeFileSync,
  writeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { canonicalTarget, isNonEmptyString, isPlainObject, sha256Bytes } from "./coordination-write.js";
import { assertExecutionSessionCurrent } from "./execution-session.js";
import type { ExecutionContext, ExecutionSessionRef } from "./execution-store.js";
import { NOTES_LEDGER_FILE } from "./migrate.js";
import { assertSafePathComponent, resolveWorkflowDir } from "./path.js";
import { storeDbPath, type StoreContext } from "./store-db.js";

/* ------------------------------------------------------------------------ *
 * Public shapes (§5)
 * ------------------------------------------------------------------------ */

/**
 * One new-format ledger record (§5). `id` is the caller's record identity —
 * metadata carried for correlation, deliberately NOT a dedup key: the same id
 * may be appended again. `workflowId`/`sessionId` are the provenance the engine
 * preserves; the note text carries no authority of any kind.
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

/** The append receipt: the record id this append wrote. */
export type WorkflowNoteAppendReceipt = Readonly<{ id: string }>;

type WorkflowNoteRequest = Omit<WorkflowNote, "ts"> & Readonly<{ ts?: string }>;

/** Stable refusal codes of the notes ledger. */
export const EXECUTION_LEDGER_ERROR_CODES = [
  "execution-ledgers.record-invalid",
  "execution-ledgers.scope-mismatch",
  "execution-ledgers.target-untrusted",
  "execution-ledgers.append-short",
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
 * canonicalized, exactly as `execution-minimal-import.ts`/`execution-store.ts`
 * resolve theirs, so every recorded path and every comparison is one spelling.
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
  const { id, workflowId, sessionId, ts, text } = value;
  if (!isNonEmptyString(id) || !isNonEmptyString(workflowId) || !isNonEmptyString(sessionId) || !isNonEmptyString(ts)) {
    return null;
  }
  if (typeof text !== "string") return null;
  return { version: 1, id, workflowId, sessionId, kind: "note", ts, text };
}

/** Serialize a new ledger record in a stable key order, without a final LF. */
function canonicalNoteLine(note: WorkflowNote & { ts: string }): string {
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
  | Readonly<{ format: "blank" }>
  | Readonly<{ format: "unrecognized" }>;

const UNRECOGNIZED_LINE: LedgerLine = { format: "unrecognized" };

/**
 * Classify one LF-terminated line. An empty line is `blank` — the framing byte
 * this writer puts before a record when the leaf already existed, and an
 * artifact no reader should report as a corrupt record. A v1
 * `{kind:"note",ts,text}` line is the historical format the migration emitted; a
 * `version:1` record is this module's format; everything else (including a
 * `version` field that is not a valid record) is unrecognized — reported, never
 * guessed.
 */
function parseLedgerLine(bytes: Buffer): LedgerLine {
  if (bytes.length === 0) return { format: "blank" };
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
  lines: readonly LedgerScanLine[];
  /** Bytes after the last LF — a partial record a reader must skip, if any. */
  tail: Buffer;
}>;

/**
 * Scan retained bytes without decoding them as one string: lines are split on
 * the LF byte (one native scan, no per-byte loop), and any trailing partial line
 * is kept aside as the tail. Nothing is hashed, normalized, rewritten or dropped
 * here — hashing belongs to the coverage projection, which is the only consumer
 * that needs it.
 */
function scanLedger(bytes: Buffer): LedgerScan {
  const lines: LedgerScanLine[] = [];
  let start = 0;
  let end = bytes.indexOf(0x0a, start);
  while (end !== -1) {
    const lineBytes = bytes.subarray(start, end);
    lines.push({ index: lines.length, bytes: lineBytes, line: parseLedgerLine(lineBytes) });
    start = end + 1;
    end = bytes.indexOf(0x0a, start);
  }
  return { lines, tail: bytes.subarray(start) };
}

/* ------------------------------------------------------------------------ *
 * Durable byte-level commit
 * ------------------------------------------------------------------------ */

/**
 * Open one leaf without ever following a symbolic link; a link refuses. The
 * `O_NOFOLLOW` flag comes from `fs.constants` (the repo's one source for open
 * flags); where a platform does not provide it, the `fstat` verification of the
 * same descriptor remains the boundary.
 */
function openWithoutFollowing(path: string, flags: number, mode?: number): number {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  try {
    return mode === undefined ? openSync(path, flags | noFollow) : openSync(path, flags | noFollow, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ExecutionLedgerError(
        "execution-ledgers.target-untrusted",
        `${path} is a symbolic link; a retained ledger leaf is opened directly and never followed.`,
      );
    }
    throw error;
  }
}

/**
 * Test-runner-only fault seam between the leaf open and the frame write: a peer
 * that writes into the same leaf inside that window. Two shapes are exercised —
 * a replacement of the leaf (the bytes this append then appends to are the
 * replacement's), and a real second process leaving a partial record, which is
 * the interleaving that decides whether the frame needs its boundary byte.
 */
function interleavingSeam(path: string): void {
  if (process.env.MSTAR_STORE_TEST_RUNNER !== "1") return;
  if (process.env.MSTAR_LEDGER_REPLACE_BEFORE_COMMIT === path) {
    writeFileSync(path, "replaced between the open and the write\n");
    return;
  }
  const peer = process.env.MSTAR_LEDGER_PEER_PARTIAL_SCRIPT;
  if (peer !== undefined && peer !== "") execFileSync("bun", [peer, path], { stdio: "ignore" });
}

/**
 * Test-runner-only shortening of the single write call's requested length, so a
 * frame is provably incomplete without mocking the driver. Production always
 * requests the whole frame, and both cases take the same ordinary refusal path:
 * the descriptor reports fewer bytes than the frame, which is exactly what a
 * short append (full filesystem, resource limit) produces.
 */
function writeRequestLength(line: Buffer): number {
  if (process.env.MSTAR_STORE_TEST_RUNNER !== "1") return line.length;
  const parsed = Number.parseInt(process.env.MSTAR_LEDGER_WRITE_CAPACITY_BYTES ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed < line.length ? parsed : line.length;
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
 * Append one complete framed record in a SINGLE `O_APPEND` write. Nothing is
 * read first: there is no whole-file admission, no dedup decision, no peer-tail
 * repair and no truncation. A short append is reported as a failure and leaves
 * exactly the bytes that landed, so a later record is still reachable.
 *
 * Every frame — including one that creates the leaf — carries one leading LF.
 * The leaf is not private between this call's open and its write: a peer can
 * create it, or extend it with a partial record, in that window, so a boundary
 * decided from the open alone would fuse this record to an unterminated line and
 * hide an acknowledged note from every reader. The leading LF is unconditional
 * for the same reason on a leaf this call created. A boundary written into a
 * leaf that already ended with LF, or into a freshly created empty leaf, is an
 * empty line, which readers skip.
 */
function commitLedgerFrame(path: string, frame: Buffer): void {
  let fd: number;
  let created = false;
  try {
    fd = openWithoutFollowing(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o644);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    fd = openWithoutFollowing(path, fsConstants.O_WRONLY | fsConstants.O_APPEND);
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) {
      throw new ExecutionLedgerError(
        "execution-ledgers.target-untrusted",
        `${path} is not a regular file; nothing was written.`,
      );
    }
    interleavingSeam(path);
    const line = Buffer.concat([Buffer.from("\n", "utf8"), frame]);
    const written = writeSync(fd, line, 0, writeRequestLength(line), null);
    if (written !== line.length) {
      throw new ExecutionLedgerError(
        "execution-ledgers.append-short",
        `only ${written} of ${line.length} bytes of the framed note reached ${path}; the partial bytes stay in place ` +
          `and are never repaired or truncated in a peer's name. Retry the append with a new record id.`,
      );
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
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

/* ------------------------------------------------------------------------ *
 * Append (§5)
 * ------------------------------------------------------------------------ */

/** Validate one incoming record and its provenance against the bound session. */
function assertNoteScope(session: ExecutionSessionRef, note: WorkflowNoteRequest): void {
  assertWorkflowId(session.workflowId, "execution session workflow id");
  const record = parseWorkflowNote(note.ts === undefined ? { ...note, ts: "pending" } : note);
  if (record === null) {
    throw new ExecutionLedgerError(
      "execution-ledgers.record-invalid",
      `a note is exactly {version:1,id,workflowId,sessionId,kind:"note",text} with an optional non-empty ts and string text.`,
    );
  }
  if (record.workflowId !== session.workflowId || record.sessionId !== session.sessionId) {
    throw new ExecutionLedgerError(
      "execution-ledgers.scope-mismatch",
      `the note records provenance ${JSON.stringify(record.workflowId)}/${JSON.stringify(record.sessionId)}, but the bound ` +
        `session is ${JSON.stringify(session.workflowId)}/${JSON.stringify(session.sessionId)}. Provenance is the bound ` +
        `session's own scope - it is never taken from the record; nothing was written.`,
    );
  }
}

/**
 * Append one note to the workflow's retained ledger.
 *
 * Active route only, and the whole path is: prove the control root exists →
 * resolve the retained workflow body dir (materialized only after the
 * current-session guard has authorized a genuinely absent one) → the SAME
 * synchronous current-session guard again, immediately before the byte
 * mutation → one fsynced `O_APPEND` frame. There is no file lock, no
 * maintenance exclusion, no read of retained bytes and no replay/conflict
 * decision: a stale epoch, a revoked/suspended session, a foreign caller or a
 * mismatched scope still refuses with the store's own codes (or this module's),
 * every retained byte stays in place, and a refused call leaves no directory
 * side effect behind. A repeated id appends a second record.
 */
export async function appendWorkflowNote(
  context: ExecutionContext,
  session: ExecutionSessionRef,
  note: WorkflowNoteRequest,
): Promise<WorkflowNoteAppendReceipt> {
  assertNoteScope(session, note);
  assertRealDirectory(controlRootOf(context), "the control root");
  const ledgerPath = workflowNotesLedgerPath(context, session.workflowId);
  prepareWorkflowBodyDir(context, session, dirname(ledgerPath));
  const frame = Buffer.from(`${canonicalNoteLine({ ...note, ts: note.ts ?? new Date().toISOString() })}\n`, "utf8");
  // The final synchronous identity check, immediately before the byte mutation.
  assertExecutionSessionCurrent(context, session);
  commitLedgerFrame(ledgerPath, frame);
  return { id: note.id };
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

/** One retained new-format record, in append order. */
export type WorkflowNoteRecord = Readonly<{
  id: string;
  lineIndex: number;
  sha256: string;
  bytes: number;
  record: WorkflowNote;
}>;

/**
 * The composition of a retained notes surface. `absent` (no file) and `empty`
 * (a present, zero-byte file) are distinct because they are different facts for
 * coverage: a first note against either is an ordinary append, but only the
 * absent one has no retained bytes to witness.
 */
export type WorkflowNotesFormat = "absent" | "empty" | "legacy" | "versioned" | "unrecognized" | "mixed";

/**
 * The normalized, inspectable facts of one retained notes surface: the physical
 * records a reader can see, never a claim about which ids were transactionally
 * accepted (the log makes no such promise, so a repeated id is simply a second
 * record).
 */
export type WorkflowNotesCoverageFacts = Readonly<{
  version: 1;
  protocol: "notes-v1";
  workflowId: string;
  path: string;
  format: WorkflowNotesFormat;
  bytes: number;
  fileSha256: string | null;
  historical: readonly WorkflowNoteHistoricalRecord[];
  records: readonly WorkflowNoteRecord[];
  counts: Readonly<{ historical: number; records: number; unrecognized: number }>;
  /** Bytes after the last LF — a partial record a reader must skip. */
  tail: Readonly<{ sha256: string; bytes: number }> | null;
}>;

/**
 * Pure projection of one retained notes ledger's bytes into coverage facts.
 * Input bytes are the caller's own fresh read (the caller owns safe IO and the
 * existence/symlink/root checks); this function hashes and classifies them and
 * writes nothing. An unrecognized line or a partial tail is reported rather than
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
      counts: { historical: 0, records: 0, unrecognized: 0 },
      tail: null,
    };
  }
  const buffer = Buffer.isBuffer(input.bytes)
    ? input.bytes
    : Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  const scan = scanLedger(buffer);
  const fileSha256 = sha256Bytes(buffer);
  const historical: WorkflowNoteHistoricalRecord[] = [];
  const records: WorkflowNoteRecord[] = [];
  let legacy = 0;
  let versioned = 0;
  let unrecognized = 0;
  for (const entry of scan.lines) {
    const digest = sha256Bytes(entry.bytes);
    if (entry.line.format === "legacy-note") {
      legacy += 1;
      historical.push({
        identity: { sourceFileSha256: fileSha256, lineIndex: entry.index },
        sha256: digest,
        bytes: entry.bytes.length,
        format: "legacy-note",
        record: entry.line.record,
      });
      continue;
    }
    if (entry.line.format === "unrecognized") {
      unrecognized += 1;
      historical.push({
        identity: { sourceFileSha256: fileSha256, lineIndex: entry.index },
        sha256: digest,
        bytes: entry.bytes.length,
        format: "unrecognized",
        record: null,
      });
      continue;
    }
    if (entry.line.format === "blank") {
      // The writer's own framing byte: a reader skips it, never counts it.
      continue;
    }
    versioned += 1;
    records.push({
      id: entry.line.record.id,
      lineIndex: entry.index,
      sha256: digest,
      bytes: entry.bytes.length,
      record: entry.line.record,
    });
  }
  let format: WorkflowNotesFormat;
  if (legacy === 0 && versioned === 0 && unrecognized === 0) format = "empty";
  else if (versioned === 0 && unrecognized === 0) format = "legacy";
  else if (legacy === 0 && unrecognized === 0) format = "versioned";
  else if (legacy === 0 && versioned === 0) format = "unrecognized";
  else format = "mixed";
  return {
    version: 1,
    protocol: "notes-v1",
    workflowId: input.workflowId,
    path: input.path,
    format,
    bytes: buffer.length,
    fileSha256,
    historical,
    records,
    counts: { historical: historical.length, records: records.length, unrecognized },
    tail: scan.tail.length === 0 ? null : { sha256: sha256Bytes(scan.tail), bytes: scan.tail.length },
  };
}
