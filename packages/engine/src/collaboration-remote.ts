/**
 * invariant: collaboration-remote.ts -- the remote authority boundary.
 *
 * A `remote` checkout's provider is the collaboration authority; this module
 * owns the ONLY transactions that write its local cache: the explicit bind that
 * materializes the selected provider scope, and the observation ingest that
 * replaces one project's evidence. It never reads or writes the local domain
 * tables (`issues`, `catalog_*`, `project_*`), never opens a local-authority
 * lane, and makes no provider call: the Host Agent supplies already-verified
 * `ScopeCheck` / snapshot JSON, which is a trusted-host assertion, not a token.
 *
 * Everything a caller persists is validated and normalized to the allowlisted
 * contract fields; scope is proven against the checked selector and the v3
 * checkout binding before any row is touched. A negative access check is
 * recorded as an invalidation (the cache stops serving) and returned as its
 * named refusal - never as an empty or zero result.
 */
import { existsSync } from "node:fs";
import {
  readCollaborationBinding,
  initializeRemoteCacheStore,
  openRemoteCache,
  writeRemoteCacheStage,
  writeRemoteCollaborationBinding,
  withRemoteCacheWrite,
  assertIssueRef,
  assertRemoteCacheIdentity,
  type CollaborationAuthority,
  type CollaborationBinding,
  type CollaborationStoreHandle,
} from "./collaboration-store.js";
import { ISSUE_DISPOSITIONS, ISSUE_KINDS, ISSUE_PROVENANCE_KINDS, ISSUE_RELATIONS, ISSUE_SEVERITIES } from "./issue.js";
import {
  resolveCollaborationLocation,
  type CollaborationLocation,
  type CollaborationSelectorProject,
  type CollaborationSelection,
} from "./collaboration-identity.js";
import { StoreError, nowRfc3339, type StoreContext, type StoreDb, type StoreErrorCode } from "./store-db.js";

// ---------------------------------------------------------------------------
// note: Contract DTOs (Q1 - identity, scope checks and normalized snapshots)
// ---------------------------------------------------------------------------

/** note: The bound provider record an MStar issue is anchored to. */
export type ProviderIssueIdentity = Readonly<{
  provider: "linear";
  workspaceId: string;
  teamId: string;
  projectId: string;
  issueId: string;
}>;

/** note: The dedicated provider project one local project is bound to. */
export type ProviderProjectScope = Readonly<{
  provider: "linear";
  workspaceId: string;
  teamId: string;
  projectId: string;
}>;

/** note: The five capabilities a binding must prove before it can hold authority. */
export type ScopeCapabilities = Readonly<{
  fullRead: boolean;
  appendOnly: boolean;
  exactLookup: boolean;
  fieldFidelity: boolean;
  privateAudience: boolean;
}>;

/** note: What the Host Agent's live access check established for one project. */
export type ScopeOutcome =
  | Readonly<{
      kind: "verified";
      readerId: string;
      writerId: string | null;
      capabilities: ScopeCapabilities;
    }>
  | Readonly<{ kind: "unavailable" | "scope-mismatch" | "denied" | "revoked" | "unsafe-fidelity" }>;

/** note: One project's verified (or refused) access at the host's `checkedAt`. */
export type ScopeCheck = Readonly<{
  projectId: string;
  scope: ProviderProjectScope;
  journalIssueId: string;
  checkedAt: string;
  outcome: ScopeOutcome;
}>;

/** note: `remote bind --input` - exactly one positive check per selected project. */
export type VerificationBatch = Readonly<{
  version: 1;
  selectorCommit: string;
  generation: number;
  checks: readonly ScopeCheck[];
}>;

export type RemoteMilestone = Readonly<{
  milestoneId: string;
  name: string;
  target: string | null;
  status: "planned" | "active" | "delivered" | "dropped";
  ordinal: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}>;

export type RemoteRoadmap = Readonly<{ contentMarkdown: string; revision: number; updatedAt: string }>;

export type RemoteCatalogEntity = Readonly<{
  kind: "project" | "iteration" | "plan" | "document";
  id: string;
  title: string;
  description: string | null;
  documentKind: string | null;
  lifecycle: "active" | "archived" | "superseded";
  revision: number;
}>;

export type RemoteCatalogLink = Readonly<{
  fromKind: "project" | "iteration" | "plan" | "document";
  fromId: string;
  relation: "belongs-to" | "documents" | "spec-ref" | "knowledge-ref" | "derived-from" | "supersedes";
  toKind: "project" | "iteration" | "plan" | "document";
  toId: string;
  ordinal: number | null;
}>;

/**
 * note: The MStar subject as it travels in the snapshot. Its interior history is the
 * reviewed subject document the read boundary consumes, so this boundary
 * validates that each named member is present with the contract's container
 * kind and preserves it whole - it does not reinterpret local authority.
 */
export type RemoteMstarIssue = Readonly<{
  issueRef: string;
  head: readonly string[];
  fields: Record<string, unknown>;
  occurrences: readonly Record<string, unknown>[];
  transitions: readonly Record<string, unknown>[];
  relations: readonly Record<string, unknown>[];
  provenance: readonly Record<string, unknown>[];
  projectMoves: readonly Record<string, unknown>[];
}>;

/** note: `mstar: null` is a provider-only issue: visible, never counted as an MStar record. */
export type RemoteIssue = Readonly<{
  identity: ProviderIssueIdentity;
  nativeTitle: string;
  nativeStatus: string;
  providerUpdatedAt: string;
  mstar: RemoteMstarIssue | null;
}>;

export type RemoteSnapshotProject = Readonly<{
  projectId: string;
  /** note: `null` only for a verified empty project journal. */
  head: readonly string[] | null;
  binding: ProviderProjectScope;
  milestones: readonly RemoteMilestone[];
  roadmap: RemoteRoadmap | null;
  catalogEntities: readonly RemoteCatalogEntity[];
  catalogLinks: readonly RemoteCatalogLink[];
}>;

/** note: A complete traversal, or the one known gap that makes this a partial observation. */
export type SnapshotCoverage =
  | Readonly<{ kind: "complete" }>
  | Readonly<{
      kind: "partial";
      stream: "issues" | "comments" | "journal";
      nextCursor: string | null;
      code: string;
    }>;

export type RemoteSnapshot = Readonly<{
  asOf: string;
  coverage: SnapshotCoverage;
  project: RemoteSnapshotProject;
  issues: readonly RemoteIssue[];
}>;

/** note: `remote observe --input` - one verification and at most one whole-project snapshot. */
export type ObservationSubmission = Readonly<{
  version: 1;
  selectorCommit: string;
  generation: number;
  check: ScopeCheck;
  expectRevision: number;
  snapshot: RemoteSnapshot | null;
}>;

// ---------------------------------------------------------------------------
// note: Narrow DTO validation. Every message names the offending field path so a
// Host Agent author can fix the document, never guess.
// ---------------------------------------------------------------------------

const RCF3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LINEAR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** note: A stable history event id carries the same lowercase UUID shape as every portable key. */
const UUID = LINEAR_ID;

const CAPABILITY_KEYS = ["fullRead", "appendOnly", "exactLookup", "fieldFidelity", "privateAudience"] as const;

/** note: A positive access check expires 60 seconds after `checkedAt`. */
const SCOPE_CHECK_TTL_MS = 60_000;

function invalid(path: string, detail: string): never {
  throw new StoreError("remote.input-invalid", `${path}: ${detail}. Nothing was written.`);
}

