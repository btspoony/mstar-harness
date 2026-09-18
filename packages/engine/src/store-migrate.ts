/**
 * store-migrate.ts -- the read-only migration planner (plan
 * 20260918-issue-governance-cutover Task 1 G1a; issue-store-contract §3/§7).
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
import { lstatSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { discoverCatalog, type CatalogImportPlan } from "./catalog-import.js";
import { catalogRootDir } from "./catalog.js";
import type { StoreContext } from "./store-db.js";
import type { Disposition, IssueKind, Severity } from "./issue.js";
import { isOpenResidual, normalizeSeverity } from "./status.js";

/** Transport version of a `MigrationManifest` (§7). */
export const MIGRATION_MANIFEST_VERSION = 1;

/** The constant proposed kind for legacy register rows, declared in the vocabulary. */
const LEGACY_ISSUE_KIND: IssueKind = "review-obligation";

/** Stable refusal codes for the migration planner. */
export type StoreMigrationErrorCode = "store.migration-duplicate-entry";

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
