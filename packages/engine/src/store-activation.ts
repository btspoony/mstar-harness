/**
 * store-activation.ts — the activation barrier, the retirement of the legacy
 * sources and the consistent backup (issue-store-contract §7).
 *
 * Boundaries this module owns, and does not cross:
 * - `activateStore` is the ONE point where the DB replaces the live registers
 *   as issue/catalog authority (§1, D19 `apply≠activate≠retire`). It requires
 *   the reviewed applied receipt, a strict installed-consumer attestation
 *   (concrete entrypoints/versions, quiesced sessions, the approving operator;
 *   never session credentials), and a verified `VACUUM INTO` backup of the
 *   staged store. The register PATH SET is revalidated twice: on the inspection
 *   connection, and again INSIDE the flip transaction, so a new unreviewed
 *   legacy register landing in the window after the inspection pass refuses
 *   instead of letting the epoch bump against a source set that no longer
 *   matches the reviewed one. Content-byte drift is NOT a refusal — the
 *   recorded digests are provenance. The authority-state flip, the epoch
 *   increment and the receipt row commit in ONE transaction — the epoch is
 *   atomic, not a follow-up write.
 * - Every receipt carries the authority generation (`storeId` + `epoch`), and
 *   `assertAuthorityCurrent` / the retirement re-check refuse a resumed handle
 *   or receipt from an earlier generation with `store.stale-epoch` instead of
 *   letting it act against a superseded generation (§5).
 * - `retireStoreSources` moves the reviewed registers into
 *   `<resolved root>/archived/store-migration/<activation-receipt-id>/` under
 *   a resumable per-item ledger, preserving copy-before-remove ordering and
 *   path containment. A mixed-content index file loses only the lines of the
 *   table that still carries one of its reviewed row identities; every other
 *   byte — narrative, unrelated tables, rows added after review — stays.
 * - The archived registers are historical migration input, never a rollback
 *   path: recovery after activation is the verified SQLite-consistent backup
 *   plus reconciliation (§7), and the marker says so explicitly.
 * - Nothing here reads or writes a lease, session, workflow snapshot or
 *   `status.json`. The migration path cannot steal, release or rebind a lease,
 *   and no marker or warning is treated as a fence against an old binary —
 *   the fence is the attestation, the register set and the epoch.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve, sep } from "node:path";
import { catalogRootDir, type CatalogRootKind } from "./catalog.js";
import { resolveCollaborationLocation, type CollaborationMode } from "./collaboration-identity.js";
import {
  COLLABORATION_COLUMNS,
  initializeCollaborationStore,
  openCollaborationStore,
  readCollaborationAuthority,
  writeCollaborationStage,
  type CollaborationAuthority,
} from "./collaboration-store.js";
import {
  detectIndexFamily,
  indexRowIdentity,
  readTables,
  type IndexFamily,
  type RawTable,
} from "./catalog-import.js";
import { ACTIVATION_PROTOCOL_VERSION, readDeclaredNodeFloor, writeJson } from "./core.js";
import { provisionActivationDocument, type ProvisionProcessFacts } from "./activation-provisioning.js";
import type { MigrationManifest, MigrationReceipt } from "./store-migrate.js";
import {
  MIGRATIONS,
  assertStoreRuntimeSupported,
  busyTimeoutMs,
  compareVersions,
  connect,
  nowRfc3339,
  openStore,
  readCollaborationFence,
  readStoreAuthority,
  storeDbPath,
  syncDirectoryEntry,
  tableNamesOn,
  StoreError,
  type ExecutionAuthorityState,
  type ExecutionMeta,
  type StoreContext,
  type StoreDb,
} from "./store-db.js";

/**
 * Protocol version of the attestation, the receipts and the retirement ledger.
 * Defined in the leaf `core.ts` (so `activation-provisioning.ts` can import it
 * without a value-cycle) and re-exported here for every existing importer.
 */
export { ACTIVATION_PROTOCOL_VERSION };

/**
 * §7: the backup RECEIPT generation. Version 2 is the whole-image receipt:
 * the store identity, schema version, execution identity and row counts are
 * read from the copy itself (§8 "read metadata from the backup itself"). The
 * file-native accepted-body inventory an earlier generation recorded beside
 * the copy is gone — notes, agent-flow ledgers, cursors, the launch journal
 * and the selection snapshot are ordinary retained files, not a second
 * transactionally frozen authority, and a SQLite image does not roll them
 * back. A version-1 receipt stays readable for the migration gate.
 */
export const BACKUP_RECEIPT_VERSION = 2;

/** Stable refusal codes of the activation/retirement transport (§5 + §7). */
export type StoreActivationErrorCode =
  | "store.attestation-invalid"
  | "store.operator-required"
  | "store.activation-blocked"
  | "store.activation-stale"
  | "store.not-active"
  | "store.stale-epoch"
  | "store.migration-source-changed"
  | "store.legacy-write-detected";

export class StoreActivationError extends Error {
  readonly code: StoreActivationErrorCode;

