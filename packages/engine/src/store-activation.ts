/**
 * store-activation.ts — the activation barrier, the retirement of the legacy
 * sources and the consistent backup (issue-store-contract §7).
 *
 * Boundaries this module owns, and does not cross:
 * - `activateStore` is the ONE point where the DB replaces the live registers
 *   as issue/catalog authority (§1, D19 `apply≠activate≠retire`). It requires
 *   the reviewed applied receipt, a strict installed-consumer attestation
 *   (concrete entrypoints/versions, quiesced sessions, the approving operator;
 *   never session credentials), revalidated exact source hashes/catalog
 *   digests, and a verified `VACUUM INTO` backup of the staged store. The
 *   revalidation runs twice: on the inspection connection, and again INSIDE the
 *   flip transaction, so a legacy write landing in the window after the
 *   inspection pass refuses instead of letting the epoch bump against sources
 *   that no longer hold the reviewed bytes. The authority-state flip, the epoch
 *   increment and the receipt row commit in ONE transaction — the epoch is
 *   atomic, not a follow-up write.
 * - Every receipt carries the authority generation (`storeId` + `epoch`), and
 *   `assertAuthorityCurrent` / the retirement re-check refuse a resumed handle
 *   or receipt from an earlier generation with `store.stale-epoch` instead of
 *   letting it act against a superseded generation (§5).
 * - `retireStoreSources` moves EXACT reviewed bytes into
 *   `<resolved root>/archived/store-migration/<activation-receipt-id>/` under
 *   a resumable per-item ledger. A late old-format write refuses
 *   `store.legacy-write-detected` and is never deleted. Mixed-content index
 *   files lose only their reviewed section lines; every other byte stays.
 * - The archived registers are historical migration input, never a rollback
 *   path: recovery after activation is the quiesced SQLite-consistent backup
 *   plus reconciliation (§7), and the marker says so explicitly.
 * - Nothing here reads or writes a lease, session, workflow snapshot or
 *   `status.json`. The migration path cannot steal, release or rebind a lease,
 *   and no marker or warning is treated as a fence against an old binary —
 *   the fence is the attestation, the revalidated hashes and the epoch.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { catalogRootDir, type CatalogRootKind } from "./catalog.js";
import { verifyCatalogImport } from "./catalog-import.js";
import { writeJson } from "./core.js";
import { migrationManifestHash, type MigrationManifest, type MigrationReceipt } from "./store-migrate.js";
import {
  MIN_BUN_VERSION,
  MIN_NODE_VERSION,
  MIGRATIONS,
  assertStoreRuntimeSupported,
  compareVersions,
  migrationChecksum,
  openStore,
  storeDbPath,
  StoreError,
  type ExecutionAuthorityState,
  type ExecutionMeta,
  type StoreContext,
  type StoreDb,
} from "./store-db.js";

/** Protocol version of the attestation, the receipts and the retirement ledger. */
export const ACTIVATION_PROTOCOL_VERSION = 1;

/** Stable refusal codes of the activation/retirement transport (§5 + §7). */
export type StoreActivationErrorCode =
  | "store.attestation-invalid"
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
  runtime: "bun" | "node";
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

/**
 * The operator attestation of the barrier. Only these fields are ever
 * recorded: an undeclared field (a token, a credential, a session secret)
 * refuses the attestation instead of travelling into the receipt.
 */
