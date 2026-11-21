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
import { resolveCollaborationLocation, type CollaborationLocation, type CollaborationMode } from "./collaboration-identity.js";
import {
  COLLABORATION_COLUMNS,
  initializeCollaborationStore,
  openCollaborationStore,
  readCollaborationAuthority,
  readCollaborationStage,
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
import {
  heldCollaborationTables,
  insertMigrationPhaseRow,
  migrationManifestHash,
  readMigrationPhaseRow,
  readMigrationPhaseRows,
  receiptOfStoredApply,
  type MigrationManifest,
  type MigrationReceipt,
  type StoredApply,
} from "./store-migrate.js";
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

/**
 * The verified recovery point the activation barrier takes of the STAGED
 * collaboration lane. Every fact is read from the copy itself, so a recovery
 * point never describes a generation its bytes do not hold.
 */
export type ActivationRecoveryPoint = {
  backupPath: string;
  bytes: number;
  takenAt: string;
  authority: CollaborationAuthority;
  counts: Readonly<Record<string, number>>;
};

export type ActivationReceipt = {
  receiptVersion: number;
  phase: "activated";
  /** True when an identical activation was already recorded (no second epoch bump). */
  replayed: boolean;
  /** Canonical hash of this activation, recorded as provenance. */
  activationHash: string;
  /** The reviewed apply's manifest hash — the lane phase row this activation publishes. */
  applyManifestHash: string;
  storeId: string;
  previousEpoch: number;
  /** The live authority epoch this activation created. */
  epoch: number;
  revision: number;
  catalogRevision: number;
  attestationHash: string;
  attestation: ActivationAttestation;
  backup: ActivationRecoveryPoint;
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
  phase: "retired";
  replayed: boolean;
  retirementHash: string;
  /** The reviewed apply whose activation this retirement completes. */
  applyManifestHash: string;
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
 *
 * `execution.backupPath` and `collaboration.path` are SAFE SIBLING BASENAMES:
 * the two images are published beside the manifest, and a restore resolves them
 * against the manifest location the operator supplied. `manifestPath` records
 * where the manifest was published (provenance), never the locator a restore
 * depends on — a moved, intact pair therefore restores from its new directory.
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
  /**
   * Every recorded operation row: its key space, execution store/epoch, receipt
   * revisions and — for a composite effect — whether its execution half ever
   * acknowledged it. A confirmed effect whose acknowledgement never landed is a
   * supported state (`acknowledgedAt: null`), and a pair must never freeze it.
   */
  operations: readonly Readonly<{
    keySpace: string;
    operationId: string;
    executionStoreId: string | null;
    executionEpoch: number | null;
    state: EffectState;
  }>[];
}>;

/** The cutover's single claim slot: a pending activation, never a restore state. */
const COLLABORATION_CLAIM_KEY = "collaboration-cutover-claim";

/**
 * What one lane operation row says about the repository's causal boundary:
 *
 * - `acknowledged`: a standalone marker (no execution half) or a composite whose
 *   `result_json.acknowledgedAt` instant landed.
 * - `declined`: a composite whose deterministic refusal is recorded instead of an
 *   effect, in the exact shape the decline producer writes and under its OWN
 *   effect key. The execution side deliberately keeps that as terminal state, so a
 *   well-formed decline is settled history — never an outstanding effect, because
 *   treating one as outstanding would block every future repository backup.
 * - `unacknowledged`: a committed effect whose acknowledgement never landed (the
 *   supported two-transaction window).
 * - `unreadable`: anything that is neither a receipt nor a STRUCTURALLY VALID,
 *   currently owned decline. A malformed, partial, foreign or hand-assembled
 *   decline proves nothing, so it is unconfirmed rather than historical success.
 */
type EffectState = "acknowledged" | "declined" | "unacknowledged" | "unreadable";

/** The exact keys of the stored decline document (`{ declined: { …cause, at } }`). */
const DECLINE_KEYS = ["at", "code", "details", "message"];
/** The exact keys of a stored effect document (`{ receipt, acknowledgedAt }`). */
const EFFECT_KEYS = ["acknowledgedAt", "receipt"];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Exactly these keys, nothing more and nothing less. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value).sort();
  return present.length === keys.length && keys.every((key, index) => present[index] === key);
}

/**
 * A decline is settled history only when it is the shape the producer writes AND
 * the row still owns it: a composite key (execution store, epoch, request hash)
 * plus the recording instant. Anything else is unconfirmed.
 */
function isOwnedDecline(row: Record<string, unknown>, declined: unknown): boolean {
  if (!isPlainRecord(declined) || !hasExactKeys(declined, DECLINE_KEYS)) return false;
  if (typeof declined.code !== "string" || declined.code.trim() === "") return false;
  if (typeof declined.message !== "string" || declined.message.trim() === "") return false;
  if (typeof declined.at !== "string" || Number.isNaN(Date.parse(declined.at))) return false;
  if (declined.details !== null && !isPlainRecord(declined.details)) return false;
  if (typeof row.execution_store_id !== "string" || row.execution_store_id === "") return false;
  if (typeof row.execution_epoch !== "number" || !Number.isSafeInteger(row.execution_epoch)) return false;
  if (typeof row.request_hash !== "string" || row.request_hash === "") return false;
  return true;
}

function effectStateOf(row: Record<string, unknown>): EffectState {
  if (row.key_space !== "composite") return "acknowledged";
  const raw = row.result_json;
  if (typeof raw !== "string") return "unreadable";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "unreadable";
  }
  if (!isPlainRecord(parsed)) return "unreadable";
  // A decline document carries exactly one key; a receipt document exactly two.
  if (hasExactKeys(parsed, ["declined"])) return isOwnedDecline(row, parsed.declined) ? "declined" : "unreadable";
  if (!hasExactKeys(parsed, EFFECT_KEYS)) return "unreadable";
  if (!isPlainRecord(parsed.receipt)) return "unreadable";
  return typeof parsed.acknowledgedAt === "string" ? "acknowledged" : "unacknowledged";
}

/** One lane operation row as the quiescence and causal-boundary checks read it. */
type LaneOperation = {
  keySpace: string;
  operationId: string;
  executionStoreId: string | null;
  executionEpoch: number | null;
  state: EffectState;
};

/**
 * A lane frozen mid-activation: the cutover's single claim slot is still held, so
 * the authority is between verified, fenced and active. No pair and no restore
 * may treat that generation as settled.
 */
function assertNoPendingClaim(operations: readonly LaneOperation[], where: string): void {
  const claim = operations.find((row) => row.keySpace === "standalone" && row.operationId === COLLABORATION_CLAIM_KEY);
  if (claim !== undefined) {
    throw incompletePair(
      `The collaboration authority ${where} holds a pending cutover claim, so it was frozen mid-activation. Resume or ` +
        `abandon that activation before taking a pair.`,
    );
  }
}

