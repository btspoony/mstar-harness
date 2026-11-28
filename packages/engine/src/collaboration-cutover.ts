import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  resolveCollaborationLocation,
  type CollaborationLocation,
  type CollaborationMode,
} from "./collaboration-identity.js";
import {
  COLLABORATION_COLUMNS,
  COLLABORATION_CUTOVER_TABLES,
  COLLABORATION_SOURCE_DROP_TABLES,
  initializeCollaborationStore,
  mintIssueRef,
  readCollaborationStage,
  beginBindingClaim,
  writeCollaborationBinding,
  writeCollaborationStage,
  type CollaborationAuthority,
  type CollaborationStamp,
} from "./collaboration-store.js";
import {
  MIGRATIONS,
  StoreError,
  busyTimeoutMs,
  connect,
  migrationChecksum,
  nowRfc3339,
  openStore,
  readAppliedMigrations,
  readCollaborationFence,
  readStoreAuthority,
  storeDbPath,
  validateAppliedMigrations,
  type CollaborationFence,
  type StoreContext,
  type StoreDb,
} from "./store-db.js";
import { readHarnessVersionOrNull } from "./core.js";
import {
  backupStore,
  inspectBackupCopy,
  validateActivationAttestation,
  type ActivationAttestation,
  type BackupInspection,
} from "./store-activation.js";

/** The exact source generation a manifest freezes. */
export type CutoverSource = Readonly<{
  storeId: string;
  epoch: number;
  schemaVersion: number;
  revision: number;
  catalogRevision: number;
}>;

/** One reviewed extraction plan: source identity, exact row evidence and blockers. */
export type CutoverManifest = Readonly<{
  version: 1;
  manifestId: string;
  source: CutoverSource;
  repoKey: string;
  mode: CollaborationMode;
  counts: Readonly<Record<string, number>>;
  sourceDigest: string;
  blockers: readonly Readonly<{ code: string; subject: string }>[];
}>;

export type CutoverReceipt = Readonly<{
  manifestId: string;
  phase: "verified" | "source-fenced" | "active";
  source: CutoverManifest["source"];
  target: CollaborationStamp;
  verifiedAt: string;
  fencedAt?: string;
  activatedAt?: string;
  replayed: boolean;
}>;

export type CutoverActivationOptions = Readonly<{
  operator: string;
  attestation: ActivationAttestation;
}>;

const SOURCE_SCHEMA_FLOOR = MIGRATIONS.find((migration) => migration.name === "milestone-effort-sessions")!.version;

const CLAIM_KEY = "collaboration-cutover-claim";

const CUTOVER_LOCK_BASENAME = "collaboration-cutover.lock";
const CUTOVER_LOCK_RECOVERY_SUFFIX = ".recover";
const STALE_LOCK_ATTEMPTS = 3;

type Blockers = readonly Readonly<{ code: string; subject: string }>[];

type SourceSnapshot = Readonly<{
  source: CutoverSource;
  counts: Record<string, number>;
  digest: string;
  rows: Record<string, unknown[][]>;
  ledger: unknown[][];
}>;

type SourceState = Readonly<{
  fence: CollaborationFence | null;
  snapshot: SourceSnapshot | null;
  blockers: Blockers;
  sessions: readonly { sessionId: string; state: string }[];
}>;

type PublicationRow = Readonly<{
  manifestId: string;
  phase: "verified" | "source-fenced" | "active";
  source: CutoverSource;
  manifestDigest: string;
  targetStoreId: string;
  targetEpoch: number;
  verifiedAt: string;
  fencedAt: string | null;
  activatedAt: string | null;
}>;

type ClaimRow = Readonly<{
  requestHash: string;
  manifestId: string;
  manifestDigest: string;
  sourceStoreId: string;
  sourceEpoch: number;
  claimedAt: string;
}>;

type TargetState = Readonly<{
  authority: CollaborationAuthority;
  publication: PublicationRow | null;
  claim: ClaimRow | null;
}>;

type Prepared = Readonly<{
  context: StoreContext;
  location: CollaborationLocation;
  manifest: CutoverManifest;
  digest: string;
  operator: string;
  attestation: ActivationAttestation;
  source: SourceState;
  target: TargetState;
}>;

const LIVE_SESSION_STATES: Readonly<Record<string, true>> = { active: true, suspended: true };

const LEDGER_COLUMNS = ["operation_id", "request_hash", "result_json", "committed_at"] as const;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function conflict(message: string): StoreError {
  return new StoreError("collaboration.cutover-conflict", message);
}

function notQuiescent(blockers: Blockers, detail: string): StoreError {
  const listed = blockers.map((blocker) => `${blocker.subject} (${blocker.code})`).join("; ");
  return new StoreError(
    "collaboration.cutover-not-quiescent",
    `${detail} Settle the named work with its own documented verb, stop the writers it names, then re-plan: ${listed}. ` +
      `Nothing was staged, fenced or activated.`,
  );
}

function backupIncomplete(detail: string): StoreError {
  return new StoreError(
    "collaboration.backup-incomplete",
    `${detail} The activation claim is retained and the source is unchanged; fix the recovery-point destination and ` +
      `rerun the same activate.`,
  );
}

type CutoverLockOwner = Readonly<{ pid: number; host: string; startedAt: string; token: string }>;

function cutoverLockPath(context: StoreContext): string {
  return join(context.harnessDir, CUTOVER_LOCK_BASENAME);
}

function cutoverRecoveryPath(path: string): string {
  return `${path}${CUTOVER_LOCK_RECOVERY_SUFFIX}`;
}

function readCutoverLock(path: string): CutoverLockOwner | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isReceiptObject(parsed)) return null;
  const { pid, host, startedAt, token } = parsed;
  if (!isCount(pid) || !Number.isInteger(pid) || pid < 1) return null;
  if (!isText(host) || !isText(startedAt) || !isText(token)) return null;
  return { pid, host, startedAt, token };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

function lockCreateRefusal(label: string, path: string, error: unknown): StoreError {
  return new StoreError(
    "collaboration.cutover-conflict",
    `The ${label} lock at ${path} could not be created ` +
      `(${error instanceof Error ? error.message : String(error)}). Fix the control harness directory and retry. ` +
      `Nothing was inspected, claimed, fenced or published.`,
  );
}

function cutoverLockRefusal(label: string, path: string, owner: CutoverLockOwner | null): StoreError {
  const header = "Nothing was inspected, claimed, fenced or published.";
  if (owner === null) {
    return new StoreError(
      "collaboration.cutover-conflict",
      `The ${label} lock at ${path} is unreadable or malformed. Confirm that no ${label} process is running ` +
        `on any host that shares this harness, remove that file, and retry. ${header}`,
    );
  }
  if (owner.host === hostname()) {
    return new StoreError(
      "collaboration.cutover-conflict",
      `Another ${label} is running on this host (pid ${String(owner.pid)}, started at ${owner.startedAt}) ` +
        `and holds ${path}. Wait for it to finish; a stuck run must be stopped before retrying. ${header}`,
    );
  }
  return new StoreError(
    "collaboration.cutover-conflict",
    `The ${label} lock at ${path} is held on host ${owner.host} (pid ${String(owner.pid)}, started at ` +
      `${owner.startedAt}), which cannot be probed from here. Confirm that the ${label} is not running on that host, ` +
      `remove the lock file only then, and retry. ${header}`,
  );
}

function cutoverRecoveryRefusal(label: string, recoveryPath: string, holder: CutoverLockOwner | null): StoreError {
  const who =
    holder === null
      ? "an unreadable recovery slot"
      : `pid ${String(holder.pid)} on ${holder.host}, started at ${holder.startedAt}`;
  return new StoreError(
    "collaboration.cutover-conflict",
    `Another process is recovering the stale ${label} lock (recovery slot ${recoveryPath}, ${who}). ` +
      `Wait for it and retry; if that process is gone, confirm no ${label} is running and remove the recovery slot ` +
      `file, then retry. Nothing was inspected, claimed, fenced or published.`,
  );
}

function releaseCutoverLockFile(path: string, token: string): void {
  try {
    const held = readCutoverLock(path);
    if (held !== null && held.token === token) unlinkSync(path);
  } catch {
  }
}

