/**
 * execution-recovery.ts — §8 backup, export and restore (R3 of plan
 * `20260920-activation-migration-recovery`).
 *
 * The activation barrier (§6) is only survivable if there is a point to come
 * back to and an honest account of what coming back costs. This module owns
 * exactly that, and nothing else:
 *
 * - `previewExecutionRestore` mutates nothing — it reads the live store through
 *   the READ snapshot, so it writes no authority row and never reconfigures the
 *   store's journal mode. It verifies the recovery point through the
 *   same verdict `backupStore` applies (§8 "re-open it for `integrity_check` +
 *   `foreign_key_check`", migration checksums, identity, execution identity),
 *   then inventories the WHOLE store — issue, catalog and execution — against
 *   the live authority, and returns the canonical `lossDigest` of that
 *   inventory. It writes no authority row, no receipt and no artifact of its
 *   own, so it is safe to run at any time.
 * - `restoreExecutionBackup` is the destructive step. It never trusts the
 *   preview it is handed: it re-derives the inventory under the maintenance
 *   lock and refuses unless the supplied preview is byte-identical to the
 *   recomputed one, so work committed after the preview cannot disappear under
 *   an approval that never described it. It requires the exact loss digest
 *   whenever the inventory holds any loss ("no default yes"), takes a fresh
 *   pre-restore recovery point, checkpoints the live WAL, then installs a
 *   verified SIBLING image whose epoch is already above both the live store and
 *   the point — so the atomic rename is the single cutover and no window exists
 *   in which the restored bytes carry a still-valid generation.
 * - `exportExecutionState` is a diagnostic, not an authority: canonical data
 *   with the store/execution identity, the recorded migrations and their source
 *   status, and workflow/plan/lease/frozen-input state — with every session
 *   identity, CAS token and credential path removed, and no import verb.
 *
 * ## The loss inventory, and why it is complete
 *
 * §8 asks the preview to list "changed/deleted authoritative rows and committed
 * operation ids across all three domains, not just an execution revision
 * difference". The inventory below enumerates EVERY authority table of the
 * three domains (the durable `projection_*` tables are excluded: contract §5
 * makes them disposable and rebuildable, never authority), compares each row on
 * both sides by its canonical content, and additionally lists the committed
 * operation receipts of the three domains.
 *
 * `authorityDifferences` reports, per differing row, the row's OWN authority
 * revision when its table carries one, and `null` when the row is absent on
 * that side. The child rows and the provenance tables §2.2 keeps outside the
 * authority (`occurrences`, `relations`, `provenance`, `issue_transitions`,
 * `catalog_links`, `catalog_operations`, `catalog_execution_bindings`,
 * `execution_registry`, `execution_operations`, `execution_migrations`,
 * `migration_receipts`, `store_operations`, `issue_counter`) have no revision
 * of their own, so they report the presence marker `1` on a side that holds
 * them: `null` stays reserved for absence, and an entry whose markers are both
 * `1` means the row exists on BOTH sides with different content — the entry
 * itself is the disclosure. `execution_migrations` matters here: a retirement
 * receipt is provenance (§2.2) rather than authority, and restoring a
 * pre-retirement point drops it, so it is listed rather than hidden.
 *
 * The digest is the precise token the approval names. It is computed over the
 * two stores' identities/epochs/schema/execution state, the COMPLETE
 * `authorityDifferences` list, the lost operation ids, and the operation
 * receipts only the POINT holds (a resurrected receipt, which `lostOperationIds`
 * does not list because nothing is lost). Any change on either side — including
 * a change to a row the readable list can only mark as `1`/`1` — changes it.
 *
 * ## Crash identification
 *
 * One durable receipt per attempt is written under
 * `<root>/archived/store-migration/recovery/` BEFORE the rename (`phase:
 * "replacing"`, naming both the live bytes' hash and the prepared image's hash)
 * and rewritten AFTER it (`phase: "replaced"`). A crash is therefore decidable
 * from the receipt alone: a live file matching `liveStoreSha256` was never
 * replaced, and one matching `restoredCopySha256` was — the installed store is
 * identified by hash, never assumed.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isNonEmptyString, isPlainObject } from "./coordination-write.js";
import { writeJson } from "./core.js";
import { serializeExecutionValue } from "./execution-store.js";
import { withStatusWriteLock } from "./lease.js";
import {
  MIGRATIONS,
  StoreError,
  assertStoreRuntimeSupported,
  openStore,
  storeDbPath,
  type StoreContext,
  type StoreDb,
  type StoreHandle,
} from "./store-db.js";
import {
  ACTIVATION_PROTOCOL_VERSION,
  StoreActivationError,
  backupStore,
  canonicalPath,
  inspectBackupCopy,
  isPathWithin,
  type BackupExecutionMeta,
  type BackupInspection,
  type BackupReceipt,
} from "./store-activation.js";

/** Transport version of the recovery receipt and of the diagnostic export. */
export const EXECUTION_RECOVERY_PROTOCOL_VERSION = 1;

/**
 * Stable refusal codes. `execution.recovery-loss-unaccepted` is §5's verdict
 * for "the loss is not the loss the operator approved" — an incomplete
 * inventory, an unapproved loss and a superseded preview are all that one
 * refusal, because in each case the honest answer is "do not replace anything".
 * `execution.migration-conflict` carries the malformed request, and
 * `store.corrupt` the store that cannot be inventoried or re-verified.
 */
export type ExecutionRecoveryErrorCode =
  | "execution.recovery-loss-unaccepted"
  | "execution.migration-conflict"
  | "store.corrupt";

export class ExecutionRecoveryError extends Error {
  readonly code: ExecutionRecoveryErrorCode;

  constructor(code: ExecutionRecoveryErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "ExecutionRecoveryError";
    this.code = code;
  }
}

/** §8: one authority row that differs between the live store and the point. */
export type ExecutionRecoveryAuthorityDifference = {
  domain: "issue" | "catalog" | "execution";
  key: string;
  liveRevision: number | null;
  backupRevision: number | null;
};

/** §8 (verbatim): what restoring one recovery point would cost. */
export type ExecutionRecoveryPreview = {
  backupPath: string;
  backupSha256: string;
  liveStoreId: string;
  liveEpoch: number;
  backupEpoch: number;
  lostOperationIds: string[];
  lossDigest: string;
  authorityDifferences: ExecutionRecoveryAuthorityDifference[];
};

/** §8 (verbatim): the recorded outcome of one accepted restore. */
export type ExecutionRestoreReceipt = {
  storeId: string;
  epoch: number;
  restoredFromSha256: string;
  preRestoreBackup: BackupReceipt;
  recoveryReceiptPath: string;
};

/** §8 (verbatim): the diagnostic projection of the execution authority. */
export type ExecutionDiagnosticExport = { format: "execution-diagnostic-v1"; canonicalJson: string; sha256: string };

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** The migration that introduced the execution authority (never a magic number). */
const EXECUTION_MIGRATION_VERSION =
  MIGRATIONS.find((migration) => migration.name === "execution-authority")?.version ?? Number.POSITIVE_INFINITY;
/** The migration that introduced the catalog authority (never a magic number). */
const CATALOG_MIGRATION_VERSION = MIGRATIONS.find((migration) => migration.name === "catalog-authority")?.version ?? 2;

/** §4.3: the canonical control harness root that owns this context's store. */
function controlRootOf(context: StoreContext): string {
  return canonicalPath(dirname(storeDbPath(context)));
}