/**
 * The REQUIRED quiescent causal boundary of a repository PAIR: beyond the claim
 * slot, the lane may hold no committed effect whose execution half never
 * acknowledged it, and no composite row whose receipt cannot be interpreted. A
 * recorded DECLINE is settled history (a deterministic refusal the execution side
 * keeps as terminal state), so it never blocks a pair — treating it as an
 * outstanding effect would make one ordinary business refusal stop every future
 * backup.
 */
function assertLaneQuiescent(operations: readonly LaneOperation[], where: string): void {
  assertNoPendingClaim(operations, where);
  const outstanding = operations.filter((row) => row.state === "unacknowledged" || row.state === "unreadable");
  if (outstanding.length > 0) {
    throw incompletePair(
      `The collaboration authority ${where} holds ${outstanding.length} composite effect(s) that are not settled ` +
        `(${outstanding.map((row) => `${row.operationId}: ${row.state}`).join(", ")}). Replay each owning verb so its ` +
        `acknowledgement lands (or its refusal is recorded), then take the pair against a quiescent authority.`,
    );
  }
}

/** The operation columns the quiescence view reads: the key, the revisions and the receipt body. */
const LANE_OPERATION_COLUMNS = "key_space, operation_id, execution_store_id, execution_epoch, request_hash, result_json";

/** The live lane's operation rows, read through its own read admission. */
async function liveLaneOperations(context: StoreContext): Promise<LaneOperation[]> {
  const location = resolveCollaborationLocation(context);
  return readCollaborationStage(location, ({ db }) =>
    (
      db
        .prepare(`select ${LANE_OPERATION_COLUMNS} from collaboration_operations order by operation_id`)
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      keySpace: String(row.key_space),
      operationId: String(row.operation_id),
      executionStoreId: typeof row.execution_store_id === "string" ? row.execution_store_id : null,
      executionEpoch: typeof row.execution_epoch === "number" ? row.execution_epoch : null,
      state: effectStateOf(row),
    })),
  );
}

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
        .prepare(`select ${LANE_OPERATION_COLUMNS} from collaboration_operations order by operation_id`)
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      keySpace: String(row.key_space),
      operationId: String(row.operation_id),
      executionStoreId: typeof row.execution_store_id === "string" ? row.execution_store_id : null,
      executionEpoch: typeof row.execution_epoch === "number" ? row.execution_epoch : null,
      state: effectStateOf(row),
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
 * The pair's execution-side quiescence boundary, proved against the FROZEN
 * bytes: the verified execution image must carry the reservation ledger (it is a
 * current-schema image) and hold no prepared composite. A reservation that
 * started before the snapshot is therefore visible here, deterministically — the
 * copy is refused, never published with half of an in-flight composite.
 */
function assertNoPreparedCompositeOnImage(path: string): void {
  assertStoreRuntimeSupported();
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (p: string, options?: { readOnly?: boolean }) => StoreDb;
  };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("pragma query_only=ON");
    if (!tableNamesOn(db).has("execution_collaboration_intents")) {
      throw incompletePair(
        `The execution image ${path} records this build's schema but carries no composite reservation ledger, so a pending ` +
          `reservation cannot be ruled out; the pair is not taken from an unreadable authority.`,
      );
    }
    const prepared = db
      .prepare("select operation_id from execution_collaboration_intents where phase = 'prepared' order by operation_id")
      .all() as Array<{ operation_id?: unknown }>;
    if (prepared.length > 0) {
      throw incompletePair(
        `The execution image ${path} holds ${prepared.length} prepared composite operation(s) ` +
          `(${prepared.map((row) => String(row.operation_id)).join(", ")}); a pair is only taken of a settled root.`,
      );
    }
  } finally {
    db.close();
  }
}

/** The live selected root still holds no prepared composite: the second half of the publication boundary. */
async function assertNoPreparedCompositeLive(context: StoreContext): Promise<void> {
  const handle = await openStore(context, "read");
  try {
    assertNoOutstandingComposite(handle);
  } finally {
    handle.close();
  }
}

/**
 * `backupRepositoryStores` — the verified PAIR.
 *
 * Preconditions, all proved before anything is published: the selected execution
 * root holds no prepared composite; the live lane holds no pending cutover claim
 * and no composite effect whose execution half never acknowledged it; and the
 * collaboration authority is ACTIVE. Both domains are then copied with their own
 * SQLite snapshot (`VACUUM INTO`) into PRIVATE, uniquely owned image files, each
 * re-opened and verified against its own bytes. Both authorities must hold the
 * SAME generation — identity, epoch, revision AND catalog revision — before and
 * after the copies, and the verified images must describe exactly that
 * generation. Only then are the two images linked into their canonical names and
 * the manifest published, both create-only. A concurrent attempt that wins any
 * of those names is refused; this attempt removes only the files it created and
 * never another attempt's image. Every refusal is `collaboration.backup-incomplete`
 * with nothing named as a backup.
 */
