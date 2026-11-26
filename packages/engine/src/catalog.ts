/**
 * catalog.ts — catalog authority: the typed entity registry, its relations
 * and the catalog receipt/query surface.
 *
 * Authority: `state-projection-contract.md` §2 (migration-2 schema and APIs)
 * and §1 (field-level authority separation). Catalog metadata is DB
 * authority; document bodies stay files and execution state (status, phase,
 * progress, leases, frozen inputs) stays JSON. This module therefore stores
 * no execution status and builds no projection.
 *
 * Boundary notes (P1):
 * - Identity is the composite `(kind, id)`; kind-scoped uniqueness means
 *   plan/iteration IDs keep their existing namespace.
 * - Relation targets are checked against both the allowed-pair table and the
 *   target row (plus the schema's own FKs), so a dangling or ill-typed
 *   relation is refused rather than stored.
 * - `relativePath` is relative to the already-resolved root for `rootKind`.
 *   Mutations refuse absolute paths, traversal, NUL and symlink escapes;
 *   readers disclose a missing location instead of refusing it.
 * - Registration writes are workspace-scoped domain verbs. Workflow-scoped
 *   authority (root/workflow locks, the registration journal's prepared →
 *   execution-written → committed ordering, execution pins) belongs to the
 *   registration service, not here.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, type Stats } from "node:fs";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import {
  assertSafePathComponent,
  canonicalizeNearestExisting,
  resolveIterationDir,
  resolveKnowledgeDir,
  resolvePlanDir,
  resolveProjectDir,
  resolveSpecsDir,
  resolveTrackedResultDir,
} from "./path.js";
import { mainWorktreeRoot, realpathNearest } from "./git-probe.js";
import {
  openCollaborationStore,
  readCollaborationObservation,
  withCollaborationWrite,
  type CollaborationScope,
  type CompleteCollaborationObservation,
} from "./collaboration-store.js";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import type { RemoteIntent, RemoteWriteOrigin } from "./collaboration-remote.js";
import { StoreError, type StoreContext, type StoreDb, storeDbPath } from "./store-db.js";

// ---------------------------------------------------------------------------
// Vocabulary (contract §2)
// ---------------------------------------------------------------------------

export type CatalogEntityKind = "project" | "iteration" | "plan" | "document";
export type CatalogRootKind = "repository" | "harness" | "plans" | "iterations" | "specs" | "knowledge" | "projects";
export type CatalogDocumentKind = "spec" | "knowledge" | "guide" | "compass" | "plan" | "review" | "other";

/**
 * note: The ONE document-kind vocabulary, shared by the local catalog verbs and the remote contract:
 * a wire shape that admits a value this list omits would let a retired kind re-enter through a
 * surface that never learned it was retired.
 */
export const DOCUMENT_KIND_NAMES = ["spec", "knowledge", "guide", "compass", "plan", "review", "other"] as const;

export type CatalogLifecycle = "active" | "archived" | "superseded";
export type CatalogRelation =
  | "belongs-to"
  | "documents"
  | "spec-ref"
  | "knowledge-ref"
  | "derived-from"
  | "supersedes";

const ENTITY_KINDS: Record<CatalogEntityKind, true> = {
  project: true,
  iteration: true,
  plan: true,
  document: true,
};
const ROOT_KINDS: Record<CatalogRootKind, true> = {
  repository: true,
  harness: true,
  plans: true,
  iterations: true,
  specs: true,
  knowledge: true,
  projects: true,
};
const DOCUMENT_KINDS: Record<CatalogDocumentKind, true> = {
  spec: true,
  knowledge: true,
  guide: true,
  compass: true,
  plan: true,
  review: true,
  other: true,
};
const LIFECYCLES: Record<CatalogLifecycle, true> = {
  active: true,
  archived: true,
  superseded: true,
};
const RELATIONS: Record<CatalogRelation, true> = {
  "belongs-to": true,
  documents: true,
  "spec-ref": true,
  "knowledge-ref": true,
  "derived-from": true,
  supersedes: true,
};

export type CatalogKey = { kind: CatalogEntityKind; id: string };

/**
 * Mutation input shared by the catalog verbs. `operationId` makes a retry
 * idempotent and `actor` names the seat/operator the request came from;
 * `expectedRevision` is enforced wherever the contract makes it mandatory
 * (a positional argument on `updateCatalogEntity`).
 */
export type CatalogOperation = {
  operationId: string;
  actor: string;
  expectedRevision?: number;
  /** note: The project journal a remote write appends to; a local/mirror write never reads it. */
  projectId?: string;
};

export type CatalogEntityInput = {
  kind: CatalogEntityKind;
  id: string;
  title: string;
  description?: string | null;
  rootKind: CatalogRootKind;
  relativePath: string;
  documentKind?: CatalogDocumentKind | null;
  lifecycle?: CatalogLifecycle;
  sourceHash?: string | null;
};

/** Catalog-only metadata/lifecycle patch; identity is never patched. */
export type CatalogEntityPatch = {
  title?: string;
  description?: string | null;
  rootKind?: CatalogRootKind;
  relativePath?: string;
  documentKind?: CatalogDocumentKind | null;
  lifecycle?: CatalogLifecycle;
  sourceHash?: string | null;
};

export type CatalogLinkInput = {
  from: CatalogKey;
  relation: CatalogRelation;
  to: CatalogKey;
  ordinal?: number | null;
};

export type CatalogReceipt = {
  kind: CatalogEntityKind;
  id: string;
  revision: number;
  storeRevision: number;
};

/**
 * A catalog row plus its read-only location disclosure: `absolutePath` is
 * the resolved destination and `present` reports whether it currently exists
 * (contract §2 — a stored historical location may be missing, and readers
 * disclose that instead of failing). Neither is a stored column.
 */
export type CatalogEntity = {
  kind: CatalogEntityKind;
  id: string;
  title: string;
  description: string | null;
  rootKind: CatalogRootKind;
  relativePath: string;
  documentKind: CatalogDocumentKind | null;
  lifecycle: CatalogLifecycle;
  revision: number;
  registeredAt: string;
  updatedAt: string;
  sourceHash: string | null;
  absolutePath: string;
  present: boolean;
};

export type CatalogLink = {
  fromKind: CatalogEntityKind;
  fromId: string;
  relation: CatalogRelation;
  toKind: CatalogEntityKind;
  toId: string;
  ordinal: number | null;
};

export type CatalogFilter = {
  kind?: CatalogEntityKind;
  documentKind?: CatalogDocumentKind;
  lifecycle?: CatalogLifecycle;
  /** Membership by `belongs-to`: entities linked to this project. */
  projectId?: string;
  /** Membership by `belongs-to`: entities linked to this iteration. */
  iterationId?: string;
  limit?: number;
  offset?: number;
};

export type CatalogPage = {
  items: CatalogEntity[];
  /** Every link incident to a listed item (either endpoint). */
  links: CatalogLink[];
  total: number;
  storeRevision: number;
};

export type CatalogDetail = {
  entity: CatalogEntity;
  /** Every link incident to this entity (either endpoint). */
  links: CatalogLink[];
  storeRevision: number;
};