function recoverStaleCutoverLock(
  label: string,
  path: string,
  recoveryPath: string,
  staleOwner: CutoverLockOwner,
  attemptToken: string,
): boolean {
  const recoveryOwner: CutoverLockOwner = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    token: recoverySlotToken(attemptToken),
  };
  try {
    writeFileSync(recoveryPath, `${JSON.stringify(recoveryOwner)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") return false;
    throw lockCreateRefusal(label, recoveryPath, error);
  }
  try {
    const current = readCutoverLock(path);
    if (current === null) return true;
    if (current.token !== staleOwner.token) return true;
    unlinkSync(path);
    return true;
  } finally {
    releaseCutoverLockFile(recoveryPath, recoveryOwner.token);
  }
}

function recoverySlotToken(attemptToken: string): string {
  return `${attemptToken}:recover:${randomUUID()}`;
}

function acquireCutoverLock(label: string, path: string, recoveryPath: string, owner: CutoverLockOwner): void {
  for (let attempt = 1; ; attempt++) {
    try {
      writeFileSync(path, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw lockCreateRefusal(label, path, error);
    }
    const held = readCutoverLock(path);
    if (held === null) throw cutoverLockRefusal(label, path, null);
    const stale = held.host === owner.host && !processIsAlive(held.pid);
    if (!stale || attempt >= STALE_LOCK_ATTEMPTS) throw cutoverLockRefusal(label, path, held);
    if (!recoverStaleCutoverLock(label, path, recoveryPath, held, owner.token)) {
      throw cutoverRecoveryRefusal(label, recoveryPath, readCutoverLock(recoveryPath));
    }
  }
}

/**
 * The one local OS cutover lock. Scope: `plan`, `apply`, `activate` (and the
 * durable fence entry) serialize their whole inspect/claim/fence/publish
 * critical section across processes of this host and across hosts that share
 * the control harness. It is exported as the shared critical-section primitive
 * for the operator verbs that wrap multi-step work. Ordinary collaboration
 * writers do not take it: the operator's complete-stop assertion covers them.
 *
 * Acquisition is an exclusive create carrying `{pid, host, startedAt, token}`;
 * stale recovery goes through its own exclusive recovery slot (see
 * `recoverStaleCutoverLock`). A live or foreign-host lock refuses with a named
 * recovery, and release removes a file only when it still carries this
 * attempt's token, in `finally`, so a throwing step never leaves the lock held.
 */
export async function withCollaborationCutoverLock<T>(context: StoreContext, work: () => Promise<T>): Promise<T> {
  return withCollaborationLockFile(cutoverLockPath(context), "collaboration cutover", work);
}

/**
 * The same exclusive-file primitive over an EXPLICIT path. Two checkouts of one
 * repository resolve one canonical store path but different harness roots, so a
 * critical section over shared store bytes (retirement, publication) keys its
 * lock by that store/binding path instead of `{HARNESS_DIR}`. The stale-lock
 * recovery protocol is the cutover lock's; only the label and location differ.
 */
export async function withCollaborationLockFile<T>(
  path: string,
  label: string,
  work: () => Promise<T>,
): Promise<T> {
  const owner: CutoverLockOwner = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    token: randomUUID(),
  };
  acquireCutoverLock(label, path, cutoverRecoveryPath(path), owner);
  try {
    return await work();
  } finally {
    releaseCutoverLockFile(path, owner.token);
  }
}

function tableExists(db: StoreDb, table: string): boolean {
  const row = db
    .prepare("select count(*) as n from sqlite_master where type = 'table' and name = ?")
    .get(table) as { n?: number } | undefined;
  return row?.n === 1;
}

function readRows(db: StoreDb, table: string, columns: readonly string[]): unknown[][] {
  const list = columns.join(", ");
  const rows = db.prepare(`select ${list} from ${table} order by ${list}`).all() as Array<Record<string, unknown>>;
  return rows.map((row) => columns.map((column) => (typeof row[column] === "bigint" ? String(row[column]) : row[column])));
}

/** see packages/engine/src/collaboration-cutover.ts - The one value the retired catalog kind becomes on the combined-to-lane path. The lane's CHECK no longer admits `roadmap`, so a combined source holding such a row is copied as `other`: identity, revision and registration are untouched and no catalog row is dropped. The same normalization runs on BOTH sides of the copy - the source snapshot that feeds the reviewed digest and the staged copy the verification re-reads - so the evidence stays exact. */
const RETIRED_DOCUMENT_KIND = "roadmap";
const RETIRED_DOCUMENT_KIND_REPLACEMENT = "other";

function normalizeCutoverRow(table: string, columns: readonly string[], row: unknown[]): unknown[] {
  if (table !== "catalog_entities") return row;
  const index = columns.indexOf("document_kind");
  if (index < 0 || row[index] !== RETIRED_DOCUMENT_KIND) return row;
  const normalized = [...row];
  normalized[index] = RETIRED_DOCUMENT_KIND_REPLACEMENT;
  return normalized;
}

function readCutoverRows(db: StoreDb): Record<string, unknown[][]> {
  const rows: Record<string, unknown[][]> = {};
  for (const table of COLLABORATION_CUTOVER_TABLES) {
    if (!tableExists(db, table)) {
      throw new StoreError(
        "collaboration.cutover-required",
        `The combined store has no ${table} table, so it is not a complete pre-cutover source. Run ` +
          `"mstar store upgrade --operator <name>" to reach the current combined schema, then re-plan. Nothing was written.`,
      );
    }
    const columns = COLLABORATION_COLUMNS[table]!;
    const present = new Set(
      (db.prepare(`pragma table_info(${table})`).all() as Array<{ name?: unknown }>).map((column) => column.name),
    );
    const missing = columns.filter((column) => !present.has(column));
    if (missing.length > 0) {
      throw new StoreError(
        "collaboration.cutover-required",
        `The combined store's ${table} table cannot be copied exactly (missing columns: ${missing.join(", ")}). ` +
          `Run "mstar store upgrade --operator <name>" to reach the current combined schema, then re-plan. Nothing was written.`,
      );
    }
    rows[table] = readRows(db, table, columns).map((row) => normalizeCutoverRow(table, columns, row));
  }
  return rows;
}

function countsOf(rows: Record<string, unknown[][]>, ledger: unknown[][]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of COLLABORATION_CUTOVER_TABLES) counts[table] = rows[table]?.length ?? 0;
  counts.store_operations = ledger.length;
  return counts;
}

function digestOfRows(rows: Record<string, unknown[][]>, ledger: unknown[][]): string {
  const hash = createHash("sha256");
  for (const table of COLLABORATION_CUTOVER_TABLES) {
    hash.update(`${table}\n`);
    for (const row of rows[table] ?? []) hash.update(`${JSON.stringify(row)}\n`);
  }
  hash.update("store_operations\n");
  for (const row of ledger) hash.update(`${JSON.stringify(row)}\n`);
  return hash.digest("hex");
}

function digestOfSource(source: CutoverSource, rows: Record<string, unknown[][]>, ledger: unknown[][]): string {
  return sha256(
    `${source.storeId}|${source.epoch}|${source.schemaVersion}|${source.revision}|${source.catalogRevision}\n` +
      digestOfRows(rows, ledger),
  );
}

type ReceiptOwnership = "collaboration" | "execution" | { unproven: string };

function isReceiptObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function onlyKnownKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function isIssueReceipt(record: Record<string, unknown>): boolean {
  return (
    isText(record.issueId) &&
    isCount(record.revision) &&
    isCount(record.storeRevision) &&
    typeof record.created === "boolean" &&
    (record.occurrenceId === undefined || isCount(record.occurrenceId)) &&
    (record.fromProject === undefined || isText(record.fromProject)) &&
    (record.toProject === undefined || isText(record.toProject)) &&
    (record.clearedMilestoneId === undefined || record.clearedMilestoneId === null || isText(record.clearedMilestoneId)) &&
    onlyKnownKeys(record, [
      "issueId",
      "occurrenceId",
      "revision",
      "storeRevision",
      "created",
      "fromProject",
      "toProject",
      "clearedMilestoneId",
    ])
  );
}

function isMilestoneReceipt(record: Record<string, unknown>): boolean {
  return (
    isText(record.projectId) &&
    isText(record.milestoneId) &&
    isCount(record.revision) &&
    isCount(record.storeRevision) &&
    typeof record.changed === "boolean" &&
    onlyKnownKeys(record, ["projectId", "milestoneId", "revision", "storeRevision", "changed"])
  );
}

function isProjectBindingReceipt(record: Record<string, unknown>): boolean {
  return (
    isText(record.projectId) &&
    isText(record.provider) &&
    isText(record.remoteProject) &&
    isCount(record.revision) &&
    isCount(record.storeRevision) &&
    typeof record.changed === "boolean" &&
    onlyKnownKeys(record, ["projectId", "provider", "remoteProject", "revision", "storeRevision", "changed"])
  );
}

/** see packages/engine/src/collaboration-cutover.ts - The retired roadmap writer's persisted receipt, still promoted verbatim as a historical operation. It recorded the returned receipt PLUS the recorded outcome and the nullable reviewed provenance: `{projectId, revision, contentHash, storeRevision, outcome: "committed", provenance: {sourcePath, sourceHash} | null}`. A receipt written before those two fields were recorded keeps the four-field shape, which is accepted too - both are exact key sets, never a loose subset. */
function isRoadmapReceipt(record: Record<string, unknown>): boolean {
  const provenance = record.provenance;
  const provenanceOk =
    record.provenance === undefined
      ? true
      : provenance === null ||
        (isReceiptObject(provenance) &&
          isText(provenance.sourcePath) &&
          isText(provenance.sourceHash) &&
          onlyKnownKeys(provenance, ["sourcePath", "sourceHash"]));
  return (
    isText(record.projectId) &&
    isCount(record.revision) &&
    isText(record.contentHash) &&
    isCount(record.storeRevision) &&
    (record.outcome === undefined || record.outcome === "committed") &&
    provenanceOk &&
    onlyKnownKeys(record, ["projectId", "revision", "contentHash", "storeRevision", "outcome", "provenance"])
  );
}

