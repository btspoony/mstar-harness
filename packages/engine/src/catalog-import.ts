/**
 * catalog-import.ts -- explicit discovery/proposal, reviewed-mapping import and
 * versioned export transport over the catalog authority
 * (state-projection-contract §2/§4).
 *
 * Boundaries this module owns, and does not cross:
 * - Discovery is a PROPOSAL over the configured roots. It writes nothing, never
 *   reads through a symlink, and never treats a filename as project/iteration
 *   membership, archive state, execution status or provenance. A legacy index
 *   row whose reference leaves its catalog root (a cross-root/history link) is
 *   retained as an explicit unresolved-reference unknown, never a fatal plan
 *   error and never a fabricated row (§4).
 * - Import applies a REVIEWED plan through the shared catalog domain verbs
 *   (P1 `registerCatalogEntity` / `linkCatalogEntities`), so every write keeps
 *   the store's epoch/role/idempotency/transaction rules. The reviewed source
 *   hashes are re-verified before the first write; a conflict or a source drift
 *   refuses the whole import instead of silently preferring one source. A
 *   failure AFTER writes started is never a silent prefix: the applied prefix
 *   is journalled progress and the failure is rethrown as an explicit
 *   `catalog.import-partial` error that reports what applied and how to resume
 *   (RV-3).
 * - Import never creates a workflow session, retires an index or repairs issue
 *   authority; live index retirement belongs to the cutover plan's G6.
 *
 * Identity sources (what a proposal's id may come from, §2):
 * - iteration / project package directory names (a directory holding the
 *   canonical `delivery-compass.md` / `roadmap.md` marker) and the canonical
 *   `{PLANS_DIR}/<plan-id>.md` plan-file convention: the harness's own layout
 *   identity, read from the filesystem and not from a maintained index.
 * - an explicit id cell in a legacy index row (backticked first cell).
 * - otherwise the proposal carries a discovery-assigned `doc-<UUID>` and an
 *   explicit `identity` unknown; reimport attaches to the existing row at the
 *   same canonical location, so the retained DB id wins (§2).
 */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import {
  catalogRootDir,
  linkCatalogEntities,
  listCatalog,
  registerCatalogEntity,
  type CatalogDocumentKind,
  type CatalogEntity,
  type CatalogEntityInput,
  type CatalogEntityKind,
  type CatalogKey,
  type CatalogLifecycle,
  type CatalogLink,
  type CatalogOperation,
  type CatalogReceipt,
  type CatalogRelation,
  type CatalogRootKind,
} from "./catalog.js";
import { parseCompassFrontmatterText } from "./iteration.js";
import type { StoreContext } from "./store-db.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Transport version of a `CatalogImportPlan` (§2/§4 dry-run inventory). */
export const CATALOG_IMPORT_PLAN_VERSION = 1;
/** Transport version of a `CatalogExport` payload (§4 catalog export). */
export const CATALOG_EXPORT_VERSION = 1;

/** The page size used when a full catalog read is needed (>listCatalog max). */
const CATALOG_PAGE_LIMIT = 200;

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
  roadmap: true,
  review: true,
  other: true,
};

const LIFECYCLES: Record<CatalogLifecycle, true> = { active: true, archived: true, superseded: true };

const RELATIONS: Record<CatalogRelation, true> = {
  "belongs-to": true,
  documents: true,
  "spec-ref": true,
  "knowledge-ref": true,
  "derived-from": true,
  supersedes: true,
};

/** Files that are never a tracked document body (§4: ordinary README/INSTALL). */
const ORDINARY_FILES: Record<string, true> = { "readme.md": true, "install.md": true, "index.md": true };

const COMPASS_FILE = "delivery-compass.md";
const ROADMAP_FILE = "roadmap.md";

/** Stable refusal codes for the import transport. */
export type CatalogImportErrorCode =
  | "catalog.import-invalid-plan"
  | "catalog.import-conflict"
  | "catalog.import-source-drift"
  | "catalog.import-unknown-input"
  | "catalog.import-partial";

/**
 * The explicit, resumable partial state of a failed import (RV-3): every
 * applied proposal is journalled in `catalog_operations` under its
 * deterministic per-proposal operation id (`<operationId>:entity:<i>` /
 * `<operationId>:link:<i>`) in the same transaction as its rows, so the
 * progress below IS the persisted journal state. Re-running the SAME reviewed
 * plan with the SAME `operationId` replays the applied proposals idempotently
 * and applies only the rest — a retried import converges to the full plan
 * exactly once. A partial import is never silent: the error names what
 * applied, what failed, and how to resume.
 */
export type CatalogImportPartialState = {
  operationId: string;
  appliedEntities: CatalogReceipt[];
  appliedLinks: CatalogLink[];
  failed: { stage: "entity" | "link"; index: number; message: string };
};

export class CatalogImportError extends Error {
  readonly code: CatalogImportErrorCode;
  /** The explicit resumable partial state (`catalog.import-partial` only). */
  readonly partial: CatalogImportPartialState | null;

  constructor(code: CatalogImportErrorCode, message: string, partial: CatalogImportPartialState | null = null) {
    super(`[${code}] ${message}`);
    this.name = "CatalogImportError";
    this.code = code;
    this.partial = partial;
  }
}

// ---------------------------------------------------------------------------
// Plan / receipt / export shapes (contract §2 names, §4 semantics)
// ---------------------------------------------------------------------------

/** One reviewed source hash: the bytes the plan was reviewed against. */
export type CatalogImportSourceDigest = {
  sourceKey: string;
  rootKind: CatalogRootKind;
  relativePath: string;
  sha256: string;
};

/** Which source field a proposal value was read from. */
export type CatalogImportEvidence = {
  sourceKey: string;
  field: string;
  value: string;
};

export type CatalogImportEntityProposal = {
  kind: CatalogEntityKind;
  id: string;
  title: string;
  description: string | null;
  rootKind: CatalogRootKind;
  relativePath: string;
  documentKind: CatalogDocumentKind | null;
  lifecycle: CatalogLifecycle;
  /** Content hash of the tracked body when the proposal came from one. */
  sourceHash: string | null;
  /** True when no source carried this id and discovery assigned `doc-<UUID>`. */
  idAssigned: boolean;
  evidence: CatalogImportEvidence[];
};

export type CatalogImportLinkProposal = {
  from: CatalogKey;
  relation: CatalogRelation;
  to: CatalogKey;
  ordinal: number | null;
  evidence: CatalogImportEvidence[];
};

/**
 * A disagreement between sources. A non-empty conflict list BLOCKS the import
 * (§4): no source is silently preferred.
 */
export type CatalogImportConflict = {
  field: "id" | "path" | "lifecycle" | "relationship";
  /** The disputed key: `<kind>:<id>` or `<rootKind>:<relativePath>`. */
  key: string;
  values: { value: string; sourceKey: string }[];
  message: string;
};

export type CatalogImportUnknownCode =
  | "identity"
  | "membership"
  | "document-kind"
  | "lifecycle"
  | "provenance"
  | "source-missing"
  | "source-refused"
  | "reference-missing"
  | "reference-unresolvable"
  | "duplicate-row";

/** Metadata the import cannot recover from the reviewed sources (§4). */
export type CatalogImportUnknown = {
  code: CatalogImportUnknownCode;
  key: string;
  detail: string;
  sourceKey: string;
};

/**
 * A legacy index section proposed for retirement at activation (§4): only the
 * recognized table is targeted; every other line of the file is narrative that
 * stays.
 */
export type CatalogImportRetirementSection = {
  rootKind: CatalogRootKind;
  relativePath: string;
  header: string;
  startLine: number;
  endLine: number;
  sha256: string;
  /** Lines outside the retired section, preserved verbatim. */
  preservedLines: number;
  sourceKey: string;
};

export type CatalogImportPlan = {
  version: number;
  sourceDigests: CatalogImportSourceDigest[];
  entities: CatalogImportEntityProposal[];
  links: CatalogImportLinkProposal[];
  conflicts: CatalogImportConflict[];
  unknowns: CatalogImportUnknown[];
  retirementSections: CatalogImportRetirementSection[];
};