/**
 * note: The one object guard for this boundary. The engine has no shared runtime-shape
 * module, and these are the only documents that cross it, so the parse lives
 * here and every field below is narrowed with its own `typeof` / `in` check.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(path, "must be an object");
  return value;
}

function list(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(path, "must be an array");
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") invalid(path, "must be a non-empty string");
  return value;
}

function optionalText(value: unknown, path: string): string | null {
  if (value === null) return null;
  return text(value, path);
}

function instant(value: unknown, path: string): string {
  const raw = text(value, path);
  if (!RCF3339.test(raw) || !Number.isFinite(Date.parse(raw))) {
    invalid(path, "must be a UTC RFC 3339 instant (YYYY-MM-DDTHH:MM:SS[.fff]Z)");
  }
  return raw;
}

function digest(value: unknown, path: string): string {
  const raw = text(value, path);
  if (!SHA256.test(raw)) invalid(path, "must be a canonical lowercase SHA-256 digest");
  return raw;
}

/** note: Sorted, unique content digests: the canonical form the cutover and read boundary compare. */
function digestHead(value: unknown, path: string): readonly string[] {
  const raw = list(value, path).map((entry, index) => digest(entry, `${path}[${index}]`));
  const sorted = [...raw].sort();
  if (new Set(raw).size !== raw.length) invalid(path, "must not repeat a digest");
  if (raw.some((entry, index) => entry !== sorted[index])) invalid(path, "must be sorted");
  return raw;
}

function integer(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) invalid(path, "must be a safe integer");
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  const raw = integer(value, path);
  if (raw <= 0) invalid(path, "must be a positive integer");
  return raw;
}

function nonNegativeInteger(value: unknown, path: string): number {
  const raw = integer(value, path);
  if (raw < 0) invalid(path, "must be a non-negative integer");
  return raw;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(path, "must be a boolean");
  return value;
}

function oneOf<const T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    invalid(path, `must be one of ${allowed.join("|")}`);
  }
  return value as T;
}

/** note: Reject every member the contract does not name, so no unlisted material reaches the cache. */
function allowOnly(body: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) invalid(`${path}.${key}`, "is not a contract field");
  }
}

function stringList(value: unknown, path: string): string[] {
  return list(value, path).map((entry, index) => text(entry, `${path}[${index}]`));
}

/** note: A nullable member: absent or null is null, otherwise it must be a string. */
function nullableString(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") invalid(path, "must be a string or null");
  return value;
}

function nullableInstant(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  return instant(value, path);
}

function eventId(value: unknown, path: string): string {
  const raw = text(value, path);
  if (!UUID.test(raw)) invalid(path, "must be a stable event UUID");
  return raw;
}

function linearId(value: unknown, path: string): string {
  const raw = text(value, path);
  if (!LINEAR_ID.test(raw)) invalid(path, "must be an immutable Linear object id (lowercase UUID)");
  return raw;
}

/** note: A project's provider tuple, validated without the issue identity. */
function projectScope(value: unknown, path: string): ProviderProjectScope {
  const body = record(value, path);
  if (body.provider !== "linear") invalid(`${path}.provider`, "must be 'linear'");
  return {
    provider: "linear",
    workspaceId: linearId(body.workspaceId, `${path}.workspaceId`),
    teamId: linearId(body.teamId, `${path}.teamId`),
    projectId: linearId(body.projectId, `${path}.projectId`),
  };
}

function issueIdentity(value: unknown, path: string): ProviderIssueIdentity {
  const body = record(value, path);
  return { ...projectScope(body, path), issueId: linearId(body.issueId, `${path}.issueId`) };
}

function sameScope(left: ProviderProjectScope, right: ProviderProjectScope): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.teamId === right.teamId &&
    left.projectId === right.projectId
  );
}

function capabilities(value: unknown, path: string): ScopeCapabilities {
  const body = record(value, path);
  const result: Record<string, boolean> = {};
  for (const key of CAPABILITY_KEYS) {
    const flag = body[key];
    if (typeof flag !== "boolean") invalid(`${path}.${key}`, "must be a boolean");
    result[key] = flag;
  }
  return result as ScopeCapabilities;
}

function scopeOutcome(value: unknown, path: string): ScopeOutcome {
  const body = record(value, path);
  const kind = body.kind;
  if (kind === "verified") {
    const proven = capabilities(body.capabilities, `${path}.capabilities`);
    for (const key of CAPABILITY_KEYS) {
      if (!proven[key]) invalid(`${path}.capabilities.${key}`, "an authoritative binding needs every capability");
    }
    return {
      kind: "verified",
      readerId: text(body.readerId, `${path}.readerId`),
      writerId: body.writerId === null ? null : text(body.writerId, `${path}.writerId`),
      capabilities: proven,
    };
  }
  return { kind: oneOf(kind, ["unavailable", "scope-mismatch", "denied", "revoked", "unsafe-fidelity"], `${path}.kind`) };
}

/** note: The named refusal a negative access outcome maps to. */
const NEGATIVE_OUTCOME_CODES: Readonly<Record<Exclude<ScopeOutcome["kind"], "verified">, StoreErrorCode>> = {
  unavailable: "remote.unavailable",
  "scope-mismatch": "remote.scope-mismatch",
  denied: "remote.denied",
  revoked: "remote.revoked",
  "unsafe-fidelity": "remote.unsafe-fidelity",
};

function scopeCheck(value: unknown, path: string): ScopeCheck {
  const body = record(value, path);
  return {
    projectId: text(body.projectId, `${path}.projectId`),
    scope: projectScope(body.scope, `${path}.scope`),
    journalIssueId: linearId(body.journalIssueId, `${path}.journalIssueId`),
    checkedAt: instant(body.checkedAt, `${path}.checkedAt`),
    outcome: scopeOutcome(body.outcome, `${path}.outcome`),
  };
}

function verificationBatch(value: unknown): VerificationBatch {
  const body = record(value, "batch");
  if (body.version !== 1) invalid("batch.version", "must be 1");
  const selectorCommit = text(body.selectorCommit, "batch.selectorCommit");
  if (!GIT_OBJECT_ID.test(selectorCommit)) invalid("batch.selectorCommit", "must be a Git object id");
  return {
    version: 1,
    selectorCommit,
    generation: positiveInteger(body.generation, "batch.generation"),
    checks: list(body.checks, "batch.checks").map((entry, index) => scopeCheck(entry, `batch.checks[${index}]`)),
  };
}

function milestone(value: unknown, path: string): RemoteMilestone {
  const body = record(value, path);
  const target = body.target === null ? null : text(body.target, `${path}.target`);
  if (target !== null && !CALENDAR_DATE.test(target)) invalid(`${path}.target`, "must be YYYY-MM-DD or null");
  return {
    milestoneId: text(body.milestoneId, `${path}.milestoneId`),
    name: text(body.name, `${path}.name`),
    target,
    status: oneOf(body.status, ["planned", "active", "delivered", "dropped"], `${path}.status`),
    ordinal: nonNegativeInteger(body.ordinal, `${path}.ordinal`),
    revision: positiveInteger(body.revision, `${path}.revision`),
    createdAt: instant(body.createdAt, `${path}.createdAt`),
    updatedAt: instant(body.updatedAt, `${path}.updatedAt`),
  };
}

function roadmap(value: unknown, path: string): RemoteRoadmap | null {
  if (value === null) return null;
  const body = record(value, path);
  if (typeof body.contentMarkdown !== "string") invalid(`${path}.contentMarkdown`, "must be a string");
  return {
    contentMarkdown: body.contentMarkdown,
    revision: positiveInteger(body.revision, `${path}.revision`),
    updatedAt: instant(body.updatedAt, `${path}.updatedAt`),
  };
}

const CATALOG_KINDS = ["project", "iteration", "plan", "document"] as const;
const CATALOG_RELATIONS = [
  "belongs-to", "documents", "spec-ref", "knowledge-ref", "derived-from", "supersedes",
] as const;

function catalogEntity(value: unknown, path: string): RemoteCatalogEntity {
  const body = record(value, path);
  const documentKind = optionalText(body.documentKind, `${path}.documentKind`);
  if (documentKind !== null && body.kind !== "document") {
    invalid(`${path}.documentKind`, "only a document entity carries a document kind");
  }
  return {
    kind: oneOf(body.kind, CATALOG_KINDS, `${path}.kind`),
    id: text(body.id, `${path}.id`),
    title: text(body.title, `${path}.title`),
    description: optionalText(body.description, `${path}.description`),
    documentKind,
    lifecycle: oneOf(body.lifecycle, ["active", "archived", "superseded"], `${path}.lifecycle`),
    revision: positiveInteger(body.revision, `${path}.revision`),
  };
}

