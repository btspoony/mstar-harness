/**
 * collaboration-cutover.ts -- the one-way authority cutover from the combined
 * control store to the per-repository collaboration store.
 *
 * One reviewed manifest drives the whole state machine (Data Model - Cutover
 * state machine): `plan` reads the source and freezes the evidence, `apply`
 * copies one transactionally consistent snapshot into the canonical STAGED
 * target and verifies it, and `activate` claims the target for this exact
 * manifest, retains a verified combined recovery point, fences the source in
 * one transaction and publishes the target.
 *
 * Every durable step lives in exactly one file and is proven by its own
 * receipt, so an interrupted activation resumes instead of repeating a step:
 * a held claim is resumed while the source is provably unfenced, a committed
 * fence is reused by the same manifest, and an active target replays its own
 * publication receipt verbatim. A competing source, mode or manifest refuses
 * before either contender fences its source; nothing is guessed, merged or
 * rolled forward from a partial target.
 *
 * Bindings to the rest of the engine: `planCollaborationCutover` /
 * `applyCollaborationCutover` / `activateCollaborationCutover` are the exported
 * protocol; `fenceCollaborationCutoverSource` is the durable fence step they
 * drive (also the resume entry a fenced-but-unpublished source needs).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  resolveCollaborationLocation,
  type CollaborationLocation,
  type CollaborationMode,
} from "./collaboration-identity.js";
import {
  COLLABORATION_COLUMNS,
  COLLABORATION_CUTOVER_TABLES,
  initializeCollaborationStore,
  readCollaborationStage,
  writeCollaborationStage,
  type CollaborationAuthority,
  type CollaborationStamp,
} from "./collaboration-store.js";
import {
  MIGRATIONS,
  StoreError,
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

/** The single claim slot on the canonical target: one activation at a time. */
const CLAIM_KEY = "collaboration-cutover-claim";

/** The oldest source schema this build can extract (the combined store's cutover base). */
const SOURCE_SCHEMA_FLOOR = MIGRATIONS[MIGRATIONS.length - 2]!.version;

type Blockers = readonly Readonly<{ code: string; subject: string }>[];

type SourceSnapshot = Readonly<{
  source: CutoverSource;
  counts: Record<string, number>;
  digest: string;
  rows: Record<string, unknown[][]>;
}>;

type SourceState = Readonly<{
  fence: CollaborationFence | null;
  snapshot: SourceSnapshot | null;
  blockers: Blockers;
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
  source: SourceState;
  target: TargetState;
}>;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Stable JSON: object keys sorted, so equal semantics always hash equally. */
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

function tableExists(db: StoreDb, table: string): boolean {
  const row = db
    .prepare("select count(*) as n from sqlite_master where type = 'table' and name = ?")
    .get(table) as { n?: number } | undefined;
  return row?.n === 1;
}

function readRows(db: StoreDb, table: string, columns: readonly string[]): unknown[][] {
  const list = columns.join(", ");
  const rows = db.prepare(`select ${list} from ${table} order by ${list}`).all() as Array<Record<string, unknown>>;
  // SQLite hands back bigints for values beyond the safe integer range.
  return rows.map((row) => columns.map((column) => (typeof row[column] === "bigint" ? String(row[column]) : row[column])));
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
    rows[table] = readRows(db, table, columns);
  }
  return rows;
}

function countsOf(rows: Record<string, unknown[][]>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of COLLABORATION_CUTOVER_TABLES) counts[table] = rows[table]?.length ?? 0;
  return counts;
}

function digestOfRows(rows: Record<string, unknown[][]>): string {
  const hash = createHash("sha256");
  for (const table of COLLABORATION_CUTOVER_TABLES) {
    hash.update(`${table}\n`);
    for (const row of rows[table] ?? []) hash.update(`${JSON.stringify(row)}\n`);
  }
  return hash.digest("hex");
}

/** The source digest freezes BOTH the generation stamp and the exact rows. */
function digestOfSource(source: CutoverSource, rows: Record<string, unknown[][]>): string {
  return sha256(
    `${source.storeId}|${source.epoch}|${source.schemaVersion}|${source.revision}|${source.catalogRevision}\n` +
      digestOfRows(rows),
  );
}

/**
 * The pending work that must be settled before a source may be fenced: an open
 * mirror run still owns the ledger, and a catalog journal entry that has not
 * committed still describes an in-flight registration.
 */
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
    .prepare("select operation_id, phase from catalog_operations where phase <> 'committed' order by operation_id")
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
  // suits a reviewed local database; stream it if collaboration rows reach
  // hundreds of megabytes.
  const rows = readCutoverRows(db);
  const source: CutoverSource = {
    storeId: authority.storeId,
    epoch: authority.epoch,
    schemaVersion,
    revision: authority.revision,
    catalogRevision: authority.catalogRevision,
  };
  return { source, counts: countsOf(rows), rows, digest: digestOfSource(source, rows) };
}