  constructor(code: StoreActivationErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "StoreActivationError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Attestation — installed consumers, quiesced sessions, approving operator
// ---------------------------------------------------------------------------

export type AttestationConsumerKind = "cli" | "host-plugin" | "hook" | "coordinator";

/**
 * What happened to one installed consumer before the barrier: it was reloaded,
 * upgraded, or explicitly excluded from this control root. There is no
 * "pending"/"running" value — an un-attested old binary cannot be waved
 * through, because a marker or a warning is not a fence against it.
 *
 * A stateless per-invocation consumer (the CLI) is attested `reloaded` even
 * though no reload event occurs: nothing of it outlives an invocation, so its
 * next invocation under the current epoch is the whole reload, and the value
 * attests that no old process survived the barrier.
 */
export type AttestationDisposition =
  | "reloaded"
  | "upgraded"
  | "excluded:not-this-control-root"
  | "excluded:no-store-access"
  | "excluded:superseded-binary";

/** One concrete installed consumer of this control root (§7 "not simply source code merged"). */
export type InstalledConsumerAttestation = {
  entryId: string;
  kind: AttestationConsumerKind;
  /** The actual installed entrypoint (absolute path or the resolution root used). */
  entrypoint: string;
  /** The supported runtime. Bun is the development toolchain, never a consumer. */
  runtime: "node";
  /** The version ACTUALLY reported by that runtime (checked against the floor). */
  runtimeVersion: string;
  /** The installed package/bundle version of that entry. */
  version: string;
  /** True for the single current coordinator driving this activation. */
  current: boolean;
  disposition: AttestationDisposition;
};

/** One session that had to be quiesced before the barrier (§7). */
export type StoppedSessionAttestation = {
  sessionId: string;
  host: string;
  state: "stopped" | "reloaded";
};

/** One handle an operator explicitly asserts must be gone before a fence. */
export type CutoverStoppedHandle = {
  kind: "process" | "session" | "host" | "consumer";
  id: string;
};

/**
 * The cutover-scope block of an attestation: the exact control root, the exact
 * source generation and the operator's own stopped-handle assertion. A
 * queryable session table cannot prove that an old process holds no open
 * database handle, so the collaboration fence requires this independent
 * statement instead of inferring the absence of handles from empty rows.
 */
export type CutoverAttestation = {
  repoKey: string;
  mode: "local" | "mirror";
  controlRoot: string;
  sourceStoreId: string;
  sourceEpoch: number;
  schemaVersion: number;
  stoppedHandles: CutoverStoppedHandle[];
  /**
   * The operator's explicit assertion that EVERY process, host, CLI and
   * consumer that could hold the combined store is stopped. This is an operator
   * statement: this slice has no OS-level handle inventory, so the fence cannot
   * derive it from rows or from the handle list alone.
   */
  allHandlesStopped: true;
};

/**
 * The operator attestation of the barrier. Only these fields are ever
 * recorded: an undeclared field (a token, a credential, a session secret)
 * refuses the attestation instead of travelling into the receipt. `cutover` is
 * an optional, separately validated block that only a collaboration cutover
 * requires; every existing activation path keeps the document it already sends.
 */
export type ActivationAttestation = {
  version: number;
  attestedAt: string;
  operator: { actor: string; authorizationRef: string };
  consumers: InstalledConsumerAttestation[];
  stoppedSessions: StoppedSessionAttestation[];
  cutover?: CutoverAttestation;
};

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/**
 * The execution half of a backup's recorded identity (primary spec §8): the
 * execution authority protocol/state/root revision/manifest identity read from
 * the COPY itself. `null` means the copied store predates migration 4, so the
 * copy carries no execution authority at all — an execution migration that
 * requires a recovery point refuses it rather than treating absence as legacy.
 */
export type BackupExecutionMeta = {
  protocolVersion: number;
  authorityState: ExecutionAuthorityState;
  revision: number;
  rootUpdatedAt: string;
  manifestId: string | null;
  activatedAt: string | null;
};

/** A consistent `VACUUM INTO` copy of the store, with its recorded identity. */
export type BackupReceipt = {
  receiptVersion: number;
  backupPath: string;
  storeId: string;
  epoch: number;
  revision: number;
  catalogRevision: number;
  authorityState: "staged" | "active";
  schemaVersion: number;
  /** The execution identity of the copy; `null` when it predates migration 4. */
  execution: BackupExecutionMeta | null;
  counts: {
    issues: number;
    occurrences: number;
    transitions: number;
    catalogEntities?: number;
    catalogLinks?: number;
    migrationReceipts: number;
  };
  /** The source still held committed, not-yet-checkpointed WAL frames when copied. */
  walPending: boolean;
  bytes: number;
  takenAt: string;
};

export type ActivationReceipt = {
  receiptVersion: number;
  receiptId: number;
  phase: "activated";
  /** True when an identical activation was already recorded (no second epoch bump). */
  replayed: boolean;
  /** Canonical hash of this activation, stored as the receipt row's manifest hash. */
  activationHash: string;
  applyReceiptId: number;
  applyManifestHash: string;
  storeId: string;
  previousEpoch: number;
  /** The live authority epoch this activation created. */
  epoch: number;
  revision: number;
  catalogRevision: number;
  attestationHash: string;
  attestation: ActivationAttestation;
  backup: BackupReceipt;
  activatedAt: string;
};

/** One retired residual register: exact bytes moved out of the live root. */
export type RetiredRegister = {
  project: string;
  relativePath: string;
  sha256: string;
  bytes: number;
  archivedPath: string;
};

/** One retired index section: the reviewed lines removed, the rest preserved. */
export type RetiredSection = {
  rootKind: CatalogRootKind;
  relativePath: string;
  header: string;
  startLine: number;
  endLine: number;
  /** SHA-256 of the whole original file at retirement time. */
  sha256: string;
  archivedPath: string;
  /** SHA-256 of the live file after only the reviewed section was removed. */
  liveSha256: string;
  preservedLines: number;
  removedLines: number;
};

export type RetirementReceipt = {
  receiptVersion: number;
  receiptId: number;
  phase: "retired";
  replayed: boolean;
  retirementHash: string;
  activationReceiptId: number;
  activationHash: string;
  storeId: string;
  epoch: number;
  archiveDir: string;
  markerPath: string;
  registers: RetiredRegister[];
  sections: RetiredSection[];
  /** True when a recorded ledger from an earlier attempt was resumed to the end. */
  resumed: boolean;
  retiredAt: string;
};

/** The authority generation a consumer handle binds to (§5 `store.stale-epoch`). */
export type StoreAuthorityHandle = { storeId: string; epoch: number };

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** SHA-256 of raw bytes — the only correctness token used for source bytes. */
function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readIfExists(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

function scalar(db: StoreDb, sql: string): number {
  const row = db.prepare(sql).get() as { n?: unknown } | undefined;
  return typeof row?.n === "number" ? row.n : 0;
}

/** Atomic text write: same-dir temp + rename, so a reader never sees a partial file. */
function writeTextAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

type LiveMeta = {
  storeId: string;
  authorityState: "staged" | "active";
  epoch: number;
  revision: number;
  catalogRevision: number;
};

function readMetaRow(db: StoreDb): LiveMeta {
  const row = readStoreAuthority(db);
  if (
    typeof row.storeId !== "string" ||
    (row.authorityState !== "staged" && row.authorityState !== "active") ||
    typeof row.epoch !== "number" ||
    typeof row.revision !== "number" ||
    typeof row.catalogRevision !== "number"
  ) {
    throw new StoreError("store.corrupt", "store_meta is missing or malformed; the authority generation cannot be verified");
  }
  return {
    storeId: row.storeId,
    authorityState: row.authorityState,
    epoch: row.epoch,
    revision: row.revision,
    catalogRevision: row.catalogRevision,
  };
}

/** Applied schema version, verified contiguous (a gap is corruption, §2). */
function schemaVersionOf(db: StoreDb): number {
  const max = scalar(db, "select max(version) as n from schema_version");
  const applied = scalar(db, "select count(*) as n from schema_version");
  if (max < 1 || applied !== max) {
    throw new StoreError(
      "store.schema-drift",
      "applied schema versions are not contiguous; the store cannot be backed up or activated",
    );
  }
  return max;
}

function countsOf(db: StoreDb): BackupReceipt["counts"] {
  const tables = tableNamesOn(db);
  const countOf = (table: string): number => (tables.has(table) ? scalar(db, `select count(*) as n from ${table}`) : 0);
  // A fenced store no longer holds the moved collaboration tables, so a copied
  // image of it is complete without them: absence is zero rows of that domain
  // here, never a corrupt store.
  const counts: BackupReceipt["counts"] = {
    issues: countOf("issues"),
    occurrences: countOf("occurrences"),
    transitions: countOf("issue_transitions"),
    migrationReceipts: countOf("migration_receipts"),
  };
  if (tables.has("catalog_entities")) counts.catalogEntities = countOf("catalog_entities");
  if (tables.has("catalog_links")) counts.catalogLinks = countOf("catalog_links");
  return counts;
}

/** The migration that introduced the execution authority (never a magic number). */
const EXECUTION_MIGRATION_VERSION =
  MIGRATIONS.find((migration) => migration.name === "execution-authority")?.version ?? Number.POSITIVE_INFINITY;

/**
 * The execution identity of a COPY (§8 "read metadata from the backup
 * itself"), read directly like every other fact `inspectBackup` establishes:
 * the store-open boundary resolves exactly `<root>/store.db`, so a
 * `VACUUM INTO` copy can only be read by opening it here.
 *
 * The recorded migration set decides whether the copy has an execution
 * authority at all: below migration 4 it has none (`null` — absence is
 * disclosed, never treated as `legacy`), and at or above it the singleton must
 * exist and be well formed, because a copy that records the migration without
 * its schema is not a verified recovery point.
 */
function readExecutionMetaOfCopy(db: StoreDb, schemaVersion: number): BackupExecutionMeta | null {
  if (schemaVersion < EXECUTION_MIGRATION_VERSION) return null;
  const row = db
    .prepare(
      "select protocol_version, authority_state, revision, root_updated_at, manifest_id, activated_at " +
        "from execution_meta where id = 1",
    )
    .get() as Record<string, unknown> | undefined;
  if (
    !row ||
    typeof row.protocol_version !== "number" ||
    (row.authority_state !== "legacy" && row.authority_state !== "staged" && row.authority_state !== "active") ||
    typeof row.revision !== "number" ||
    typeof row.root_updated_at !== "string" ||
    (row.manifest_id !== null && row.manifest_id !== undefined && typeof row.manifest_id !== "string") ||
    (row.activated_at !== null && row.activated_at !== undefined && typeof row.activated_at !== "string")
  ) {
    throw new StoreActivationError(
      "store.activation-stale",
      `the copy records migration ${EXECUTION_MIGRATION_VERSION} (execution-authority) but its execution metadata is ` +
        `missing or malformed; the copy cannot be verified as an execution-bearing recovery point.`,
    );
  }
  return {
    protocolVersion: row.protocol_version,
    authorityState: row.authority_state,
    revision: row.revision,
    rootUpdatedAt: row.root_updated_at,
    manifestId: (row.manifest_id as string | null | undefined) ?? null,
    activatedAt: (row.activated_at as string | null | undefined) ?? null,
  };
}

/** The execution identity a live store holds (the same six fields as the copy). */
function liveExecutionMeta(meta: ExecutionMeta | null): BackupExecutionMeta | null {
  if (meta === null) return null;
  return {
    protocolVersion: meta.protocolVersion,
    authorityState: meta.authorityState,
    revision: meta.revision,
    rootUpdatedAt: meta.rootUpdatedAt,
    manifestId: meta.manifestId,
    activatedAt: meta.activatedAt,
  };
}

/** Two execution identities describe the same authority state. */
function sameExecution(a: BackupExecutionMeta | null, b: BackupExecutionMeta | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.protocolVersion === b.protocolVersion &&
    a.authorityState === b.authorityState &&
    a.revision === b.revision &&
    a.rootUpdatedAt === b.rootUpdatedAt &&
    a.manifestId === b.manifestId &&
    a.activatedAt === b.activatedAt
  );
}

/**
 * Canonicalize a path: the nearest EXISTING ancestor is resolved through
 * `realpathSync` and the remaining segments are re-joined. A symlinked
 * ancestor (macOS `/var` → `/private/var`, a linked workspace) must never turn
 * one authorized root into two spellings, and a candidate that itself resolves
 * outside through a link still refuses containment. Source/witness paths and
 * containment verdicts are recorded in this form, so a component that resolves
 * the same root by a different lexical route can never produce a false
 * mismatch.
 */
export function canonicalPath(value: string): string {
  let current = resolve(value);
  const trailing: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...[...trailing].reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(value);
      trailing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * §4.3 root containment: is `candidate` inside the authorized `root`?
 * Canonical prefixes only, so `/root-evil` is never inside `/root` and a
 * symlinked ancestor is not a second root. Used by the migration/backup
 * destinations and by source discovery, which must both stay under the control
 * root.
 */
export function isPathWithin(root: string, candidate: string): boolean {
  const parent = canonicalPath(root);
  const child = canonicalPath(candidate);
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

// ---------------------------------------------------------------------------
// Authority generation guard — a resumed stale handle refuses (§5)
// ---------------------------------------------------------------------------

/**
 * The ONE generation rule, used by the consumer guard and by retirement: a
 * handle/receipt from an earlier authority generation can never act on the
 * live store.
 */
function refuseUnlessSameGeneration(live: StoreAuthorityHandle, expected: StoreAuthorityHandle, what: string): void {
  if (live.storeId !== expected.storeId) {
    throw new StoreActivationError(
      "store.activation-stale",
      `${what} belongs to store_id ${expected.storeId}, but the live store is ${live.storeId}; ` +
        `re-resolve the control root and re-attest. Nothing was changed.`,
    );
  }
  if (live.epoch !== expected.epoch) {
    throw new StoreActivationError(
      "store.stale-epoch",
      `${what} belongs to authority epoch ${expected.epoch}, but the live store is epoch ${live.epoch}; the generation it ` +
        `was admitted under has been superseded. Resume with the current activation receipt. Nothing was changed.`,
    );
  }
}

/** The live authority generation, read-only. */
export async function currentAuthorityHandle(context: StoreContext): Promise<StoreAuthorityHandle> {
  const handle = await openStore(context, "read");
  try {
    const meta = readMetaRow(handle.db);
    return { storeId: meta.storeId, epoch: meta.epoch };
  } finally {
    handle.close();
  }
}

/**
 * Guard a resume: a handle captured before a barrier must refuse once the
 * authority generation has advanced. A stale consumer can never write (or
 * retire) against the generation it was admitted under.
 */
export async function assertAuthorityCurrent(context: StoreContext, handle: StoreAuthorityHandle): Promise<void> {
  refuseUnlessSameGeneration(await currentAuthorityHandle(context), handle, "the handle");
}

/**
 * §7 — the recovery-point contract of this module.
 *
 * A whole-store SQLite copy IS the backup: `VACUUM INTO` produces one
 * independent, transactionally consistent image of every authority domain the
 * store owns. The file-native ledgers and documents beside the store (notes,
 * agent-flow history, cursors, the launch journal, the selection snapshot) are
 * ordinary retained files — process evidence, never a second transactionally
 * frozen authority — so a recovery point neither freezes, checkpoints nor
 * requires them, and a SQLite image does not roll their bytes back.
 */

/** The verification view of a backup: what the copy says about itself (§8). */
export type BackupInspection = {
  storeId: string;
  authorityState: "staged" | "active";
  epoch: number;
  revision: number;
  catalogRevision: number;
  schemaVersion: number;
  execution: BackupExecutionMeta | null;
  counts: BackupReceipt["counts"];
};

/**
 * §8 "re-open it for `integrity_check` + `foreign_key_check`": the copy has to
 * be self-consistent SQLite before it is evidence for anything. A copy whose
 * page structure SQLite itself rejects, or one that holds rows violating the
 * schema's own foreign keys, is refused whatever its metadata rows claim —
 * otherwise a truncated or hand-assembled file could present a plausible
 * `store_meta` and be treated as a recovery point.
 */
function assertCopyIsConsistent(db: StoreDb, backupPath: string): void {
  const integrity = (db.prepare("pragma integrity_check").all() as Array<Record<string, unknown>>).map((row) =>
    String(Object.values(row)[0] ?? ""),
  );
  if (integrity.length !== 1 || integrity[0] !== "ok") {
    throw new StoreActivationError(
      "store.activation-stale",
      `the copy at ${backupPath} fails SQLite integrity_check ` +
        `(${integrity.slice(0, 3).join("; ") || "no result"}); it is not a verified recovery point.`,
    );
  }
  const violations = db.prepare("pragma foreign_key_check").all() as Array<Record<string, unknown>>;
  if (violations.length > 0) {
    throw new StoreActivationError(
      "store.activation-stale",
      `the copy at ${backupPath} holds ${violations.length} row(s) violating the schema's foreign keys ` +
        `(first: ${JSON.stringify(violations[0])}); it is not a verified recovery point.`,
    );
  }
}

/**
 * §8 "schema/migration checksums": the copy must record exactly THIS build's
 * immutable migration prefix — the same version ids, in the same order. A copy
 * recording a migration this engine does not have was written by a newer build
 * (it is "too new" to be read or installed here), and neither is accepted, so
 * `store_id` equality alone can never make a foreign or future file look like
 * this store's recovery point. The recorded `name`/`checksum` columns are
 * provenance: "same version id, different SQL" is a build mismatch caught by
 * CI, not a runtime gate.
 */
function assertCopySchemaIsThisBuild(db: StoreDb, backupPath: string): void {
  const rows = db
    .prepare("select version from schema_version order by version")
    .all() as Array<Record<string, unknown>>;
  if (rows.length === 0) {
    throw new StoreActivationError(
      "store.activation-stale",
      `the copy at ${backupPath} records no applied migration; it is not a store this build can verify.`,
    );
  }
  if (rows.length > MIGRATIONS.length) {
    throw new StoreActivationError(
      "store.activation-stale",
      `the copy at ${backupPath} records migration ${String(rows[rows.length - 1]?.version)}, which this build does not ` +
        `have (it knows ${MIGRATIONS.length}); the copy was written by a newer build and is not a recovery point for this one.`,
    );
  }
  for (const [index, row] of rows.entries()) {
    const migration = MIGRATIONS[index]!;
    if (row.version !== migration.version) {
      throw new StoreActivationError(
        "store.activation-stale",
        `the copy at ${backupPath} records migration ${String(row.version)} at position ${index + 1}, not this build's ` +
          `${migration.version}; the copy is not this build's store.`,
      );
    }
  }
}

/**
 * A `VACUUM INTO` copy is not at `<root>/store.db`, so the store-open boundary
 * (which resolves exactly that path) cannot read it. Open the copy directly,
 * read-only and capability-checked, exactly like every other store access.
 *
 * The driver is acquired through a function-scoped `createRequire`: contract §2
 * requires lazy, capability-checked SQLite acquisition at store access — a
 * top-level import would acquire the driver whenever the engine package is
 * imported, and a literal `import("node:…")` specifier would make a bundled
 * dist emit the CJS interop banner at module scope (issue #491).
 *
 * Exported as `inspectBackupCopy` because the restore protocol reads the same
 * verdict: §8's recovery point acceptance is ONE rule (identity, schema and
 * migration checksums, execution identity, row counts, `integrity_check` and
 * `foreign_key_check`), not a second copy of it in the recovery module.
 */
export async function inspectBackupCopy(backupPath: string): Promise<BackupInspection> {
  assertStoreRuntimeSupported();
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => StoreDb;
  };
  const db = new DatabaseSync(backupPath, { readOnly: true });
  try {
    db.exec("pragma query_only=ON");
    assertCopyIsConsistent(db, backupPath);
    assertCopySchemaIsThisBuild(db, backupPath);
    const schemaVersion = schemaVersionOf(db);
    return {
      ...readMetaRow(db),
      schemaVersion,
      // §8: the execution protocol/state/root revision/manifest identity is
      // read from the COPY itself, so the receipt never claims execution
      // readiness the copy does not carry.
      execution: readExecutionMetaOfCopy(db, schemaVersion),
      counts: countsOf(db),
    };
  } finally {
    db.close();
  }
}

function sameCounts(a: BackupReceipt["counts"], b: BackupReceipt["counts"]): boolean {
  const keys = Object.keys(a) as Array<keyof BackupReceipt["counts"]>;
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  );
}

/** Default backup path under the resolved control root (never a cwd-local path). */
function defaultBackupPath(context: StoreContext, meta: LiveMeta, label?: string): string {
  const name = label === undefined ? `${meta.storeId.slice(0, 8)}-e${meta.epoch}-r${meta.revision}.db` : `${label}.db`;
  return join(dirname(storeDbPath(context)), "archived", "store-migration", "backups", name);
}

/**
 * Take (or, for the activation resume path, re-verify) one consistent backup.
 *
 * The copy is ONE native `VACUUM INTO` statement on the live store's own
 * connection — never inside a transaction, never a rename, and without any
 * frozen or quiesced window — so it is one committed generation of the store
 * whatever a concurrent writer commits before or after it. Every fact the
 * receipt records is then read from the image itself (`inspectBackupCopy`):
 * identity, epoch, revision, catalog revision, authority state, schema
 * version, execution identity and row counts. A differently timed live read or
 * row-count snapshot is never compared against the copy, so a real concurrent
 * writer can neither make a coherent copy falsely mismatched nor make the
 * receipt describe a generation the bytes do not hold.
 */
async function takeVerifiedBackup(
  context: StoreContext,
  options: { out?: string; label?: string; reuseMatchingIdentity: boolean },
): Promise<BackupReceipt> {
  const dbPath = storeDbPath(context);
  const handle = await openStore(context, "write");
  try {
    const meta = readMetaRow(handle.db);
    let walPending = false;
    try {
      walPending = statSync(`${dbPath}-wal`).size > 0;
    } catch {
      walPending = false;
    }
    const targetPath = options.out === undefined ? defaultBackupPath(context, meta, options.label) : resolve(options.out);
    if (existsSync(targetPath)) {
      if (!options.reuseMatchingIdentity) {
        throw new StoreActivationError(
          "store.activation-stale",
          `a backup already exists at ${targetPath}; pass --out <path> for a different target instead of overwriting a ` +
            `recorded recovery point.`,
        );
      }
      // Activation resume: the point at the deterministic pre-activation path
      // is re-verified as THIS staged authority generation's. Activation runs
      // only on an attested QUIESCED store, so the staged identity the caller
      // resumed is the one stable identity this comparison may read live.
      const existing = await inspectBackupCopy(targetPath).catch((error: unknown) => {
        throw new StoreActivationError(
          "store.activation-stale",
          `the existing backup at ${targetPath} cannot be verified (${(error as Error).message}). Refusing to overwrite a ` +
            `recorded recovery point.`,
        );
      });
      const execution = liveExecutionMeta(handle.execution);
      if (
        existing.storeId !== meta.storeId ||
        existing.epoch !== meta.epoch ||
        existing.revision !== meta.revision ||
        existing.catalogRevision !== meta.catalogRevision ||
        existing.authorityState !== meta.authorityState ||
        existing.schemaVersion !== schemaVersionOf(handle.db) ||
        !sameExecution(existing.execution, execution)
      ) {
        throw new StoreActivationError(
          "store.activation-stale",
          `the existing backup at ${targetPath} does not describe this store (identity/epoch/revision/schema/execution mismatch). ` +
            `Refusing to overwrite a recorded recovery point.`,
        );
      }
      return {
        receiptVersion: BACKUP_RECEIPT_VERSION,
        backupPath: targetPath,
        ...existing,
        walPending,
        bytes: statSync(targetPath).size,
        takenAt: new Date().toISOString(),
      };
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    handle.db.prepare("vacuum into ?").run(targetPath);
    const verified = await inspectBackupCopy(targetPath).catch((error: unknown) => {
      rmSync(targetPath, { force: true });
      throw new StoreActivationError(
        "store.activation-stale",
        `the backup written to ${targetPath} could not be reopened for verification (${(error as Error).message}); ` +
          `the unverified copy was removed. Nothing was activated.`,
      );
    });
    // Same-store: `store_id` is written once at store creation and no writer,
    // upgrade or restore changes it, so it is the one live fact a fresh copy is
    // checked against — never a mutable generation or row-count snapshot.
    if (verified.storeId !== meta.storeId) {
      rmSync(targetPath, { force: true });
      throw new StoreActivationError(
        "store.activation-stale",
        `the backup written to ${targetPath} describes store ${verified.storeId}, not the live store ${meta.storeId}; ` +
          `the unverified copy was removed. Nothing was activated.`,
      );
    }
    return {
      receiptVersion: BACKUP_RECEIPT_VERSION,
      backupPath: targetPath,
      ...verified,
      walPending,
      bytes: statSync(targetPath).size,
      takenAt: new Date().toISOString(),
    };
  } finally {
    handle.close();
  }
}

/**
 * `backupStore` — the explicit recovery-point verb. A consistent `VACUUM INTO`
 * copy of the whole store that records, from the copy itself, the store
 * identity (store_id, epoch, revision, catalog revision, authority state,
 * schema version), the execution identity and the row counts it verified. It
 * takes no filesystem mutex and freezes no process log: SQLite's own snapshot
 * is the whole concurrency story, and the file-native ledgers beside the store
 * are ordinary retained files a database image does not roll back.
 */
export async function backupStore(context: StoreContext, options: { out?: string } = {}): Promise<BackupReceipt> {
  return takeVerifiedBackup(context, { out: options.out, reuseMatchingIdentity: false });
}

// ---------------------------------------------------------------------------
// Repository backup pair and scoped collaboration restore (§Backup/Restore)
// ---------------------------------------------------------------------------

/**
 * One verified image of the collaboration lane. Every fact comes from the copy
 * itself, exactly like the execution half: identity, state, epoch, both
 * revisions and the row counts the image was verified to hold.
 */
export type CollaborationBackupImage = Readonly<{
  path: string;
  authority: CollaborationAuthority;
  takenAt: string;
  counts: Readonly<Record<string, number>>;
}>;

/**
 * The verified pair one `store backup` publishes. A single image is never
 * called a repository backup: both domains are copied, verified against their
 * own bytes, and only then named together by this receipt and its manifest.
 */
export type RepositoryBackupReceipt = Readonly<{
  version: 1;
  manifestPath: string;
  execution: BackupReceipt;
  collaboration: CollaborationBackupImage;
}>;

/** The row counts one collaboration image records, in table-name order. */
type CollaborationCounts = Readonly<Record<string, number>>;

type CollaborationImageInspection = Readonly<{
  authority: CollaborationAuthority;
  counts: CollaborationCounts;
  /** Every recorded operation row: kind, execution store/epoch and receipt revision. */
  operations: readonly Readonly<{
    keySpace: string;
    operationId: string;
    executionStoreId: string | null;
    executionEpoch: number | null;
  }>[];
}>;

/** The cutover's single claim slot: a pending activation, never a restore state. */
const COLLABORATION_CLAIM_KEY = "collaboration-cutover-claim";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The one refusal of an unverifiable pair: one image, generation or boundary. */
function incompletePair(detail: string): StoreError {
  return new StoreError("collaboration.backup-incomplete", `${detail} Nothing was written.`);
}

/** Canonical JSON (sorted keys) — the identity comparison a manifest round-trip needs. */
function canonicalJsonOf(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonOf).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonOf(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Re-open ONE collaboration image and verify it as this build's complete
 * collaboration store: consistent SQLite, the closed table/column inventory,
 * a contiguous schema ledger, the singleton metadata and its row counts. Every
 * fact is read from the copy, so a truncated, hand-assembled or foreign image
 * cannot borrow the receipt's identity.
 */
async function inspectCollaborationImage(path: string, expected: Readonly<{ repoKey: string; mode: CollaborationMode }>): Promise<CollaborationImageInspection> {
  assertStoreRuntimeSupported();
  if (!existsSync(path)) throw incompletePair(`The collaboration image ${path} is missing.`);
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (p: string, options?: { readOnly?: boolean }) => StoreDb;
  };
  let db: StoreDb;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    throw incompletePair(`The collaboration image ${path} cannot be opened (${messageOf(error)}).`);
  }
  try {
    db.exec("pragma query_only=ON");
    const integrity = (db.prepare("pragma integrity_check").all() as Array<Record<string, unknown>>)
      .map((row) => String(Object.values(row)[0] ?? ""));
    if (integrity.length !== 1 || integrity[0] !== "ok") {
      throw incompletePair(
        `The collaboration image ${path} fails SQLite integrity_check (${integrity.slice(0, 3).join("; ") || "no result"}).`,
      );
    }
    const violations = db.prepare("pragma foreign_key_check").all() as Array<Record<string, unknown>>;
    if (violations.length > 0) {
      throw incompletePair(`The collaboration image ${path} holds ${violations.length} row(s) violating its foreign keys.`);
    }
    const tables = tableNamesOn(db);
    for (const [table, columns] of Object.entries(COLLABORATION_COLUMNS)) {
      if (!tables.has(table)) {
        throw incompletePair(`The collaboration image ${path} is missing the collaboration table ${table}.`);
      }
      const present = new Set(
        (db.prepare(`pragma table_info(${table})`).all() as Array<{ name?: unknown }>).map((row) => String(row.name)),
      );
      const missing = columns.filter((column) => !present.has(column));
      if (missing.length > 0) {
        throw incompletePair(
          `The collaboration image ${path} table ${table} is missing the column(s) ${missing.join(", ")}.`,
        );
      }
    }
    const maxVersion = scalar(db, "select max(version) as n from schema_version");
    const applied = scalar(db, "select count(*) as n from schema_version");
    if (maxVersion < 1 || applied !== maxVersion) {
      throw incompletePair(`The collaboration image ${path} records a non-contiguous schema ledger.`);
    }
    const meta = db
      .prepare(
        "select repository_key, mode, store_id, authority_state, authority_epoch, revision, catalog_revision " +
          "from collaboration_meta where id = 1",
      )
      .get() as Record<string, unknown> | undefined;
    if (
      meta === undefined ||
      typeof meta.repository_key !== "string" ||
      (meta.mode !== "local" && meta.mode !== "mirror") ||
      typeof meta.store_id !== "string" ||
      (meta.authority_state !== "staged" && meta.authority_state !== "active") ||
      typeof meta.authority_epoch !== "number" ||
      typeof meta.revision !== "number" ||
      typeof meta.catalog_revision !== "number"
    ) {
      throw incompletePair(`The collaboration image ${path} records no readable collaboration_meta singleton.`);
    }
    if (meta.repository_key !== expected.repoKey || meta.mode !== expected.mode) {
      throw new StoreError(
        "collaboration.stale-binding",
        `The collaboration image ${path} belongs to repository ${meta.repository_key} (${String(meta.mode)}), not to this ` +
          `checkout's ${expected.repoKey} (${expected.mode}). A verified image of another repository never restores here; ` +
          `run the recovery from a checkout of that repository. Nothing was written.`,
      );
    }
    const counts: Record<string, number> = {};
    for (const table of Object.keys(COLLABORATION_COLUMNS)) counts[table] = scalar(db, `select count(*) as n from ${table}`);
    const operations = (
      db
        .prepare("select key_space, operation_id, execution_store_id, execution_epoch from collaboration_operations order by operation_id")
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      keySpace: String(row.key_space),
      operationId: String(row.operation_id),
      executionStoreId: typeof row.execution_store_id === "string" ? row.execution_store_id : null,
      executionEpoch: typeof row.execution_epoch === "number" ? row.execution_epoch : null,
    }));
    return {
      authority: {
        repoKey: meta.repository_key,
        mode: meta.mode,
        storeId: meta.store_id,
        epoch: meta.authority_epoch,
        state: meta.authority_state,
        schemaVersion: maxVersion,
        revision: meta.revision,
        catalogRevision: meta.catalog_revision,
      },
      counts,
      operations,
    };
  } catch (error) {
    // A driver-level failure (not a database, a locked or truncated image) is
    // the same unverifiable-image refusal as a wrong identity: the pair is not
    // evidence.
    if (error instanceof StoreError) throw error;
    throw incompletePair(`The collaboration image ${path} is not a readable collaboration store (${messageOf(error)}).`);
  } finally {
    db.close();
  }
}