function isSyncItemReceipt(record: Record<string, unknown>): boolean {
  const nullableText = (value: unknown): boolean => value === null || isText(value);
  return (
    isText(record.bindingId) &&
    (record.direction === "import" || record.direction === "push") &&
    isText(record.localId) &&
    nullableText(record.externalId) &&
    typeof record.itemState === "string" &&
    ["unbound", "pending", "applied", "failed", "skipped"].includes(record.itemState) &&
    nullableText(record.lastRemoteUpdatedAt) &&
    nullableText(record.pendingTarget) &&
    nullableText(record.lastError) &&
    nullableText(record.lastSkipReason) &&
    nullableText(record.lastRequestHash) &&
    Array.isArray(record.lastKindLabels) &&
    record.lastKindLabels.every((label) => typeof label === "string") &&
    isCount(record.revision) &&
    isText(record.updatedAt) &&
    onlyKnownKeys(record, [
      "bindingId",
      "direction",
      "localId",
      "externalId",
      "itemState",
      "lastRemoteUpdatedAt",
      "pendingTarget",
      "lastError",
      "lastSkipReason",
      "lastRequestHash",
      "lastKindLabels",
      "revision",
      "updatedAt",
    ])
  );
}

function isSyncCursorReceipt(record: Record<string, unknown>): boolean {
  return (
    onlyKnownKeys(record, ["cursor"]) &&
    Object.hasOwn(record, "cursor") &&
    (record.cursor === null || isText(record.cursor))
  );
}

function isRecoveryRecord(record: Record<string, unknown>): boolean {
  const verified = record.verified;
  return (
    isCount(record.recoveryVersion) &&
    record.phase === "replaced" &&
    isText(record.storeId) &&
    isReceiptObject(verified) &&
    verified.integrity === "ok" &&
    verified.foreignKeys === "ok"
  );
}

function isExecutionImportResult(record: Record<string, unknown>): boolean {
  const optionalStrings = (value: unknown): boolean =>
    value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === "string"));
  return (
    (record.verdict === "upgraded" || record.verdict === "nothing-to-import") &&
    isCount(record.imported) &&
    optionalStrings(record.importedIds) &&
    (record.skipped === undefined || Array.isArray(record.skipped)) &&
    optionalStrings(record.dispositions) &&
    isText(record.sourceDigest) &&
    (record.inputDigest === undefined || isText(record.inputDigest)) &&
    onlyKnownKeys(record, ["verdict", "imported", "importedIds", "skipped", "dispositions", "sourceDigest", "inputDigest"])
  );
}

function isHostStateImportReport(record: Record<string, unknown>): boolean {
  return (
    (record.verdict === "imported" || record.verdict === "partially-imported" || record.verdict === "nothing-to-import") &&
    isReceiptObject(record.imported) &&
    isReceiptObject(record.merged) &&
    Array.isArray(record.findings) &&
    isText(record.sourceDigest)
  );
}

function receiptOwnership(row: unknown[]): ReceiptOwnership {
  const raw = row[2];
  if (typeof raw !== "string" || raw === "") return { unproven: "the receipt records no result payload" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { unproven: "the result payload is not JSON" };
  }
  if (!isReceiptObject(parsed)) return { unproven: "the result payload is not an object" };
  if (isRecoveryRecord(parsed)) return "execution";
  if (isExecutionImportResult(parsed)) return "execution";
  if (isHostStateImportReport(parsed)) return "execution";
  if (isIssueReceipt(parsed)) return "collaboration";
  if (isMilestoneReceipt(parsed)) return "collaboration";
  if (isProjectBindingReceipt(parsed)) return "collaboration";
  if (isRoadmapReceipt(parsed)) return "collaboration";
  if (isSyncItemReceipt(parsed)) return "collaboration";
  if (isSyncCursorReceipt(parsed)) return "collaboration";
  return { unproven: "the result payload matches no known collaboration or execution producer" };
}

function readSourceLedger(db: StoreDb): unknown[][] {
  if (!tableExists(db, "store_operations")) return [];
  const ledger: unknown[][] = [];
  for (const row of readRows(db, "store_operations", LEDGER_COLUMNS)) {
    const ownership = receiptOwnership(row);
    if (ownership === "execution") continue;
    if (ownership !== "collaboration") {
      throw conflict(
        `The combined store's operation receipt ${JSON.stringify(String(row[0]))} cannot be proven collaboration- or ` +
          `execution-owned (${ownership.unproven}). The cutover refuses to guess: inspect that receipt, resolve or ` +
          `remove it with the domain that owns it, then re-plan. Nothing was staged, fenced or published.`,
      );
    }
    ledger.push(row);
  }
  return ledger;
}

function readStagedLedger(db: StoreDb): unknown[][] {
  const rows = db
    .prepare(
      "select operation_id, request_hash, result_json, committed_at from collaboration_operations " +
        "where key_space = 'standalone' and operation_id <> ? order by operation_id, request_hash, result_json, committed_at",
    )
    .all(CLAIM_KEY) as Array<Record<string, unknown>>;
  return rows.map((row) => LEDGER_COLUMNS.map((column) => (typeof row[column] === "bigint" ? String(row[column]) : row[column])));
}

function readCutoverBlockers(db: StoreDb): Blockers {
  const blockers: Array<{ code: string; subject: string }> = [];
  const runs = db
    .prepare("select binding_id, direction, run_id from sync_runs order by binding_id, direction")
    .all() as Array<{ binding_id?: unknown; direction?: unknown; run_id?: unknown }>;
  for (const run of runs) {
    blockers.push({
      code: "collaboration.cutover-not-quiescent",
      subject: `mirror run ${String(run.direction)} for binding ${String(run.binding_id)} (${String(run.run_id)}) is still open`,
    });
  }
  const journal = db
    .prepare(
      "select operation_id, phase from catalog_operations " +
        "where phase in ('prepared','execution-written') order by operation_id",
    )
    .all() as Array<{ operation_id?: unknown; phase?: unknown }>;
  for (const entry of journal) {
    blockers.push({
      code: "collaboration.cutover-not-quiescent",
      subject: `catalog operation ${String(entry.operation_id)} is ${String(entry.phase)}, not committed`,
    });
  }
  return blockers;
}

function readSourceSnapshot(db: StoreDb): SourceSnapshot {
  const authority = readStoreAuthority(db);
  if (
    authority.missing ||
    typeof authority.storeId !== "string" ||
    typeof authority.epoch !== "number" ||
    typeof authority.revision !== "number" ||
    typeof authority.catalogRevision !== "number"
  ) {
    throw new StoreError(
      "store.corrupt",
      "store_meta is missing or malformed; the combined source's generation cannot be frozen. Nothing was read further.",
    );
  }
  const schemaVersion = validateAppliedMigrations(readAppliedMigrations(db, false));
  if (schemaVersion < SOURCE_SCHEMA_FLOOR) {
    throw new StoreError(
      "collaboration.cutover-required",
      `The combined store is at schema ${schemaVersion}, below the cutover source floor ${SOURCE_SCHEMA_FLOOR}. Run ` +
        `"mstar store upgrade --operator <name>" first, then re-plan. Nothing was written.`,
    );
  }
  // shortcut: one source snapshot is held in memory while it is copied, which
  // suits a reviewed local database.
  // upgrade: stream the rows when a reviewed source can approach hundreds of
  // megabytes or the snapshot no longer fits the process budget.
  const rows = readCutoverRows(db);
  const ledger = readSourceLedger(db);
  const source: CutoverSource = {
    storeId: authority.storeId,
    epoch: authority.epoch,
    schemaVersion,
    revision: authority.revision,
    catalogRevision: authority.catalogRevision,
  };
  return { source, counts: countsOf(rows, ledger), rows, ledger, digest: digestOfSource(source, rows, ledger) };
}

function readSourceSessions(db: StoreDb): Array<{ sessionId: string; state: string }> {
  if (!tableExists(db, "execution_sessions")) return [];
  return (db
    .prepare("select session_id, state from execution_sessions order by session_id")
    .all() as Array<{ session_id?: unknown; state?: unknown }>).map((row) => ({
    sessionId: typeof row.session_id === "string" ? row.session_id : "",
    state: typeof row.state === "string" ? row.state : "",
  }));
}

async function readSourceState(context: StoreContext): Promise<SourceState> {
  const handle = await openStore(context, "read");
  try {
    const fence = readCollaborationFence(handle.db);
    if (fence !== null) return { fence, snapshot: null, blockers: [], sessions: [] };
    handle.db.exec("begin");
    try {
      return {
        fence: null,
        snapshot: readSourceSnapshot(handle.db),
        blockers: readCutoverBlockers(handle.db),
        sessions: readSourceSessions(handle.db),
      };
    } finally {
      handle.db.exec("commit");
    }
  } finally {
    handle.close();
  }
}

async function readSourceFence(context: StoreContext): Promise<CollaborationFence | null> {
  const handle = await openStore(context, "read");
  try {
    return readCollaborationFence(handle.db);
  } finally {
    handle.close();
  }
}

function sortedCounts(counts: Readonly<Record<string, number>>): Record<string, number> {
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(counts).sort()) sorted[key] = counts[key]!;
  return sorted;
}

function manifestBody(manifest: CutoverManifest): unknown {
  return {
    version: manifest.version,
    source: manifest.source,
    repoKey: manifest.repoKey,
    mode: manifest.mode,
    counts: sortedCounts(manifest.counts),
    sourceDigest: manifest.sourceDigest,
    blockers: manifest.blockers.map((blocker) => ({ code: blocker.code, subject: blocker.subject })),
  };
}

