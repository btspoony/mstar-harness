/**
 * projection.ts -- disposable execution/roadmap projections over the JSON
 * execution authority (state-projection-contract §5/§6).
 *
 * The root `status.json`, workflow snapshots and catalog-linked compass
 * documents stay the authority; everything this module
 * writes lives in the `projection_*` tables (migration 3) and may be dropped
 * and rebuilt at any time. A refresh NEVER writes issue/catalog rows, never
 * consults the retired README indexes or the residual registers, and never
 * validates a closure authorization.
 *
 * Two boundaries, deliberately split (brief: "pure validated source snapshot
 * vs atomic publication/last-good handling"):
 *
 * 1. `captureProjectionSources(context)` reads every source ONCE, outside any
 *    database transaction, derives the projected rows from the shared
 *    validators/parsers and fingerprints the observed source set. It writes
 *    nothing.
 * 2. `publishProjectionCapture(context, capture)` re-verifies that the
 *    captured sources are still the ones on disk (and that the catalog
 *    revision did not move), then inserts the replacement generation and
 *    flips the current generation inside ONE short write transaction. A
 *    failed or refused publication leaves the last good generation exactly
 *    as it was.
 *
 * `refreshProjections(context)` is the read boundary's entry point: capture,
 * publish, one bounded retry when the source set moved under it, then an
 * honest `stale`/`unavailable` report instead of a fabricated projection.
 *
 * Source set (contract §5): resolved `status.json`, the registered workflow
 * snapshot dirs plus the retained known locations from committed
 * `catalog_execution_bindings`, and compass documents linked to iterations.
 * Fingerprint = SHA-256 over the sorted `(canonical source key, state, SHA-256
 * of the raw bytes)` tuples plus the projection format version and catalog
 * revision. mtime/size are NOT correctness tokens.
 */
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openStore, type StoreContext, type StoreDb } from "./store-db.js";
import { catalogRootDir, type CatalogRootKind } from "./catalog.js";
import { isPlainObject } from "./coordination-write.js";
import type { ValidationResult } from "./core.js";
import { parseCompassFrontmatterText, validateCompassFrontmatter } from "./iteration.js";
import { validateExecutionLease, validateIntegrationMergeLease, type ExecutionLease, type IntegrationMergeLease } from "./lease.js";
import { readExecutionState, type ExecutionState } from "./execution-store.js";
import { rowPlanId, validatePlanRow, validateWorkflowEntry, validateStatus, type PlanRow, type StatusV2Doc } from "./status.js";
import { resolveCurrentAuthority } from "./store-read.js";
import {
  LEGACY_WORKTREE_PATH_CODE,
  validateWorkflowSnapshot,
  WORKFLOW_LIFECYCLE_STATUSES,
  WORKFLOW_LIFECYCLE_TYPES,
  WORKFLOW_SNAPSHOT_FILE,
  type WorkflowSnapshot,
} from "./workflow.js";
/** Projection payload/format version (contract §5). A bump invalidates every
 * published generation: the refresh discards the old rows and rebuilds. */
export const PROJECTION_FORMAT_VERSION = 2;

/** Root execution source, resolved under the harness root. */
export const PROJECTION_ROOT_FILE = "status.json";

/** Freshness contract §6 exposes: the published generation is current, a
 * failed read retained an older one (stale), or nothing valid was ever
 * published (unavailable). */
export type ProjectionFreshness = "current" | "stale" | "unavailable";
export type ProjectionSourceState = "ok" | "missing" | "invalid" | "inaccessible";
export type ProjectionSourceKind = "root" | "workflow" | "compass";

/**
 * One named source diagnostic (contract §6: only the source key, the reason
 * token and a safe message -- never file content, never a credential/session
 * payload). `reason` is the source state for a failed read, `changed-during-read`
 * when the observed bytes moved while the capture was being validated, or
 * `source-changing` when the source set itself moved before publication.
 * A diagnostic whose `sourceKey` is the reserved `catalog` reports a moving
 * catalog revision (the catalog is a projection input tracked by revision
 * rather than by bytes).
 */
export type SourceDiagnostic = { sourceKey: string; reason: string; message: string };

/** Read disclosure for one projected source -- mirrors `projection_sources`
 * (no absolute path: the stored/ reported location is the root + relative). */
export type ProjectionSourceDigest = {
  sourceKey: string;
  kind: ProjectionSourceKind;
  rootKind: CatalogRootKind;
  relativePath: string;
  sha256: string | null;
  state: ProjectionSourceState;
  diagnostic: string | null;
  /** Root/catalog-declared, versus a retained historical location. */
  declared: boolean;
};

export type ProjectedWorkflow = {
  id: string;
  type: string;
  status: string;
  phase: string | null;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string | null;
  branchBase: string | null;
  branchSource: string | null;
  branchIntegration: string | null;
  branchTarget: string | null;
  /** True while the root active-workflow register still lists this workflow. */
  activeRegistration: boolean;
};

export type ProjectedPlan = {
  workflowId: string;
  planId: string;
  status: string | null;
  /** The row's reported progress summary (`coordination.progress.summary`). */
  progress: string | null;
  /** The workflow phase this row ran under -- the JSON has no per-row phase. */
  phase: string | null;
  doneAt: string | null;
  /** Frozen catalog input revision the row was prepared against, if pinned. */
  catalogPinRevision: number | null;
};

export type ProjectedLease = {
  workflowId: string;
  planId: string;
  kind: "execution" | "integration-merge";
  holder: string | null;
  worktreePath: string | null;
  expiresAt: string | null;
};

export type ProjectedCompass = {
  iterationId: string;
  summary: string | null;
  milestonesJson: string;
  startedAt: string | null;
  endedAt: string | null;
  status: string | null;
};

export type ProjectionRows = {
  workflows: ProjectedWorkflow[];
  plans: ProjectedPlan[];
  leases: ProjectedLease[];
  compasses: ProjectedCompass[];
};
/** Resolved file or database row used to re-verify one captured source. */
export type ProjectionSourceLocation =
  | { source: "file"; sourceKey: string; relativePath: string; absolutePath: string; sha256: string | null; state: ProjectionSourceState }
  | {
      source: "database";
      sourceKey: string;
      relativePath: string;
      sha256: string | null;
      state: ProjectionSourceState;
      table: "execution_workflows" | "execution_plans" | "execution_leases" | "execution_integration_leases" | "execution_registry";
      keys: Record<string, string>;
    };

/**
 * A validated read of the whole source set, taken outside any transaction.
 * `blocked` means at least one source problem makes this capture unpublishable
 * (the caller keeps the last good generation); `rows` then holds only the
 * sources that were read cleanly.
 */
export type ProjectionCapture = {
  formatVersion: number;
  catalogRevision: number;
  storeRevision?: number | null;
  sources: ProjectionSourceDigest[];
  rows: ProjectionRows;
  diagnostics: SourceDiagnostic[];
  sourceSetHash: string;
  blocked: boolean;
  /** Internal: resolved locations + the digest re-checked before publication. */
  locations: ProjectionSourceLocation[];
};

/** The projection metadata contract §6 exposes on every read. */
export type ProjectionMetadata = {
  generation: number | null;
  freshness: ProjectionFreshness;
  builtAt: string | null;
  checkedAt: string;
  diagnostics: SourceDiagnostic[];
};

/**
 * `refreshProjections` / `publishProjectionCapture` result: §6 metadata plus
 * the observed source digests and the keys that moved since the published
 * generation. `sourceSetHash`/`sources` describe the sources THIS attempt
 * read (equal to the published generation's only when the attempt published
 * or adopted it); `builtAt` is always the retained generation's build time,
 * so a stale report never claims a newer projection than the store holds.
 */
export type RefreshReport = ProjectionMetadata & {
  /** True when this call inserted a NEW generation row set. */
  published: boolean;
  sourceSetHash: string;
  sources: ProjectionSourceDigest[];
  changedKeys: string[];
};

export type ProjectionErrorCode =
  | "projection.source-stale"
  | "projection.schema-outdated"
  | "projection.invalid-capture";

export class ProjectionError extends Error {
  readonly code: ProjectionErrorCode;