function catalogLink(value: unknown, path: string): RemoteCatalogLink {
  const body = record(value, path);
  const ordinal = body.ordinal === null ? null : nonNegativeInteger(body.ordinal, `${path}.ordinal`);
  return {
    fromKind: oneOf(body.fromKind, CATALOG_KINDS, `${path}.fromKind`),
    fromId: text(body.fromId, `${path}.fromId`),
    relation: oneOf(body.relation, CATALOG_RELATIONS, `${path}.relation`),
    toKind: oneOf(body.toKind, CATALOG_KINDS, `${path}.toKind`),
    toId: text(body.toId, `${path}.toId`),
    ordinal,
  };
}

/**
 * invariant: The MStar subject's allowlist. `fields` preserves exactly the contract's
 * domain fields - sourced from the issue module's vocabularies - and every
 * history element carries its existing business fields plus a stable event UUID,
 * never a SQLite row id or the implicit parent issue reference.
 */
const MSTAR_FIELD_KEYS = [
  "title", "kind", "severity", "disposition", "impact", "acceptance", "owner", "registeredAt", "closedAt",
  "closureNote", "createdAt", "updatedAt", "revision", "milestoneId",
] as const;

function mstarFields(value: unknown, path: string): Record<string, unknown> {
  const body = record(value, path);
  allowOnly(body, path, MSTAR_FIELD_KEYS);
  return {
    title: text(body.title, `${path}.title`),
    kind: oneOf(body.kind, ISSUE_KINDS, `${path}.kind`),
    severity: oneOf(body.severity, ISSUE_SEVERITIES, `${path}.severity`),
    disposition: oneOf(body.disposition, ISSUE_DISPOSITIONS, `${path}.disposition`),
    impact: text(body.impact, `${path}.impact`),
    acceptance: text(body.acceptance, `${path}.acceptance`),
    owner: nullableString(body.owner, `${path}.owner`),
    registeredAt: nullableInstant(body.registeredAt, `${path}.registeredAt`),
    closedAt: nullableInstant(body.closedAt, `${path}.closedAt`),
    closureNote: nullableString(body.closureNote, `${path}.closureNote`),
    createdAt: instant(body.createdAt, `${path}.createdAt`),
    updatedAt: instant(body.updatedAt, `${path}.updatedAt`),
    revision: positiveInteger(body.revision, `${path}.revision`),
    milestoneId: nullableString(body.milestoneId, `${path}.milestoneId`),
  };
}

const OCCURRENCE_KEYS = [
  "eventId", "occurrenceKey", "sourceKind", "sourceIdentity", "rootCauseKey", "acceptanceKey", "location",
  "observedBehavior", "evidence", "discoveredAt", "recordedAt", "imported",
] as const;

function occurrence(value: unknown, path: string): Record<string, unknown> {
  const body = record(value, path);
  allowOnly(body, path, OCCURRENCE_KEYS);
  return {
    eventId: eventId(body.eventId, `${path}.eventId`),
    occurrenceKey: text(body.occurrenceKey, `${path}.occurrenceKey`),
    sourceKind: text(body.sourceKind, `${path}.sourceKind`),
    sourceIdentity: text(body.sourceIdentity, `${path}.sourceIdentity`),
    rootCauseKey: text(body.rootCauseKey, `${path}.rootCauseKey`),
    acceptanceKey: text(body.acceptanceKey, `${path}.acceptanceKey`),
    location: text(body.location, `${path}.location`),
    observedBehavior: text(body.observedBehavior, `${path}.observedBehavior`),
    evidence: stringList(body.evidence, `${path}.evidence`),
    discoveredAt: nullableInstant(body.discoveredAt, `${path}.discoveredAt`),
    recordedAt: instant(body.recordedAt, `${path}.recordedAt`),
    // note: The domain's imported provenance is a business field of the history, not a private detail.
    imported: boolean(body.imported, `${path}.imported`),
  };
}

const TRANSITION_KEYS = [
  "eventId", "fromDisposition", "toDisposition", "actor", "occurredAt", "recordedAt", "reason", "evidence",
  "issueRevision", "imported",
] as const;

/**
 * invariant: The portable transition evidence is the closure document the domain
 * records - reason, scope, references, canonical issue and alignment reference.
 * Anything else (a token, a header, a raw provider error, a nested payload) is
 * refused before it can be persisted, and every member is validated rather than
 * carried through as unknown JSON.
 */
const TRANSITION_EVIDENCE_KEYS = ["reason", "scope", "references", "canonicalIssueId", "alignmentRef"] as const;

function transitionEvidence(value: unknown, path: string): Record<string, unknown> {
  const body = record(value, path);
  allowOnly(body, path, TRANSITION_EVIDENCE_KEYS);
  const evidence: Record<string, unknown> = {};
  for (const key of TRANSITION_EVIDENCE_KEYS) {
    if (!(key in body)) continue;
    evidence[key] =
      key === "references" ? stringList(body.references, `${path}.references`) : nullableString(body[key], `${path}.${key}`);
  }
  return evidence;
}

/**
 * invariant: An imported terminal transition carries the reviewed legacy register
 * row as its recorded evidence. Its portable form is that row's business identity
 * and closure labels, with camelCase names matching the snapshot vocabulary. A
 * credential, a raw error, a repository or checkout path, a detail/document
 * reference, free-form closure evidence, a supersession pointer or any other key
 * is excluded rather than persisted; the lossless row stays in the local
 * provenance record, which the snapshot does not replace.
 */
const IMPORTED_EVIDENCE_FIELDS = [
  ["legacyId", "id"],
  ["title", "title"],
  ["severity", "severity"],
  ["scope", "scope"],
  ["decision", "decision"],
  ["owner", "owner"],
  ["target", "target"],
  ["tracking", "tracking"],
  ["lifecycle", "lifecycle"],
  ["closedAt", "closed_at"],
  ["closureNote", "closure_note"],
  ["sourcePlan", "source_plan"],
  ["registeredAt", "registered_at"],
] as const;

function importedTransitionEvidence(value: unknown, path: string): Record<string, unknown> {
  const body = record(value, path);
  const evidence: Record<string, unknown> = {};
  for (const [portable, legacy] of IMPORTED_EVIDENCE_FIELDS) {
    // note: The portable document is accepted again, so an export of a stored snapshot round-trips.
    if (!(legacy in body) && !(portable in body)) continue;
    evidence[portable] = nullableString(legacy in body ? body[legacy] : body[portable], `${path}.${portable}`);
  }
  if (Object.keys(evidence).length === 0) {
    invalid(path, "must carry the imported record's business fields (legacy id, title, lifecycle, ...)");
  }
  return evidence;
}

function transition(value: unknown, path: string): Record<string, unknown> {
  const body = record(value, path);
  allowOnly(body, path, TRANSITION_KEYS);
  if (!("evidence" in body)) invalid(`${path}.evidence`, "must be present (the recorded transition evidence)");
  const imported = boolean(body.imported, `${path}.imported`);
  return {
    eventId: eventId(body.eventId, `${path}.eventId`),
    fromDisposition: oneOf(body.fromDisposition, ISSUE_DISPOSITIONS, `${path}.fromDisposition`),
    toDisposition: oneOf(body.toDisposition, ISSUE_DISPOSITIONS, `${path}.toDisposition`),
    actor: nullableString(body.actor, `${path}.actor`),
    occurredAt: nullableInstant(body.occurredAt, `${path}.occurredAt`),
    recordedAt: instant(body.recordedAt, `${path}.recordedAt`),
    reason: text(body.reason, `${path}.reason`),
    evidence: imported
      ? importedTransitionEvidence(body.evidence, `${path}.evidence`)
      : transitionEvidence(body.evidence, `${path}.evidence`),
    issueRevision: nonNegativeInteger(body.issueRevision, `${path}.issueRevision`),
    imported,
  };
}

const RELATION_KEYS = ["relation", "target"] as const;

function relation(value: unknown, path: string): Record<string, unknown> {
  const body = record(value, path);
  allowOnly(body, path, RELATION_KEYS);
  return {
    relation: oneOf(body.relation, ISSUE_RELATIONS, `${path}.relation`),
    // note: A dangling target stays as the spellable reference; the read boundary renders it unresolved.
    target: assertIssueRef(text(body.target, `${path}.target`)),
  };
}