/** Reviewed mapping for one source (§4 "catalog import requires reviewed mapping"). */
export type CatalogImportEntityMapping = {
  kind: CatalogEntityKind;
  id: string;
  title?: string;
  description?: string | null;
  documentKind?: CatalogDocumentKind | null;
  lifecycle?: CatalogLifecycle;
  /** Reviewed location override; defaults to the input's own location. */
  rootKind?: CatalogRootKind;
  relativePath?: string;
  sourceHash?: string | null;
};

/** Provenance carried by an exported row; never re-applied as local authority. */
export type CatalogImportProvenance = {
  revision: number;
  registeredAt: string;
  updatedAt: string;
  sourceHash: string | null;
};

/** One reviewed relation an input states (never inferred from a file name). */
export type CatalogImportReviewedLink = {
  relation: CatalogRelation;
  to: CatalogKey;
  ordinal?: number | null;
};

/** One reviewed import input. */
export type CatalogImportInput = {
  rootKind: CatalogRootKind;
  relativePath: string;
  mapping: CatalogImportEntityMapping;
  links?: CatalogImportReviewedLink[];
  provenance?: CatalogImportProvenance;
};

export type CatalogImportReceipt = {
  operationId: string;
  planVersion: number;
  /** One receipt per proposal, in plan order (ids are the effective ones). */
  entities: CatalogReceipt[];
  /** The relations actually recorded, with effective ids. */
  links: CatalogLink[];
  /** Carried from the plan: what the import did not recover. */
  unknowns: CatalogImportUnknown[];
  storeRevision: number;
};

export type CatalogExport = {
  version: number;
  exportedAt: string;
  storeRevision: number;
  entities: CatalogEntity[];
  links: CatalogLink[];
};

/** Read-only result of re-checking a reviewed plan against store and sources. */
export type CatalogImportDrift = {
  sourceKey: string;
  rootKind: CatalogRootKind;
  relativePath: string;
  expectedSha256: string;
  actualSha256: string | null;
  state: "changed" | "missing" | "refused";
};

export type CatalogImportVerification = {
  ok: boolean;
  conflicts: CatalogImportConflict[];
  drift: CatalogImportDrift[];
};

// ---------------------------------------------------------------------------
// Path / source reading
// ---------------------------------------------------------------------------

function invalidPlan(message: string): CatalogImportError {
  return new CatalogImportError("catalog.import-invalid-plan", message);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Canonical stored form of a root-relative path (§2), never absolute. */
function normalizeRelativePath(raw: unknown, label: string): string {
  const resolved = resolveRelativePath(raw, label);
  if (!resolved.ok) throw invalidPlan(resolved.reason);
  return resolved.relativePath;
}

type PathResolution = { ok: true; relativePath: string } | { ok: false; reason: string };

/**
 * Non-throwing core of `normalizeRelativePath`. A reviewed import input still
 * fails hard on a bad path; a legacy index row may legitimately carry a
 * cross-root/history reference (`../../plans/<id>.md`) that the caller retains
 * as a disclosed unknown instead of losing the whole proposal (§4).
 */
function resolveRelativePath(raw: unknown, label: string): PathResolution {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, reason: `${label} must be a nonblank relative path` };
  const value = raw.trim().replace(/\\/g, "/");
  if (value.includes("\0")) return { ok: false, reason: `${label} contains a NUL byte` };
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return { ok: false, reason: `${label} must be relative to its catalog root` };
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return { ok: false, reason: `${label} must not traverse outside its catalog root` };
    parts.push(part);
  }
  if (parts.length === 0) return { ok: false, reason: `${label} must name a path inside its catalog root` };
  return { ok: true, relativePath: parts.join("/") };
}

/** Absolute destination of a root-relative catalog location. */
function sourcePath(context: StoreContext, rootKind: CatalogRootKind, relativePath: string): string {
  const root = resolve(catalogRootDir(context, rootKind));
  const absolute = resolve(join(root, relativePath));
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw invalidPlan(`"${relativePath}" escapes the ${rootKind} catalog root`);
  }
  return absolute;
}

type SourceRead =
  | { state: "ok"; text: string; sha256: string }
  | { state: "missing" | "refused"; detail: string };

/**
 * Read one reviewed source. Symlinks are never followed (§4 "enumerates
 * configured document roots (no symlink following)"): a symlinked location is
 * refused, not resolved.
 */
function readSourceFile(context: StoreContext, rootKind: CatalogRootKind, relativePath: string): SourceRead {
  const absolute = sourcePath(context, rootKind, relativePath);
  let info;
  try {
    info = lstatSync(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing", detail: `${rootKind}:${relativePath} is not present` };
    return { state: "refused", detail: `${rootKind}:${relativePath} is not readable (${code ?? "unknown error"})` };
  }
  if (info.isSymbolicLink()) return { state: "refused", detail: `${rootKind}:${relativePath} is a symlink (not followed)` };
  if (!info.isFile()) return { state: "refused", detail: `${rootKind}:${relativePath} is not a regular file` };
  try {
    const text = readFileSync(absolute, "utf8");
    return { state: "ok", text, sha256: sha256(text) };
  } catch (error) {
    return { state: "refused", detail: `${rootKind}:${relativePath} could not be read (${(error as Error).message})` };
  }
}

function sourceKeyOf(rootKind: CatalogRootKind, relativePath: string): string {
  return `${rootKind}:${relativePath}`;
}

// ---------------------------------------------------------------------------
// Body metadata extraction
// ---------------------------------------------------------------------------

function tryFrontmatter(text: string, label: string): Record<string, unknown> | null {
  try {
    return parseCompassFrontmatterText(text, label);
  } catch {
    // A body whose frontmatter is outside the flat subset carries no explicit
    // metadata this reader can trust; callers disclose what they could not read.
    return null;
  }
}

function scalar(doc: Record<string, unknown> | null, key: string): string | null {
  const value = doc?.[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** First level-1 heading outside a fenced code block. */
function firstHeading(text: string): string | null {
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) return match[1]!;
  }
  return null;
}

/** Title candidate: explicit frontmatter title, else the body's own heading. */
function titleFromBody(text: string, label: string): { title: string | null; field: string } {
  const doc = tryFrontmatter(text, label);
  const declared = scalar(doc, "title");
  if (declared !== null) return { title: declared, field: "frontmatter.title" };
  const heading = firstHeading(text);
  if (heading !== null) return { title: heading, field: "heading" };
  return { title: null, field: "none" };
}

/** Last-resort title for a proposal that must carry a nonblank title. */
function fallbackTitle(relativePath: string): string {
  const name = basename(relativePath);
  return name.replace(/\.md$/i, "") || relativePath;
}

// ---------------------------------------------------------------------------
// Legacy index tables
// ---------------------------------------------------------------------------

type RawTable = {
  header: string[];
  headerLine: number;
  firstLine: number;
  lastLine: number;
  rows: { cells: string[]; line: number }[];
};

function cellsOf(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isDelimiterRow(line: string): boolean {
  if (!line.trim().startsWith("|")) return false;
  const cells = cellsOf(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, "")));
}

/** Every markdown table in the file, in document order. */
function readTables(text: string): RawTable[] {
  const lines = text.split(/\r?\n/);
  const tables: RawTable[] = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = lines[i]!;
    if (!line.trim().startsWith("|") || !isDelimiterRow(lines[i + 1] ?? "")) continue;
    const rows: { cells: string[]; line: number }[] = [];
    let last = i + 1;
    for (let j = i + 2; j < lines.length; j += 1) {
      const row = lines[j]!;
      if (!row.trim().startsWith("|")) break;
      rows.push({ cells: cellsOf(row), line: j + 1 });
      last = j;
    }
    tables.push({ header: cellsOf(line), headerLine: i + 1, firstLine: i + 1, lastLine: last + 1, rows });
    i = last;
  }
  return tables;
}

/** Plain text of a cell: drop markdown links/backticks, keep the label. */
function cellText(cell: string): string {
  return cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .trim();
}