/** Stable refusal codes; `store.*` are the shared issue-store codes. */
export type CatalogErrorCode =
  | "catalog.not-found"
  | "catalog.invalid-entity"
  | "catalog.invalid-filter"
  | "catalog.duplicate"
  | "catalog.revision-conflict"
  | "catalog.link-refused"
  | "catalog.path-refused"
  | "store.not-active"
  | "store.operation-conflict";

export class CatalogError extends Error {
  readonly code: CatalogErrorCode;

  constructor(code: CatalogErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "CatalogError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Location authority — resolved roots, normalization, escape refusal
// ---------------------------------------------------------------------------

/**
 * The already-resolved root for a `root_kind`. The harness root is the same
 * selected root as the database; process callers discover it before building
 * the StoreContext. The repository root is the main worktree that owns the
 * harness (its parent only when Git cannot name one) — the checkout the
 * `.agents/` corpora belong to. `.mstarc` overrides apply through the shared
 * resolvers.
 */
export function catalogRootDir(context: StoreContext, rootKind: CatalogRootKind): string {
  if (!Object.hasOwn(ROOT_KINDS, rootKind)) {
    throw new CatalogError(
      "catalog.path-refused",
      `"${String(rootKind)}" is not a configured catalog root kind; expected one of ${Object.keys(ROOT_KINDS).join(", ")}`,
    );
  }
  const harness = dirname(storeDbPath(context));
  const mainRoot = dirname(harness);
  // The repository root follows the caller's checkout for the same reason
  // tracked results do; another repository's checkout keeps its own root.
  // The harness may sit below the repository root (a nested `.mstar`), so
  // the repository root is the main worktree that owns the harness. The
  // `.agents/` corpora default there, never beside a harness that lives
  // outside the checkout.
  const repoRoot = mainWorktreeRoot(harness) ?? mainRoot;
  switch (rootKind) {
    case "repository": {
      if (context.checkoutRoot === undefined) return repoRoot;
      const callerMain = mainWorktreeRoot(context.checkoutRoot);
      return callerMain !== null && realpathNearest(callerMain) === realpathNearest(repoRoot)
        ? realpathNearest(context.checkoutRoot)
        : repoRoot;
    }
    case "harness":
      return harness;
    case "plans":
      return resolvePlanDir(harness);
    case "iterations":
      return resolveIterationDir(harness);
    // `create: false` — resolving a catalog location never creates a dir.
    // Tracked results follow the caller's checkout; only a context without one
    // falls back to the process harness.
    case "specs":
      return context.checkoutRoot === undefined
        ? resolveSpecsDir(harness, { create: false, repoRoot })
        : resolveTrackedResultDir(context.checkoutRoot, harness, "specsDir");
    case "knowledge":
      return context.checkoutRoot === undefined
        ? resolveKnowledgeDir(harness, { create: false, repoRoot })
        : resolveTrackedResultDir(context.checkoutRoot, harness, "knowledgeDir");
    case "projects":
      return resolveProjectDir(harness, { harnessDir: harness });
  }
}

/** Every configured root, resolved once per call (no repeated FS probing). */
function catalogRoots(context: StoreContext): Record<CatalogRootKind, string> {
  return {
    repository: catalogRootDir(context, "repository"),
    harness: catalogRootDir(context, "harness"),
    plans: catalogRootDir(context, "plans"),
    iterations: catalogRootDir(context, "iterations"),
    specs: catalogRootDir(context, "specs"),
    knowledge: catalogRootDir(context, "knowledge"),
    projects: catalogRootDir(context, "projects"),
  };
}

function pathRefused(message: string): CatalogError {
  return new CatalogError(
    "catalog.path-refused",
    `${message} -- no catalog write was made. Correct the --path value to a root-relative, non-traversing, non-empty path with no symlink escape (the user corrects the input value; no hidden-state repair needed).`,
  );
}

/**
 * Normalize a stored `relative_path` (contract §2): `/` separators, no
 * traversal, no NUL, never absolute. Returns the canonical stored form.
 */
function normalizeCatalogRelativePath(relativePath: string): string {
  if (typeof relativePath !== "string") {
    throw pathRefused("relativePath must be a string");
  }
  if (relativePath.includes("\0")) {
    throw pathRefused("relativePath contains a NUL byte");
  }
  const unified = relativePath.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) {
    throw pathRefused(`relativePath ${JSON.stringify(relativePath)} is absolute; it must be relative to its declared root`);
  }
  const segments: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      throw pathRefused(`relativePath ${JSON.stringify(relativePath)} contains a parent ("..") segment`);
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw pathRefused(`relativePath ${JSON.stringify(relativePath)} resolves to the root itself`);
  }
  return segments.join("/");
}

/**
 * Refuse a mutation destination that escapes its declared root: absolute or
 * traversing input (already removed by normalization), a canonical target
 * outside the canonical root (`..` through an existing symlinked ancestor),
 * or a symlinked component whose realpath is outside the root — including a
 * dangling symlink, whose destination cannot be proven inside the root and
 * whose write would land on the link target.
 */
function assertPathContained(root: string, relativePath: string): void {
  const canonicalRoot = canonicalizeNearestExisting(root);
  let walked = root;
  for (const segment of relativePath.split("/")) {
    walked = join(walked, segment);
    let stats: Stats;
    try {
      stats = lstatSync(walked);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") break; // lexical tail — nothing further exists
      throw pathRefused(`relativePath cannot be checked against ${root}: ${(error as Error).message}`);
    }
    if (!stats.isSymbolicLink()) continue;
    let resolved: string;
    try {
      resolved = realpathSync(walked);
    } catch {
      throw pathRefused(`relativePath crosses ${walked}, a dangling symlink, so its destination is not inside ${canonicalRoot}`);
    }
    if (resolved !== canonicalRoot && !resolved.startsWith(`${canonicalRoot}${sep}`)) {
      throw pathRefused(`relativePath crosses the symlink ${walked} -> ${resolved}, outside ${canonicalRoot}`);
    }
    walked = resolved;
  }
  const canonicalTarget = canonicalizeNearestExisting(join(root, relativePath));
  if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(`${canonicalRoot}${sep}`)) {
    throw pathRefused(`relativePath resolves to ${canonicalTarget}, outside ${canonicalRoot}`);
  }
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function requestHash(kind: string, payload: unknown): string {
  return createHash("sha256").update(`${kind}\n${JSON.stringify(payload)}`, "utf8").digest("hex");
}

function nowRfc3339(): string {
  return new Date().toISOString();
}

function invalid(message: string): CatalogError {
  return new CatalogError("catalog.invalid-entity", message);
}

function requireEntityKind(kind: unknown, code: CatalogErrorCode = "catalog.invalid-entity"): CatalogEntityKind {
  if (typeof kind !== "string" || !Object.hasOwn(ENTITY_KINDS, kind)) {
    throw new CatalogError(
      code,
      `"${String(kind)}" is not a catalog entity kind; expected one of ${Object.keys(ENTITY_KINDS).join(", ")}`,
    );
  }
  return kind as CatalogEntityKind;
}