const PROVENANCE_KEYS = [
  "eventId", "kind", "target", "sourceHash", "origin", "legacyProject", "legacyBucket", "legacyEntryId",
  "legacyJson", "importedAt",
] as const;

function provenanceLink(value: unknown, path: string): Record<string, unknown> {
  const body = record(value, path);
  allowOnly(body, path, PROVENANCE_KEYS);
  return {
    eventId: eventId(body.eventId, `${path}.eventId`),
    kind: oneOf(body.kind, ISSUE_PROVENANCE_KINDS, `${path}.kind`),
    target: text(body.target, `${path}.target`),
    sourceHash: text(body.sourceHash, `${path}.sourceHash`),
    origin: oneOf(body.origin, ["scoped", "unscoped"] as const, `${path}.origin`),
    legacyProject: nullableString(body.legacyProject, `${path}.legacyProject`),
    legacyBucket: nullableString(body.legacyBucket, `${path}.legacyBucket`),
    legacyEntryId: nullableString(body.legacyEntryId, `${path}.legacyEntryId`),
    legacyJson: nullableString(body.legacyJson, `${path}.legacyJson`),
    importedAt: nullableInstant(body.importedAt, `${path}.importedAt`),
  };
}

const PROJECT_MOVE_KEYS = ["eventId", "fromProject", "toProject", "actor", "reason", "occurredAt", "issueRevision"] as const;

function projectMove(value: unknown, path: string): Record<string, unknown> {
  const body = record(value, path);
  allowOnly(body, path, PROJECT_MOVE_KEYS);
  return {
    eventId: eventId(body.eventId, `${path}.eventId`),
    fromProject: text(body.fromProject, `${path}.fromProject`),
    toProject: text(body.toProject, `${path}.toProject`),
    actor: text(body.actor, `${path}.actor`),
    reason: text(body.reason, `${path}.reason`),
    occurredAt: instant(body.occurredAt, `${path}.occurredAt`),
    issueRevision: nonNegativeInteger(body.issueRevision, `${path}.issueRevision`),
  };
}

/** note: Each complete subject carries all eight members; a partial coverage is a stream gap, not missing history. */
function mstarIssue(value: unknown, path: string): RemoteMstarIssue {
  const body = record(value, path);
  return {
    issueRef: assertIssueRef(text(body.issueRef, `${path}.issueRef`)),
    head: digestHead(body.head, `${path}.head`),
    fields: mstarFields(body.fields, `${path}.fields`),
    occurrences: list(body.occurrences, `${path}.occurrences`).map((entry, index) =>
      occurrence(entry, `${path}.occurrences[${index}]`),
    ),
    transitions: list(body.transitions, `${path}.transitions`).map((entry, index) =>
      transition(entry, `${path}.transitions[${index}]`),
    ),
    relations: list(body.relations, `${path}.relations`).map((entry, index) =>
      relation(entry, `${path}.relations[${index}]`),
    ),
    provenance: list(body.provenance, `${path}.provenance`).map((entry, index) =>
      provenanceLink(entry, `${path}.provenance[${index}]`),
    ),
    projectMoves: list(body.projectMoves, `${path}.projectMoves`).map((entry, index) =>
      projectMove(entry, `${path}.projectMoves[${index}]`),
    ),
  };
}

function remoteIssue(value: unknown, path: string): RemoteIssue {
  const body = record(value, path);
  return {
    identity: issueIdentity(body.identity, `${path}.identity`),
    nativeTitle: text(body.nativeTitle, `${path}.nativeTitle`),
    nativeStatus: text(body.nativeStatus, `${path}.nativeStatus`),
    providerUpdatedAt: instant(body.providerUpdatedAt, `${path}.providerUpdatedAt`),
    mstar: body.mstar === null ? null : mstarIssue(body.mstar, `${path}.mstar`),
  };
}

function coverage(value: unknown, path: string): SnapshotCoverage {
  const body = record(value, path);
  if (body.kind === "complete") return { kind: "complete" };
  if (body.kind !== "partial") invalid(`${path}.kind`, "must be 'complete' or 'partial'");
  return {
    kind: "partial",
    stream: oneOf(body.stream, ["issues", "comments", "journal"], `${path}.stream`),
    nextCursor: optionalText(body.nextCursor, `${path}.nextCursor`),
    code: text(body.code, `${path}.code`),
  };
}

/**
 * invariant: One project's normalized snapshot, proven to describe exactly the bound
 * provider project (never foreign tenant content) and internally consistent:
 * unique milestone ids, catalog keys and issue identities, a unique portable
 * reference per MStar issue, and a sorted content head.
 */
function snapshot(value: unknown, check: ScopeCheck): RemoteSnapshot {
  const body = record(value, "submission.snapshot");
  const asOf = instant(body.asOf, "submission.snapshot.asOf");
  if (Date.parse(asOf) > Date.parse(check.checkedAt)) {
    invalid("submission.snapshot.asOf", "cannot be later than the check that verified it");
  }
  const project = record(body.project, "submission.snapshot.project");
  const projectId = text(project.projectId, "submission.snapshot.project.projectId");
  if (projectId !== check.projectId) {
    throw new StoreError(
      "remote.scope-mismatch",
      `The snapshot describes project ${projectId}, but this submission addresses ${check.projectId}. Nothing was written.`,
    );
  }
  const binding = projectScope(project.binding, "submission.snapshot.project.binding");
  if (!sameScope(binding, check.scope)) {
    throw new StoreError(
      "remote.scope-mismatch",
      `The snapshot's provider project does not equal the verified scope for ${check.projectId}; foreign tenant content is ` +
        `never cached. Nothing was written.`,
    );
  }
  const milestones = list(project.milestones, "submission.snapshot.project.milestones").map((entry, index) =>
    milestone(entry, `submission.snapshot.project.milestones[${index}]`),
  );
  if (new Set(milestones.map((entry) => entry.milestoneId)).size !== milestones.length) {
    invalid("submission.snapshot.project.milestones", "must not repeat a milestone id");
  }
  const catalogEntities = list(project.catalogEntities, "submission.snapshot.project.catalogEntities").map(
    (entry, index) => catalogEntity(entry, `submission.snapshot.project.catalogEntities[${index}]`),
  );
  if (new Set(catalogEntities.map((entry) => `${entry.kind}:${entry.id}`)).size !== catalogEntities.length) {
    invalid("submission.snapshot.project.catalogEntities", "must not repeat a (kind, id) pair");
  }
  const catalogLinks = list(project.catalogLinks, "submission.snapshot.project.catalogLinks").map((entry, index) =>
    catalogLink(entry, `submission.snapshot.project.catalogLinks[${index}]`),
  );
  const issues = list(body.issues, "submission.snapshot.issues").map((entry, index) =>
    remoteIssue(entry, `submission.snapshot.issues[${index}]`),
  );
  const providers = new Set<string>();
  const references = new Set<string>();
  for (const issue of issues) {
    if (!sameScope(issue.identity, check.scope)) {
      throw new StoreError(
        "remote.scope-mismatch",
        `Issue ${issue.identity.issueId} belongs to another workspace, team or project than ${check.projectId}; a snapshot ` +
          `never carries foreign scope. Nothing was written.`,
      );
    }
    if (providers.has(issue.identity.issueId)) {
      invalid("submission.snapshot.issues", `repeats provider issue ${issue.identity.issueId}`);
    }
    providers.add(issue.identity.issueId);
    if (issue.mstar === null) continue;
    if (references.has(issue.mstar.issueRef)) {
      invalid("submission.snapshot.issues", `two issues carry the same IssueRef ${issue.mstar.issueRef}`);
    }
    references.add(issue.mstar.issueRef);
  }
  return {
    asOf,
    coverage: coverage(body.coverage, "submission.snapshot.coverage"),
    project: {
      projectId,
      // note: `null` is the verified empty project journal, never an absent traversal.
      head: project.head === null ? null : digestHead(project.head, "submission.snapshot.project.head"),
      binding,
      milestones,
      roadmap: roadmap(project.roadmap, "submission.snapshot.project.roadmap"),
      catalogEntities,
      catalogLinks,
    },
    issues,
  };
}