/** The live collaboration authority this checkout must use, leaving it untouched. */
async function liveCollaborationAuthority(context: StoreContext): Promise<CollaborationAuthority> {
  const handle = await openCollaborationStore(context, "read");
  handle.close();
  return handle.authority;
}

/**
 * The execution half of the pair's own outstanding work: an accepted composite
 * whose execution finalization has not committed. A pair must never be offered
 * while one exists, because the two images would freeze opposite halves of it.
 */
function assertNoOutstandingComposite(handle: { db: StoreDb }): void {
  const tables = tableNamesOn(handle.db);
  if (!tables.has("execution_collaboration_intents")) return;
  const pending = handle.db
    .prepare("select operation_id from execution_collaboration_intents where phase = 'prepared' order by operation_id")
    .all() as Array<{ operation_id?: unknown }>;
  if (pending.length > 0) {
    throw incompletePair(
      `This execution root holds ${pending.length} accepted composite operation(s) that are still pending ` +
        `(${pending.map((row) => String(row.operation_id)).join(", ")}). Settle each with its own domain verb first, then ` +
        `take the pair against a quiescent root.`,
    );
  }
}

/**
 * `backupRepositoryStores` — the verified PAIR.
 *
 * Both domains are copied with their own SQLite snapshot (`VACUUM INTO`), each
 * copy is re-opened and verified against its own bytes, and both authorities
 * must hold the SAME generation before and after the two copies. Only then is
 * the manifest published, create-only, naming the two verified images. A
 * changed authority, an unverifiable image or a pending composite is reported
 * as `collaboration.backup-incomplete` with nothing named as a backup.
 */