function requireDocumentKind(
  kind: unknown,
  code: CatalogErrorCode = "catalog.invalid-entity",
): CatalogDocumentKind {
  if (typeof kind !== "string" || !Object.hasOwn(DOCUMENT_KINDS, kind)) {
    throw new CatalogError(
      code,
      `"${String(kind)}" is not a document kind; expected one of ${Object.keys(DOCUMENT_KINDS).join(", ")}`,
    );
  }
  return kind as CatalogDocumentKind;
}

function requireLifecycle(lifecycle: unknown, code: CatalogErrorCode = "catalog.invalid-entity"): CatalogLifecycle {
  if (typeof lifecycle !== "string" || !Object.hasOwn(LIFECYCLES, lifecycle)) {
    throw new CatalogError(
      code,
      `"${String(lifecycle)}" is not a catalog lifecycle; expected one of ${Object.keys(LIFECYCLES).join(", ")}`,
    );
  }
  return lifecycle as CatalogLifecycle;
}

function requireNonblank(label: string, value: unknown, code: CatalogErrorCode = "catalog.invalid-entity"): string {
  if (typeof value !== "string" || value.trim() === "") throw new CatalogError(code, `${label} must be nonblank`);
  return value.trim();
}

/**
 * Identity is a name, not a path: it keeps the harness's existing safe
 * path-component convention so a catalog id can never be interpolated into a
 * location by a later consumer. Kind-scoped uniqueness is unchanged.
 */
function requireCatalogId(label: string, value: unknown): string {
  const id = requireNonblank(label, value);
  try {
    assertSafePathComponent(id, label);
  } catch (error) {
    throw invalid(`${label} ${JSON.stringify(id)} is not a safe catalog id (${(error as Error).message})`);
  }
  return id;
}

function requireKey(label: string, key: CatalogKey | undefined): CatalogKey {
  if (!key || typeof key !== "object") throw invalid(`${label} must be a {kind, id} catalog key`);
  return { kind: requireEntityKind(key.kind), id: requireCatalogId(`${label}.id`, key.id) };
}

function normalizeDescription(description: unknown): string | null {
  if (description === undefined || description === null) return null;
  if (typeof description !== "string") throw invalid("description must be a string or null");
  const trimmed = description.trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeSourceHash(sourceHash: unknown): string | null {
  if (sourceHash === undefined || sourceHash === null) return null;
  if (typeof sourceHash !== "string" || sourceHash.trim() === "") {
    throw invalid("sourceHash must be a nonblank string or null");
  }
  return sourceHash.trim();
}

/** The stored shape of a registration input, after every refusal. */
type EntityRecord = {
  kind: CatalogEntityKind;
  id: string;
  title: string;
  description: string | null;
  rootKind: CatalogRootKind;
  relativePath: string;
  documentKind: CatalogDocumentKind | null;
  lifecycle: CatalogLifecycle;
  sourceHash: string | null;
};

/**
 * `document_kind` classifies a document row only (§2): required for
 * `kind=document` (identity includes its kind, §1) and refused on every
 * other entity kind.
 */
function normalizeDocumentKind(kind: CatalogEntityKind, documentKind: unknown): CatalogDocumentKind | null {
  if (kind === "document") {
    if (documentKind === undefined || documentKind === null) {
      throw invalid("a document entity requires documentKind (spec|knowledge|guide|compass|plan|review|other)");
    }
    return requireDocumentKind(documentKind);
  }
  if (documentKind !== undefined && documentKind !== null) {
    throw invalid(`documentKind is only valid on a document entity, not on a ${kind} entity`);
  }
  return null;
}

function normalizeEntityInput(context: StoreContext, input: CatalogEntityInput): EntityRecord {
  if (!input || typeof input !== "object") throw invalid("a catalog registration input is required");
  const kind = requireEntityKind(input.kind);
  const id = requireCatalogId("id", input.id);
  const title = requireNonblank("title", input.title);
  const rootKind = input.rootKind;
  if (typeof rootKind !== "string" || !Object.hasOwn(ROOT_KINDS, rootKind)) {
    throw new CatalogError(
      "catalog.path-refused",
      `"${String(rootKind)}" is not a configured catalog root kind; expected one of ${Object.keys(ROOT_KINDS).join(", ")}`,
    );
  }
  const relativePath = normalizeCatalogRelativePath(input.relativePath);
  assertPathContained(catalogRootDir(context, rootKind as CatalogRootKind), relativePath);
  return {
    kind,
    id,
    title,
    description: normalizeDescription(input.description),
    rootKind: rootKind as CatalogRootKind,
    relativePath,
    documentKind: normalizeDocumentKind(kind, input.documentKind),
    lifecycle: input.lifecycle === undefined ? "active" : requireLifecycle(input.lifecycle),
    sourceHash: normalizeSourceHash(input.sourceHash),
  };
}

/** The patch as written, before the target row supplies its effective values. */
type EntityPatchRecord = {
  title?: string;
  description?: string | null;
  rootKind?: CatalogRootKind;
  relativePath?: string;
  documentKind?: CatalogDocumentKind | null;
  lifecycle?: CatalogLifecycle;
  sourceHash?: string | null;
};

function normalizePatch(input: CatalogEntityPatch | undefined): EntityPatchRecord {
  if (!input || typeof input !== "object") throw invalid("an update patch is required");
  const patch: EntityPatchRecord = {};
  if (input.title !== undefined) patch.title = requireNonblank("title", input.title);
  if (input.description !== undefined) patch.description = normalizeDescription(input.description);
  if (input.rootKind !== undefined) {
    if (typeof input.rootKind !== "string" || !Object.hasOwn(ROOT_KINDS, input.rootKind)) {
      throw new CatalogError(
        "catalog.path-refused",
        `"${String(input.rootKind)}" is not a configured catalog root kind; expected one of ${Object.keys(ROOT_KINDS).join(", ")}`,
      );
    }
    patch.rootKind = input.rootKind as CatalogRootKind;
  }
  if (input.relativePath !== undefined) patch.relativePath = normalizeCatalogRelativePath(input.relativePath);
  if (input.documentKind !== undefined) {
    patch.documentKind = input.documentKind === null ? null : requireDocumentKind(input.documentKind);
  }
  if (input.lifecycle !== undefined) patch.lifecycle = requireLifecycle(input.lifecycle);
  if (input.sourceHash !== undefined) patch.sourceHash = normalizeSourceHash(input.sourceHash);
  if (Object.keys(patch).length === 0) throw invalid("the update patch changes nothing");
  return patch;
}

function requireOperation(operation: CatalogOperation | undefined): { operationId: string; actor: string } {
  if (!operation || typeof operation !== "object") {
    throw new CatalogError("store.operation-conflict", "a catalog mutation requires an operationId and an actor");
  }
  return { operationId: requireNonblank("operationId", operation.operationId), actor: requireNonblank("actor", operation.actor) };
}

function requireExpectedRevision(expectedRevision: unknown): number {
  if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new CatalogError(
      "catalog.revision-conflict",
      "expectedRevision is mandatory for a catalog update and must be the revision read from the catalog",
    );
  }
  return expectedRevision;
}