function observationSubmission(value: unknown): ObservationSubmission {
  const body = record(value, "submission");
  if (body.version !== 1) invalid("submission.version", "must be 1");
  const selectorCommit = text(body.selectorCommit, "submission.selectorCommit");
  if (!GIT_OBJECT_ID.test(selectorCommit)) invalid("submission.selectorCommit", "must be a Git object id");
  const check = scopeCheck(body.check, "submission.check");
  return {
    version: 1,
    selectorCommit,
    generation: positiveInteger(body.generation, "submission.generation"),
    check,
    expectRevision: nonNegativeInteger(body.expectRevision, "submission.expectRevision"),
    snapshot: body.snapshot === null ? null : snapshot(body.snapshot, check),
  };
}

// ---------------------------------------------------------------------------
// note: Scope proof - the checked selector is the only selection authority.
// ---------------------------------------------------------------------------

function remoteSelection(location: CollaborationLocation): CollaborationSelection {
  if (location.mode !== "remote" || location.selection === undefined) {
    throw new StoreError(
      "collaboration.stale-binding",
      `This checkout resolves ${location.mode} collaboration, not a checked remote selector, so there is no provider ` +
        `scope to bind or observe. Nothing was changed.`,
    );
  }
  return location.selection;
}

function selectedProject(selection: CollaborationSelection, projectId: string): CollaborationSelectorProject {
  const selected = selection.projects.find((project) => project.localProjectId === projectId);
  if (selected === undefined) {
    throw new StoreError(
      "remote.scope-mismatch",
      `Project ${projectId} is not selected by the checked selector generation ${String(selection.generation)}. ` +
        `Nothing was written.`,
    );
  }
  return selected;
}

/** note: A check must address exactly the selected provider project, journal anchor and writer. */
function assertCheckAddresses(check: ScopeCheck, selected: CollaborationSelectorProject): void {
  const mismatch =
    check.projectId !== selected.localProjectId ||
    check.journalIssueId !== selected.journalIssueId ||
    check.scope.workspaceId !== selected.workspaceId ||
    check.scope.teamId !== selected.teamId ||
    check.scope.projectId !== selected.projectId;
  if (mismatch) {
    throw new StoreError(
      "remote.scope-mismatch",
      `The check for ${check.projectId} does not address the selected provider project for ` +
        `${selected.localProjectId}. Nothing was written.`,
    );
  }
  if (check.outcome.kind === "verified" && check.outcome.writerId !== null && check.outcome.writerId !== selected.writerId) {
    throw new StoreError(
      "remote.scope-mismatch",
      `The verified writer for ${check.projectId} is not the writer the checked selector names. Nothing was written.`,
    );
  }
}

/**
 * invariant: A bind admits only a check the host just made: never dated in the future and
 * never older than the 60-second TTL. An expired positive check can bootstrap
 * no authority, exactly like an observation.
 */
function assertCheckCurrent(check: ScopeCheck, now: number): void {
  const checkedAt = Date.parse(check.checkedAt);
  if (checkedAt > now || now - checkedAt > SCOPE_CHECK_TTL_MS) {
    throw new StoreError(
      "collaboration.observation-stale",
      `The check for ${check.projectId} at ${check.checkedAt} is not current: a positive access check must be dated ` +
        `within ${String(SCOPE_CHECK_TTL_MS / 1000)} seconds of this process and never in the future. Reverify with the ` +
        `host; nothing was written.`,
    );
  }
}

function negativeRefusal(outcome: ScopeOutcome): StoreError {
  const kind = outcome.kind === "verified" ? "unavailable" : outcome.kind;
  return new StoreError(
    NEGATIVE_OUTCOME_CODES[kind],
    `The host's access check for this project is ${kind}. Nothing was authorized.`,
  );
}

// ---------------------------------------------------------------------------
// note: readRemoteStatus
// ---------------------------------------------------------------------------

export type RemoteProjectStatus = Readonly<{
  projectId: string;
  scope: ProviderProjectScope;
  journalIssueId: string;
  writerId: string | null;
  verifiedAt: string;
  outcome: string;
  revision: number;
  completeness: "complete" | "partial" | "unavailable";
  asOf: string | null;
  code: string | null;
  freshness: "fresh" | "expired" | "incomplete";
}>;

export type RemoteStatus = Readonly<{
  version: 1;
  selector: Readonly<{ commit: string; generation: number; phase: "active" | "draining" }>;
  binding: Readonly<{
    state: "bound" | "unbound";
    selectorCommit: string | null;
    generation: number | null;
    storeId: string | null;
    epoch: number | null;
  }>;
  available: boolean;
  code: string | null;
  projects: readonly RemoteProjectStatus[];
}>;

type StoredBindingRow = {
  project_key: string;
  selector_commit: string;
  workspace_id: string;
  team_id: string;
  provider_project_id: string;
  journal_issue_id: string;
  writer_id: string | null;
  verified_at: string;
  verification_json: string;
};

type StoredObservationRow = {
  project_key: string;
  revision: number;
  as_of: string | null;
  completeness: "complete" | "partial" | "unavailable";
  code: string | null;
};

function bindingRows(db: StoreDb, generation: number): StoredBindingRow[] {
  return db
    .prepare(
      "select project_key, selector_commit, workspace_id, team_id, provider_project_id, journal_issue_id, writer_id, " +
        "verified_at, verification_json from remote_bindings where generation = ? order by project_key",
    )
    .all(generation)
    .filter((row): row is StoredBindingRow => row !== null && typeof row === "object" && "project_key" in row && typeof row.project_key === "string");
}

function observationRows(db: StoreDb, generation: number): StoredObservationRow[] {
  return db
    .prepare(
      "select project_key, revision, as_of, completeness, code from remote_observations where generation = ? order by project_key",
    )
    .all(generation)
    .filter(
      (row): row is StoredObservationRow =>
        row !== null && typeof row === "object" && "project_key" in row && typeof row.project_key === "string",
    );
}

/** note: The recorded outcome label of a binding's latest check, for status only. */
function outcomeLabel(verificationJson: string): string {
  try {
    const parsed: unknown = JSON.parse(verificationJson);
    if (isRecord(parsed) && isRecord(parsed.outcome) && typeof parsed.outcome.kind === "string") return parsed.outcome.kind;
  } catch {
    // note: A damaged verification document is reported as unavailable evidence, never guessed.
  }
  return "unavailable";
}

/**
 * `remote status`: the current selector/phase, this checkout's binding state, and
 * each bound project's latest revision, completeness, `asOf` and access verdict.
 * It creates and changes nothing and surfaces no provider content.
 */