function assertManifest(manifest: CutoverManifest): string {
  if (manifest === null || typeof manifest !== "object" || manifest.version !== 1) {
    throw conflict("The supplied cutover manifest is not version 1. Re-run `store collaboration plan` and review its output.");
  }
  const source = manifest.source;
  const integer = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
  if (
    source === undefined ||
    typeof source.storeId !== "string" ||
    source.storeId === "" ||
    !integer(source.epoch) ||
    !integer(source.schemaVersion) ||
    !integer(source.revision) ||
    !integer(source.catalogRevision)
  ) {
    throw conflict("The supplied manifest's source generation is malformed. Re-run `store collaboration plan` and review its output.");
  }
  if (typeof manifest.repoKey !== "string" || manifest.repoKey === "" || (manifest.mode !== "local" && manifest.mode !== "mirror")) {
    throw conflict("The supplied manifest's repository identity is malformed. Re-run `store collaboration plan` and review its output.");
  }
  if (typeof manifest.sourceDigest !== "string" || manifest.sourceDigest === "") {
    throw conflict("The supplied manifest carries no source digest. Re-run `store collaboration plan` and review its output.");
  }
  if (manifest.counts === null || typeof manifest.counts !== "object") {
    throw conflict("The supplied manifest carries no row counts. Re-run `store collaboration plan` and review its output.");
  }
  for (const table of [...COLLABORATION_CUTOVER_TABLES, "store_operations"]) {
    if (!integer(manifest.counts[table])) {
      throw conflict(`The supplied manifest has no row count for ${table}. Re-run \`store collaboration plan\` and review its output.`);
    }
  }
  if (!Array.isArray(manifest.blockers)) {
    throw conflict("The supplied manifest carries no blocker list. Re-run `store collaboration plan` and review its output.");
  }
  const digest = sha256(canonicalJson(manifestBody(manifest)));
  if (manifest.manifestId !== digest.slice(0, 32)) {
    throw conflict(
      "The supplied manifest is not the reviewed output of `store collaboration plan` for this content (its id does not " +
        "match its own evidence). Re-plan and apply the reviewed manifest; nothing was staged, fenced or activated.",
    );
  }
  return digest;
}

function assertManifestScope(location: CollaborationLocation, manifest: CutoverManifest): void {
  if (manifest.repoKey !== location.repoKey || manifest.mode !== location.mode) {
    throw new StoreError(
      "collaboration.stale-binding",
      `The supplied manifest belongs to ${manifest.repoKey} (${manifest.mode}), while this checkout resolves ` +
        `${location.repoKey} (${location.mode}). Re-resolve the scope with "mstar path resolve" and plan the manifest ` +
        `for THIS repository; a manifest is never applied across a different repository or mode. Nothing was written.`,
    );
  }
}

function sameSource(a: CutoverSource, b: CutoverSource): boolean {
  return (
    a.storeId === b.storeId &&
    a.epoch === b.epoch &&
    a.schemaVersion === b.schemaVersion &&
    a.revision === b.revision &&
    a.catalogRevision === b.catalogRevision
  );
}

function sameCounts(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key] === b[key]);
}

function assertSnapshotMatches(snapshot: SourceSnapshot, manifest: CutoverManifest, detail: string): void {
  if (
    !sameSource(snapshot.source, manifest.source) ||
    snapshot.digest !== manifest.sourceDigest ||
    !sameCounts(snapshot.counts, manifest.counts)
  ) {
    throw conflict(
      `${detail} Re-plan against the source's current state and review the new manifest; the staged evidence was not ` +
        `reused, and nothing was fenced or activated.`,
    );
  }
}

function assertFenceMatches(
  fence: CollaborationFence,
  manifest: CutoverManifest,
  digest: string,
  target?: Readonly<{ storeId: string; epoch: number }>,
): void {
  if (fence.manifestId !== manifest.manifestId || fence.manifestDigest !== digest) {
    throw conflict(
      `The combined store was already fenced for manifest ${fence.manifestId} (fenced at ${fence.fencedAt}), not for ` +
        `${manifest.manifestId}. Preserve both sides: complete the activation of the fenced manifest, or plan a new ` +
        `cutover only after reconciling the target. Nothing was changed.`,
    );
  }
  if (target !== undefined && (fence.targetStoreId !== target.storeId || fence.targetEpoch !== target.epoch)) {
    throw conflict(
      `The persisted fence names target ${fence.targetStoreId} epoch ${fence.targetEpoch}, while this canonical path ` +
        `holds ${target.storeId} epoch ${target.epoch}. A foreign or replaced target never wins by force: restore the ` +
        `target the source was fenced for, or recover from the verified pre-fence image. Nothing was published.`,
    );
  }
}

function publicationFromRow(row: Record<string, unknown>): PublicationRow {
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const count = (value: unknown): number => (typeof value === "number" ? value : -1);
  const phase = row.phase;
  if (phase !== "verified" && phase !== "source-fenced" && phase !== "active") {
    throw new StoreError("store.corrupt", "cutover_publications holds an unknown phase; the cutover receipt cannot be verified.");
  }
  return {
    manifestId: text(row.manifest_id),
    phase,
    source: {
      storeId: text(row.source_store_id),
      epoch: count(row.source_epoch),
      schemaVersion: count(row.source_schema_version),
      revision: count(row.source_revision),
      catalogRevision: count(row.source_catalog_revision),
    },
    manifestDigest: text(row.manifest_digest),
    targetStoreId: text(row.target_store_id),
    targetEpoch: count(row.target_epoch),
    verifiedAt: text(row.verified_at),
    fencedAt: typeof row.fenced_at === "string" ? row.fenced_at : null,
    activatedAt: typeof row.activated_at === "string" ? row.activated_at : null,
  };
}

function readPublication(db: StoreDb, manifestId: string): PublicationRow | null {
  const row = db
    .prepare(
      "select manifest_id, phase, source_store_id, source_epoch, source_schema_version, source_revision, " +
        "source_catalog_revision, manifest_digest, target_store_id, target_epoch, verified_at, fenced_at, activated_at " +
        "from cutover_publications where manifest_id = ?",
    )
    .get(manifestId) as Record<string, unknown> | undefined;
  return row === undefined ? null : publicationFromRow(row);
}

function readPublications(db: StoreDb): PublicationRow[] {
  const rows = db
    .prepare(
      "select manifest_id, phase, source_store_id, source_epoch, source_schema_version, source_revision, " +
        "source_catalog_revision, manifest_digest, target_store_id, target_epoch, verified_at, fenced_at, activated_at " +
        "from cutover_publications order by manifest_id",
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(publicationFromRow);
}

function readClaim(db: StoreDb): ClaimRow | null {
  const row = db
    .prepare(
      "select request_hash, result_json, committed_at from collaboration_operations " +
        "where key_space = 'standalone' and operation_id = ?",
    )
    .get(CLAIM_KEY) as { request_hash?: unknown; result_json?: unknown; committed_at?: unknown } | undefined;
  if (row === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(row.result_json));
  } catch {
    parsed = null;
  }
  const record = parsed as Record<string, unknown> | null;
  if (
    record === null ||
    typeof record !== "object" ||
    typeof record.manifestId !== "string" ||
    typeof record.manifestDigest !== "string" ||
    typeof record.sourceStoreId !== "string" ||
    typeof record.sourceEpoch !== "number"
  ) {
    throw new StoreError(
      "store.corrupt",
      "The cutover claim slot holds a malformed record; the target cannot be proven free for this activation. " +
        "Nothing was staged, fenced or activated.",
    );
  }
  return {
    requestHash: typeof row.request_hash === "string" ? row.request_hash : "",
    manifestId: record.manifestId,
    manifestDigest: record.manifestDigest,
    sourceStoreId: record.sourceStoreId,
    sourceEpoch: record.sourceEpoch,
    claimedAt: typeof row.committed_at === "string" ? row.committed_at : "",
  };
}

function receiptOf(
  publication: PublicationRow,
  base: Readonly<{ repoKey: string; mode: CollaborationMode }>,
  replayed: boolean,
): CutoverReceipt {
  return {
    manifestId: publication.manifestId,
    phase: publication.phase,
    source: publication.source,
    target: {
      repoKey: base.repoKey,
      mode: base.mode,
      storeId: publication.targetStoreId,
      epoch: publication.targetEpoch,
    },
    verifiedAt: publication.verifiedAt,
    ...(publication.fencedAt === null ? {} : { fencedAt: publication.fencedAt }),
    ...(publication.activatedAt === null ? {} : { activatedAt: publication.activatedAt }),
    replayed,
  };
}

async function readTargetStateFor(
  location: CollaborationLocation,
  manifestId: string,
): Promise<TargetState | null> {
  if (!existsSync(location.dbPath)) return null;
  return readCollaborationStage(location, ({ db, authority }) => ({
    authority,
    publication: readPublication(db, manifestId),
    claim: readClaim(db),
  }));
}