/**
 * Allowed relation pairs (§2). A pair outside this table is refused before
 * the schema check ever sees it, so the refusal names the pair.
 */
function assertAllowedLink(from: CatalogKey, relation: CatalogRelation, to: CatalogKey): void {
  if (!Object.hasOwn(RELATIONS, relation)) {
    throw new CatalogError(
      "catalog.link-refused",
      `"${String(relation)}" is not a catalog relation; expected one of ${Object.keys(RELATIONS).join(", ")}`,
    );
  }
  if (from.kind === to.kind && from.id === to.id) {
    throw new CatalogError("catalog.link-refused", `a ${from.kind} cannot carry ${relation} to itself`);
  }
  const allowed =
    relation === "belongs-to"
      ? (to.kind === "project" && (from.kind === "plan" || from.kind === "iteration" || from.kind === "document")) ||
        (from.kind === "plan" && to.kind === "iteration")
      : relation === "documents"
        ? to.kind === "document" && (from.kind === "iteration" || from.kind === "project" || from.kind === "plan")
        : relation === "supersedes"
          ? from.kind === to.kind
          : // spec-ref | knowledge-ref | derived-from
            to.kind === "document" && (from.kind === "plan" || from.kind === "iteration" || from.kind === "document");
  if (!allowed) {
    throw new CatalogError(
      "catalog.link-refused",
      `${from.kind} --${relation}--> ${to.kind} is not an allowed catalog relation pair`,
    );
  }
}

function normalizeOrdinal(ordinal: unknown): number | null {
  if (ordinal === undefined || ordinal === null) return null;
  if (typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal < 0) {
    throw invalid("ordinal must be a nonnegative integer or null");
  }
  return ordinal;
}

// ---------------------------------------------------------------------------
// Row mapping and reads
// ---------------------------------------------------------------------------

const ENTITY_COLUMNS =
  "kind, id, title, description, root_kind, relative_path, document_kind, lifecycle, revision, registered_at, updated_at, source_hash";

type EntityRow = {
  kind: CatalogEntityKind;
  id: string;
  title: string;
  description: string | null;
  root_kind: CatalogRootKind;
  relative_path: string;
  document_kind: CatalogDocumentKind | null;
  lifecycle: CatalogLifecycle;
  revision: number;
  registered_at: string;
  updated_at: string;
  source_hash: string | null;
};

function toCatalogEntity(row: EntityRow, roots: Record<CatalogRootKind, string>): CatalogEntity {
  const absolutePath = join(roots[row.root_kind], row.relative_path);
  return {
    kind: row.kind,
    id: row.id,
    title: row.title,
    description: row.description,
    rootKind: row.root_kind,
    relativePath: row.relative_path,
    documentKind: row.document_kind,
    lifecycle: row.lifecycle,
    revision: row.revision,
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
    sourceHash: row.source_hash,
    absolutePath,
    present: existsSync(absolutePath),
  };
}

function readEntity(db: StoreDb, kind: CatalogEntityKind, id: string): EntityRow | undefined {
  return db.prepare(`select ${ENTITY_COLUMNS} from catalog_entities where kind = ? and id = ?`).get(kind, id) as
    | EntityRow
    | undefined;
}

function findEntityByLocation(
  db: StoreDb,
  kind: CatalogEntityKind,
  rootKind: CatalogRootKind,
  relativePath: string,
): EntityRow | undefined {
  return db
    .prepare(`select ${ENTITY_COLUMNS} from catalog_entities where kind = ? and root_kind = ? and relative_path = ?`)
    .get(kind, rootKind, relativePath) as EntityRow | undefined;
}

type LinkRow = {
  from_kind: CatalogEntityKind;
  from_id: string;
  relation: CatalogRelation;
  to_kind: CatalogEntityKind;
  to_id: string;
  ordinal: number | null;
};

const LINK_COLUMNS = "from_kind, from_id, relation, to_kind, to_id, ordinal";

const LINK_ORDER = "order by from_kind asc, from_id asc, relation asc, to_kind asc, to_id asc";

/** Every link incident to any of `keys`, either endpoint, deterministic order. */
function incidentLinks(db: StoreDb, keys: readonly CatalogKey[]): CatalogLink[] {
  if (keys.length === 0) return [];
  const tuples = keys.map(() => "(?, ?)").join(", ");
  const params = keys.flatMap((key) => [key.kind, key.id]);
  const rows = db
    .prepare(
      `select ${LINK_COLUMNS} from catalog_links ` +
        `where (from_kind, from_id) in (values ${tuples}) or (to_kind, to_id) in (values ${tuples}) ${LINK_ORDER}`,
    )
    .all(...params, ...params) as LinkRow[];
  return rows.map((row) => ({
    fromKind: row.from_kind,
    fromId: row.from_id,
    relation: row.relation,
    toKind: row.to_kind,
    toId: row.to_id,
    ordinal: row.ordinal,
  }));
}

/** §2 the store's three revisions, as one read: the pair a mutation records plus the authority state it requires. */
export type CatalogStoreVersions = { storeRevision: number; catalogRevision: number; authorityState: string };

/**
 * §3.1 the SHARED store revision of the transaction a COMPOSED caller already
 * owns. A caller that owns the transaction also owns its single advance of
 * `store_meta.revision` (§3.1: one increment per accepted multi-domain
 * transaction), so it tells the composed publish the revision the transaction
 * commits at and every published row JOINS that advance — a second row in the
 * same transaction must not move the shared counter again. The catalog revision
 * is this domain's own counter and keeps advancing once per published row.
 *
 * Only the composed route supplies one: on the public route the catalog mutation
 * IS the transaction, so it advances the shared counter itself, exactly as
 * before. The handle is the caller's statement about its own transaction, never
 * something a catalog request can carry.
 */
export type ComposedStoreRevision = {
  /** The `store_meta.revision` value this transaction commits at. */
  committedStoreRevision: number;
};

/**
 * The same versions, read through a handle the caller ALREADY owns. The
 * registration's active route composes catalog writes into the one execution
 * transaction, so it reads the expectation (`catalogRevision`) and the
 * published revision on its own handle instead of opening a second connection
 * — one reader for both transports.
 */
export function readCatalogStoreVersionsOn(db: StoreDb): CatalogStoreVersions {
  const row = db
    .prepare("select authority_state, revision, catalog_revision from collaboration_meta where id = 1")
    .get() as { authority_state?: unknown; revision?: unknown; catalog_revision?: unknown } | undefined;
  if (typeof row?.authority_state !== "string" || typeof row.revision !== "number" || typeof row.catalog_revision !== "number") {
    throw new CatalogError("store.not-active", "collaboration_meta is missing; the catalog requires the repository's collaboration authority. Run mstar store init (fresh scope) or the reviewed collaboration apply/activate sequence, then retry.");
  }
  return { storeRevision: row.revision, catalogRevision: row.catalog_revision, authorityState: row.authority_state };
}