export async function readRemoteStatus(context: StoreContext, projectId?: string): Promise<RemoteStatus> {
  const location = resolveCollaborationLocation(context);
  const selection = remoteSelection(location);
  if (projectId !== undefined) selectedProject(selection, projectId);
  const recorded = readCollaborationBinding(context);
  const binding =
    recorded !== null && recorded.version === 3 && recorded.repoKey === location.repoKey
      ? {
          state: "bound" as const,
          selectorCommit: recorded.selectorCommit,
          generation: recorded.generation,
          storeId: recorded.storeId,
          epoch: recorded.epoch,
        }
      : {
          state: "unbound" as const,
          selectorCommit: null,
          generation: null,
          storeId: null,
          epoch: null,
        };
  const status = (available: boolean, code: string | null, projects: readonly RemoteProjectStatus[]): RemoteStatus => ({
    version: 1,
    selector: { commit: selection.commit, generation: selection.generation, phase: selection.phase },
    binding,
    available,
    code,
    projects: projectId === undefined ? projects : projects.filter((entry) => entry.projectId === projectId),
  });
  // invariant: An unbound, missing or interrupted lane is reported, never created here.
  if (binding.state !== "bound") return status(false, "collaboration.stale-binding", []);
  let handle: CollaborationStoreHandle;
  try {
    handle = await openRemoteCache(context, "read");
  } catch (error) {
    if (
      error instanceof StoreError &&
      (error.code === "collaboration.not-initialized" || error.code === "collaboration.not-active")
    ) {
      return status(false, error.code, []);
    }
    throw error;
  }
  try {
    const rows = bindingRows(handle.db, binding.generation);
    const observations = new Map(observationRows(handle.db, binding.generation).map((row) => [row.project_key, row]));
    const now = Date.now();
    const projects = rows.map((row): RemoteProjectStatus => {
      const observation = observations.get(row.project_key);
      const complete = observation?.completeness === "complete";
      const outcome = outcomeLabel(row.verification_json);
      // invariant: Serving needs a current positive access check AND a complete snapshot. The
      // freshness clock starts at the latest check, so a revocation or a refused check can
      // never be reported fresh off the binding's original bind time.
      const current = outcome === "verified" && Math.abs(now - Date.parse(row.verified_at)) <= SCOPE_CHECK_TTL_MS;
      return {
        projectId: row.project_key,
        scope: {
          provider: "linear",
          workspaceId: row.workspace_id,
          teamId: row.team_id,
          projectId: row.provider_project_id,
        },
        journalIssueId: row.journal_issue_id,
        writerId: row.writer_id,
        verifiedAt: row.verified_at,
        outcome,
        revision: observation?.revision ?? 0,
        completeness: observation?.completeness ?? "unavailable",
        asOf: observation?.as_of ?? null,
        code: observation?.code ?? null,
        freshness: current && complete ? "fresh" : complete ? "expired" : "incomplete",
      };
    });
    if (projectId !== undefined && !projects.some((entry) => entry.projectId === projectId)) {
      throw new StoreError(
        "remote.scope-mismatch",
        `Project ${projectId} has no binding in the cache reached by this checkout. Run the reviewed remote bind; nothing was changed.`,
      );
    }
    const unavailable = projects.find((entry) => entry.freshness !== "fresh");
    return status(
      projects.length > 0 && unavailable === undefined,
      projects.length === 0
        ? "remote.unavailable"
        : unavailable === undefined
          ? null
          : unavailable.code ??
            (unavailable.freshness === "expired"
              ? "collaboration.observation-stale"
              : "collaboration.observation-incomplete"),
      projects,
    );
  } finally {
    handle.close();
  }
}

// ---------------------------------------------------------------------------
// note: bindRemoteAuthority
// ---------------------------------------------------------------------------

export type RemoteAvailability = Readonly<{
  projectId: string;
  revision: number;
  completeness: "complete" | "partial" | "unavailable";
  code: string | null;
}>;

export type RemoteBindResult = Readonly<{
  version: 1;
  selectorCommit: string;
  generation: number;
  replayed: boolean;
  binding: CollaborationBinding;
  availability: readonly RemoteAvailability[];
}>;

function availabilityOf(db: StoreDb, generation: number, projects: readonly string[]): readonly RemoteAvailability[] {
  const observations = new Map(observationRows(db, generation).map((row) => [row.project_key, row]));
  return projects.map((projectId) => {
    const observation = observations.get(projectId);
    return {
      projectId,
      revision: observation?.revision ?? 0,
      completeness: observation?.completeness ?? ("unavailable" as const),
      code: observation?.code ?? null,
    };
  });
}

/** note: A staged fresh lane must still be empty evidence before a bind publishes it. */
function assertFreshLane(authority: CollaborationAuthority, db: StoreDb): void {
  if (authority.state === "active") return;
  const row = db
    .prepare("select revision, catalog_revision from collaboration_meta where id = 1")
    .get();
  const revision = isRecord(row) ? row.revision : 0;
  const catalogRevision = isRecord(row) ? row.catalog_revision : 0;
  const receipts = db.prepare("select count(*) as n from collaboration_operations").get();
  const publications = db.prepare("select count(*) as n from cutover_publications").get();
  const before =
    (typeof revision === "number" ? revision : -1) +
    (typeof catalogRevision === "number" ? catalogRevision : -1) +
    (isRecord(receipts) && typeof receipts.n === "number" ? receipts.n : -1) +
    (isRecord(publications) && typeof publications.n === "number" ? publications.n : -1);
  if (before !== 0) {
    throw new StoreError(
      "collaboration.not-active",
      "The remote cache lane is staged and holds recorded evidence, so it belongs to an interrupted reviewed bind. " +
        "Rerun the same bind with its identical input; nothing was written.",
    );
  }
}

/** note: Publish a fresh staged cache lane inside the caller's transaction. */
function publishStagedLane(db: StoreDb, authority: CollaborationAuthority, selection: CollaborationSelection): void {
  if (authority.state === "active") return;
  const at = nowRfc3339();
  const flipped = db
    .prepare(
      "update collaboration_meta set authority_state = 'active', activated_at = ? " +
        "where id = 1 and authority_state = 'staged' and store_id = ? and authority_epoch = ? and revision = 0 and catalog_revision = 0",
    )
    .run(at, authority.storeId, authority.epoch);
  if (isRecord(flipped) && typeof flipped.changes === "number" && flipped.changes !== 1) {
    throw new StoreError(
      "collaboration.not-active",
      "The staged remote cache lane changed while the bind was publishing it; rerun the same bind. Nothing was written.",
    );
  }
  db.prepare(
    "insert into collaboration_operations(key_space, operation_id, request_hash, result_json, committed_at) " +
      "values ('standalone', ?, ?, ?, ?)",
  ).run(
    `remote-bind:${authority.storeId}:${String(authority.epoch)}`,
    selection.commit,
    JSON.stringify({
      version: 1,
      producer: "remote-bind",
      storeId: authority.storeId,
      epoch: authority.epoch,
      selectorCommit: selection.commit,
      generation: selection.generation,
      createdAt: at,
    }),
    at,
  );
}

/**
 * `remote bind`: verify every selected project and create (or advance) this
 * checkout's private cache lane.
 *
 * The batch must name the checked commit and generation, carry exactly one
 * positive check per selected project and no others, and each check must
 * address that project's exact provider tuple and writer. A lane that already
 * records a generation may only advance through the reviewed lineage: the
 * selector's `previous` must name the recorded generation and commit, and the
 * transition must be fenced with no pending operations. The cache transaction
 * commits BEFORE the v3 checkout binding is published, and replaying the same
 * batch after a crash completes that publication.
 */