export async function backupRepositoryStores(
  context: StoreContext,
  options: { out: string },
): Promise<RepositoryBackupReceipt> {
  if (typeof options?.out !== "string" || options.out.trim() === "") {
    throw incompletePair("A repository backup needs the absolute manifest path it publishes (--out <abs-manifest>).");
  }
  const manifestPath = resolve(options.out);
  const executionImagePath = `${manifestPath}.execution.db`;
  const collaborationImagePath = `${manifestPath}.collaboration.db`;
  const location = resolveCollaborationLocation(context);

  if (existsSync(manifestPath)) {
    throw incompletePair(
      `A repository backup manifest already exists at ${manifestPath}; pass --out <path> naming a new destination instead of ` +
        `overwriting a recorded recovery point.`,
    );
  }
  // The manifest is the pair's ONLY discoverable commit. Two image names with no
  // manifest are an interrupted attempt (or a competitor still copying), never a
  // published backup: resume it by verifying those exact bytes, refuse a half
  // pair by name, and never guess.
  if (existsSync(executionImagePath) || existsSync(collaborationImagePath)) {
    if (!existsSync(executionImagePath) || !existsSync(collaborationImagePath)) {
      const missing = existsSync(executionImagePath) ? collaborationImagePath : executionImagePath;
      throw incompletePair(
        `An interrupted pair left an image at ${existsSync(executionImagePath) ? executionImagePath : collaborationImagePath} ` +
          `without ${missing} and without a manifest. Nothing is published by that half attempt; remove the orphan image or ` +
          `pass --out <path> naming a new destination.`,
      );
    }
    return resumeInterruptedPair(context, location, {
      manifestPath,
      executionImagePath,
      collaborationImagePath,
    });
  }

  // The quiescent causal boundary BEFORE either copy: no prepared composite in
  // this execution root, and no unacknowledged or mid-activation state in the
  // lane. A pair is taken of a settled generation or not at all.
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
  assertLaneQuiescent(await liveLaneOperations(context), `at ${location.dbPath}`);

  // This attempt's own image names: private scratch beside the canonical
  // destinations. Nothing else ever writes or removes them, so a concurrent
  // attempt can never delete this attempt's bytes (or vice versa).
  const attempt = `${process.pid}-${randomUUID()}`;
  const privateExecutionImage = join(dirname(executionImagePath), `.${basename(executionImagePath)}.${attempt}.tmp`);
  const privateCollaborationImage = join(dirname(collaborationImagePath), `.${basename(collaborationImagePath)}.${attempt}.tmp`);
  const privatePaths = [privateExecutionImage, privateCollaborationImage];
  const linked: string[] = [];

  let execution: BackupReceipt | undefined;
  let collaborationInspection: CollaborationImageInspection | undefined;
  try {
    execution = await backupStore(context, { out: privateExecutionImage });
    await writeCollaborationImage(location.dbPath, privateCollaborationImage);
    collaborationInspection = await inspectCollaborationImage(privateCollaborationImage, location).catch((error: unknown) => {
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
    const sameCollaborationGeneration = (generation: CollaborationAuthority): boolean =>
      generation.storeId === collaborationBefore.storeId &&
      generation.epoch === collaborationBefore.epoch &&
      generation.revision === collaborationBefore.revision &&
      generation.catalogRevision === collaborationBefore.catalogRevision;
    if (!sameCollaborationGeneration(collaborationAfter) || !sameCollaborationGeneration(collaborationInspection.authority)) {
      // Both copies can be individually coherent while the lane moved under
      // them: the pair would name a generation its bytes do not hold.
      throw incompletePair(
        `The collaboration authority moved while the pair was copied (store ${collaborationBefore.storeId} epoch ` +
          `${collaborationBefore.epoch} revision ${collaborationBefore.revision} catalog revision ` +
          `${collaborationBefore.catalogRevision} -> revision ${collaborationAfter.revision} catalog revision ` +
          `${collaborationAfter.catalogRevision}, image revision ${collaborationInspection.authority.revision} catalog ` +
          `revision ${collaborationInspection.authority.catalogRevision}); a pair is only published against one stable ` +
          `generation. Stop the writers and retry.`,
      );
    }
    // The verified images must also clear the same boundary the live lane did.
    assertLaneQuiescent(collaborationInspection.operations, `at ${privateCollaborationImage}`);

    // THE publication boundary: the frozen execution bytes hold no prepared
    // composite, and the live root still holds none. A reservation that started
    // before the snapshot is in the image; one that started after it is in the
    // live read. Either way this attempt refuses instead of publishing a pair
    // with half of an in-flight composite, and the retry succeeds once settled.
    assertNoPreparedCompositeOnImage(privateExecutionImage);
    await assertNoPreparedCompositeLive(context);

    // Publish both images create-only: a link either creates this attempt's name
    // or fails, so a competitor's image is never overwritten or adopted.
    linkSync(privateExecutionImage, executionImagePath);
    linked.push(executionImagePath);
    linkSync(privateCollaborationImage, collaborationImagePath);
    linked.push(collaborationImagePath);
  } catch (error) {
    for (const path of [...privatePaths, ...linked]) rmSync(path, { force: true });
    for (const path of privatePaths) {
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
    throw error instanceof StoreError
      ? error
      : incompletePair(`The pair could not be published (${messageOf(error)}).`);
  } finally {
    for (const path of privatePaths) rmSync(path, { force: true });
  }

  const collaborationImage: CollaborationBackupImage = {
    path: basename(collaborationImagePath),
    authority: collaborationInspection!.authority,
    takenAt: new Date().toISOString(),
    counts: collaborationInspection!.counts,
  };
  const receipt: RepositoryBackupReceipt = {
    version: 1,
    manifestPath,
    execution: { ...execution!, backupPath: basename(executionImagePath) },
    collaboration: collaborationImage,
  };
  publishPairManifest(manifestPath, receipt);
  return receipt;
}

/**
 * Verify an interrupted attempt's two image names and publish the manifest for
 * them. The images are the only evidence, so they are proved exactly like a
 * fresh pair: each re-inspected, both at one generation, the lane quiescent and
 * the execution image free of prepared reservations. A competitor still copying
 * therefore loses the create-only manifest link to whoever verifies first, and
 * nothing is deleted.
 */
async function resumeInterruptedPair(
  context: StoreContext,
  location: CollaborationLocation,
  paths: { manifestPath: string; executionImagePath: string; collaborationImagePath: string },
): Promise<RepositoryBackupReceipt> {
  const executionCopy = await inspectBackupCopy(paths.executionImagePath).catch((error: unknown) => {
    throw incompletePair(
      `The interrupted pair's execution image ${paths.executionImagePath} cannot be verified (${messageOf(error)}); nothing ` +
        `was published.`,
    );
  });
  const collaborationInspection = await inspectCollaborationImage(paths.collaborationImagePath, location);
  assertLaneQuiescent(collaborationInspection.operations, `at ${paths.collaborationImagePath}`);
  assertNoPreparedCompositeOnImage(paths.executionImagePath);
  assertCausalBoundary(
    {
      version: 1,
      manifestPath: paths.manifestPath,
      execution: { ...executionCopy, receiptVersion: BACKUP_RECEIPT_VERSION, backupPath: basename(paths.executionImagePath), walPending: false, bytes: statSync(paths.executionImagePath).size, takenAt: new Date().toISOString() },
      collaboration: { path: basename(paths.collaborationImagePath), authority: collaborationInspection.authority, takenAt: new Date().toISOString(), counts: collaborationInspection.counts },
    },
    collaborationInspection,
    executionCopy,
  );
  const receipt: RepositoryBackupReceipt = {
    version: 1,
    manifestPath: paths.manifestPath,
    execution: {
      receiptVersion: BACKUP_RECEIPT_VERSION,
      backupPath: basename(paths.executionImagePath),
      ...executionCopy,
      walPending: false,
      bytes: statSync(paths.executionImagePath).size,
      takenAt: new Date().toISOString(),
    },
    collaboration: {
      path: basename(paths.collaborationImagePath),
      authority: collaborationInspection.authority,
      takenAt: new Date().toISOString(),
      counts: collaborationInspection.counts,
    },
  };
  publishPairManifest(paths.manifestPath, receipt);
  return receipt;
}

/**
 * Publish the pair's manifest — the ONE discoverable commit — create-only. Once
 * the link lands the pair exists: a directory-sync failure is disclosed as
 * uncertain durability and BOTH the manifest and its images are retained, never
 * deleted behind the operator's back.
 */
function publishPairManifest(manifestPath: string, receipt: RepositoryBackupReceipt): void {
  try {
    publishTextCreateOnly(manifestPath, `${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    if (existsSync(manifestPath)) {
      throw incompletePair(
        `The pair was published at ${manifestPath} but its directory entry could not be synchronized ` +
          `(${messageOf(error)}); the manifest and both images are retained with UNCERTAIN durability. Verify the pair from a ` +
          `second process before relying on it for recovery.`,
      );
    }
    throw error instanceof StoreError
      ? error
      : incompletePair(`The manifest could not be published at ${manifestPath} (${messageOf(error)}).`);
  }
}

/**
 * Allocate the recovery generation of one restore. The canonical target is
 * ABSENT by precondition, so nothing inside it can remember an earlier recovery:
 * a small lineage ledger beside it does, and its epoch only ever advances. Two
 * restores of the same point therefore never issue the same authority stamp, and
 * the receipt records the generation and the epoch it superseded.
 */
function allocateRecoveryGeneration(
  storeDir: string,
  storeId: string,
  backupEpoch: number,
): { epoch: number; generation: number; previousEpoch: number | null } {
  const path = join(storeDir, "restore-lineage.json");
  let generation = 1;
  let previousEpoch: number | null = null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof parsed.generation === "number" && Number.isSafeInteger(parsed.generation)) generation = parsed.generation + 1;
    const prior = parsed.epochByStore;
    if (prior !== null && typeof prior === "object" && !Array.isArray(prior)) {
      const last = (prior as Record<string, unknown>)[storeId];
      if (typeof last === "number" && Number.isSafeInteger(last)) previousEpoch = last;
    }
  } catch {
    // Absent or unreadable lineage is a first recovery: it can only make the
    // allocated epoch HIGHER than the image's, never reuse one.
  }
  const epoch = Math.max(backupEpoch, previousEpoch ?? 0) + 1;
  const body = {
    version: 1,
    generation,
    epochByStore: { ...(previousEpoch === null ? {} : { [storeId]: previousEpoch }), [storeId]: epoch },
    allocatedAt: nowRfc3339(),
  };
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const tmp = join(storeDir, `.restore-lineage.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  return { epoch, generation, previousEpoch };
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
  options: { operator: string; attestation: ActivationAttestation; manifestPath?: string },
): Promise<CollaborationAuthority> {
  const supplied = requireRepositoryBackupReceipt(receipt);
  const location = resolveCollaborationLocation(context);
  // The canonical target's own admission comes FIRST: a redirected storage
  // ancestor or a symlinked target is refused before any staging directory, byte
  // copy or link exists on that path.
  assertCollaborationTargetAdmission(location);

  // The pair is addressed by the manifest the OPERATOR supplied: its directory is
  // where the two sibling images live, so an intact pair moved together restores
  // from its new location without editing the manifest.
  const manifestFile = resolve(options?.manifestPath ?? supplied.manifestPath);
  const pairDir = dirname(manifestFile);
  const executionImagePath = join(pairDir, supplied.execution.backupPath);
  const collaborationImagePath = join(pairDir, supplied.collaboration.path);

  // The manifest is the published authority for the pair: the supplied receipt
  // must BE it, so a caller cannot recombine two verified images by hand.
  let manifestText: string;
  try {
    manifestText = readFileSync(manifestFile, "utf8");
  } catch (error) {
    throw incompletePair(`The backup manifest ${manifestFile} cannot be read (${messageOf(error)}).`);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText) as unknown;
  } catch {
    throw incompletePair(`The backup manifest ${manifestFile} is not readable JSON.`);
  }
  if (canonicalJsonOf(manifest) !== canonicalJsonOf(supplied)) {
    throw incompletePair(
      `The supplied receipt is not the manifest published at ${manifestFile}; supply the verified pair's own ` +
        `manifest rather than images assembled by hand.`,
    );
  }

  const executionCopy = await inspectBackupCopy(executionImagePath).catch((error: unknown) => {
    throw incompletePair(`The execution image ${executionImagePath} cannot be verified (${messageOf(error)}).`);
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
      `The execution image at ${executionImagePath} does not describe the generation the manifest records.`,
    );
  }
  const collaborationInspection = await inspectCollaborationImage(collaborationImagePath, location);
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
      `The collaboration image at ${collaborationImagePath} does not describe the generation the manifest records.`,
    );
  }
  // The pair must still prove the SAME settled boundary the producer required:
  // no prepared reservation in the paired execution image, and no outstanding
  // effect in the lane (acknowledged or declined history of any root is settled).
  assertNoPreparedCompositeOnImage(executionImagePath);
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
    copyFileSync(collaborationImagePath, stagingPath);
    chmodSync(stagingPath, 0o600);
    const stagedInspection = await inspectCollaborationImage(stagingPath, location);
    if (canonicalJsonOf(stagedInspection.counts) !== canonicalJsonOf(collaborationInspection.counts)) {
      throw incompletePair(`The staged copy of ${collaborationImagePath} does not hold the verified rows.`);
    }
    // The runtime's OWN admission over the private staged bytes (migration and
    // checksum, closed inventory, metadata) — the same proof the live read will
    // apply, so an image this build would refuse never reaches the canonical name.
    const admitted = await admitCollaborationImage(location, stagingPath).catch((error: unknown) => {
      throw error instanceof StoreError
        ? error
        : incompletePair(`The staged copy of ${collaborationImagePath} is not an admissible collaboration store (${messageOf(error)}).`);
    });
    if (admitted.storeId !== recorded.storeId || admitted.epoch !== recorded.epoch || admitted.state !== recorded.state) {
      throw incompletePair(
        `The staged copy of ${collaborationImagePath} is not the generation the manifest records (identity, epoch or state changed).`,
      );
    }
    const imageSha = sha256Bytes(readFileSync(stagingPath));
    const restoredAt = nowRfc3339();
    // A recovery generation is NEVER reused: the epoch comes from a lineage
    // ledger that only ever advances, so a second restore of the same point
    // cannot re-issue a stamp an earlier recovery already handed out.
    const lineage = allocateRecoveryGeneration(dir, recorded.storeId, recorded.epoch);
    nextEpoch = lineage.epoch;
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
            version: 2,
            imagePath: basename(collaborationImagePath),
            imageSha256: imageSha,
            restoredFrom: { storeId: recorded.storeId, epoch: recorded.epoch, revision: recorded.revision },
            lineage: { generation: lineage.generation, previousEpoch: lineage.previousEpoch },
            authority: { storeId: recorded.storeId, epoch: nextEpoch, repoKey: location.repoKey, mode: location.mode },
            operator,
            executionImage: { path: basename(executionImagePath), storeId: supplied.execution.storeId, epoch: supplied.execution.epoch },
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

/**
 * The receipt shape a restore accepts: the pair's own manifest fields, nothing
 * inferred. The two image fields are SAFE SIBLING BASENAMES — a restore resolves
 * them against the manifest location the operator supplied — so an absolute path,
 * a separator, `.` or `..` is a hand-assembled manifest, refused by name.
 */
function requireRepositoryBackupReceipt(value: unknown): RepositoryBackupReceipt {
  const bad = (detail: string): never => {
    throw incompletePair(`The supplied repository backup receipt is not usable: ${detail}.`);
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) bad("it is not an object");
  const receipt = value as Record<string, unknown>;
  if (receipt.version !== 1) bad(`its version is ${JSON.stringify(receipt.version)}, not this build's 1`);
  const manifestPath = receipt.manifestPath;
  if (typeof manifestPath !== "string" || manifestPath.trim() === "") bad("it names no manifest path");
  const requireSibling = (name: unknown, what: string): void => {
    if (typeof name !== "string" || name.trim() === "") bad(`its ${what} names no image`);
    const imageName = name as string;
    if (imageName !== basename(imageName) || imageName === "." || imageName === "..") {
      bad(`its ${what} is ${JSON.stringify(imageName)}, not a sibling file name (a pair is resolved beside its manifest)`);
    }
  };
  const execution = receipt.execution;
  if (
    execution === null ||
    typeof execution !== "object" ||
    typeof (execution as Record<string, unknown>).storeId !== "string"
  ) {
    bad("it carries no execution image receipt");
  }
  requireSibling((execution as Record<string, unknown>).backupPath, "execution image");
  const collaboration = receipt.collaboration;
  if (collaboration === null || typeof collaboration !== "object") bad("it carries no collaboration image");
  const image = collaboration as Record<string, unknown>;
  if (image.authority === null || typeof image.authority !== "object") {
    bad("its collaboration image names no verified authority");
  }
  requireSibling(image.path, "collaboration image");
  if (image.counts === null || typeof image.counts !== "object" || Array.isArray(image.counts)) {
    bad("its collaboration image records no row counts");
  }
  return value as RepositoryBackupReceipt;
}

/**
 * The causal boundary of a restore. The lane is repository-wide and every
 * checkout (including a replacement clone) has its own execution store, so a
 * composite effect recorded for ANOTHER execution root is legitimate, already
 * acknowledged history — never a mismatch. What the restore does refuse:
 *
 * - a lane frozen mid-activation (the cutover claim slot still held);
 * - an effect of the PAIRED execution root that its own execution half never
 *   acknowledged (an outstanding effect of the root this restore replaces);
 * - an effect of the paired root from a LATER epoch than the paired image.
 */
function assertCausalBoundary(
  receipt: RepositoryBackupReceipt,
  collaboration: CollaborationImageInspection,
  execution: BackupInspection,
): void {
  assertNoPendingClaim(collaboration.operations, `at ${receipt.collaboration.path}`);
  for (const row of collaboration.operations) {
    if (row.keySpace !== "composite") continue;
    if (row.state === "unreadable") {
      throw incompletePair(
        `The collaboration image records composite row ${row.operationId} whose result is neither a receipt nor a recorded ` +
          `refusal; an uninterpretable effect is never restored as history.`,
      );
    }
    // Another root's history: acknowledged effect or recorded decline, it belongs
    // to a checkout this restore neither replaces nor can complete.
    if (row.executionStoreId !== execution.storeId) continue;
    if (row.state === "unacknowledged") {
      throw incompletePair(
        `The collaboration image records composite effect ${row.operationId} for the paired execution store ` +
          `${execution.storeId} without its acknowledgement; that root's owning verb must replay it before this pair can be ` +
          `restored over it.`,
      );
    }
    if (row.executionEpoch !== null && row.executionEpoch > execution.epoch) {
      throw incompletePair(
        `The collaboration image records a composite effect from execution epoch ${row.executionEpoch}, which is AHEAD of the ` +
          `paired execution image's epoch ${execution.epoch}; the pair is out of causal order.`,
      );
    }
  }
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
  // A checkout already bound to a repository is never silently re-pointed by an
  // origin or `.mstarc` change: the bootstrap refuses before it creates, reuses or
  // publishes anything for the newly derived scope.
  const binding = readCollaborationBinding(context);
  if (binding !== null && (binding.repoKey !== location.repoKey || binding.mode !== location.mode)) {
    throw new StoreError(
      "collaboration.stale-binding",
      `This control checkout is bound to repository ${binding.repoKey} (${binding.mode}), but now resolves to ` +
        `${location.repoKey} (${location.mode}); a retargeted checkout never adopts another repository's authority. ` +
        `Re-resolve the scope deliberately (mstar path resolve) or start a new checkout for the other repository. ` +
        `Nothing was created or changed.`,
    );
  }
  if (existsSync(storeDbPath(context))) {
    const handle = await openStore(context, "read");
    try {
      const fence = readCollaborationFence(handle.db);
      if (fence === null) {
        const held = heldCollaborationTables(handle.db);
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
// Receipt rows (collaboration lane)
// ---------------------------------------------------------------------------

/**
 * The reviewed manifest's recorded applied phase, read-only: the lane row
 * addressed by the manifest's OWN canonical hash. Whether that row is still the
 * FINAL applied import, and whether it belongs to this lane generation, is
 * decided by the activation/retirement barrier from the recorded store id,
 * epoch and live revision.
 */
export async function appliedReceiptFor(context: StoreContext, manifest: MigrationManifest): Promise<MigrationReceipt> {
  if (resolve(manifest.controlRoot) !== resolve(context.harnessDir)) {
    throw new StoreActivationError(
      "store.activation-stale",
      `the manifest was reviewed for control root ${manifest.controlRoot}, not ${context.harnessDir}; nothing was activated.`,
    );
  }
  const manifestHash = migrationManifestHash(manifest);
  const found = await readCollaborationStage(resolveCollaborationLocation(context), ({ db }) =>
    readMigrationPhaseRow(db, "applied", manifestHash),
  );
  if (found === undefined) {
    throw new StoreActivationError(
      "store.activation-stale",
      "this collaboration authority has no recorded apply receipt for the reviewed manifest; apply the reviewed manifest first " +
        "(store migrate --apply --manifest <path>).",
    );
  }
  const stored = JSON.parse(found.resultJson) as StoredApply;
  if (typeof stored.counts?.storeRevision !== "number") {
    throw new StoreActivationError(
      "store.activation-stale",
      "the recorded apply receipt carries no store revision; the staged lane cannot be checked against the reviewed apply.",
    );
  }
  return receiptOfStoredApply(stored, manifestHash, found.committedAt, true);
}

/** The recorded activation receipt of an applied manifest (§7); read-only. */
export async function activationReceiptFor(context: StoreContext, manifest: MigrationManifest): Promise<ActivationReceipt> {
  const apply = await appliedReceiptFor(context, manifest);
  const row = await readCollaborationStage(resolveCollaborationLocation(context), ({ db }) =>
    readMigrationPhaseRow(db, "activated", apply.manifestHash),
  );
  if (row === undefined) {
    throw new StoreActivationError(
      "store.activation-stale",
      `the applied manifest ${apply.manifestHash.slice(0, 16)} has no recorded activation; run "store activate" ` +
        `with the reviewed manifest and attestation first.`,
    );
  }
  const recorded = JSON.parse(row.resultJson) as Omit<ActivationReceipt, "replayed">;
  return { ...recorded, replayed: true };
}

function activationHashOf(parts: {
  applyManifestHash: string;
  storeId: string;
  previousEpoch: number;
  epoch: number;
  attestationHash: string;
  backupPath: string;
}): string {
  return sha256Bytes(Buffer.from(`activation\u0000${JSON.stringify(parts)}`, "utf8"));
}

// ---------------------------------------------------------------------------
// Activation barrier (§7)
// ---------------------------------------------------------------------------

/**
 * The rows statement result a CAS reports; a driver value that carries no
 * readable count is treated as "no row changed" — the conservative side of
 * every conditional update.
 */
function affectedRows(result: unknown): number {
  if (result === null || typeof result !== "object" || !("changes" in result)) return 0;
  return typeof result.changes === "number" ? result.changes : 0;
}

/**
 * The recovery point of the STAGED lane, taken with the one-image primitive and
 * verified against its own bytes. A resumed activation re-verifies the existing
 * point at this generation's deterministic path instead of overwriting a
 * recorded recovery point.
 */
async function takeLaneRecoveryPoint(
  context: StoreContext,
  location: CollaborationLocation,
  authority: CollaborationAuthority,
): Promise<ActivationRecoveryPoint> {
  const targetPath = join(
    dirname(storeDbPath(context)),
    "archived",
    "store-migration",
    "backups",
    `pre-activation-${authority.storeId.slice(0, 8)}-e${authority.epoch}-r${authority.revision}.db`,
  );
  const takenAt = new Date().toISOString();
  if (existsSync(targetPath)) {
    let existing: CollaborationImageInspection;
    try {
      existing = await inspectCollaborationImage(targetPath, location);
    } catch (error) {
      throw new StoreActivationError(
        "store.activation-stale",
        `the existing recovery point at ${targetPath} cannot be verified (${messageOf(error)}). Refusing to overwrite a ` +
          `recorded recovery point.`,
      );
    }
    if (
      existing.authority.storeId !== authority.storeId ||
      existing.authority.epoch !== authority.epoch ||
      existing.authority.revision !== authority.revision ||
      existing.authority.state !== authority.state
    ) {
      throw new StoreActivationError(
        "store.activation-stale",
        `the existing recovery point at ${targetPath} does not describe this staged lane ` +
          `(identity/epoch/revision/state mismatch). Refusing to overwrite a recorded recovery point.`,
      );
    }
    return { backupPath: targetPath, bytes: statSync(targetPath).size, takenAt, authority: existing.authority, counts: existing.counts };
  }
  await writeCollaborationImage(location.dbPath, targetPath);
  const verified = await inspectCollaborationImage(targetPath, location).catch((error: unknown) => {
    rmSync(targetPath, { force: true });
    throw new StoreActivationError(
      "store.activation-stale",
      `the recovery point written to ${targetPath} could not be verified (${messageOf(error)}); the unverified copy was ` +
        `removed. Nothing was activated.`,
    );
  });
  // Same-lane: `store_id` is written once at lane creation and never changes,
  // so it is the one live fact a fresh copy is checked against.
  if (verified.authority.storeId !== authority.storeId || verified.authority.revision !== authority.revision) {
    rmSync(targetPath, { force: true });
    throw new StoreActivationError(
      "store.activation-stale",
      `the recovery point written to ${targetPath} describes store ${verified.authority.storeId} revision ` +
        `${verified.authority.revision}, not this staged lane ${authority.storeId} revision ${authority.revision}; the ` +
        `unverified copy was removed. Nothing was activated.`,
    );
  }
  return { backupPath: targetPath, bytes: statSync(targetPath).size, takenAt, authority: verified.authority, counts: verified.counts };
}

/**
 * The ACTIVE execution sessions this checkout currently holds. The execution
 * and collaboration authorities keep independent epochs, so an activation's
 * stop list is the active rows themselves — the running consumers that could
 * hold the superseded state. A file-era import has no execution store, and that
 * absence is not an error: there is nothing to stop.
 */
async function activeExecutionSessions(context: StoreContext): Promise<StoppedSessionAttestation[]> {
  if (!existsSync(storeDbPath(context))) return [];
  const handle = await openStore(context, "read");
  try {
    const rows = handle.db.prepare("select session_id from execution_sessions where state = 'active'").all();
    const sessions: StoppedSessionAttestation[] = [];
    for (const row of rows) {
      if (row === null || typeof row !== "object" || !("session_id" in row) || typeof row.session_id !== "string") continue;
      if (row.session_id === "") continue;
      sessions.push({ sessionId: row.session_id, host: "local", state: "stopped" });
    }
    return sessions;
  } finally {
    handle.close();
  }
}

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
    typeof receipt.manifestHash !== "string" ||
    typeof receipt.storeRevision !== "number"
  ) {
    throw new StoreActivationError(
      "store.activation-stale",
      "the activation requires the reviewed apply receipt (manifestHash, storeRevision); re-apply the reviewed manifest.",
    );
  }
  // A supplied document is the 1:1 override and is validated here, before the
  // recovery point, exactly as before. An omitted one is generated inside the
  // flip transaction below and validated at the same point — the validator stays
  // the acceptance authority either way.
  const validated = attestation === undefined ? undefined : validateActivationAttestation(attestation);

  const location = resolveCollaborationLocation(context);
  const inspection = await readCollaborationStage(location, ({ db, authority }) => ({
    authority,
    applied: readMigrationPhaseRow(db, "applied", receipt.manifestHash),
    lastApplied: readMigrationPhaseRows(db, "applied").at(-1),
    recorded: readMigrationPhaseRow(db, "activated", receipt.manifestHash),
  }));

  if (inspection.authority.state === "active") {
    // Published already: serve THIS manifest's recorded activation, and refuse
    // any other outcome. The published generation is never replaced by a new
    // receipt, and the lane's unique phase row makes a second activation of the
    // same import impossible.
    if (inspection.recorded === undefined) {
      throw new StoreActivationError(
        "store.activation-stale",
        `the collaboration authority is already active under a different activation; the reviewed manifest ` +
          `${receipt.manifestHash.slice(0, 16)} is not its published import, and the authority generation cannot be ` +
          `replaced by a new receipt.`,
      );
    }
    const published = JSON.parse(inspection.recorded.resultJson) as Omit<ActivationReceipt, "replayed">;
    // The recorded activation must be THIS authority's, in the live generation:
    // store identity and epoch are real owner facts, so a copied lane's or a
    // superseded epoch's activation is never replayed as this one's.
    if (published.storeId !== inspection.authority.storeId || published.epoch !== inspection.authority.epoch) {
      throw new StoreActivationError(
        "store.activation-stale",
        `the recorded activation belongs to store ${published.storeId} epoch ${published.epoch}, not this live authority ` +
          `${inspection.authority.storeId} epoch ${inspection.authority.epoch}; it cannot be served as this store's activation.`,
      );
    }
    return { ...published, replayed: true };
  }

  // The applied phase is addressed by the reviewed manifest's OWN hash — the
  // row the staged apply wrote — never by a content digest of anything else.
  if (inspection.applied === undefined) {
    throw new StoreActivationError(
      "store.activation-stale",
      `the reviewed manifest ${receipt.manifestHash.slice(0, 16)} has no recorded apply receipt in this collaboration ` +
        `lane; re-apply the reviewed manifest and use its receipt. Nothing was activated.`,
    );
  }
  if (inspection.recorded !== undefined) {
    throw new StoreActivationError(
      "store.activation-stale",
      `the lane records an activation for ${receipt.manifestHash.slice(0, 16)} but is still staged; the recorded activation ` +
        `does not describe this lane generation. Nothing was activated.`,
    );
  }
  if (inspection.lastApplied === undefined || inspection.lastApplied.rowid !== inspection.applied.rowid) {
    throw new StoreActivationError(
      "store.activation-stale",
      `the reviewed manifest is not the FINAL applied import (a later apply is recorded); revalidate the final manifest, ` +
        `re-apply it and re-attest. Nothing was activated.`,
    );
  }
  const appliedStored = JSON.parse(inspection.applied.resultJson) as StoredApply;
  const manifest = appliedStored.manifest;
  if (resolve(manifest.controlRoot) !== resolve(context.harnessDir)) {
    throw new StoreActivationError(
      "store.activation-stale",
      `the applied manifest was reviewed for control root ${manifest.controlRoot}, not ${context.harnessDir}. Nothing was activated.`,
    );
  }
  const meta = inspection.authority;
  if (meta.revision !== receipt.storeRevision) {
    throw new StoreActivationError(
      "store.activation-stale",
      `the staged lane is at revision ${meta.revision}, but the reviewed apply committed revision ` +
        `${receipt.storeRevision}; the staged lane changed after the reviewed apply. Re-apply the final manifest first.`,
    );
  }
  // First of two: this pass refuses a missing/renamed register before the
  // recovery point is written. The decisive one runs inside the flip
  // transaction.
  revalidateSources(context, manifest, "activation");

  // The generated document records the invoking operator, so a missing one is
  // refused HERE — before the recovery point is written — and an unoperated
  // activation never leaves an orphan artifact behind.
  const generatedOperator = validated === undefined ? requireGeneratedOperator(options.operator) : "";

  // The recovery point is the STAGED LANE's own verified copy, taken before the
  // publication: the lane is quiesced (attested) and never has two writers.
  const backup = await takeLaneRecoveryPoint(context, location, meta);

  // Test seam: an old binary writes a register here — after the inspection pass
  // above and before the barrier transaction below.
  hooks.afterStage?.("inspection", 0);

  // The active execution sessions this publication supersedes, read from the
  // checkout's own execution authority. The two authorities keep independent
  // epochs, so the stop list is the active rows themselves; a file-era import
  // has no execution store and therefore nothing to stop.
  const stoppedSessions = await activeExecutionSessions(context);

  // The publication is ONE lane transaction: the state/epoch flip, the
  // authority stamp and the activation phase row commit together, so an
  // interrupted barrier leaves the lane staged with no activation receipt.
  return writeCollaborationStage(location, ({ db, authority }) => {
    // ONE instant for the whole flip: the generated document attests it and
    // every activation stamp records it.
    const at = (options.now ?? (() => new Date().toISOString()))();
    if (authority.state !== "staged" || authority.storeId !== meta.storeId || authority.revision !== meta.revision) {
      throw new StoreActivationError(
        "store.activation-stale",
        "the staged lane changed while the barrier was running; the activation was rolled back. Re-check and retry.",
      );
    }
    // Barrier-time register-set fence. The inspection pass ran under its own
    // read admission and the recovery point was taken after it, so a legacy
    // writer could have landed a new register in between. Revalidate the
    // reviewed register set HERE, inside the flip transaction: the epoch never
    // bumps against a source set that no longer matches the reviewed one,
    // whatever appeared after the inspection.
    //
    // Documented trade (QC seat 3 S-001): this fence performs register-set
    // enumeration while the lane's write lock is held, so the lock window
    // scales with the register count. That is acceptable BY PRECONDITION:
    // activation runs only on a QUIESCED STAGED lane — the attestation
    // validation above has stopped every registered reader/writer session
    // before this transaction opens, so no concurrent writer can be starved and
    // the in-window I/O is bounded by the reviewed source set, not by
    // contention. The fence stays in-transaction deliberately: hoisting it
    // before the lock would reopen the inspection→flip race this fence exists to
    // close.
    revalidateSources(context, manifest, "activation");
    // The generated operator document, assembled inside this transaction: the
    // invoking operator is the recorded actor, the reviewed apply's manifest
    // hash is the durable authorizationRef, the clock is the same instant the
    // epoch bump is stamped with, and the stop list is exactly the active
    // execution rows this publication supersedes. The narrowed meaning stays
    // explicit: consumers attests the EXECUTING consumer only, and
    // stoppedSessions attests row disposal, never an observed process death.
    let activationValidated = validated;
    if (activationValidated === undefined) {
      // The operator was required before the recovery point (preflight above);
      // this branch only runs when no document was supplied, so it is nonblank.
      const provisioned = provisionActivationDocument(
        {
          actor: generatedOperator,
          authorizationRef: `migration-applied:${receipt.manifestHash}`,
          attestedAt: at,
          stoppedSessions,
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
    const epoch = meta.epoch + 1;
    const revision = meta.revision + 1;
    const activationHash = activationHashOf({
      applyManifestHash: receipt.manifestHash,
      storeId: meta.storeId,
      previousEpoch: meta.epoch,
      epoch,
      attestationHash,
      backupPath: backup.backupPath,
    });
    // CAS on the reviewed generation: the publication only ever advances the
    // exact staged revision it verified, once.
    const changed = db
      .prepare(
        "update collaboration_meta set authority_state = 'active', authority_epoch = ?, revision = ?, activated_at = ? " +
          "where id = 1 and authority_state = 'staged' and store_id = ? and authority_epoch = ? and revision = ?",
      )
      .run(epoch, revision, at, meta.storeId, meta.epoch, meta.revision);
    if (affectedRows(changed) !== 1) {
      throw new StoreActivationError(
        "store.activation-stale",
        "the staged lane changed inside the barrier transaction; the activation was rolled back. Re-check and retry.",
      );
    }
    hooks.afterStage?.("flip", 0);
    const stored: ActivationReceipt = {
      receiptVersion: ACTIVATION_PROTOCOL_VERSION,
      phase: "activated",
      replayed: false,
      activationHash,
      applyManifestHash: receipt.manifestHash,
      storeId: meta.storeId,
      previousEpoch: meta.epoch,
      epoch,
      revision,
      catalogRevision: authority.catalogRevision,
      attestationHash,
      attestation: activationValidated,
      backup,
      activatedAt: at,
    };
    insertMigrationPhaseRow(db, "activated", receipt.manifestHash, stored, at);
    return stored;
  });
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
  /** The reviewed import whose activation this retirement completes. */
  applyManifestHash: string;
  activationHash: string;
  storeId: string;
  epoch: number;
  archiveDir: string;
  successorDbPath: string;
  backupPath: string;
  startedAt: string;
  updatedAt: string;
  retirementHash: string | null;
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
    `# Legacy source archive \u2014 reviewed import \`${ledger.applyManifestHash.slice(0, 16)}\``,
    "",
    "Retired from the live control root by `mstar store retire`, after the activation barrier passed.",
    "",
    `- successor authority: \`${ledger.successorDbPath}\` (store_id \`${ledger.storeId}\`, authority epoch ${ledger.epoch})`,
    `- activation receipt: \`${ledger.activationHash}\``,
    `- retirement receipt: ${receipt === null ? "pending" : `\`${receipt.retirementHash}\``}`,
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
    typeof activationReceipt.applyManifestHash !== "string" ||
    typeof activationReceipt.activationHash !== "string" ||
    typeof activationReceipt.storeId !== "string" ||
    typeof activationReceipt.epoch !== "number"
  ) {
    throw new StoreActivationError(
      "store.activation-stale",
      'retirement requires the recorded activation receipt (applyManifestHash, activationHash, storeId, epoch); run "store activate" first.',
    );
  }

  const location = resolveCollaborationLocation(context);
  const lane = await readCollaborationStage(location, ({ db, authority }) => ({
    authority,
    applied: readMigrationPhaseRow(db, "applied", activationReceipt.applyManifestHash),
    activation: readMigrationPhaseRow(db, "activated", activationReceipt.applyManifestHash),
    retired: readMigrationPhaseRow(db, "retired", activationReceipt.applyManifestHash),
  }));
  if (lane.authority.state !== "active") {
    throw new StoreActivationError(
      "store.not-active",
      `the collaboration authority is ${lane.authority.state}; legacy sources are retired only after the activation barrier ` +
        `made it active. Nothing was retired.`,
    );
  }
  refuseUnlessSameGeneration(
    { storeId: lane.authority.storeId, epoch: lane.authority.epoch },
    { storeId: activationReceipt.storeId, epoch: activationReceipt.epoch },
    "the activation receipt",
  );
  // The activation phase is addressed by the reviewed import it published.
  // The supplied receipt's own hash must then BE the recorded activation: the
  // lane's phase row is the identity, and a drifted hash names another
  // activation.
  if (lane.activation === undefined) {
    throw new StoreActivationError(
      "store.activation-stale",
      `no activation is recorded for the reviewed import ${activationReceipt.applyManifestHash.slice(0, 16)} in this ` +
        `collaboration lane; nothing was retired.`,
    );
  }
  const recordedActivation = JSON.parse(lane.activation.resultJson) as Omit<ActivationReceipt, "replayed">;
  if (recordedActivation.activationHash !== activationReceipt.activationHash) {
    throw new StoreActivationError(
      "store.activation-stale",
      `the supplied activation hash ${activationReceipt.activationHash.slice(0, 16)} is not the one recorded for this import ` +
        `(${recordedActivation.activationHash.slice(0, 16)}); nothing was retired.`,
    );
  }
  if (recordedActivation.storeId !== lane.authority.storeId || recordedActivation.epoch !== lane.authority.epoch) {
    throw new StoreActivationError(
      "store.activation-stale",
      `the recorded activation belongs to store ${recordedActivation.storeId} epoch ${recordedActivation.epoch}, not this ` +
        `authority ${lane.authority.storeId} epoch ${lane.authority.epoch}; nothing was retired.`,
    );
  }
  if (lane.applied === undefined) {
    throw new StoreActivationError(
      "store.activation-stale",
      `the applied import behind this activation is missing from the collaboration lane; nothing was retired.`,
    );
  }
  const manifest = (JSON.parse(lane.applied.resultJson) as StoredApply).manifest;
  const meta = lane.authority;

  const registers = manifest.retirement.registers;
  const sections = manifest.catalog.retirementSections;
  const archiveDir = join(dirname(storeDbPath(context)), "archived", "store-migration", activationReceipt.applyManifestHash);
  const ledgerPath = join(archiveDir, "ledger.json");
  const retirementHash = sha256Bytes(
    Buffer.from(
      `retirement\u0000${JSON.stringify({
        applyManifestHash: activationReceipt.applyManifestHash,
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

  if (lane.retired !== undefined) {
    const receipt = JSON.parse(lane.retired.resultJson) as RetirementReceipt;
    const existing = readLedger(ledgerPath);
    if (existing !== undefined) finalizeDisclosure(ledgerPath, existing, receipt);
    return { ...receipt, replayed: true };
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
    applyManifestHash: activationReceipt.applyManifestHash,
    activationHash: activationReceipt.activationHash,
    storeId: meta.storeId,
    epoch: meta.epoch,
    archiveDir,
    successorDbPath: storeDbPath(context),
    backupPath: activationReceipt.backup.backupPath,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    retirementHash: null,
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

  const receipt: RetirementReceipt = {
    receiptVersion: ACTIVATION_PROTOCOL_VERSION,
    phase: "retired",
    replayed: false,
    retirementHash,
    applyManifestHash: activationReceipt.applyManifestHash,
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
  // The retirement phase row commits in ONE lane transaction: the receipt's
  // presence IS the completed retirement, so a crash before it leaves the
  // resumable ledger as the only witness.
  const written = await writeCollaborationStage(location, ({ db, authority }) => {
    if (authority.storeId !== meta.storeId || authority.epoch !== meta.epoch) {
      throw new StoreActivationError(
        "store.stale-epoch",
        `the authority changed generation while the sources were being retired (${meta.storeId} epoch ${meta.epoch} -> ` +
          `${authority.storeId} epoch ${authority.epoch}); nothing was recorded. Resume with the current activation receipt.`,
      );
    }
    insertMigrationPhaseRow(db, "retired", activationReceipt.applyManifestHash, receipt, at);
    return receipt;
  });
  ledger.retirementHash = receipt.retirementHash;
  finalizeDisclosure(ledgerPath, ledger, written);
  return written;
}