function assertCatalogActive(db: StoreDb): void {
  const versions = readCatalogStoreVersionsOn(db);
  if (versions.authorityState !== "active") {
    throw new CatalogError(
      "store.not-active",
      `The catalog store is ${versions.authorityState}; catalog mutations require an active store (\u00a72 issues contract: a staged store is read-only to ordinary domain verbs). Run mstar store upgrade --operator <name> (one-command minimal activation) or mstar store activate --manifest <migration.json> --attestation <file.json>, then retry.`,
    );
  }
}

/**
 * Only a published catalog mutation advances the catalog revision (§2) — and
 * the SHARED store revision belongs to the transaction rather than to this
 * domain: when a composed caller has already advanced it once, the row joins
 * that advance (§3.1) instead of moving the same counter a second time, while
 * still reporting the revision the transaction commits at.
 */
function bumpCatalogRevisions(db: StoreDb, composed?: ComposedStoreRevision): CatalogStoreVersions {
  if (composed !== undefined) {
    db.prepare("update collaboration_meta set catalog_revision = catalog_revision + 1 where id = 1").run();
    return { ...readCatalogStoreVersionsOn(db), storeRevision: composed.committedStoreRevision };
  }
  db.prepare("update collaboration_meta set revision = revision + 1, catalog_revision = catalog_revision + 1 where id = 1").run();
  return readCatalogStoreVersionsOn(db);
}

type CatalogDelta = { mutation: string; action: string; key: CatalogKey | { from: CatalogKey; relation: string; to: CatalogKey } };

function commitOperation(
  db: StoreDb,
  operation: { operationId: string },
  hash: string,
  receipt: CatalogReceipt,
  before: CatalogStoreVersions,
  after: CatalogStoreVersions,
  delta: CatalogDelta,
): CatalogReceipt {
  const at = nowRfc3339();
  db.prepare(
    "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) " +
      "values (?, ?, 'committed', ?, ?, ?, ?, ?, ?)",
  ).run(
    operation.operationId,
    hash,
    JSON.stringify(delta),
    JSON.stringify({ storeRevision: before.storeRevision, catalogRevision: before.catalogRevision }),
    JSON.stringify({ storeRevision: after.storeRevision, catalogRevision: after.catalogRevision }),
    JSON.stringify(receipt),
    at,
    at,
  );
  return receipt;
}

function lookupOperation(db: StoreDb, operationId: string): { request_hash: string; result_json: string | null } | undefined {
  return db
    .prepare("select request_hash, result_json from catalog_operations where operation_id = ?")
    .get(operationId) as { request_hash: string; result_json: string | null } | undefined;
}

/** Duplicate operation + identical request returns the original receipt. */
function replayOperation(existing: { request_hash: string; result_json: string | null }, hash: string): CatalogReceipt {
  if (existing.request_hash !== hash || existing.result_json === null) {
    throw new CatalogError(
      "store.operation-conflict",
      "The same operationId was reused with a different request; the original catalog receipt is retained.",
    );
  }
  return JSON.parse(existing.result_json) as CatalogReceipt;
}

function receiptOf(row: EntityRow, storeRevision: number): CatalogReceipt {
  return { kind: row.kind, id: row.id, revision: row.revision, storeRevision };
}

async function withCatalogWrite<T>(context: StoreContext, fn: (db: StoreDb) => T): Promise<T> {
  return withCollaborationWrite(context, (handle) => fn(handle.db));
}

/**
 * note: The remote branch of every catalog write: the portable catalog is part of a project journal,
 * so the change is frozen as one durable project-replace intent against the observed document.
 * Location facts (root kind, relative path, source hash) are checkout evidence the remote
 * document does not carry; the portable identity, metadata and lifecycle are what it publishes.
 */
/**
 * note: The confirmed business result of a remote catalog write: the frozen document is the
 * recorded effect, so the row's revision comes from it. A remote write owns no local store
 * revision, so `storeRevision` is 0 exactly as a remote composite's collaboration revision is.
 */
function confirmedCatalogReceipt(intent: RemoteIntent, kind: CatalogReceipt["kind"], id: string): CatalogReceipt {
  const confirmed = intent.confirmed;
  if (confirmed === null) {
    throw new CatalogError(
      "catalog.revision-conflict",
      `Operation ${intent.operationId} is confirmed without a recorded provider effect; nothing was read or changed.`,
    );
  }
  const change = confirmed.event.change;
  const entities = change.kind === "project-replace" ? (change.project.catalogEntities as Array<Record<string, unknown>>) : [];
  const row = entities.find((entity) => entity.kind === kind && entity.id === id);
  return { kind, id, revision: typeof row?.revision === "number" ? row.revision : 0, storeRevision: 0 };
}