  constructor(code: ProjectionErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "ProjectionError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Source discovery and reads
// ---------------------------------------------------------------------------

type ProjectionSourceTable =
  | "execution_workflows"
  | "execution_plans"
  | "execution_leases"
  | "execution_integration_leases"
  | "execution_registry";

const DATABASE_SOURCE_PRIMARY_KEYS: Record<ProjectionSourceTable, readonly string[]> = {
  execution_registry: [],
  execution_workflows: ["workflow_id"],
  execution_plans: ["workflow_id", "plan_id"],
  execution_leases: ["workflow_id", "plan_id"],
  execution_integration_leases: ["workflow_id"],
};

function databaseSourceLocationError(location: unknown): string | null {
  if (!isPlainObject(location) || typeof location.table !== "string" || !Object.prototype.hasOwnProperty.call(DATABASE_SOURCE_PRIMARY_KEYS, location.table)) {
    return "unknown database source table";
  }
  const primaryKeys = DATABASE_SOURCE_PRIMARY_KEYS[location.table as ProjectionSourceTable];
  if (!isPlainObject(location.keys)) return "database source keys do not match the table primary key";
  const keys = Object.keys(location.keys);
  if (
    keys.length !== primaryKeys.length ||
    primaryKeys.some((key) => !Object.prototype.hasOwnProperty.call(location.keys, key)) ||
    keys.some((key) => typeof location.keys[key] !== "string" || location.keys[key] === "")
  ) {
    return "database source keys do not match the table primary key";
  }
  return null;
}

type SourceSpec =
  | { source: "file"; sourceKey: string; kind: ProjectionSourceKind; rootKind: CatalogRootKind; relativePath: string; absolutePath: string; declared: boolean }
  | { source: "database"; sourceKey: string; kind: ProjectionSourceKind; rootKind: CatalogRootKind; relativePath: string; declared: boolean; table: ProjectionSourceTable; keys: Record<string, string> };

type SourceRead = { state: ProjectionSourceState; sha256: string | null; content: string | null; diagnostic: string | null };

/** Canonical source key: `<kind>:<root_kind>:<relative path>`. Stable across
 * refreshes and independent of where the root happens to be mounted. */
function sourceKeyOf(kind: ProjectionSourceKind, rootKind: CatalogRootKind, relativePath: string): string {
  return `${kind}:${rootKind}:${relativePath}`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Test seam, gated exactly like `store-db`'s failure injection: honored only
 * under `MSTAR_STORE_TEST_RUNNER=1`, so a shipped CLI/plugin process can never
 * reach it. `MSTAR_PROJECTION_CHURN_PATH` names one source by its relative
 * path; every successful read of it appends a byte right afterwards, so the
 * NEXT read of that source (the roadmap re-digest inside a capture, or the
 * pre-publication re-verification) observes a different digest. That makes a
 * moving source set reproducible in-process instead of timing-dependent.
 */
function churnAfterRead(spec: { relativePath: string; absolutePath: string }): void {
  if (process.env.MSTAR_STORE_TEST_RUNNER !== "1") return;
  const target = process.env.MSTAR_PROJECTION_CHURN_PATH;
  if (target === undefined || target === "" || target !== spec.relativePath) return;
  try {
    appendFileSync(spec.absolutePath, "\n");
  } catch {
    // The next read reports the resulting mismatch either way.
  }
}

/**
 * Read one source's bytes and classify the outcome. `mtime`/`size` are never
 * used: the digest of the raw bytes is the only correctness token, so a
 * same-size/same-mtime rewrite is visible here.
 */
function readSource(spec: SourceSpec | ProjectionSourceLocation, db?: StoreDb): SourceRead {
  if (spec.source === "database") {
    const sourceError = databaseSourceLocationError(spec);
    if (sourceError !== null) return { state: "invalid", sha256: null, content: null, diagnostic: sourceError };
    if (db === undefined) {
      return { state: "inaccessible", sha256: null, content: null, diagnostic: "capture arm pending (Task 2)" };
    }
    try {
      if (spec.table === "execution_registry") {
        const entries = db.prepare("select workflow_id, entry_json from execution_registry order by workflow_id asc").all() as
          Array<{ workflow_id: string; entry_json: unknown }>;
        for (const entry of entries) {
          if (typeof entry.entry_json !== "string") {
            return { state: "invalid", sha256: null, content: null, diagnostic: `invalid: malformed JSON at ${spec.relativePath}` };
          }
          try {
            JSON.parse(entry.entry_json);
          } catch {
            return { state: "invalid", sha256: null, content: null, diagnostic: `invalid: malformed JSON at ${spec.relativePath}` };
          }
        }
        const content = JSON.stringify(entries);
        return { state: "ok", sha256: createHash("sha256").update(content, "utf8").digest("hex"), content, diagnostic: null };
      }
      const primaryKeys = DATABASE_SOURCE_PRIMARY_KEYS[spec.table];
      const row = db
        .prepare(`select * from ${spec.table} where ${primaryKeys.map((key) => `${key} = ?`).join(" and ")}`)
        .get(...primaryKeys.map((key) => spec.keys[key])) as Record<string, unknown> | undefined;
      if (row === undefined) {
        return { state: "missing", sha256: null, content: null, diagnostic: `missing: no row at ${spec.relativePath}` };
      }
      const columns =
        spec.table === "execution_plans"
          ? [row.state_json, row.coordination_json]
          : [spec.table === "execution_workflows" ? row.state_json : row.lease_json];
      if (columns.some((value) => typeof value !== "string")) {
        return { state: "invalid", sha256: null, content: null, diagnostic: `invalid: malformed JSON at ${spec.relativePath}` };
      }
      try {
        for (const column of columns as string[]) JSON.parse(column);
      } catch {
        return { state: "invalid", sha256: null, content: null, diagnostic: `invalid: malformed JSON at ${spec.relativePath}` };
      }
      const content = columns.join("\u0000");
      return { state: "ok", sha256: createHash("sha256").update(content, "utf8").digest("hex"), content, diagnostic: null };
    } catch {
      return { state: "inaccessible", sha256: null, content: null, diagnostic: `inaccessible: execution row read refused at ${spec.relativePath}` };
    }
  }
  let content: string;
  try {
    content = readFileSync(spec.absolutePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { state: "missing", sha256: null, content: null, diagnostic: `missing: no file at ${spec.relativePath}` };
    }
    return {
      state: "inaccessible",
      sha256: null,
      content: null,
      diagnostic: `inaccessible: read refused (${code === "" ? "unknown" : code}) at ${spec.relativePath}`,
    };
  }
  churnAfterRead(spec);
  return { state: "ok", sha256: createHash("sha256").update(content, "utf8").digest("hex"), content, diagnostic: null };
}

/** Root-kind guard for values read back from the catalog binding table. */
const CATALOG_ROOT_KINDS: Record<string, true> = {
  repository: true,
  harness: true,
  plans: true,
  iterations: true,
  specs: true,
  knowledge: true,
  projects: true,
};

function asCatalogRootKind(value: unknown): CatalogRootKind | null {
  return typeof value === "string" && CATALOG_ROOT_KINDS[value] === true ? (value as CatalogRootKind) : null;
}

/** Normalize a root-declared snapshot dir; `null` refuses an escaping location. */
function normalizeDeclaredDir(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  const unified = value.replace(/\\/g, "/");
  if (unified.includes("\0") || unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) return null;
  const segments = unified.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;
  return segments.join("/");
}

type CatalogInputs = {
  catalogRevision: number;
  bindings: Array<{ workflowId: string; rootKind: CatalogRootKind; relativePath: string }>;
  compassDocs: Array<{ iterationId: string; rootKind: CatalogRootKind; relativePath: string }>;
};

type CatalogDocumentRow = { id: string; rootKind: CatalogRootKind; relativePath: string; documentKind: string; lifecycle: string; revision: number };

/**
 * The catalog side of a capture: ONE read-only connection for the current
 * revision, committed execution bindings and linked compass documents. These
 * are plain projection SELECTs over catalog tables; every catalog WRITE stays
 * on the catalog domain verbs, and
 * this module never mutates a catalog row.
 */
async function readCatalogInputs(context: StoreContext): Promise<CatalogInputs> {
  const handle = await openStore(context, "read");
  try {
    const db = handle.db;
    const meta = db.prepare("select catalog_revision from store_meta where id = 1").get() as
      | { catalog_revision?: unknown }
      | undefined;
    const catalogRevision = typeof meta?.catalog_revision === "number" ? meta.catalog_revision : 0;

    const bindings = (
      db
        .prepare(
          "select workflow_id, workflow_root_kind, workflow_relative_path from catalog_execution_bindings order by workflow_id asc",
        )
        .all() as Array<Record<string, unknown>>
    ).flatMap((row) => {
      const workflowId = text(row.workflow_id);
      const rootKind = asCatalogRootKind(row.workflow_root_kind);
      const relativePath = text(row.workflow_relative_path);
      return workflowId !== null && rootKind !== null && relativePath !== null
        ? [{ workflowId, rootKind, relativePath: relativePath.replace(/\/+$/, "") }]
        : [];
    });

    // Linked compass documents: the catalog decides the paths (never README
    // discovery). When several are linked, select active first, then newest
    // revision, then lowest id.
    const documents = (
      db
        .prepare(
          "select id, root_kind, relative_path, document_kind, lifecycle, revision from catalog_entities " +
            "where kind = 'document' and document_kind = 'compass'",
        )
        .all() as Array<Record<string, unknown>>
    ).flatMap((row) => {
      const id = text(row.id);
      const rootKind = asCatalogRootKind(row.root_kind);
      const relativePath = text(row.relative_path);
      const documentKind = text(row.document_kind);
      if (id === null || rootKind === null || relativePath === null || documentKind === null) return [];
      return [
        {
          id,
          rootKind,
          relativePath,
          documentKind,
          lifecycle: text(row.lifecycle) ?? "active",
          revision: typeof row.revision === "number" ? row.revision : 0,
        } satisfies CatalogDocumentRow,
      ];
    });

    const links = db
      .prepare("select from_kind, from_id, to_kind, to_id from catalog_links where relation = 'documents'")
      .all() as Array<Record<string, unknown>>;

    const owners = db
      .prepare("select id from catalog_entities where kind = 'iteration'")
      .all() as Array<Record<string, unknown>>;

    const byId = new Map(documents.map((doc) => [doc.id, doc]));
    const pick = (ownerId: string): CatalogDocumentRow | null => {
      const candidates = links
        .filter(
          (link) =>
            link.from_kind === "iteration" &&
            link.from_id === ownerId &&
            link.to_kind === "document" &&
            typeof link.to_id === "string",
        )
        .map((link) => byId.get(link.to_id as string))
        .filter((doc): doc is CatalogDocumentRow => doc !== undefined)
        .sort((a, b) => {
          if (a.lifecycle !== b.lifecycle) return a.lifecycle === "active" ? -1 : 1;
          if (a.revision !== b.revision) return b.revision - a.revision;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
      return candidates[0] ?? null;
    };

    const compassDocs: CatalogInputs["compassDocs"] = [];
    for (const owner of owners) {
      const ownerId = text(owner.id);
      if (ownerId === null) continue;
      const doc = pick(ownerId);
      if (doc !== null) compassDocs.push({ iterationId: ownerId, rootKind: doc.rootKind, relativePath: doc.relativePath });
    }

    return { catalogRevision, bindings, compassDocs };
  } finally {
    handle.close();
  }
}

// ---------------------------------------------------------------------------
// Root source (status.json)
// ---------------------------------------------------------------------------

/**
 * Root validation is the shared `validateStatus` over the document we read.
 * Two of its finding codes are the workflow-source findings this capture
 * reports on the named workflow source instead
 * (`status.workflow.snapshot-missing` / `status.workflow.snapshot-invalid`);
 * every other finding -- including a listed terminal snapshot, a snapshot
 * outside the harness, a root/snapshot type or started_at mismatch and a
 * duplicate id -- invalidates the ROOT source, so the refresh fails closed
 * rather than projecting an incoherent register.
 */
const ROOT_WORKFLOW_SOURCE_CODES: Record<string, true> = {
  "status.workflow.snapshot-missing": true,
  "status.workflow.snapshot-invalid": true,
};

type RootRead = { entries: Array<{ id: string; dir: string }>; diagnostic: string | null };

function readRootSource(content: string, harnessDir: string): RootRead {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return { entries: [], diagnostic: "invalid: status.json is not valid JSON" };
  }
  const gate = validateStatus(doc as StatusV2Doc, { harnessDir });
  const blocking: ValidationResult[] = gate.violations.filter(
    (violation) => ROOT_WORKFLOW_SOURCE_CODES[violation.code] !== true,
  );
  if (blocking.length > 0) {
    return { entries: [], diagnostic: `invalid: ${blocking.map((violation) => violation.code).join(", ")}` };
  }
  const entries: Array<{ id: string; dir: string }> = [];
  for (const raw of (doc as StatusV2Doc).workflows) {
    const id = text(raw.id);
    const dir = normalizeDeclaredDir(raw.dir);
    if (id === null || dir === null) {
      return {
        entries: [],
        diagnostic: `invalid: workflow entry ${id === null ? "(missing id)" : JSON.stringify(id)} has no usable harness-relative dir`,
      };
    }
    entries.push({ id, dir });
  }
  return { entries, diagnostic: null };
}

// ---------------------------------------------------------------------------
// Derived rows (shared validators/parsers, no forks)
// ---------------------------------------------------------------------------

/**
 * Snapshot read acceptance mirrors the canonical reader's one permitted
 * migration diagnostic: a v1 `control_worktree_path` alias is accepted (it
 * names the integration worktree, which is NOT a projected column, so the
 * projection never depends on the alias value) while every other violation
 * refuses the source. The canonical reader normalizes that alias in memory
 * for readers that DO consume the path; `readWorkflowSnapshot`'s write
 * permission is untouched here.
 */
function deriveWorkflowRows(
  content: string,
  declared: boolean,
): { workflow: ProjectedWorkflow; plans: ProjectedPlan[]; leases: ProjectedLease[] } | { diagnostic: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return { diagnostic: "invalid: snapshot is not valid JSON" };
  }
  const gate = validateWorkflowSnapshot(doc);
  const blocking = gate.violations.filter((violation) => violation.code !== LEGACY_WORKTREE_PATH_CODE);
  if (blocking.length > 0) {
    return { diagnostic: `invalid: ${blocking.map((violation) => violation.code).join(", ")}` };
  }
  const snapshot = doc as WorkflowSnapshot;
  const phase = text(snapshot.phase);
  const branch = isPlainObject(snapshot.branch) ? (snapshot.branch as Record<string, unknown>) : {};
  const workflows: ProjectedWorkflow[] = [
    {
      id: snapshot.id,
      type: snapshot.type,
      status: snapshot.status,
      phase,
      startedAt: text(snapshot.started_at),
      endedAt: text(snapshot.ended_at),
      updatedAt: text(snapshot.updated_at),
      branchBase: text(branch.base),
      branchSource: text(branch.source),
      branchIntegration: text(branch.integration),
      branchTarget: text(branch.target),
      activeRegistration: declared,
    },
  ];
  const plans: ProjectedPlan[] = [];
  const leases: ProjectedLease[] = [];
  for (const raw of Array.isArray(snapshot.plans) ? snapshot.plans : []) {
    const row = raw as PlanRow;
    const planId = rowPlanId(row);
    // validateWorkflowSnapshot (validatePlanRow) already refused a row with
    // neither id nor plan_id, so this only guards a hand-built document.
    if (planId === undefined) continue;
    const coordination = isPlainObject(row.coordination) ? (row.coordination as Record<string, unknown>) : {};
    const progress = isPlainObject(coordination.progress) ? (coordination.progress as Record<string, unknown>) : {};
    const metadata = isPlainObject(row.metadata) ? (row.metadata as Record<string, unknown>) : {};
    const pin = isPlainObject(metadata.catalog_pin) ? (metadata.catalog_pin as Record<string, unknown>) : {};
    plans.push({
      workflowId: snapshot.id,
      planId,
      status: text(row.status),
      progress: text(progress.summary),
      phase,
      doneAt: text(row.done_at),
      catalogPinRevision: typeof pin.entity_revision === "number" ? pin.entity_revision : null,
    });
    if (isPlainObject(row.execution_lease)) {
      const lease = row.execution_lease as ExecutionLease;
      leases.push({
        workflowId: snapshot.id,
        planId,
        kind: "execution",
        holder: text(lease.holder),
        worktreePath: text(lease.worktree_path),
        expiresAt: text(lease.expires_at),
      });
    }
  }
  if (isPlainObject(snapshot.integration_merge_lease)) {
    const lease = snapshot.integration_merge_lease as IntegrationMergeLease;
    leases.push({
      workflowId: snapshot.id,
      planId: text(lease.plan_id) ?? "",
      kind: "integration-merge",
      holder: text(lease.holder),
      worktreePath: null,
      expiresAt: text(lease.expires_at),
    });
  }
  return { workflow: workflows[0]!, plans, leases };
}

function bodyOf(content: string): string {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return content;
  const end = lines.indexOf("---", 1);
  return end === -1 ? "" : lines.slice(end + 1).join("\n");
}

/** Body text of a `## <heading>` section (up to the next `##` heading). */
function sectionText(body: string, heading: string): string | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${heading}\\s*$`).test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s+/.test(line));
  const text = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return text === "" ? null : text;
}

/** First non-heading paragraph of a document body -- the compass narrative summary. */
function firstParagraph(body: string): string | null {
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const text = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .join(" ");
    if (text !== "") return text;
  }
  return null;
}

/** Milestone rows of a compass `## Milestones` markdown table. */
function parseMilestoneTable(body: string): Array<{ milestone: string; target: string | null; status: string | null }> {
  const section = sectionText(body, "Milestones");
  if (section === null) return [];
  const rows: Array<{ milestone: string; target: string | null; status: string | null }> = [];
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length < 2) continue;
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
    if (cells[0]?.toLowerCase() === "milestone") continue;
    if (cells[0] === undefined || cells[0] === "") continue;
    rows.push({
      milestone: cells[0],
      target: cells[1] === undefined || cells[1] === "" ? null : cells[1],
      status: cells[2] === undefined || cells[2] === "" ? null : cells[2],
    });
  }
  return rows;
}

function deriveCompass(iterationId: string, content: string, relativePath: string): ProjectedCompass | { diagnostic: string } {
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseCompassFrontmatterText(content, relativePath);
  } catch {
    return { diagnostic: "invalid: compass frontmatter is not parseable" };
  }
  const gate = validateCompassFrontmatter(frontmatter);
  if (!gate.ok) return { diagnostic: `invalid: ${gate.violations.map((violation) => violation.code).join(", ")}` };
  const body = bodyOf(content);
  return {
    iterationId,
    summary: firstParagraph(body),
    milestonesJson: JSON.stringify(parseMilestoneTable(body)),
    startedAt: text(frontmatter.start_date),
    endedAt: text(frontmatter.end_date),
    status: text(frontmatter.status),
  };
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------



/**
 * Read, validate and fingerprint the whole source set without writing
 * anything. Source I/O happens ONLY here (and in the publication
 * re-verification), so the read boundary's "discover/read/validate outside
 * the transaction" rule is structural rather than a convention.
 */
export async function captureProjectionSources(context: StoreContext): Promise<ProjectionCapture> {
  const authority = await resolveCurrentAuthority(context);
  return authority.route === "execution"
    ? captureExecutionProjectionSources(context)
    : captureFileProjectionSources(context);
}
function safeExecutionAuthorityError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "unknown read failure";
  const payloadStart = raw.indexOf("{");
  const text = (payloadStart < 0 ? raw : `${raw.slice(0, payloadStart).trimEnd()} [payload omitted]`)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\b(token|secret|password|credential|authorization)\s*[:=]\s*[^,;\s]+/gi, "$1=[redacted]")
    .slice(0, 240);
  return `execution authority unreadable: ${text || "read failure"}`;
}