async function readSourceState(context: StoreContext): Promise<SourceState> {
  const handle = await openStore(context, "read");
  try {
    const fence = readCollaborationFence(handle.db);
    if (fence !== null) return { fence, snapshot: null, blockers: [] };
    // One read transaction: the counted rows, the digest and the blocker scan
    // all describe one committed generation of the source.
    handle.db.exec("begin");
    try {
      return {
        fence: null,
        snapshot: readSourceSnapshot(handle.db),
        blockers: readCutoverBlockers(handle.db),
      };
    } finally {
      handle.db.exec("commit");
    }
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

/**
 * The supplied manifest must be the reviewed output of `planCollaborationCutover`
 * for this exact content: its id is derived from the body, so a hand-edited or
 * fabricated manifest cannot name a different source or row population.
 */
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
  for (const table of COLLABORATION_CUTOVER_TABLES) {
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
  return COLLABORATION_CUTOVER_TABLES.every((table) => a[table] === b[table]);
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

function assertFenceMatches(fence: CollaborationFence, manifest: CutoverManifest, digest: string): void {
  if (fence.manifestId !== manifest.manifestId || fence.manifestDigest !== digest) {
    throw conflict(
      `The combined store was already fenced for manifest ${fence.manifestId} (fenced at ${fence.fencedAt}), not for ` +
        `${manifest.manifestId}. Preserve both sides: complete the activation of the fenced manifest, or plan a new ` +
        `cutover only after reconciling the target. Nothing was changed.`,
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

/** Read the target's own rows for one manifest id (the publication table is keyed by it). */
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
  if (!sameCounts(countsOf(rows), manifest.counts) || digestOfSource(manifest.source, rows) !== manifest.sourceDigest) {
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

/** Replace the staged business rows with the source snapshot, exactly. */
function replaceStagedRows(db: StoreDb, rows: Record<string, unknown[][]>): void {
  for (const table of [...COLLABORATION_CUTOVER_TABLES].reverse()) db.prepare(`delete from ${table}`).run();
  for (const table of COLLABORATION_CUTOVER_TABLES) {
    const columns = COLLABORATION_COLUMNS[table]!;
    const statement = db.prepare(
      `insert into ${table}(${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
    );
    for (const row of rows[table] ?? []) statement.run(...row);
  }
}

function ensureFenceSchema(db: StoreDb): number {
  const fenceMigration = MIGRATIONS[MIGRATIONS.length - 1]!;
  const applied = readAppliedMigrations(db, false);
  const max = validateAppliedMigrations(applied);
  if (max >= fenceMigration.version) return max;
  if (max !== fenceMigration.version - 1) {
    throw new StoreError(
      "store.schema-drift",
      `The combined store is at schema ${max}, not the cutover's predecessor ${fenceMigration.version - 1}. Run ` +
        `"mstar store upgrade --operator <name>" to reach the current schema; nothing was fenced.`,
    );
  }
  db.exec(fenceMigration.sql);
  db.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)").run(
    fenceMigration.version,
    fenceMigration.name,
    migrationChecksum(fenceMigration),
    nowRfc3339(),
  );
  return validateAppliedMigrations(readAppliedMigrations(db, false));
}

export async function planCollaborationCutover(context: StoreContext): Promise<CutoverManifest> {
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

export async function applyCollaborationCutover(
  context: StoreContext,
  manifest: CutoverManifest,
): Promise<CutoverReceipt> {
  const digest = assertManifest(manifest);
  const location = resolveCollaborationLocation(context);
  assertManifestScope(location, manifest);
  if (manifest.blockers.length > 0) {
    throw notQuiescent(manifest.blockers, "The reviewed manifest still reports pending work.");
  }
  const state = await readSourceState(context);
  if (state.fence !== null) {
    assertFenceMatches(state.fence, manifest, digest);
    const target = await readTargetStateFor(location, manifest.manifestId);
    if (target === null) {
      throw conflict(
        `The source is fenced for this manifest, but no staged target exists at ${location.dbPath}. Restore the ` +
          `verified pre-fence image and complete the activation in the session that fenced it; nothing was written.`,
      );
    }
    if (target.publication === null) {
      throw conflict(
        `The source is fenced for manifest ${manifest.manifestId}, but the target holds no publication record for it. ` +
          `Preserve both sides and complete the activation from the original session; nothing was written.`,
      );
    }
    return receiptOf(target.publication, location, true);
  }
  assertSnapshotMatches(state.snapshot!, manifest, "The source changed since the manifest was reviewed.");

  await initializeCollaborationStore(location);
  return writeCollaborationStage(location, ({ db, authority }) => {
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
      if (publication !== null && publication.phase === "active" && publication.manifestDigest === digest) {
        return receiptOf(publication, location, true);
      }
      throw conflict(
        `The collaboration store at ${location.dbPath} is already active as ${authority.storeId}, so it is not a ` +
          `staging target. Read it through the runtime verbs; a different source needs an already active repository ` +
          `authority, not a forced publication. Nothing was written.`,
      );
    }
    // One staged slot per canonical target: another manifest may only restage
    // over the SAME source, and only while that source is still unfenced.
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

    replaceStagedRows(db, state.snapshot!.rows);
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
    // A restage replaces the evidence for the target: the previous manifest no longer describes the staged rows.
    db.prepare("delete from cutover_publications where manifest_id <> ?").run(manifest.manifestId);
    const stored = readPublication(db, manifest.manifestId)!;
    return receiptOf(stored, location, replayed);
  });
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
  const source = await readSourceState(context);
  if (source.fence === null) {
    assertSnapshotMatches(source.snapshot!, manifest, "The source changed since the manifest was reviewed.");
    if (source.blockers.length > 0) {
      throw notQuiescent(source.blockers, "The source reported pending work when activation started.");
    }
  } else {
    assertFenceMatches(source.fence, manifest, digest);
  }
  if (target.authority.state === "active") {
    const published = target.publication;
    if (published === null || published.phase !== "active" || published.manifestDigest !== digest) {
      throw conflict(
        `The collaboration store at ${location.dbPath} is active, but not for manifest ${manifest.manifestId}. Read it ` +
          `through the runtime verbs; an active authority is never republished or replaced. Nothing was written.`,
      );
    }
    return { context, location, manifest, digest, operator, source, target, replay: receiptOf(published, location, true) };
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
  return { context, location, manifest, digest, operator, source, target, replay: null };
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
    const ownClaim =
      claim.manifestId === manifest.manifestId &&
      claim.sourceStoreId === manifest.source.storeId &&
      claim.sourceEpoch === manifest.source.epoch;
    if (ownClaim) {
      // Proven unfenced (the source was read in this activation) and the
      // reviewed observation drifted: release this activation's own claim so a
      // re-plan can proceed, and report the drift.
      db.prepare("delete from collaboration_operations where key_space = 'standalone' and operation_id = ?").run(CLAIM_KEY);
      throw conflict(
        `The reviewed observation drifted since this activation was claimed (claimed at ${claim.claimedAt}), and the ` +
          `source is still unfenced, so the claim was released. Re-plan and apply the new manifest; nothing was fenced ` +
          `or activated.`,
      );
    }
    throw conflict(
      `Another activation holds the canonical target's claim (manifest ${claim.manifestId}, source ` +
        `${claim.sourceStoreId} epoch ${claim.sourceEpoch}, claimed at ${claim.claimedAt}). Preserve both; complete or ` +
        `abandon that activation in its own session. Nothing was fenced.`,
    );
  });
}

/**
 * The verified combined image the fence leaves behind. An attempt that already
 * wrote it re-verifies the same bytes, so a retry after a crash does not overwrite
 * a recorded recovery point and a drifted source never reuses a stale one.
 */
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
    return out;
  };
  if (existsSync(out)) return verify(await inspectBackupCopy(out));
  try {
    await backupStore(context, { out });
  } catch (error) {
    throw backupIncomplete(
      `The source recovery point could not be written to ${out} ` +
        `(${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  return verify(await inspectBackupCopy(out));
}

/**
 * The durable fence: one source transaction that re-proves the manifest,
 * advances the recorded schema (so an older binary refuses this file), records
 * the fence and drops exactly the moved collaboration tables. Execution rows,
 * tokens, plans, sessions, leases and the source epoch are not touched.
 */
async function fenceSource(prepared: Prepared, backupPath: string): Promise<CollaborationFence> {
  const { context, manifest, digest, target } = prepared;
  const handle = await openStore(context, "write");
  try {
    handle.db.exec("begin immediate");
    try {
      const existing = readCollaborationFence(handle.db);
      if (existing !== null) {
        assertFenceMatches(existing, manifest, digest);
        handle.db.exec("commit");
        return existing;
      }
      const snapshot = readSourceSnapshot(handle.db);
      assertSnapshotMatches(snapshot, manifest, "The source changed after staging and before fencing.");
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
      for (const table of [...COLLABORATION_CUTOVER_TABLES].reverse()) handle.db.exec(`drop table ${table}`);
      handle.db.exec("commit");
      return {
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
    } catch (error) {
      try {
        handle.db.exec("rollback");
      } catch {
        // nothing committed either way
      }
      throw error;
    }
  } finally {
    handle.close();
  }
}

/** Record the fenced phase on the target; the source fence row stays the authority. */
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
  const publication = await readTargetStateFor(prepared.location, manifest.manifestId);
  return receiptOf(publication!.publication!, prepared.location, false);
}

export async function activateCollaborationCutover(
  context: StoreContext,
  manifest: CutoverManifest,
  options: CutoverActivationOptions,
): Promise<CutoverReceipt> {
  const prepared = await prepareActivation(context, manifest, options);
  if (prepared.replay !== null) return prepared.replay;
  if (prepared.source.fence !== null) {
    // The fence committed before the target did: reuse it and publish only.
    return publishTarget(prepared, prepared.source.fence);
  }
  await claimActivation(prepared);
  const backupPath = await takeOrVerifyFenceBackup(prepared);
  const fence = await fenceSource(prepared, backupPath);
  await recordFenced(prepared, fence);
  return publishTarget(prepared, fence);
}