function sha256Of(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** SHA-256 of a file's bytes, streamed rather than read into memory. */
async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function readIfExists(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

/** One file's (dev, ino) identity — how "positively owned" is decided. */
function identityOf(path: string): { dev: number; ino: number } | undefined {
  try {
    const stats = lstatSync(path);
    return { dev: stats.dev, ino: stats.ino };
  } catch {
    return undefined;
  }
}

function sameIdentity(a: { dev: number; ino: number } | undefined, b: { dev: number; ino: number } | undefined): boolean {
  return a === undefined || b === undefined ? a === b : a.dev === b.dev && a.ino === b.ino;
}

/**
 * §8: the loss the operator has to approve explicitly. Every refusal that means
 * "the inventory cannot be trusted" or "the approval does not describe this
 * loss" is this ONE code, because the operator's next action is the same in
 * both cases: re-preview, read the loss, and decide again.
 */
function lossUnaccepted(detail: string): ExecutionRecoveryError {
  return new ExecutionRecoveryError("execution.recovery-loss-unaccepted", detail);
}

function conflict(detail: string): ExecutionRecoveryError {
  return new ExecutionRecoveryError("execution.migration-conflict", detail);
}

function corrupt(detail: string): ExecutionRecoveryError {
  return new ExecutionRecoveryError("store.corrupt", detail);
}

/**
 * The §4.2 outer lock every file-touching migration/retire/restore step takes
 * first, keyed EXACTLY like `withExecutionMaintenanceLock` in
 * `execution-migrate.ts` (`<root>/.execution-maintenance/execution-migration`,
 * which `withStatusWriteLock` turns into
 * `<root>/.execution-maintenance/.status-write.lockdir`): a restore must never
 * interleave with a migration, a retirement or another restore, and the two
 * spellings of the key have to stay identical for that to hold.
 */
async function withExecutionMaintenanceLock<T>(context: StoreContext, fn: () => Promise<T>): Promise<T> {
  const key = join(controlRootOf(context), ".execution-maintenance", "execution-migration");
  mkdirSync(dirname(key), { recursive: true });
  return withStatusWriteLock(key, fn, { timeoutMs: maintenanceLockWaitMs() });
}

/** The bounded wait for an operation that is not the caller's to interrupt. */
function maintenanceLockWaitMs(): number {
  if (process.env.MSTAR_STORE_TEST_RUNNER === "1") {
    const parsed = Number.parseInt(process.env.MSTAR_EXECUTION_MIGRATION_LOCK_WAIT_MS ?? "", 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 30_000;
}

/**
 * The test-runner-gated crash seam, the same gate every other failure injection
 * in the store uses: the stage names where the run was interrupted, so "crash
 * before the replacement" and "crash after it" are reproduced rather than
 * described.
 */
function recoveryFailureHook(stage: "before-replacement" | "after-replacement"): void {
  if (process.env.MSTAR_STORE_TEST_RUNNER !== "1") return;
  if (process.env.MSTAR_STORE_FAIL_EXECUTION_RESTORE === stage) {
    throw new Error(`induced execution-restore failure at ${stage}`);
  }
}

// ---------------------------------------------------------------------------
// Reading the three authority domains
// ---------------------------------------------------------------------------

type AuthorityDomain = "issue" | "catalog" | "execution";

/** One enumerated authority row: its key, its own revision (or presence), its content digest. */
type AuthorityRow = { domain: AuthorityDomain; key: string; revision: number | null; digest: string };

type AuthorityTable = {
  domain: AuthorityDomain;
  table: string;
  /** The exact columns compared — nothing else is ever read from the row. */
  columns: readonly string[];
  orderBy: string;
  key: (row: Record<string, unknown>) => string;
  /** The row's own authority revision column, when the table carries one. */
  revisionColumn?: string;
  /** True when the table only exists once the catalog/execution migration applied. */
  requires?: "catalog" | "execution";
};

function text(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value === "string") return value;
  return value === null || value === undefined ? "" : String(value);
}

function number(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw corrupt(`the authority column ${column} is ${JSON.stringify(value)}, not a safe integer; the loss inventory cannot be built`);
  }
  return value;
}

/**
 * Every authority table of the three domains (§2 of the primary spec), in the
 * order the inventory reports them. `projection_*` is deliberately absent:
 * contract §5 makes those tables a disposable published generation, so losing
 * one is not an authority loss.
 */
const AUTHORITY_TABLES: readonly AuthorityTable[] = [
  {
    domain: "issue",
    table: "store_meta",
    columns: ["id", "store_id", "authority_state", "authority_epoch", "revision", "catalog_revision", "created_at", "activated_at"],
    orderBy: "id",
    key: () => "store_meta",
    revisionColumn: "revision",
  },
  {
    domain: "issue",
    table: "issues",
    columns: [
      "id",
      "project_id",
      "title",
      "kind",
      "severity",
      "disposition",
      "impact",
      "acceptance",
      "owner",
      "registered_at",
      "closed_at",
      "closure_note",
      "created_at",
      "updated_at",
      "revision",
      "provider",
      "external_id",
      "url",
      "identity_key",
    ],
    orderBy: "id",
    key: (row) => `issue:${text(row, "id")}`,
    revisionColumn: "revision",
  },
  {
    domain: "issue",
    table: "occurrences",
    columns: [
      "id",
      "issue_id",
      "occurrence_key",
      "source_kind",
      "source_identity",
      "root_cause_key",
      "acceptance_key",
      "location",
      "observed_behavior",
      "evidence_json",
      "discovered_at",
      "recorded_at",
      "imported",
    ],
    orderBy: "occurrence_key",
    key: (row) => `occurrence:${text(row, "occurrence_key")}`,
  },
  {
    domain: "issue",
    table: "relations",
    columns: ["from_issue", "relation", "to_issue"],
    orderBy: "from_issue, relation, to_issue",
    key: (row) => `relation:${text(row, "from_issue")}/${text(row, "relation")}/${text(row, "to_issue")}`,
  },
  {
    domain: "issue",
    table: "provenance",
    columns: ["id", "issue_id", "kind", "target", "source_hash", "legacy_project", "legacy_bucket", "legacy_entry_id", "legacy_json", "imported_at"],
    orderBy: "id",
    key: (row) => `provenance:${text(row, "id")}`,
  },
  {
    domain: "issue",
    table: "issue_transitions",
    columns: ["id", "issue_id", "from_disposition", "to_disposition", "actor", "occurred_at", "recorded_at", "reason", "evidence_json", "imported", "issue_revision"],
    orderBy: "id",
    key: (row) => `transition:${text(row, "id")}`,
  },
  {
    domain: "issue",
    table: "store_operations",
    columns: ["operation_id", "request_hash", "result_json", "committed_at"],
    orderBy: "operation_id",
    key: (row) => `store-operation:${text(row, "operation_id")}`,
  },
  {
    domain: "issue",
    table: "issue_counter",
    columns: ["id", "next_value"],
    orderBy: "id",
    key: () => "issue-counter",
  },
  {
    domain: "issue",
    table: "migration_receipts",
    columns: ["id", "manifest_hash", "phase", "manifest_json", "mapping_json", "source_counts_json", "applied_at", "activated_at", "retired_at"],
    orderBy: "id",
    key: (row) => `migration-receipt:${text(row, "manifest_hash")}`,
  },
  {
    domain: "catalog",
    table: "catalog_entities",
    columns: [
      "kind",
      "id",
      "title",
      "description",
      "root_kind",
      "relative_path",
      "document_kind",
      "lifecycle",
      "revision",
      "registered_at",
      "updated_at",
      "source_hash",
    ],
    orderBy: "kind, id",
    key: (row) => `entity:${text(row, "kind")}/${text(row, "id")}`,
    revisionColumn: "revision",
    requires: "catalog",
  },
  {
    domain: "catalog",
    table: "catalog_links",
    columns: ["from_kind", "from_id", "relation", "to_kind", "to_id", "ordinal"],
    orderBy: "from_kind, from_id, relation, to_kind, to_id",
    key: (row) =>
      `link:${text(row, "from_kind")}/${text(row, "from_id")}/${text(row, "relation")}/${text(row, "to_kind")}/${text(row, "to_id")}`,
    requires: "catalog",
  },
  {
    domain: "catalog",
    table: "catalog_operations",
    columns: ["operation_id", "request_hash", "phase", "catalog_delta_json", "before_versions_json", "after_versions_json", "result_json", "created_at", "updated_at"],
    orderBy: "operation_id",
    key: (row) => `catalog-operation:${text(row, "operation_id")}`,
    requires: "catalog",
  },
  {
    domain: "catalog",
    table: "catalog_execution_bindings",
    columns: ["workflow_id", "catalog_kind", "catalog_id", "workflow_root_kind", "workflow_relative_path", "catalog_revision", "input_hash", "pin_json", "operation_id"],
    orderBy: "workflow_id, catalog_kind, catalog_id",
    key: (row) => `binding:${text(row, "workflow_id")}/${text(row, "catalog_kind")}/${text(row, "catalog_id")}`,
    requires: "catalog",
  },
  {
    domain: "execution",
    table: "execution_meta",
    columns: ["id", "protocol_version", "authority_state", "revision", "root_updated_at", "manifest_id", "activated_at"],
    orderBy: "id",
    key: () => "execution_meta",
    revisionColumn: "revision",
    requires: "execution",
  },
  {
    domain: "execution",
    table: "execution_workflows",
    columns: ["workflow_id", "revision", "creator_session_id", "state_json", "created_at", "updated_at"],
    orderBy: "workflow_id",
    key: (row) => `workflow:${text(row, "workflow_id")}`,
    revisionColumn: "revision",
    requires: "execution",
  },
  {
    domain: "execution",
    table: "execution_registry",
    columns: ["workflow_id", "entry_json"],
    orderBy: "workflow_id",
    key: (row) => `registry:${text(row, "workflow_id")}`,
    requires: "execution",
  },
  {
    domain: "execution",
    table: "execution_plans",
    columns: ["workflow_id", "plan_id", "revision", "ordinal", "state_json", "coordination_json"],
    orderBy: "workflow_id, plan_id",
    key: (row) => `plan:${text(row, "workflow_id")}/${text(row, "plan_id")}`,
    revisionColumn: "revision",
    requires: "execution",
  },
  {
    domain: "execution",
    table: "execution_sessions",
    columns: ["workflow_id", "role", "session_id", "plan_id", "epoch", "revision", "state", "bound_at"],
    orderBy: "workflow_id, role, session_id",
    key: (row) => `session:${text(row, "workflow_id")}/${text(row, "role")}/${text(row, "session_id")}`,
    revisionColumn: "revision",
    requires: "execution",
  },
  {
    domain: "execution",
    table: "execution_leases",
    columns: ["workflow_id", "plan_id", "revision", "owner_epoch", "lease_json"],
    orderBy: "workflow_id, plan_id",
    key: (row) => `lease:${text(row, "workflow_id")}/${text(row, "plan_id")}`,
    revisionColumn: "revision",
    requires: "execution",
  },
  {
    domain: "execution",
    table: "execution_integration_leases",
    columns: ["workflow_id", "revision", "owner_epoch", "lease_json"],
    orderBy: "workflow_id",
    key: (row) => `integration-lease:${text(row, "workflow_id")}`,
    revisionColumn: "revision",
    requires: "execution",
  },
  {
    domain: "execution",
    table: "execution_inputs",
    columns: ["workflow_id", "plan_id", "revision", "input_json", "input_hash", "catalog_pin_json"],
    orderBy: "workflow_id, plan_id",
    key: (row) => `input:${text(row, "workflow_id")}/${text(row, "plan_id")}`,
    revisionColumn: "revision",
    requires: "execution",
  },
  {
    domain: "execution",
    table: "execution_operations",
    columns: ["epoch", "operation_id", "request_hash", "store_id", "workflow_id", "plan_id", "result_json", "committed_at"],
    orderBy: "epoch, operation_id",
    key: (row) => `operation:${text(row, "epoch")}/${text(row, "operation_id")}`,
    requires: "execution",
  },
  {
    domain: "execution",
    table: "execution_migrations",
    columns: ["manifest_id", "manifest_hash", "phase", "manifest_json", "activation_receipt_json", "retirement_json", "created_at", "updated_at"],
    orderBy: "manifest_id",
    key: (row) => `migration:${text(row, "manifest_id")}`,
    requires: "execution",
  },
];

type TableAvailability = { catalog: boolean; execution: boolean };

function available(table: AuthorityTable, availability: TableAvailability): boolean {
  if (table.requires === "catalog") return availability.catalog;
  if (table.requires === "execution") return availability.execution;
  return true;
}

/** Enumerate every authority row of one store, deterministic key order, duplicate keys refused. */
function readAuthorityRows(db: StoreDb, availability: TableAvailability): AuthorityRow[] {
  const rows: AuthorityRow[] = [];
  const seen = new Set<string>();
  for (const table of AUTHORITY_TABLES) {
    if (!available(table, availability)) continue;
    const found = db.prepare(`select ${table.columns.join(", ")} from ${table.table} order by ${table.orderBy}`).all() as Array<
      Record<string, unknown>
    >;
    for (const raw of found) {
      const projected: Record<string, unknown> = {};
      for (const column of table.columns) projected[column] = raw[column];
      const key = table.key(projected);
      if (seen.has(`${table.domain}\u0000${key}`)) {
        throw corrupt(`two ${table.table} rows share the inventory key ${JSON.stringify(key)}; the loss inventory cannot be trusted`);
      }
      seen.add(`${table.domain}\u0000${key}`);
      rows.push({
        domain: table.domain,
        key,
        revision: table.revisionColumn === undefined ? 1 : number(projected, table.revisionColumn),
        digest: sha256Of(serializeExecutionValue(projected)),
      });
    }
  }
  return rows;
}

/** The committed operation receipt ids of one store, per domain. */
function readCommittedOperationIds(db: StoreDb, availability: TableAvailability): string[] {
  const ids: string[] = [];
  for (const row of db.prepare("select operation_id from store_operations order by operation_id").all() as Array<Record<string, unknown>>) {
    ids.push(`issue:${text(row, "operation_id")}`);
  }
  if (availability.catalog) {
    for (const row of db
      .prepare("select operation_id from catalog_operations where phase = 'committed' order by operation_id")
      .all() as Array<Record<string, unknown>>) {
      ids.push(`catalog:${text(row, "operation_id")}`);
    }
  }
  if (availability.execution) {
    for (const row of db
      .prepare("select epoch, operation_id from execution_operations order by epoch, operation_id")
      .all() as Array<Record<string, unknown>>) {
      ids.push(`execution:${text(row, "epoch")}:${text(row, "operation_id")}`);
    }
  }
  return ids;
}

/** The live store's authority generation, identity and counts — the drift anchor. */
type LiveAnchor = {
  storeId: string;
  epoch: number;
  revision: number;
  catalogRevision: number;
  authorityState: "staged" | "active";
  schemaVersion: number;
  execution: BackupExecutionMeta | null;
};

type LiveRead = LiveAnchor & { rows: AuthorityRow[]; operationIds: string[] };

/**
 * SQLite's own self-consistency probe. A store SQLite cannot even read is a
 * store whose loss cannot be inventoried, so a raw driver failure here is the
 * same verdict as a reported problem: refuse, and touch nothing.
 */
function probeIntegrity(db: StoreDb): string[] {
  try {
    return (db.prepare("pragma integrity_check").all() as Array<Record<string, unknown>>).map((row) =>
      String(Object.values(row)[0] ?? ""),
    );
  } catch (error) {
    throw lossUnaccepted(
      `the live store cannot be read for a loss inventory (${(error as Error).message}); an incomplete inventory is never ` +
        `called a safe rollback, so nothing was replaced and both files are retained.`,
    );
  }
}

function probeForeignKeys(db: StoreDb): Array<Record<string, unknown>> {
  try {
    return db.prepare("pragma foreign_key_check").all() as Array<Record<string, unknown>>;
  } catch (error) {
    throw lossUnaccepted(
      `the live store cannot be read for a loss inventory (${(error as Error).message}); nothing was replaced and both files ` +
        `are retained.`,
    );
  }
}

/**
 * A SQLite database header is 100 bytes long; offset 18/19 carry the file
 * format's write/read version, `2` for WAL. Together with the `-wal` sidecar's
 * presence that is the whole shape this module has to agree with SQLite about,
 * and it is readable from the file itself — before any connection is opened.
 */
const DATABASE_HEADER_BYTES = 100;
const WAL_FILE_FORMAT_VERSION = 2;

/** The store file's header bytes and whether its `-wal` journal is present; null when it cannot be read as a store file. */
type WalStoreShape = { header: string; wal: boolean };

function walStoreShapeOf(context: StoreContext): WalStoreShape | null {
  const dbPath = storeDbPath(context);
  const header = Buffer.alloc(DATABASE_HEADER_BYTES);
  let fd: number;
  try {
    fd = openSync(dbPath, "r");
  } catch {
    return null;
  }
  try {
    readSync(fd, header, 0, header.length, 0);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
  if (header[18] !== WAL_FILE_FORMAT_VERSION || header[19] !== WAL_FILE_FORMAT_VERSION) return null;
  return { header: header.toString("hex"), wal: existsSync(`${dbPath}-wal`) };
}

/**
 * The capability path for the ONE shape the store layer's read intent cannot
 * read: a WAL store with no `-wal` file beside it — the shape SQLite's own last
 * clean close leaves when it folds the journal into the database and removes
 * it, and the shape a store's own file has when it was copied without its
 * sidecars. The database file is the whole committed state there (there is no
 * WAL content to miss), so the store is completely intact and refusing to
 * inventory it would be a defect of its own.
 *
 * SQLite reads a WAL database THROUGH its `-wal` file, opened read-only, so a
 * read-only open of that shape fails outright (SQLITE_CANTOPEN, "unable to open
 * database file"): the sidecar a preview may not create beside the store is
 * exactly the sidecar SQLite refuses to work without. A stale `-shm` beside the
 * store does not change that — SQLite needs the `-wal` itself — and a
 * write-capable connection is not a way out either: it creates `-wal` AND
 * `-shm` as a side effect of reading the store (pragma or not, and on this
 * runtime it fails on the very `-wal` it just created), so the store would come
 * out of a preview mutated, which is what §8's "mutates nothing" forbids.
 *
 * So this path never opens the LIVE store. It copies the quiesced store's bytes
 * into a private image, where the `-wal` sidecar is this process's own file,
 * and takes the store layer's read intent of THAT: the same identity, schema,
 * migration-checksum, `query_only`, integrity and foreign-key rules every other
 * store read gets, over the same committed state byte for byte (see
 * `assertWalStoreUnchanged`). The live store keeps its database bytes, its
 * header, its journal mode and its sidecar set exactly as they were.
 *
 * Reachability is decided HERE, from the store's own bytes, before anything
 * opens the store: a store that is not a WAL store, or that has its `-wal`, is
 * not served (`null`) and keeps the read intent's own refusal. Every other
 * shape therefore arrives at its own refusal unchanged: a rollback-journal
 * store, a hot journal, a missing/corrupt/drifted database, a store another
 * writer holds (a writer's connection creates the `-wal`) and a plain busy
 * store.
 */
async function openWalWithoutJournalReadSnapshot(
  context: StoreContext,
): Promise<{ handle: StoreHandle; walWithoutJournal: WalStoreShape } | null> {
  const walWithoutJournal = walStoreShapeOf(context);
  if (walWithoutJournal === null || walWithoutJournal.wal) return null;
  const scratch = mkdtempSync(join(tmpdir(), "mstar-store-read-"));
  try {
    const image = join(scratch, "store.db");
    copyFileSync(storeDbPath(context), image);
    // The read intent's open needs the `-wal` file to exist and cannot create
    // it; in this private image that file is ours to create, and SQLite creates
    // the image's `-shm` beside it under its own read-only rules.
    writeFileSync(`${image}-wal`, "");
    const handle = await openStore({ harnessDir: scratch }, "read");
    return {
      handle: {
        ...handle,
        close(): void {
          try {
            handle.close();
          } finally {
            rmSync(scratch, { recursive: true, force: true });
          }
        },
      },
      walWithoutJournal,
    };
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The image above describes the live store only while the store keeps the shape
 * it was read in: a WAL store with no `-wal`, whose database file is therefore
 * the whole committed state. A writer that appeared while the image was taken
 * would put a `-wal` (with frames the image does not hold) beside the store and
 * make it a mixture of two states, so the read is verified rather than assumed —
 * a preview may not describe the live store with an inventory it cannot stand
 * behind.
 */
function assertWalStoreUnchanged(context: StoreContext, before: WalStoreShape, what: string): void {
  const after = walStoreShapeOf(context);
  if (after !== null && !after.wal && after.header === before.header) return;
  const observed =
    after === null
      ? "its database file no longer reads as a WAL store"
      : `its WAL journal is ${after.wal ? "present" : "absent"} and its header is ${after.header}`;
  throw lossUnaccepted(
    `${what} read the live store at ${storeDbPath(context)} through the WAL-without-journal path and the store did not ` +
      `keep the shape that read needs (${observed}, against ${before.header} with no WAL journal): an inventory taken across ` +
      `that change is not a complete description of the live store. Nothing was replaced and both files are retained.`,
  );
}

/**
 * The live read snapshot for the loss inventory: which handle the inventory is
 * taken from, and the shape the capability path read it in (`null` when the
 * store layer's own read intent was used).
 */
type LiveReadSnapshot = { handle: StoreHandle; walWithoutJournal: WalStoreShape | null };

/**
 * Open the live store for the loss inventory.
 *
 * The shape decides the path, and it is read from the file's BYTES rather than
 * from a refusal: for a WAL store with no `-wal`, the capability path must be
 * taken BEFORE the read intent is tried. A read-only open of that shape on
 * Bun's `node:sqlite` refuses it (SQLITE_CANTOPEN) and on Node's opens it by
 * creating the `-wal` the preview may not leave behind, so trying the read
 * intent first would either refuse an intact store or mutate it.
 *
 * The shape can also MOVE under the read — a read-only connection's own last
 * clean close deletes the `-wal` when it is the last one holding the store — so
 * a read intent that refuses is not taken at face value either: the capability
 * path is consulted again, decides from the bytes whether this is the one shape
 * it serves, and only then does the original refusal stand.
 */
async function openLiveReadSnapshot(context: StoreContext): Promise<LiveReadSnapshot> {
  const capability = await openWalWithoutJournalReadSnapshot(context);
  if (capability !== null) return capability;
  try {
    return { handle: await openStore(context, "read"), walWithoutJournal: null };
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    const retry = await openWalWithoutJournalReadSnapshot(context);
    if (retry === null) throw error;
    return retry;
  }
}

/**
 * Read the live store for the loss inventory: ONE snapshot transaction over the
 * three domains, plus the §8 self-consistency probe (§8 "read the live
 * authority").
 *
 * The handle is the store layer's READ snapshot (`openLiveReadSnapshot`): the
 * write intent applies `journal_mode=wal` and `synchronous=FULL` as part of
 * opening, so it reconfigures a live store that is not currently in WAL — an
 * image just installed by a restore, whose bytes are deliberately left in
 * VACUUM INTO's rollback-journal mode until the next writer access — and
 * creates its sidecars before a single authority row is read. "No write
 * statement" is not "mutates nothing". The one shape that read intent cannot be
 * taken of — a WAL store with no `-wal` — is read through
 * `openWalWithoutJournalReadSnapshot`, which leaves the live store untouched,
 * and is verified to have stayed that shape (`assertWalStoreUnchanged`) because
 * that is what makes the read a description of the live store rather than of a
 * mixture.
 *
 * A live store that cannot be read — missing, corrupt, drifted, held by another
 * writer past the bounded wait, or an artifact the read snapshot cannot be
 * taken of — cannot produce a loss inventory, and §8's answer to that is
 * `execution.recovery-loss-unaccepted` with the files left alone, never a blind
 * overwrite. This function is the ONE boundary that turns every such failure
 * into that refusal: a store that opens but whose authority rows or committed
 * receipts cannot be inventoried — a malformed/wrong-shaped row, an unreadable
 * table, a failed query — is the same incomplete inventory as an unreadable
 * file, so it is normalized here with the underlying cause kept in the detail
 * rather than escaping as a raw driver or `store.corrupt` failure that a caller
 * cannot tell apart from an unrelated fault. Backup and request validation
 * refuse earlier, through their own codes, and never reach this boundary.
 */
async function readLiveStore(context: StoreContext, what: string): Promise<LiveRead> {
  let snapshot: LiveReadSnapshot;
  try {
    snapshot = await openLiveReadSnapshot(context);
  } catch (error) {
    throw lossUnaccepted(
      `${what} cannot inventory the live store at ${storeDbPath(context)} (${(error as Error).message}); an incomplete ` +
        `inventory is never called a safe rollback. The live store and the recovery point are BOTH left exactly as they are.`,
    );
  }
  const { handle, walWithoutJournal } = snapshot;
  try {
    const integrity = probeIntegrity(handle.db);
    if (integrity.length !== 1 || integrity[0] !== "ok") {
      throw lossUnaccepted(
        `${what} cannot inventory the live store: SQLite integrity_check reports ` +
          `${integrity.slice(0, 3).join("; ") || "no result"}. An incomplete inventory is never called a safe rollback, so ` +
          `nothing was replaced and both files are retained.`,
      );
    }
    const violations = probeForeignKeys(handle.db);
    if (violations.length > 0) {
      throw lossUnaccepted(
        `${what} cannot inventory the live store: ${violations.length} row(s) violate the schema's foreign keys ` +
          `(first: ${JSON.stringify(violations[0])}). Nothing was replaced and both files are retained.`,
      );
    }
    handle.db.exec("begin");
    try {
      const meta = handle.db
        .prepare("select store_id, authority_state, authority_epoch, revision, catalog_revision from store_meta where id = 1")
        .get() as Record<string, unknown> | undefined;
      if (
        !meta ||
        typeof meta.store_id !== "string" ||
        (meta.authority_state !== "staged" && meta.authority_state !== "active") ||
        typeof meta.authority_epoch !== "number" ||
        typeof meta.revision !== "number" ||
        typeof meta.catalog_revision !== "number"
      ) {
        throw corrupt("store_meta is missing or malformed; the live authority generation cannot be verified");
      }
      const availability: TableAvailability = {
        catalog: handle.schemaVersion >= CATALOG_MIGRATION_VERSION,
        execution: handle.schemaVersion >= EXECUTION_MIGRATION_VERSION,
      };
      // Verified before the inventory is handed back: the capability path read an
      // image of a store with no `-wal`, and that image only IS the live store
      // while the live store kept the shape it was read in.
      if (walWithoutJournal !== null) assertWalStoreUnchanged(context, walWithoutJournal, what);
      return {
        storeId: meta.store_id,
        epoch: meta.authority_epoch,
        revision: meta.revision,
        catalogRevision: meta.catalog_revision,
        authorityState: meta.authority_state,
        schemaVersion: handle.schemaVersion,
        execution: handle.execution,
        rows: readAuthorityRows(handle.db, availability),
        operationIds: readCommittedOperationIds(handle.db, availability),
      };
    } finally {
      handle.db.exec("commit");
    }
  } catch (error) {
    if (error instanceof ExecutionRecoveryError && error.code === "execution.recovery-loss-unaccepted") throw error;
    throw lossUnaccepted(
      `${what} cannot inventory the live store at ${storeDbPath(context)}: ${(error as Error).message} An incomplete ` +
        `inventory is never called a safe rollback, so nothing was replaced and both files are retained.`,
    );
  } finally {
    handle.close();
  }
}

/**
 * Read a `VACUUM INTO` copy's authority rows in ONE read-only snapshot.
 *
 * The specifier cannot be a static import: contract §2 requires lazy,
 * capability-checked SQLite acquisition at store access, and the store-open
 * boundary resolves exactly `<root>/store.db`, never a copy beside it.
 */
async function readCopyRows(backupPath: string, availability: TableAvailability): Promise<{ rows: AuthorityRow[]; operationIds: string[] }> {
  assertStoreRuntimeSupported();
  const { DatabaseSync } = (await import("node:sqlite")) as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => StoreDb;
  };
  const db = new DatabaseSync(backupPath, { readOnly: true });
  try {
    db.exec("pragma query_only=ON");
    db.exec("begin");
    try {
      return { rows: readAuthorityRows(db, availability), operationIds: readCommittedOperationIds(db, availability) };
    } finally {
      db.exec("commit");
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// The loss inventory (§8)
// ---------------------------------------------------------------------------

type LossInventory = {
  preview: ExecutionRecoveryPreview;
  live: LiveAnchor;
  backup: BackupInspection;
  /** Committed receipts the POINT holds and the live store does not. */
  resurrectedOperationIds: string[];
};

function executionView(meta: BackupExecutionMeta | null): unknown {
  return meta === null ? null : { ...meta };
}

/**
 * §8: the canonical digest of the COMPLETE loss. It covers both stores'
 * identities, epochs, schema version, issue/catalog authority state and
 * execution identity; every authority difference; every lost operation id; and
 * every operation receipt only the point holds. The readable preview is a
 * projection of it, so an approval can never describe less than it approves.
 */
function lossDigestOf(input: {
  preview: Omit<ExecutionRecoveryPreview, "lossDigest">;
  live: LiveAnchor;
  backup: BackupInspection;
  resurrectedOperationIds: string[];
}): string {
  return sha256Of(
    serializeExecutionValue({
      format: "execution-restore-loss-v1",
      version: EXECUTION_RECOVERY_PROTOCOL_VERSION,
      backupPath: input.preview.backupPath,
      backupSha256: input.preview.backupSha256,
      backupEpoch: input.preview.backupEpoch,
      backupAuthorityState: input.backup.authorityState,
      backupSchemaVersion: input.backup.schemaVersion,
      backupExecution: executionView(input.backup.execution),
      backupCounts: { ...input.backup.counts },
      liveStoreId: input.preview.liveStoreId,
      liveEpoch: input.preview.liveEpoch,
      liveAuthorityState: input.live.authorityState,
      liveSchemaVersion: input.live.schemaVersion,
      liveExecution: executionView(input.live.execution),
      authorityDifferences: input.preview.authorityDifferences,
      lostOperationIds: input.preview.lostOperationIds,
      resurrectedOperationIds: input.resurrectedOperationIds,
    }),
  );
}

/**
 * Verify the recovery point and inventory the whole store against it. Both
 * sides are read under the SAME rule, so a row that only one of them holds is
 * as visible as a row whose content changed.
 */
async function buildLossInventory(context: StoreContext, backupPath: string): Promise<LossInventory> {
  if (!isNonEmptyString(backupPath)) {
    throw conflict("a restore preview needs the recovery point path it is previewed against");
  }
  const root = controlRootOf(context);
  const point = canonicalPath(resolve(backupPath));
  if (!isPathWithin(root, point)) {
    throw new StoreActivationError(
      "store.activation-stale",
      `the recovery point ${backupPath} is outside the authorized control root ${root}; a recovery point must live inside the ` +
        `root it protects.`,
    );
  }
  const liveStore = canonicalPath(storeDbPath(context));
  if (point === liveStore || point === `${liveStore}-wal` || point === `${liveStore}-shm`) {
    throw new StoreActivationError(
      "store.activation-stale",
      `the recovery point ${backupPath} names the live store database itself. §8: copying \`store.db\` bytes is not a backup, ` +
        `so the live database and its WAL/SHM sidecars are never their own recovery point.`,
    );
  }
  if (!existsSync(point)) {
    throw new StoreActivationError("store.activation-stale", `no recovery point exists at ${point}.`);
  }
  let description: BackupInspection;
  try {
    description = await inspectBackupCopy(point);
  } catch (error) {
    if (error instanceof StoreActivationError) throw error;
    throw new StoreActivationError(
      "store.activation-stale",
      `the recovery point at ${point} cannot be verified (${(error as Error).message}); it is not a recovery point for this store.`,
    );
  }
  const backupSha256 = await sha256OfFile(point);

  // §8: the point must describe THIS store, this schema and this generation.
  const live = await readLiveStore(context, "the restore preview");
  if (description.storeId !== live.storeId) {
    throw new StoreActivationError(
      "store.activation-stale",
      `the recovery point at ${point} belongs to store ${description.storeId}, not to the live store ${live.storeId}; a point ` +
        `of another store is never restored over this one.`,
    );
  }
  if (description.schemaVersion !== live.schemaVersion) {
    throw new StoreActivationError(
      "store.activation-stale",
      `the recovery point at ${point} records schema ${description.schemaVersion} while the live store is at ` +
        `${live.schemaVersion}; a point this store cannot install byte-identically is not a recovery point for it.`,
    );
  }
  if (description.epoch > live.epoch) {
    throw new StoreActivationError(
      "store.activation-stale",
      `the recovery point at ${point} carries authority epoch ${description.epoch}, which is AHEAD of the live store's ` +
        `${live.epoch}; the point is not a rollback target for this store.`,
    );
  }

  const availability: TableAvailability = {
    catalog: live.schemaVersion >= CATALOG_MIGRATION_VERSION,
    execution: live.schemaVersion >= EXECUTION_MIGRATION_VERSION,
  };
  const copy = await readCopyRows(point, availability);

  const differences: ExecutionRecoveryAuthorityDifference[] = [];
  const liveByKey = new Map(live.rows.map((row) => [`${row.domain}\u0000${row.key}`, row] as const));
  const copyByKey = new Map(copy.rows.map((row) => [`${row.domain}\u0000${row.key}`, row] as const));
  for (const key of [...new Set([...liveByKey.keys(), ...copyByKey.keys()])].sort()) {
    const onLive = liveByKey.get(key);
    const onCopy = copyByKey.get(key);
    if (onLive !== undefined && onCopy !== undefined && onLive.digest === onCopy.digest) continue;
    const [domain] = key.split("\u0000") as [AuthorityDomain];
    differences.push({
      domain,
      key: (onLive ?? onCopy)!.key,
      liveRevision: onLive?.revision ?? null,
      backupRevision: onCopy?.revision ?? null,
    });
  }
  // §3.1: the catalog domain's own root revision. It is a column of
  // `store_meta`, so it is reported as its own entry rather than folded into
  // the issue-domain row that also carries it.
  const liveCatalogRow = live.rows.find((row) => row.domain === "issue" && row.key === "store_meta");
  const copyCatalogRow = copy.rows.find((row) => row.domain === "issue" && row.key === "store_meta");
  if (live.catalogRevision !== description.catalogRevision && liveCatalogRow !== undefined && copyCatalogRow !== undefined) {
    differences.push({
      domain: "catalog",
      key: "store_meta.catalog_revision",
      liveRevision: live.catalogRevision,
      backupRevision: description.catalogRevision,
    });
    differences.sort((a, b) => (a.domain === b.domain ? (a.key < b.key ? -1 : 1) : a.domain < b.domain ? -1 : 1));
  }

  const liveOperationIds = new Set(live.operationIds);
  const copyOperationIds = new Set(copy.operationIds);
  const lostOperationIds = [...liveOperationIds].filter((id) => !copyOperationIds.has(id)).sort();
  const resurrectedOperationIds = [...copyOperationIds].filter((id) => !liveOperationIds.has(id)).sort();

  const withoutDigest: Omit<ExecutionRecoveryPreview, "lossDigest"> = {
    backupPath: point,
    backupSha256,
    liveStoreId: live.storeId,
    liveEpoch: live.epoch,
    backupEpoch: description.epoch,
    lostOperationIds,
    authorityDifferences: differences,
  };
  const anchor: LiveAnchor = {
    storeId: live.storeId,
    epoch: live.epoch,
    revision: live.revision,
    catalogRevision: live.catalogRevision,
    authorityState: live.authorityState,
    schemaVersion: live.schemaVersion,
    execution: live.execution,
  };
  return {
    preview: {
      ...withoutDigest,
      lossDigest: lossDigestOf({ preview: withoutDigest, live: anchor, backup: description, resurrectedOperationIds }),
    },
    live: anchor,
    backup: description,
    resurrectedOperationIds,
  };
}

/**
 * `previewExecutionRestore` — §8's read-only loss preview.
 *
 * It mutates nothing: it reads the live store through the read snapshot, verifies
 * the point, inventories the whole store and returns the canonical digest of
 * what restoring it would cost. A live store that cannot be inventoried
 * refuses with `execution.recovery-loss-unaccepted` and leaves both files
 * exactly where they are.
 */
export async function previewExecutionRestore(context: StoreContext, backupPath: string): Promise<ExecutionRecoveryPreview> {
  return (await buildLossInventory(context, backupPath)).preview;
}

// ---------------------------------------------------------------------------
// Restore (§8)
// ---------------------------------------------------------------------------

/** §8 (verbatim) the restore request, validated into a projection. */
type ResolvedRestoreInput = {
  preview: ExecutionRecoveryPreview;
  acceptLossDigest: string | null;
  operator: string;
  authorization: string;
};

function requireDifference(value: unknown, index: number): ExecutionRecoveryAuthorityDifference {
  if (!isPlainObject(value)) throw conflict(`the preview's difference ${index} is not an object`);
  const domain = value.domain;
  if (domain !== "issue" && domain !== "catalog" && domain !== "execution") {
    throw conflict(`the preview's difference ${index} names domain ${JSON.stringify(domain)}`);
  }
  if (!isNonEmptyString(value.key)) throw conflict(`the preview's difference ${index} carries no row key`);
  const revision = (candidate: unknown, field: string): number | null => {
    if (candidate === null) return null;
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate)) {
      throw conflict(`the preview's difference ${index} carries ${field} ${JSON.stringify(candidate)}`);
    }
    return candidate;
  };
  return {
    domain,
    key: value.key,
    liveRevision: revision(value.liveRevision, "liveRevision"),
    backupRevision: revision(value.backupRevision, "backupRevision"),
  };
}

/**
 * The request, validated field by field into the declared shape. Extra fields
 * are dropped rather than travelling, and the digest is compared as an exact
 * string — a prefix or a "yes" is not an approval.
 */
function requireRestoreInput(input: {
  preview: ExecutionRecoveryPreview;
  acceptLossDigest: string | null;
  operator: string;
  authorization: string;
}): ResolvedRestoreInput {
  const raw = input as unknown as Record<string, unknown> | undefined;
  if (!isPlainObject(raw)) throw conflict("a restore needs the preview it acts on, the operator and the authorization reference");
  if (!isNonEmptyString(raw.operator) || !isNonEmptyString(raw.authorization)) {
    throw conflict(
      "a restore needs a non-empty operator and a non-empty authorization reference; the authorization is the audit record of who " +
        "accepted the disclosed loss, not a bypass.",
    );
  }
  const preview: unknown = raw.preview;
  if (!isPlainObject(preview)) throw conflict("a restore needs the preview object it was taken from");
  if (!isNonEmptyString(preview.backupPath) || !isNonEmptyString(preview.backupSha256)) {
    throw conflict("the preview names no recovery point; take one with `previewExecutionRestore` and pass it back verbatim");
  }
  if (!isNonEmptyString(preview.liveStoreId) || !isNonEmptyString(preview.lossDigest)) {
    throw conflict("the preview is not the object `previewExecutionRestore` produced");
  }
  if (!Array.isArray(preview.lostOperationIds) || !Array.isArray(preview.authorityDifferences)) {
    throw conflict("the preview carries no loss inventory; take one with `previewExecutionRestore`");
  }
  const positive = (value: unknown, field: string): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw conflict(`the preview's ${field} is ${JSON.stringify(value)}, not a positive safe integer`);
    }
    return value;
  };
  const lostOperationIds = preview.lostOperationIds.map((id: unknown, index: number) => {
    if (!isNonEmptyString(id)) throw conflict(`the preview's lost operation id ${index} is not a string`);
    return id;
  });
  return {
    preview: {
      backupPath: preview.backupPath,
      backupSha256: preview.backupSha256,
      liveStoreId: preview.liveStoreId,
      liveEpoch: positive(preview.liveEpoch, "liveEpoch"),
      backupEpoch: positive(preview.backupEpoch, "backupEpoch"),
      lostOperationIds,
      lossDigest: preview.lossDigest,
      authorityDifferences: preview.authorityDifferences.map(requireDifference),
    },
    acceptLossDigest: raw.acceptLossDigest === null || raw.acceptLossDigest === undefined ? null : String(raw.acceptLossDigest),
    operator: raw.operator,
    authorization: raw.authorization,
  };
}

/**
 * The durable receipt of one attempt (§8 "record an external recovery receipt
 * before/after the atomic replacement"). It is written before the rename and
 * rewritten after it, so a crash is decidable from the file alone.
 */
type ExecutionRecoveryRecord = {
  recoveryVersion: number;
  phase: "replacing" | "replaced";
  storeId: string;
  operator: string;
  authorization: string;
  backupPath: string;
  backupSha256: string;
  liveStorePath: string;
  liveEpoch: number;
  backupEpoch: number;
  newEpoch: number;
  /** SHA-256 of the live database bytes after the quiescence checkpoint. */
  liveStoreSha256: string;
  /** SHA-256 of the verified sibling image a completed replacement installs. */
  restoredCopySha256: string;
  restoredCopyPath: string;
  lossDigest: string;
  acceptedLossDigest: string | null;
  /** §8/§2.3: what the operator still owes before a consumer may read the store. */
  requiredRebind: string;
  preRestoreBackup: BackupReceipt;
  writtenAt: string;
  verified?: { integrity: "ok"; foreignKeys: "ok"; schemaVersion: number; executionAuthorityState: string | null };
  replacedAt?: string;
};

/** §8/§2.3: the step a restored store owes before ordinary consumers may read it. */
function requiredRebind(): string {
  return (
    "Every reference that was valid before the replacement is invalid: the restore advances the store-wide epoch above both " +
    "the live store and the recovery point, so a pre-restore handle refuses `store.stale-epoch`, the restored session rows are " +
    "below the new epoch and authorize nothing, and any restored held lease keeps its old `owner_epoch`. Recover each " +
    "workflow's coordinator with `recoverExecutionCoordinator` (naming the recorded prior holder and attesting it stopped), " +
    "rebind its plans with `bindExecutionSession`, and reconcile any restored lease explicitly before reuse."
  );
}

function recoveryReceiptPathOf(root: string, attemptId: string): string {
  return join(root, "archived", "store-migration", "recovery", `restore-${Date.now().toString().padStart(16, "0")}-${attemptId}.json`);
}

/**
 * Patch the epoch into the recovery IMAGE — the sibling copy on its way to
 * becoming the live store.
 *
 * The image is deliberately left in the journal mode `VACUUM INTO` produced
 * (a rollback-journal database, no sidecar of its own) rather than being put
 * into WAL here: a WAL-mode database that is renamed into place with no
 * `-shm` beside it cannot be opened read-only at all, so installing one would
 * trade a transient mode for an unreadable store. The installed store is
 * therefore the recovery point's own bytes plus one epoch, no read path is
 * weakened, and the next write access through `openStore` re-establishes WAL
 * exactly as it does for any other store.
 *
 * The specifier cannot be a static import: contract §2 requires lazy,
 * capability-checked SQLite acquisition at store access, and `openStore` owns
 * exactly `<root>/store.db`, never an image beside it.
 */
async function patchImageEpoch(imagePath: string, epoch: number): Promise<void> {
  assertStoreRuntimeSupported();
  const { DatabaseSync } = (await import("node:sqlite")) as { DatabaseSync: new (path: string) => StoreDb };
  const db = new DatabaseSync(imagePath);
  try {
    db.exec("pragma synchronous=FULL");
    db.exec("pragma foreign_keys=ON");
    db.exec("begin immediate");
    try {
      const changed = db.prepare("update store_meta set authority_epoch = ? where id = 1").run(epoch) as { changes?: unknown };
      if (Number(changed?.changes) !== 1) {
        throw corrupt(`the recovery image ${imagePath} holds no store_meta singleton to re-epoch`);
      }
      db.exec("commit");
    } catch (error) {
      try {
        db.exec("rollback");
      } catch {
        // the transaction already rolled back
      }
      throw error;
    }
  } finally {
    db.close();
  }
  // The image must carry no half-written sidecar of its own before it is
  // renamed into place.
  rmSync(`${imagePath}-wal`, { force: true });
  rmSync(`${imagePath}-shm`, { force: true });
  rmSync(`${imagePath}-journal`, { force: true });
}

/** §8 "quick_checkpoint old WAL": fold the live WAL in, and prove quiescence while doing it. */
async function checkpointLiveStore(context: StoreContext): Promise<void> {
  const handle = await openStore(context, "write");
  try {
    const result = handle.db.prepare("pragma wal_checkpoint(TRUNCATE)").get() as { busy?: unknown; log?: unknown } | undefined;
    if (result?.busy !== 0) {
      throw new StoreError(
        "store.busy",
        `the live store at ${storeDbPath(context)} is not quiesced: a checkpoint could not complete because another connection ` +
          `still holds it. A restore is a quiesced, whole-store replacement (contract §8); nothing was replaced.`,
      );
    }
  } finally {
    handle.close();
  }
}

async function runRestore(context: StoreContext, root: string, input: ResolvedRestoreInput): Promise<ExecutionRestoreReceipt> {
  // §8: the preview is recomputed under the maintenance lock and compared
  // byte-for-byte with the one the operator approved, so work committed after
  // the preview can never vanish under an approval that never described it.
  const inventory = await buildLossInventory(context, input.preview.backupPath);
  if (serializeExecutionValue(inventory.preview) !== serializeExecutionValue(input.preview)) {
    throw lossUnaccepted(
      `the loss inventory moved since the preview was taken (approved digest ${input.preview.lossDigest.slice(0, 12)}, current ` +
        `digest ${inventory.preview.lossDigest.slice(0, 12)}); the approved loss is not the loss this restore would cause. ` +
        `Nothing was replaced — re-preview, read the new loss and decide again.`,
    );
  }
  const hasLoss = inventory.preview.lostOperationIds.length > 0 || inventory.preview.authorityDifferences.length > 0;
  if (input.acceptLossDigest === null) {
    if (hasLoss) {
      throw lossUnaccepted(
        `restoring ${inventory.preview.backupPath} would discard ${inventory.preview.authorityDifferences.length} authority ` +
          `row(s) and ${inventory.preview.lostOperationIds.length} committed operation(s) the live store holds. §8 requires the ` +
          `exact \`acceptLossDigest\` of the inventory the operator read (${inventory.preview.lossDigest}); there is no default yes.`,
      );
    }
  } else if (input.acceptLossDigest !== inventory.preview.lossDigest) {
    throw lossUnaccepted(
      `the accepted loss digest ${input.acceptLossDigest} is not this inventory's ${inventory.preview.lossDigest}; an approval ` +
        `names the exact loss it accepts. Nothing was replaced.`,
    );
  }

  // §8 quiescence, then the fresh pre-restore recovery point.
  await checkpointLiveStore(context);
  const livePath = storeDbPath(context);
  const before = await readLiveStore(context, "the restore");
  if (
    before.storeId !== inventory.live.storeId ||
    before.epoch !== inventory.live.epoch ||
    before.revision !== inventory.live.revision ||
    before.catalogRevision !== inventory.live.catalogRevision ||
    before.authorityState !== inventory.live.authorityState ||
    serializeExecutionValue(before.execution) !== serializeExecutionValue(inventory.live.execution)
  ) {
    throw lossUnaccepted(
      `the live store changed after its loss was inventoried (epoch/revision/authority moved); the approved loss is no longer ` +
        `complete. Nothing was replaced.`,
    );
  }
  const safety = await backupStore(context, {
    out: join(root, "archived", "store-migration", "backups", `pre-restore-e${before.epoch}-r${before.revision}-${randomUUID()}.db`),
  });

  // The old database's own sidecars, recorded so only THOSE are removed later.
  const sidecars = ["-wal", "-shm"].map((suffix) => ({ path: `${livePath}${suffix}`, identity: identityOf(`${livePath}${suffix}`) }));
  const liveIdentity = identityOf(livePath);
  const liveSha256 = await sha256OfFile(livePath);

  // §8: restore into a verified sibling on the SAME filesystem, with the epoch
  // already above both generations, so the rename is the whole cutover and no
  // window exists in which the restored bytes carry a live reference generation.
  const attemptId = randomUUID();
  const imagePath = join(root, `.store-restore-${attemptId}.db`);
  const receiptPath = recoveryReceiptPathOf(root, attemptId);
  const newEpoch = Math.max(before.epoch, inventory.backup.epoch) + 1;
  try {
    copyFileSync(inventory.preview.backupPath, imagePath);
    if ((await sha256OfFile(imagePath)) !== inventory.preview.backupSha256) {
      throw new StoreActivationError(
        "store.activation-stale",
        `the recovery point at ${inventory.preview.backupPath} changed while it was being installed; the bytes behind the ` +
          `approved hash are not the bytes on disk. Nothing was replaced.`,
      );
    }
    await patchImageEpoch(imagePath, newEpoch);
    const image = await inspectBackupCopy(imagePath);
    if (
      image.storeId !== inventory.live.storeId ||
      image.schemaVersion !== inventory.backup.schemaVersion ||
      image.authorityState !== inventory.backup.authorityState ||
      serializeExecutionValue(image.execution) !== serializeExecutionValue(inventory.backup.execution) ||
      JSON.stringify(image.counts) !== JSON.stringify(inventory.backup.counts)
    ) {
      throw new StoreActivationError(
        "store.activation-stale",
        `the prepared image does not hold the selected recovery point's state (identity, schema, authority or row counts); ` +
          `nothing was replaced.`,
      );
    }
    const imageSha256 = await sha256OfFile(imagePath);
    const record: ExecutionRecoveryRecord = {
      recoveryVersion: EXECUTION_RECOVERY_PROTOCOL_VERSION,
      phase: "replacing",
      storeId: before.storeId,
      operator: input.operator,
      authorization: input.authorization,
      backupPath: inventory.preview.backupPath,
      backupSha256: inventory.preview.backupSha256,
      liveStorePath: livePath,
      liveEpoch: before.epoch,
      backupEpoch: inventory.backup.epoch,
      newEpoch,
      liveStoreSha256: liveSha256,
      restoredCopySha256: imageSha256,
      restoredCopyPath: imagePath,
      lossDigest: inventory.preview.lossDigest,
      acceptedLossDigest: input.acceptLossDigest,
      requiredRebind: requiredRebind(),
      preRestoreBackup: safety,
      writtenAt: new Date().toISOString(),
    };
    writeJson(receiptPath, record);
    recoveryFailureHook("before-replacement");

    // The last synchronous gate: no `await` separates these checks from the
    // rename, so nothing in this process can interleave with them, and only
    // files whose recorded (dev, ino) still match are ever removed.
    if (!sameIdentity(liveIdentity, identityOf(livePath))) {
      throw lossUnaccepted(`the live store file at ${livePath} was replaced by another writer; nothing was replaced.`);
    }
    for (const sidecar of sidecars) {
      const now = identityOf(sidecar.path);
      // A sidecar that is still the file the checkpoint saw, or that is GONE, is
      // quiescence: SQLite's own last clean close folds the journal into the
      // database and removes it (and this runtime can land that removal just
      // after the close), which is the store going quiet. A fold cannot hide
      // here — the live BYTES are re-verified against the checkpoint hash in the
      // next statement, with no await in between. A sidecar that is present and
      // is not that file is a writer, and refuses.
      if (now !== undefined && !sameIdentity(sidecar.identity, now)) {
        throw lossUnaccepted(`a WAL/SHM sidecar of ${livePath} appeared after the checkpoint; the store is not quiesced. Nothing was replaced.`);
      }
    }
    if ((await sha256OfFile(livePath)) !== liveSha256) {
      throw lossUnaccepted(`the live store bytes changed after the pre-restore recovery point was taken; nothing was replaced.`);
    }
    renameSync(imagePath, livePath);
    for (const sidecar of sidecars) {
      if (sidecar.identity !== undefined && sameIdentity(sidecar.identity, identityOf(sidecar.path))) {
        unlinkSync(sidecar.path);
      }
    }
    recoveryFailureHook("after-replacement");

    // §8: reopen and verify integrity, identity and the selected whole-store
    // state before the receipt is finalized. A verification failure here is
    // reported with the receipt that identifies the installed bytes, so the
    // operator resumes verification instead of assuming the original survived.
    const installed = await inspectBackupCopy(livePath).catch((error: unknown) => {
      throw corrupt(
        `the store installed by this restore at ${livePath} cannot be verified (${(error as Error).message}). The durable ` +
          `recovery receipt at ${receiptPath} names both hashes, so identify the installed store from it and resume ` +
          `verification; do not assume the original bytes survived.`,
      );
    });
    if (installed.storeId !== before.storeId || installed.epoch !== newEpoch) {
      throw corrupt(
        `the store installed by this restore at ${livePath} describes store ${installed.storeId} epoch ${installed.epoch}, not ` +
          `store ${before.storeId} epoch ${newEpoch}. Identify the installed store from the durable recovery receipt at ` +
          `${receiptPath} before doing anything else.`,
      );
    }
    writeJson(receiptPath, {
      ...record,
      phase: "replaced",
      storeId: installed.storeId,
      restoredCopySha256: await sha256OfFile(livePath),
      verified: {
        integrity: "ok",
        foreignKeys: "ok",
        schemaVersion: installed.schemaVersion,
        executionAuthorityState: installed.execution?.authorityState ?? null,
      },
      replacedAt: new Date().toISOString(),
    } satisfies ExecutionRecoveryRecord);
    return {
      storeId: installed.storeId,
      epoch: installed.epoch,
      restoredFromSha256: inventory.preview.backupSha256,
      preRestoreBackup: safety,
      recoveryReceiptPath: receiptPath,
    };
  } catch (error) {
    // This attempt's own scratch image, and only while it is still that file:
    // after a completed rename the path is gone and nothing here can touch the
    // installed store.
    rmSync(`${imagePath}-wal`, { force: true });
    rmSync(`${imagePath}-shm`, { force: true });
    rmSync(imagePath, { force: true });
    throw error;
  }
}

/**
 * `restoreExecutionBackup` — §8's whole-store replacement.
 *
 * Under the §4.2 maintenance → root lock ladder it recomputes the loss
 * inventory, refuses anything but the exact approved digest, takes a fresh
 * pre-restore recovery point, checkpoints the live WAL, installs a verified
 * sibling whose epoch is above both generations, and records the durable
 * receipt before and after the atomic rename. It never falls back to files and
 * never converts DB state back into JSON.
 */
export async function restoreExecutionBackup(
  context: StoreContext,
  input: { preview: ExecutionRecoveryPreview; acceptLossDigest: string | null; operator: string; authorization: string },
): Promise<ExecutionRestoreReceipt> {
  const resolved = requireRestoreInput(input);
  const root = controlRootOf(context);
  return withExecutionMaintenanceLock(context, () => withStatusWriteLock(join(root, "status.json"), () => runRestore(context, root, resolved)));
}

// ---------------------------------------------------------------------------
// Diagnostic export (§8)
// ---------------------------------------------------------------------------

/**
 * The keys a session identity is ever recorded under — the reference fields of
 * §2.3/§2.2 and the actor fields the coordination vocabulary names one with.
 * §8 excludes "credential bytes, raw session file paths and mutation-capable
 * session references" from the export, so the projection drops these keys
 * wherever they appear and REPORTS that it did (`redactedKeys`), rather than
 * dropping data silently. Nothing else about the stored state is altered.
 */
const REDACTED_KEYS: Record<string, true> = {
  session: true,
  session_id: true,
  sessionId: true,
  session_file: true,
  session_label: true,
  holder: true,
  holder_session_id: true,
  holder_role: true,
  creator_session_id: true,
  submitted_by: true,
  accepted_by: true,
  bound_by: true,
  token: true,
  workflowToken: true,
  planTokens: true,
  expected: true,
  credential: true,
  secret: true,
  bearer: true,
  authorization: true,
};

function redactSessionIdentities(value: unknown, redacted: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSessionIdentities(item, redacted));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(REDACTED_KEYS, key)) {
        if (!redacted.includes(key)) redacted.push(key);
        continue;
      }
      out[key] = redactSessionIdentities(entry, redacted);
    }
    return out;
  }
  return value;
}

