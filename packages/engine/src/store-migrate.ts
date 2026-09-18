/**
 * store-migrate.ts -- the read-only migration planner
 * (issue-store-contract §3/§7).
 *
 * Boundaries this module owns, and does not cross:
 * - `planStoreMigration` is READ-ONLY over the named legacy source roots: the
 *   four live project residual registers enumerated through the configured
 *   project resolver (never a hard-coded `.mstar`, never `_default` only) and
 *   the legacy catalog index sources through P2 `discoverCatalog`. It opens no
 *   database, writes no file and creates no receipt (§7 "Preview writes no DB
 *   or receipt").
 * - Every source row is classified. The default is one original entry → one
 *   issue (§3); a row becomes an unresolved mapping only when the legacy
 *   evidence is missing required fields or carries a lifecycle/severity the
 *   declared vocabulary does not define. Unresolved rows BLOCK apply; unknown
 *   legacy semantics are returned for review, never guessed.
 * - Legacy vocabulary mapping is the explicit reviewed table of §3:
 *   `open`/absent → open, `resolved` → resolved, `wont-fix` → waived (keeping
 *   the exact legacy label verbatim in provenance, never relabelled
 *   "resolved"), `superseded` → superseded, plus the existing
 *   `normalizeSeverity` legacy severity rules. Every original field survives
 *   verbatim in `legacyJson`.
 * - The legacy source identity is the stable tuple `(resolved relative
 *   register path, project, bucket, entry id)` (§3): equal ids in DIFFERENT
 *   buckets are distinct rows, a duplicate id within ONE bucket is a refused
 *   source, and a synthetic backlog bucket name stays provenance — never a
 *   fabricated plan.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { discoverCatalog, verifyCatalogImport, type CatalogImportPlan } from "./catalog-import.js";
import { catalogRootDir } from "./catalog.js";
import { initializeStore, openStore, storeDbPath, StoreError, type StoreContext, type StoreDb, type StoreHandle } from "./store-db.js";
import { computeIdentityKey, type Disposition, type IssueKind, type Severity } from "./issue.js";
import { isOpenResidual, normalizeSeverity } from "./status.js";

/** Transport version of a `MigrationManifest` (§7). */
export const MIGRATION_MANIFEST_VERSION = 1;

/** The constant proposed kind for legacy register rows, declared in the vocabulary. */
const LEGACY_ISSUE_KIND: IssueKind = "review-obligation";

/** Stable refusal codes for the migration transport (§7 + Task G1b). */
export type StoreMigrationErrorCode =
  | "store.migration-duplicate-entry"
  | "store.migration-manifest-invalid"
  | "store.migration-unresolved"
  | "store.migration-source-changed"
  | "store.migration-active-store"
  | "store.migration-row-removed";

export class StoreMigrationError extends Error {
  readonly code: StoreMigrationErrorCode;

  constructor(code: StoreMigrationErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "StoreMigrationError";
    this.code = code;
  }
}

/** Declared legacy → issue vocabulary (§3/§7 "legacy vocabulary mapping"). */
export type MigrationVocabulary = {
  /** `lifecycle=open` or absent maps to open; wont-fix is the explicit waived mapping. */
  lifecycle: Record<string, Disposition>;
  /** Legacy absent/empty → medium, `warning` → low (existing normalizeSeverity rules); `nit` → info. */
  severity: Record<string, Severity>;
  /** Legacy rows carry no kind; the constant proposed kind is declared here. */
  kind: IssueKind;
};

export const MIGRATION_VOCABULARY: MigrationVocabulary = {
  lifecycle: {
    open: "open",
    resolved: "resolved",
    waived: "waived",
    "wont-fix": "waived",
    superseded: "superseded",
    duplicate: "duplicate",
  },
  severity: {
    critical: "critical",
    high: "high",
    medium: "medium",
    low: "low",
    warning: "low",
    nit: "info",
  },
  kind: LEGACY_ISSUE_KIND,
};

/** The stable legacy source identity tuple (§3). */
export type MigrationSourceIdentity = {
  /** Register path relative to the projects root, posix separators. */
  registerPath: string;
  project: string;
  /** The entries key (plan id or synthetic backlog bucket name). */
  bucket: string;
  entryId: string;
};

/** One legacy register file as read, with its byte digest and parsed counts. */
export type MigrationSourceFile = {
  project: string;
  relativePath: string;
  sha256: string;
  bytes: number;
  entryCount: number;
  openCount: number;
  closedCount: number;
};

/** One classified source row (§7 "proposed issue IDs or reviewed decisions"). */
export type MigrationEntryMapping = {
  source: MigrationSourceIdentity;
  classification: "issue";
  disposition: Disposition;
  severity: Severity;
  kind: IssueKind;
  /** Deterministic proposed issue id (`I-` + 6-digit counter, §3 sort order). */
  proposedIssueId: string;
  /** The exact legacy labels this row was mapped FROM (verbatim, never relabelled). */
  legacy: { lifecycle: string | null; decision: string | null; severity: string | null; closedAt: string | null };
  /** The full original entry, every field preserved losslessly (§3). */
  legacyJson: string;
};

/** What the planner could not resolve; each entry blocks apply (§3/§7). */
export type MigrationUnknown = {
  code: "register-unreadable" | "invalid-register" | "missing-field" | "unknown-lifecycle" | "unknown-severity";
  source: MigrationSourceIdentity | null;
  detail: string;
};