export async function backupRepositoryStores(
  context: StoreContext,
  options: { out: string },
): Promise<RepositoryBackupReceipt> {
  if (typeof options?.out !== "string" || options.out.trim() === "") {
    throw incompletePair("A repository backup needs the absolute manifest path it publishes (--out <abs-manifest>).");
  }
  const manifestPath = resolve(options.out);
  if (existsSync(manifestPath)) {
    throw incompletePair(
      `A repository backup manifest already exists at ${manifestPath}; pass --out <path> naming a new destination instead of ` +
        `overwriting a recorded recovery point.`,
    );
  }
  const executionImagePath = `${manifestPath}.execution.db`;
  const collaborationImagePath = `${manifestPath}.collaboration.db`;
  for (const imagePath of [executionImagePath, collaborationImagePath]) {
    if (existsSync(imagePath)) {
      throw incompletePair(
        `A file already exists at ${imagePath}; a pair is published create-only and never overwrites a recorded recovery ` +
          `point. Pass --out <path> naming a new destination.`,
      );
    }
  }
  const location = resolveCollaborationLocation(context);

  // Both authorities' generation BEFORE either copy: a pair is only coherent
  // when both domains held one generation across the whole window.
  const executionBefore = await openStore(context, "read").then((handle) => {
    try {
      const meta = readMetaRow(handle.db);
      assertNoOutstandingComposite(handle);
      return meta;
    } finally {
      handle.close();
    }
  });
  const collaborationBefore = await liveCollaborationAuthority(context);
  if (collaborationBefore.state !== "active") {
    throw incompletePair(
      `The collaboration authority at ${location.dbPath} is ${collaborationBefore.state}; a repository pair is taken of the ` +
        `ACTIVE authority only. Publish it with its own activation first.`,
    );
  }

  let execution: BackupReceipt | undefined;
  let collaborationInspection: CollaborationImageInspection | undefined;
  try {
    execution = await backupStore(context, { out: executionImagePath });
    await writeCollaborationImage(location.dbPath, collaborationImagePath);
    collaborationInspection = await inspectCollaborationImage(collaborationImagePath, location).catch((error: unknown) => {
      throw error instanceof StoreError ? error : incompletePair(`The collaboration image could not be verified (${messageOf(error)}).`);
    });

    const executionAfter = await openStore(context, "read").then((handle) => {
      try {
        return readMetaRow(handle.db);
      } finally {
        handle.close();
      }
    });
    const collaborationAfter = await liveCollaborationAuthority(context).catch((error: unknown) => {
      throw incompletePair(`The collaboration authority changed during the copy and cannot be re-read (${messageOf(error)}).`);
    });
    if (
      executionBefore.storeId !== executionAfter.storeId ||
      executionBefore.epoch !== executionAfter.epoch ||
      executionBefore.revision !== executionAfter.revision ||
      executionBefore.catalogRevision !== executionAfter.catalogRevision
    ) {
      throw incompletePair(
        `The execution authority advanced while the pair was copied (revision ${executionBefore.revision} -> ` +
          `${executionAfter.revision}); a pair is only published against one stable generation. Stop the writers and retry.`,
      );
    }
    if (collaborationAfter.storeId !== collaborationBefore.storeId || collaborationAfter.epoch !== collaborationBefore.epoch) {
      throw incompletePair(
        `The collaboration authority changed generation while the pair was copied (${collaborationBefore.storeId} epoch ` +
          `${collaborationBefore.epoch} -> ${collaborationAfter.storeId} epoch ${collaborationAfter.epoch}). Stop the writers and retry.`,
      );
    }
    if (collaborationInspection.authority.revision !== collaborationAfter.revision) {
      // Both copies are individually coherent, but the collaboration image is
      // not the generation the pair claims: retry against a quiescent lane.
      throw incompletePair(
        `The collaboration image holds revision ${collaborationInspection.authority.revision} while the live authority is at ` +
          `${collaborationAfter.revision}; the pair does not describe one generation. Stop the writers and retry.`,
      );
    }
  } catch (error) {
    // No partial layout is ever published: a failed pair removes only the two
    // images this attempt created.
    rmSync(executionImagePath, { force: true });
    rmSync(collaborationImagePath, { force: true });
    rmSync(`${executionImagePath}-wal`, { force: true });
    rmSync(`${executionImagePath}-shm`, { force: true });
    throw error;
  }

  const collaborationImage: CollaborationBackupImage = {
    path: collaborationImagePath,
    authority: collaborationInspection.authority,
    takenAt: new Date().toISOString(),
    counts: collaborationInspection.counts,
  };
  const receipt: RepositoryBackupReceipt = {
    version: 1,
    manifestPath,
    execution: execution!,
    collaboration: collaborationImage,
  };
  try {
    publishTextCreateOnly(manifestPath, `${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    rmSync(executionImagePath, { force: true });
    rmSync(collaborationImagePath, { force: true });
    throw error instanceof StoreError
      ? error
      : incompletePair(`The manifest could not be published at ${manifestPath} (${messageOf(error)}).`);
  }
  return receipt;
}

/** One `VACUUM INTO` copy of the collaboration lane (the one-image primitive). */
async function writeCollaborationImage(dbPath: string, out: string): Promise<void> {
  mkdirSync(dirname(out), { recursive: true });
  const source = await connect(dbPath, "write", busyTimeoutMs(), { keepJournalMode: true, noCreate: true }).catch((error: unknown) => {
    throw incompletePair(`The collaboration authority at ${dbPath} cannot be read for a copy (${messageOf(error)}).`);
  });
  try {
    source.prepare("vacuum into ?").run(out);
  } catch (error) {
    throw incompletePair(`The collaboration image could not be written to ${out} (${messageOf(error)}).`);
  } finally {
    source.close();
  }
}

/**
 * Publish one text file create-only: the bytes are written under a private name
 * first, so a crash leaves inert scratch and the canonical manifest is either
 * complete or absent.
 */
function publishTextCreateOnly(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, text, "utf8");
    linkSync(tmp, path);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw incompletePair(`A repository backup manifest already exists at ${path}.`);
    }
    throw error;
  } finally {
    rmSync(tmp, { force: true });
  }
  syncDirectoryEntry(dirname(path));
}

/**
 * `restoreCollaborationBackup` — the scoped collaboration restore.
 *
 * It validates BOTH images of the supplied pair (and the manifest they were
 * published under), the repository/mode they belong to, and the causal
 * boundary between the two generations; then it stages a private copy, bumps
 * the restored authority's epoch, records the restore receipt in the same
 * transaction and publishes the canonical path create-only. An absent target is
 * the only admitted destination: a live, corrupt or foreign collaboration
 * authority is never overwritten, quarantined or deleted. Execution sessions,
 * leases and rows are neither copied nor changed.
 */
export async function restoreCollaborationBackup(
  context: StoreContext,
  receipt: RepositoryBackupReceipt,
  options: { operator: string; attestation: ActivationAttestation },
): Promise<CollaborationAuthority> {
  const supplied = requireRepositoryBackupReceipt(receipt);
  const location = resolveCollaborationLocation(context);

  // The manifest is the published authority for the pair: the supplied receipt
  // must BE it, so a caller cannot recombine two verified images by hand.
  let manifestText: string;
  try {
    manifestText = readFileSync(supplied.manifestPath, "utf8");
  } catch (error) {
    throw incompletePair(`The backup manifest ${supplied.manifestPath} cannot be read (${messageOf(error)}).`);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText) as unknown;
  } catch {
    throw incompletePair(`The backup manifest ${supplied.manifestPath} is not readable JSON.`);
  }
  if (canonicalJsonOf(manifest) !== canonicalJsonOf(supplied)) {
    throw incompletePair(
      `The supplied receipt is not the manifest published at ${supplied.manifestPath}; supply the verified pair's own ` +
        `manifest rather than images assembled by hand.`,
    );
  }

  const executionCopy = await inspectBackupCopy(supplied.execution.backupPath).catch((error: unknown) => {
    throw incompletePair(`The execution image ${supplied.execution.backupPath} cannot be verified (${messageOf(error)}).`);
  });
  if (
    executionCopy.storeId !== supplied.execution.storeId ||
    executionCopy.epoch !== supplied.execution.epoch ||
    executionCopy.revision !== supplied.execution.revision ||
    executionCopy.catalogRevision !== supplied.execution.catalogRevision ||
    executionCopy.schemaVersion !== supplied.execution.schemaVersion ||
    executionCopy.authorityState !== supplied.execution.authorityState ||
    !sameCounts(executionCopy.counts, supplied.execution.counts)
  ) {
    throw incompletePair(
      `The execution image at ${supplied.execution.backupPath} does not describe the generation the manifest records.`,
    );
  }
  const collaborationInspection = await inspectCollaborationImage(supplied.collaboration.path, location);
  const recorded = supplied.collaboration.authority;
  if (
    collaborationInspection.authority.storeId !== recorded.storeId ||
    collaborationInspection.authority.epoch !== recorded.epoch ||
    collaborationInspection.authority.revision !== recorded.revision ||
    collaborationInspection.authority.catalogRevision !== recorded.catalogRevision ||
    collaborationInspection.authority.state !== recorded.state ||
    canonicalJsonOf(collaborationInspection.counts) !== canonicalJsonOf(supplied.collaboration.counts)
  ) {
    throw incompletePair(
      `The collaboration image at ${supplied.collaboration.path} does not describe the generation the manifest records.`,
    );
  }
  assertCausalBoundary(supplied, collaborationInspection, executionCopy);

  const attestation = validateActivationAttestation(options?.attestation);
  const operator = options?.operator;
  if (typeof operator !== "string" || operator.trim() === "") {
    throw new StoreError(
      "store.attestation-invalid",
      "A collaboration restore requires the named operator (--operator <name>); it is recorded as the approving actor.",
    );
  }
  if (attestation.operator.actor !== operator) {
    throw new StoreError(
      "store.attestation-invalid",
      `The attestation names operator ${attestation.operator.actor}, not ${operator}. Attest this restore under the operator ` +
        `who actually approved it; nothing was restored.`,
    );
  }

  const dbPath = location.dbPath;
  if (existsSync(dbPath)) {
    throw new StoreError(
      "collaboration.cutover-conflict",
      `A collaboration authority already exists at ${dbPath}. A restore is create-only: it never overwrites, quarantines or ` +
        `deletes a live, staged or corrupt authority. Inspect the existing authority with "mstar path resolve", move it aside ` +
        `only through an explicit operator action after reconciliation, then restore into the absent target. Nothing was written.`,
    );
  }

  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stagingDir = join(dir, `.restore-${process.pid}-${randomUUID()}`);
  const stagingPath = join(stagingDir, basename(dbPath));
  try {
    mkdirSync(stagingDir, { mode: 0o700 });
  } catch (error) {
    throw incompletePair(`A private staging directory could not be created beside ${dbPath} (${messageOf(error)}).`);
  }
  let staged = false;
  try {
    copyFileSync(supplied.collaboration.path, stagingPath);
    chmodSync(stagingPath, 0o600);
    const stagedInspection = await inspectCollaborationImage(stagingPath, location);
    if (canonicalJsonOf(stagedInspection.counts) !== canonicalJsonOf(collaborationInspection.counts)) {
      throw incompletePair(`The staged copy of ${supplied.collaboration.path} does not hold the verified rows.`);
    }
    const imageSha = sha256Bytes(readFileSync(stagingPath));
    const restoredAt = nowRfc3339();
    const nextEpoch = recorded.epoch + 1;
    const db = await connect(stagingPath, "write", busyTimeoutMs(), { keepJournalMode: true });
    try {
      db.exec("begin immediate");
      try {
        const flipped = db
          .prepare(
            "update collaboration_meta set authority_state = 'active', authority_epoch = ?, activated_at = ? " +
              "where id = 1 and store_id = ? and repository_key = ? and mode = ? and authority_epoch = ?",
          )
          .run(nextEpoch, restoredAt, recorded.storeId, location.repoKey, location.mode, recorded.epoch) as { changes?: number };
        if (Number(flipped?.changes) !== 1) {
          throw incompletePair(
            `The verified collaboration image changed between its inspection and the restore transaction (identity, ` +
              `repository, mode or epoch no longer match).`,
          );
        }
        db.prepare(
          "insert into collaboration_operations(key_space, operation_id, request_hash, result_json, committed_at) " +
            "values ('standalone', ?, ?, ?, ?)",
        ).run(
          `restore:${nextEpoch}:${imageSha}`,
          imageSha,
          JSON.stringify({
            version: 1,
            imagePath: supplied.collaboration.path,
            imageSha256: imageSha,
            restoredFrom: { storeId: recorded.storeId, epoch: recorded.epoch, revision: recorded.revision },
            authority: { storeId: recorded.storeId, epoch: nextEpoch, repoKey: location.repoKey, mode: location.mode },
            operator,
            executionImage: { path: supplied.execution.backupPath, storeId: supplied.execution.storeId, epoch: supplied.execution.epoch },
            restoredAt,
          }),
          restoredAt,
        );
        db.exec("commit");
      } catch (error) {
        try {
          db.exec("rollback");
        } catch {
          // nothing committed either way
        }
        throw error;
      }
      // One self-contained file: the published name is not a journal alias.
      const folded = db.prepare("pragma journal_mode=delete").get() as { journal_mode?: string } | undefined;
      if (folded?.journal_mode !== "delete") {
        throw incompletePair(`The restored image could not be folded into one database file (${String(folded?.journal_mode ?? "unknown")}).`);
      }
    } finally {
      db.close();
    }
    try {
      linkSync(stagingPath, dbPath);
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        throw new StoreError(
          "collaboration.cutover-conflict",
          `A collaboration authority appeared at ${dbPath} while this restore was staging; it is never overwritten. ` +
            `Inspect the existing authority and retry only against an absent target.`,
        );
      }
      throw incompletePair(`The restored image could not be published at ${dbPath} (${messageOf(error)}).`);
    }
    staged = true;
    syncDirectoryEntry(dir);
  } finally {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${stagingPath}${suffix}`, { force: true });
    try {
      rmdirSync(stagingDir);
    } catch {
      // an empty private staging directory is inert scratch
    }
  }
  if (!staged) throw incompletePair(`The restore did not publish ${dbPath}.`);
  return readCollaborationAuthority(context);
}

/** The receipt shape a restore accepts: the pair's own manifest fields, nothing inferred. */
function requireRepositoryBackupReceipt(value: unknown): RepositoryBackupReceipt {
  const bad = (detail: string): never => {
    throw incompletePair(`The supplied repository backup receipt is not usable: ${detail}.`);
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) bad("it is not an object");
  const receipt = value as Record<string, unknown>;
  if (receipt.version !== 1) bad(`its version is ${JSON.stringify(receipt.version)}, not this build's 1`);
  const manifestPath = receipt.manifestPath;
  if (typeof manifestPath !== "string" || manifestPath.trim() === "") bad("it names no manifest path");
  const execution = receipt.execution;
  if (
    execution === null ||
    typeof execution !== "object" ||
    typeof (execution as Record<string, unknown>).backupPath !== "string" ||
    typeof (execution as Record<string, unknown>).storeId !== "string"
  ) {
    bad("it carries no execution image receipt");
  }
  const collaboration = receipt.collaboration;
  if (collaboration === null || typeof collaboration !== "object") bad("it carries no collaboration image");
  const image = collaboration as Record<string, unknown>;
  if (typeof image.path !== "string" || image.authority === null || typeof image.authority !== "object") {
    bad("its collaboration image names no verified authority");
  }
  if (image.counts === null || typeof image.counts !== "object" || Array.isArray(image.counts)) {
    bad("its collaboration image records no row counts");
  }
  return value as RepositoryBackupReceipt;
}

/**
 * The causal boundary of one pair: the collaboration receipts only ever name an
 * execution generation at or before the paired execution image, and neither
 * side may be frozen mid-operation.
 */
function assertCausalBoundary(
  receipt: RepositoryBackupReceipt,
  collaboration: CollaborationImageInspection,
  execution: BackupInspection,
): void {
  const claim = collaboration.operations.find((row) => row.keySpace === "standalone" && row.operationId === COLLABORATION_CLAIM_KEY);
  if (claim !== undefined) {
    throw incompletePair(
      "The collaboration image holds a pending cutover claim, so it was frozen mid-activation. Resume or abandon that " +
        "activation before taking a pair.",
    );
  }
  for (const row of collaboration.operations) {
    if (row.keySpace !== "composite") continue;
    if (row.executionStoreId !== execution.storeId) {
      throw incompletePair(
        `The collaboration image records a composite effect for execution store ${String(row.executionStoreId)}, not for the ` +
          `paired execution store ${execution.storeId}; the two images are not one repository's generation.`,
      );
    }
    if (row.executionEpoch !== null && row.executionEpoch > execution.epoch) {
      throw incompletePair(
        `The collaboration image records a composite effect from execution epoch ${row.executionEpoch}, which is AHEAD of the ` +
          `paired execution image's epoch ${execution.epoch}; the pair is out of causal order.`,
      );
    }
  }
  void receipt;
}

/**
 * `ensureCollaborationAuthority` — the fresh/file-era bootstrap.
 *
 * A checkout whose combined store provably holds no collaboration rows (or no
 * store at all) gets its repository's collaboration authority from here:
 * `initializeCollaborationStore` creates it create-only or reuses the matching
 * record WITHOUT clearing it, and a freshly created empty staged lane is
 * published as this scope's first active generation. A lane that recorded any
 * staging evidence belongs to a cutover or register import and is never
 * published by a bootstrap. A combined source that still owns collaboration rows
 * is not a fresh scope: it directs to the reviewed cutover.
 */
export async function ensureCollaborationAuthority(context: StoreContext): Promise<CollaborationAuthority> {
  const location = resolveCollaborationLocation(context);
  if (existsSync(storeDbPath(context))) {
    const handle = await openStore(context, "read");
    try {
      const fence = readCollaborationFence(handle.db);
      if (fence === null) {
        const tables = tableNamesOn(handle.db);
        const held = ["issues", "occurrences", "issue_transitions", "provenance", "catalog_entities", "catalog_links"].filter(
          (table) => tables.has(table) && scalar(handle.db, `select count(*) as n from ${table}`) > 0,
        );
        if (held.length > 0) {
          throw new StoreError(
            "collaboration.cutover-required",
            `The combined store at ${storeDbPath(context)} still owns collaboration rows (${held.join(", ")}); it is not a ` +
              `fresh scope. Move that authority with the reviewed cutover: mstar store collaboration plan, apply, then ` +
              `activate. Nothing was created or changed.`,
          );
        }
      }
    } finally {
      handle.close();
    }
  }
  const authority = await initializeCollaborationStore(location);
  if (authority.state === "active") return authority;
  return writeCollaborationStage(location, ({ db, authority: current }) => {
    if (current.state === "active") return current;
    const evidence =
      scalar(db, "select count(*) as n from cutover_publications") +
      scalar(db, "select count(*) as n from collaboration_operations") +
      current.revision +
      current.catalogRevision;
    if (evidence !== 0) {
      throw new StoreError(
        "collaboration.not-active",
        `The collaboration authority at ${location.dbPath} is staged and holds recorded staging evidence, so it belongs to a ` +
          `reviewed activation (a cutover or a file-era register import). Publish it with that activation \u2014 ` +
          `mstar store collaboration activate --manifest <path> --operator <name> \u2014 instead of treating it as a fresh scope. ` +
          `Nothing was written.`,
      );
    }
    const at = nowRfc3339();
    const flipped = db
      .prepare(
        "update collaboration_meta set authority_state = 'active', activated_at = ? " +
          "where id = 1 and authority_state = 'staged' and store_id = ? and authority_epoch = ? and revision = 0 and catalog_revision = 0",
      )
      .run(at, current.storeId, current.epoch) as { changes?: number };
    if (Number(flipped?.changes) !== 1) {
      throw new StoreError(
        "collaboration.not-active",
        `The staged collaboration authority at ${location.dbPath} changed while it was being published; inspect it with ` +
          `mstar path resolve before retrying. Nothing was written.`,
      );
    }
    return { ...current, state: "active" as const };
  });
}


/** The reviewed authority a recovery point has to belong to (primary spec §6 item 2). */
export type ReviewedBackupAuthority = {
  storeId: string;
  epoch: number;
  schemaVersion: number;
  catalogRevision: number;
};

/**
 * Re-verify a recovery-point receipt for a first-write step that must be
 * gated on a consistent backup — the execution migration's staged apply is
 * that caller (§6 item 2, §8).
 *
 * Three things are checked and none of them is taken on trust:
 *
 * 1. the receipt's shape, and that its destination is inside the authorized
 *    control root (§4.3 — a migration recovery point never lives outside the
 *    root it protects);
 * 2. the COPY behind it, reopened read-only: identity, epoch, revision,
 *    catalog revision, issue/catalog authority state, schema version, row
 *    counts and the execution protocol/state/root-revision/manifest identity
 *    must all equal what the receipt claims, so the receipt is never a
 *    credential for bytes that changed under it;
 * 3. the RECEIPT must belong to the reviewed authority the caller names
 *    (store identity, epoch, schema version and catalog revision) and the live
 *    store must still hold the same ISSUE/CATALOG row counts and authority
 *    state, so issue/catalog work committed after the point refuses.
 *
 * What it deliberately does NOT compare is the live root `revision` or the
 * live execution state: the step being gated *is* the one that advances them.
 * A re-apply of an already-staged manifest therefore passes this gate without a
 * fresh backup — the rollback point a no-write replay needs is the one it was
 * staged under.
 */