function parseStoredJson(value: unknown, what: string, redacted: string[]): unknown {
  if (typeof value !== "string") throw corrupt(`${what} is not stored as JSON text`);
  try {
    return redactSessionIdentities(JSON.parse(value) as unknown, redacted);
  } catch (error) {
    if (error instanceof ExecutionRecoveryError) throw error;
    throw corrupt(`${what} is not readable JSON (${(error as Error).message}); the diagnostic export cannot describe this store`);
  }
}

/** The harness-relative spelling of one recorded source, or null when it escapes the root. */
function relativeSourcePath(root: string, path: string): string | null {
  if (!isPathWithin(root, path)) return null;
  const rel = relative(root, canonicalPath(path));
  if (rel === "" || rel.split(sep).some((segment) => segment === ".." || segment === "")) return null;
  return rel.split(sep).join("/");
}

/**
 * §8's "source status": the recorded migration sources, each with the state its
 * bytes are actually in. A SESSION ENVELOPE is the credential-bearing file the
 * migration never converts, so its state travels and its path deliberately does
 * not — the export is not a map to credential files.
 */
function sourceStatusOf(root: string, manifestJson: unknown): Array<{ kind: string; relativePath: string | null; state: string }> {
  let manifest: unknown;
  try {
    manifest = typeof manifestJson === "string" ? (JSON.parse(manifestJson) as unknown) : null;
  } catch {
    throw corrupt("a recorded migration manifest is not readable JSON; the diagnostic export cannot describe this store");
  }
  if (!isPlainObject(manifest) || !Array.isArray(manifest.sources)) return [];
  return manifest.sources.map((witness: unknown) => {
    const record = isPlainObject(witness) ? witness : {};
    const kind = isNonEmptyString(record.kind) ? record.kind : "deferred";
    const path = typeof record.path === "string" ? record.path : "";
    if (kind === "session-envelope") {
      return { kind, relativePath: null, state: existsSync(path) ? "present" : "absent" };
    }
    const bytes = readIfExists(path);
    if (bytes === undefined) return { kind, relativePath: relativeSourcePath(root, path), state: "absent" };
    return { kind, relativePath: relativeSourcePath(root, path), state: sha256Of(bytes) === record.sha256 ? "matching" : "changed" };
  });
}