function cellLinkTarget(cell: string): string | null {
  const match = /\[[^\]]*\]\(([^)]+)\)/.exec(cell);
  return match === null ? null : match[1]!.trim();
}

function cellBacktickToken(cell: string): string | null {
  const match = /^`([^`]+)`$/.exec(cell.trim());
  return match === null ? null : match[1]!.trim();
}

/** The path a first-cell reference points at: link target, else a backticked token. */
function cellReference(cell: string): string | null {
  return cellLinkTarget(cell) ?? cellBacktickToken(cell);
}

type IndexFamily = "iteration-rows" | "document-rows" | "package-documents";

function detectIndexFamily(header: string[]): IndexFamily | null {
  const keys = header.map((cell) => cellText(cell).toLowerCase());
  const has = (token: string) => keys.includes(token);
  if (has("iteration")) return "iteration-rows";
  if (has("document") && has("kind")) return "package-documents";
  if (has("document")) return "document-rows";
  return null;
}

// ---------------------------------------------------------------------------
// Plan accumulation
// ---------------------------------------------------------------------------

type Accumulator = {
  entities: CatalogImportEntityProposal[];
  links: CatalogImportLinkProposal[];
  conflicts: CatalogImportConflict[];
  unknowns: CatalogImportUnknown[];
  digests: Map<string, CatalogImportSourceDigest>;
  sections: CatalogImportRetirementSection[];
  /** Identical rows inside ONE index file, so a repeated row is disclosed. */
  seenRows: Map<string, string>;
};

function emptyAccumulator(): Accumulator {
  return { entities: [], links: [], conflicts: [], unknowns: [], digests: new Map(), sections: [], seenRows: new Map() };
}

function recordDigest(acc: Accumulator, rootKind: CatalogRootKind, relativePath: string, digest: string): string {
  const sourceKey = sourceKeyOf(rootKind, relativePath);
  if (!acc.digests.has(sourceKey)) acc.digests.set(sourceKey, { sourceKey, rootKind, relativePath, sha256: digest });
  return sourceKey;
}

/** Read a source for evidence: digests on success, discloses either refusal. */
function readForEvidence(acc: Accumulator, context: StoreContext, rootKind: CatalogRootKind, relativePath: string): { text: string; sourceKey: string } | null {
  const read = readSourceFile(context, rootKind, relativePath);
  const sourceKey = sourceKeyOf(rootKind, relativePath);
  if (read.state === "ok") {
    recordDigest(acc, rootKind, relativePath, read.sha256);
    return { text: read.text, sourceKey };
  }
  acc.unknowns.push({
    code: read.state === "missing" ? "source-missing" : "source-refused",
    key: sourceKey,
    detail: read.detail,
    sourceKey,
  });
  return null;
}

function catalogLifecycleOf(raw: string | null): { lifecycle: CatalogLifecycle | null; declared: string | null } {
  if (raw === null) return { lifecycle: null, declared: null };
  const value = raw.toLowerCase().replace(/`/g, "").trim();
  return Object.hasOwn(LIFECYCLES, value) ? { lifecycle: value as CatalogLifecycle, declared: raw } : { lifecycle: null, declared: raw };
}

function sortedPlan(acc: Accumulator): CatalogImportPlan {
  return {
    version: CATALOG_IMPORT_PLAN_VERSION,
    sourceDigests: [...acc.digests.values()].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)),
    entities: acc.entities
      .slice()
      .sort(
        (a, b) =>
          a.kind.localeCompare(b.kind) ||
          a.id.localeCompare(b.id) ||
          a.rootKind.localeCompare(b.rootKind) ||
          a.relativePath.localeCompare(b.relativePath),
      ),
    links: acc.links.slice().sort((a, b) => linkSortKey(a).localeCompare(linkSortKey(b))),
    conflicts: acc.conflicts
      .slice()
      .sort((a, b) => a.field.localeCompare(b.field) || a.key.localeCompare(b.key)),
    unknowns: acc.unknowns.slice().sort((a, b) => a.code.localeCompare(b.code) || a.key.localeCompare(b.key)),
    retirementSections: acc.sections
      .slice()
      .sort((a, b) => a.rootKind.localeCompare(b.rootKind) || a.relativePath.localeCompare(b.relativePath) || a.startLine - b.startLine),
  };
}

/** Deterministic relation order for a plan (§6 catalog list ordering rules). */
function linkSortKey(link: CatalogImportLinkProposal): string {
  return [
    link.from.kind,
    link.from.id,
    link.relation,
    link.to.kind,
    link.to.id,
    link.ordinal === null ? "" : String(link.ordinal).padStart(6, "0"),
  ].join("\u0000");
}

/**
 * Merge proposals for one canonical location: an assigned identity never
 * disagrees with another assigned identity, but two different explicit ids for
 * one location are a conflict a reviewer must resolve.
 */
function addEntity(acc: Accumulator, proposal: CatalogImportEntityProposal): void {
  acc.entities.push(proposal);
}

function entityKey(kind: CatalogEntityKind, id: string): string {
  return `${kind}:${id}`;
}

function locationKey(rootKind: CatalogRootKind, relativePath: string): string {
  return `${rootKind}:${relativePath}`;
}

/**
 * Record one blocking disagreement. Values keep per-field source evidence
 * (§4) and are distinct/sorted so a plan reads deterministically.
 */