export async function assertBackupDescribesStore(
  context: StoreContext,
  receipt: BackupReceipt,
  reviewed: ReviewedBackupAuthority,
): Promise<void> {
  const stale = (detail: string): never => {
    throw new StoreActivationError("store.activation-stale", detail);
  };
  if (
    !receipt ||
    (receipt.receiptVersion !== ACTIVATION_PROTOCOL_VERSION && receipt.receiptVersion !== BACKUP_RECEIPT_VERSION) ||
    typeof receipt.backupPath !== "string" ||
    receipt.backupPath.trim() === ""
  ) {
    stale(
      "the supplied recovery point is not a backup receipt of this protocol version; take one with `backupStore` and " +
        "apply the manifest that names it.",
    );
  }
  const controlRoot = dirname(storeDbPath(context));
  if (!isPathWithin(controlRoot, receipt.backupPath)) {
    stale(
      `the recovery point ${receipt.backupPath} is outside the authorized control root ${controlRoot}; a migration ` +
        `recovery point must live inside the root it protects.`,
    );
  }
  // §8: "copying `store.db` bytes is not a backup". The point of this gate is an
  // INDEPENDENT SQLite copy (`VACUUM INTO`) that can roll the store back, so the
  // live database and its WAL/SHM sidecars are refused as their own recovery
  // point even when the fields they carry happen to match the receipt.
  const liveStore = canonicalPath(storeDbPath(context));
  const candidate = canonicalPath(receipt.backupPath);
  if (candidate === liveStore || candidate === `${liveStore}-wal` || candidate === `${liveStore}-shm`) {
    stale(
      `the recovery point ${receipt.backupPath} names the live store database (${liveStore}), not an independent copy. ` +
        `A migration recovery point must be taken with \`backupStore\` (SQLite \`VACUUM INTO\`); the live database and its ` +
        `WAL/SHM sidecars cannot be their own recovery point.`,
    );
  }
  if (
    receipt.storeId !== reviewed.storeId ||
    receipt.epoch !== reviewed.epoch ||
    receipt.schemaVersion !== reviewed.schemaVersion ||
    receipt.catalogRevision !== reviewed.catalogRevision
  ) {
    stale(
      `the recovery point ${receipt.backupPath} belongs to store ${receipt.storeId} epoch ${receipt.epoch} schema ` +
        `${receipt.schemaVersion} catalog revision ${receipt.catalogRevision}, not to the reviewed authority ` +
        `${reviewed.storeId} epoch ${reviewed.epoch} schema ${reviewed.schemaVersion} catalog revision ` +
        `${reviewed.catalogRevision}; take a recovery point of the reviewed authority.`,
    );
  }
  let copy: BackupInspection;
  try {
    copy = await inspectBackupCopy(receipt.backupPath);
  } catch (error) {
    throw new StoreActivationError(
      "store.activation-stale",
      `the recovery point ${receipt.backupPath} cannot be reopened for verification (${(error as Error).message}).`,
    );
  }
  if (
    copy.storeId !== receipt.storeId ||
    copy.epoch !== receipt.epoch ||
    copy.revision !== receipt.revision ||
    copy.catalogRevision !== receipt.catalogRevision ||
    copy.authorityState !== receipt.authorityState ||
    copy.schemaVersion !== receipt.schemaVersion ||
    !sameExecution(copy.execution, receipt.execution ?? null) ||
    !sameCounts(copy.counts, receipt.counts)
  ) {
    stale(
      `the copy at ${receipt.backupPath} does not match the receipt recorded for it; the receipt is not evidence for ` +
        `these bytes, so it is not a verified recovery point.`,
    );
  }
  const handle = await openStore(context, "read");
  try {
    const meta = readMetaRow(handle.db);
    const counts = countsOf(handle.db);
    if (meta.authorityState !== receipt.authorityState || !sameCounts(counts, receipt.counts)) {
      stale(
        `the recovery point ${receipt.backupPath} no longer describes the live issue/catalog authority ` +
          `(${meta.authorityState}, ${counts.issues} issue(s) / ${counts.catalogEntities} catalog entit(ies) live). ` +
          `Issue/catalog work committed after the point would be silently outside its coverage; take a fresh backup.`,
      );
    }
  } finally {
    handle.close();
  }
}

// ---------------------------------------------------------------------------
// Attestation validation — strict, credential-free, floor-checked
// ---------------------------------------------------------------------------

export const CONSUMER_KINDS: Record<AttestationConsumerKind, true> = { cli: true, "host-plugin": true, hook: true, coordinator: true };
export const DISPOSITIONS: Record<AttestationDisposition, true> = {
  reloaded: true,
  upgraded: true,
  "excluded:not-this-control-root": true,
  "excluded:no-store-access": true,
  "excluded:superseded-binary": true,
};
export const SESSION_STATES: Record<"stopped" | "reloaded", true> = { stopped: true, reloaded: true };
export const CUTOVER_HANDLE_KINDS: Record<CutoverStoppedHandle["kind"], true> = {
  process: true,
  session: true,
  host: true,
  consumer: true,
};

/**
 * Two refusal families, as contract §7 distinguishes them.
 *
 * `store.attestation-invalid` is an attestation DOCUMENT that cannot be used at
 * all: a wrong version, a missing/ill-typed field, a contradictory claim (two
 * current coordinators), or an undeclared field such as a session credential.
 * `store.activation-blocked` is §7's documented stop — "if exclusion or
 * required restart/re-entry proof is incomplete, stop with
 * `store.activation-blocked`; legacy remains sole authority" — for readiness
 * that is documented but incomplete: no attested consumer, a consumer below the
 * runtime floor or left running/unattested, no current coordinator, or a
 * session that was never quiesced. Both refuse before a byte is written, so
 * legacy remains sole authority either way; they stay distinct because the
 * operator remedy differs (fix the barrier vs. fix the document).
 */
function attestationRefusal(message: string): never {
  throw new StoreActivationError("store.attestation-invalid", message);
}

/** §7's stop for exclusion / restart-re-entry proof that is incomplete. */
function activationBlocked(message: string): never {
  throw new StoreActivationError("store.activation-blocked", message);
}

function attestationObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) attestationRefusal(`${what} must be an object`);
  return value as Record<string, unknown>;
}

/**
 * Only the declared fields are ever accepted. An undeclared field is refused
 * by name, so a session credential cannot ride into the activation receipt on
 * an extra key.
 */
function attestationKeys(object: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      attestationRefusal(
        `${what} declares an undeclared field "${key}"; the attestation records only installed entrypoints/versions, ` +
          `quiesced sessions, the approving operator and (for a collaboration cutover) the cutover scope \u2014 never ` +
          `session credentials or other data.`,
      );
    }
  }
}

function attestationString(object: Record<string, unknown>, key: string, what: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.trim() === "") attestationRefusal(`${what}.${key} must be a nonblank string`);
  return value;
}

/**
 * The optional cutover block, validated with the same strictness as the rest of
 * the document. It is never inferred: an operator that omits it, names another
 * root or source generation, or claims no stopped handle at all gets a refusal
 * rather than a fence.
 */
function cutoverAttestation(raw: unknown): CutoverAttestation {
  const what = "the attestation.cutover";
  const block = attestationObject(raw, what);
  attestationKeys(
    block,
    ["repoKey", "mode", "controlRoot", "sourceStoreId", "sourceEpoch", "schemaVersion", "stoppedHandles", "allHandlesStopped"],
    what,
  );
  const mode = block.mode;
  if (mode !== "local" && mode !== "mirror") attestationRefusal(`${what}.mode must be "local" or "mirror"`);
  const positive = (key: "sourceEpoch" | "schemaVersion"): number => {
    const value = block[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      attestationRefusal(`${what}.${key} must be a positive integer`);
    }
    return value;
  };
  if (!Array.isArray(block.stoppedHandles) || block.stoppedHandles.length === 0) {
    attestationRefusal(
      `${what}.stoppedHandles must name at least one stopped handle; an empty list is not evidence that no old process ` +
        `holds the store`,
    );
  }
  const stoppedHandles = block.stoppedHandles.map((entry: unknown, index: number): CutoverStoppedHandle => {
    const handleWhat = `${what}.stoppedHandles[${index}]`;
    const handle = attestationObject(entry, handleWhat);
    attestationKeys(handle, ["kind", "id"], handleWhat);
    const kind = handle.kind;
    if (typeof kind !== "string" || !Object.hasOwn(CUTOVER_HANDLE_KINDS, kind)) {
      attestationRefusal(`${handleWhat}.kind must be one of ${Object.keys(CUTOVER_HANDLE_KINDS).join(", ")}`);
    }
    return { kind: kind as CutoverStoppedHandle["kind"], id: attestationString(handle, "id", handleWhat) };
  });
  if (block.allHandlesStopped !== true) {
    attestationRefusal(
      `${what}.allHandlesStopped must be the literal true: the operator asserts that EVERY process, host, CLI and ` +
        `consumer that could hold the combined store is stopped, and the fence cannot be undone`,
    );
  }
  return {
    repoKey: attestationString(block, "repoKey", what),
    mode,
    controlRoot: attestationString(block, "controlRoot", what),
    sourceStoreId: attestationString(block, "sourceStoreId", what),
    sourceEpoch: positive("sourceEpoch"),
    schemaVersion: positive("schemaVersion"),
    stoppedHandles,
    allHandlesStopped: true,
  };
}

/** The fields every attestation declares: the protocol version, its instant and the approving operator. */
function attestationHeader(raw: Record<string, unknown>): {
  attestedAt: string;
  operator: { actor: string; authorizationRef: string };
} {
  if (raw.version !== ACTIVATION_PROTOCOL_VERSION) {
    attestationRefusal(`the attestation version must be ${ACTIVATION_PROTOCOL_VERSION}`);
  }
  const attestedAt = attestationString(raw, "attestedAt", "the attestation");
  if (!Number.isFinite(Date.parse(attestedAt))) attestationRefusal("the attestation.attestedAt must be an ISO/RFC3339 instant");

  const operator = attestationObject(raw.operator, "the attestation.operator");
  attestationKeys(operator, ["actor", "authorizationRef"], "the attestation.operator");
  return {
    attestedAt,
    operator: {
      actor: attestationString(operator, "actor", "the attestation.operator"),
      authorizationRef: attestationString(operator, "authorizationRef", "the attestation.operator"),
    },
  };
}

/** The quiesced sessions of an attestation: only a stopped/reloaded one is admissible. */
function stoppedSessionsOf(raw: Record<string, unknown>): StoppedSessionAttestation[] {
  if (!Array.isArray(raw.stoppedSessions)) attestationRefusal("the attestation.stoppedSessions must be an array (possibly empty)");
  return raw.stoppedSessions.map((entry, index) => {
    const what = `the attestation.stoppedSessions[${index}]`;
    const session = attestationObject(entry, what);
    attestationKeys(session, ["sessionId", "host", "state"], what);
    const state = session.state;
    if (typeof state !== "string" || !Object.hasOwn(SESSION_STATES, state)) {
      activationBlocked(`${what}.state must be "stopped" or "reloaded"; a running or queued session is not quiesced and stops the barrier`);
    }
    return {
      sessionId: attestationString(session, "sessionId", what),
      host: attestationString(session, "host", what),
      state: state as "stopped" | "reloaded",
    };
  });
}

/**
 * Validate one attestation and project it onto the declared shape. Missing
 * consumer or current-coordinator attestation, a below-floor consumer, a
 * session that was never stopped and any credential-bearing field all refuse
 * here — before a byte is written.
 */
export function validateActivationAttestation(value: unknown): ActivationAttestation {
  const raw = attestationObject(value, "the attestation");
  attestationKeys(raw, ["version", "attestedAt", "operator", "consumers", "stoppedSessions", "cutover"], "the attestation");
  const { attestedAt, operator } = attestationHeader(raw);

  if (!Array.isArray(raw.consumers)) attestationRefusal("the attestation.consumers must be an array");
  if (raw.consumers.length === 0) {
    activationBlocked(
      "the attestation must attest at least one installed consumer (entrypoint, version and disposition); a merely merged " +
        "source tree is not installed-consumer readiness",
    );
  }
  const consumers: InstalledConsumerAttestation[] = raw.consumers.map((entry, index) => {
    const what = `the attestation.consumers[${index}]`;
    const consumer = attestationObject(entry, what);
    attestationKeys(
      consumer,
      ["entryId", "kind", "entrypoint", "runtime", "runtimeVersion", "version", "current", "disposition"],
      what,
    );
    const kind = consumer.kind;
    if (typeof kind !== "string" || !Object.hasOwn(CONSUMER_KINDS, kind)) {
      attestationRefusal(`${what}.kind must be one of ${Object.keys(CONSUMER_KINDS).join(", ")}`);
    }
    const runtime = consumer.runtime;
    if (runtime !== "node") {
      attestationRefusal(
        `${what}.runtime must be "node" (got ${JSON.stringify(runtime)}); a consumer is an installed entrypoint that opens the store, ` +
          "and Bun is this project's development toolchain, not a runtime a consumer runs on. Attest the Node entrypoint that opens the store",
      );
    }
    const entryId = attestationString(consumer, "entryId", what);
    const runtimeVersion = attestationString(consumer, "runtimeVersion", what);
    // `bun` consumers carry no version gate (Bun is a development toolchain);
    // a Node consumer's floor is the declared one, read from the manifest.
    // The floor is the whole point of this check, and every host that embeds this
    // engine ships a manifest that declares it: an unresolvable floor is refused
    // rather than passed, so no consumer can be attested without the comparison.
    const floor = readDeclaredNodeFloor();
    if (floor === null) {
      attestationRefusal(
        `${what} cannot be checked for runtime compatibility: no visible manifest declares engines.node (run this from an installed CLI or a full checkout, ` +
          "not from a copied bundle), so the consumer's Node version cannot be compared against the floor",
      );
    }
    if (compareVersions(runtimeVersion, floor) < 0) {
      activationBlocked(
        `${what} (${entryId}) reports ${runtime} ${runtimeVersion}, below the ${floor} floor; an old binary is not a ` +
          `compatible consumer. Upgrade/reload it or exclude it explicitly.`,
      );
    }
    const disposition = consumer.disposition;
    if (typeof disposition !== "string" || !Object.hasOwn(DISPOSITIONS, disposition)) {
      activationBlocked(
        `${what}.disposition must be one of ${Object.keys(DISPOSITIONS).join(", ")}; a consumer left running/unattested ` +
          `stops the barrier \u2014 if a host cannot reload safely, stop at the exact user-restart step instead`,
      );
    }
    if (typeof consumer.current !== "boolean") attestationRefusal(`${what}.current must be a boolean`);
    return {
      entryId,
      kind: kind as AttestationConsumerKind,
      entrypoint: attestationString(consumer, "entrypoint", what),
      runtime,
      runtimeVersion,
      version: attestationString(consumer, "version", what),
      current: consumer.current,
      disposition: disposition as AttestationDisposition,
    };
  });
  const current = consumers.filter((consumer) => consumer.current);
  if (current.length === 0) {
    activationBlocked(
      "the attestation does not mark a current coordinator; the coordinator driving this activation must attest its own " +
        "reloaded/upgraded entry, including its queued/reused sessions",
    );
  }
  if (current.length > 1) attestationRefusal(`${current.length} consumers are marked current; exactly one current coordinator is allowed`);
  if (current[0]!.kind !== "coordinator") {
    attestationRefusal(
      `the current consumer is attested as "${current[0]!.kind}"; the current-coordinator attestation must be a coordinator entry`,
    );
  }

  if (!Array.isArray(raw.stoppedSessions)) attestationRefusal("the attestation.stoppedSessions must be an array (possibly empty)");
  const stoppedSessions = stoppedSessionsOf(raw);
  const cutover = raw.cutover === undefined ? undefined : cutoverAttestation(raw.cutover);

  return {
    version: ACTIVATION_PROTOCOL_VERSION,
    attestedAt,
    operator,
    consumers,
    stoppedSessions,
    ...(cutover === undefined ? {} : { cutover }),
  };
}