async function captureExecutionProjectionSources(context: StoreContext): Promise<ProjectionCapture> {
  const inputs = await readCatalogInputs(context);
  const revisionHandle = await openStore(context, "read");
  let capturedStoreRevision: number;
  try {
    capturedStoreRevision = (revisionHandle.db.prepare("select revision from store_meta where id = 1").get() as { revision: number }).revision;
  } finally {
    revisionHandle.close();
  }
  let servedGraph: ExecutionState;
  try {
    if (process.env.MSTAR_STORE_TEST_RUNNER === "1" && process.env.MSTAR_PROJECTION_TEST_AUTHORITY_READ_ERROR) {
      throw new Error(process.env.MSTAR_PROJECTION_TEST_AUTHORITY_READ_ERROR);
    }
    servedGraph = (await readExecutionState(context)).data;
  } catch (error) {
    const sourceKey = sourceKeyOf("root", "harness", "execution/registry");
    const message = safeExecutionAuthorityError(error);
    const sources: ProjectionSourceDigest[] = [];
    const rows: ProjectionRows = { workflows: [], plans: [], leases: [], compasses: [] };
    return {
      formatVersion: PROJECTION_FORMAT_VERSION,
      catalogRevision: inputs.catalogRevision,
      storeRevision: capturedStoreRevision,
      sources,
      rows,
      diagnostics: [{ sourceKey, reason: "invalid", message }],
      sourceSetHash: computeSourceSetHash(inputs.catalogRevision, sources),
      blocked: true,
      locations: [],
    };
  }
  const handle = await openStore(context, "read");
  try {
    const db = handle.db;
    const sources: ProjectionSourceDigest[] = [];
    const locations: ProjectionSourceLocation[] = [];
    const diagnostics: SourceDiagnostic[] = [];
    const rows: ProjectionRows = { workflows: [], plans: [], leases: [], compasses: [] };
    const recordInvalid = (sourceSpec: SourceSpec, content: string, message: string, readState: "ok" | "invalid" = "ok"): void => {
      const sha256 = readState === "invalid" ? null : createHash("sha256").update(content, "utf8").digest("hex");
      sources.push({ sourceKey: sourceSpec.sourceKey, kind: sourceSpec.kind, rootKind: sourceSpec.rootKind, relativePath: sourceSpec.relativePath, sha256, state: "invalid", diagnostic: message, declared: true });
      locations.push({ source: "database", sourceKey: sourceSpec.sourceKey, relativePath: sourceSpec.relativePath, sha256, state: readState, table: sourceSpec.table as ProjectionSourceTable, keys: sourceSpec.keys! });
      diagnostics.push({ sourceKey: sourceSpec.sourceKey, reason: "invalid", message });
    };
    const record = (spec: SourceSpec, content: string, shaText = content): void => {
      const sha256 = createHash("sha256").update(shaText, "utf8").digest("hex");
      sources.push({ sourceKey: spec.sourceKey, kind: spec.kind, rootKind: spec.rootKind, relativePath: spec.relativePath, sha256, state: "ok", diagnostic: null, declared: spec.declared });
      locations.push({ source: "database", sourceKey: spec.sourceKey, relativePath: spec.relativePath, sha256, state: "ok", table: spec.table as ProjectionSourceTable, keys: spec.keys! });
    };
    const spec = (table: ProjectionSourceTable, kind: ProjectionSourceKind, rel: string, keys: Record<string, string>): SourceSpec => ({
      source: "database", sourceKey: sourceKeyOf(kind, "harness", rel), kind, rootKind: "harness", relativePath: rel, declared: true, table, keys,
    });
    const registry = db.prepare("select workflow_id, entry_json from execution_registry order by workflow_id").all() as Array<{ workflow_id: string; entry_json: string }>;
    const registrySpec = spec("execution_registry", "root", "execution/registry", {});
    const malformedRegistryJson = registry.some((item) => {
      try {
        JSON.parse(item.entry_json);
        return false;
      } catch {
        return true;
      }
    });
    const invalidRegistryEntry = registry.find((item) => {
      try {
        const entry: unknown = JSON.parse(item.entry_json);
        return !isPlainObject(entry) || entry.id !== item.workflow_id || !validateWorkflowEntry(entry).ok;
      } catch {
        return false;
      }
    });
    if (malformedRegistryJson) recordInvalid(registrySpec, JSON.stringify(registry), "invalid: execution registry contains malformed entry JSON", "invalid");
    else if (invalidRegistryEntry) recordInvalid(registrySpec, JSON.stringify(registry), "invalid: execution registry contains mismatched or domain-invalid entry JSON");
    else record(registrySpec, JSON.stringify(registry));
    const graphWorkflows = servedGraph.workflows;
    const servedWorkflowIds = graphWorkflows.map((workflow) => workflow.state.id);
    const registryIds = new Set(servedWorkflowIds);
    const servedWorkflowById = new Map(graphWorkflows.map((workflow) => [workflow.state.id, workflow]));
    const workflows = servedWorkflowIds.length === 0
      ? []
      : db.prepare(`select workflow_id, state_json from execution_workflows where workflow_id in (${servedWorkflowIds.map(() => "?").join(",")}) order by workflow_id`)
          .all(...servedWorkflowIds) as Array<{ workflow_id: string; state_json: string }>;
    const workflowIds = new Set(workflows.map((item) => item.workflow_id));
    for (const item of registry) {
      if (!workflowIds.has(item.workflow_id)) {
        const sourceKey = sourceKeyOf("root", "harness", "execution/registry");
        diagnostics.push({ sourceKey, reason: "invalid", message: `invalid: registry membership has no workflow row (${item.workflow_id})` });
      }
    }
    const workflowStateById = new Map<string, Record<string, unknown>>();
    for (const item of workflows) {
      const workflowSpec = spec("execution_workflows", "workflow", `execution/workflows/${item.workflow_id}`, { workflow_id: item.workflow_id });
      let state: unknown;
      try { state = JSON.parse(item.state_json); } catch {
        recordInvalid(workflowSpec, item.state_json, "invalid: workflow state is not valid JSON", "invalid");
        continue;
      }
      if (!isPlainObject(state) || state.id !== item.workflow_id || !WORKFLOW_LIFECYCLE_TYPES.includes(state.type as never) || !WORKFLOW_LIFECYCLE_STATUSES.includes(state.status as never)) {
        recordInvalid(workflowSpec, item.state_json, "invalid: workflow state has an invalid object, type, or status");
        continue;
      }
      const servedWorkflow = servedWorkflowById.get(item.workflow_id);
      if (!servedWorkflow) {
        recordInvalid(workflowSpec, item.state_json, "invalid: served workflow is missing from the execution authority graph");
        continue;
      }
      const projectionState = servedWorkflow.state;
      const workflowValidation = validateWorkflowSnapshot({ ...projectionState, plans: [] });
      const workflowErrors = workflowValidation.violations.filter((violation) => violation.code !== LEGACY_WORKTREE_PATH_CODE);
      if (workflowErrors.length > 0) {
        recordInvalid(workflowSpec, item.state_json, `invalid: workflow state failed validation (${workflowErrors.map((violation) => violation.code).join(", ")})`);
        continue;
      }
      record(workflowSpec, item.state_json);
      const branch = isPlainObject(projectionState.branch) ? projectionState.branch : {};
      rows.workflows.push({
        id: item.workflow_id, type: projectionState.type as ProjectedWorkflow["type"], status: projectionState.status as string,
        phase: text(projectionState.phase), startedAt: text(projectionState.started_at), endedAt: text(projectionState.ended_at), updatedAt: text(projectionState.updated_at),
        branchBase: text(branch.base), branchSource: text(branch.source), branchIntegration: text(branch.integration), branchTarget: text(branch.target),
        activeRegistration: registryIds.has(item.workflow_id),
      });
    }
    const workflowPhases = new Map(rows.workflows.map((workflow) => [workflow.id, workflow.phase]));
    const servedPlanIdsByWorkflow = new Map(graphWorkflows.map((workflow) => [workflow.state.id, new Set(workflow.plans.map((plan) => plan.plan.id))]));
    const servedLeaseIdsByWorkflow = new Map(graphWorkflows.map((workflow) => [workflow.state.id, new Set(workflow.plans.filter((plan) => plan.executionLease !== null).map((plan) => plan.plan.id))]));
    const servedIntegrationLeaseIds = new Set(graphWorkflows.filter((workflow) => workflow.integrationLease !== null).map((workflow) => workflow.state.id));
    const plans = servedWorkflowIds.length === 0
      ? []
      : db.prepare(`select workflow_id, plan_id, revision, state_json, coordination_json from execution_plans where workflow_id in (${servedWorkflowIds.map(() => "?").join(",")}) order by workflow_id, plan_id`)
          .all(...servedWorkflowIds) as Array<{ workflow_id: string; plan_id: string; revision: number; state_json: string; coordination_json: string }>;
    for (const row of plans) {
      if (!servedPlanIdsByWorkflow.get(row.workflow_id)?.has(row.plan_id)) continue;
      const sourceSpec = spec("execution_plans", "workflow", `execution/plans/${row.workflow_id}/${row.plan_id}`, { workflow_id: row.workflow_id, plan_id: row.plan_id });
      let state: unknown;
      let coordination: unknown;
      try {
        state = JSON.parse(row.state_json);
        coordination = JSON.parse(row.coordination_json);
      } catch {
        recordInvalid(sourceSpec, `${row.state_json}\u0000${row.coordination_json}`, "invalid: plan state or coordination is not valid JSON", "invalid");
        continue;
      }
      const plan = isPlainObject(state) ? { ...state, coordination } : state;
      const validation = validatePlanRow(plan);
      if (!isPlainObject(coordination) || !validation.ok) {
        const codes = validation.violations.map((item) => item.code);
        recordInvalid(sourceSpec, `${row.state_json}\u0000${row.coordination_json}`, `invalid: plan state or coordination failed validation${codes.length ? ` (${codes.join(", ")})` : ""}`);
        continue;
      }
      const planState = state as Record<string, unknown>;
      const coordinationState = coordination as Record<string, unknown>;
      const planId = rowPlanId(planState);
      if (!planId || planId !== row.plan_id) {
        recordInvalid(sourceSpec, `${row.state_json}\u0000${row.coordination_json}`, "invalid: plan state id does not match its execution_plans key");
        continue;
      }
      const workflowState = workflowStateById.get(row.workflow_id);
      const authorityPlanView = servedWorkflowById.get(row.workflow_id)?.plans.find((view) => view.plan.id === row.plan_id);
      const leaseRow = db.prepare("select lease_json from execution_leases where workflow_id = ? and plan_id = ?").get(row.workflow_id, row.plan_id) as { lease_json: string } | undefined;
      let snapshotLease: unknown;
      if (leaseRow) {
        try { snapshotLease = JSON.parse(leaseRow.lease_json); } catch { /* reported on the lease source below */ }
      }
      const snapshotPlanBase = { ...planState, coordination: { revision: row.revision, ...coordinationState } };
      const snapshotPlan = snapshotLease === undefined ? snapshotPlanBase : { ...snapshotPlanBase, execution_lease: snapshotLease };
      if (workflowState) {
        const workflowGate = validateWorkflowSnapshot({ ...workflowState, plans: [snapshotPlan] });
        const blockingCodes = workflowGate.violations.filter((violation) => violation.code !== LEGACY_WORKTREE_PATH_CODE).map((violation) => violation.code);
        if (blockingCodes.length > 0) {
          recordInvalid(sourceSpec, `${row.state_json}\u0000${row.coordination_json}`, `invalid: plan does not validate in its workflow (${blockingCodes.join(", ")})`);
          continue;
        }
      }
      if (!authorityPlanView) {
        recordInvalid(sourceSpec, `${row.state_json}\u0000${row.coordination_json}`, "invalid: served plan is missing from the execution authority graph");
        continue;
      }
      const pinRevision = authorityPlanView.frozenInput?.entity_revision ?? (isPlainObject(planState.metadata) && isPlainObject(planState.metadata.catalog_pin) ? planState.metadata.catalog_pin.entity_revision : null);
      record(sourceSpec, `${row.state_json}\u0000${row.coordination_json}`, `${row.state_json}\u0000${row.coordination_json}`);
      const mappedCoordination = authorityPlanView.coordination;
      const progress = isPlainObject(mappedCoordination) && isPlainObject(mappedCoordination.progress) ? mappedCoordination.progress : {};
      rows.plans.push({ workflowId: row.workflow_id, planId, status: text(authorityPlanView.plan.status), progress: text(progress.summary), phase: workflowPhases.get(row.workflow_id) ?? null, doneAt: text(authorityPlanView.plan.done_at), catalogPinRevision: typeof pinRevision === "number" ? pinRevision : null });
    }
    const leases = servedWorkflowIds.length === 0
      ? []
      : db.prepare(`select workflow_id, plan_id, lease_json from execution_leases where workflow_id in (${servedWorkflowIds.map(() => "?").join(",")}) order by workflow_id, plan_id`)
          .all(...servedWorkflowIds) as Array<{ workflow_id: string; plan_id: string; lease_json: string }>;
    for (const lease of leases) {
      if (!servedLeaseIdsByWorkflow.get(lease.workflow_id)?.has(lease.plan_id)) continue;
      const leaseSpec = spec("execution_leases", "workflow", `execution/leases/${lease.workflow_id}/${lease.plan_id}`, { workflow_id: lease.workflow_id, plan_id: lease.plan_id });
      let value: unknown;
      try { value = JSON.parse(lease.lease_json); } catch {
        recordInvalid(leaseSpec, lease.lease_json, "invalid: execution lease is not valid JSON", "invalid");
        continue;
      }
      const validation = validateExecutionLease(value);
      if (!isPlainObject(value) || !validation.ok) {
        recordInvalid(leaseSpec, lease.lease_json, `invalid: execution lease failed validation (${validation.violations.map((item) => item.code).join(", ")})`);
        continue;
      }
      const servedLease = servedWorkflowById.get(lease.workflow_id)?.plans.find((plan) => plan.plan.id === lease.plan_id)?.executionLease;
      const mappedLease = servedLease;
      if (!mappedLease) continue;
      record(leaseSpec, lease.lease_json);
      rows.leases.push({ workflowId: lease.workflow_id, planId: lease.plan_id, kind: "execution", holder: text(mappedLease.holder), worktreePath: text(mappedLease.worktree_path), expiresAt: text(mappedLease.expires_at) });
    }
    for (const doc of inputs.compassDocs) {
      const fspec: SourceSpec = { source: "file", sourceKey: sourceKeyOf("compass", doc.rootKind, doc.relativePath), kind: "compass", rootKind: doc.rootKind, relativePath: doc.relativePath, absolutePath: join(catalogRootDir(context, doc.rootKind), doc.relativePath), declared: true };
      const read = readSource(fspec);
      if (read.state !== "ok" || read.content === null) {
        sources.push({ sourceKey: fspec.sourceKey, kind: "compass", rootKind: fspec.rootKind, relativePath: fspec.relativePath, sha256: read.sha256, state: read.state, diagnostic: read.diagnostic, declared: true });
        locations.push({ source: "file", sourceKey: fspec.sourceKey, relativePath: fspec.relativePath, absolutePath: fspec.absolutePath, sha256: read.sha256, state: read.state });
        diagnostics.push({ sourceKey: fspec.sourceKey, reason: read.state, message: read.diagnostic ?? "compass unavailable" });
        continue;
      }
      const parsed = deriveCompass(doc.iterationId, read.content, doc.relativePath);
      if ("diagnostic" in parsed) {
        sources.push({ sourceKey: fspec.sourceKey, kind: "compass", rootKind: fspec.rootKind, relativePath: fspec.relativePath, sha256: read.sha256, state: "invalid", diagnostic: parsed.diagnostic, declared: true });
        locations.push({ source: "file", sourceKey: fspec.sourceKey, relativePath: fspec.relativePath, absolutePath: fspec.absolutePath, sha256: read.sha256, state: "invalid" });
        diagnostics.push({ sourceKey: fspec.sourceKey, reason: "invalid", message: parsed.diagnostic });
        continue;
      }
      rows.compasses.push(parsed);
      sources.push({ sourceKey: fspec.sourceKey, kind: "compass", rootKind: fspec.rootKind, relativePath: fspec.relativePath, sha256: read.sha256, state: "ok", diagnostic: null, declared: true });
      locations.push({ source: "file", sourceKey: fspec.sourceKey, relativePath: fspec.relativePath, absolutePath: fspec.absolutePath, sha256: read.sha256, state: "ok" });
    }
    const integrationLeases = servedWorkflowIds.length === 0
      ? []
      : db.prepare(`select workflow_id, lease_json from execution_integration_leases where workflow_id in (${servedWorkflowIds.map(() => "?").join(",")}) order by workflow_id`)
          .all(...servedWorkflowIds) as Array<{ workflow_id: string; lease_json: string }>;
    for (const row of integrationLeases) {
      if (!servedIntegrationLeaseIds.has(row.workflow_id)) continue;
      const leaseSpec = spec("execution_integration_leases", "workflow", `execution/integration-leases/${row.workflow_id}`, { workflow_id: row.workflow_id });
      let value: unknown;
      try { value = JSON.parse(row.lease_json); } catch {
        recordInvalid(leaseSpec, row.lease_json, "invalid: integration lease is not valid JSON", "invalid");
        continue;
      }
      const validation = validateIntegrationMergeLease(value);
      if (!isPlainObject(value) || !validation.ok) {
        recordInvalid(leaseSpec, row.lease_json, `invalid: integration lease failed validation (${validation.violations.map((item) => item.code).join(", ")})`);
        continue;
      }
      const servedLease = servedWorkflowById.get(row.workflow_id)?.integrationLease;
      const mappedLease = servedLease;
      if (!mappedLease) continue;
      record(leaseSpec, row.lease_json);
      rows.leases.push({ workflowId: row.workflow_id, planId: text(mappedLease.plan_id) ?? "", kind: "integration-merge", holder: text(mappedLease.holder), worktreePath: null, expiresAt: text(mappedLease.expires_at) });
    }
    sources.sort((a,b) => a.sourceKey.localeCompare(b.sourceKey));
    locations.sort((a,b) => a.sourceKey.localeCompare(b.sourceKey));
    const sourceSetHash = computeSourceSetHash(inputs.catalogRevision, sources);
    return { formatVersion: PROJECTION_FORMAT_VERSION, catalogRevision: inputs.catalogRevision, storeRevision: capturedStoreRevision, sources, rows, diagnostics, sourceSetHash, blocked: diagnostics.length > 0, locations };
  } finally {
    handle.close();
  }
}