export async function bindRemoteAuthority(context: StoreContext, input: unknown): Promise<RemoteBindResult> {
  const batch = verificationBatch(input);
  const location = resolveCollaborationLocation(context);
  const selection = remoteSelection(location);
  if (batch.selectorCommit !== selection.commit || batch.generation !== selection.generation) {
    throw new StoreError(
      "collaboration.stale-binding",
      `The bind names selector commit ${batch.selectorCommit} generation ${String(batch.generation)}, but the checked ` +
        `selector is ${selection.commit} generation ${String(selection.generation)}. Nothing was changed.`,
    );
  }
  if (selection.phase !== "active") {
    // invariant: A draining generation is the predecessor a reviewed transition reconciles, not
    // the target a cache boots from.
    throw new StoreError(
      "collaboration.stale-binding",
      `The checked selector generation ${String(selection.generation)} is ${selection.phase}; only an active selector ` +
        `bootstraps this checkout's remote cache. Reconcile the transition first; nothing was changed.`,
    );
  }

  // note: Exactly one positive, current check per selected project, and no check for a
  // project the selector does not select.
  const checks = new Map<string, ScopeCheck>();
  const now = Date.now();
  for (const check of batch.checks) {
    const selected = selectedProject(selection, check.projectId);
    if (checks.has(check.projectId)) {
      throw new StoreError(
        "remote.scope-mismatch",
        `The bind carries more than one check for ${check.projectId}; exactly one is required. Nothing was changed.`,
      );
    }
    assertCheckAddresses(check, selected);
    if (check.outcome.kind !== "verified") throw negativeRefusal(check.outcome);
    assertCheckCurrent(check, now);
    checks.set(check.projectId, check);
  }
  for (const selected of selection.projects) {
    if (!checks.has(selected.localProjectId)) {
      throw new StoreError(
        "remote.scope-mismatch",
        `The bind carries no check for the selected project ${selected.localProjectId}; every selected project must be ` +
          `verified. Nothing was changed.`,
      );
    }
  }

  const recorded = readCollaborationBinding(context);
  if (recorded !== null && recorded.repoKey !== location.repoKey) {
    throw new StoreError(
      "collaboration.stale-binding",
      `This checkout is bound to repository ${recorded.repoKey}, not the resolved ${location.repoKey}; a bind never ` +
        `overwrites a foreign checkout's binding. Nothing was changed.`,
    );
  }
  if (recorded !== null && recorded.version === 3 && recorded.generation > batch.generation) {
    throw new StoreError(
      "collaboration.stale-binding",
      `This checkout already recorded remote generation ${String(recorded.generation)}, and the checked selector is the ` +
        `older generation ${String(batch.generation)}; a bind never downgrades a generation. Nothing was changed.`,
    );
  }
  if (recorded !== null && recorded.version === 2) {
    throw new StoreError(
      "collaboration.stale-binding",
      `This checkout holds a ${recorded.mode} binding for ${recorded.repoKey}; switching a lane to remote is the ` +
        `reviewed transition that publishes this selector, not a bind of an existing local authority. Nothing was changed.`,
    );
  }

  // invariant: A rebind continues the cache this checkout is bound to. A lane that is
  // present under another store id or epoch is a replacement and is refused; only a
  // vanished cache (Data Model: bind initializes a missing lane) may adopt a new identity.
  const cachePresent = existsSync(location.dbPath);
  const staged = await initializeRemoteCacheStore(location);
  if (cachePresent && recorded !== null && recorded.version === 3) assertRemoteCacheIdentity(staged, recorded);
  const outcome = await writeRemoteCacheStage(location, ({ db, authority }) => {
    assertFreshLane(authority, db);
    const latest = db
      .prepare("select generation, selector_commit from remote_bindings order by generation desc limit 1")
      .get();
    const recordedGeneration = isRecord(latest) && typeof latest.generation === "number" ? latest.generation : null;
    const recordedCommit = isRecord(latest) && typeof latest.selector_commit === "string" ? latest.selector_commit : null;
    if (recordedGeneration !== null && recordedGeneration > batch.generation) {
      throw new StoreError(
        "collaboration.stale-binding",
        `The cache lane already records generation ${String(recordedGeneration)}; the checked selector is the older ` +
          `generation ${String(batch.generation)}. Nothing was written.`,
      );
    }
    if (recordedGeneration !== null && recordedGeneration < batch.generation) {
      // invariant: A successor generation is admitted only through the reviewed lineage: the
      // selector names the predecessor it supersedes and its fenced transition.
      const previous = selection.previous;
      const fenced = selection.cutover;
      if (
        previous === null ||
        previous.generation !== recordedGeneration ||
        previous.selectorCommit !== recordedCommit ||
        fenced === null ||
        !fenced.sourceFenced ||
        fenced.pendingOperationIds.length > 0
      ) {
        throw new StoreError(
          "collaboration.stale-binding",
          `The cache lane records generation ${String(recordedGeneration)} (${String(recordedCommit)}), but the checked ` +
            `selector generation ${String(batch.generation)} does not name that predecessor with a fenced, pending-free ` +
            `cutover. The predecessor is unfenced; nothing was written.`,
        );
      }
    }
    publishStagedLane(db, authority, selection);
    const upsert = db.prepare(
      "insert into remote_bindings(generation, project_key, selector_commit, provider, workspace_id, team_id, " +
        "provider_project_id, journal_issue_id, writer_id, verified_at, verification_json) " +
        "values (?, ?, ?, 'linear', ?, ?, ?, ?, ?, ?, ?) " +
        "on conflict(generation, project_key) do update set selector_commit = excluded.selector_commit, " +
        "writer_id = excluded.writer_id, verified_at = excluded.verified_at, verification_json = excluded.verification_json " +
        "where remote_bindings.selector_commit = excluded.selector_commit",
    );
    const observation = db.prepare(
      "insert or ignore into remote_observations(generation, project_key, revision, as_of, completeness, code, snapshot_json, received_at) " +
        "values (?, ?, 0, null, 'unavailable', null, null, ?)",
    );
    const at = nowRfc3339();
    for (const check of checks.values()) {
      const selected = selectedProject(selection, check.projectId);
      if (check.outcome.kind !== "verified") throw negativeRefusal(check.outcome);
      // invariant: A verification never moves a binding's evidence backwards, and a tie only
      // replays the identical check; a conflicting tie cannot replace the recorded one.
      const previous = db
        .prepare("select verified_at, verification_json from remote_bindings where generation = ? and project_key = ?")
        .get(batch.generation, selected.localProjectId);
      if (isRecord(previous)) assertCheckAdvances(selected.localProjectId, check, previous);
      upsert.run(
        batch.generation,
        selected.localProjectId,
        batch.selectorCommit,
        selected.workspaceId,
        selected.teamId,
        selected.projectId,
        selected.journalIssueId,
        check.outcome.writerId,
        check.checkedAt,
        JSON.stringify(serializeCheck(check)),
      );
      const existing = db
        .prepare(
          "select selector_commit, workspace_id, team_id, provider_project_id from remote_bindings where generation = ? and project_key = ?",
        )
        .get(batch.generation, selected.localProjectId);
      if (
        !isRecord(existing) ||
        existing.selector_commit !== batch.selectorCommit ||
        existing.workspace_id !== selected.workspaceId ||
        existing.team_id !== selected.teamId ||
        existing.provider_project_id !== selected.projectId
      ) {
        throw new StoreError(
          "collaboration.stale-binding",
          `The recorded binding for ${selected.localProjectId} disagrees with the checked selector; the lane is never ` +
            `re-keyed in place. Nothing was written.`,
        );
      }
      observation.run(batch.generation, selected.localProjectId, at);
    }
    return {
      replayed: recordedGeneration === batch.generation,
      availability: availabilityOf(db, batch.generation, [...checks.keys()]),
    };
  });

  const binding = writeRemoteCollaborationBinding(context, {
    repoKey: location.repoKey,
    selectorCommit: batch.selectorCommit,
    generation: batch.generation,
    storeId: staged.storeId,
    epoch: staged.epoch,
  });
  return {
    version: 1,
    selectorCommit: batch.selectorCommit,
    generation: batch.generation,
    replayed: outcome.replayed,
    binding,
    availability: outcome.availability,
  };
}

/**
 * invariant: A check never rewrites a binding's evidence at an older host time, and
 * a conflicting tie cannot replace the recorded one. Two asymmetric ties are
 * admitted: a byte-identical replay, and an addressed negative check tied with a
 * recorded positive - a revocation invalidates serving even in the same
 * millisecond. The reverse never holds: a tied positive cannot reverse a recorded
 * negative and restore the binding.
 */
function assertCheckAdvances(projectId: string, check: ScopeCheck, recorded: Record<string, unknown>): void {
  if (typeof recorded.verified_at !== "string") return;
  const prior = Date.parse(recorded.verified_at);
  const current = Date.parse(check.checkedAt);
  if (current > prior) return;
  if (current === prior) {
    if (recorded.verification_json === JSON.stringify(serializeCheck(check))) return;
    if (check.outcome.kind !== "verified" && recordedOutcome(recorded) === "verified") return;
  }
  throw new StoreError(
    "collaboration.observation-stale",
    `The check for ${projectId} is dated ${check.checkedAt}, which does not advance the binding's recorded ` +
      `verification (${recorded.verified_at}); only a later check, an identical replay, or a revocation at the ` +
      `same instant is accepted. Nothing was written.`,
  );
}

/** note: The recorded check's outcome kind; an unreadable document reads as no outcome. */
function recordedOutcome(recorded: Record<string, unknown>): string | null {
  const json = recorded.verification_json;
  if (typeof json !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) && isRecord(parsed.outcome) && typeof parsed.outcome.kind === "string"
      ? parsed.outcome.kind
      : null;
  } catch {
    return null;
  }
}

/** note: The persisted verification document: the allowlisted check, never the raw input. */
function serializeCheck(check: ScopeCheck): ScopeCheck {
  return {
    projectId: check.projectId,
    scope: { ...check.scope },
    journalIssueId: check.journalIssueId,
    checkedAt: check.checkedAt,
    outcome:
      check.outcome.kind === "verified"
        ? {
            kind: "verified",
            readerId: check.outcome.readerId,
            writerId: check.outcome.writerId,
            capabilities: { ...check.outcome.capabilities },
          }
        : { kind: check.outcome.kind },
  };
}