function verifyStagedEvidence(db: StoreDb, manifest: CutoverManifest): void {
  const meta = db
    .prepare("select revision, catalog_revision from collaboration_meta where id = 1")
    .get() as { revision?: unknown; catalog_revision?: unknown } | undefined;
  if (meta?.revision !== manifest.source.revision || meta?.catalog_revision !== manifest.source.catalogRevision) {
    throw conflict(
      `The staged target carries revision ${String(meta?.revision)}/${String(meta?.catalog_revision)}, not the reviewed ` +
        `${manifest.source.revision}/${manifest.source.catalogRevision}. Restage from the reviewed manifest; nothing was fenced.`,
    );
  }
  const rows = readCutoverRows(db);
  const ledger = readStagedLedger(db);
  if (
    !sameCounts(countsOf(rows, ledger), manifest.counts) ||
    digestOfSource(manifest.source, rows, ledger) !== manifest.sourceDigest
  ) {
    throw conflict(
      "The staged copy no longer matches the reviewed manifest's exact row evidence. Restage from the reviewed " +
        "manifest; the source was not fenced and the target was not activated.",
    );
  }
  const violations = db.prepare("pragma foreign_key_check").all();
  if (violations.length > 0) {
    throw conflict(
      `The staged copy holds ${violations.length} row(s) violating the collaboration schema's foreign keys ` +
        `(first: ${JSON.stringify(violations[0])}). Fix the source's integrity, then re-plan; nothing was fenced.`,
    );
  }
}