async function captureFileProjectionSources(context: StoreContext): Promise<ProjectionCapture> {
  const harness = catalogRootDir(context, "harness");
  const inputs = await readCatalogInputs(context);

  const sources: ProjectionSourceDigest[] = [];
  const locations: ProjectionSourceLocation[] = [];
  const diagnostics: SourceDiagnostic[] = [];
  const rows: ProjectionRows = { workflows: [], plans: [], leases: [], compasses: [] };

  const record = (
    spec: SourceSpec,
    read: { sha256: string | null },
    state: ProjectionSourceState,
    diagnostic: string | null,
    options: { tolerate?: boolean } = {},
  ): void => {
    sources.push({
      sourceKey: spec.sourceKey,
      kind: spec.kind,
      rootKind: spec.rootKind,
      relativePath: spec.relativePath,
      sha256: read.sha256,
      state,
      diagnostic,
      declared: spec.declared,
    });
    locations.push(
      spec.source === "file"
        ? { source: "file", sourceKey: spec.sourceKey, relativePath: spec.relativePath, absolutePath: spec.absolutePath, sha256: read.sha256, state }
        : { source: "database", sourceKey: spec.sourceKey, relativePath: spec.relativePath, sha256: read.sha256, state, table: spec.table, keys: spec.keys },
    );
    if (options.tolerate === true) return;
    if (state === "ok" && diagnostic === null) return;
    diagnostics.push({
      sourceKey: spec.sourceKey,
      reason: state === "ok" ? "changed-during-read" : state,
      message:
        diagnostic ??
        `the declared source ${spec.relativePath} could not be read; the in-memory capture keeps its state instead of inventing rows`,
    });
  };

  // --- root execution source ------------------------------------------------
  const rootSpec: SourceSpec = {
    source: "file",
    sourceKey: sourceKeyOf("root", "harness", PROJECTION_ROOT_FILE),
    kind: "root",
    rootKind: "harness",
    relativePath: PROJECTION_ROOT_FILE,
    absolutePath: join(harness, PROJECTION_ROOT_FILE),
    declared: true,
  };
  const rootRead = readSource(rootSpec);
  let declaredEntries: Array<{ id: string; dir: string }> = [];
  if (rootRead.state === "ok" && rootRead.content !== null) {
    const parsed = readRootSource(rootRead.content, harness);
    if (parsed.diagnostic !== null) {
      record(rootSpec, rootRead, "invalid", parsed.diagnostic);
    } else {
      declaredEntries = parsed.entries;
      record(rootSpec, rootRead, "ok", null);
    }
  } else {
    record(rootSpec, rootRead, rootRead.state, rootRead.diagnostic);
  }

  // --- workflow sources (root-declared, then retained history) --------------
  const declaredIds = new Set(declaredEntries.map((entry) => entry.id));
  const workflowSpecs: SourceSpec[] = declaredEntries.map((entry) => {
    const relativePath = `${entry.dir}/${WORKFLOW_SNAPSHOT_FILE}`;
    return {
      source: "file",
      sourceKey: sourceKeyOf("workflow", "harness", relativePath),
      kind: "workflow",
      rootKind: "harness",
      relativePath,
      absolutePath: join(harness, entry.dir, WORKFLOW_SNAPSHOT_FILE),
      declared: true,
    };
  });
  for (const binding of inputs.bindings) {
    if (declaredIds.has(binding.workflowId)) continue;
    const root = catalogRootDir(context, binding.rootKind);
    const relativePath = `${binding.relativePath}/${WORKFLOW_SNAPSHOT_FILE}`;
    workflowSpecs.push({
      source: "file",
      sourceKey: sourceKeyOf("workflow", binding.rootKind, relativePath),
      kind: "workflow",
      rootKind: binding.rootKind,
      relativePath,
      absolutePath: join(root, binding.relativePath, WORKFLOW_SNAPSHOT_FILE),
      declared: false,
    });
  }

  for (const spec of workflowSpecs) {
    const read = readSource(spec);
    if (read.state !== "ok" || read.content === null) {
      // A workflow that the root cleanly unregistered and whose snapshot was
      // removed is a valid source-set change: retain its catalog identity and
      // project nothing, without a diagnostic. Its row is still published with
      // `state = missing`, so a reader keys freshness on `projection_meta` and
      // never treats a missing row of a current generation as a failure. A
      // still-declared snapshot that is gone IS an error.
      record(spec, read, read.state, read.diagnostic, { tolerate: !spec.declared && read.state === "missing" });
      continue;
    }
    const derived = deriveWorkflowRows(read.content, spec.declared);
    if ("diagnostic" in derived) {
      record(spec, read, "invalid", derived.diagnostic);
      continue;
    }
    record(spec, read, "ok", null);
    rows.workflows.push(derived.workflow);
    rows.plans.push(...derived.plans);
    rows.leases.push(...derived.leases);
  }

  // --- catalog-linked compass documents ------------------------------------
  for (const doc of inputs.compassDocs) {
    const spec: SourceSpec = {
      source: "file",
      sourceKey: sourceKeyOf("compass", doc.rootKind, doc.relativePath),
      kind: "compass",
      rootKind: doc.rootKind,
      relativePath: doc.relativePath,
      absolutePath: join(catalogRootDir(context, doc.rootKind), doc.relativePath),
      declared: true,
    };
    const read = readSource(spec);
    if (read.state !== "ok" || read.content === null) {
      record(spec, read, read.state, read.diagnostic);
      continue;
    }
    const derived = deriveCompass(doc.iterationId, read.content, doc.relativePath);
    if ("diagnostic" in derived) {
      record(spec, read, "invalid", derived.diagnostic);
      continue;
    }
    record(spec, read, "ok", null);
    rows.compasses.push(derived);
  }


  sources.sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0));
  locations.sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0));
  const sourceSetHash = computeSourceSetHash(inputs.catalogRevision, sources);
  return {
    formatVersion: PROJECTION_FORMAT_VERSION,
    catalogRevision: inputs.catalogRevision,
    sources,
    rows,
    diagnostics,
    sourceSetHash,
    blocked: diagnostics.length > 0,
    locations,
  };
}