/** Sources proposed for retirement at activation: whole registers plus P2 index sections. */
export type MigrationRetirement = {
  registers: { project: string; relativePath: string; sha256: string }[];
  indexSections: CatalogImportPlan["retirementSections"];
};

/** The reviewable full manifest (§7). */
export type MigrationManifest = {
  version: number;
  controlRoot: string;
  sources: MigrationSourceFile[];
  /** SHA-256 over the sorted `(relativePath, sha256)` tuple set. */
  sourceSetDigest: string;
  mappings: MigrationEntryMapping[];
  unresolved: MigrationUnknown[];
  vocabulary: MigrationVocabulary;
  retirement: MigrationRetirement;
  /** The P2 catalog dry-run inventory embedded verbatim (conflicts block). */
  catalog: CatalogImportPlan;
  /** True when any unresolved mapping or catalog conflict blocks apply. */
  blocksApply: boolean;
};

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Enumerate the live legacy registers through the configured project resolver:
 * every directory under the resolved projects root that holds a
 * `residuals.json` regular file (symlinks never followed). This is all four
 * live projects by construction — never `_default` alone and never a
 * hard-coded `.mstar` path.
 */
function registerSources(context: StoreContext): { project: string; absolutePath: string; relativePath: string }[] {
  const projectsRoot = catalogRootDir(context, "projects");
  let entries: Dirent[];
  try {
    entries = readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const sources: { project: string; absolutePath: string; relativePath: string }[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const registerPath = join(projectsRoot, entry.name, "residuals.json");
    let info;
    try {
      info = lstatSync(registerPath);
    } catch {
      continue; // a project directory without a register has nothing to migrate
    }
    if (info.isSymbolicLink() || !info.isFile()) continue;
    sources.push({ project: entry.name, absolutePath: registerPath, relativePath: `${entry.name}/residuals.json` });
  }
  return sources;
}

type BucketRows = { bucket: string; rows: { entryId: string; entry: Record<string, unknown> }[] };

/**
 * Parse one register document into per-bucket rows. Structural failures land
 * in `unresolved` (blocking) instead of being skipped silently; a duplicate
 * entry id WITHIN one bucket refuses the whole preview (§3 — an error, not a
 * row), while the same id in different buckets stays distinct.
 */
function parseRegister(
  text: string,
  source: { project: string; relativePath: string },
  unresolved: MigrationUnknown[],
): BucketRows[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    unresolved.push({
      code: "register-unreadable",
      source: null,
      detail: `${source.relativePath} is not valid JSON: ${(error as Error).message}`,
    });
    return [];
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    unresolved.push({ code: "invalid-register", source: null, detail: `${source.relativePath} is not a register object` });
    return [];
  }
  const entries = (doc as { entries?: unknown }).entries;
  if (entries !== undefined && (entries === null || typeof entries !== "object" || Array.isArray(entries))) {
    unresolved.push({ code: "invalid-register", source: null, detail: `${source.relativePath} entries must be an object keyed by plan id` });
    return [];
  }
  const buckets: BucketRows[] = [];
  for (const bucket of Object.keys(entries as Record<string, unknown>).sort()) {
    const value = (entries as Record<string, unknown>)[bucket];
    if (!Array.isArray(value)) {
      unresolved.push({
        code: "invalid-register",
        source: null,
        detail: `${source.relativePath} entries[${JSON.stringify(bucket)}] must be an array of residual entries`,
      });
      continue;
    }
    const rows: BucketRows["rows"] = [];
    const seen = new Set<string>();
    let refused = false;
    for (const raw of value) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        unresolved.push({
          code: "invalid-register",
          source: null,
          detail: `${source.relativePath} entries[${JSON.stringify(bucket)}] holds a non-object entry`,
        });
        refused = true;
        continue;
      }
      const entry = raw as Record<string, unknown>;
      const entryId = typeof entry.id === "string" ? entry.id : "";
      if (entryId === "") {
        unresolved.push({
          code: "missing-field",
          source: { registerPath: source.relativePath, project: source.project, bucket, entryId: "" },
          detail: `${source.relativePath} entries[${JSON.stringify(bucket)}] holds an entry without a string id`,
        });
        refused = true;
        continue;
      }
      if (seen.has(entryId)) {
        throw new StoreMigrationError(
          "store.migration-duplicate-entry",
          `${source.relativePath} bucket ${JSON.stringify(bucket)} holds duplicate entry id ${JSON.stringify(entryId)}; ` +
            "the source must be repaired before a manifest can be planned",
        );
      }
      seen.add(entryId);
      rows.push({ entryId, entry });
    }
    if (!refused) buckets.push({ bucket, rows });
  }
  return buckets;
}

/**
 * Classify one source row against the declared vocabulary (§3). A row whose
 * required finding evidence is missing or whose lifecycle/severity the
 * vocabulary does not define becomes an UNRESOLVED mapping that blocks apply;
 * nothing is synthesized.
 */
/** The legacy required finding fields (status.ts `RESIDUAL_REQUIRED_FIELDS` vocabulary). */
const LEGACY_REQUIRED_FIELDS = [
  "id",
  "title",
  "severity",
  "source",
  "scope",
  "decision",
  "owner",
  "target",
  "tracking",
] as const;