function replaceStagedRows(db: StoreDb, rows: Record<string, unknown[][]>, ledger: unknown[][]): void {
  for (const table of [...COLLABORATION_CUTOVER_TABLES].reverse()) db.prepare(`delete from ${table}`).run();
  for (const table of COLLABORATION_CUTOVER_TABLES) {
    const columns = table === "issues" ? [...COLLABORATION_COLUMNS[table]!, "issue_ref"] : COLLABORATION_COLUMNS[table]!;
    const statement = db.prepare(
      `insert into ${table}(${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
    );
    for (const row of rows[table] ?? []) {
      if (table === "issues") statement.run(...row, mintIssueRef());
      else statement.run(...row);
    }
  }
  db.prepare("delete from collaboration_operations where key_space = 'standalone'").run();
  const receipt = db.prepare(
    "insert into collaboration_operations(key_space, operation_id, request_hash, result_json, committed_at) " +
      "values ('standalone', ?, ?, ?, ?)",
  );
  for (const row of ledger) receipt.run(...row);
}

function assertCutoverAttestation(
  context: StoreContext,
  location: CollaborationLocation,
  manifest: CutoverManifest,
  attestation: ActivationAttestation,
  sessions: readonly { sessionId: string; state: string }[],
): void {
  const invalid: (detail: string) => never = (detail) => {
    throw new StoreError(
      "store.attestation-invalid",
      `${detail} Attest this exact control root, source generation, build and stopped handles; nothing was fenced or ` +
        `activated.`,
    );
  };
  const build = readHarnessVersionOrNull();
  const coordinator = attestation.consumers.find((consumer) => consumer.current);
  if (build === null) {
    invalid("This build cannot name its own version, so the attestation cannot be bound to the build performing the fence.");
  }
  if (coordinator === undefined || coordinator.version !== build) {
    invalid(
      `The attestation names build ${String(coordinator?.version)} as the current coordinator, while this activation runs ` +
        `build ${String(build)}.`,
    );
  }
  const block = attestation.cutover;
  if (block === undefined) {
    invalid(
      "The attestation carries no `cutover` block, so its control root, source generation and stopped handles are unproven.",
    );
  }
  if (block.repoKey !== location.repoKey || block.mode !== location.mode) {
    invalid(
      `The cutover block names repository ${block.repoKey} (${block.mode}), while this activation resolves ` +
        `${location.repoKey} (${location.mode}).`,
    );
  }
  const controlRoot = resolve(context.harnessDir);
  if (resolve(block.controlRoot) !== controlRoot) {
    invalid(
      `The cutover block names control root ${block.controlRoot}, while this activation runs in ${controlRoot}.`,
    );
  }
  if (
    block.sourceStoreId !== manifest.source.storeId ||
    block.sourceEpoch !== manifest.source.epoch ||
    block.schemaVersion !== manifest.source.schemaVersion
  ) {
    invalid(
      `The cutover block names source ${block.sourceStoreId} epoch ${block.sourceEpoch} schema ${block.schemaVersion}, ` +
        `while the reviewed manifest extracts ${manifest.source.storeId} epoch ${manifest.source.epoch} schema ` +
        `${manifest.source.schemaVersion}.`,
    );
  }
  const known = new Set(sessions.map((session) => session.sessionId));
  for (const stopped of attestation.stoppedSessions) {
    if (!known.has(stopped.sessionId)) {
      invalid(`The attestation stops session ${stopped.sessionId}, which this combined store does not record.`);
    }
  }
  const attestedSessions = new Set(attestation.stoppedSessions.map((stopped) => stopped.sessionId));
  for (const handle of block.stoppedHandles) {
    if (handle.kind !== "session") continue;
    if (!known.has(handle.id)) {
      invalid(`The cutover block stops session ${handle.id}, which this combined store does not record.`);
    }
    attestedSessions.add(handle.id);
  }
  const surviving = sessions.filter(
    (session) => LIVE_SESSION_STATES[session.state] === true && !attestedSessions.has(session.sessionId),
  );
  if (surviving.length > 0) {
    invalid(
      `This combined store still records ${surviving.length} live session(s) that the attestation does not stop ` +
        `(${surviving.map((session) => `${session.sessionId} is ${session.state}`).join("; ")}).`,
    );
  }
}

async function releaseOwnClaim(
  location: CollaborationLocation,
  manifest: CutoverManifest,
  digest: string,
): Promise<boolean> {
  return writeCollaborationStage(location, ({ db }) => {
    const claim = readClaim(db);
    if (
      claim === null ||
      claim.manifestId !== manifest.manifestId ||
      claim.manifestDigest !== digest ||
      claim.sourceStoreId !== manifest.source.storeId ||
      claim.sourceEpoch !== manifest.source.epoch
    ) {
      return false;
    }
    db.prepare("delete from collaboration_operations where key_space = 'standalone' and operation_id = ?").run(CLAIM_KEY);
    return true;
  });
}

type StaleClaimOutcome = Readonly<{ kind: "released" | "unowned" | "aligned" }> | Readonly<{
  kind: "fenced";
  fence: CollaborationFence;
}>;

async function releaseStaleClaim(
  context: StoreContext,
  location: CollaborationLocation,
  manifest: CutoverManifest,
  digest: string,
): Promise<StaleClaimOutcome> {
  const source = await openStore(context, "write");
  try {
    source.db.exec("begin immediate");
    try {
      const fence = readCollaborationFence(source.db);
      if (fence !== null) return { kind: "fenced", fence };
      const snapshot = readSourceSnapshot(source.db);
      const aligned =
        sameSource(snapshot.source, manifest.source) &&
        snapshot.digest === manifest.sourceDigest &&
        sameCounts(snapshot.counts, manifest.counts);
      if (aligned) return { kind: "aligned" };
      const released = await releaseOwnClaim(location, manifest, digest);
      return { kind: released ? "released" : "unowned" };
    } finally {
      try {
        source.db.exec("rollback");
      } catch {
      }
    }
  } finally {
    source.close();
  }
}

function ensureFenceSchema(db: StoreDb): number {
  const max = validateAppliedMigrations(readAppliedMigrations(db, false));
  if (max < SOURCE_SCHEMA_FLOOR) {
    throw new StoreError(
      "store.schema-drift",
      `The combined store is at schema ${max}, below the cutover source floor ${SOURCE_SCHEMA_FLOOR}. Run ` +
        `"mstar store upgrade --operator <name>" to reach the current schema; nothing was fenced.`,
    );
  }
  return max;
}

export async function planCollaborationCutover(context: StoreContext): Promise<CutoverManifest> {
  return withCollaborationCutoverLock(context, () => planUnderCutoverLock(context));
}

async function planUnderCutoverLock(context: StoreContext): Promise<CutoverManifest> {
  const location = resolveCollaborationLocation(context);
  const state = await readSourceState(context);
  if (state.fence !== null) {
    throw conflict(
      `The combined store at ${storeDbPath(context)} was already cut over (manifest ${state.fence.manifestId}, ` +
        `fenced at ${state.fence.fencedAt}) and keeps its rows only through the verified pre-fence image ` +
        `${state.fence.backupPath}. There is nothing left to plan for this source; read collaboration through ` +
        `"mstar path resolve" and the active repository authority instead. Nothing was written.`,
    );
  }
  const snapshot = state.snapshot!;
  const base = {
    version: 1 as const,
    source: snapshot.source,
    repoKey: location.repoKey,
    mode: location.mode,
    counts: sortedCounts(snapshot.counts),
    sourceDigest: snapshot.digest,
    blockers: state.blockers,
  };
  const digest = sha256(canonicalJson(base));
  return { ...base, manifestId: digest.slice(0, 32) };
}

async function receiptFromFencedSource(
  location: CollaborationLocation,
  manifest: CutoverManifest,
  digest: string,
  fence: CollaborationFence,
): Promise<CutoverReceipt> {
  const target = await readTargetStateFor(location, manifest.manifestId);
  if (target === null || target.publication === null) {
    throw conflict(
      `The source is fenced for manifest ${manifest.manifestId}, but the target holds no publication record for it. ` +
        `Preserve both sides and complete the activation from the original session; nothing was written.`,
    );
  }
  assertFenceMatches(fence, manifest, digest, target.authority);
  return receiptOf(target.publication, location, true);
}

export async function applyCollaborationCutover(
  context: StoreContext,
  manifest: CutoverManifest,
): Promise<CutoverReceipt> {
  return withCollaborationCutoverLock(context, () => applyUnderCutoverLock(context, manifest));
}

async function applyUnderCutoverLock(
  context: StoreContext,
  manifest: CutoverManifest,
): Promise<CutoverReceipt> {
  const digest = assertManifest(manifest);
  const location = resolveCollaborationLocation(context);
  assertManifestScope(location, manifest);
  if (manifest.blockers.length > 0) {
    throw notQuiescent(manifest.blockers, "The reviewed manifest still reports pending work.");
  }
  const source = await openStore(context, "write");
  try {
    source.db.exec("begin immediate");
    try {
      const fence = readCollaborationFence(source.db);
      if (fence !== null) return await receiptFromFencedSource(location, manifest, digest, fence);
      const snapshot = readSourceSnapshot(source.db);
      assertSnapshotMatches(snapshot, manifest, "The source changed since the manifest was reviewed.");
      const blockers = readCutoverBlockers(source.db);
      if (blockers.length > 0) {
        throw notQuiescent(blockers, "The source reported pending work when staging started.");
      }
      const collision = snapshot.ledger.find((row) => row[0] === CLAIM_KEY);
      if (collision !== undefined) {
        throw conflict(
          `The source holds a legacy operation whose id is the cutover claim slot (${CLAIM_KEY}); promoting it would let ` +
            `the claim delete a reviewed receipt. Rename that legacy operation first, then re-plan; nothing was staged.`,
        );
      }

      await initializeCollaborationStore(location);
      return await writeCollaborationStage(location, ({ db, authority }) => {
        const publication = readPublication(db, manifest.manifestId);
        const claim = readClaim(db);
        if (claim !== null) {
          throw conflict(
            `An activation (manifest ${claim.manifestId}, claimed at ${claim.claimedAt}) already holds the canonical ` +
              `target, so no other manifest may stage over it. Complete or abandon that activation in its own session; ` +
              `nothing was staged.`,
          );
        }
        if (authority.state === "active") {
          throw conflict(
            `The collaboration store at ${location.dbPath} is already active. "apply" never republishes or restages an ` +
              `active authority: read it through the runtime verbs, or resume its own activation with the fenced ` +
              `manifest. Nothing was written.`,
          );
        }
        for (const other of readPublications(db)) {
          if (other.manifestId === manifest.manifestId) continue;
          if (other.phase !== "verified") {
            throw conflict(
              `The canonical target already progressed past verification for manifest ${other.manifestId} ` +
                `(phase ${other.phase}); it can no longer be restaged. Complete that activation or recover it from its ` +
                `verified pre-fence image. Nothing was written.`,
            );
          }
          if (other.source.storeId !== manifest.source.storeId || other.source.epoch !== manifest.source.epoch) {
            throw conflict(
              `The staged target was verified for source ${other.source.storeId} epoch ${other.source.epoch}, not ` +
                `${manifest.source.storeId} epoch ${manifest.source.epoch}. Two sources cannot stage on one canonical ` +
                `target; keep both and select the already active repository authority for this clone. Nothing was written.`,
            );
          }
        }
        if (publication !== null && publication.phase !== "verified") {
          throw conflict(
            `The target holds a ${publication.phase} publication for this manifest, not a restageable verification. ` +
              `Complete it with "store collaboration activate" instead. Nothing was written.`,
          );
        }

        replaceStagedRows(db, snapshot.rows, snapshot.ledger);
        db.prepare("update collaboration_meta set revision = ?, catalog_revision = ? where id = 1").run(
          manifest.source.revision,
          manifest.source.catalogRevision,
        );
        verifyStagedEvidence(db, manifest);
        const replayed = publication !== null && publication.manifestDigest === digest;
        const verifiedAt = replayed ? publication!.verifiedAt : nowRfc3339();
        db.prepare(
          "insert into cutover_publications(manifest_id, phase, source_store_id, source_epoch, source_schema_version, " +
            "source_revision, source_catalog_revision, manifest_digest, target_store_id, target_epoch, verified_at, " +
            "fenced_at, activated_at) values (?, 'verified', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL) " +
            "on conflict(manifest_id) do update set phase = 'verified', source_store_id = excluded.source_store_id, " +
            "source_epoch = excluded.source_epoch, source_schema_version = excluded.source_schema_version, " +
            "source_revision = excluded.source_revision, source_catalog_revision = excluded.source_catalog_revision, " +
            "manifest_digest = excluded.manifest_digest, target_store_id = excluded.target_store_id, " +
            "target_epoch = excluded.target_epoch, verified_at = excluded.verified_at, fenced_at = NULL, activated_at = NULL",
        ).run(
          manifest.manifestId,
          manifest.source.storeId,
          manifest.source.epoch,
          manifest.source.schemaVersion,
          manifest.source.revision,
          manifest.source.catalogRevision,
          digest,
          authority.storeId,
          authority.epoch,
          verifiedAt,
        );
        db.prepare("delete from cutover_publications where manifest_id <> ?").run(manifest.manifestId);
        const stored = readPublication(db, manifest.manifestId)!;
        return receiptOf(stored, location, replayed);
      });
    } finally {
      try {
        source.db.exec("rollback");
      } catch {
      }
    }
  } finally {
    source.close();
  }
}

async function prepareActivation(
  context: StoreContext,
  manifest: CutoverManifest,
  options: CutoverActivationOptions,
): Promise<Prepared & { replay: CutoverReceipt | null }> {
  const digest = assertManifest(manifest);
  if (options === null || typeof options !== "object") {
    throw new StoreError("store.attestation-invalid", "An activation requires an operator and an attestation document.");
  }
  const operator = options.operator;
  if (typeof operator !== "string" || operator.trim() === "") {
    throw new StoreError(
      "store.attestation-invalid",
      "An activation requires the named operator (--operator <name>); it is recorded as the approving actor. Nothing was written.",
    );
  }
  const attestation = validateActivationAttestation(options.attestation);
  if (attestation.operator.actor !== operator) {
    throw new StoreError(
      "store.attestation-invalid",
      `The attestation names operator ${attestation.operator.actor}, not ${operator}. Attest this activation under the ` +
        `operator who actually approved it; nothing was written.`,
    );
  }
  const location = resolveCollaborationLocation(context);
  assertManifestScope(location, manifest);
  if (manifest.blockers.length > 0) {
    throw notQuiescent(manifest.blockers, "The reviewed manifest still reports pending work.");
  }
  const target = await readTargetStateFor(location, manifest.manifestId);
  if (target === null) {
    throw new StoreError(
      "collaboration.not-initialized",
      `No staged collaboration target exists at ${location.dbPath}. Run "store collaboration apply" with this reviewed ` +
        `manifest first; nothing was staged, fenced or activated.`,
    );
  }

  for (let attempt = 0; ; attempt++) {
    const source = await readSourceState(context);
    if (source.fence === null) {
      const aligned =
        sameSource(source.snapshot!.source, manifest.source) &&
        source.snapshot!.digest === manifest.sourceDigest &&
        sameCounts(source.snapshot!.counts, manifest.counts);
      if (!aligned) {
        if (attempt > 0) {
          throw conflict(
            `The source keeps changing while this activation runs. Stop the remaining writers, re-plan, and retry with ` +
              `the new reviewed manifest; nothing was fenced or activated.`,
          );
        }
        const outcome = await releaseStaleClaim(context, location, manifest, digest);
        if (outcome.kind === "aligned" || outcome.kind === "fenced") continue;
        throw conflict(
          `The source changed since manifest ${manifest.manifestId} was reviewed. ` +
            `${outcome.kind === "released" ? "This activation's claim was released (with the source still unfenced), so the source can be re-planned and staged again." : "No claim was released because it is not held by this manifest and source."} ` +
            `Re-run "store collaboration plan", review the new manifest, then apply and activate it. Nothing was fenced.`,
        );
      }
      assertCutoverAttestation(context, location, manifest, attestation, source.sessions);
      if (source.blockers.length > 0) {
        throw notQuiescent(source.blockers, "The source reported pending work when activation started.");
      }
    } else {
      assertFenceMatches(source.fence, manifest, digest, target.authority);
    }

    if (target.authority.state === "active") {
      const published = target.publication;
      if (published === null || published.phase !== "active" || published.manifestDigest !== digest) {
        throw conflict(
          `The collaboration store at ${location.dbPath} is active, but not for manifest ${manifest.manifestId}. Read it ` +
            `through the runtime verbs; an active authority is never republished or replaced. Nothing was written.`,
        );
      }
      if (published.targetStoreId !== target.authority.storeId || published.targetEpoch !== target.authority.epoch) {
        throw conflict(
          `The active publication belongs to target ${published.targetStoreId} epoch ${published.targetEpoch}, while the ` +
            `canonical path holds ${target.authority.storeId} epoch ${target.authority.epoch}. A foreign target never ` +
            `wins by force; nothing was replayed.`,
        );
      }
      if (source.fence === null) {
        throw conflict(
          `The collaboration target at ${location.dbPath} is active, but this combined source is not fenced (it still ` +
            `holds the collaboration tables). Replaying would report one authority while the source can still admit ` +
            `writes. Complete the fence for this source with its own activation, or read collaboration through the active ` +
            `repository authority. Nothing was replayed.`,
        );
      }
      return {
        context, location, manifest, digest, operator, attestation, source, target,
        replay: receiptOf(published, location, true),
      };
    }
    const publication = target.publication;
    if (publication === null || publication.manifestDigest !== digest) {
      throw conflict(
        `The staged target holds no verified publication for manifest ${manifest.manifestId}. Run ` +
          `"store collaboration apply" with this reviewed manifest first; nothing was fenced or activated.`,
      );
    }
    if (publication.targetStoreId !== target.authority.storeId || publication.targetEpoch !== target.authority.epoch) {
      throw conflict(
        `The verified publication belongs to target ${publication.targetStoreId} epoch ${publication.targetEpoch}, while ` +
          `the canonical path now holds ${target.authority.storeId} epoch ${target.authority.epoch}. A foreign target ` +
          `never wins by force: restore the verified target and resume, or recover from the verified pre-fence image. ` +
          `Nothing was fenced.`,
      );
    }
    return { context, location, manifest, digest, operator, attestation, source, target, replay: null };
  }
}

async function claimActivation(prepared: Prepared): Promise<void> {
  const { location, manifest, digest } = prepared;
  const requestHash = sha256(
    canonicalJson({
      manifestId: manifest.manifestId,
      manifestDigest: digest,
      repoKey: manifest.repoKey,
      mode: manifest.mode,
      source: manifest.source,
    }),
  );
  await writeCollaborationStage(location, ({ db, authority }) => {
    if (authority.state !== "staged") {
      throw conflict(
        `The target at ${location.dbPath} changed to ${authority.state} after verification; the activation claim was ` +
          `not taken. Resolve the competing activation before retrying. Nothing was written.`,
      );
    }
    const publication = readPublication(db, manifest.manifestId);
    if (publication === null || publication.manifestDigest !== digest) {
      throw conflict(
        `The staged target no longer holds the verified publication for manifest ${manifest.manifestId}. Re-apply the ` +
          `reviewed manifest before activating; nothing was fenced.`,
      );
    }
    verifyStagedEvidence(db, manifest);
    const claim = readClaim(db);
    if (claim === null) {
      const at = nowRfc3339();
      db.prepare(
        "insert into collaboration_operations(key_space, operation_id, request_hash, result_json, committed_at) " +
          "values ('standalone', ?, ?, ?, ?)",
      ).run(
        CLAIM_KEY,
        requestHash,
        JSON.stringify({
          manifestId: manifest.manifestId,
          manifestDigest: digest,
          sourceStoreId: manifest.source.storeId,
          sourceEpoch: manifest.source.epoch,
          claimedAt: at,
        }),
        at,
      );
      return;
    }
    if (claim.requestHash === requestHash) return;
    throw conflict(
      `Another activation holds the canonical target's claim (manifest ${claim.manifestId}, source ` +
        `${claim.sourceStoreId} epoch ${claim.sourceEpoch}, claimed at ${claim.claimedAt}). Preserve both; complete or ` +
        `abandon that activation in its own session. Nothing was fenced.`,
    );
  });
}