/**
 * Fingerprint (contract §5): SHA-256 over the sorted
 * `(canonical source key, existence/readability state, SHA-256 of the raw
 * bytes)` tuples, plus the projection format version and the catalog revision
 * (the catalog identity the compass paths and pin revisions came from). mtime and size are deliberately absent.
 */
function computeSourceSetHash(catalogRevision: number, sources: ProjectionSourceDigest[]): string {
  const tuples = sources
    .map((source) => [source.sourceKey, source.state, source.sha256 ?? "-"].join("\u0000"))
    .sort();
  const payload = [`projection-format:${PROJECTION_FORMAT_VERSION}`, `catalog-revision:${catalogRevision}`, ...tuples].join("\n");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

type ProjectionMetaRow = {
  generation: number | null;
  formatVersion: number;
  sourceSetHash: string | null;
  builtAt: string | null;
  checkedAt: string;
  freshness: ProjectionFreshness;
};

type SourceFingerprint = { sourceKey: string; state: string; sha256: string | null };

/** What moved under a publication attempt: named sources, or the catalog. */
type Movement = { kind: "sources"; keys: string[] } | { kind: "catalog" };

type PublishAttempt = { kind: "report"; report: RefreshReport } | { kind: "source-stale"; movement: Movement };

const PROJECTION_TABLES: readonly string[] = [
  "projection_sources",
  "projection_workflows",
  "projection_plans",
  "projection_leases",
  "projection_compasses",
];

/**
 * Re-read every captured source and compare `(state, sha256)`. This is the
 * "re-enumerate/re-hash before publication" step: a source that APPEARED or
 * DISAPPEARED implies either a root `status.json` rewrite (visible in the
 * root digest) or a catalog write (visible in the catalog revision compared
 * inside the publication transaction), so re-reading the captured locations
 * plus that revision comparison covers the whole source set.
 */
async function verifyCaptureStable(context: StoreContext, capture: ProjectionCapture): Promise<string[]> {
  const mismatched: string[] = [];
  const databaseLocations = capture.locations.filter((location) => location.source === "database");
  let handle: StoreHandle | undefined;
  if (databaseLocations.length > 0) {
    try {
      handle = await openStore(context, "read");
    } catch {
      return databaseLocations.map((location) => location.sourceKey).sort();
    }
  }
  try {
    for (const location of capture.locations) {
      const observed = readSource(location, handle?.db);
      const stableInvalidFile = location.source === "file" && location.state === "invalid" && observed.state === "ok" && observed.sha256 === location.sha256;
      if (!stableInvalidFile && (observed.state !== location.state || observed.sha256 !== location.sha256)) mismatched.push(location.sourceKey);
    }
  } finally {
    handle?.close();
  }
  return mismatched.sort();
}

function assertProjectionTables(handle: StoreHandle): void {
  const row = handle.db
    .prepare("select count(*) as n from sqlite_master where type = 'table' and name = 'projection_meta'")
    .get() as { n?: number } | undefined;
  if (!row?.n) {
    throw new ProjectionError(
      "projection.schema-outdated",
      `The store at schema version ${handle.schemaVersion} has no projection tables (migration 3 "execution-projections"). ` +
        `Apply the pending migrations through the store safe-upgrade path (mstar store safe-upgrade) and retry; nothing was projected.`,
    );
  }
}

function readProjectionMeta(db: StoreDb): ProjectionMetaRow {
  const row = db
    .prepare(
      "select generation, format_version, source_set_hash, built_at, checked_at, freshness from projection_meta where id = 1",
    )
    .get() as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new ProjectionError("projection.schema-outdated", "projection_meta has no current row; the store schema is incomplete");
  }
  const freshness = text(row.freshness);
  return {
    generation: typeof row.generation === "number" ? row.generation : null,
    formatVersion: typeof row.format_version === "number" ? row.format_version : 0,
    sourceSetHash: text(row.source_set_hash),
    builtAt: text(row.built_at),
    checkedAt: text(row.checked_at) ?? "",
    freshness: freshness === "current" || freshness === "stale" || freshness === "unavailable" ? freshness : "unavailable",
  };
}