// ---------------------------------------------------------------------------
// note: ingestRemoteObservation
// ---------------------------------------------------------------------------

export type RemoteObservationResult = Readonly<{
  version: 1;
  projectId: string;
  generation: number;
  revision: number;
  completeness: "complete" | "partial";
  asOf: string;
  code: string | null;
}>;

/**
 * `remote observe`: accept one verification/observation submission.
 *
 * A negative access check records the invalidation, clears the active
 * projection and is then returned as its named refusal. A positive check
 * requires the whole project snapshot (never a diff: the cache replaces the
 * project atomically) and commits at `expectRevision`; a stale base refuses
 * `collaboration.observation-stale` and a known gap is stored as `partial`.
 * This never creates or adopts an issue, never confirms an intent and never
 * writes a local-authority table.
 */
export async function ingestRemoteObservation(
  context: StoreContext,
  input: unknown,
): Promise<RemoteObservationResult> {
  const submission = observationSubmission(input);
  const location = resolveCollaborationLocation(context);
  const selection = remoteSelection(location);
  const binding = readCollaborationBinding(context);
  if (
    binding === null ||
    binding.version !== 3 ||
    binding.state !== "active" ||
    binding.selectorCommit !== submission.selectorCommit ||
    binding.generation !== submission.generation
  ) {
    throw new StoreError(
      "collaboration.stale-binding",
      `The submission names selector commit ${submission.selectorCommit} generation ${String(submission.generation)}, which ` +
        `is not this checkout's finalized remote binding. Run the reviewed remote bind first; nothing was written.`,
    );
  }
  const selected = selectedProject(selection, submission.check.projectId);
  assertCheckAddresses(submission.check, selected);
  const checkedAt = Date.parse(submission.check.checkedAt);
  const now = Date.now();
  if (checkedAt > now) {
    throw new StoreError(
      "collaboration.observation-stale",
      `The check for ${submission.check.projectId} is dated in the future (${submission.check.checkedAt}); a host time is ` +
        `never accepted ahead of this process. Nothing was written.`,
    );
  }
  const negative = submission.check.outcome.kind === "verified" ? null : negativeRefusal(submission.check.outcome);
  if (negative === null && submission.snapshot === null) {
    throw new StoreError(
      "collaboration.observation-incomplete",
      `A verified check for ${submission.check.projectId} must carry its complete project snapshot; a missing snapshot is ` +
        `never recorded as a current result. Nothing was written.`,
    );
  }
  if (negative === null && now - checkedAt > SCOPE_CHECK_TTL_MS) {
    throw new StoreError(
      "collaboration.observation-stale",
      `The verified check for ${submission.check.projectId} is older than ${String(SCOPE_CHECK_TTL_MS / 1000)} seconds, so ` +
        `it cannot serve a current observation. Reverify with the host and resubmit; nothing was written.`,
    );
  }

  const outcome = await withRemoteCacheWrite(context, ({ db }) =>
    recordObservation(db, submission, negative),
  );

  // invariant: The invalidation is durable BEFORE its refusal is reported: a caller that saw
  // the error still finds the cache marked unavailable.
  if ("refused" in outcome) throw outcome.refused;
  return outcome.recorded;
}

/** note: One submission's whole cache transaction, run under the writer's guarded connection. */
function recordObservation(
  db: StoreDb,
  submission: ObservationSubmission,
  negative: StoreError | null,
): { recorded: RemoteObservationResult } | { refused: StoreError } {
  const stored = db
    .prepare(
      "select verified_at, verification_json, selector_commit from remote_bindings where generation = ? and project_key = ?",
    )
    .get(submission.generation, submission.check.projectId);
  if (!isRecord(stored)) {
    throw new StoreError(
      "remote.scope-mismatch",
      `Project ${submission.check.projectId} is not bound at generation ${String(submission.generation)} in this cache; ` +
        `run the reviewed remote bind first. Nothing was written.`,
    );
  }
  if (stored.selector_commit !== submission.selectorCommit) {
    throw new StoreError(
      "collaboration.stale-binding",
      `The cache binds ${submission.check.projectId} to another selector commit than the submission names. Nothing was written.`,
    );
  }
  assertCheckAdvances(submission.check.projectId, submission.check, stored);
  const current = db
    .prepare("select revision from remote_observations where generation = ? and project_key = ?")
    .get(submission.generation, submission.check.projectId);
  const revision = isRecord(current) && typeof current.revision === "number" ? current.revision : undefined;
  if (revision === undefined) {
    throw new StoreError(
      "collaboration.unreadable",
      `The cache holds no observation row for ${submission.check.projectId}; rerun the reviewed remote bind. Nothing was written.`,
    );
  }
  const next = revision + 1;
  const at = nowRfc3339();
  // invariant: The check itself becomes the binding's latest evidence before either branch,
  // so status, freshness and ordering all read the verification a reader can see. A
  // negative check carries no writer: it proves no authorized sender exists.
  db.prepare(
    "update remote_bindings set verified_at = ?, verification_json = ?, writer_id = ? " +
      "where generation = ? and project_key = ?",
  ).run(
    submission.check.checkedAt,
    JSON.stringify(serializeCheck(submission.check)),
    submission.check.outcome.kind === "verified" ? submission.check.outcome.writerId : null,
    submission.generation,
    submission.check.projectId,
  );
  if (negative !== null) {
    // invariant: A revocation invalidates serving as soon as it is submitted. It never waits
    // for the snapshot replacement CAS to match: a host that last read an older revision
    // must still revoke.
    db.prepare(
      "update remote_observations set revision = ?, as_of = null, completeness = 'unavailable', code = ?, " +
        "snapshot_json = null, received_at = ? where generation = ? and project_key = ?",
    ).run(next, negative.code, at, submission.generation, submission.check.projectId);
    db.prepare("delete from remote_issue_identities where generation = ? and project_key = ?").run(
      submission.generation,
      submission.check.projectId,
    );
    return { refused: negative };
  }
  if (submission.expectRevision !== revision) {
    throw new StoreError(
      "collaboration.observation-stale",
      `The submission expects observation revision ${String(submission.expectRevision)}, but the cache holds ` +
        `${String(revision)} for ${submission.check.projectId}. Re-read the scope and resubmit; nothing was written.`,
    );
  }
  const snapshotValue = submission.snapshot;
  if (snapshotValue === null) {
    throw new StoreError(
      "collaboration.observation-incomplete",
      "A verified observation needs its project snapshot; nothing was written.",
    );
  }
  const completeness = snapshotValue.coverage.kind === "complete" ? "complete" : "partial";
  const code = snapshotValue.coverage.kind === "partial" ? snapshotValue.coverage.code : null;
  db.prepare(
    "update remote_observations set revision = ?, as_of = ?, completeness = ?, code = ?, snapshot_json = ?, received_at = ? " +
      "where generation = ? and project_key = ?",
  ).run(
    next,
    snapshotValue.asOf,
    completeness,
    code,
    JSON.stringify(snapshotValue),
    at,
    submission.generation,
    submission.check.projectId,
  );
  // invariant: The identity projection is rebuilt with the snapshot in the same transaction,
  // so a reader never sees a reference from a replaced observation.
  db.prepare("delete from remote_issue_identities where generation = ? and project_key = ?").run(
    submission.generation,
    submission.check.projectId,
  );
  const insert = db.prepare(
    "insert into remote_issue_identities(generation, project_key, provider_issue_id, issue_ref) values (?, ?, ?, ?)",
  );
  for (const issue of snapshotValue.issues) {
    insert.run(
      submission.generation,
      submission.check.projectId,
      issue.identity.issueId,
      issue.mstar === null ? null : issue.mstar.issueRef,
    );
  }
  return {
    recorded: {
      version: 1,
      projectId: submission.check.projectId,
      generation: submission.generation,
      revision: next,
      completeness,
      asOf: snapshotValue.asOf,
      code,
    },
  };
}