/**
 * Validate one RECOVERY-scope attestation and project it onto the declared
 * shape. Recovery replaces a crashed coordinator in an ALREADY-active store, so
 * the installed-consumer obligation of the activation barrier does not apply:
 * `consumers` is accepted and ignored when present, and the operator
 * authorization plus the attested stops are the whole document.
 */
export function validateRecoveryAttestation(value: unknown): ActivationAttestation {
  const raw = attestationObject(value, "the attestation");
  attestationKeys(raw, ["version", "attestedAt", "operator", "consumers", "stoppedSessions", "cutover"], "the attestation");
  const { attestedAt, operator } = attestationHeader(raw);
  const cutover = raw.cutover === undefined ? undefined : cutoverAttestation(raw.cutover);
  return {
    version: ACTIVATION_PROTOCOL_VERSION,
    attestedAt,
    operator,
    consumers: [],
    stoppedSessions: stoppedSessionsOf(raw),
    ...(cutover === undefined ? {} : { cutover }),
  };
}

// ---------------------------------------------------------------------------
// Source revalidation — the final hash check at the barrier
// ---------------------------------------------------------------------------

type RegisterSource = { project: string; absolutePath: string; relativePath: string };

/**
 * Enumerate the live registers through the configured project resolver — the
 * same resolver the planner uses (never a hard-coded `.mstar`, never
 * `_default` only, symlinks never followed).
 */
function currentRegisterSources(context: StoreContext): RegisterSource[] {
  const projectsRoot = catalogRootDir(context, "projects");
  let entries: Dirent[];
  try {
    entries = readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const sources: RegisterSource[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const absolutePath = join(projectsRoot, entry.name, "residuals.json");
    let info;
    try {
      info = lstatSync(absolutePath);
    } catch {
      continue; // a project directory without a register has nothing to retire
    }
    if (info.isSymbolicLink() || !info.isFile()) continue;
    sources.push({ project: entry.name, absolutePath, relativePath: `${entry.name}/residuals.json` });
  }
  return sources;
}

/**
 * Revalidate the reviewed manifest against the live sources by PATH SET: the
 * register set (an unreviewed register that appeared, a reviewed one that is
 * gone). Content drift is not a refusal — the recorded digests describe what
 * was reviewed and are never re-compared.
 */
function revalidateSources(context: StoreContext, manifest: MigrationManifest, mode: "activation" | "retirement"): void {
  const reviewed = new Set(manifest.sources.map((source) => source.relativePath));
  const retired = new Set(manifest.retirement.registers.map((register) => register.relativePath));
  const changed = (detail: string): never => {
    throw new StoreActivationError(
      mode === "activation" ? "store.migration-source-changed" : "store.legacy-write-detected",
      `${detail} ` +
        (mode === "activation"
          ? "Nothing was activated; re-run the preview, review the final manifest, apply it and re-attest."
          : "Nothing was retired; re-preview and re-apply, then resume retirement."),
    );
  };

  for (const source of currentRegisterSources(context)) {
    if (!reviewed.has(source.relativePath) && !retired.has(source.relativePath)) {
      changed(`an unreviewed legacy register appeared at ${source.relativePath}.`);
    }
  }
  for (const reviewedSource of manifest.sources) {
    const live = readIfExists(join(catalogRootDir(context, "projects"), reviewedSource.relativePath));
    // A register an earlier retirement attempt already moved is verified per
    // item against the archive instead of against the live file.
    if (live === undefined && !retired.has(reviewedSource.relativePath)) {
      changed(`register ${reviewedSource.relativePath} is gone.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Receipt rows
// ---------------------------------------------------------------------------

type ReceiptRow = {
  id: number;
  manifest_hash: string;
  manifest_json: string;
  mapping_json: string;
  source_counts_json: string;
  applied_at: string;
  activated_at: string | null;
  retired_at: string | null;
};

/** `source_counts_json` as the apply half writes it: the counts (incl. storeRevision). */
type StoredCounts = MigrationReceipt["counts"];

const RECEIPT_COLUMNS =
  "id, manifest_hash, manifest_json, mapping_json, source_counts_json, applied_at, activated_at, retired_at";

function readReceiptRows(db: StoreDb, where: string, param?: unknown): ReceiptRow[] {
  const statement = db.prepare(`select ${RECEIPT_COLUMNS} from migration_receipts where ${where} order by id`);
  return (param === undefined ? statement.all() : statement.all(param)) as ReceiptRow[];
}

/**
 * The context's CURRENT apply receipt, read-only: the last `applied` row by id.
 * `manifest` carries only the reviewed control root this manifest was signed
 * for — a real owner/scope field — never a whole-record identity. Whether that
 * receipt really is THIS manifest's, and whether the receipt belongs to this
 * store, is decided by the activation/retirement barrier from the recorded
 * `applyReceiptId`, `storeId`, `epoch` and live revision.
 */
export async function appliedReceiptFor(context: StoreContext, manifest: MigrationManifest): Promise<MigrationReceipt> {
  const handle = await openStore(context, "read");
  try {
    if (resolve(manifest.controlRoot) !== resolve(context.harnessDir)) {
      throw new StoreActivationError(
        "store.activation-stale",
        `the manifest was reviewed for control root ${manifest.controlRoot}, not ${context.harnessDir}; nothing was activated.`,
      );
    }
    const row = readReceiptRows(handle.db, "phase = 'applied'").at(-1);
    if (!row) {
      throw new StoreActivationError(
        "store.activation-stale",
        "this store has no recorded apply receipt; apply the reviewed manifest first (store migrate --apply --manifest <path>).",
      );
    }
    const storedMapping = JSON.parse(row.mapping_json) as {
      source: MigrationReceipt["issueIds"][number]["source"];
      issueId: string;
      classification?: string;
      rationale?: string | null;
      legacyJson?: string;
    }[];
    const counts = JSON.parse(row.source_counts_json) as StoredCounts;
    if (typeof counts.storeRevision !== "number") {
      throw new StoreActivationError(
        "store.activation-stale",
        "the recorded apply receipt carries no store revision; the staged store cannot be checked against the reviewed apply.",
      );
    }
    return {
      receiptId: row.id,
      manifestHash: row.manifest_hash,
      phase: "applied",
      replayed: true,
      issueIds: storedMapping
        .filter((entry) => entry.issueId !== "")
        .map((entry) => ({ source: entry.source, issueId: entry.issueId })),
      // Pre-FW-2 receipts carried issue mappings only; a receipt recorded by
      // the current apply stores history/excluded mappings beside them.
      historyRows: storedMapping
        .filter(
          (entry): entry is typeof entry & { classification: "history" | "excluded"; rationale: string; legacyJson: string } =>
            entry.issueId === "" && (entry.classification === "history" || entry.classification === "excluded"),
        )
        .map((entry) => ({
          source: entry.source,
          classification: entry.classification,
          rationale: entry.rationale ?? "",
          legacyJson: entry.legacyJson ?? "",
        })),
      counts: { ...counts, history: counts.history ?? 0, excluded: counts.excluded ?? 0, created: 0, updated: 0 },
      storeRevision: counts.storeRevision,
      appliedAt: row.applied_at,
    };
  } finally {
    handle.close();
  }
}

function activationReceiptOfRow(row: ReceiptRow, replayed: boolean): ActivationReceipt {
  const stored = JSON.parse(row.manifest_json) as Omit<ActivationReceipt, "receiptId" | "phase" | "replayed" | "activatedAt">;
  return { ...stored, receiptId: row.id, phase: "activated", replayed, activatedAt: row.activated_at ?? row.applied_at };
}

/** The recorded activation receipt of an applied manifest (§7); read-only. */
export async function activationReceiptFor(context: StoreContext, manifest: MigrationManifest): Promise<ActivationReceipt> {
  const apply = await appliedReceiptFor(context, manifest);
  const handle = await openStore(context, "read");
  try {
    const row = findActivationRow(readReceiptRows(handle.db, "phase = 'activated'"), apply.receiptId);
    if (!row) {
      throw new StoreActivationError(
        "store.activation-stale",
        `the applied receipt #${apply.receiptId} has no recorded activation; run "store activate" ` +
          `with the reviewed manifest and attestation first.`,
      );
    }
    return activationReceiptOfRow(row, true);
  } finally {
    handle.close();
  }
}

/**
 * The activation row one reviewed apply already produced, newest first: the
 * activation recorded for the apply receipt that committed this manifest. The
 * association is that receipt's own identity — the row the staged apply wrote
 * — so an activation recorded for a different manifest, or belonging to another
 * store, is never served as this manifest's activation.
 */
function findActivationRow(rows: ReceiptRow[], applyReceiptId: number): ReceiptRow | undefined {
  for (const row of [...rows].reverse()) {
    let stored: unknown;
    try {
      stored = JSON.parse(row.manifest_json);
    } catch {
      // a malformed receipt row cannot claim this activation
      continue;
    }
    if (stored === null || typeof stored !== "object" || !("applyReceiptId" in stored)) continue;
    if (typeof stored.applyReceiptId === "number" && stored.applyReceiptId === applyReceiptId) return row;
  }
  return undefined;
}

function activationHashOf(parts: {
  applyManifestHash: string;
  applyReceiptId: number;
  storeId: string;
  previousEpoch: number;
  epoch: number;
  attestationHash: string;
  backupPath: string;
}): string {
  return sha256Bytes(Buffer.from(`activation\u0000${JSON.stringify(parts)}`, "utf8"));
}

/**
 * The retirement row one activation already produced, newest first: the
 * retirement recorded FOR that activation receipt in the live authority
 * generation. The association is the receipt's own identity and the live
 * store/epoch it acted on — never `retirementHash` — so a retirement recorded
 * for another activation, store or epoch is never served as this one's.
 */
function findRetirementRow(
  rows: ReceiptRow[],
  activationReceiptId: number,
  live: { storeId: string; epoch: number },
): ReceiptRow | undefined {
  for (const row of [...rows].reverse()) {
    let stored: unknown;
    try {
      stored = JSON.parse(row.manifest_json);
    } catch {
      // a malformed receipt row cannot claim this retirement
      continue;
    }
    if (stored === null || typeof stored !== "object") continue;
    const candidate = stored as Record<string, unknown>;
    if (candidate.activationReceiptId !== activationReceiptId) continue;
    if (candidate.storeId !== live.storeId || candidate.epoch !== live.epoch) continue;
    return row;
  }
  return undefined;
}


// ---------------------------------------------------------------------------
// Activation barrier (§7)
// ---------------------------------------------------------------------------

/** The generated document's actor, or the coded refusal its preflight raises (same code, message and recovery as before the move). */
function requireGeneratedOperator(operator: string | undefined): string {
  if (operator === undefined || operator.trim() === "") {
    throw Object.assign(
      new StoreActivationError(
        "store.operator-required",
        "the activation generates its operator attestation when --attestation is omitted, and the generated document records the invoking operator; pass --operator <name> (or --attestation <absolute-json> to supply the document explicitly)",
      ),
      { recovery: "run mstar store activate --manifest <path> --operator <name> (add --attestation <absolute-json> to override the generated document)" },
    );
  }
  return operator;
}

/**
 * `activateStore(context, receipt, attestation)` — the barrier. Addresses the
 * reviewed applied receipt by its OWN recorded row identity (the apply row
 * `id`, never a manifest digest) and requires it to be the FINAL one (latest
 * applied manifest, unchanged source path set, no post-apply store change), a
 * valid attestation, and a verified consistent backup. It then flips the
 * authority state and increments the epoch atomically with the receipt row.
 */
export async function activateStore(
  context: StoreContext,
  receipt: MigrationReceipt,
  attestation?: ActivationAttestation,
  hooks: { afterStage?(stage: "flip" | "inspection" | "retirement" | "section-write", completed: number): void } = {},
  // `processFacts` is the ACCEPTED provisioning limit
  // `activation-provisioning.ts` documents at `ProvisionProcessFacts`: an
  // explicit direct-engine/test input, never evidence of an installed consumer
  // (production CLI callers omit it). It exists because a Bun-driven run
  // refuses on the generated path — Bun is never an admissible consumer — so
  // the generated success path is proven at this transaction with injected
  // facts, the same class of seam as the `hooks` above.
  // `now` is the activation transaction's own clock: one instant stamps the
  // generated document and every activation stamp below.
  options: { operator?: string; processFacts?: ProvisionProcessFacts; now?: () => string } = {},
): Promise<ActivationReceipt> {
  if (
    !receipt ||
    receipt.phase !== "applied" ||
    typeof receipt.receiptId !== "number" ||
    typeof receipt.manifestHash !== "string" ||
    typeof receipt.storeRevision !== "number"
  ) {
    throw new StoreActivationError(
      "store.activation-stale",
      "the activation requires the reviewed apply receipt (receiptId, storeRevision; manifestHash is provenance); re-apply the reviewed manifest.",
    );
  }
  // A supplied document is the 1:1 override and is validated here, before the
  // backup, exactly as before. An omitted one is generated inside the flip
  // transaction below and validated at the same point — the validator stays
  // the acceptance authority either way.
  const validated = attestation === undefined ? undefined : validateActivationAttestation(attestation);

  const inspection = await openStore(context, "write");
  let meta: LiveMeta;
  let manifest: MigrationManifest;
  try {
    meta = readMetaRow(inspection.db);
    if (meta.authorityState === "active") {
      const row = findActivationRow(readReceiptRows(inspection.db, "phase = 'activated'"), receipt.receiptId);
      if (!row) {
        throw new StoreActivationError(
          "store.activation-stale",
          "the store is already active under a different activation; the authority generation cannot be replaced by a new receipt.",
        );
      }
      const recorded = activationReceiptOfRow(row, true);
      // The recorded activation must be THIS store's, in the live authority
      // generation: store identity and epoch are real owner facts, so a copied
      // store's or a superseded epoch's activation is never replayed as this
      // one's (the recorded `activationHash` is provenance only).
      if (recorded.storeId !== meta.storeId || recorded.epoch !== meta.epoch) {
        throw new StoreActivationError(
          "store.activation-stale",
          `the recorded activation #${recorded.receiptId} belongs to store ${recorded.storeId} epoch ${recorded.epoch}, ` +
            `not this live store ${meta.storeId} epoch ${meta.epoch}; it cannot be served as this store's activation.`,
        );
      }
      return recorded;
    }

    // The applied row is addressed by the receipt's OWN recorded identity —
    // its `id` in `migration_receipts` — never by a content digest of the
    // manifest it applied. `manifest_hash` stays recorded provenance; it does
    // not select the row, veto the receipt or imply identity proof.
    const appliedRow = readReceiptRows(inspection.db, "id = ? and phase = 'applied'", receipt.receiptId)[0];
    if (!appliedRow) {
      throw new StoreActivationError(
        "store.activation-stale",
        `the supplied receipt (#${receipt.receiptId}) is not a recorded apply receipt of this store; ` +
          `re-apply the reviewed manifest and use its receipt. Nothing was activated.`,
      );
    }
    const applied = readReceiptRows(inspection.db, "phase = 'applied'");
    if (applied.at(-1)!.id !== appliedRow.id) {
      throw new StoreActivationError(
        "store.activation-stale",
        `the supplied receipt is not the FINAL applied manifest (a later apply, receipt #${applied.at(-1)!.id}, is recorded); ` +
          `revalidate the final manifest, re-apply it and re-attest. Nothing was activated.`,
      );
    }
    manifest = JSON.parse(appliedRow.manifest_json) as MigrationManifest;
    if (resolve(manifest.controlRoot) !== resolve(context.harnessDir)) {
      throw new StoreActivationError(
        "store.activation-stale",
        `the applied manifest was reviewed for control root ${manifest.controlRoot}, not ${context.harnessDir}. Nothing was activated.`,
      );
    }
    if (meta.revision !== receipt.storeRevision) {
      throw new StoreActivationError(
        "store.activation-stale",
        `the staged store is at revision ${meta.revision}, but the reviewed apply committed revision ` +
          `${receipt.storeRevision}; the staged store changed after the reviewed apply. Re-apply the final manifest first.`,
      );
    }
    // First of two: this pass refuses a missing/renamed register before the
    // recovery point is written. The decisive one runs inside the flip
    // transaction.
    revalidateSources(context, manifest, "activation");
  } finally {
    inspection.close();
  }

  // The generated document records the invoking operator, so a missing one is
  // refused HERE — before the recovery point is written — and an unoperated
  // activation never leaves an orphan backup artifact behind. Same code,
  // message and recovery the flip used to raise; the document itself is still
  // assembled inside the flip transaction below.
  const generatedOperator = validated === undefined ? requireGeneratedOperator(options.operator) : "";

  // The recovery point is taken on its own connection, after the validations
  // and before the barrier transaction: the staged store is quiesced (attested)
  // and never has two writers open at once.
  const backup = await takeVerifiedBackup(context, {
    label: `pre-activation-${meta.storeId.slice(0, 8)}-r${meta.revision}`,
    reuseMatchingIdentity: true,
  });

  // Test seam: an old binary writes a register here — after the inspection pass
  // above and before the barrier transaction below.
  hooks.afterStage?.("inspection", 0);

  const flip = await openStore(context, "write");
  try {
    // ONE instant for the whole flip: the generated document attests it and
    // every activation stamp records it.
    const at = (options.now ?? (() => new Date().toISOString()))();
    flip.db.exec("begin immediate");
    try {
      const current = readMetaRow(flip.db);
      if (current.authorityState !== "staged" || current.storeId !== meta.storeId || current.revision !== meta.revision) {
        throw new StoreActivationError(
          "store.activation-stale",
          "the staged store changed while the barrier was running; the activation was rolled back. Re-check and retry.",
        );
      }
      // Barrier-time register-set fence. The inspection pass ran on its own
      // connection and the recovery point was taken after it, so a legacy
      // writer could have landed a new register in between. Revalidate the
      // reviewed register set HERE, inside the flip transaction: the epoch never
      // bumps against a source set that no longer matches the reviewed one,
      // whatever appeared after the inspection.
      //
      // Documented trade (QC seat 3 S-001): this fence performs register-set
      // enumeration while the `begin immediate` write lock is held, so the lock
      // window scales with the register count. That is acceptable BY
      // PRECONDITION: activation runs only on a QUIESCED STAGED store — the
      // attestation validation above has stopped every registered reader/writer
      // session before this transaction opens, so no concurrent writer can be
      // starved and the in-window I/O is bounded by the reviewed source set, not
      // by contention. The fence stays in-transaction deliberately: hoisting it
      // before the lock would reopen the inspection→flip race this fence exists
      // to close. A non-quiesced caller is already refused by the attestation
      // gate; this note records the precondition so a future caller does not
      // widen the window.
      revalidateSources(context, manifest, "activation");
      // The generated operator document, assembled inside this transaction:
      // the invoking operator is the recorded actor, the reviewed apply
      // receipt is the durable authorizationRef, the clock is the same
      // instant the epoch bump is stamped with, and the stop list is exactly
      // the active rows this epoch bump invalidates (an earlier-epoch row
      // authorizes nothing afterwards). The narrowed meaning stays explicit:
      // consumers attests the EXECUTING consumer only, and stoppedSessions
      // attests row disposal, never an observed process death.
      let activationValidated = validated;
      if (activationValidated === undefined) {
        // The operator was required before the backup (preflight above); this
        // branch only runs when no document was supplied, so it is nonblank.
        const stoppedRows = flip.db
          .prepare("select session_id from execution_sessions where state = 'active' and epoch = ?")
          .all(current.epoch) as Array<{ session_id?: unknown }>;
        const provisioned = provisionActivationDocument(
          {
            actor: generatedOperator,
            authorizationRef: `migration-receipt:${receipt.receiptId}`,
            attestedAt: at,
            stoppedSessions: stoppedRows
              .filter((row) => typeof row.session_id === "string" && row.session_id !== "")
              .map((row) => ({ sessionId: row.session_id as string, host: "local", state: "stopped" as const })),
          },
          options.processFacts,
        );
        if (!provisioned.ok) {
          throw Object.assign(
            new StoreActivationError("store.attestation-invalid", provisioned.message),
            { recovery: "run the same verb through the installed Node CLI: mstar store activate --manifest <path> --operator <name> (an explicit --attestation <absolute-json> also overrides)" },
          );
        }
        activationValidated = validateActivationAttestation(provisioned.document);
      }
      const attestationHash = sha256Bytes(Buffer.from(`attestation\u0000${JSON.stringify(activationValidated)}`, "utf8"));
      const epoch = current.epoch + 1;
      const revision = current.revision + 1;
      const activationHash = activationHashOf({
        applyManifestHash: receipt.manifestHash,
        applyReceiptId: receipt.receiptId,
        storeId: current.storeId,
        previousEpoch: current.epoch,
        epoch,
        attestationHash,
        backupPath: backup.backupPath,
      });
      flip.db
        .prepare("update store_meta set authority_state = 'active', authority_epoch = ?, revision = ?, activated_at = ? where id = 1")
        .run(epoch, revision, at);
      flip.db.prepare("update migration_receipts set activated_at = ? where id = ?").run(at, receipt.receiptId);
      hooks.afterStage?.("flip", 0);
      const stored = {
        receiptVersion: ACTIVATION_PROTOCOL_VERSION,
        activationHash,
        applyReceiptId: receipt.receiptId,
        applyManifestHash: receipt.manifestHash,
        storeId: current.storeId,
        previousEpoch: current.epoch,
        epoch,
        revision,
        catalogRevision: current.catalogRevision,
        attestationHash,
        attestation: activationValidated,
        backup,
      };
      const result = flip.db
        .prepare(
          "insert into migration_receipts(manifest_hash, phase, manifest_json, mapping_json, source_counts_json, applied_at, activated_at) " +
            "values (?, 'activated', ?, '[]', ?, ?, ?)",
        )
        .run(
          activationHash,
          JSON.stringify(stored),
          JSON.stringify({ consumers: activationValidated.consumers.length, stoppedSessions: activationValidated.stoppedSessions.length }),
          at,
          at,
        );
      const receiptId = Number((result as { lastInsertRowid: number | bigint }).lastInsertRowid);
      flip.db.exec("commit");
      return { ...stored, receiptId, phase: "activated", replayed: false, activatedAt: at };
    } catch (error) {
      try {
        flip.db.exec("rollback");
      } catch {
        // nothing committed either way
      }
      throw error;
    }
  } finally {
    flip.close();
  }
}

// ---------------------------------------------------------------------------
// Retirement of the legacy sources (§7)
// ---------------------------------------------------------------------------

type LedgerRegisterItem = {
  project: string;
  relativePath: string;
  sha256: string;
  archivePath: string;
  state: "pending" | "archived" | "verified";
};

type LedgerSectionItem = {
  rootKind: CatalogRootKind;
  relativePath: string;
  header: string;
  startLine: number;
  endLine: number;
  sha256: string;
  preservedLines: number;
  /** The recognized family of the reviewed table; a row identity lives in one family only. */
  family: IndexFamily;
  /**
   * The normalized locations of the rows THIS table was reviewed to retire,
   * read from the reviewed plan's own per-section record. Identity is row-level
   * and family-scoped: a live table is retired when it still carries these rows,
   * whatever its line number or column labels.
   */
  reviewedRows: string[];
  /**
   * The reviewed locations actually excised, recorded when the rewrite
   * happened. A verified item resumes against exactly these, so a later
   * re-derivation from the reviewed span can never select another table.
   */
  retiredRows: string[] | null;
  /** Lines actually removed from the live file, as observed on the rewrite. */
  removedLines: number | null;
  archivePath: string;
  expectedLiveSha256: string | null;
  state: "pending" | "verified";
};

type RetirementLedger = {
  version: number;
  activationReceiptId: number;
  activationHash: string;
  storeId: string;
  epoch: number;
  archiveDir: string;
  successorDbPath: string;
  backupPath: string;
  startedAt: string;
  updatedAt: string;
  retirementReceiptId: number | null;
  registers: LedgerRegisterItem[];
  sections: LedgerSectionItem[];
};

/** Repository/harness-relative path segments, traversal-refused. */
function relativePathSegments(relativePath: string): string[] {
  const segments = relativePath.split(/[\\/]+/);
  if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new StoreActivationError(
      "store.migration-source-changed",
      `the catalog source path "${relativePath}" is not a safe root-relative path; nothing was retired.`,
    );
  }
  return segments;
}