async function verifyBackupRows(path: string, manifest: CutoverManifest): Promise<string> {
  const db = await connect(path, "read", busyTimeoutMs());
  let rows: Record<string, unknown[][]>;
  let ledger: unknown[][];
  try {
    if (validateAppliedMigrations(readAppliedMigrations(db, false)) !== manifest.source.schemaVersion) {
      throw backupIncomplete(
        `The recovery point at ${path} was written at another schema than the reviewed ${manifest.source.schemaVersion}.`,
      );
    }
    rows = readCutoverRows(db);
    ledger = readSourceLedger(db);
  } finally {
    db.close();
  }
  const counts = countsOf(rows, ledger);
  if (!sameCounts(counts, manifest.counts) || digestOfSource(manifest.source, rows, ledger) !== manifest.sourceDigest) {
    throw backupIncomplete(
      `The retained recovery point at ${path} does not hold the reviewed rows (it records ` +
        `${counts.store_operations} legacy receipts and ${counts.issues} issues, and its row digest differs from the ` +
        `reviewed manifest). Rename or remove that image, or re-plan against the source's current rows; a fence never ` +
        `runs on an image that does not preserve the reviewed history.`,
    );
  }
  return path;
}

async function takeOrVerifyFenceBackup(prepared: Prepared): Promise<string> {
  const { context, manifest } = prepared;
  const out = join(
    dirname(storeDbPath(context)),
    "archived",
    "store-migration",
    "backups",
    `collaboration-cutover-${manifest.manifestId}.db`,
  );
  const verify = async (copy: BackupInspection): Promise<string> => {
    if (
      copy.storeId !== manifest.source.storeId ||
      copy.epoch !== manifest.source.epoch ||
      copy.revision !== manifest.source.revision ||
      copy.catalogRevision !== manifest.source.catalogRevision ||
      copy.schemaVersion !== manifest.source.schemaVersion
    ) {
      throw backupIncomplete(
        `The recovery point at ${out} describes ${copy.storeId} epoch ${copy.epoch} revision ${copy.revision}, not the ` +
          `reviewed source ${manifest.source.storeId} epoch ${manifest.source.epoch} revision ${manifest.source.revision}.`,
      );
    }
    return verifyBackupRows(out, manifest);
  };
  const inspect = async (): Promise<BackupInspection> => {
    try {
      return await inspectBackupCopy(out);
    } catch (error) {
      throw backupIncomplete(
        `The recovery point at ${out} cannot be verified (${error instanceof Error ? error.message : String(error)}). ` +
          `Rename or remove that image, or re-plan against the source's current rows.`,
      );
    }
  };
  if (existsSync(out)) return verify(await inspect());
  try {
    await backupStore(context, { out });
  } catch (error) {
    if (!existsSync(out)) {
      throw backupIncomplete(
        `The source recovery point could not be written to ${out} ` +
          `(${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }
  return verify(await inspect());
}

async function fenceSource(prepared: Prepared, backupPath: string): Promise<CollaborationFence> {
  const { context, manifest, digest, target } = prepared;
  const handle = await openStore(context, "write");
  try {
    handle.db.exec("begin immediate");
    let commitAttempted = false;
    try {
      const existing = readCollaborationFence(handle.db);
      if (existing !== null) {
        assertFenceMatches(existing, manifest, digest);
        handle.db.exec("commit");
        return existing;
      }
      const snapshot = readSourceSnapshot(handle.db);
      assertSnapshotMatches(snapshot, manifest, "The source changed after staging and before fencing.");
      assertCutoverAttestation(
        prepared.context,
        prepared.location,
        manifest,
        prepared.attestation,
        readSourceSessions(handle.db),
      );
      const blockers = readCutoverBlockers(handle.db);
      if (blockers.length > 0) throw notQuiescent(blockers, "The source reported pending work at the fence.");
      ensureFenceSchema(handle.db);
      if (!tableExists(handle.db, "collaboration_cutover")) {
        throw new StoreError(
          "store.corrupt",
          "The combined store records the current schema but has no cutover fence ledger, so a completed fence could " +
            "not be told apart from an absent one. Recover the store from its verified pre-fence image; nothing was fenced.",
        );
      }
      const at = nowRfc3339();
      handle.db
        .prepare(
          "insert into collaboration_cutover(id, manifest_id, manifest_digest, source_store_id, source_epoch, " +
            "source_schema_version, source_revision, source_catalog_revision, target_store_id, target_epoch, " +
            "backup_path, fenced_at) values (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          manifest.manifestId,
          digest,
          manifest.source.storeId,
          manifest.source.epoch,
          manifest.source.schemaVersion,
          manifest.source.revision,
          manifest.source.catalogRevision,
          target.authority.storeId,
          target.authority.epoch,
          backupPath,
          at,
        );
      // see packages/engine/src/collaboration-cutover.ts - // invariant: The fence drops the source-only set, child before parent: a populated
      // `project_roadmaps` references `catalog_entities`, and reverse order removes it first.
      for (const table of [...COLLABORATION_SOURCE_DROP_TABLES].reverse()) handle.db.exec(`drop table ${table}`);
      const fence: CollaborationFence = {
        manifestId: manifest.manifestId,
        manifestDigest: digest,
        sourceStoreId: manifest.source.storeId,
        sourceEpoch: manifest.source.epoch,
        sourceSchemaVersion: manifest.source.schemaVersion,
        sourceRevision: manifest.source.revision,
        sourceCatalogRevision: manifest.source.catalogRevision,
        targetStoreId: target.authority.storeId,
        targetEpoch: target.authority.epoch,
        backupPath,
        fencedAt: at,
      };
      commitAttempted = true;
      handle.db.exec("commit");
      return fence;
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      let rollbackFailure: string | null = null;
      try {
        handle.db.exec("rollback");
      } catch (rollbackError) {
        rollbackFailure = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      }
      if (commitAttempted || rollbackFailure !== null) {
        throw new StoreError(
          "collaboration.cutover-unconfirmed",
          `The collaboration fence did not complete cleanly (${cause}` +
            `${rollbackFailure === null ? "" : `; the rollback also failed: ${rollbackFailure}`}). Its persisted state is ` +
            `UNCONFIRMED: do not treat the combined source as unchanged, and do not retry as if nothing happened. Inspect ` +
            `the persisted fence record, the retained pre-fence image at ${backupPath} and the source's schema_version and ` +
            `moved tables, then recover from the verified pre-fence image or resume the same activation.`,
          { cause, rollback: rollbackFailure === null ? "rolled-back" : "rollback-failed", commitAttempted },
        );
      }
      if (!sourceIsPreFence(handle.db, manifest)) {
        throw new StoreError(
          "collaboration.cutover-unconfirmed",
          `The collaboration fence failed (${cause}) and its rollback returned, but re-reading the combined source did not ` +
            `show the expected pre-fence state. Do not treat the source as unchanged: inspect the persisted fence record, ` +
            `the retained pre-fence image at ${backupPath} and the source's schema_version and moved tables.`,
          { cause, rollback: "rolled-back", verified: false },
        );
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError(
        "store.corrupt",
        `The collaboration fence transaction failed and rolled back (${cause}). The combined source was re-read and is ` +
          `still at its pre-cutover schema with no fence record, so nothing was fenced and no target publication was ` +
          `made; fix the source's integrity and rerun the same activation.`,
        { cause, rollback: "rolled-back", verified: true },
      );
    }
  } finally {
    handle.close();
  }
}