function pushConflict(
  acc: Accumulator,
  field: CatalogImportConflict["field"],
  key: string,
  values: { value: string; sourceKey: string }[],
  message: string,
): void {
  const seen = new Set<string>();
  const distinct = values
    .filter((value) => {
      const id = `${value.value}\u0000${value.sourceKey}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => a.value.localeCompare(b.value) || a.sourceKey.localeCompare(b.sourceKey));
  acc.conflicts.push({ field, key, values: distinct, message });
}

/**
 * Resolve the accumulated proposals into a reviewable set: merge corroborating
 * proposals, block on disagreement (§4 "Conflicting ID/path/relationship/
 * lifecycle between sources blocks import with per-field source evidence").
 */
function resolveProposals(acc: Accumulator): void {
  const byLocation = new Map<string, CatalogImportEntityProposal[]>();
  for (const proposal of acc.entities) {
    const key = locationKey(proposal.rootKind, proposal.relativePath);
    const bucket = byLocation.get(key);
    if (bucket === undefined) byLocation.set(key, [proposal]);
    else bucket.push(proposal);
  }

  const merged: CatalogImportEntityProposal[] = [];
  for (const [key, bucket] of byLocation) {
    const ordered = bucket
      .slice()
      .sort((a, b) => Number(a.idAssigned) - Number(b.idAssigned) || a.id.localeCompare(b.id) || a.kind.localeCompare(b.kind));
    const explicit = new Map<string, string>();
    for (const proposal of ordered) {
      if (!proposal.idAssigned) explicit.set(entityKey(proposal.kind, proposal.id), proposal.id);
    }
    const head = ordered[0]!;
    if (explicit.size > 1) {
      pushConflict(
        acc,
        "id",
        key,
        ordered.map((proposal) => ({ value: entityKey(proposal.kind, proposal.id), sourceKey: proposal.evidence[0]?.sourceKey ?? key })),
        `${key} is claimed by ${explicit.size} different explicit ids (${[...explicit.keys()].join(", ")})`,
      );
      continue;
    }
    const mergedProposal: CatalogImportEntityProposal = {
      ...head,
      // Corroborating sources fill what the head could not read (a directory
      // location carries no description of its own, an index row may).
      description: head.description ?? ordered.find((proposal) => proposal.description !== null)?.description ?? null,
      evidence: dedupeEvidence([...ordered].flatMap((proposal) => proposal.evidence)),
    };
    const assigned = ordered.filter((proposal) => proposal.idAssigned).length;
    if (assigned > 0) {
      acc.unknowns.push({
        code: "identity",
        key: entityKey(mergedProposal.kind, mergedProposal.id),
        detail:
          explicit.size === 1
            ? `${assigned} source(s) list ${key} without an id; the explicit id from another source is retained`
            : `${assigned} source(s) list ${key} without an explicit id; one discovery-assigned id is retained (\u00a72 doc-<UUID>) ` +
              "and a reimport attaches to the row already registered at this location",
        sourceKey: mergedProposal.evidence[0]?.sourceKey ?? key,
      });
    }
    merged.push(mergedProposal);
  }

  // Same identity at two locations: the reviewer must decide where it lives.
  const byIdentity = new Map<string, CatalogImportEntityProposal[]>();
  for (const proposal of merged) {
    const key = entityKey(proposal.kind, proposal.id);
    const bucket = byIdentity.get(key);
    if (bucket === undefined) byIdentity.set(key, [proposal]);
    else bucket.push(proposal);
  }
  for (const [key, bucket] of byIdentity) {
    const locations = new Set(bucket.map((proposal) => locationKey(proposal.rootKind, proposal.relativePath)));
    if (locations.size > 1) {
      pushConflict(
        acc,
        "path",
        key,
        bucket.map((proposal) => ({
          value: locationKey(proposal.rootKind, proposal.relativePath),
          sourceKey: proposal.evidence[0]?.sourceKey ?? key,
        })),
        `${key} is claimed at ${locations.size} different locations (${[...locations].join(", ")})`,
      );
    }
    const lifecycles = new Set(bucket.map((proposal) => proposal.lifecycle));
    if (lifecycles.size > 1) {
      pushConflict(
        acc,
        "lifecycle",
        key,
        bucket.map((proposal) => ({ value: proposal.lifecycle, sourceKey: proposal.evidence[0]?.sourceKey ?? key })),
        `${key} carries ${lifecycles.size} different catalog lifecycles (${[...lifecycles].join(", ")})`,
      );
    }
  }
  acc.entities = merged;

  // Relation conflicts: one ordered slot cannot point at two targets.
  const slots = new Map<string, Map<string, Set<string>>>();
  for (const link of acc.links) {
    const slot = [link.from.kind, link.from.id, link.relation, link.ordinal === null ? "" : String(link.ordinal)].join("\u0000");
    const targets = slots.get(slot) ?? new Map<string, Set<string>>();
    const target = entityKey(link.to.kind, link.to.id);
    const sources = targets.get(target) ?? new Set<string>();
    for (const entry of link.evidence) sources.add(entry.sourceKey);
    targets.set(target, sources);
    slots.set(slot, targets);
  }
  for (const [slot, targets] of slots) {
    if (targets.size < 2) continue;
    const values: { value: string; sourceKey: string }[] = [];
    for (const [target, sources] of targets) {
      for (const sourceKey of sources) values.push({ value: target, sourceKey });
    }
    pushConflict(
      acc,
      "relationship",
      slot.split("\u0000").filter((part) => part !== "").join(" "),
      values,
      `the relation slot ${JSON.stringify(slot.split("\u0000").join(" "))} is claimed by ${targets.size} different targets`,
    );
  }
}

function dedupeEvidence(evidence: CatalogImportEvidence[]): CatalogImportEvidence[] {
  const seen = new Set<string>();
  const out: CatalogImportEvidence[] = [];
  for (const entry of evidence) {
    const key = `${entry.sourceKey}\u0000${entry.field}\u0000${entry.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey) || a.field.localeCompare(b.field) || a.value.localeCompare(b.value));
}

// ---------------------------------------------------------------------------
// Discovery (contract §4: an explicit proposal, never a live parallel authority)
// ---------------------------------------------------------------------------

/** Legacy index files read as proposal sources, in a deterministic order. */
type IndexSource = {
  rootKind: CatalogRootKind;
  relativePath: string;
  /** The document kind rows of this index describe. */
  documentKind: CatalogDocumentKind;
  /** Package owner (`{ITERATION_DIR}/<id>/README.md`), for `documents` links. */
  owner?: string;
};

/**
 * Legacy index files read as proposal sources, in a deterministic order: the
 * root indexes (`{ITERATION_DIR}`, `{KNOWLEDGE_DIR}`, `{SPECS_DIR}` when their
 * README carries a recognized table) and each iteration package's Documents
 * table.
 */
function indexSourcesFor(context: StoreContext, iterationIds: string[]): IndexSource[] {
  const sources: IndexSource[] = [
    { rootKind: "iterations", relativePath: "README.md", documentKind: "compass" },
    { rootKind: "knowledge", relativePath: "README.md", documentKind: "knowledge" },
  ];
  if (hasFile(catalogRootDir(context, "specs"), "README.md")) {
    sources.push({ rootKind: "specs", relativePath: "README.md", documentKind: "spec" });
  }
  for (const id of iterationIds) {
    sources.push({ rootKind: "iterations", relativePath: `${id}/README.md`, documentKind: "other", owner: id });
  }
  return sources;
}

function listDirectories(root: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !entry.isSymbolicLink() && entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function hasFile(root: string, name: string): boolean {
  try {
    const info = lstatSync(join(root, name));
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Every `*.md` body under `root`, symlinks never followed, posix-relative. */
function collectBodies(root: string, relativeDir = ""): string[] {
  const dir = relativeDir === "" ? root : join(root, relativeDir);
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const bodies: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const child = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      bodies.push(...collectBodies(root, child));
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    // Ordinary README/INSTALL/index content is not an index registry (§4).
    if (ORDINARY_FILES[entry.name.toLowerCase()] === true) continue;
    bodies.push(child);
  }
  return bodies;
}

/**
 * One tracked-body proposal. `evidencePath` names the file the metadata is
 * read from: the body itself for documents, and the package marker file
 * (`delivery-compass.md` / `roadmap.md`) for a directory-located package,
 * whose own location stays the directory.
 */
function bodyProposal(
  acc: Accumulator,
  context: StoreContext,
  rootKind: CatalogRootKind,
  relativePath: string,
  kind: CatalogEntityKind,
  documentKind: CatalogDocumentKind | null,
  id: { value: string; assigned: boolean; evidence: CatalogImportEvidence[] },
  evidencePath = relativePath,
): void {
  const read = readForEvidence(acc, context, rootKind, evidencePath);
  const sourceKey = sourceKeyOf(rootKind, evidencePath);
  let title: string | null = null;
  if (read !== null) {
    const found = titleFromBody(read.text, sourceKey);
    title = found.title;
    if (found.title !== null) {
      id.evidence.push({ sourceKey, field: found.field, value: found.title });
    }
  }
  const proposal: CatalogImportEntityProposal = {
    kind,
    id: id.value,
    title: title ?? fallbackTitle(relativePath),
    description: null,
    rootKind,
    relativePath,
    documentKind,
    lifecycle: "active",
    sourceHash: read === null ? null : sha256(read.text),
    idAssigned: id.assigned,
    evidence: id.evidence,
  };
  if (documentKind === null) {
    acc.unknowns.push({
      code: "document-kind",
      key: entityKey(kind, id.value),
      detail: `${sourceKeyOf(rootKind, relativePath)} declares no document kind; reviewed mapping is required`,
      sourceKey,
    });
  }
  // Body discovery never invents a relation: no link is read from a name or a
  // directory, so membership stays a reviewed decision.
  acc.unknowns.push({
    code: "membership",
    key: entityKey(kind, id.value),
    detail: "the tracked source declares no project/iteration membership; relations are never inferred from its name or location",
    sourceKey,
  });
  addEntity(acc, proposal);
}

/** 1-based line numbering for a retirement section, trailing newline ignored. */
function lineCountOf(text: string): number {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines.length;
}

/** One index file: recognized tables become proposals, everything else stays. */
function parseIndexFile(acc: Accumulator, context: StoreContext, source: IndexSource): void {
  const read = readForEvidence(acc, context, source.rootKind, source.relativePath);
  if (read === null) return;
  const tables = readTables(read.text);
  const lineCount = lineCountOf(read.text);
  for (const table of tables) {
    const family = detectIndexFamily(table.header);
    if (family === null) continue;
    const header = table.header.map((cell) => cellText(cell)).join(" | ");
    acc.sections.push({
      rootKind: source.rootKind,
      relativePath: source.relativePath,
      header,
      startLine: table.firstLine,
      endLine: table.lastLine,
      sha256: sha256(read.text),
      preservedLines: Math.max(0, lineCount - (table.lastLine - table.firstLine + 1)),
      sourceKey: read.sourceKey,
    });
    for (const row of table.rows) {
      if (family === "iteration-rows") parseIterationRow(acc, context, source, read.sourceKey, row, table.header);
      else if (family === "document-rows") parseDocumentRow(acc, context, source, read.sourceKey, row, table.header);
      else parsePackageRow(acc, context, source, read.sourceKey, row, table.header);
    }
  }
}

function indexColumn(header: string[], names: string[]): number {
  const keys = header.map((cell) => cellText(cell).toLowerCase());
  for (const name of names) {
    const index = keys.indexOf(name);
    if (index !== -1) return index;
  }
  return -1;
}

function cellAt(cells: string[], index: number): string | null {
  if (index < 0 || index >= cells.length) return null;
  const value = cells[index]!.trim();
  return value === "" ? null : value;
}

/** Disclose an index row listed twice in the same file (a real duplicate). */
function noteRow(acc: Accumulator, sourceKey: string, rowCells: string[], line: number): boolean {
  const rowKey = `${sourceKey}\u0000${rowCells.join("|")}`;
  const first = acc.seenRows.get(rowKey);
  if (first === undefined) {
    acc.seenRows.set(rowKey, `line ${line}`);
    return false;
  }
  acc.unknowns.push({
    code: "duplicate-row",
    key: sourceKey,
    detail: `the row ${JSON.stringify(rowCells[0] ?? "")} repeats the row first read at ${first} (line ${line})`,
    sourceKey,
  });
  return true;
}

/**
 * Resolve one legacy index row's reference into a catalog location. A row whose
 * reference leaves its catalog root (a cross-root/history link) is a real
 * legacy shape, not a plan error: it is retained as an explicit
 * unresolved-reference unknown naming the source and line, and the resolvable
 * remainder of the proposal proceeds (§4).
 */
function resolveRowLocation(
  acc: Accumulator,
  sourceKey: string,
  label: string,
  reference: string,
  row: { cells: string[]; line: number },
): string | null {
  const resolved = resolveRelativePath(reference, label);
  if (resolved.ok) return resolved.relativePath;
  acc.unknowns.push({
    code: "reference-unresolvable",
    key: sourceKey,
    detail:
      `the index row ${JSON.stringify(cellText(row.cells[0] ?? ""))} (line ${row.line}) references ` +
      `${JSON.stringify(reference)}, which is not a usable catalog location: ${resolved.reason}`,
    sourceKey,
  });
  return null;
}

/** `| Iteration | Path | Description | Status |` -- the canonical iteration index. */
function parseIterationRow(
  acc: Accumulator,
  context: StoreContext,
  source: IndexSource,
  sourceKey: string,
  row: { cells: string[]; line: number },
  header: string[],
): void {
  const id = cellBacktickToken(row.cells[0] ?? "");
  if (id === null) return;
  if (noteRow(acc, sourceKey, row.cells, row.line)) return;
  const pathCell = cellAt(row.cells, indexColumn(header, ["path"]) >= 0 ? indexColumn(header, ["path"]) : 1) ?? "";
  const declaredPath = cellReference(pathCell) ?? cellBacktickToken(pathCell);
  const descriptionCell = cellAt(row.cells, indexColumn(header, ["description"]));
  const statusCell = cellAt(row.cells, indexColumn(header, ["status"]));
  const declared =
    declaredPath === null ? null : resolveRowLocation(acc, sourceKey, "index row path", declaredPath.replace(/\/+$/, ""), row);
  // An unresolvable declared path falls back to the identity's canonical
  // location, exactly as a row that declares no path at all does; the
  // unresolved reference stays disclosed above.
  const location = declared ?? id;
  const { lifecycle } = catalogLifecycleOf(statusCell);
  if (statusCell !== null && lifecycle === null) {
    acc.unknowns.push({
      code: "lifecycle",
      key: `iteration:${id}`,
      detail: `the index row status ${JSON.stringify(statusCell)} is execution disposition, not a catalog lifecycle; the row is proposed active pending review`,
      sourceKey,
    });
  }
  if (!hasFile(join(catalogRootDir(context, source.rootKind), location), COMPASS_FILE)) {
    acc.unknowns.push({
      code: "reference-missing",
      key: `iteration:${id}`,
      detail: `the index row points at ${location}, which holds no ${COMPASS_FILE}`,
      sourceKey,
    });
  }
  addEntity(acc, {
    kind: "iteration",
    id,
    title: id,
    description: descriptionCell === null ? null : cellText(descriptionCell) || null,
    rootKind: source.rootKind,
    relativePath: location,
    documentKind: null,
    lifecycle: lifecycle ?? "active",
    sourceHash: null,
    idAssigned: false,
    evidence: [
      { sourceKey, field: "index.id", value: id },
      { sourceKey, field: "index.path", value: location },
      ...(descriptionCell === null ? [] : [{ sourceKey, field: "index.description", value: cellText(descriptionCell) }]),
      ...(statusCell === null ? [] : [{ sourceKey, field: "index.status", value: cellText(statusCell) }]),
    ],
  });
}

/** `| Document | Source | Description | Status |` -- a document index table. */
function parseDocumentRow(
  acc: Accumulator,
  context: StoreContext,
  source: IndexSource,
  sourceKey: string,
  row: { cells: string[]; line: number },
  header: string[],
): void {
  const reference = cellReference(row.cells[0] ?? "");
  if (reference === null) return;
  if (noteRow(acc, sourceKey, row.cells, row.line)) return;
  const relativePath = resolveRowLocation(acc, sourceKey, "index row path", reference.replace(/^\.\//, "").replace(/\/+$/, ""), row);
  if (relativePath === null) return;
  const sourceCell = cellAt(row.cells, indexColumn(header, ["source"]));
  const descriptionCell = cellAt(row.cells, indexColumn(header, ["description"]));
  const statusCell = cellAt(row.cells, indexColumn(header, ["status"]));
  const { lifecycle } = catalogLifecycleOf(statusCell);
  if (statusCell !== null && lifecycle === null) {
    acc.unknowns.push({
      code: "lifecycle",
      key: sourceKeyOf(source.rootKind, relativePath),
      detail: `the index row status ${JSON.stringify(statusCell)} is not a catalog lifecycle (active|archived|superseded); the row is proposed active pending review`,
      sourceKey,
    });
  }
  if (sourceCell !== null && cellText(sourceCell) !== "") {
    acc.unknowns.push({
      code: "provenance",
      key: sourceKeyOf(source.rootKind, relativePath),
      detail: `index provenance retained verbatim and not converted into relations: ${cellText(sourceCell)}`,
      sourceKey,
    });
  }
  const label = cellText(row.cells[0] ?? "");
  const linkLabel = label !== "" && label !== relativePath && !label.endsWith(".md") ? label : null;
  const read = readForEvidence(acc, context, source.rootKind, relativePath);
  const bodyTitle = read === null ? null : titleFromBody(read.text, sourceKeyOf(source.rootKind, relativePath));
  addEntity(acc, {
    kind: "document",
    id: `doc-${randomUUID()}`,
    title: linkLabel ?? bodyTitle?.title ?? fallbackTitle(relativePath),
    description: descriptionCell === null ? null : cellText(descriptionCell) || null,
    rootKind: source.rootKind,
    relativePath,
    documentKind: source.documentKind,
    lifecycle: lifecycle ?? "active",
    sourceHash: read === null ? null : sha256(read.text),
    idAssigned: true,
    evidence: dedupeEvidence([
      { sourceKey, field: "index.path", value: relativePath },
      ...(linkLabel === null ? [] : [{ sourceKey, field: "index.title", value: linkLabel }]),
      ...(bodyTitle?.title == null
        ? []
        : [{ sourceKey: sourceKeyOf(source.rootKind, relativePath), field: bodyTitle.field, value: bodyTitle.title }]),
    ]),
  });
}

/** `| Document | Kind | Description | Status |` -- an iteration package index. */
function parsePackageRow(
  acc: Accumulator,
  context: StoreContext,
  source: IndexSource,
  sourceKey: string,
  row: { cells: string[]; line: number },
  header: string[],
): void {
  const owner = source.owner;
  if (owner === undefined) return;
  const reference = cellReference(row.cells[0] ?? "");
  if (reference === null) return;
  if (noteRow(acc, sourceKey, row.cells, row.line)) return;
  const relativePath = resolveRowLocation(
    acc,
    sourceKey,
    "package row path",
    `${owner}/${reference.replace(/^\.\//, "").replace(/\/+$/, "")}`,
    row,
  );
  if (relativePath === null) return;
  const declaredKindCell = cellAt(row.cells, indexColumn(header, ["kind"]));
  const declaredKind = declaredKindCell === null ? null : cellText(declaredKindCell).toLowerCase();
  const documentKind =
    declaredKind !== null && Object.hasOwn(DOCUMENT_KINDS, declaredKind) ? (declaredKind as CatalogDocumentKind) : "other";
  if (declaredKind === null || !Object.hasOwn(DOCUMENT_KINDS, declaredKind)) {
    acc.unknowns.push({
      code: "document-kind",
      key: sourceKeyOf(source.rootKind, relativePath),
      detail: `the package index row declares kind ${JSON.stringify(declaredKind ?? "")}, which is not a catalog document kind; "other" is proposed pending review`,
      sourceKey,
    });
  }
  const descriptionCell = cellAt(row.cells, indexColumn(header, ["description"]));
  const statusCell = cellAt(row.cells, indexColumn(header, ["status"]));
  const { lifecycle } = catalogLifecycleOf(statusCell);
  if (statusCell !== null && lifecycle === null) {
    acc.unknowns.push({
      code: "lifecycle",
      key: sourceKeyOf(source.rootKind, relativePath),
      detail: `the package index row status ${JSON.stringify(statusCell)} is not a catalog lifecycle; "active" is proposed pending review`,
      sourceKey,
    });
  }
  const read = readForEvidence(acc, context, source.rootKind, relativePath);
  const documentId = `doc-${randomUUID()}`;
  addEntity(acc, {
    kind: "document",
    id: documentId,
    title: fallbackTitle(reference.replace(/\/+$/, "")),
    description: descriptionCell === null ? null : cellText(descriptionCell) || null,
    rootKind: source.rootKind,
    relativePath,
    documentKind,
    lifecycle: lifecycle ?? "active",
    sourceHash: read === null ? null : sha256(read.text),
    idAssigned: true,
    evidence: [
      { sourceKey, field: "index.path", value: relativePath },
      ...(declaredKindCell === null ? [] : [{ sourceKey, field: "index.kind", value: cellText(declaredKindCell) }]),
    ],
  });
  // The package index itself states which documents the iteration owns: an
  // explicit table entry, not a relation guessed from a file name.
  acc.links.push({
    from: { kind: "iteration", id: owner },
    relation: "documents",
    to: { kind: "document", id: documentId },
    ordinal: row.line,
    evidence: [{ sourceKey, field: "index.documents", value: relativePath }],
  });
}

/**
 * `discoverCatalog(context)` -- the reviewable dry-run inventory (§4): the
 * legacy index rows plus the tracked bodies of the configured document roots.
 * A proposal only; nothing is written and nothing becomes authority.
 */
export async function discoverCatalog(context: StoreContext): Promise<CatalogImportPlan> {
  const acc = emptyAccumulator();
  const iterationsRoot = catalogRootDir(context, "iterations");
  const specsRoot = catalogRootDir(context, "specs");
  const knowledgeRoot = catalogRootDir(context, "knowledge");
  const plansRoot = catalogRootDir(context, "plans");
  const projectsRoot = catalogRootDir(context, "projects");

  const iterationIds = listDirectories(iterationsRoot).filter((id) => hasFile(join(iterationsRoot, id), COMPASS_FILE));
  const projectIds = listDirectories(projectsRoot).filter((id) => hasFile(join(projectsRoot, id), ROADMAP_FILE));

  // 1. Layout identity: the harness's own directory conventions (§1).
  for (const id of projectIds) {
    bodyProposal(
      acc,
      context,
      "projects",
      id,
      "project",
      null,
      {
        value: id,
        assigned: false,
        evidence: [{ sourceKey: sourceKeyOf("projects", `${id}/${ROADMAP_FILE}`), field: "layout.directory", value: id }],
      },
      `${id}/${ROADMAP_FILE}`,
    );
  }
  for (const id of iterationIds) {
    bodyProposal(
      acc,
      context,
      "iterations",
      id,
      "iteration",
      null,
      {
        value: id,
        assigned: false,
        evidence: [{ sourceKey: sourceKeyOf("iterations", `${id}/${COMPASS_FILE}`), field: "layout.directory", value: id }],
      },
      `${id}/${COMPASS_FILE}`,
    );
  }
  for (const relativePath of collectBodies(plansRoot)) {
    const id = relativePath.replace(/\.md$/, "");
    bodyProposal(acc, context, "plans", relativePath, "plan", null, {
      value: id,
      assigned: false,
      evidence: [{ sourceKey: sourceKeyOf("plans", relativePath), field: "plan-file", value: id }],
    });
  }

  // 2. Tracked document bodies (fresh-clone discovery, §4).
  for (const relativePath of collectBodies(knowledgeRoot)) {
    bodyProposal(acc, context, "knowledge", relativePath, "document", "knowledge", {
      value: `doc-${randomUUID()}`,
      assigned: true,
      evidence: [{ sourceKey: sourceKeyOf("knowledge", relativePath), field: "layout.document", value: relativePath }],
    });
  }
  for (const relativePath of collectBodies(specsRoot)) {
    bodyProposal(acc, context, "specs", relativePath, "document", "spec", {
      value: `doc-${randomUUID()}`,
      assigned: true,
      evidence: [{ sourceKey: sourceKeyOf("specs", relativePath), field: "layout.document", value: relativePath }],
    });
  }

  // 3. Legacy index rows: documents and iterations declared by an index table.
  for (const source of indexSourcesFor(context, iterationIds)) {
    parseIndexFile(acc, context, source);
  }

  resolveProposals(acc);
  // A relation whose endpoint is not proposed by this discovery set cannot be
  // applied by an import; it is reported instead of being invented (§4).
  const known = new Set(acc.entities.map((proposal) => entityKey(proposal.kind, proposal.id)));
  acc.links = acc.links.filter((link) => {
    const fromKey = entityKey(link.from.kind, link.from.id);
    const toKey = entityKey(link.to.kind, link.to.id);
    if (known.has(fromKey) && known.has(toKey)) return true;
    acc.unknowns.push({
      code: "reference-missing",
      key: `${fromKey} ${link.relation} ${toKey}`,
      detail: "the relation endpoint is not part of this discovery set; the relation is not recovered",
      sourceKey: link.evidence[0]?.sourceKey ?? fromKey,
    });
    return false;
  });
  return sortedPlan(acc);
}

// ---------------------------------------------------------------------------
// Reviewed-mapping planning
// ---------------------------------------------------------------------------

function requireMapping(input: CatalogImportInput, index: number): CatalogImportEntityMapping {
  const label = `inputs[${index}].mapping`;
  const mapping = input?.mapping;
  if (mapping === null || typeof mapping !== "object") throw invalidPlan(`${label} is required`);
  if (typeof mapping.kind !== "string" || !Object.hasOwn(ENTITY_KINDS, mapping.kind)) {
    throw invalidPlan(`${label}.kind must be project|iteration|plan|document`);
  }
  if (typeof mapping.id !== "string" || mapping.id.trim() === "") throw invalidPlan(`${label}.id must be nonblank`);
  if (mapping.documentKind !== undefined && mapping.documentKind !== null && !Object.hasOwn(DOCUMENT_KINDS, mapping.documentKind)) {
    throw invalidPlan(`${label}.documentKind is not a catalog document kind`);
  }
  if (mapping.lifecycle !== undefined && !Object.hasOwn(LIFECYCLES, mapping.lifecycle)) {
    throw invalidPlan(`${label}.lifecycle is not a catalog lifecycle`);
  }
  return mapping;
}

function requireInput(input: CatalogImportInput, index: number): { rootKind: CatalogRootKind; relativePath: string; mapping: CatalogImportEntityMapping } {
  if (input === null || typeof input !== "object") throw invalidPlan(`inputs[${index}] must be an object`);
  if (typeof input.rootKind !== "string" || !Object.hasOwn(ROOT_KINDS, input.rootKind)) {
    throw invalidPlan(`inputs[${index}].rootKind is not a configured catalog root kind`);
  }
  return {
    rootKind: input.rootKind,
    relativePath: normalizeRelativePath(input.relativePath, `inputs[${index}].relativePath`),
    mapping: requireMapping(input, index),
  };
}

/** Every catalog row, so planned relations can be checked against local truth. */
async function readLocalCatalog(context: StoreContext): Promise<Map<string, CatalogEntity>> {
  const byKey = new Map<string, CatalogEntity>();
  let offset = 0;
  for (;;) {
    const page = await listCatalog(context, { limit: CATALOG_PAGE_LIMIT, offset });
    for (const entity of page.items) byKey.set(entityKey(entity.kind, entity.id), entity);
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total) return byKey;
  }
}

/**
 * `planCatalogImport(context, inputs)` -- the reviewed-mapping step (§4): the
 * caller supplies the identity/relations it reviewed, the engine re-reads the
 * named sources for the reviewed hashes and reports conflicts and what cannot
 * be recovered. Reads only.
 */
export async function planCatalogImport(context: StoreContext, inputs: CatalogImportInput[]): Promise<CatalogImportPlan> {
  if (!Array.isArray(inputs)) throw invalidPlan("inputs must be an array of reviewed import inputs");
  const acc = emptyAccumulator();
  const local = await readLocalCatalog(context);

  inputs.forEach((raw, index) => {
    const { rootKind, relativePath, mapping } = requireInput(raw, index);
    const read = readForEvidence(acc, context, rootKind, relativePath);
    const sourceKey = sourceKeyOf(rootKind, relativePath);
    const bodyTitle = read === null ? null : titleFromBody(read.text, sourceKey);
    const kind = mapping.kind;
    const documentKind = kind === "document" ? (mapping.documentKind ?? null) : null;
    if (kind === "document" && documentKind === null) {
      acc.unknowns.push({
        code: "document-kind",
        key: sourceKey,
        detail: "a document entity requires a reviewed documentKind; none was supplied",
        sourceKey,
      });
    }
    const proposal: CatalogImportEntityProposal = {
      kind,
      id: mapping.id.trim(),
      title: mapping.title ?? bodyTitle?.title ?? fallbackTitle(relativePath),
      description: mapping.description ?? null,
      rootKind: mapping.rootKind ?? rootKind,
      relativePath: mapping.relativePath === undefined ? relativePath : normalizeRelativePath(mapping.relativePath, `inputs[${index}].mapping.relativePath`),
      documentKind,
      lifecycle: mapping.lifecycle ?? "active",
      sourceHash: mapping.sourceHash === undefined ? (read === null ? null : sha256(read.text)) : mapping.sourceHash,
      idAssigned: false,
      evidence: dedupeEvidence([
        { sourceKey, field: "reviewed.mapping", value: `${kind}:${mapping.id.trim()}` },
        ...(bodyTitle?.title == null ? [] : [{ sourceKey, field: bodyTitle.field, value: bodyTitle.title }]),
      ]),
    };
    addEntity(acc, proposal);

    for (const link of raw.links ?? []) {
      if (typeof link?.relation !== "string" || !Object.hasOwn(RELATIONS, link.relation)) {
        throw invalidPlan(`inputs[${index}].links carries an unknown relation`);
      }
      const target = link.to;
      if (target === null || typeof target !== "object" || typeof target.id !== "string" || !Object.hasOwn(ENTITY_KINDS, target.kind)) {
        throw invalidPlan(`inputs[${index}].links[].to must be a {kind, id} catalog key`);
      }
      acc.links.push({
        from: { kind, id: mapping.id.trim() },
        relation: link.relation,
        to: { kind: target.kind, id: target.id },
        ordinal: link.ordinal ?? null,
        evidence: [{ sourceKey, field: "reviewed.link", value: `${link.relation} ${target.kind}:${target.id}` }],
      });
    }

    const existing = local.get(entityKey(kind, mapping.id.trim()));
    if (existing !== undefined && (existing.rootKind !== proposal.rootKind || existing.relativePath !== proposal.relativePath)) {
      acc.conflicts.push({
        field: "path",
        key: entityKey(kind, proposal.id),
        values: [
          { value: locationKey(proposal.rootKind, proposal.relativePath), sourceKey },
          { value: locationKey(existing.rootKind, existing.relativePath), sourceKey: "catalog:local" },
        ],
        message: `${entityKey(kind, proposal.id)} is already registered at ${locationKey(existing.rootKind, existing.relativePath)}`,
      });
    }
  });

  resolveProposals(acc);

  // Reviewed relations: a target that is neither planned nor registered locally
  // cannot be recorded - report it instead of creating a placeholder row (§4).
  const planned = new Set(acc.entities.map((proposal) => entityKey(proposal.kind, proposal.id)));
  acc.links = acc.links.filter((link) => {
    const fromKey = entityKey(link.from.kind, link.from.id);
    const toKey = entityKey(link.to.kind, link.to.id);
    if (planned.has(fromKey) && (planned.has(toKey) || local.has(toKey))) return true;
    acc.unknowns.push({
      code: "reference-missing",
      key: `${fromKey} ${link.relation} ${toKey}`,
      detail: planned.has(fromKey)
        ? "the reviewed relation target is neither part of this plan nor registered in the local catalog; the relation is not recovered"
        : "the reviewed relation owner is not part of this plan; the relation is not recovered",
      sourceKey: link.evidence[0]?.sourceKey ?? fromKey,
    });
    return false;
  });
  return sortedPlan(acc);
}

/**
 * Turn a reviewed export payload into reviewed inputs (§4 portability): the
 * exported ids/relations/locations are preserved; exported revisions stay
 * provenance and are never re-applied to the local store.
 */
export function catalogExportToInputs(payload: CatalogExport): CatalogImportInput[] {
  if (payload === null || typeof payload !== "object" || !Array.isArray(payload.entities)) {
    throw invalidPlan("an export payload must carry an entities array");
  }
  const linksByOwner = new Map<string, CatalogImportReviewedLink[]>();
  for (const link of payload.links ?? []) {
    const owner = entityKey(link.fromKind, link.fromId);
    const bucket = linksByOwner.get(owner) ?? [];
    bucket.push({ relation: link.relation, to: { kind: link.toKind, id: link.toId }, ordinal: link.ordinal });
    linksByOwner.set(owner, bucket);
  }
  return payload.entities.map((entity) => ({
    rootKind: entity.rootKind,
    relativePath: entity.relativePath,
    mapping: {
      kind: entity.kind,
      id: entity.id,
      title: entity.title,
      description: entity.description,
      documentKind: entity.documentKind,
      lifecycle: entity.lifecycle,
      sourceHash: entity.sourceHash,
    },
    links: linksByOwner.get(entityKey(entity.kind, entity.id)) ?? [],
    provenance: {
      revision: entity.revision,
      registeredAt: entity.registeredAt,
      updatedAt: entity.updatedAt,
      sourceHash: entity.sourceHash,
    },
  }));
}

/** `exportCatalog(context)` -- versioned transport, never a file authority (§4). */
export async function exportCatalog(context: StoreContext): Promise<CatalogExport> {
  const entities: CatalogEntity[] = [];
  const links = new Map<string, CatalogLink>();
  let offset = 0;
  let storeRevision = 0;
  for (;;) {
    const page = await listCatalog(context, { limit: CATALOG_PAGE_LIMIT, offset });
    storeRevision = page.storeRevision;
    for (const entity of page.items) entities.push(entity);
    for (const link of page.links) {
      links.set([link.fromKind, link.fromId, link.relation, link.toKind, link.toId].join("\u0000"), link);
    }
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total) break;
  }
  return {
    version: CATALOG_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    storeRevision,
    entities,
    links: [...links.values()].sort((a, b) =>
      [a.fromKind, a.fromId, a.relation, a.toKind, a.toId].join("\u0000").localeCompare(
        [b.fromKind, b.fromId, b.relation, b.toKind, b.toId].join("\u0000"),
      ),
    ),
  };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function requirePlan(plan: CatalogImportPlan): void {
  if (plan === null || typeof plan !== "object") throw invalidPlan("an import plan is required");
  if (plan.version !== CATALOG_IMPORT_PLAN_VERSION) {
    throw invalidPlan(`unsupported import plan version ${JSON.stringify(plan.version)}; expected ${CATALOG_IMPORT_PLAN_VERSION}`);
  }
  for (const field of ["sourceDigests", "entities", "links", "conflicts", "unknowns", "retirementSections"] as const) {
    if (!Array.isArray(plan[field])) throw invalidPlan(`the import plan is missing its ${field} list`);
  }
}

/**
 * Re-check a reviewed plan against the current sources and the plan's own
 * conflicts. Read-only: the same check `importCatalog` refuses on, exposed so a
 * reviewer can reconcile hashes before writing (§4).
 */
export async function verifyCatalogImport(context: StoreContext, plan: CatalogImportPlan): Promise<CatalogImportVerification> {
  requirePlan(plan);
  const drift: CatalogImportDrift[] = [];
  for (const digest of plan.sourceDigests) {
    const read = readSourceFile(context, digest.rootKind, digest.relativePath);
    if (read.state === "ok" && read.sha256 === digest.sha256) continue;
    drift.push({
      sourceKey: digest.sourceKey,
      rootKind: digest.rootKind,
      relativePath: digest.relativePath,
      expectedSha256: digest.sha256,
      actualSha256: read.state === "ok" ? read.sha256 : null,
      state: read.state === "ok" ? "changed" : read.state,
    });
  }
  return { ok: plan.conflicts.length === 0 && drift.length === 0, conflicts: plan.conflicts, drift };
}

/**
 * `importCatalog(context, plan, operation)` -- apply a reviewed plan.
 *
 * The reviewed hashes are verified first and a conflict blocks: nothing is
 * written when the plan disagrees with itself or its sources moved. Each
 * proposal is then applied through the shared catalog domain verbs, with a
 * deterministic per-proposal operation id derived from `operation.operationId`,
 * so a retry (or a second call after a crash) replays the applied rows and
 * converges instead of double-writing. No workflow session is created and no
 * index is retired.
 *
 * A mid-plan failure is NEVER a silent prefix (RV-3): the domain verbs commit
 * each applied proposal together with its journal row, so the applied prefix
 * is persisted progress, and the failure is rethrown as an explicit
 * `catalog.import-partial` error naming exactly what applied, which proposal
 * failed, and how to resume (re-run the SAME plan with the SAME operationId —
 * applied proposals replay idempotently from the journal). The verbs are not
 * re-entered inside one caller-managed transaction: each owns its own
 * transaction and journal rules (the P1 boundary the registration journal
 * also keeps), so the resumable journal — not a hand-rolled second writer —
 * is the atomicity story here.
 */
export async function importCatalog(
  context: StoreContext,
  plan: CatalogImportPlan,
  operation: CatalogOperation,
): Promise<CatalogImportReceipt> {
  requirePlan(plan);
  const operationId = typeof operation?.operationId === "string" ? operation.operationId.trim() : "";
  const actor = typeof operation?.actor === "string" ? operation.actor.trim() : "";
  if (operationId === "" || actor === "") {
    throw new CatalogImportError("catalog.import-unknown-input", "an import operation requires an operationId and an actor");
  }
  if (plan.conflicts.length > 0) {
    const first = plan.conflicts[0]!;
    throw new CatalogImportError(
      "catalog.import-conflict",
      `the plan carries ${plan.conflicts.length} unresolved conflict(s); no source is preferred silently. First: ${first.message}`,
    );
  }
  const verification = await verifyCatalogImport(context, plan);
  if (verification.drift.length > 0) {
    const first = verification.drift[0]!;
    throw new CatalogImportError(
      "catalog.import-source-drift",
      `the reviewed source ${first.sourceKey} is ${first.state} since review ` +
        `(expected ${first.expectedSha256.slice(0, 12)}, actual ${first.actualSha256 === null ? "none" : first.actualSha256.slice(0, 12)}); ` +
        `${verification.drift.length} source(s) drifted and nothing was imported`,
    );
  }

  const receipts: CatalogReceipt[] = [];
  const effective = new Map<string, string>();
  const appliedLinks: CatalogLink[] = [];
  try {
    for (const [index, proposal] of plan.entities.entries()) {
      const input: CatalogEntityInput = {
        kind: proposal.kind,
        id: proposal.id,
        title: proposal.title === "" ? fallbackTitle(proposal.relativePath) : proposal.title,
        description: proposal.description,
        rootKind: proposal.rootKind,
        relativePath: proposal.relativePath,
        documentKind: proposal.documentKind,
        lifecycle: proposal.lifecycle,
        sourceHash: proposal.sourceHash,
      };
      const receipt = await registerCatalogEntity(context, input, { operationId: `${operationId}:entity:${index}`, actor });
      receipts.push(receipt);
      // A proposal may attach to the row that already owns the location (§2);
      // later relations must target the effective id, never the proposed one.
      effective.set(entityKey(proposal.kind, proposal.id), receipt.id);
    }

    for (const [index, link] of plan.links.entries()) {
      const from = { kind: link.from.kind, id: effective.get(entityKey(link.from.kind, link.from.id)) ?? link.from.id };
      const to = { kind: link.to.kind, id: effective.get(entityKey(link.to.kind, link.to.id)) ?? link.to.id };
      await linkCatalogEntities(context, { from, relation: link.relation, to, ordinal: link.ordinal }, {
        operationId: `${operationId}:link:${index}`,
        actor,
      });
      appliedLinks.push({ fromKind: from.kind, fromId: from.id, relation: link.relation, toKind: to.kind, toId: to.id, ordinal: link.ordinal });
    }
  } catch (error) {
    const stage = appliedLinks.length === 0 && receipts.length < plan.entities.length ? "entity" : "link";
    const failedIndex = stage === "entity" ? receipts.length : appliedLinks.length;
    const failedMessage = error instanceof Error ? error.message : String(error);
    const partial: CatalogImportPartialState = {
      operationId,
      appliedEntities: receipts,
      appliedLinks,
      failed: { stage, index: failedIndex, message: failedMessage },
    };
    throw new CatalogImportError(
      "catalog.import-partial",
      `the import applied a partial state before failing: ${receipts.length} of ${plan.entities.length} entity proposal(s) ` +
        `${receipts.length > 0 ? `(${receipts.map((receipt) => `${receipt.kind}:${receipt.id}`).join(", ")}) ` : ""}` +
        `and ${appliedLinks.length} of ${plan.links.length} link proposal(s) are committed; the ${stage} proposal at index ` +
        `${failedIndex} failed with: ${failedMessage}. The applied rows are journalled progress, not a silent prefix \u2014 ` +
        `re-run the SAME reviewed plan with the SAME operationId ("${operationId}") to resume: applied proposals replay ` +
        "idempotently from the catalog operation journal and only the remaining proposals apply.",
      partial,
    );
  }

  let storeRevision = receipts.at(-1)?.storeRevision ?? 0;
  if (receipts.length === 0) storeRevision = (await listCatalog(context, { limit: 1 })).storeRevision;

  return {
    operationId,
    planVersion: plan.version,
    entities: receipts,
    links: appliedLinks,
    unknowns: plan.unknowns,
    storeRevision,
  };
}