function classifyEntry(
  source: MigrationSourceIdentity,
  entry: Record<string, unknown>,
  vocabulary: MigrationVocabulary,
  unresolved: MigrationUnknown[],
): { disposition: Disposition; severity: Severity } | null {
  // Required finding evidence is checked for PRESENCE, not with the new-entry
  // validator: legal legacy labels such as `wont-fix` and `warning` never
  // satisfy the new-entry enum and must map through the reviewed vocabulary,
  // not refuse the preview (§3).
  const missing = LEGACY_REQUIRED_FIELDS.filter((field) => {
    const value = entry[field];
    return typeof value !== "string" || value.trim() === "";
  });
  if (missing.length > 0) {
    unresolved.push({
      code: "missing-field",
      source,
      detail: `entry ${JSON.stringify(source.entryId)} is missing required finding evidence: ${missing.map((field) => JSON.stringify(field)).join(", ")}`,
    });
    return null;
  }
  // jq semantics: an absent (or null/false) lifecycle is open (isOpenResidual).
  const effectiveLifecycle = isOpenResidual(entry) ? "open" : String(entry.lifecycle);
  const disposition = vocabulary.lifecycle[effectiveLifecycle];
  if (disposition === undefined) {
    unresolved.push({
      code: "unknown-lifecycle",
      source,
      detail: `entry ${JSON.stringify(source.entryId)} carries lifecycle ${JSON.stringify(String(entry.lifecycle))}, which the reviewed vocabulary does not define; a per-row decision is required`,
    });
    return null;
  }
  const normalized = normalizeSeverity(entry.severity);
  const severity = typeof normalized === "string" ? vocabulary.severity[normalized] : undefined;
  if (severity === undefined) {
    unresolved.push({
      code: "unknown-severity",
      source,
      detail: `entry ${JSON.stringify(source.entryId)} carries severity ${JSON.stringify(entry.severity)}, which the reviewed vocabulary does not define; a per-row decision is required`,
    });
    return null;
  }
  return { disposition, severity };
}

/**
 * `planStoreMigration(context)` -- the read-only migration planner (§7):
 * enumerate every legacy register through the configured project resolver,
 * classify every row, embed the P2 catalog dry-run inventory, and return the
 * reviewable manifest with byte digests, a source-set digest and retirement
 * sections. Creates no database and writes nothing. A duplicate entry id
 * within one bucket refuses the preview; unresolved mappings and catalog
 * conflicts surface in the manifest and block apply.
 */