function readLedger(path: string): RetirementLedger | undefined {
  const bytes = readIfExists(path);
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(bytes.toString("utf8")) as RetirementLedger;
  } catch (error) {
    throw new StoreActivationError(
      "store.activation-stale",
      `the retirement ledger at ${path} is unreadable (${(error as Error).message}); refusing to guess at partial retirement state.`,
    );
  }
}

function writeLedger(path: string, ledger: RetirementLedger): void {
  ledger.updatedAt = new Date().toISOString();
  writeJson(path, ledger);
}

function markerText(ledger: RetirementLedger, receipt: RetirementReceipt | null): string {
  return [
    `# Legacy source archive \u2014 activation receipt #${ledger.activationReceiptId}`,
    "",
    "Retired from the live control root by `mstar store retire`, after the activation barrier passed.",
    "",
    `- successor authority: \`${ledger.successorDbPath}\` (store_id \`${ledger.storeId}\`, authority epoch ${ledger.epoch})`,
    `- activation receipt: #${ledger.activationReceiptId} (\`${ledger.activationHash}\`)`,
    `- retirement receipt: ${receipt === null ? "pending" : `#${receipt.receiptId} (\`${receipt.retirementHash}\`)`}`,
    `- recovery point: \`${ledger.backupPath}\``,
    `- archived: ${ledger.registers.length} residual register(s), ${ledger.sections.length} reviewed index section(s)`,
    `- last updated: ${ledger.updatedAt}`,
    "",
    "These archived bytes are historical migration input, not a post-activation rollback path: they were the",
    "pre-activation authority and are superseded history, and restoring them would recreate a second authority.",
    "Recovery after activation uses the verified SQLite-consistent `VACUUM INTO` backup above plus reconciliation.",
    "",
    "The per-item retirement ledger (`ledger.json`, same directory) is the resumable record of exactly which",
    "bytes and sections were moved and verified.",
    "",
  ].join("\n");
}

function retirementReceiptOfRow(row: ReceiptRow, replayed: boolean): RetirementReceipt {
  const stored = JSON.parse(row.manifest_json) as Omit<RetirementReceipt, "receiptId" | "phase" | "replayed" | "retiredAt">;
  return { ...stored, receiptId: row.id, phase: "retired", replayed, retiredAt: row.retired_at ?? row.applied_at };
}

/** Write the marker disclosure; a resumed run completes a missing one. */
function finalizeDisclosure(ledgerPath: string, ledger: RetirementLedger, receipt: RetirementReceipt): void {
  writeLedger(ledgerPath, ledger);
  writeTextAtomic(join(ledger.archiveDir, "MARKER.md"), markerText(ledger, receipt));
}

/**
 * Move one register out of the live root: copy first (so the original bytes
 * exist before anything is removed), then unlink the live file. A crash between
 * the steps resumes from the ledger: the archive is the witness. The recorded
 * review digest is provenance — it is never re-compared, so a register whose
 * bytes changed since review is archived as it is now.
 */
function retireRegister(context: StoreContext, ledgerPath: string, ledger: RetirementLedger, item: LedgerRegisterItem): void {
  const livePath = join(catalogRootDir(context, "projects"), item.relativePath);
  const liveBytes = readIfExists(livePath);
  if (liveBytes !== undefined) {
    mkdirSync(dirname(item.archivePath), { recursive: true });
    rmSync(item.archivePath, { force: true });
    copyFileSync(livePath, item.archivePath);
    item.state = "archived";
    writeLedger(ledgerPath, ledger);
    unlinkSync(livePath);
  } else if (readIfExists(item.archivePath) === undefined) {
    throw new StoreActivationError(
      "store.migration-source-changed",
      `register ${item.relativePath} is gone and no archive copy exists; the reviewed source cannot be retired truthfully. ` +
        `Nothing was retired.`,
    );
  }
  item.state = "verified";
  writeLedger(ledgerPath, ledger);
}

function verifyArchivedRegister(item: LedgerRegisterItem): void {
  if (readIfExists(item.archivePath) === undefined) {
    throw new StoreActivationError(
      "store.migration-source-changed",
      `the archived register ${item.relativePath} is missing; refusing to claim retirement.`,
    );
  }
}

/**
 * The live rows of one recognized table that still match a reviewed item's
 * identities, with their line numbers. The table is read with the SAME family
 * detection and the SAME identity resolution the reviewed plan used, so an
 * equivalent spelling of a reviewed location (`guides//intro.md`,
 * `guides/./intro.md`, a backslash separator) is the same identity rather than
 * a different string.
 */
function matchedRowsIn(
  table: RawTable,
  owner: string | null,
  wanted: { family: IndexFamily; identities: Set<string> },
): { identity: string; line: number }[] {
  const family = detectIndexFamily(table.header);
  if (family === null || family !== wanted.family) return [];
  const hits: { identity: string; line: number }[] = [];
  for (const row of table.rows) {
    const identity = indexRowIdentity(family, row.cells, owner);
    if (identity !== null && wanted.identities.has(identity)) hits.push({ identity, line: row.line });
  }
  return hits;
}

/**
 * The live table one reviewed retirement item targets, chosen by REVIEWED ROW
 * IDENTITY: among the recognized tables of the item's family, the one holding
 * the most of the item's reviewed row identities. A table's line slot, its
 * header labels, the file's total length and an unreviewed row that merely
 * reuses an id or a location are never identity.
 *
 * `undefined` means none of the item's reviewed rows remains anywhere in the
 * file — an earlier attempt's rewrite, or rows never present at all.
 */