async function queueCatalogWrite(
  context: StoreContext,
  operation: CatalogOperation,
  entity: Readonly<{ kind: CatalogReceipt["kind"]; id: string }>,
  origin: RemoteWriteOrigin,
  next: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<CatalogReceipt> {
  const projectId = operation.projectId;
  if (typeof projectId !== "string" || projectId.trim() === "") {
    throw new CatalogError(
      "catalog.invalid-entity",
      "A remote catalog write appends to one project journal; name it with `projectId`. Nothing was enqueued.",
    );
  }
  // note: Dynamic on purpose — collaboration-remote.ts imports this module, so a static import
  // would close the cycle before the catalog contract initializes.
  const { prepareRemoteProjectWrite, pendingRemoteEffect } = await import("./collaboration-remote.js");
  const intent = await prepareRemoteProjectWrite(context, {
    projectId: projectId.trim(),
    operationId: operation.operationId,
    origin,
    next,
  });
  if (intent.confirmed !== null) return confirmedCatalogReceipt(intent, entity.kind, entity.id);
  throw pendingRemoteEffect(intent);
}

/** note: The observed portable entities of one project journal. */
function observedEntities(current: Record<string, unknown>): Array<Record<string, unknown>> {
  return current.catalogEntities as Array<Record<string, unknown>>;
}

/** note: The observed portable links of one project journal. */
function observedLinks(current: Record<string, unknown>): Array<Record<string, unknown>> {
  return current.catalogLinks as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Mutations (contract §2)
// ---------------------------------------------------------------------------

/**
 * Create a catalog row, or attach to the one that already owns the canonical
 * location. The composite `(kind, id)` is the identity: re-registering the
 * same identity at the same location is an idempotent no-op, an existing
 * identity at a different location is refused (never relocated behind the
 * caller's back), and a *different* id at an already-registered location
 * attaches to that row instead of minting a duplicate (`(kind, root_kind,
 * relative_path)` is unique). The operation is journalled in every branch,
 * so a replay returns the original receipt.
 */
export async function registerCatalogEntity(
  context: StoreContext,
  input: CatalogEntityInput,
  operation: CatalogOperation,
): Promise<CatalogReceipt> {
  if (resolveCollaborationLocation(context).mode === "remote") {
    const op = requireOperation(operation);
    const kind = requireEntityKind(input?.kind);
    const id = requireCatalogId("id", input?.id);
    const title = requireNonblank("title", input?.title);
    const description = normalizeDescription(input?.description);
    const documentKind = normalizeDocumentKind(kind, input?.documentKind);
    const lifecycle = input?.lifecycle === undefined ? "active" : requireLifecycle(input.lifecycle);
    return queueCatalogWrite(
      context,
      { ...op, projectId: operation.projectId },
      { kind, id },
      { verb: "catalog-register", request: { projectId: operation.projectId, kind, id, title, description, documentKind, lifecycle } },
      (current) => {
        const entities = observedEntities(current);
        if (entities.some((entity) => entity.kind === kind && entity.id === id)) {
          throw new CatalogError("catalog.duplicate", `${kind} ${id} is already registered in the observed project; nothing was enqueued.`);
        }
        return {
          ...current,
          catalogEntities: [...entities, { kind, id, title, description, documentKind, lifecycle, revision: 1 }],
        };
      },
    );
  }
  return withCatalogWrite(context, (db) => registerCatalogEntityOn(db, context, input, operation));
}

/**
 * §2 the same create/attach rule on a handle the caller ALREADY owns. The
 * registration's active route publishes its reviewed delta inside the ONE
 * execution transaction, so it composes this instead of opening a second
 * connection: one implementation of the identity/location/uniqueness rules for
 * both transports, and no nested `begin` for a caller that already owns one.
 * The authority gate the frame used to run before `begin` runs here instead —
 * inside the caller's transaction, under its write lock. A composing caller also
 * passes its `ComposedStoreRevision`, so the published row joins the
 * transaction's single shared store-revision advance instead of moving that
 * counter again.
 */
export function registerCatalogEntityOn(
  db: StoreDb,
  context: StoreContext,
  input: CatalogEntityInput,
  operation: CatalogOperation,
  composed?: ComposedStoreRevision,
): CatalogReceipt {
  assertCatalogActive(db);
  const op = requireOperation(operation);
  const record = normalizeEntityInput(context, input);
  const hash = requestHash("registerCatalogEntity", { record, ...op });

  const before = readCatalogStoreVersionsOn(db);
  const existingOp = lookupOperation(db, op.operationId);
  if (existingOp) return replayOperation(existingOp, hash);

  const existing = readEntity(db, record.kind, record.id);
  if (existing) {
    if (existing.root_kind !== record.rootKind || existing.relative_path !== record.relativePath) {
      throw new CatalogError(
        "catalog.duplicate",
        `${record.kind} ${record.id} is already registered at ${existing.root_kind}/${existing.relative_path}; ` +
          `existing IDs are preserved -- updateCatalogEntity is the only verb that relocates one. Discover the current revision with mstar catalog show <kind> <id>, then relocate it with mstar catalog update <kind> <id> --path <new> [--root-kind <k>] --expect <revision> --operation-id <id> --actor <role>.`,
      );
    }
    return commitOperation(
      db,
      op,
      hash,
      receiptOf(existing, before.storeRevision),
      before,
      before,
      { mutation: "registerCatalogEntity", action: "noop-identical", key: { kind: record.kind, id: record.id } },
    );
  }

  const located = findEntityByLocation(db, record.kind, record.rootKind, record.relativePath);
  if (located) {
    return commitOperation(
      db,
      op,
      hash,
      receiptOf(located, before.storeRevision),
      before,
      before,
      { mutation: "registerCatalogEntity", action: "attach-existing-location", key: { kind: located.kind, id: located.id } },
    );
  }

  const at = nowRfc3339();
  db.prepare(
    "insert into catalog_entities(kind, id, title, description, root_kind, relative_path, document_kind, lifecycle, revision, registered_at, updated_at, source_hash) " +
      "values (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
  ).run(
    record.kind,
    record.id,
    record.title,
    record.description,
    record.rootKind,
    record.relativePath,
    record.documentKind,
    record.lifecycle,
    at,
    at,
    record.sourceHash,
  );
  const after = bumpCatalogRevisions(db, composed);
  return commitOperation(
    db,
    op,
    hash,
    { kind: record.kind, id: record.id, revision: 1, storeRevision: after.storeRevision },
    before,
    after,
    { mutation: "registerCatalogEntity", action: "created", key: { kind: record.kind, id: record.id } },
  );
}

/**
 * Change catalog-only metadata/lifecycle. `expectedRevision` must be the
 * revision the caller read: a stale or absent expectation refuses
 * `catalog.revision-conflict` and the transaction rolls back with nothing
 * changed. A relocation is revalidated against the containing root and the
 * location uniqueness rule.
 */
export async function updateCatalogEntity(
  context: StoreContext,
  key: CatalogKey,
  patch: CatalogEntityPatch,
  expectedRevision: number,
  operation: CatalogOperation,
): Promise<CatalogReceipt> {
  const op = requireOperation(operation);
  const target = requireKey("key", key);
  const expected = requireExpectedRevision(expectedRevision);
  const record = normalizePatch(patch);
  if (resolveCollaborationLocation(context).mode === "remote") {
    return queueCatalogWrite(
      context,
      { ...op, projectId: operation.projectId },
      target,
      { verb: "catalog-update", request: { projectId: operation.projectId, key: target, patch: record, expectedRevision: expected } },
      (current) => {
      const entities = observedEntities(current);
      const row = entities.find((entity) => entity.kind === target.kind && entity.id === target.id);
      if (row === undefined) throw new CatalogError("catalog.not-found", `${target.kind} ${target.id} is not registered in the observed project`);
      if (row.revision !== expected) {
        throw new CatalogError(
          "catalog.revision-conflict",
          `${target.kind} ${target.id} is at revision ${String(row.revision)}, not the expected ${expected}; nothing was enqueued.`,
        );
      }
      return {
        ...current,
        catalogEntities: entities.map((entity) =>
          entity.kind === target.kind && entity.id === target.id
            ? {
                ...entity,
                title: record.title ?? entity.title,
                description: record.description !== undefined ? record.description : entity.description,
                documentKind:
                  record.documentKind !== undefined
                    ? normalizeDocumentKind(target.kind, record.documentKind)
                    : entity.documentKind,
                lifecycle: record.lifecycle !== undefined ? requireLifecycle(record.lifecycle) : entity.lifecycle,
                revision: (entity.revision as number) + 1,
              }
            : entity,
        ),
      };
      },
    );
  }
  const hash = requestHash("updateCatalogEntity", { target, record, expected, ...op });

  return withCatalogWrite(context, (db) => {
    assertCatalogActive(db);
    const before = readCatalogStoreVersionsOn(db);
    const existingOp = lookupOperation(db, op.operationId);
    if (existingOp) return replayOperation(existingOp, hash);

    const row = readEntity(db, target.kind, target.id);
    if (!row) throw new CatalogError("catalog.not-found", `${target.kind} ${target.id} is not registered`);
    if (row.revision !== expected) {
      throw new CatalogError(
        "catalog.revision-conflict",
        `${target.kind} ${target.id} is at revision ${row.revision}, not the expected ${expected}; nothing was changed.`,
      );
    }

    const rootKind = record.rootKind ?? row.root_kind;
    const relativePath = record.relativePath ?? row.relative_path;
    if (record.rootKind !== undefined || record.relativePath !== undefined) {
      assertPathContained(catalogRootDir(context, rootKind), relativePath);
      const collision = findEntityByLocation(db, target.kind, rootKind, relativePath);
      if (collision && collision.id !== target.id) {
        throw new CatalogError(
          "catalog.duplicate",
          `${collision.kind} ${collision.id} already owns ${rootKind}/${relativePath}; relocation refused.`,
        );
      }
    }
    const documentKind =
      record.documentKind !== undefined
        ? normalizeDocumentKind(target.kind, record.documentKind)
        : row.document_kind;

    const at = nowRfc3339();
    const revision = row.revision + 1;
    db.prepare(
      "update catalog_entities set title = ?, description = ?, root_kind = ?, relative_path = ?, document_kind = ?, lifecycle = ?, source_hash = ?, revision = ?, updated_at = ? " +
        "where kind = ? and id = ?",
    ).run(
      record.title ?? row.title,
      record.description !== undefined ? record.description : row.description,
      rootKind,
      relativePath,
      documentKind,
      record.lifecycle ?? row.lifecycle,
      record.sourceHash !== undefined ? record.sourceHash : row.source_hash,
      revision,
      at,
      target.kind,
      target.id,
    );
    const after = bumpCatalogRevisions(db);
    return commitOperation(
      db,
      op,
      hash,
      { kind: target.kind, id: target.id, revision, storeRevision: after.storeRevision },
      before,
      after,
      { mutation: "updateCatalogEntity", action: "updated", key: { kind: target.kind, id: target.id } },
    );
  });
}

/**
 * Record a relation between two registered entities. Both endpoints must
 * exist and the pair must be in the allowed table (§2), so an unknown kind,
 * a dangling target or an ill-typed relation is refused rather than stored;
 * the schema's composite FKs and pair check back the same rules. Replaying
 * an existing link is idempotent; supplying a different `ordinal` updates it.
 * `operation.expectedRevision` is enforced against the `from` entity when
 * supplied.
 */
export async function linkCatalogEntities(
  context: StoreContext,
  link: CatalogLinkInput,
  operation: CatalogOperation,
): Promise<CatalogReceipt> {
  if (resolveCollaborationLocation(context).mode === "remote") {
    const op = requireOperation(operation);
    if (!link || typeof link !== "object") throw invalid("a catalog link is required");
    const from = requireKey("link.from", link.from);
    const to = requireKey("link.to", link.to);
    assertAllowedLink(from, link.relation, to);
    const ordinal = normalizeOrdinal(link.ordinal);
    return queueCatalogWrite(
      context,
      { ...op, projectId: operation.projectId },
      from,
      {
        verb: "catalog-link",
        request: { projectId: operation.projectId, from, to, relation: link.relation, ordinal, expectedRevision: operation.expectedRevision },
      },
      (current) => {
      const entities = observedEntities(current);
      for (const endpoint of [from, to]) {
        if (!entities.some((entity) => entity.kind === endpoint.kind && entity.id === endpoint.id)) {
          throw new CatalogError(
            "catalog.link-refused",
            `${endpoint.kind} ${endpoint.id} is not registered in the observed project; a dangling link is never published.`,
          );
        }
      }
      if (operation.expectedRevision !== undefined) {
        const row = entities.find((entity) => entity.kind === from.kind && entity.id === from.id);
        if (row !== undefined && row.revision !== operation.expectedRevision) {
          throw new CatalogError(
            "catalog.revision-conflict",
            `${from.kind} ${from.id} is at revision ${String(row.revision)}, not the expected ${operation.expectedRevision}; nothing was enqueued.`,
          );
        }
      }
      // note: Replaying an existing link is idempotent; a supplied ordinal replaces the stored one.
      const kept = observedLinks(current).filter(
        (row) =>
          !(
            row.fromKind === from.kind &&
            row.fromId === from.id &&
            row.relation === link.relation &&
            row.toKind === to.kind &&
            row.toId === to.id
          ),
      );
      return {
        ...current,
        catalogLinks: [
          ...kept,
          { fromKind: from.kind, fromId: from.id, relation: link.relation, toKind: to.kind, toId: to.id, ordinal },
        ],
      };
      },
    );
  }
  return withCatalogWrite(context, (db) => linkCatalogEntitiesOn(db, context, link, operation));
}

/**
 * §2 the same relation rule on a handle the caller ALREADY owns — the link half
 * of the registration's composed publish (see `registerCatalogEntityOn`): the
 * pair table, the endpoint existence checks, the optional `from`-revision
 * expectation and the deterministic replay all run against the caller's own
 * transaction instead of a second connection, and the relation joins the
 * transaction's single shared store-revision advance when the caller passes its
 * `ComposedStoreRevision`.
 */
export function linkCatalogEntitiesOn(
  db: StoreDb,
  context: StoreContext,
  link: CatalogLinkInput,
  operation: CatalogOperation,
  composed?: ComposedStoreRevision,
): CatalogReceipt {
  assertCatalogActive(db);
  const op = requireOperation(operation);
  if (!link || typeof link !== "object") throw invalid("a catalog link is required");
  const from = requireKey("link.from", link.from);
  const to = requireKey("link.to", link.to);
  assertAllowedLink(from, link.relation, to);
  const ordinal = normalizeOrdinal(link.ordinal);
  const hash = requestHash("linkCatalogEntities", {
    from,
    relation: link.relation,
    to,
    ordinal,
    operationId: op.operationId,
    actor: op.actor,
    expectedRevision: operation.expectedRevision,
  });

  const before = readCatalogStoreVersionsOn(db);
  const existingOp = lookupOperation(db, op.operationId);
  if (existingOp) return replayOperation(existingOp, hash);

  const fromRow = readEntity(db, from.kind, from.id);
  if (!fromRow) throw new CatalogError("catalog.link-refused", `${from.kind} ${from.id} is not registered`);
  if (!readEntity(db, to.kind, to.id)) {
    throw new CatalogError(
      "catalog.link-refused",
      `${to.kind} ${to.id} is not registered; a catalog relation may not dangle (\u00a72).`,
    );
  }
  if (operation.expectedRevision !== undefined) {
    const expected = requireExpectedRevision(operation.expectedRevision);
    if (fromRow.revision !== expected) {
      throw new CatalogError(
        "catalog.revision-conflict",
        `${from.kind} ${from.id} is at revision ${fromRow.revision}, not the expected ${expected}; nothing was changed.`,
      );
    }
  }

  const existingLink = db
    .prepare(`select ${LINK_COLUMNS} from catalog_links where from_kind = ? and from_id = ? and relation = ? and to_kind = ? and to_id = ?`)
    .get(from.kind, from.id, link.relation, to.kind, to.id) as LinkRow | undefined;
  const delta: CatalogDelta = {
    mutation: "linkCatalogEntities",
    action: "linked",
    key: { from, relation: link.relation, to },
  };

  if (existingLink && existingLink.ordinal === ordinal) {
    return commitOperation(db, op, hash, receiptOf(fromRow, before.storeRevision), before, before, {
      ...delta,
      action: "noop-identical",
    });
  }

  const at = nowRfc3339();
  if (existingLink) {
    db.prepare(
      "update catalog_links set ordinal = ? where from_kind = ? and from_id = ? and relation = ? and to_kind = ? and to_id = ?",
    ).run(ordinal, from.kind, from.id, link.relation, to.kind, to.id);
  } else {
    db.prepare(
      "insert into catalog_links(from_kind, from_id, relation, to_kind, to_id, ordinal) values (?, ?, ?, ?, ?, ?)",
    ).run(from.kind, from.id, link.relation, to.kind, to.id, ordinal);
  }
  const revision = fromRow.revision + 1;
  db.prepare("update catalog_entities set revision = ?, updated_at = ? where kind = ? and id = ?").run(
    revision,
    at,
    from.kind,
    from.id,
  );
  const after = bumpCatalogRevisions(db, composed);
  return commitOperation(
    db,
    op,
    hash,
    { kind: from.kind, id: from.id, revision, storeRevision: after.storeRevision },
    before,
    after,
    existingLink ? { ...delta, action: "ordinal-updated" } : delta,
  );
}

// ---------------------------------------------------------------------------
// Queries (contract §2, §6 ordering)
// ---------------------------------------------------------------------------

function bindCatalogFilter(filter: CatalogFilter | undefined): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter?.kind !== undefined) {
    clauses.push("catalog_entities.kind = ?");
    params.push(requireEntityKind(filter.kind, "catalog.invalid-filter"));
  }
  if (filter?.documentKind !== undefined) {
    clauses.push("catalog_entities.document_kind = ?");
    params.push(requireDocumentKind(filter.documentKind, "catalog.invalid-filter"));
  }
  if (filter?.lifecycle !== undefined) {
    clauses.push("catalog_entities.lifecycle = ?");
    params.push(requireLifecycle(filter.lifecycle, "catalog.invalid-filter"));
  }
  // Membership is the catalog's own `belongs-to` relation — never a
  // directory scan, and never a filename convention.
  if (filter?.projectId !== undefined) {
    clauses.push(
      "exists (select 1 from catalog_links l where l.relation = 'belongs-to' and l.to_kind = 'project' and l.to_id = ? " +
        "and l.from_kind = catalog_entities.kind and l.from_id = catalog_entities.id)",
    );
    params.push(requireNonblank("projectId", filter.projectId, "catalog.invalid-filter"));
  }
  if (filter?.iterationId !== undefined) {
    clauses.push(
      "exists (select 1 from catalog_links l where l.relation = 'belongs-to' and l.to_kind = 'iteration' and l.to_id = ? " +
        "and l.from_kind = catalog_entities.kind and l.from_id = catalog_entities.id)",
    );
    params.push(requireNonblank("iterationId", filter.iterationId, "catalog.invalid-filter"));
  }
  return { where: clauses.length ? `where ${clauses.join(" and ")}` : "", params };
}