type DiagnosticPlan = {
  planId: string;
  revision: number;
  ordinal: number;
  state: unknown;
  coordination: unknown;
  input: { inputJson: unknown; inputHash: string; catalogPin: unknown };
  lease: unknown;
};

/**
 * §8: canonical sorted data with the store/execution identity, the recorded
 * migrations and their source status, and workflow/plan/lease/frozen-input
 * state — with every session identity, CAS token and credential path removed.
 * There is no import verb: this artifact can describe an authority, never
 * reconstitute one, and no writer accepts it (proved in the module's tests).
 */
export async function exportExecutionState(context: StoreContext): Promise<ExecutionDiagnosticExport> {
  const root = controlRootOf(context);
  const handle = await openStore(context, "read");
  try {
    const redacted: string[] = [];
    handle.db.exec("begin");
    try {
      const meta = handle.db
        .prepare("select store_id, authority_state, authority_epoch, revision, catalog_revision from store_meta where id = 1")
        .get() as Record<string, unknown> | undefined;
      if (!meta || typeof meta.store_id !== "string") throw corrupt("store_meta is missing; there is no store identity to export");

      const migrations =
        handle.schemaVersion >= EXECUTION_MIGRATION_VERSION
          ? (handle.db
              .prepare("select manifest_id, manifest_hash, phase, created_at, updated_at, manifest_json from execution_migrations order by rowid")
              .all() as Array<Record<string, unknown>>)
          : [];
      const governing = handle.schemaVersion >= EXECUTION_MIGRATION_VERSION ? latestGoverningMigration(handle.db) : null;

      const sessions =
        handle.schemaVersion >= EXECUTION_MIGRATION_VERSION
          ? (handle.db
              .prepare("select workflow_id, role, plan_id, epoch, revision, state, bound_at from execution_sessions order by workflow_id, role, plan_id, session_id")
              .all() as Array<Record<string, unknown>>)
          : [];
      const leases =
        handle.schemaVersion >= EXECUTION_MIGRATION_VERSION
          ? (handle.db.prepare("select workflow_id, plan_id, lease_json from execution_leases order by workflow_id, plan_id").all() as Array<
              Record<string, unknown>
            >)
          : [];
      const integrationLeases =
        handle.schemaVersion >= EXECUTION_MIGRATION_VERSION
          ? (handle.db
              .prepare("select workflow_id, lease_json from execution_integration_leases order by workflow_id")
              .all() as Array<Record<string, unknown>>)
          : [];
      const inputs =
        handle.schemaVersion >= EXECUTION_MIGRATION_VERSION
          ? (handle.db
              .prepare("select workflow_id, plan_id, input_json, input_hash, catalog_pin_json from execution_inputs order by workflow_id, plan_id")
              .all() as Array<Record<string, unknown>>)
          : [];
      const plans =
        handle.schemaVersion >= EXECUTION_MIGRATION_VERSION
          ? (handle.db
              .prepare("select workflow_id, plan_id, revision, ordinal, state_json, coordination_json from execution_plans order by workflow_id, ordinal")
              .all() as Array<Record<string, unknown>>)
          : [];
      const registry =
        handle.schemaVersion >= EXECUTION_MIGRATION_VERSION
          ? (handle.db.prepare("select workflow_id, entry_json from execution_registry order by workflow_id").all() as Array<Record<string, unknown>>)
          : [];
      const workflows =
        handle.schemaVersion >= EXECUTION_MIGRATION_VERSION
          ? (handle.db
              .prepare("select workflow_id, revision, state_json, created_at, updated_at from execution_workflows order by workflow_id")
              .all() as Array<Record<string, unknown>>)
          : [];

      const payload = {
        format: "execution-diagnostic-v1",
        store: {
          storeId: meta.store_id,
          epoch: meta.authority_epoch,
          revision: meta.revision,
          catalogRevision: meta.catalog_revision,
          authorityState: meta.authority_state,
          schemaVersion: handle.schemaVersion,
        },
        execution: handle.execution === null ? null : { ...handle.execution },
        redactedKeys: redacted,
        migrations: migrations.map((row) => ({
          manifestId: text(row, "manifest_id"),
          manifestHash: text(row, "manifest_hash"),
          phase: text(row, "phase"),
          createdAt: text(row, "created_at"),
          updatedAt: text(row, "updated_at"),
        })),
        sources: governing === null ? [] : sourceStatusOf(root, governing.manifest_json),
        workflows: workflows.map((workflow) => {
          const workflowId = text(workflow, "workflow_id");
          return {
            workflowId,
            revision: number(workflow, "revision"),
            state: parseStoredJson(workflow.state_json, `execution_workflows(${workflowId}).state_json`, redacted),
            createdAt: text(workflow, "created_at"),
            updatedAt: text(workflow, "updated_at"),
            registered: registry.some((entry) => text(entry, "workflow_id") === workflowId),
            registryEntry: parseStoredJson(
              registry.find((entry) => text(entry, "workflow_id") === workflowId)?.entry_json,
              `execution_registry(${workflowId}).entry_json`,
              redacted,
            ),
            plans: plans
              .filter((plan) => text(plan, "workflow_id") === workflowId)
              .map((plan): DiagnosticPlan => {
                const planId = text(plan, "plan_id");
                const sealed = inputs.find((input) => text(input, "workflow_id") === workflowId && text(input, "plan_id") === planId);
                const lease = leases.find((row) => text(row, "workflow_id") === workflowId && text(row, "plan_id") === planId);
                return {
                  planId,
                  revision: number(plan, "revision"),
                  ordinal: number(plan, "ordinal"),
                  state: parseStoredJson(plan.state_json, `execution_plans(${workflowId},${planId}).state_json`, redacted),
                  coordination: parseStoredJson(plan.coordination_json, `execution_plans(${workflowId},${planId}).coordination_json`, redacted),
                  input: {
                    inputJson:
                      sealed === undefined
                        ? null
                        : parseStoredJson(sealed.input_json, `execution_inputs(${workflowId},${planId}).input_json`, redacted),
                    inputHash: sealed === undefined ? "" : text(sealed, "input_hash"),
                    catalogPin:
                      sealed === undefined || sealed.catalog_pin_json === null || sealed.catalog_pin_json === undefined
                        ? null
                        : parseStoredJson(sealed.catalog_pin_json, `execution_inputs(${workflowId},${planId}).catalog_pin_json`, redacted),
                  },
                  lease:
                    lease === undefined
                      ? null
                      : parseStoredJson(lease.lease_json, `execution_leases(${workflowId},${planId}).lease_json`, redacted),
                };
              }),
            integrationLease: (() => {
              const held = integrationLeases.find((row) => text(row, "workflow_id") === workflowId);
              return held === undefined
                ? null
                : parseStoredJson(held.lease_json, `execution_integration_leases(${workflowId}).lease_json`, redacted);
            })(),
          };
        }),
        sessions: sessions.map((session) => ({
          workflowId: text(session, "workflow_id"),
          role: text(session, "role"),
          planId: session.plan_id === null || session.plan_id === undefined ? null : String(session.plan_id),
          state: text(session, "state"),
          epoch: number(session, "epoch"),
          revision: number(session, "revision"),
          boundAt: text(session, "bound_at"),
        })),
      };
      // The `redactedKeys` list is part of the artifact, so the pass above has
      // to complete before it is serialized.
      const canonicalJson = serializeExecutionValue(redactSessionIdentities(payload, redacted));
      return { format: "execution-diagnostic-v1", canonicalJson, sha256: sha256Of(canonicalJson) };
    } finally {
      handle.db.exec("commit");
    }
  } finally {
    handle.close();
  }
}

/**
 * The migration record whose sources are the live ones: the most advanced
 * phase wins (a retired manifest's sources are the ones that moved), and the
 * newest row breaks the tie.
 */
function latestGoverningMigration(db: StoreDb): Record<string, unknown> | null {
  const row = db
    .prepare(
      "select manifest_json from execution_migrations " +
        "order by case phase when 'retired' then 4 when 'active' then 3 when 'staged' then 2 else 1 end desc, rowid desc limit 1",
    )
    .get() as Record<string, unknown> | undefined;
  return row ?? null;
}