function selectReviewedSection(
  live: string,
  item: LedgerSectionItem,
): { table: RawTable; hits: { identity: string; line: number }[] } | undefined {
  const wanted = { family: item.family, identities: new Set(item.retiredRows ?? item.reviewedRows) };
  if (wanted.identities.size === 0) return undefined;
  const slash = item.relativePath.indexOf("/");
  const owner = slash === -1 ? null : item.relativePath.slice(0, slash);
  let best: { table: RawTable; hits: { identity: string; line: number }[] } | undefined;
  for (const table of readTables(live)) {
    const hits = matchedRowsIn(table, owner, wanted);
    if (hits.length === 0) continue;
    if (best === undefined || hits.length > best.hits.length) best = { table, hits };
  }
  return best;
}

/**
 * Excise one reviewed index section: archive the whole original file, then
 * rewrite the live file without the reviewed rows only.
 *
 * The target is associated by the reviewed row identities of ONE family, never
 * by a line coordinate or a header. Rows the plan did not review — including a
 * row another iteration added to the same table after review — are not the
 * reviewed identity and survive verbatim, along with their header and
 * delimiter; the whole table (header, delimiter and every row) disappears only
 * when the reviewed rows were all of it. Every kept byte is the original line,
 * so narrative, security dispositions and unrelated tables are untouched.
 *
 * The lines actually removed are recorded as observed, so no resume path ever
 * re-derives them from the reviewed span. Completion is proven by the reviewed
 * rows' absence, not by a total length or an archive.
 */
function retireSection(context: StoreContext, ledgerPath: string, ledger: RetirementLedger, item: LedgerSectionItem, hooks: { afterStage?(stage: "section-write", completed: number): void }): void {
  const livePath = join(catalogRootDir(context, item.rootKind), ...relativePathSegments(item.relativePath));
  const live = readIfExists(livePath)?.toString("utf8");
  if (live === undefined) {
    throw new StoreActivationError(
      "store.migration-source-changed",
      `catalog source ${item.rootKind}:${item.relativePath} is gone; the reviewed section cannot be retired truthfully. ` +
        `Nothing was retired.`,
    );
  }
  const selection = selectReviewedSection(live, item);
  if (selection === undefined) {
    // None of the target's reviewed rows remains (an earlier attempt's rewrite,
    // or the rows were already excised): finish from the archive witness.
    item.removedLines ??= 0;
    verifyRetiredSection(livePath, item);
    item.state = "verified";
    writeLedger(ledgerPath, ledger);
    return;
  }
  const reviewedLines = new Set(selection.hits.map((hit) => hit.line));
  const survivingRows = selection.table.rows.filter((row) => !reviewedLines.has(row.line));
  const dropped = new Set<number>();
  if (survivingRows.length === 0) {
    // The reviewed rows were the whole table: header and delimiter go with them.
    for (let line = selection.table.firstLine; line <= selection.table.lastLine; line += 1) dropped.add(line);
  } else {
    for (const line of reviewedLines) dropped.add(line);
  }
  const excised = live
    .split("\n")
    .filter((_line, index) => !dropped.has(index + 1))
    .join("\n");
  mkdirSync(dirname(item.archivePath), { recursive: true });
  rmSync(item.archivePath, { force: true });
  copyFileSync(livePath, item.archivePath);
  item.retiredRows = [...new Set(selection.hits.map((hit) => hit.identity))].sort();
  item.removedLines = dropped.size;
  item.expectedLiveSha256 = sha256Bytes(Buffer.from(excised, "utf8"));
  writeLedger(ledgerPath, ledger);
  writeTextAtomic(livePath, excised);
  item.state = "verified";
  hooks.afterStage?.("section-write", 0);
  verifyRetiredSection(livePath, item);
  writeLedger(ledgerPath, ledger);
}

function verifyRetiredSection(livePath: string, item: LedgerSectionItem): void {
  const live = readIfExists(livePath)?.toString("utf8");
  if (live === undefined) {
    throw new StoreActivationError(
      "store.migration-source-changed",
      `catalog source ${item.rootKind}:${item.relativePath} is gone; refusing to claim retirement.`,
    );
  }
  if (selectReviewedSection(live, item) !== undefined) {
    throw new StoreActivationError(
      "store.migration-source-changed",
      `catalog source ${item.rootKind}:${item.relativePath} still holds a reviewed row of the retired section; refusing to claim retirement.`,
    );
  }
  if (readIfExists(item.archivePath) === undefined) {
    throw new StoreActivationError(
      "store.migration-source-changed",
      `the archived original of ${item.relativePath} is missing; refusing to claim retirement.`,
    );
  }
}

/**
 * `retireStoreSources(context, activationReceipt)` — move the reviewed
 * sources out of the live root under a resumable per-item ledger. Revalidates
 * the live DB identity, the authority epoch, the activation receipt and the
 * register PATH SET first; a resumed attempt continues from the recorded item
 * states to complete the remaining registrations and section excisions; an
 * unexpected unreviewed register stops the transition without deleting
 * anything.
 */
export async function retireStoreSources(
  context: StoreContext,
  activationReceipt: ActivationReceipt,
  hooks: { afterStage?(stage: "retirement" | "section-write", completed: number): void } = {},
): Promise<RetirementReceipt> {
  if (
    !activationReceipt ||
    activationReceipt.phase !== "activated" ||
    typeof activationReceipt.receiptId !== "number" ||
    typeof activationReceipt.activationHash !== "string" ||
    typeof activationReceipt.storeId !== "string" ||
    typeof activationReceipt.epoch !== "number"
  ) {
    throw new StoreActivationError(
      "store.activation-stale",
      'retirement requires the recorded activation receipt (receiptId, activationHash, storeId, epoch); run "store activate" first.',
    );
  }

  const handle = await openStore(context, "write");
  try {
    const meta = readMetaRow(handle.db);
    if (meta.authorityState !== "active") {
      throw new StoreActivationError(
        "store.not-active",
        `the store is ${meta.authorityState}; legacy sources are retired only after the activation barrier made the store active. ` +
          `Nothing was retired.`,
      );
    }
    refuseUnlessSameGeneration(
      { storeId: meta.storeId, epoch: meta.epoch },
      { storeId: activationReceipt.storeId, epoch: activationReceipt.epoch },
      "the activation receipt",
    );
    // The activation row is addressed by the receipt's OWN recorded identity —
    // its `id` in `migration_receipts` — never by `activationHash`. The hash
    // stays recorded provenance; it does not select the row, veto the receipt
    // or imply identity proof. The real constraints are read from the row and
    // checked against the live store below.
    const activationRow = readReceiptRows(handle.db, "id = ? and phase = 'activated'", activationReceipt.receiptId)[0];
    if (!activationRow) {
      throw new StoreActivationError(
        "store.activation-stale",
        `no activation receipt #${activationReceipt.receiptId} is recorded for this store; nothing was retired.`,
      );
    }
    const activationRowReceipt = activationReceiptOfRow(activationRow, true);
    if (
      activationRowReceipt.storeId !== meta.storeId ||
      activationRowReceipt.epoch !== meta.epoch ||
      activationRowReceipt.applyReceiptId !== activationReceipt.applyReceiptId
    ) {
      throw new StoreActivationError(
        "store.activation-stale",
        `the recorded activation #${activationReceipt.receiptId} belongs to store ${activationRowReceipt.storeId} epoch ` +
          `${activationRowReceipt.epoch} over apply receipt #${activationRowReceipt.applyReceiptId}, not this store ` +
          `${meta.storeId} epoch ${meta.epoch} over apply receipt #${activationReceipt.applyReceiptId}; nothing was retired.`,
      );
    }
    const appliedRow = readReceiptRows(handle.db, "id = ? and phase = 'applied'", activationReceipt.applyReceiptId)[0];
    if (!appliedRow) {
      throw new StoreActivationError(
        "store.activation-stale",
        `the applied receipt #${activationReceipt.applyReceiptId} behind this activation is missing; nothing was retired.`,
      );
    }
    const manifest = JSON.parse(appliedRow.manifest_json) as MigrationManifest;

    const registers = manifest.retirement.registers;
    const sections = manifest.catalog.retirementSections;
    const archiveDir = join(dirname(storeDbPath(context)), "archived", "store-migration", String(activationReceipt.receiptId));
    const ledgerPath = join(archiveDir, "ledger.json");
    const retirementHash = sha256Bytes(
      Buffer.from(
        `retirement\u0000${JSON.stringify({
          activationReceiptId: activationReceipt.receiptId,
          activationHash: activationReceipt.activationHash,
          storeId: meta.storeId,
          epoch: meta.epoch,
          registers: registers.map((register) => ({ relativePath: register.relativePath, sha256: register.sha256 })),
          sections: sections.map((section) => ({
            rootKind: section.rootKind,
            relativePath: section.relativePath,
            startLine: section.startLine,
            endLine: section.endLine,
            sha256: section.sha256,
          })),
        })}`,
        "utf8",
      ),
    );

    const recorded = findRetirementRow(readReceiptRows(handle.db, "phase = 'retired'"), activationReceipt.receiptId, meta);
    if (recorded) {
      const receipt = retirementReceiptOfRow(recorded, true);
      const existing = readLedger(ledgerPath);
      if (existing) finalizeDisclosure(ledgerPath, existing, receipt);
      return receipt;
    }

    const existingLedger = readLedger(ledgerPath);
    if (existingLedger && (existingLedger.storeId !== meta.storeId || existingLedger.epoch !== meta.epoch)) {
      throw new StoreActivationError(
        "store.activation-stale",
        `the retirement ledger at ${ledgerPath} belongs to a different activation generation; refusing to resume another ` +
          `generation's partial retirement. Nothing was retired.`,
      );
    }
    revalidateSources(context, manifest, "retirement");
    const resumed = existingLedger !== undefined;

    const ledger: RetirementLedger = existingLedger ?? {
      version: ACTIVATION_PROTOCOL_VERSION,
      activationReceiptId: activationReceipt.receiptId,
      activationHash: activationReceipt.activationHash,
      storeId: meta.storeId,
      epoch: meta.epoch,
      archiveDir,
      successorDbPath: storeDbPath(context),
      backupPath: activationReceipt.backup.backupPath,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      retirementReceiptId: null,
      registers: registers
        .map((register) => ({
          project: register.project,
          relativePath: register.relativePath,
          sha256: register.sha256,
          archivePath: join(archiveDir, "registers", ...relativePathSegments(register.relativePath)),
          state: "pending" as const,
        }))
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
      sections: sections
        .map((section) => ({
          rootKind: section.rootKind,
          relativePath: section.relativePath,
          header: section.header,
          startLine: section.startLine,
          endLine: section.endLine,
          sha256: section.sha256,
          preservedLines: section.preservedLines,
          family: section.family,
          reviewedRows: section.rows,
          retiredRows: null,
          removedLines: null,
          archivePath: join(archiveDir, "index-sections", section.rootKind, ...relativePathSegments(section.relativePath)),
          expectedLiveSha256: null,
          state: "pending" as const,
        }))
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.startLine - b.startLine),
    };
    // The reviewed row identities are always current: they are read from the
    // reviewed plan in hand (the same manifest the generation/epoch already
    // binds this run to), never from a stale recorded copy.
    for (const item of ledger.sections) {
      const section = sections.find(
        (candidate) => candidate.rootKind === item.rootKind && candidate.relativePath === item.relativePath && candidate.startLine === item.startLine,
      );
      if (section === undefined) continue;
      item.family = section.family;
      item.reviewedRows = section.rows;
    }
    mkdirSync(archiveDir, { recursive: true });
    writeLedger(ledgerPath, ledger);
    let completed = 0;
    for (const item of ledger.registers) {
      if (item.state === "verified") {
        verifyArchivedRegister(item);
        continue;
      }
      retireRegister(context, ledgerPath, ledger, item);
      completed += 1;
      hooks.afterStage?.("retirement", completed);
    }
    for (const item of ledger.sections) {
      retireSection(context, ledgerPath, ledger, item, hooks);
      completed += 1;
      hooks.afterStage?.("retirement", completed);
    }

    const at = new Date().toISOString();
    const retiredRegisters: RetiredRegister[] = ledger.registers.map((item) => ({
      project: item.project,
      relativePath: item.relativePath,
      sha256: item.sha256,
      bytes: statSync(item.archivePath).size,
      archivedPath: item.archivePath,
    }));
    const retiredSections: RetiredSection[] = ledger.sections.map((item) => ({
      rootKind: item.rootKind,
      relativePath: item.relativePath,
      header: item.header,
      startLine: item.startLine,
      endLine: item.endLine,
      sha256: item.sha256,
      archivedPath: item.archivePath,
      liveSha256: item.expectedLiveSha256!,
      preservedLines: item.preservedLines,
      removedLines: item.removedLines ?? item.endLine - item.startLine + 1,
    }));

    handle.db.exec("begin immediate");
    let receiptId: number;
    try {
      handle.db
        .prepare("update migration_receipts set retired_at = ? where id in (?, ?)")
        .run(at, activationReceipt.receiptId, activationReceipt.applyReceiptId);
      const stored = {
        receiptVersion: ACTIVATION_PROTOCOL_VERSION,
        retirementHash,
        activationReceiptId: activationReceipt.receiptId,
        activationHash: activationReceipt.activationHash,
        storeId: meta.storeId,
        epoch: meta.epoch,
        archiveDir,
        markerPath: join(archiveDir, "MARKER.md"),
        registers: retiredRegisters,
        sections: retiredSections,
        resumed,
      };
      const result = handle.db
        .prepare(
          "insert into migration_receipts(manifest_hash, phase, manifest_json, mapping_json, source_counts_json, applied_at, retired_at) " +
            "values (?, 'retired', ?, '[]', ?, ?, ?)",
        )
        .run(
          retirementHash,
          JSON.stringify(stored),
          JSON.stringify({
            registers: retiredRegisters.length,
            sections: retiredSections.length,
            bytes: retiredRegisters.reduce((total, item) => total + item.bytes, 0),
            resumed,
          }),
          at,
          at,
        );
      receiptId = Number((result as { lastInsertRowid: number | bigint }).lastInsertRowid);
      handle.db.exec("commit");
    } catch (error) {
      try {
        handle.db.exec("rollback");
      } catch {
        // nothing committed either way
      }
      throw error;
    }

    ledger.retirementReceiptId = receiptId;
    const receipt: RetirementReceipt = {
      receiptVersion: ACTIVATION_PROTOCOL_VERSION,
      receiptId,
      phase: "retired",
      replayed: false,
      retirementHash,
      activationReceiptId: activationReceipt.receiptId,
      activationHash: activationReceipt.activationHash,
      storeId: meta.storeId,
      epoch: meta.epoch,
      archiveDir,
      markerPath: join(archiveDir, "MARKER.md"),
      registers: retiredRegisters,
      sections: retiredSections,
      resumed,
      retiredAt: at,
    };
    finalizeDisclosure(ledgerPath, ledger, receipt);
    return receipt;
  } finally {
    handle.close();
  }
}