/** note: The canonical scope key of one catalog page: the filters with the applied bounds. */
function catalogPageScope(filter: CatalogFilter, limit: number, offset: number): CollaborationScope {
  return {
    kind: "query",
    key: `catalog:${JSON.stringify({
      kind: filter.kind ?? null,
      documentKind: filter.documentKind ?? null,
      lifecycle: filter.lifecycle ?? null,
      projectId: filter.projectId ?? null,
      iterationId: filter.iterationId ?? null,
      limit,
      offset,
    })}`,
  };
}

/**
 * invariant: A remote snapshot carries portable catalog IDENTITY only - no checkout-relative
 * path, no resolved absolute path and no live file probe. The catalog's row
 * contract requires those location facts, so this read refuses by name instead
 * of inventing them; the dashboard's catalog identity (and its remote-aware
 * project/iteration/milestone views) is the supported remote route.
 */
function assertLocalCatalogRead(context: StoreContext): void {
  if (resolveCollaborationLocation(context).mode !== "remote") return;
  throw new StoreError(
    "remote.unavailable",
    "The catalog's registered rows carry a checkout-relative location that a remote observation does not have, so this " +
      "read cannot answer them. Read the portable catalog identity through the dashboard views (projects, iterations, " +
      "milestones) or the remote issue reads; nothing was read.",
  );
}