function sourceIsPreFence(db: StoreDb, manifest: CutoverManifest): boolean {
  try {
    return (
      readCollaborationFence(db) === null &&
      validateAppliedMigrations(readAppliedMigrations(db, false)) === manifest.source.schemaVersion
    );
  } catch {
    return false;
  }
}

async function recordFenced(prepared: Prepared, fence: CollaborationFence): Promise<void> {
  const { location, manifest, digest } = prepared;
  await writeCollaborationStage(location, ({ db, authority }) => {
    if (authority.state !== "staged") return;
    const publication = readPublication(db, manifest.manifestId);
    if (publication === null || publication.manifestDigest !== digest) {
      throw conflict(
        `The staged target lost the verified publication for manifest ${manifest.manifestId} after the source was ` +
          `fenced. Preserve the fence and its recovery point; resume with the same manifest. Nothing was published.`,
      );
    }
    if (publication.phase === "verified") {
      db.prepare("update cutover_publications set phase = 'source-fenced', fenced_at = ? where manifest_id = ?").run(
        fence.fencedAt,
        manifest.manifestId,
      );
    }
  });
}

async function publishTarget(prepared: Prepared, fence: CollaborationFence): Promise<CutoverReceipt> {
  const { location, manifest, digest } = prepared;
  return writeCollaborationStage(location, ({ db, authority }) => {
    assertFenceMatches(fence, manifest, digest, { storeId: authority.storeId, epoch: authority.epoch });
    const publication = readPublication(db, manifest.manifestId);
    if (publication === null || publication.manifestDigest !== digest) {
      throw conflict(
        `The staged target holds no publication for the fenced manifest ${manifest.manifestId}. Preserve the fence ` +
          `and its verified recovery point; resume from the original session. Nothing was published.`,
      );
    }
    if (publication.targetStoreId !== authority.storeId || publication.targetEpoch !== authority.epoch) {
      throw conflict(
        `The verified publication belongs to target ${publication.targetStoreId} epoch ${publication.targetEpoch}, while ` +
          `the canonical path now holds ${authority.storeId} epoch ${authority.epoch}. A foreign target never wins by ` +
          `force; restore the verified target before publishing. Nothing was published.`,
      );
    }
    if (authority.state === "active") {
      if (publication.phase !== "active") {
        throw conflict(
          `The target is active without its own publication receipt. Preserve both sides and recover from the verified ` +
            `pre-fence image; nothing was published.`,
        );
      }
      return receiptOf(publication, location, true);
    }
    verifyStagedEvidence(db, manifest);
    const activatedAt = nowRfc3339();
    const flipped = db
      .prepare(
        "update collaboration_meta set authority_state = 'active', activated_at = ? " +
          "where id = 1 and authority_state = 'staged' and store_id = ? and authority_epoch = ? and repository_key = ? and mode = ?",
      )
      .run(activatedAt, authority.storeId, authority.epoch, location.repoKey, location.mode) as { changes?: number };
    if (flipped.changes !== 1) {
      throw conflict(
        `The staged target changed between verification and publication (its state, store id, epoch, repository or ` +
          `mode no longer matches the verified manifest). A foreign or newer target never wins by force; nothing was ` +
          `published.`,
      );
    }
    db.prepare(
      "update cutover_publications set phase = 'active', fenced_at = COALESCE(fenced_at, ?), activated_at = ? " +
        "where manifest_id = ?",
    ).run(fence.fencedAt, activatedAt, manifest.manifestId);
    db.prepare("delete from collaboration_operations where key_space = 'standalone' and operation_id = ?").run(CLAIM_KEY);
    return receiptOf(readPublication(db, manifest.manifestId)!, location, false);
  });
}

/**
 * The durable fence step of activation: claim, retain the verified combined
 * image, fence the source and record the fenced phase. `activate` runs this
 * itself; it is exported so a fenced-but-unpublished source can be resumed (and
 * so the crash between the fence and the publication is a tested boundary).
 */
export async function fenceCollaborationCutoverSource(
  context: StoreContext,
  manifest: CutoverManifest,
  options: CutoverActivationOptions,
): Promise<CutoverReceipt> {
  return withCollaborationCutoverLock(context, () => fenceUnderCutoverLock(context, manifest, options));
}

async function fenceUnderCutoverLock(
  context: StoreContext,
  manifest: CutoverManifest,
  options: CutoverActivationOptions,
): Promise<CutoverReceipt> {
  const prepared = await prepareActivation(context, manifest, options);
  if (prepared.replay !== null) return prepared.replay;
  if (prepared.source.fence !== null) {
    const publication: PublicationRow = {
      ...prepared.target.publication!,
      phase: "source-fenced",
      fencedAt: prepared.source.fence.fencedAt,
    };
    return receiptOf(publication, prepared.location, true);
  }
  await claimActivation(prepared);
  const backupPath = await takeOrVerifyFenceBackup(prepared);
  const fence = await fenceSource(prepared, backupPath);
  await recordFenced(prepared, fence);
  const persisted = await readSourceFence(context);
  if (persisted === null) {
    throw conflict(
      `The fence transaction committed but the combined store no longer records a fence. Preserve the source and its ` +
        `recovery point at ${fence.backupPath} and investigate before publishing; nothing was published.`,
    );
  }
  const publication = await readTargetStateFor(prepared.location, manifest.manifestId);
  return receiptOf(publication!.publication!, prepared.location, false);
}

export async function activateCollaborationCutover(
  context: StoreContext,
  manifest: CutoverManifest,
  options: CutoverActivationOptions,
): Promise<CutoverReceipt> {
  validateActivationAttestation(options.attestation);
  const location = resolveCollaborationLocation(context);
  const before = await readCollaborationStage(location, ({ authority }) => authority);
  if (before.repoKey !== location.repoKey || before.mode !== location.mode) {
    throw new StoreError(
      "collaboration.stale-binding",
      `The staged target at ${location.dbPath} belongs to repository ${before.repoKey} (${before.mode}), not this checkout's ` +
        `${location.repoKey} (${location.mode}); the activation is refused before any binding is written.`,
    );
  }
  const rollbackClaim = beginBindingClaim(context, {
    repoKey: location.repoKey,
    mode: location.mode,
    storeId: before.storeId,
    epoch: before.epoch + 1,
  });
  let receipt: CutoverReceipt;
  try {
    receipt = await withCollaborationCutoverLock(context, () => activateUnderCutoverLock(context, manifest, options));
  } catch (error) {
    rollbackClaim();
    throw error;
  }
  if (receipt.phase === "active") {
    writeCollaborationBinding(context, {
      repoKey: receipt.target.repoKey,
      mode: receipt.target.mode,
      storeId: receipt.target.storeId,
      epoch: receipt.target.epoch,
      binding: "active",
    });
  }
  return receipt;
}

async function activateUnderCutoverLock(
  context: StoreContext,
  manifest: CutoverManifest,
  options: CutoverActivationOptions,
): Promise<CutoverReceipt> {
  const prepared = await prepareActivation(context, manifest, options);
  if (prepared.replay !== null) return prepared.replay;
  if (prepared.source.fence !== null) {
    const persisted = await readSourceFence(context);
    if (persisted === null) {
      throw conflict(
        `The combined store fenced earlier but no longer records its fence. Preserve the source and its pre-fence ` +
          `image; nothing was published.`,
      );
    }
    assertFenceMatches(persisted, manifest, prepared.digest, prepared.target.authority);
    return publishTarget(prepared, persisted);
  }
  await claimActivation(prepared);
  const backupPath = await takeOrVerifyFenceBackup(prepared);
  const fence = await fenceSource(prepared, backupPath);
  await recordFenced(prepared, fence);
  const persisted = await readSourceFence(context);
  if (persisted === null) {
    throw conflict(
      `The fence transaction committed but the combined store no longer records a fence. Preserve the source and its ` +
        `recovery point at ${fence.backupPath} and investigate before publishing; nothing was published.`,
    );
  }
  return publishTarget(prepared, persisted);
}