/**
 * A format/version upgrade invalidates the published generation (contract §5:
 * old rows are never reinterpreted as authority). The projection tables are
 * the only discardable ones, so the whole generation is dropped here and the
 * store reports `unavailable` until a clean capture publishes again.
 */
function ensureProjectionFormat(db: StoreDb): ProjectionMetaRow {
  const meta = readProjectionMeta(db);
  if (meta.formatVersion === PROJECTION_FORMAT_VERSION) return meta;
  for (const table of PROJECTION_TABLES) db.exec(`delete from ${table}`);
  db.prepare(
    "update projection_meta set generation = null, format_version = ?, source_set_hash = null, built_at = null, " +
      "freshness = 'unavailable', last_error_json = null where id = 1",
  ).run(PROJECTION_FORMAT_VERSION);
  return readProjectionMeta(db);
}

function readPublishedFingerprints(db: StoreDb, generation: number | null): SourceFingerprint[] {
  if (generation === null) return [];
  return (
    db
      .prepare("select source_key, state, sha256 from projection_sources where generation = ? order by source_key asc")
      .all(generation) as Array<Record<string, unknown>>
  ).map((row) => ({
    sourceKey: text(row.source_key) ?? "",
    state: text(row.state) ?? "",
    sha256: text(row.sha256),
  }));
}