/**
 * List catalog rows with their incident links. `lifecycle` is unfiltered
 * unless asked (retention is explicit: archived/superseded rows stay
 * registered), ordering is the contract §6 deterministic kind/title/id.
 */
export async function listCatalog(
  context: StoreContext,
  filter: CatalogFilter = {},
): Promise<CatalogPage & { collaboration: CompleteCollaborationObservation }> {
  assertLocalCatalogRead(context);
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) {
    throw new CatalogError("catalog.invalid-filter", "limit must be 1..200 and offset must be nonnegative");
  }
  const { where, params } = bindCatalogFilter(filter);
  const roots = catalogRoots(context);
  const handle = await openCollaborationStore(context, "read");
  try {
    const db = handle.db;
    db.exec("begin");
    const collaboration = readCollaborationObservation(handle, catalogPageScope(filter, limit, offset));
    const storeRevision = readCatalogStoreVersionsOn(db).storeRevision;
    const total = db.prepare(`select count(*) as n from catalog_entities ${where}`).get(...params) as { n: number };
    const rows = db
      .prepare(
        `select ${ENTITY_COLUMNS} from catalog_entities ${where} ` +
          `order by catalog_entities.kind asc, catalog_entities.title asc, catalog_entities.id asc limit ? offset ?`,
      )
      .all(...params, limit, offset) as EntityRow[];
    // note: The page's incident links belong to the same snapshot as its rows, total
    // and revision: read them inside this transaction, before it commits.
    const links = incidentLinks(
      db,
      rows.map((row) => ({ kind: row.kind, id: row.id })),
    );
    db.exec("commit");
    return {
      items: rows.map((row) => toCatalogEntity(row, roots)),
      links,
      total: total.n,
      storeRevision,
      collaboration,
    };
  } catch (error) {
    try {
      handle.db.exec("rollback");
    } catch {
      // note: connection-level failure during rollback -- nothing was committed
    }
    throw error;
  } finally {
    handle.close();
  }
}

/** One catalog row with every link incident to it. */
export async function getCatalog(
  context: StoreContext,
  key: CatalogKey,
): Promise<CatalogDetail & { collaboration: CompleteCollaborationObservation }> {
  assertLocalCatalogRead(context);
  const target = requireKey("key", key);
  const roots = catalogRoots(context);
  const handle = await openCollaborationStore(context, "read");
  try {
    const db = handle.db;
    db.exec("begin");
    const collaboration = readCollaborationObservation(handle, {
      kind: "query",
      key: `catalog:${target.kind}:${target.id}`,
    });
    const row = readEntity(db, target.kind, target.id);
    if (!row) throw new CatalogError("catalog.not-found", `${target.kind} ${target.id} is not registered`);
    const detail = {
      entity: toCatalogEntity(row, roots),
      links: incidentLinks(db, [target]),
      storeRevision: readCatalogStoreVersionsOn(db).storeRevision,
      collaboration,
    };
    db.exec("commit");
    return detail;
  } catch (error) {
    try {
      handle.db.exec("rollback");
    } catch {
      // note: connection-level failure during rollback -- nothing was committed
    }
    throw error;
  } finally {
    handle.close();
  }
}