export type ActivationAttestation = {
  version: number;
  attestedAt: string;
  operator: { actor: string; authorizationRef: string };
  consumers: InstalledConsumerAttestation[];
  stoppedSessions: StoppedSessionAttestation[];
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
    catalogEntities: number;
    catalogLinks: number;
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
  const row = db
    .prepare("select store_id, authority_state, authority_epoch, revision, catalog_revision from store_meta where id = 1")
    .get() as Record<string, unknown> | undefined;
  if (
    !row ||
    typeof row.store_id !== "string" ||
    (row.authority_state !== "staged" && row.authority_state !== "active") ||
    typeof row.authority_epoch !== "number" ||
    typeof row.revision !== "number" ||
    typeof row.catalog_revision !== "number"
  ) {
    throw new StoreError("store.corrupt", "store_meta is missing or malformed; the authority generation cannot be verified");
  }
  return {
    storeId: row.store_id,
    authorityState: row.authority_state,
    epoch: row.authority_epoch,
    revision: row.revision,
    catalogRevision: row.catalog_revision,
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
  return {
    issues: scalar(db, "select count(*) as n from issues"),
    occurrences: scalar(db, "select count(*) as n from occurrences"),
    transitions: scalar(db, "select count(*) as n from issue_transitions"),
    catalogEntities: scalar(db, "select count(*) as n from catalog_entities"),
    catalogLinks: scalar(db, "select count(*) as n from catalog_links"),
    migrationReceipts: scalar(db, "select count(*) as n from migration_receipts"),
  };
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

// ---------------------------------------------------------------------------
// Backup — quiesced SQLite-consistent `VACUUM INTO` (§7 rollback/recovery)
// ---------------------------------------------------------------------------

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
 * immutable migration prefix — the same versions, names and checksums, in the
 * same order. A copy recording a migration this engine does not have was
 * written by a newer build (it is "too new" to be read or installed here), and
 * a copy whose recorded checksum differs is not this build's store. Neither is
 * accepted, so `store_id` equality alone can never make a foreign or future
 * file look like this store's recovery point.
 */
function assertCopySchemaIsThisBuild(db: StoreDb, backupPath: string): void {
  const rows = db
    .prepare("select version, name, checksum from schema_version order by version")
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
    if (
      row.version !== migration.version ||
      row.name !== migration.name ||
      row.checksum !== migrationChecksum(migration)
    ) {
      throw new StoreActivationError(
        "store.activation-stale",
        `the copy at ${backupPath} records migration ${String(row.version)} as ${JSON.stringify(row.name)} with checksum ` +
          `${JSON.stringify(row.checksum)}, not this build's ${JSON.stringify(migration.name)} (${migrationChecksum(migration)}); ` +
          `the copy is not this build's store.`,
      );
    }
  }
}

/**
 * A `VACUUM INTO` copy is not at `<root>/store.db`, so the store-open boundary
 * (which resolves exactly that path) cannot read it. Open the copy directly,
 * read-only and capability-checked, exactly like every other store access.
 *
 * The specifier cannot be a static import: contract §2 requires lazy,
 * capability-checked SQLite acquisition at store access — a top-level import
 * would acquire the driver whenever the engine package is imported.
 *
 * Exported as `inspectBackupCopy` because the restore protocol reads the same
 * verdict: §8's recovery point acceptance is ONE rule (identity, schema and
 * migration checksums, execution identity, row counts, `integrity_check` and
 * `foreign_key_check`), not a second copy of it in the recovery module.
 */
export async function inspectBackupCopy(backupPath: string): Promise<BackupInspection> {
  assertStoreRuntimeSupported();
  const { DatabaseSync } = (await import("node:sqlite")) as {
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
  return (
    a.issues === b.issues &&
    a.occurrences === b.occurrences &&
    a.transitions === b.transitions &&
    a.catalogEntities === b.catalogEntities &&
    a.catalogLinks === b.catalogLinks &&
    a.migrationReceipts === b.migrationReceipts
  );
}

/** Default backup path under the resolved control root (never a cwd-local path). */
function defaultBackupPath(context: StoreContext, meta: LiveMeta, label?: string): string {
  const name = label === undefined ? `${meta.storeId.slice(0, 8)}-e${meta.epoch}-r${meta.revision}.db` : `${label}.db`;
  return join(dirname(storeDbPath(context)), "archived", "store-migration", "backups", name);
}

/**
 * Take (or, for the activation resume path, re-verify) one consistent backup.
 * `VACUUM INTO` reads through the WAL, so committed-but-uncheckpointed data is
 * in the copy; the copy is reopened read-only and its identity, schema version
 * and row counts must equal the source before the path is accepted.
 */
async function takeVerifiedBackup(
  context: StoreContext,
  options: { out?: string; label?: string; reuseMatchingIdentity: boolean },
): Promise<BackupReceipt> {
  const dbPath = storeDbPath(context);
  const handle = await openStore(context, "write");
  try {
    const meta = readMetaRow(handle.db);
    const schemaVersion = schemaVersionOf(handle.db);
    const counts = countsOf(handle.db);
    // §8: the copy must describe the SAME execution authority as the live
    // store — protocol version, state, root revision, root timestamp and
    // manifest identity included. A copy that predates the execution schema
    // (`null`) never matches an execution-bearing live store.
    const execution = liveExecutionMeta(handle.execution);
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
      let existing: BackupInspection;
      try {
        existing = await inspectBackupCopy(targetPath);
      } catch (error) {
        throw new StoreActivationError(
          "store.activation-stale",
          `the existing backup at ${targetPath} cannot be verified (${(error as Error).message}). Refusing to overwrite a ` +
            `recorded recovery point.`,
        );
      }
      if (
        existing.storeId !== meta.storeId ||
        existing.epoch !== meta.epoch ||
        existing.revision !== meta.revision ||
        existing.catalogRevision !== meta.catalogRevision ||
        existing.authorityState !== meta.authorityState ||
        existing.schemaVersion !== schemaVersion ||
        !sameExecution(existing.execution, execution)
      ) {
        throw new StoreActivationError(
          "store.activation-stale",
          `the existing backup at ${targetPath} does not describe this store (identity/epoch/revision/schema/execution mismatch). ` +
            `Refusing to overwrite a recorded recovery point.`,
        );
      }
      return {
        receiptVersion: ACTIVATION_PROTOCOL_VERSION,
        backupPath: targetPath,
        ...existing,
        walPending,
        bytes: statSync(targetPath).size,
        takenAt: new Date().toISOString(),
      };
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    handle.db.prepare("vacuum into ?").run(targetPath);
    let verified: BackupInspection;
    try {
      verified = await inspectBackupCopy(targetPath);
    } catch (error) {
      rmSync(targetPath, { force: true });
      throw new StoreActivationError(
        "store.activation-stale",
        `the backup written to ${targetPath} could not be reopened for verification (${(error as Error).message}); ` +
          `the unverified copy was removed. Nothing was activated.`,
      );
    }
    if (
      verified.storeId !== meta.storeId ||
      verified.epoch !== meta.epoch ||
      verified.revision !== meta.revision ||
      verified.catalogRevision !== meta.catalogRevision ||
      verified.authorityState !== meta.authorityState ||
      verified.schemaVersion !== schemaVersion ||
      !sameExecution(verified.execution, execution) ||
      !sameCounts(verified.counts, counts)
    ) {
      rmSync(targetPath, { force: true });
      throw new StoreActivationError(
        "store.activation-stale",
        `the backup written to ${targetPath} does not match the source store (identity, schema or row counts); ` +
          `the unverified copy was removed. Nothing was activated.`,
      );
    }
    return {
      receiptVersion: ACTIVATION_PROTOCOL_VERSION,
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
 * copy that records the store identity (store_id, epoch, revision, catalog
 * revision, authority state, schema version) and the row counts verified in
 * the copy itself.
 */
export async function backupStore(context: StoreContext, options: { out?: string } = {}): Promise<BackupReceipt> {
  return takeVerifiedBackup(context, { out: options.out, reuseMatchingIdentity: false });
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
    receipt.receiptVersion !== ACTIVATION_PROTOCOL_VERSION ||
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

const CONSUMER_KINDS: Record<AttestationConsumerKind, true> = { cli: true, "host-plugin": true, hook: true, coordinator: true };
const DISPOSITIONS: Record<AttestationDisposition, true> = {
  reloaded: true,
  upgraded: true,
  "excluded:not-this-control-root": true,
  "excluded:no-store-access": true,
  "excluded:superseded-binary": true,
};
const SESSION_STATES: Record<"stopped" | "reloaded", true> = { stopped: true, reloaded: true };

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
          `quiesced sessions and the approving operator \u2014 never session credentials or other data.`,
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
 * Validate one attestation and project it onto the declared shape. Missing
 * consumer or current-coordinator attestation, a below-floor consumer, a
 * session that was never stopped and any credential-bearing field all refuse
 * here — before a byte is written.
 */
export function validateActivationAttestation(value: unknown): ActivationAttestation {
  const raw = attestationObject(value, "the attestation");
  attestationKeys(raw, ["version", "attestedAt", "operator", "consumers", "stoppedSessions"], "the attestation");
  if (raw.version !== ACTIVATION_PROTOCOL_VERSION) {
    attestationRefusal(`the attestation version must be ${ACTIVATION_PROTOCOL_VERSION}`);
  }
  const attestedAt = attestationString(raw, "attestedAt", "the attestation");
  if (!Number.isFinite(Date.parse(attestedAt))) attestationRefusal("the attestation.attestedAt must be an ISO/RFC3339 instant");

  const operator = attestationObject(raw.operator, "the attestation.operator");
  attestationKeys(operator, ["actor", "authorizationRef"], "the attestation.operator");
  const actor = attestationString(operator, "actor", "the attestation.operator");
  const authorizationRef = attestationString(operator, "authorizationRef", "the attestation.operator");

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
    if (runtime !== "bun" && runtime !== "node") attestationRefusal(`${what}.runtime must be "bun" or "node"`);
    const entryId = attestationString(consumer, "entryId", what);
    const runtimeVersion = attestationString(consumer, "runtimeVersion", what);
    const floor = runtime === "bun" ? MIN_BUN_VERSION : MIN_NODE_VERSION;
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
  const stoppedSessions: StoppedSessionAttestation[] = raw.stoppedSessions.map((entry, index) => {
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

  return { version: ACTIVATION_PROTOCOL_VERSION, attestedAt, operator: { actor, authorizationRef }, consumers, stoppedSessions };
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
 * Revalidate the reviewed manifest against the live sources: the register set
 * and every byte digest, plus the reviewed catalog source digests. The barrier
 * refuses a stale final hash; retirement refuses a late old-format write —
 * which is why the same check names the refusal differently per mode.
 */
function revalidateSources(context: StoreContext, manifest: MigrationManifest, mode: "activation" | "retirement"): void {
  const reviewed = new Set(manifest.sources.map((source) => source.relativePath));
  const retired = new Set(manifest.retirement.registers.map((register) => register.relativePath));
  const changed = (detail: string, lateWrite: boolean): never => {
    if (mode === "retirement" && lateWrite) {
      throw new StoreActivationError(
        "store.legacy-write-detected",
        `${detail} The transition stopped and the written bytes were NOT deleted; an old consumer is still writing ` +
          `old-format data. Quiesce/reload it, re-preview and re-apply, then resume retirement.`,
      );
    }
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
      changed(`an unreviewed legacy register appeared at ${source.relativePath}.`, true);
    }
  }
  for (const reviewedSource of manifest.sources) {
    const bytes = readIfExists(join(catalogRootDir(context, "projects"), reviewedSource.relativePath));
    if (bytes !== undefined && sha256Bytes(bytes) === reviewedSource.sha256) continue;
    // A register an earlier retirement attempt already moved is verified per
    // item against the archive instead of against the live file.
    if (bytes === undefined && retired.has(reviewedSource.relativePath)) continue;
    if (bytes === undefined) changed(`register ${reviewedSource.relativePath} is gone.`, false);
    changed(`register ${reviewedSource.relativePath} no longer holds the reviewed bytes.`, true);
  }
}

/**
 * The catalog half of the final hash check (reviewed index source digests).
 * In retirement, a section the ledger already excised is EXPECTED to have
 * changed: its recorded post-excision digest is tolerated so a resumed run
 * continues to the end instead of mistaking its own completed work for a late
 * old-format write.
 */
async function revalidateCatalogSources(
  context: StoreContext,
  manifest: MigrationManifest,
  mode: "activation" | "retirement",
  ledger?: RetirementLedger,
): Promise<void> {
  const verification = await verifyCatalogImport(context, manifest.catalog);
  const drift = verification.drift.filter(
    (item) =>
      !(
        mode === "retirement" &&
        item.actualSha256 !== null &&
        ledger?.sections.some(
          (section) =>
            section.rootKind === item.rootKind && section.relativePath === item.relativePath && section.expectedLiveSha256 === item.actualSha256,
        )
      ),
  );
  if (drift.length === 0) return;
  const changedCount = drift.filter((item) => item.state === "changed").length;
  const first = drift[0]!;
  if (changedCount > 0 && mode === "retirement") {
    throw new StoreActivationError(
      "store.legacy-write-detected",
      `retired index source ${first.sourceKey} (${first.relativePath}) changed after activation (${changedCount} changed of ` +
        `${drift.length} drifted); an old consumer wrote old-format index data. The transition stopped and the file was NOT ` +
        `rewritten; quiesce it, re-preview and re-apply, then resume retirement.`,
    );
  }
  throw new StoreActivationError(
    "store.migration-source-changed",
    `catalog source ${first.sourceKey} (${first.relativePath}) is ${first.state} since review (${drift.length} drifted). ` +
      `Nothing was ${mode === "activation" ? "activated" : "retired"}; re-run the preview, review the final manifest and apply it.`,
  );
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

/** The recorded applied receipt for a reviewed manifest (§7); read-only. */
export async function appliedReceiptFor(context: StoreContext, manifest: MigrationManifest): Promise<MigrationReceipt> {
  const handle = await openStore(context, "read");
  try {
    const row = readReceiptRows(handle.db, "phase = 'applied' and manifest_hash = ?", migrationManifestHash(manifest))[0];
    if (!row) {
      throw new StoreActivationError(
        "store.activation-stale",
        "the reviewed manifest has no recorded apply receipt; apply it first (store migrate --apply --manifest <path>).",
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
    const row = findActivationRow(readReceiptRows(handle.db, "phase = 'activated'"), apply.manifestHash);
    if (!row) {
      throw new StoreActivationError(
        "store.activation-stale",
        `the applied receipt for manifest ${apply.manifestHash.slice(0, 12)} has no recorded activation; run "store activate" ` +
          `with the reviewed manifest and attestation first.`,
      );
    }
    return activationReceiptOfRow(row, true);
  } finally {
    handle.close();
  }
}

/** The activation row of one applied manifest, newest first. */
function findActivationRow(rows: ReceiptRow[], applyManifestHash: string): ReceiptRow | undefined {
  for (const row of [...rows].reverse()) {
    try {
      if ((JSON.parse(row.manifest_json) as { applyManifestHash?: string }).applyManifestHash === applyManifestHash) return row;
    } catch {
      // a malformed receipt row cannot claim this activation
    }
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
 * Test seams, gated exactly like the store's other failure injections: honored
 * only under `MSTAR_STORE_TEST_RUNNER=1`, so a shipped CLI/plugin process can
 * never reach them. `MSTAR_STORE_FAIL_ACTIVATION_AFTER=flip` throws after the
 * authority flip and before the receipt row, inside the SAME transaction, so
 * the barrier's atomicity is observable instead of asserted;
 * `MSTAR_STORE_FAIL_RETIREMENT_AFTER=<n>` throws after the n-th item was
 * archived and ledged, and `MSTAR_STORE_FAIL_RETIREMENT_AFTER_SECTION_WRITE=1`
 * throws between a section's live rewrite and its verification — so both
 * retirement resume windows are exercised for real.
 */
function failureHook(stage: "flip" | "retirement" | "section-write", completed: number): void {
  if (process.env.MSTAR_STORE_TEST_RUNNER !== "1") return;
  if (stage === "flip") {
    if (process.env.MSTAR_STORE_FAIL_ACTIVATION_AFTER === "flip") throw new Error("induced activation failure after the authority flip");
    return;
  }
  if (stage === "section-write") {
    if (process.env.MSTAR_STORE_FAIL_RETIREMENT_AFTER_SECTION_WRITE === "1") {
      throw new Error("induced retirement failure after the section rewrite");
    }
    return;
  }
  const raw = process.env.MSTAR_STORE_FAIL_RETIREMENT_AFTER;
  if (raw === undefined || raw === "") return;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed === completed) throw new Error(`induced retirement failure after ${completed} item(s)`);
}

/**
 * Second test seam, gated the same way: an OLD BINARY that lands a register
 * write in the window between the inspection pass and the barrier transaction
 * — the window the barrier-time revalidation closes. The seam only copies
 * bytes; which register and which bytes are the test's, so no fixture shape
 * lives here. Inert without `MSTAR_STORE_TEST_RUNNER=1`, so no shipped CLI,
 * plugin or hook process can reach it.
 */
function legacyWriteHook(stage: "inspection"): void {
  if (process.env.MSTAR_STORE_TEST_RUNNER !== "1") return;
  if (process.env.MSTAR_STORE_INJECT_LEGACY_WRITE_AFTER !== stage) return;
  const target = process.env.MSTAR_STORE_INJECT_LEGACY_WRITE_TARGET;
  const source = process.env.MSTAR_STORE_INJECT_LEGACY_WRITE_FROM;
  if (target === undefined || source === undefined) return;
  copyFileSync(source, target);
}

// ---------------------------------------------------------------------------
// Activation barrier (§7)
// ---------------------------------------------------------------------------

/**
 * `activateStore(context, receipt, attestation)` — the barrier. Requires the
 * reviewed applied receipt to be the FINAL one (latest applied manifest,
 * unchanged sources and catalog digests, no post-apply store change), a valid
 * attestation, and a verified consistent backup. It then flips the authority
 * state and increments the epoch atomically with the receipt row.
 */
export async function activateStore(
  context: StoreContext,
  receipt: MigrationReceipt,
  attestation: ActivationAttestation,
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
      "the activation requires the reviewed apply receipt (receiptId, manifestHash, storeRevision); re-apply the reviewed manifest.",
    );
  }
  const validated = validateActivationAttestation(attestation);
  const attestationHash = sha256Bytes(Buffer.from(`attestation\u0000${JSON.stringify(validated)}`, "utf8"));

  const inspection = await openStore(context, "write");
  let meta: LiveMeta;
  let manifest: MigrationManifest;
  try {
    meta = readMetaRow(inspection.db);
    if (meta.authorityState === "active") {
      const row = findActivationRow(readReceiptRows(inspection.db, "phase = 'activated'"), receipt.manifestHash);
      if (!row) {
        throw new StoreActivationError(
          "store.activation-stale",
          "the store is already active under a different activation; the authority generation cannot be replaced by a new receipt.",
        );
      }
      const recorded = activationReceiptOfRow(row, true);
      if (recorded.attestationHash !== attestationHash) {
        throw new StoreActivationError(
          "store.activation-stale",
          `this manifest was already activated under a different attestation (recorded ${recorded.attestationHash.slice(0, 12)}, ` +
            `supplied ${attestationHash.slice(0, 12)}); activation history is immutable \u2014 reuse the recorded attestation.`,
        );
      }
      return recorded;
    }

    const appliedRow = readReceiptRows(inspection.db, "phase = 'applied' and manifest_hash = ?", receipt.manifestHash)[0];
    if (!appliedRow || appliedRow.id !== receipt.receiptId) {
      throw new StoreActivationError(
        "store.activation-stale",
        `the supplied receipt (#${receipt.receiptId}, manifest ${receipt.manifestHash.slice(0, 12)}) is not the recorded apply ` +
          `receipt of this store; re-apply the reviewed manifest and use its receipt. Nothing was activated.`,
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
    if (migrationManifestHash(manifest) !== receipt.manifestHash) {
      throw new StoreActivationError(
        "store.activation-stale",
        "the recorded applied manifest does not hash to the receipt's manifest hash; the store cannot be activated against it.",
      );
    }
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
    // First of two: this pass refuses a drifted source before the recovery
    // point is written. The decisive one runs inside the flip transaction.
    revalidateSources(context, manifest, "activation");
    await revalidateCatalogSources(context, manifest, "activation");
  } finally {
    inspection.close();
  }

  // The recovery point is taken on its own connection, after the validations
  // and before the barrier transaction: the staged store is quiesced (attested)
  // and never has two writers open at once.
  const backup = await takeVerifiedBackup(context, {
    label: `pre-activation-${meta.storeId.slice(0, 8)}-r${meta.revision}`,
    reuseMatchingIdentity: true,
  });

  // Test seam: an old binary writes a register here — after the inspection pass
  // above and before the barrier transaction below.
  legacyWriteHook("inspection");

  const flip = await openStore(context, "write");
  try {
    const at = new Date().toISOString();
    flip.db.exec("begin immediate");
    try {
      const current = readMetaRow(flip.db);
      if (current.authorityState !== "staged" || current.storeId !== meta.storeId || current.revision !== meta.revision) {
        throw new StoreActivationError(
          "store.activation-stale",
          "the staged store changed while the barrier was running; the activation was rolled back. Re-check and retry.",
        );
      }
      // Barrier-time byte fence. The inspection pass ran on its own connection
      // and the recovery point was taken after it, so a legacy writer could have
      // landed register bytes or an index section in between. Revalidate the
      // reviewed register bytes and catalog digests HERE, inside the flip
      // transaction: the epoch never bumps against sources that no longer hold
      // the reviewed bytes, whatever landed after the inspection.
      //
      // Documented trade (QC seat 3 S-001): this fence performs register byte
      // hashing and async catalog digest reads while the `begin immediate`
      // write lock is held, so the lock window scales with the catalog source
      // count. That is acceptable BY PRECONDITION: activation runs only on a
      // QUIESCED STAGED store — the attestation validation above has stopped
      // every registered reader/writer session before this transaction opens,
      // so no concurrent writer can be starved and the in-window I/O is bounded
      // by the reviewed source set, not by contention. The fence stays
      // in-transaction deliberately: hoisting it before the lock would reopen
      // the inspection→flip race this fence exists to close. A non-quiesced
      // caller is already refused by the attestation gate; this note records
      // the precondition so a future caller does not widen the window.
      revalidateSources(context, manifest, "activation");
      await revalidateCatalogSources(context, manifest, "activation");
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
      failureHook("flip", 0);
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
        attestation: validated,
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
          JSON.stringify({ consumers: validated.consumers.length, stoppedSessions: validated.stoppedSessions.length }),
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

/** Line count that ignores a single trailing newline (catalog-import's rule). */
function lineCountOf(text: string): number {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines.length;
}

/**
 * Remove the reviewed section lines while keeping every other byte verbatim:
 * the splice works on character offsets, never on re-joined line arrays, so
 * narrative, security dispositions and report prose survive exactly.
 */
function removeSectionLines(text: string, startLine: number, endLine: number, what: string): string {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new StoreActivationError("store.migration-source-changed", `${what} carries an invalid reviewed section range`);
  }
  const total = lineCountOf(text);
  if (endLine > total) {
    throw new StoreActivationError(
      "store.migration-source-changed",
      `${what} has ${total} line(s) but the reviewed section ends at line ${endLine}; the file no longer matches the reviewed ` +
        `section. Nothing was retired.`,
    );
  }
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  const from = starts[startLine - 1]!;
  const to = endLine < starts.length ? starts[endLine]! : text.length;
  return text.slice(0, from) + text.slice(to);
}

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
    "Recovery after activation uses the quiesced SQLite-consistent `VACUUM INTO` backup above plus reconciliation.",
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
 * Move one register out of the live root: copy first (so the exact original
 * bytes exist before anything is removed), verify the copy, then unlink the
 * live file. A crash between the steps resumes from the ledger: the archive is
 * the witness and the live file (if still present) must still hold the
 * reviewed bytes.
 */
function retireRegister(context: StoreContext, ledgerPath: string, ledger: RetirementLedger, item: LedgerRegisterItem): void {
  const livePath = join(catalogRootDir(context, "projects"), item.relativePath);
  const liveBytes = readIfExists(livePath);
  if (liveBytes !== undefined) {
    const liveHash = sha256Bytes(liveBytes);
    if (liveHash !== item.sha256) {
      const archivedHash = (() => {
        const archived = readIfExists(item.archivePath);
        return archived === undefined ? null : sha256Bytes(archived);
      })();
      throw new StoreActivationError(
        "store.legacy-write-detected",
        `register ${item.relativePath} was written again with different bytes (live ${liveHash.slice(0, 12)} != reviewed ` +
          `${item.sha256.slice(0, 12)}${archivedHash === item.sha256 ? "; the reviewed bytes are already archived" : ""}). ` +
          `The transition stopped and the written file was NOT deleted; an old consumer is still writing old-format data. ` +
          `Quiesce it, re-preview and re-apply, then resume retirement.`,
      );
    }
    mkdirSync(dirname(item.archivePath), { recursive: true });
    rmSync(item.archivePath, { force: true });
    copyFileSync(livePath, item.archivePath);
    if (sha256Bytes(readFileSync(item.archivePath)) !== item.sha256) {
      throw new StoreActivationError(
        "store.migration-source-changed",
        `the archived copy of ${item.relativePath} does not match the reviewed bytes; nothing was deleted and the copy is ` +
          `unverified. Re-run retirement to retry the copy.`,
      );
    }
    item.state = "archived";
    writeLedger(ledgerPath, ledger);
  } else if (readIfExists(item.archivePath) === undefined) {
    throw new StoreActivationError(
      "store.migration-source-changed",
      `register ${item.relativePath} is gone and no archive copy exists; the reviewed source cannot be retired truthfully. ` +
        `Nothing was retired.`,
    );
  }
  const archivedBytes = readFileSync(item.archivePath);
  if (sha256Bytes(archivedBytes) !== item.sha256) {
    throw new StoreActivationError(
      "store.migration-source-changed",
      `the archived copy of ${item.relativePath} does not match the reviewed bytes; nothing was deleted.`,
    );
  }
  const stillLive = readIfExists(livePath);
  if (stillLive !== undefined) {
    if (sha256Bytes(stillLive) !== item.sha256) {
      throw new StoreActivationError(
        "store.legacy-write-detected",
        `register ${item.relativePath} was rewritten while it was being archived; the live file was NOT deleted. Quiesce the ` +
          `old consumer, re-preview and re-apply, then resume retirement.`,
      );
    }
    unlinkSync(livePath);
  }
  item.state = "verified";
  writeLedger(ledgerPath, ledger);
}

function verifyArchivedRegister(item: LedgerRegisterItem): void {
  const archived = readIfExists(item.archivePath);
  if (archived === undefined || sha256Bytes(archived) !== item.sha256) {
    throw new StoreActivationError(
      "store.migration-source-changed",
      `the archived register ${item.relativePath} no longer matches the reviewed bytes; refusing to claim retirement.`,
    );
  }
}

/**
 * Excise one reviewed index section: archive the whole original file, then
 * rewrite the live file without only those lines. Every other byte — narrative,
 * security dispositions, human report content — survives verbatim.
 */
function retireSection(context: StoreContext, ledgerPath: string, ledger: RetirementLedger, item: LedgerSectionItem): void {
  const livePath = join(catalogRootDir(context, item.rootKind), ...relativePathSegments(item.relativePath));
  const live = readIfExists(livePath)?.toString("utf8");
  if (live === undefined) {
    throw new StoreActivationError(
      "store.migration-source-changed",
      `catalog source ${item.rootKind}:${item.relativePath} is gone; the reviewed section cannot be retired truthfully. ` +
        `Nothing was retired.`,
    );
  }
  const liveHash = sha256Bytes(Buffer.from(live, "utf8"));
  if (item.expectedLiveSha256 !== null && liveHash === item.expectedLiveSha256) {
    // Crash after the rewrite, before the ledger recorded it: verify and finish.
    verifyRetiredSection(livePath, item);
    item.state = "verified";
    writeLedger(ledgerPath, ledger);
    return;
  }
  if (liveHash !== item.sha256) {
    throw new StoreActivationError(
      "store.legacy-write-detected",
      `catalog source ${item.rootKind}:${item.relativePath} changed after activation (live ${liveHash.slice(0, 12)} != reviewed ` +
        `${item.sha256.slice(0, 12)}); an old consumer wrote old-format index data. The transition stopped and the file was NOT ` +
        `rewritten; quiesce it, re-preview and re-apply, then resume retirement.`,
    );
  }
  const excised = removeSectionLines(live, item.startLine, item.endLine, `catalog source ${item.relativePath}`);
  const removedLines = item.endLine - item.startLine + 1;
  if (lineCountOf(excised) !== lineCountOf(live) - removedLines) {
    throw new StoreActivationError(
      "store.migration-source-changed",
      `removing the reviewed section from ${item.relativePath} did not remove exactly ${removedLines} line(s); nothing was rewritten.`,
    );
  }
  mkdirSync(dirname(item.archivePath), { recursive: true });
  rmSync(item.archivePath, { force: true });
  copyFileSync(livePath, item.archivePath);
  if (sha256Bytes(readFileSync(item.archivePath)) !== item.sha256) {
    throw new StoreActivationError(
      "store.migration-source-changed",
      `the archived copy of ${item.rootKind}:${item.relativePath} does not match the reviewed bytes; nothing was rewritten.`,
    );
  }
  item.expectedLiveSha256 = sha256Bytes(Buffer.from(excised, "utf8"));
  writeLedger(ledgerPath, ledger);
  writeTextAtomic(livePath, excised);
  failureHook("section-write", 0);
  verifyRetiredSection(livePath, item);
  item.state = "verified";
  writeLedger(ledgerPath, ledger);
}

function verifyRetiredSection(livePath: string, item: LedgerSectionItem): void {
  const live = readIfExists(livePath)?.toString("utf8");
  if (live === undefined || item.expectedLiveSha256 === null || sha256Bytes(Buffer.from(live, "utf8")) !== item.expectedLiveSha256) {
    throw new StoreActivationError(
      "store.legacy-write-detected",
      `catalog source ${item.rootKind}:${item.relativePath} no longer holds the reviewed section-excised bytes; the transition ` +
        `stopped and the file was NOT rewritten.`,
    );
  }
  if (lineCountOf(live) !== item.preservedLines) {
    throw new StoreActivationError(
      "store.migration-source-changed",
      `catalog source ${item.relativePath} has ${lineCountOf(live)} preserved line(s) but the reviewed manifest recorded ` +
        `${item.preservedLines}; refusing to claim retirement.`,
    );
  }
  const archived = readIfExists(item.archivePath);
  if (archived === undefined || sha256Bytes(archived) !== item.sha256) {
    throw new StoreActivationError(
      "store.migration-source-changed",
      `the archived original of ${item.relativePath} no longer matches the reviewed bytes; refusing to claim retirement.`,
    );
  }
}

/**
 * `retireStoreSources(context, activationReceipt)` — move the exact reviewed
 * sources out of the live root under a resumable per-item ledger. Revalidates
 * the live DB identity, the authority epoch, the activation receipt, the exact
 * source hashes and the catalog digests first; a resumed attempt continues
 * from the recorded item states to exactly the recorded bytes and sections; an
 * unexpected legacy write stops the transition without deleting anything.
 */
export async function retireStoreSources(context: StoreContext, activationReceipt: ActivationReceipt): Promise<RetirementReceipt> {
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
    const activationRow = readReceiptRows(handle.db, "phase = 'activated' and manifest_hash = ?", activationReceipt.activationHash)[0];
    if (!activationRow) {
      throw new StoreActivationError(
        "store.activation-stale",
        `no activation receipt #${activationReceipt.receiptId} with hash ${activationReceipt.activationHash.slice(0, 12)} is recorded ` +
          `for this store; nothing was retired.`,
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
    if (migrationManifestHash(manifest) !== activationReceipt.applyManifestHash) {
      throw new StoreActivationError(
        "store.activation-stale",
        "the applied manifest behind this activation does not hash to the activation receipt's manifest hash; nothing was retired.",
      );
    }

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

    const recorded = readReceiptRows(handle.db, "phase = 'retired' and manifest_hash = ?", retirementHash)[0];
    if (recorded) {
      const receipt = retirementReceiptOfRow(recorded, true);
      const existing = readLedger(ledgerPath);
      if (existing) finalizeDisclosure(ledgerPath, existing, receipt);
      return receipt;
    }

    const existingLedger = readLedger(ledgerPath);
    if (
      existingLedger &&
      (existingLedger.activationHash !== activationReceipt.activationHash ||
        existingLedger.storeId !== meta.storeId ||
        existingLedger.epoch !== meta.epoch)
    ) {
      throw new StoreActivationError(
        "store.activation-stale",
        `the retirement ledger at ${ledgerPath} belongs to a different activation generation; refusing to resume another ` +
          `generation's partial retirement. Nothing was retired.`,
      );
    }
    revalidateSources(context, manifest, "retirement");
    await revalidateCatalogSources(context, manifest, "retirement", existingLedger);
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
          archivePath: join(archiveDir, "index-sections", section.rootKind, ...relativePathSegments(section.relativePath)),
          expectedLiveSha256: null,
          state: "pending" as const,
        }))
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.startLine - b.startLine),
    };
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
      failureHook("retirement", completed);
    }
    for (const item of ledger.sections) {
      if (item.state === "verified") {
        verifyRetiredSection(join(catalogRootDir(context, item.rootKind), ...relativePathSegments(item.relativePath)), item);
        continue;
      }
      retireSection(context, ledgerPath, ledger, item);
      completed += 1;
      failureHook("retirement", completed);
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
      removedLines: item.endLine - item.startLine + 1,
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