function changedSourceKeys(previous: SourceFingerprint[], next: ProjectionSourceDigest[]): string[] {
  const fingerprint = (entry: { state: string; sha256: string | null }): string => `${entry.state}\u0000${entry.sha256 ?? "-"}`;
  const before = new Map(previous.map((entry) => [entry.sourceKey, fingerprint(entry)]));
  const after = new Map(next.map((entry) => [entry.sourceKey, fingerprint(entry)]));
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((key) => before.get(key) !== after.get(key)).sort();
}

function insertGeneration(db: StoreDb, generation: number, capture: ProjectionCapture): void {
  const sourceStatement = db.prepare(
    "insert into projection_sources(generation, source_key, kind, root_kind, relative_path, sha256, state, diagnostic) " +
      "values (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const source of capture.sources) {
    sourceStatement.run(
      generation,
      source.sourceKey,
      source.kind,
      source.rootKind,
      source.relativePath,
      source.sha256,
      source.state,
      source.diagnostic,
    );
  }
  const workflowStatement = db.prepare(
    "insert into projection_workflows(generation, id, type, status, phase, started_at, ended_at, updated_at, " +
      "branch_base, branch_source, branch_integration, branch_target, active_registration) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const workflow of capture.rows.workflows) {
    workflowStatement.run(
      generation,
      workflow.id,
      workflow.type,
      workflow.status,
      workflow.phase,
      workflow.startedAt,
      workflow.endedAt,
      workflow.updatedAt,
      workflow.branchBase,
      workflow.branchSource,
      workflow.branchIntegration,
      workflow.branchTarget,
      workflow.activeRegistration ? 1 : 0,
    );
  }
  const planStatement = db.prepare(
    "insert into projection_plans(generation, workflow_id, plan_id, status, progress, phase, done_at, catalog_pin_revision) " +
      "values (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const plan of capture.rows.plans) {
    planStatement.run(
      generation,
      plan.workflowId,
      plan.planId,
      plan.status,
      plan.progress,
      plan.phase,
      plan.doneAt,
      plan.catalogPinRevision,
    );
  }
  const leaseStatement = db.prepare(
    "insert into projection_leases(generation, workflow_id, plan_id, kind, holder, worktree_path, expires_at) values (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const lease of capture.rows.leases) {
    leaseStatement.run(
      generation,
      lease.workflowId,
      lease.planId,
      lease.kind,
      lease.holder,
      lease.worktreePath,
      lease.expiresAt,
    );
  }
  const compassStatement = db.prepare(
    "insert into projection_compasses(generation, iteration_id, summary, milestones_json, started_at, ended_at, status) " +
      "values (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const compass of capture.rows.compasses) {
    compassStatement.run(
      generation,
      compass.iterationId,
      compass.summary,
      compass.milestonesJson,
      compass.startedAt,
      compass.endedAt,
      compass.status,
    );
  }

}

function reportOf(
  metadata: ProjectionMetadata,
  capture: ProjectionCapture,
  changedKeys: string[],
  published: boolean,
): RefreshReport {
  return {
    ...metadata,
    published,
    sourceSetHash: capture.sourceSetHash,
    sources: capture.sources,
    changedKeys,
  };
}

/**
 * Record a failed capture's health WITHOUT touching the last good generation:
 * only `checked_at`, `freshness` and `last_error_json` move, so `built_at` and
 * the published rows keep describing the last honest read.
 */
function recordRetainedHealth(
  db: StoreDb,
  capture: ProjectionCapture,
  movement: Movement | null,
  attempts: number,
  transactionOpen = false,
): RefreshReport {
  const checkedAt = new Date().toISOString();
  if (!transactionOpen) db.exec("begin immediate");
  try {
    const meta = ensureProjectionFormat(db);
    const diagnostics = [...capture.diagnostics, ...movementDiagnostics(movement, attempts)];
    const freshness: ProjectionFreshness = meta.generation === null ? "unavailable" : "stale";
    const changedKeys = capture.blocked && capture.sources.length === 0
      ? []
      : changedSourceKeys(readPublishedFingerprints(db, meta.generation), capture.sources);
    db.prepare("update projection_meta set checked_at = ?, freshness = ?, last_error_json = ? where id = 1").run(
      checkedAt,
      freshness,
      JSON.stringify({
        code: freshness === "unavailable" ? "projection.unavailable" : "projection.stale",
        message:
          freshness === "unavailable"
            ? "No projection generation has ever been published and this refresh could not read a coherent source set; the store reports unavailable instead of zero active work."
            : "At least one declared projection source failed; the last good generation was retained unchanged.",
        sources: diagnostics,
      }),
    );
    if (!transactionOpen) db.exec("commit");
    return reportOf(
      { generation: meta.generation, freshness, builtAt: meta.builtAt, checkedAt, diagnostics },
      capture,
      changedKeys,
      false,
    );
  } catch (error) {
    if (!transactionOpen) {
      try {
        db.exec("rollback");
      } catch {
        // connection-level failure during rollback -- nothing was committed
      }
    }
    throw error;
  }
}

/**
 * Diagnostics for a capture that lost the race (or never matched): the named
 * sources that moved, or the reserved `catalog` key when the catalog revision
 * moved instead of a file. `null` movement means the capture simply could not
 * be read -- the capture's own diagnostics already say why, and no movement
 * is invented.
 */
function movementDiagnostics(movement: Movement | null, attempts: number): SourceDiagnostic[] {
  if (movement === null) return [];
  const message =
    `the source set moved while it was being published (${attempts} capture attempt(s)); ` +
    "the last good generation was retained -- retry when the writers are idle";
  if (movement.kind === "catalog") return [{ sourceKey: "catalog", reason: "source-changing", message }];
  return movement.keys.map((sourceKey) => ({ sourceKey, reason: "source-changing", message }));
}