export async function planStoreMigration(context: StoreContext): Promise<MigrationManifest> {
  const unresolved: MigrationUnknown[] = [];
  const sources: MigrationSourceFile[] = [];
  const rows: { source: MigrationSourceIdentity; entry: Record<string, unknown> }[] = [];

  for (const source of registerSources(context)) {
    const bytes = readFileSync(source.absolutePath);
    const buckets = parseRegister(bytes.toString("utf8"), source, unresolved);
    let openCount = 0;
    let closedCount = 0;
    for (const { bucket, rows: entries } of buckets) {
      for (const { entryId, entry } of entries) {
        if (isOpenResidual(entry)) openCount += 1;
        else closedCount += 1;
        rows.push({ source: { registerPath: source.relativePath, project: source.project, bucket, entryId }, entry });
      }
    }
    sources.push({
      project: source.project,
      relativePath: source.relativePath,
      sha256: sha256Bytes(bytes),
      bytes: bytes.length,
      entryCount: openCount + closedCount,
      openCount,
      closedCount,
    });
  }

  // Deterministic first-allocation order (§3): project / path / bucket / entry id.
  rows.sort(
    (a, b) =>
      a.source.project.localeCompare(b.source.project) ||
      a.source.registerPath.localeCompare(b.source.registerPath) ||
      a.source.bucket.localeCompare(b.source.bucket) ||
      a.source.entryId.localeCompare(b.source.entryId),
  );

  const mappings: MigrationEntryMapping[] = [];
  for (const [index, row] of rows.entries()) {
    const classified = classifyEntry(row.source, row.entry, MIGRATION_VOCABULARY, unresolved);
    if (classified === null) continue;
    mappings.push({
      source: row.source,
      classification: "issue",
      disposition: classified.disposition,
      severity: classified.severity,
      kind: MIGRATION_VOCABULARY.kind,
      proposedIssueId: `I-${String(index + 1).padStart(6, "0")}`,
      legacy: {
        lifecycle: typeof row.entry.lifecycle === "string" ? row.entry.lifecycle : null,
        decision: typeof row.entry.decision === "string" ? row.entry.decision : null,
        severity: typeof row.entry.severity === "string" ? row.entry.severity : null,
        closedAt: typeof row.entry.closed_at === "string" ? row.entry.closed_at : null,
      },
      legacyJson: JSON.stringify(row.entry),
    });
  }

  // The catalog half of the manifest is the P2 dry-run inventory, verbatim and
  // still read-only: conflicts block apply, no source is silently preferred.
  const catalog = await discoverCatalog(context);

  const sourceSetDigest = sha256Bytes(
    Buffer.from(
      sources
        .map((source) => `${source.relativePath}\u0000${source.sha256}\n`)
        .sort()
        .join(""),
      "utf8",
    ),
  );

  return {
    version: MIGRATION_MANIFEST_VERSION,
    controlRoot: context.harnessDir,
    sources,
    sourceSetDigest,
    mappings,
    unresolved,
    vocabulary: MIGRATION_VOCABULARY,
    retirement: {
      registers: sources.map((source) => ({ project: source.project, relativePath: source.relativePath, sha256: source.sha256 })),
      indexSections: catalog.retirementSections,
    },
    catalog,
    blocksApply: unresolved.length > 0 || catalog.conflicts.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Staged apply (§7)
// ---------------------------------------------------------------------------

/** The stable legacy source tuple key used for ID mapping and reconciliation. */
function tupleKeyOf(source: MigrationSourceIdentity): string {
  return [source.registerPath, source.project, source.bucket, source.entryId].join("\u0000");
}

function migrationSourceIdentity(tuple: string, project: string, bucket: string, entryId: string): string {
  return `${tuple}|${project}|${bucket}|${entryId}`;
}

/** Canonical hash of a manifest: every field a reviewer saw, without the derived `blocksApply`. */
export function migrationManifestHash(manifest: MigrationManifest): string {
  const { blocksApply: _blocksApply, ...rest } = manifest;
  return sha256Bytes(Buffer.from(JSON.stringify(rest), "utf8"));
}

/** One persistent source→issue ID assignment recorded in the receipt (§3/§7). */
export type MigrationIdMapping = {
  source: MigrationSourceIdentity;
  issueId: string;
};

/** The receipt of a completed staged apply (§7 `migration_receipts`). */
export type MigrationReceipt = {
  receiptId: number;
  manifestHash: string;
  phase: "applied";
  /** True when an identical manifest replayed the recorded receipt without writes. */
  replayed: boolean;
  /** The persistent legacy-source-tuple → issue ID mapping. */
  issueIds: MigrationIdMapping[];
  counts: {
    issues: number;
    open: number;
    closed: number;
    catalogEntities: number;
    catalogLinks: number;
    /** Rows created/updated by THIS apply (0 on a replay). */
    created: number;
    updated: number;
  };
  storeRevision: number;
  appliedAt: string;
};

type StoredReceipt = {
  id: number;
  manifest_hash: string;
  mapping_json: string;
  source_counts_json: string;
  applied_at: string;
};

function readReceipts(db: StoreDb): StoredReceipt[] {
  return db
    .prepare("select id, manifest_hash, mapping_json, source_counts_json, applied_at from migration_receipts order by id")
    .all() as StoredReceipt[];
}

function receiptOfStored(stored: StoredReceipt, replayed: boolean): MigrationReceipt {
  // mapping_json carries the full assigned mapping; the receipt discloses the
  // persistent (source → issueId) pairs.
  const storedMapping = JSON.parse(stored.mapping_json) as MigrationMappingWithId[];
  const counts = JSON.parse(stored.source_counts_json) as MigrationReceipt["counts"];
  return {
    receiptId: stored.id,
    manifestHash: stored.manifest_hash,
    phase: "applied",
    replayed,
    issueIds: storedMapping.map((entry) => ({ source: entry.source, issueId: entry.issueId })),
    counts: { ...counts, created: 0, updated: 0 },
    storeRevision: counts.storeRevision,
    appliedAt: stored.applied_at,
  };
}

/**
 * Re-enumerate the legacy registers and compare BOTH the source set and every
 * byte hash against the reviewed manifest (§7). Added/missing/changed refuses
 * `store.migration-source-changed` before the database is opened — no writes.
 */
async function assertSourcesUnchanged(context: StoreContext, manifest: MigrationManifest): Promise<void> {
  const current = registerSources(context);
  const currentPaths = current.map((source) => source.relativePath).sort();
  const manifestPaths = manifest.sources.map((source) => source.relativePath).sort();
  if (currentPaths.length !== manifestPaths.length || currentPaths.some((path, index) => path !== manifestPaths[index])) {
    throw new StoreMigrationError(
      "store.migration-source-changed",
      `the legacy register set changed since the manifest was reviewed ` +
        `(manifest: ${manifestPaths.length} registers, current: ${currentPaths.length}); ` +
        "re-run the preview and have the new manifest reviewed. Nothing was written.",
    );
  }
  for (const source of current) {
    const reviewed = manifest.sources.find((candidate) => candidate.relativePath === source.relativePath);
    if (!reviewed) {
      throw new StoreMigrationError(
        "store.migration-source-changed",
        `register ${source.relativePath} is not in the reviewed manifest; nothing was written.`,
      );
    }
    const digest = sha256Bytes(readFileSync(source.absolutePath));
    if (digest !== reviewed.sha256) {
      throw new StoreMigrationError(
        "store.migration-source-changed",
        `register ${source.relativePath} changed bytes since the manifest was reviewed ` +
          `(expected ${reviewed.sha256.slice(0, 12)}, actual ${digest.slice(0, 12)}); ` +
          "re-run the preview and have the new manifest reviewed. Nothing was written.",
      );
    }
  }
  const catalog = await verifyCatalogImport(context, manifest.catalog);
  if (catalog.drift.length > 0) {
    const first = catalog.drift[0]!;
    throw new StoreMigrationError(
      "store.migration-source-changed",
      `catalog source ${first.sourceKey} (${first.relativePath}) is ${first.state} since review ` +
        `(expected ${first.expectedSha256.slice(0, 12)}, actual ${first.actualSha256 === null ? "none" : first.actualSha256.slice(0, 12)}); ` +
        `${catalog.drift.length} catalog source(s) drifted. Nothing was written.`,
    );
  }
}

function readCounter(db: StoreDb): number {
  const row = db.prepare("select next_value from issue_counter where id = 1").get() as { next_value?: number } | undefined;
  if (typeof row?.next_value !== "number") {
    throw new StoreError("store.corrupt", "issue_counter is missing; the store cannot allocate issue IDs");
  }
  return row.next_value;
}

/**
 * Open the store for the staged apply, creating the staged database when the
 * legacy workspace has none. The create-only initializer refuses legacy
 * workspaces (§2), so the migration apply is the ONLY path that gives one a
 * store — created through C1's schema primitive and immediately held in
 * `staged` state (§1: import is not activation; a staged store is read-only
 * to ordinary domain verbs).
 *
 * Crash safety: the create and the demotion cannot share one transaction
 * across C1's primitive, so a crash between them would leave an ACTIVE EMPTY
 * store. The next apply detects exactly that artifact — an active store with
 * no issues, occurrences, transitions, provenance, catalog rows, operations
 * or receipts in a workspace that provably holds legacy registers (this
 * function only runs under apply's source precondition) — recovers it to
 * staged, and proceeds. An active store holding ANY data is a live store and
 * still refuses `store.migration-active-store`.
 */
async function ensureStagedStore(context: StoreContext): Promise<StoreHandle> {
  if (!existsSync(storeDbPath(context))) {
    const created = await initializeStore(context);
    created.close();
  }
  const handle = await openStore(context, "write");
  try {
    const meta = handle.db.prepare("select authority_state from store_meta where id = 1").get() as
      | { authority_state?: string }
      | undefined;
    if (meta?.authority_state !== "staged") {
      const empty = isSemanticallyEmptyStore(handle.db);
      if (meta?.authority_state === "active" && empty) {
        // The crashed create+demote artifact: an active store that has never
        // held a single domain row, in a workspace that only a migration
        // apply would be writing against. Recover it truthfully to staged.
        handle.db.exec("begin immediate");
        try {
          handle.db.exec("update store_meta set authority_state = 'staged', activated_at = NULL where id = 1");
          handle.db.exec("commit");
        } catch (error) {
          try {
            handle.db.exec("rollback");
          } catch {
            // nothing committed either way
          }
          throw error;
        }
      } else {
        throw new StoreMigrationError(
          "store.migration-active-store",
          meta?.authority_state === "active"
            ? "the store is active and already holds data; a live active store cannot be overwritten by reimporting a manifest. Nothing was written."
            : "the store is not staged; nothing was written.",
        );
      }
    }
    return handle;
  } catch (error) {
    try {
      handle.close();
    } catch {
      // already closed on a connection-level failure
    }
    throw error;
  }
}

/**
 * True when the store carries no domain row at all — the shape of the store
 * the migration create path leaves behind if it crashes before the demotion.
 */
function isSemanticallyEmptyStore(db: StoreDb): boolean {
  const tables = [
    "issues",
    "occurrences",
    "issue_transitions",
    "provenance",
    "relations",
    "catalog_entities",
    "catalog_links",
    "catalog_operations",
    "migration_receipts",
    "store_operations",
  ];
  for (const table of tables) {
    const row = db.prepare(`select count(*) as n from ${table}`).get() as { n?: number } | undefined;
    if (row?.n !== 0) return false;
  }
  return true;
}

function allocateIssueId(db: StoreDb): string {
  const next = readCounter(db);
  db.prepare("update issue_counter set next_value = next_value + 1 where id = 1").run();
  return `I-${String(next).padStart(6, "0")}`;
}

type ImportRow = {
  mapping: MigrationEntryMapping;
  tuple: string;
  entry: Record<string, unknown>;
};

function parseImportRow(mapping: MigrationMappingWithId): ImportRow {
  return { mapping, tuple: tupleKeyOf(mapping.source), entry: JSON.parse(mapping.legacyJson) as Record<string, unknown> };
}

/** Mapping plus the effective issue id assigned at apply time. */
type MigrationMappingWithId = MigrationEntryMapping & { issueId: string };

function verbatimString(entry: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "";
}

/**
 * Insert one migrated issue with its capture occurrence, migration
 * provenance and (for a closed row) the single imported terminal transition
 * (§3). Every original field travels losslessly in `provenance.legacy_json`;
 * timestamps keep their original lexeme or stay NULL — nothing is
 * synthesized.
 */
function insertMigratedIssue(db: StoreDb, row: ImportRow, issueId: string, at: string): "created" | "reused" {
  const existing = db.prepare("select id from issues where id = ?").get(issueId) as { id?: string } | undefined;
  if (existing) return "reused"; // reconciliation: the tuple already owns this id
  const { mapping, entry } = row;
  const source = mapping.source;
  const identity = migrationSourceIdentity("legacy", source.project, source.bucket, source.entryId);
  const identityKey = computeIdentityKey(source.project, identity, "legacy-register", mapping.legacy.decision ?? "open");
  const registeredAt = typeof entry.registered_at === "string" && entry.registered_at.trim() !== "" ? entry.registered_at : null;
  const closed = mapping.disposition !== "open";
  const closedAt = closed ? mapping.legacy.closedAt : null;
  const closureNote = typeof entry.closure_note === "string" && entry.closure_note.trim() !== "" ? entry.closure_note : null;
  // impact/acceptance are NOT NULL columns; they carry the ORIGINAL verbatim
  // fields (impact/scope and acceptance/decision) — never synthesized text.
  const impact = verbatimString(entry, "impact", "scope");
  const acceptance = verbatimString(entry, "acceptance", "decision");
  db.prepare(
    "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, owner, registered_at, closed_at, closure_note, created_at, updated_at, revision, identity_key) " +
      "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
  ).run(
    issueId,
    source.project,
    verbatimString(entry, "title"),
    mapping.kind,
    mapping.severity,
    mapping.disposition,
    impact,
    acceptance,
    typeof entry.owner === "string" && entry.owner.trim() !== "" ? entry.owner : null,
    registeredAt,
    closedAt,
    closureNote,
    at,
    at,
    identityKey,
  );
  // One imported capture occurrence per row (§3).
  db.prepare(
    "insert into occurrences(issue_id, occurrence_key, source_kind, source_identity, root_cause_key, acceptance_key, location, observed_behavior, evidence_json, discovered_at, recorded_at, imported) " +
      "values (?, ?, 'legacy-register', ?, 'legacy-register', ?, ?, ?, ?, NULL, ?, 1)",
  ).run(
    issueId,
    `migration:${identity}`,
    identity,
    mapping.legacy.decision ?? "open",
    source.registerPath,
    verbatimString(entry, "title"),
    mapping.legacyJson,
    at,
  );
  // Typed migration provenance with the full lossless record.
  db.prepare(
    "insert into provenance(issue_id, kind, target, source_hash, legacy_project, legacy_bucket, legacy_entry_id, legacy_json, imported_at) " +
      "values (?, 'migration', ?, ?, ?, ?, ?, ?, ?)",
  ).run(issueId, source.registerPath, createHash("sha256").update(mapping.legacyJson, "utf8").digest("hex"), source.project, source.bucket, source.entryId, mapping.legacyJson, at);
  // A closed row also carries its single imported terminal transition (§3).
  if (closed) {
    insertImportedTerminalTransition(db, issueId, mapping.disposition, closedAt, mapping.legacyJson, at);
  }
  return "created";
}

/** The single imported terminal transition of a closed migrated row (§3). */
function insertImportedTerminalTransition(
  db: StoreDb,
  issueId: string,
  disposition: Disposition,
  closedAt: string | null,
  legacyJson: string,
  at: string,
): void {
  db.prepare(
    "insert into issue_transitions(issue_id, from_disposition, to_disposition, actor, occurred_at, recorded_at, reason, evidence_json, imported, issue_revision) " +
      "values (?, 'open', ?, NULL, ?, ?, 'legacy import (reviewed manifest)', ?, 1, 1)",
  ).run(issueId, disposition, closedAt, at, legacyJson);
}

/** Migration-owned columns reconciled when a re-reviewed manifest changes a row. */
function reconcileMigratedIssue(db: StoreDb, row: ImportRow, issueId: string, at: string): void {
  const { mapping, entry } = row;
  const closed = mapping.disposition !== "open";
  const prior = db.prepare("select disposition from issues where id = ?").get(issueId) as
    | { disposition?: string }
    | undefined;
  db.prepare(
    "update issues set title = ?, severity = ?, disposition = ?, closed_at = ?, closure_note = ?, updated_at = ? where id = ?",
  ).run(
    verbatimString(entry, "title"),
    mapping.severity,
    mapping.disposition,
    closed ? mapping.legacy.closedAt : null,
    typeof entry.closure_note === "string" && entry.closure_note.trim() !== "" ? entry.closure_note : null,
    at,
    issueId,
  );
  // The occurrence's lossless evidence follows the reconciled record.
  db.prepare("update occurrences set evidence_json = ?, observed_behavior = ? where occurrence_key = ?").run(
    mapping.legacyJson,
    verbatimString(entry, "title"),
    `migration:${migrationSourceIdentity("legacy", mapping.source.project, mapping.source.bucket, mapping.source.entryId)}`,
  );
  db.prepare("update provenance set legacy_json = ? where issue_id = ? and kind = 'migration'").run(mapping.legacyJson, issueId);
  // The §3 row invariant holds in BOTH directions: a row that reconciles to
  // closed gains its single imported terminal transition; a row that
  // reconciles back to open loses the stale one.
  const priorClosed = prior?.disposition !== undefined && prior.disposition !== "open";
  if (closed && !priorClosed) {
    insertImportedTerminalTransition(db, issueId, mapping.disposition, mapping.legacy.closedAt, mapping.legacyJson, at);
  } else if (!closed && priorClosed) {
    db.prepare("delete from issue_transitions where issue_id = ? and imported = 1").run(issueId);
  }
}

type EntityResolution = { kind: string; id: string; created: boolean };

/**
 * Apply the reviewed catalog proposals inside the caller's transaction with
 * the same identity/location semantics as `registerCatalogEntity` (§2): the
 * composite `(kind, id)` is the identity, an existing identity at the same
 * location is a no-op, and a proposal whose location is already owned
 * attaches to that row instead of minting a duplicate.
 */
function applyCatalogEntities(db: StoreDb, plan: CatalogImportPlan, at: string): { entities: EntityResolution[]; createdEntities: number; createdLinks: number } {
  const effective = new Map<string, EntityResolution>();
  let createdEntities = 0;
  for (const proposal of plan.entities) {
    const existing = db.prepare("select id, root_kind, relative_path from catalog_entities where kind = ? and id = ?").get(
      proposal.kind,
      proposal.id,
    ) as { id: string; root_kind: string; relative_path: string } | undefined;
    if (existing) {
      if (existing.root_kind !== proposal.rootKind || existing.relative_path !== proposal.relativePath) {
        throw new StoreMigrationError(
          "store.migration-manifest-invalid",
          `catalog proposal ${proposal.kind}:${proposal.id} is already registered at ${existing.root_kind}/${existing.relative_path}, ` +
            `not ${proposal.rootKind}/${proposal.relativePath}; resolve the conflict in review. Nothing was written.`,
        );
      }
      effective.set(`${proposal.kind}\u0000${proposal.id}`, { kind: proposal.kind, id: existing.id, created: false });
      continue;
    }
    const located = db
      .prepare("select id from catalog_entities where kind = ? and root_kind = ? and relative_path = ?")
      .get(proposal.kind, proposal.rootKind, proposal.relativePath) as { id: string } | undefined;
    if (located) {
      effective.set(`${proposal.kind}\u0000${proposal.id}`, { kind: proposal.kind, id: located.id, created: false });
      continue;
    }
    db.prepare(
      "insert into catalog_entities(kind, id, title, description, root_kind, relative_path, document_kind, lifecycle, revision, registered_at, updated_at, source_hash) " +
        "values (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
    ).run(
      proposal.kind,
      proposal.id,
      proposal.title,
      proposal.description,
      proposal.rootKind,
      proposal.relativePath,
      proposal.documentKind,
      proposal.lifecycle,
      at,
      at,
      proposal.sourceHash,
    );
    createdEntities += 1;
    effective.set(`${proposal.kind}\u0000${proposal.id}`, { kind: proposal.kind, id: proposal.id, created: true });
  }
  let createdLinks = 0;
  for (const link of plan.links) {
    const from = effective.get(`${link.from.kind}\u0000${link.from.id}`) ?? { kind: link.from.kind, id: link.from.id, created: false };
    const to = effective.get(`${link.to.kind}\u0000${link.to.id}`) ?? { kind: link.to.kind, id: link.to.id, created: false };
    const present = db
      .prepare("select count(*) as n from catalog_links where from_kind = ? and from_id = ? and relation = ? and to_kind = ? and to_id = ?")
      .get(from.kind, from.id, link.relation, to.kind, to.id) as { n: number };
    if (present.n > 0) continue;
    db.prepare(
      "insert into catalog_links(from_kind, from_id, relation, to_kind, to_id, ordinal) values (?, ?, ?, ?, ?, ?)",
    ).run(from.kind, from.id, link.relation, to.kind, to.id, link.ordinal);
    createdLinks += 1;
  }
  return { entities: [...effective.values()], createdEntities, createdLinks };
}

/**
 * `applyStoreMigration(context, manifest)` — the reviewed staged apply (§7).
 *
 * Requires a fully resolved manifest (no unresolved mapping, no catalog
 * conflict) and unchanged sources (byte hashes AND the source set). The
 * issue import, the catalog import and the receipt commit in ONE database
 * transaction; an identical manifest repeats as a replay returning the
 * recorded IDs; a changed manifest reconciles migration-owned data through
 * the stable legacy tuple, and a row removed from the sources refuses
 * instead of being deleted. A legacy workspace without a store gets one
 * created here in `staged` state; an existing ACTIVE store refuses a
 * reimport, and ordinary issue/catalog mutations refuse a staged
 * store elsewhere. Legacy register files are never written.
 */
export async function applyStoreMigration(context: StoreContext, manifest: MigrationManifest): Promise<MigrationReceipt> {
  if (!manifest || manifest.version !== MIGRATION_MANIFEST_VERSION || typeof manifest.controlRoot !== "string") {
    throw new StoreMigrationError("store.migration-manifest-invalid", "the manifest is missing or carries an unsupported version; re-run the preview");
  }
  if (resolve(manifest.controlRoot) !== resolve(context.harnessDir)) {
    throw new StoreMigrationError(
      "store.migration-manifest-invalid",
      `the manifest was reviewed for control root ${manifest.controlRoot}, not ${context.harnessDir}; nothing was written.`,
    );
  }
  if (manifest.unresolved.length > 0 || manifest.catalog.conflicts.length > 0 || manifest.blocksApply) {
    throw new StoreMigrationError(
      "store.migration-unresolved",
      `the manifest still blocks apply: ${manifest.unresolved.length} unresolved mapping(s), ` +
        `${manifest.catalog.conflicts.length} catalog conflict(s). Resolve them in review first; nothing was written.`,
    );
  }
  await assertSourcesUnchanged(context, manifest);

  const manifestHash = migrationManifestHash(manifest);
  const at = new Date().toISOString();
  const handle: StoreHandle = await ensureStagedStore(context);
  try {
    const meta = handle.db.prepare("select authority_state from store_meta where id = 1").get() as
      | { authority_state?: string }
      | undefined;
    if (meta?.authority_state !== "staged") {
      throw new StoreMigrationError(
        "store.migration-active-store",
        "the store is not staged; a live active store cannot be overwritten by reimporting a manifest. Nothing was written.",
      );
    }

    const rows: ImportRow[] = manifest.mappings.map(parseImportRow);
    const priorReceipts = readReceipts(handle.db);
    const prior = priorReceipts.at(-1);
    const priorMapping: MigrationMappingWithId[] = prior ? (JSON.parse(prior.mapping_json) as MigrationMappingWithId[]) : [];
    const priorByTuple = new Map(priorMapping.map((entry) => [tupleKeyOf(entry.source), entry]));

    // Reconciliation gate: a row the previous receipt imported but the
    // re-reviewed manifest no longer carries requires an explicit reviewed
    // disposition — never a blind deletion.
    const removed = priorMapping.filter((entry) => !manifest.mappings.some((m) => tupleKeyOf(m.source) === tupleKeyOf(entry.source)));
    if (removed.length > 0) {
      const first = removed[0]!;
      throw new StoreMigrationError(
        "store.migration-row-removed",
        `${removed.length} previously imported row(s) are gone from the re-reviewed manifest ` +
          `(first: ${first.source.registerPath} bucket ${JSON.stringify(first.source.bucket)} entry ${JSON.stringify(first.source.entryId)}); ` +
          "a removed row requires an explicit reviewed disposition, never a blind deletion. Nothing was written.",
      );
    }

    handle.db.exec("begin immediate");
    try {
      const existingReceipt = handle.db
        .prepare("select id, manifest_hash, mapping_json, source_counts_json, applied_at from migration_receipts where manifest_hash = ?")
        .get(manifestHash) as StoredReceipt | undefined;
      if (existingReceipt) {
        // Identical manifest repeat: identical IDs, no writes (§7).
        handle.db.exec("commit");
        return receiptOfStored(existingReceipt, true);
      }

      const assignments: MigrationMappingWithId[] = [];
      let created = 0;
      let updated = 0;

      // Injected mid-import failure hook (test-runner gated, like C1's init hook).
      const failAfterRaw = process.env.MSTAR_STORE_FAIL_MIGRATION_AFTER;
      const failAfter =
        process.env.MSTAR_STORE_TEST_RUNNER === "1" && failAfterRaw !== undefined ? Number.parseInt(failAfterRaw, 10) : Number.NaN;

      for (const [index, row] of rows.entries()) {
        if (Number.isInteger(failAfter) && index === failAfter) {
          throw new Error(`induced migration failure after ${failAfter} imported row(s)`);
        }
        const priorEntry = priorByTuple.get(row.tuple);
        if (priorEntry) {
          if (priorEntry.issueId === "") {
            throw new StoreMigrationError("store.migration-manifest-invalid", "the prior receipt holds an empty issue id mapping; nothing was written.");
          }
          // The tuple already owns an issue ID: reconcile the migration-owned
          // columns only when the re-reviewed record differs; the ID and any
          // non-migration data are never touched.
          if (priorEntry.legacyJson !== row.mapping.legacyJson) {
            reconcileMigratedIssue(handle.db, row, priorEntry.issueId, at);
            updated += 1;
          }
          assignments.push({ ...row.mapping, issueId: priorEntry.issueId });
          continue;
        }
        // Fresh tuple: identical-manifest first allocation uses the manifest's
        // deterministic proposal (§3 sorted order); a later added tuple on a
        // store with prior migration data allocates from the counter.
        const issueId = priorReceipts.length === 0 ? row.mapping.proposedIssueId : allocateIssueId(handle.db);
        const result = insertMigratedIssue(handle.db, row, issueId, at);
        if (result === "created") created += 1;
        assignments.push({ ...row.mapping, issueId });
      }

      const catalog = applyCatalogEntities(handle.db, manifest.catalog, at);

      // Keep the counter ahead of any deterministic first allocation.
      if (priorReceipts.length === 0) {
        const maxAllocated = assignments.reduce((max, entry) => Math.max(max, Number.parseInt(entry.issueId.slice(2), 10)), 0);
        if (maxAllocated + 1 > readCounter(handle.db)) {
          handle.db.prepare("update issue_counter set next_value = ? where id = 1").run(maxAllocated + 1);
        }
      }

      // One store revision bump per published apply; the catalog revision
      // advances only when the import actually created catalog rows (§2).
      if (catalog.createdEntities > 0 || catalog.createdLinks > 0) {
        handle.db.prepare("update store_meta set revision = revision + 1, catalog_revision = catalog_revision + 1 where id = 1").run();
      } else {
        handle.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
      }
      const storeRevision = (handle.db.prepare("select revision from store_meta where id = 1").get() as { revision: number }).revision;

      const openCount = assignments.filter((entry) => entry.disposition === "open").length;
      const counts: MigrationReceipt["counts"] = {
        issues: assignments.length,
        open: openCount,
        closed: assignments.length - openCount,
        catalogEntities: catalog.entities.length,
        catalogLinks: catalog.createdLinks,
        created,
        updated,
        storeRevision,
      };

      // One receipt row carries the manifest, the persistent ID mapping and
      // the source counts (§7) — same transaction as the rows above.
      const receiptResult = handle.db
        .prepare(
          "insert into migration_receipts(manifest_hash, phase, manifest_json, mapping_json, source_counts_json, applied_at) " +
            "values (?, 'applied', ?, ?, ?, ?)",
        )
        .run(manifestHash, JSON.stringify(manifest), JSON.stringify(assignments), JSON.stringify(counts), at);
      const receiptId = Number((receiptResult as { lastInsertRowid: number | bigint }).lastInsertRowid);

      // Journal the catalog half as one committed operation (§2 journal).
      const catalogOpId = `migration:${manifestHash.slice(0, 24)}`;
      handle.db
        .prepare(
          "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) " +
            "values (?, ?, 'committed', ?, ?, ?, ?, ?, ?)",
        )
        .run(
          catalogOpId,
          manifestHash,
          JSON.stringify({ mutation: "applyStoreMigration", entities: catalog.createdEntities, links: catalog.createdLinks }),
          JSON.stringify({}),
          JSON.stringify({}),
          JSON.stringify({ receiptId }),
          at,
          at,
        );

      handle.db.exec("commit");
      return {
        receiptId,
        manifestHash,
        phase: "applied",
        replayed: false,
        issueIds: assignments.map((entry) => ({ source: entry.source, issueId: entry.issueId })),
        counts,
        storeRevision,
        appliedAt: at,
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