/**
 * Insert the replacement generation and flip the current one inside ONE short
 * write transaction, after re-verifying the captured sources (and comparing
 * the catalog revision inside that transaction). Identical captures keep the
 * published generation and only refresh `checked_at`/`freshness`.
 */
function publishGeneration(db: StoreDb, capture: ProjectionCapture, transactionOpen = false): RefreshReport {
  const checkedAt = new Date().toISOString();
  if (!transactionOpen) db.exec("begin immediate");
  try {
    const meta = ensureProjectionFormat(db);
    const previous = readPublishedFingerprints(db, meta.generation);
    const changedKeys = changedSourceKeys(previous, capture.sources);
    if (meta.generation !== null && meta.sourceSetHash === capture.sourceSetHash) {
      db.prepare("update projection_meta set checked_at = ?, freshness = 'current', last_error_json = null where id = 1").run(
        checkedAt,
      );
      if (!transactionOpen) db.exec("commit");
      return reportOf(
        { generation: meta.generation, freshness: "current", builtAt: meta.builtAt, checkedAt, diagnostics: [] },
        capture,
        [],
        false,
      );
    }
    const generation = (meta.generation ?? 0) + 1;
    for (const table of PROJECTION_TABLES) db.exec(`delete from ${table}`);
    insertGeneration(db, generation, capture);
    db.prepare(
      "update projection_meta set generation = ?, format_version = ?, source_set_hash = ?, built_at = ?, checked_at = ?, " +
        "freshness = 'current', last_error_json = null where id = 1",
    ).run(generation, capture.formatVersion, capture.sourceSetHash, checkedAt, checkedAt);
    if (!transactionOpen) db.exec("commit");
    return reportOf(
      { generation, freshness: "current", builtAt: checkedAt, checkedAt, diagnostics: [] },
      capture,
      changedKeys,
      true,
    );
  } catch (error) {
    if (!transactionOpen) {
      try {
        db.exec("rollback");
      } catch {
        // connection-level failure during rollback -- the last good rows survive
      }
    }
    throw error;
  }
}

function assertCaptureShape(capture: ProjectionCapture): void {
  const invalid = (message: string): never => {
    throw new ProjectionError("projection.invalid-capture", message);
  };
  if (!isPlainObject(capture)) invalid("capture must be an object");
  if (capture.formatVersion !== PROJECTION_FORMAT_VERSION) {
    invalid(`capture format version ${String(capture.formatVersion)} is not ${PROJECTION_FORMAT_VERSION}`);
  }
  if (!Array.isArray(capture.sources) || !Array.isArray(capture.locations) || !Array.isArray(capture.diagnostics)) {
    invalid("capture must carry sources, locations and diagnostics arrays");
  }
  if (!isPlainObject(capture.rows)) invalid("capture must carry projected rows");
  if (typeof capture.sourceSetHash !== "string" || !/^[0-9a-f]{64}$/.test(capture.sourceSetHash)) {
    invalid("capture.sourceSetHash must be a SHA-256 hex digest");
  }
  if (capture.locations.length !== capture.sources.length) {
    invalid("capture locations must line up with its source digests (both come from the same read)");
  }
  for (const location of capture.locations) {
    if (location.source !== "database") continue;
    const sourceError = databaseSourceLocationError(location);
    if (sourceError !== null) invalid(`capture ${sourceError}`);
  }
  if (capture.blocked && capture.diagnostics.length === 0) {
    invalid("a blocked capture must name the diagnostic that blocked it");
  }
}

async function attemptPublication(context: StoreContext, capture: ProjectionCapture, attempts: number): Promise<PublishAttempt> {
  const mismatched = await verifyCaptureStable(context, capture);
  if (mismatched.length > 0) return { kind: "source-stale", movement: { kind: "sources", keys: mismatched } };
  if (capture.storeRevision !== undefined) await applyDatabaseChurn(context);

  const handle = await openStore(context, "write");
  const db = handle.db;
  try {
    assertProjectionTables(handle);
    db.exec("begin immediate");
    if (capture.storeRevision !== undefined) {
      const storeRevision = db.prepare("select revision from store_meta where id = 1").get() as { revision: number };
      if (storeRevision.revision !== capture.storeRevision) {
        db.exec("rollback");
        return { kind: "source-stale", movement: { kind: "sources", keys: ["root:harness:execution/store-revision"] } };
      }
    }
    const revisionRow = db.prepare("select catalog_revision from store_meta where id = 1").get() as { catalog_revision?: unknown } | undefined;
    const catalogRevision = typeof revisionRow?.catalog_revision === "number" ? revisionRow.catalog_revision : 0;
    if (catalogRevision !== capture.catalogRevision) {
      db.exec("rollback");
      return { kind: "source-stale", movement: { kind: "catalog" } };
    }
    const report = capture.blocked
      ? recordRetainedHealth(db, capture, null, attempts, true)
      : publishGeneration(db, capture, true);
    db.exec("commit");
    return { kind: "report", report };
  } catch (error) {
    try { db.exec("rollback"); } catch { /* transaction may already be closed */ }
    throw error;
  } finally {
    handle.close();
  }
}

/**
 * Publish one explicitly captured source snapshot. A capture that no longer
 * matches the bytes on disk (or the catalog revision) refuses with
 * `projection.source-stale` instead of overwriting the newer generation --
 * two concurrent refreshers can therefore never publish an older capture over
 * a newer one. A capture whose sources failed records health only and returns
 * the retained-stale report; it never publishes a partial projection.
 */
export async function publishProjectionCapture(context: StoreContext, capture: ProjectionCapture): Promise<RefreshReport> {
  assertCaptureShape(capture);
  const attempt = await attemptPublication(context, capture, 1);
  if (attempt.kind === "source-stale") {
    const detail =
      attempt.movement.kind === "catalog"
        ? "the catalog revision moved"
        : attempt.movement.keys.join(", ");
    throw new ProjectionError(
      "projection.source-stale",
      `The capture no longer matches the current sources (${detail}). ` +
        "Nothing was published and the published generation is unchanged; capture again before publishing.",
    );
  }
  return attempt.report;
}

/**
 * The single source-I/O boundary (contract §5). Capture, publish, and when the
 * source set moved under the capture, one bounded retry; a second movement is
 * reported as `stale` with a `source-changing` diagnostic instead of a
 * fabricated generation. Never throws for a source problem -- only for an
 * unusable store (missing/outdated schema, busy writer), which the read
 * boundary must surface rather than cache.
 */
async function applyDatabaseChurn(context: StoreContext): Promise<void> {
  if (process.env.MSTAR_STORE_TEST_RUNNER !== "1") return;
  const encoded = process.env.MSTAR_PROJECTION_DB_CHURN;
  if (!encoded) return;
  const request: unknown = JSON.parse(encoded);
  const requests = Array.isArray(request) ? request : [request];
  const next = requests.shift();
  if (requests.length === 0) delete process.env.MSTAR_PROJECTION_DB_CHURN;
  else process.env.MSTAR_PROJECTION_DB_CHURN = JSON.stringify(requests);
  if (!isPlainObject(next) || (next.kind !== "insert-plan" && next.kind !== "update-row") ||
      typeof next.workflowId !== "string" || typeof next.planId !== "string") {
    throw new Error("invalid projection DB churn test request");
  }
  const handle = await openStore(context, "write");
  try {
    if (next.kind === "insert-plan") {
      handle.db.prepare(
        "insert into execution_plans(workflow_id, plan_id, revision, ordinal, state_json, coordination_json) " +
          "values (?, ?, 1, (select coalesce(max(ordinal), -1) + 1 from execution_plans where workflow_id = ?), ?, '{}')",
      ).run(next.workflowId, next.planId, next.workflowId, JSON.stringify({ id: next.planId, title: next.planId, file: `plans/${next.planId}.md`, status: "Todo" }));
    } else {
      const current = handle.db.prepare("select state_json from execution_workflows where workflow_id = ?").get(next.workflowId) as { state_json: string } | undefined;
      if (!current) throw new Error("projection DB churn workflow is missing");
      const state = JSON.parse(current.state_json) as Record<string, unknown>;
      state.updated_at = `${String(state.updated_at)}-churn`;
      handle.db.prepare("update execution_workflows set state_json = ? where workflow_id = ?").run(JSON.stringify(state), next.workflowId);
    }
    handle.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
  } finally {
    handle.close();
  }
}

export async function refreshProjections(context: StoreContext): Promise<RefreshReport> {
  let capture = await captureProjectionSources(context);
  let attempt = await attemptPublication(context, capture, 1);
  if (attempt.kind === "source-stale") {
    capture = await captureProjectionSources(context);
    attempt = await attemptPublication(context, capture, 2);
    if (attempt.kind === "source-stale") {
      const handle = await openStore(context, "write");
      try {
        assertProjectionTables(handle);
        return recordRetainedHealth(handle.db, capture, attempt.movement, 2);
      } finally {
        handle.close();
      }
    }
  }
  return attempt.report;
}
