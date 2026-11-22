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
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  readCollaborationBinding,
  initializeRemoteCacheStore,
  ISSUE_REF_PATTERN,
  localPredecessorRetiredPath,
  mintIssueRef,
  openRemoteCache,
  readLocalPredecessorLane,
  retireLocalPredecessorLane,
  writeRemoteCacheStage,
  writeRemoteCollaborationBinding,
  withRemoteCacheWrite,
  assertIssueRef,
  assertRemoteCacheIdentity,
  type CollaborationAuthority,
  type CollaborationBinding,
  type CollaborationStoreHandle,
} from "./collaboration-store.js";
import { assertCaptureRequest, IssueError, ISSUE_DISPOSITIONS, ISSUE_KINDS, ISSUE_PROVENANCE_KINDS, ISSUE_RELATIONS, ISSUE_SEVERITIES, occurrenceColumns, requireSemanticKey, type CaptureInput } from "./issue.js";
import {
  assertSelectionUnchanged,
  CollaborationIdentityError,
  resolveCollaborationLocation,
  type CollaborationLocation,
  type CollaborationSelectorProject,
  type CollaborationSelection,
} from "./collaboration-identity.js";
import { withCollaborationLockFile } from "./collaboration-cutover.js";
import { StoreError, nowRfc3339, type StoreContext, type StoreDb, type StoreErrorCode } from "./store-db.js";

// ---------------------------------------------------------------------------
// note: Contract DTOs (Q1 - identity, scope checks and normalized snapshots)
// ---------------------------------------------------------------------------

/**
 * note: The retirement gap seam: a regression publishes a competing selector between the
 * bind's reviewed proof and its retirement decision. Production runs without a callback.
 */
let remoteBindTransitionGapForTest: (() => void) | undefined;
export function setRemoteBindTransitionGapForTest(callback: (() => void) | undefined): void {
  remoteBindTransitionGapForTest = callback;
}

/**
 * note: The binding-publication gap seam: a regression publishes/rebinds between the
 * committed cache transaction and the locked v3 publication. Production runs without a callback.
 */
let remoteBindingPublicationGapForTest: (() => void | Promise<void>) | undefined;
export function setRemoteBindingPublicationGapForTest(
  callback: (() => void | Promise<void>) | undefined,
): void {
  remoteBindingPublicationGapForTest = callback;
}

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
export const REMOTE_SCOPE_TTL_MS = 60_000;

function invalid(path: string, detail: string): never {
  throw new StoreError("remote.input-invalid", `${path}: ${detail}. Nothing was written.`);
}

/**
 * note: The named refusal for content whose fidelity the snapshot cannot keep. It
 * is never silent: an imported field the portable representation cannot hold
 * refuses the whole observation, and the lossless original stays in the local
 * store the snapshot does not replace.
 */
function unsafeFidelity(path: string, detail: string): never {
  throw new StoreError("remote.unsafe-fidelity", `${path}: ${detail}. Nothing was written.`);
}

/** note: A portable field is one bounded line that cannot name a filesystem location or carry a credential. */
const PORTABLE_FIELD_LIMIT = 512;

/**
 * note: A complete URL is inspected instead of trusted: its path or query can name
 * a home directory, and its authority or query key can carry a credential. It is
 * masked after that inspection so its `/<segment>` tail does not read as an
 * absolute path; an ordinary URL stays portable.
 */
const URL_TOKEN = /https?:\/\/[^\s"'`<>()[\]{}]+/gi;

/** note: An absolute home path is machine detail wherever it appears, a URL included. */
const HOME_PATH = /\/(?:Users|home|root|Volumes)\//i;

/** note: Credential-bearing URL query keys: a whole key, or a vendor-prefixed one after `_`/`-`. */
const URL_CREDENTIAL_KEY =
  /(?:^|[_-])(?:authorization|token|secret|password|passwd|passphrase|credential|api[_-]?key|apikey|access[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key)$/i;

/**
 * note: A path leaks the same machine detail embedded in a sentence as it does at
 * the start, so only a plain relative reference or a URL stays portable. An
 * absolute path after any boundary - whitespace or punctuation, under any root -
 * is refused, because a sentence that glues one behind another word still names
 * the machine. The slash must be followed by a non-space, so prose separation
 * such as `PR #42 / commit` stays readable.
 */
const EMBEDDED_PATH = /(?:^|[^\w])\/(?!\/)\S|\b[A-Za-z]:[\\/]|\\\\|~\/|file:\/\//i;

/**
 * note: A reviewed conservative shape rule, not a credential scanner: the HTTP auth
 * header, the common key shapes, and a credential label only when an assigned value
 * follows it. A phrase such as `Token: rotation scheduled` is business prose, so the
 * value shape decides, never the bare label.
 */
const CREDENTIAL_SHAPE =
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{4,}|\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[0-9A-Z]{12,})/i;
const AUTHORIZATION_HEADER = /\bauthorization\b\s*[:=]\s*\S/i;
const CREDENTIAL_ASSIGNMENT =
  /\b(?:token|secret|password|passwd|passphrase|credential|api[_\s-]?key|access[_\s-]?token|client[_\s-]?secret|secret[_\s-]?key|private[_\s-]?key)\b\s*[:=]\s*/gi;

/** note: A URL that names a home path or carries a credential in its authority or query is not portable. */
function urlRefusal(raw: string): string | null {
  if (HOME_PATH.test(raw)) return "names an absolute home path";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // shortcut: a URL the parser rejects is refused only by its visible home path; upgrade if a malformed form can carry a credential.
    return null;
  }
  if (url.username !== "" || url.password !== "") return "carries URL userinfo credentials";
  const keys = [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()];
  if (keys.some((key) => URL_CREDENTIAL_KEY.test(key))) return "carries a credential query key";
  return null;
}

/** note: Only a single-token value after a credential label is an assignment; a phrase is business prose. */
function assignedCredential(value: string): boolean {
  if (CREDENTIAL_SHAPE.test(value) || AUTHORIZATION_HEADER.test(value)) return true;
  for (const match of value.matchAll(CREDENTIAL_ASSIGNMENT)) {
    const rest = value.slice((match.index ?? 0) + match[0].length);
    const token = /^\S+/.exec(rest)?.[0];
    if (token === undefined) continue;
    // note: Anything other than a further word means the label owns the value.
    if (!/^\s+\S/.test(rest.slice(token.length))) return true;
  }
  return false;
}

function portableValue(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    unsafeFidelity(path, "carries a structured value, which the reviewed portable representation cannot keep");
  }
  if (value.length > PORTABLE_FIELD_LIMIT) {
    unsafeFidelity(path, `is longer than ${String(PORTABLE_FIELD_LIMIT)} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) unsafeFidelity(path, "carries a control character");
  for (const match of value.matchAll(URL_TOKEN)) {
    const refusal = urlRefusal(match[0]);
    if (refusal !== null) unsafeFidelity(path, `${refusal}, which the snapshot cannot represent`);
  }
  const withoutUrls = value.replace(URL_TOKEN, " ");
  if (
    /^(?:[A-Za-z]:[\\/]|[\\/~])/.test(value) ||
    value.split(/[\\/]/).includes("..") ||
    EMBEDDED_PATH.test(withoutUrls) ||
    assignedCredential(value)
  ) {
    unsafeFidelity(path, "carries a filesystem location or credential material, which the snapshot cannot represent");
  }
  return value;
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

/** note: The issue domain's dedup rule, reused here: a frozen subject never persists a guessed key. */
function semanticKey(value: unknown, path: string): string {
  if (typeof value !== "string") invalid(path, "must be a non-empty string");
  try {
    return requireSemanticKey(path, value);
  } catch (error) {
    invalid(path, error instanceof IssueError ? error.message : "is unknown or ambiguous");
  }
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

/**
 * invariant: Freezing a new intent applies the issue domain's dedup rule; an
 * observed chain is provider evidence and is never re-judged by this boundary.
 */
function frozenOccurrence(value: unknown, path: string): Record<string, unknown> {
  const row = occurrence(value, path);
  return {
    ...row,
    rootCauseKey: semanticKey(row.rootCauseKey, `${path}.rootCauseKey`),
    acceptanceKey: semanticKey(row.acceptanceKey, `${path}.acceptanceKey`),
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
 * row as its recorded evidence, so its portable form is that row's complete
 * business field set under camelCase names matching the snapshot vocabulary:
 * identity, classification, closure and supersession pointers, the
 * detail-document reference, and the source and plan anchors. A field outside
 * that list, or a value that is not portable text (a structured payload, a
 * credential, an embedded absolute, home-anchored or Windows path, a control
 * character, an over-long string), refuses the observation as
 * `remote.unsafe-fidelity` instead of being dropped.
 * The lossless row stays in the local store, which the snapshot does not replace.
 */
const IMPORTED_RECORD_FIELDS = [
  ["legacyId", "id"],
  ["title", "title"],
  ["severity", "severity"],
  ["source", "source"],
  ["scope", "scope"],
  ["decision", "decision"],
  ["owner", "owner"],
  ["target", "target"],
  ["tracking", "tracking"],
  ["detailDoc", "detail_doc"],
  ["lifecycle", "lifecycle"],
  ["closedAt", "closed_at"],
  ["closureNote", "closure_note"],
  ["closureEvidence", "closure_evidence"],
  ["supersededBy", "superseded_by"],
  ["sourcePlan", "source_plan"],
  ["registeredAt", "registered_at"],
] as const;

const IMPORTED_RECORD_KEYS: ReadonlySet<string> = new Set(
  IMPORTED_RECORD_FIELDS.flatMap(([portable, legacy]) => [portable, legacy]),
);

function importedRecord(value: unknown, path: string): Record<string, string | null> {
  const body = record(value, path);
  for (const key of Object.keys(body)) {
    if (!IMPORTED_RECORD_KEYS.has(key)) {
      unsafeFidelity(`${path}.${key}`, "is not a field the reviewed portable representation defines");
    }
  }
  const portable: Record<string, string | null> = {};
  for (const [key, legacy] of IMPORTED_RECORD_FIELDS) {
    // note: The portable document is accepted again, so an export of a stored snapshot round-trips.
    // Only a name that differs can be sent twice; most legacy spellings are already the portable one.
    if (key !== legacy && legacy in body && key in body) {
      invalid(`${path}.${key}`, `duplicates ${legacy}; send one spelling`);
    }
    if (!(legacy in body) && !(key in body)) continue;
    // note: A refusal names the spelling the sender used, so the offending field is findable.
    const sent = legacy in body ? legacy : key;
    portable[key] = portableValue(body[sent], `${path}.${sent}`);
  }
  if (Object.keys(portable).length === 0) {
    invalid(path, "must carry the imported record's business fields (legacy id, title, lifecycle, ...)");
  }
  return portable;
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
      ? importedRecord(body.evidence, `${path}.evidence`)
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

/**
 * note: Every provenance kind the store records: the domain links plus the capture and
 * migration rows. Resolved at CALL time because this module is reachable
 * through a module cycle (project -> collaboration-remote-read -> here) before
 * the issue domain's vocabulary has initialized.
 */
function provenanceKinds(): readonly string[] {
  return [...ISSUE_PROVENANCE_KINDS, "capture", "migration"];
}

const PROVENANCE_KEYS = [
  "eventId", "kind", "target", "sourceHash", "origin", "legacyProject", "legacyBucket", "legacyEntryId",
  "legacyRecord", "legacyJson", "importedAt",
] as const;

/**
 * invariant: Provenance never carries the raw legacy register JSON. A migration
 * row's full lossless text may be handed over as `legacyJson`; it is parsed and
 * projected through the same reviewed portable record as imported transition
 * evidence, so a credential-bearing structure or string, an embedded absolute,
 * home-anchored or Windows path, or an unknown field refuses the observation as
 * `remote.unsafe-fidelity`.
 * Only the portable projection is persisted, as `legacyRecord`, and a stored
 * snapshot's `legacyRecord` is accepted again so an export round-trips.
 */
function provenanceRecord(body: Record<string, unknown>, path: string): Record<string, string | null> | null {
  if ("legacyJson" in body && "legacyRecord" in body) {
    invalid(`${path}.legacyRecord`, "duplicates legacyJson; send one representation");
  }
  if ("legacyRecord" in body) {
    return body.legacyRecord === null ? null : importedRecord(body.legacyRecord, `${path}.legacyRecord`);
  }
  if (!("legacyJson" in body) || body.legacyJson === null) return null;
  const raw = body.legacyJson;
  if (typeof raw !== "string") unsafeFidelity(`${path}.legacyJson`, "must be the legacy row's JSON text or null");
  // shortcut: one legacy register row is a small JSON document; 64 KiB is far above any
  // observed row, and a larger one is refused rather than parsed unbounded.
  if (raw.length > 64 * 1024) unsafeFidelity(`${path}.legacyJson`, "is too large to be one legacy register row");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    unsafeFidelity(`${path}.legacyJson`, "is not JSON the reviewed representation can read");
  }
  return importedRecord(parsed, `${path}.legacyJson`);
}

function provenanceLink(value: unknown, path: string): Record<string, unknown> {
  const body = record(value, path);
  allowOnly(body, path, PROVENANCE_KEYS);
  const target = portableValue(text(body.target, `${path}.target`), `${path}.target`);
  if (target === null) invalid(`${path}.target`, "must be a non-empty string");
  const sourceHash = text(body.sourceHash, `${path}.sourceHash`);
  if (!SHA256.test(sourceHash)) invalid(`${path}.sourceHash`, "must be a canonical lowercase SHA-256 digest");
  return {
    eventId: eventId(body.eventId, `${path}.eventId`),
    kind: oneOf(body.kind, provenanceKinds(), `${path}.kind`),
    target,
    sourceHash,
    origin: oneOf(body.origin, ["scoped", "unscoped"] as const, `${path}.origin`),
    legacyProject: portableValue(body.legacyProject, `${path}.legacyProject`),
    legacyBucket: portableValue(body.legacyBucket, `${path}.legacyBucket`),
    legacyEntryId: portableValue(body.legacyEntryId, `${path}.legacyEntryId`),
    legacyRecord: provenanceRecord(body, path),
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
  if (checkedAt > now || now - checkedAt > REMOTE_SCOPE_TTL_MS) {
    throw new StoreError(
      "collaboration.observation-stale",
      `The check for ${check.projectId} at ${check.checkedAt} is not current: a positive access check must be dated ` +
        `within ${String(REMOTE_SCOPE_TTL_MS / 1000)} seconds of this process and never in the future. Reverify with the ` +
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
  const bound = recorded !== null && recorded.version === 3 && recorded.repoKey === location.repoKey ? recorded : null;
  const binding =
    bound !== null
      ? {
          state: "bound" as const,
          selectorCommit: bound.selectorCommit,
          generation: bound.generation,
          storeId: bound.storeId,
          epoch: bound.epoch,
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
  if (bound === null) return status(false, "collaboration.stale-binding", []);
  let handle: CollaborationStoreHandle;
  try {
    // note: The cache is admitted for the SAME selector and binding this status reports.
    handle = await openRemoteCache(context, "read", { location, binding: bound });
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
    const rows = bindingRows(handle.db, bound.generation);
    const observations = new Map(observationRows(handle.db, bound.generation).map((row) => [row.project_key, row]));
    const now = Date.now();
    const projects = rows.map((row): RemoteProjectStatus => {
      const observation = observations.get(row.project_key);
      const complete = observation?.completeness === "complete";
      const outcome = outcomeLabel(row.verification_json);
      // invariant: Serving needs a current positive access check AND a complete snapshot. The
      // freshness clock starts at the latest check, so a revocation or a refused check can
      // never be reported fresh off the binding's original bind time.
      const current = outcome === "verified" && Math.abs(now - Date.parse(row.verified_at)) <= REMOTE_SCOPE_TTL_MS;
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
  /** note: The local/mirror predecessor this reviewed transition retired, or null. */
  retiredPredecessor: Readonly<{ mode: "local" | "mirror"; storeId: string; epoch: number; path: string }> | null;
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
 * invariant: A local/mirror lane is retired only by a reviewed transition: the checked active
 * selector must supersede a local/mirror generation as its `previous` and carry a
 * fenced, pending-free cutover. The lane itself records no selector commit, so the
 * selector's own reviewed `previous` plus the matching lane metadata is the
 * lineage evidence available locally; an unfenced selector never retires anything.
 */
function assertPredecessorTransition(
  selection: CollaborationSelection,
  mode: "local" | "mirror",
): void {
  const previous = selection.previous;
  const fence = selection.cutover;
  const lineage = previous !== null && previous.mode === mode && previous.generation < selection.generation;
  const fenced = fence !== null && fence.sourceFenced && fence.pendingOperationIds.length === 0;
  if (!lineage || !fenced) {
    throw new StoreError(
      "collaboration.stale-binding",
      `This scope's canonical lane is a ${mode} predecessor, and the checked selector generation ` +
        `${String(selection.generation)} does not supersede a ${mode} generation with a fenced, pending-free cutover. ` +
        `The predecessor is not proven fenced, so it is never retired. Nothing was written.`,
    );
  }
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
  // invariant: A generation is only replayed by its OWN commit. A different selector never
  // reuses a recorded generation - least of all when the cache bytes are gone and the
  // later per-generation row checks have nothing left to compare against.
  if (
    recorded !== null &&
    recorded.version === 3 &&
    recorded.generation === batch.generation &&
    recorded.selectorCommit !== batch.selectorCommit
  ) {
    throw new StoreError(
      "collaboration.stale-binding",
      `This checkout recorded selector commit ${recorded.selectorCommit} at generation ${String(batch.generation)}, and ` +
        `the bind names ${batch.selectorCommit} at that same generation; a different selector never reuses a recorded ` +
        `generation. Publish a successor generation with its reviewed lineage. Nothing was changed.`,
    );
  }

  // invariant: A local/mirror lane at this scope's canonical path - recorded by this checkout or
  // not - is the PREDECESSOR a reviewed transition retires, never a lane a bind re-keys in place.
  const predecessor = await readLocalPredecessorLane(location);
  if (recorded !== null && recorded.version === 2) {
    if (recorded.state !== "active") {
      throw new StoreError(
        "collaboration.stale-binding",
        `This checkout holds an unfinished ${recorded.mode} binding (state ${recorded.state}); finish that activation ` +
          `before the reviewed transition to remote. Nothing was changed.`,
      );
    }
    if (predecessor === null) {
      // note: A crash after retirement leaves the preserved image and no lane: replaying the same
      // reviewed bind continues from there instead of re-creating an authority from nothing.
      if (!existsSync(localPredecessorRetiredPath(location, recorded))) {
        throw new StoreError(
          "collaboration.stale-binding",
          `This checkout is bound to the ${recorded.mode} predecessor store ${recorded.storeId} epoch ` +
            `${String(recorded.epoch)}, but that lane is missing and has no preserved image. Restore it or resolve the ` +
            `transition again; nothing was changed.`,
        );
      }
      assertPredecessorTransition(selection, recorded.mode);
    } else if (
      predecessor.mode !== recorded.mode ||
      predecessor.storeId !== recorded.storeId ||
      predecessor.epoch !== recorded.epoch
    ) {
      throw new StoreError(
        "collaboration.stale-binding",
        `This checkout is bound to the ${recorded.mode} predecessor store ${recorded.storeId} epoch ` +
          `${String(recorded.epoch)}, but the lane at ${location.dbPath} is ${predecessor.mode} store ` +
          `${predecessor.storeId} epoch ${String(predecessor.epoch)}; a bind never retires another generation. ` +
          `Nothing was changed.`,
      );
    }
  }
  if (predecessor !== null) {
    if (predecessor.state !== "active") {
      throw new StoreError(
        "collaboration.stale-binding",
        `The ${predecessor.mode} lane at ${location.dbPath} is ${predecessor.state}; only a published predecessor is ` +
          `retired by the reviewed transition. Finish or discard that bootstrap first; nothing was changed.`,
      );
    }
    assertPredecessorTransition(selection, predecessor.mode);
  }
  // note: The checkout's own lineage is proved INSIDE the cache transaction below, where the
  // committed intermediate generation (if any) is visible: a publication that failed leaves
  // that evidence in the cache, and the checkout may advance through it.

  // note: The reviewed transition's proof is re-taken at the retirement boundary; this seam
  // observes the gap a competing selector publication lands in.
  remoteBindTransitionGapForTest?.();
  // invariant: The reviewed transition retires the matched local/mirror lane under the SHARED
  // lane exclusion BEFORE the cache exists: two checkouts of one repository resolve one store
  // path, so a lock beside that path (not either checkout's harness) serializes their
  // renames. The lane proof, the live selector recheck and the move are one critical
  // section; a selector that moves while this bind waits leaves the predecessor untouched.
  const retiredPath =
    predecessor === null
      ? null
      : await withCollaborationLockFile(
          join(dirname(location.dbPath), "collaboration-retire.lock"),
          "collaboration retirement",
          () => retireLocalPredecessorLane(context, location, predecessor),
        );
  // invariant: A rebind continues the cache this checkout is bound to. A lane that is
  // present under another store id or epoch is a replacement and is refused; only a
  // vanished cache (Data Model: bind initializes a missing lane) may adopt a new identity.
  const cachePresent = existsSync(location.dbPath);
  // invariant: With NO committed cache there is no intermediate lineage to recover through:
  // the selector must name this checkout's recorded generation directly, and the refusal
  // happens BEFORE a lane is created (the cache's loss is never a fresh clone).
  if (!cachePresent && recorded !== null && recorded.version === 3 && recorded.generation < batch.generation) {
    const previous = selection.previous;
    const fenced =
      selection.cutover !== null && selection.cutover.sourceFenced && selection.cutover.pendingOperationIds.length === 0;
    if (
      previous === null ||
      previous.mode !== "remote" ||
      previous.generation !== recorded.generation ||
      previous.selectorCommit !== recorded.selectorCommit ||
      !fenced
    ) {
      throw new StoreError(
        "collaboration.stale-binding",
        `This checkout records remote generation ${String(recorded.generation)} (${recorded.selectorCommit}), its cache ` +
          `is absent, and the checked selector generation ${String(batch.generation)} does not name that record with a ` +
          `fenced transition. A missing cache never substitutes for lineage; nothing was created.`,
      );
    }
  }
  const staged = await initializeRemoteCacheStore(location);
  if (cachePresent && recorded !== null && recorded.version === 3) assertRemoteCacheIdentity(staged, recorded);
  const outcome = await writeRemoteCacheStage(location, ({ db, authority }) => {
    // invariant: The transaction's own lane identity is the stamp that gets published: a lane
    // replaced between admission and the write lock is never recorded in the v3 binding.
    if (authority.storeId !== staged.storeId || authority.epoch !== staged.epoch) {
      throw new StoreError(
        "collaboration.stale-binding",
        `The remote cache lane at ${location.dbPath} is store ${authority.storeId} epoch ${String(authority.epoch)}, not the ` +
          `store ${staged.storeId} epoch ${String(staged.epoch)} this bind admitted. Re-run the reviewed bind; nothing was written.`,
      );
    }
    assertFreshLane(authority, db);
    const latest = db
      .prepare("select generation, selector_commit from remote_bindings order by generation desc limit 1")
      .get();
    const recordedGeneration = isRecord(latest) && typeof latest.generation === "number" ? latest.generation : null;
    const recordedCommit = isRecord(latest) && typeof latest.selector_commit === "string" ? latest.selector_commit : null;
    // invariant: A recorded v3 binding that a higher generation supersedes is replaced only
    // through reviewed lineage. The cache is disposable, but its loss never substitutes for
    // the checkout's own evidence. Two reviewed shapes are admitted: the selector names the
    // checkout's recorded generation (the ordinary advance), or it names a COMMITTED cache
    // generation newer than that record - the durable intermediate of a bind whose selector
    // advanced before its v3 publication, so its recovery completes instead of looping.
    if (recorded !== null && recorded.version === 3 && recorded.generation < batch.generation) {
      const previous = selection.previous;
      const fenced =
        selection.cutover !== null && selection.cutover.sourceFenced && selection.cutover.pendingOperationIds.length === 0;
      const namesRecorded =
        previous !== null &&
        previous.mode === "remote" &&
        previous.generation === recorded.generation &&
        previous.selectorCommit === recorded.selectorCommit;
      const namesCommittedCache =
        recordedGeneration !== null &&
        recordedGeneration > recorded.generation &&
        previous !== null &&
        previous.mode === "remote" &&
        previous.generation === recordedGeneration &&
        previous.selectorCommit === recordedCommit;
      if (!fenced || (!namesRecorded && !namesCommittedCache)) {
        throw new StoreError(
          "collaboration.stale-binding",
          `This checkout records remote generation ${String(recorded.generation)} (${recorded.selectorCommit}) and the ` +
            `checked selector generation ${String(batch.generation)} names ` +
            `${previous === null ? "no predecessor" : `${String(previous.generation)} (${previous.selectorCommit})`}` +
            `${fenced ? "" : " with an unfenced cutover"}. A successor must name either this record or the committed ` +
            `cache generation with a fenced transition; nothing was written.`,
        );
      }
    }
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
      stamp: { storeId: authority.storeId, epoch: authority.epoch },
    };
  }, context);

  // invariant: Publication is the transition's last fence, and it is one critical section:
  // the live-selector read, the existing-binding compare and the file replace run under this
  // checkout's publication lock, so a process suspended after comparing cannot replace a
  // successor another publisher wrote. A selector that moved leaves no checkout binding; the
  // refusal discloses the committed cache instead of claiming a rollback.
  const binding = await withCollaborationLockFile(
    join(context.harnessDir, "collaboration-binding.lock"),
    "collaboration binding publication",
    async () => {
      await remoteBindingPublicationGapForTest?.();
      try {
        assertSelectionUnchanged(context, location);
      } catch (error) {
        if (error instanceof CollaborationIdentityError && error.code === "collaboration.stale-binding") {
          throw new StoreError(
            "collaboration.stale-binding",
            `The checked selector moved before this checkout's binding was published. The verified cache transaction ` +
              `already committed at store ${outcome.stamp.storeId} epoch ${String(outcome.stamp.epoch)} for selector commit ` +
              `${batch.selectorCommit} generation ${String(batch.generation)}, and no checkout binding was published. ` +
              `Re-run the reviewed bind for the current live selector: the committed generation is the reviewed ` +
              `predecessor its successor must name, so the checkout binding completes without republishing a stale ` +
              `selector; the cache rows stand.`,
          );
        }
        throw error;
      }
      return writeRemoteCollaborationBinding(context, {
        repoKey: location.repoKey,
        selectorCommit: batch.selectorCommit,
        generation: batch.generation,
        storeId: outcome.stamp.storeId,
        epoch: outcome.stamp.epoch,
      });
    },
  );
  return {
    version: 1,
    selectorCommit: batch.selectorCommit,
    generation: batch.generation,
    replayed: outcome.replayed,
    binding,
    availability: outcome.availability,
    retiredPredecessor:
      predecessor === null || retiredPath === null
        ? null
        : { mode: predecessor.mode, storeId: predecessor.storeId, epoch: predecessor.epoch, path: retiredPath },
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
  if (negative === null && now - checkedAt > REMOTE_SCOPE_TTL_MS) {
    throw new StoreError(
      "collaboration.observation-stale",
      `The verified check for ${submission.check.projectId} is older than ${String(REMOTE_SCOPE_TTL_MS / 1000)} seconds, so ` +
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

// ---------------------------------------------------------------------------
// note: prepareRemoteAdoption
// ---------------------------------------------------------------------------

/** note: `adopt-issue` addresses one observed, unmarked native issue by immutable identity. */
export type RemoteAdoptionRequest = Readonly<{
  projectId: string;
  issueId: string;
  operationId: string;
  adoption: unknown;
}>;

const ADOPTION_CAPTURE_KEYS = [
  "kind", "severity", "impact", "acceptance", "owner", "sourceIdentity", "rootCauseKey", "acceptanceKey",
  "occurrenceKey", "sourceKind", "location", "observedBehavior", "evidence", "discoveredAt",
] as const;
const ADOPTION_RETAIN_KEYS = ["issueRef", "fields", "occurrences", "transitions", "relations", "provenance", "projectMoves"] as const;

/**
 * note: The strict adoption DTO. `new` reuses normal capture validation with the project
 * from the binding and the title from the verified native issue; neither is
 * accepted from the caller. `retain` carries the reviewed complete MStar subject
 * (no `head`, which is an event-chain fact).
 */
/** note: The validated adoption input: a capture for `new`, or the reviewed complete subject for `retain`. */
type AdoptionDocument =
  | Readonly<{ kind: "new"; capture: Omit<CaptureInput, "projectId" | "title"> }>
  | Readonly<{ kind: "retain"; issueRef: string; source: Record<string, unknown> }>;

function adoptionDocument(raw: unknown): AdoptionDocument {
  const body = record(raw, "adoption");
  allowOnly(body, "adoption", ["version", "kind", "capture", "sourceIssue"]);
  if (body.version !== 1) invalid("adoption.version", "must be 1");
  const kind = oneOf(body.kind, ["new", "retain"] as const, "adoption.kind");
  if (kind === "new") {
    const capture = record(body.capture, "adoption.capture");
    allowOnly(capture, "adoption.capture", ADOPTION_CAPTURE_KEYS);
    return { kind, capture: capture as unknown as Omit<CaptureInput, "projectId" | "title"> };
  }
  const source = record(body.sourceIssue, "adoption.sourceIssue");
  allowOnly(source, "adoption.sourceIssue", ADOPTION_RETAIN_KEYS);
  assertIssueRef(source.issueRef);
  for (const key of ["fields", "occurrences", "transitions", "relations", "provenance", "projectMoves"] as const) {
    if (key === "fields") {
      record(source.fields, "adoption.sourceIssue.fields");
      continue;
    }
    list(source[key], `adoption.sourceIssue.${key}`).forEach((entry, index) => record(entry, `adoption.sourceIssue.${key}[${String(index)}]`));
  }
  return { kind, issueRef: source.issueRef as string, source };
}

/**
 * The genesis subject an adoption appends: the reviewed complete MStar subject for `retain`,
 * or the capture's own fields and first occurrence for `new`. It is validated by the same
 * freeze an ordinary replacement takes, so an incomplete genesis never reaches the outbox.
 */
function adoptionSubject(adoption: AdoptionDocument, nativeTitle: string, projectId: string): Record<string, unknown> {
  if (adoption.kind === "retain") {
    const source = adoption.source;
    return {
      fields: source.fields,
      occurrences: source.occurrences,
      transitions: source.transitions,
      relations: source.relations,
      provenance: source.provenance,
      projectMoves: source.projectMoves,
    };
  }
  const cols = occurrenceColumns(adoption.capture);
  const at = nowRfc3339();
  return {
    fields: {
      title: nativeTitle,
      kind: adoption.capture.kind,
      severity: adoption.capture.severity,
      disposition: "open",
      impact: adoption.capture.impact,
      acceptance: adoption.capture.acceptance,
      owner: adoption.capture.owner ?? null,
      registeredAt: at,
      closedAt: null,
      closureNote: null,
      createdAt: at,
      updatedAt: at,
      revision: 1,
      milestoneId: null,
    },
    occurrences: [
      {
        eventId: randomUUID(),
        occurrenceKey: cols.occurrenceKey,
        sourceKind: cols.sourceKind,
        sourceIdentity: cols.sourceIdentity,
        rootCauseKey: cols.rootCauseKey,
        acceptanceKey: cols.acceptanceKey,
        location: cols.location,
        observedBehavior: cols.observedBehavior,
        evidence: adoption.capture.evidence,
        discoveredAt: cols.discoveredAt,
        recordedAt: at,
        imported: false,
      },
    ],
    transitions: [],
    relations: [],
    // note: The capture's own provenance row, exactly as local capture records it.
    provenance: [
      {
        eventId: randomUUID(),
        kind: "capture",
        target: cols.sourceIdentity,
        sourceHash: createHash("sha256").update(cols.occurrenceKey, "utf8").digest("hex"),
        origin: "unscoped",
        legacyProject: null,
        legacyBucket: null,
        legacyEntryId: null,
        legacyRecord: null,
        importedAt: null,
      },
    ],
    projectMoves: [],
  };
}

/**
 * `remote adopt-issue`: validate the strict adoption DTO against the exact observed, unmarked
 * native issue, then freeze it as one durable `issue-adopt` intent. The verb never creates an
 * issue, never marks the native issue, never appends to a cache snapshot, and never performs a
 * "cache-only adoption": the effect exists only once the provider has appended it and the
 * receipt has confirmed the exact event.
 */
export async function prepareRemoteAdoption(context: StoreContext, request: RemoteAdoptionRequest): Promise<RemoteIntent> {
  const projectId = text(request?.projectId, "projectId");
  const issueId = linearId(request?.issueId, "issueId");
  const operationId = linearId(request?.operationId, "operationId");
  const adoption = adoptionDocument(request?.adoption);
  // note: The cache is admitted for the same selector and binding the adoption document was
  // validated against, so a rebind in between never mixes two generations.
  const scope = await readWriteScope(context, projectId);
  selectedProject(scope.selection, projectId);
  const native = scope.snapshot.issues.find((issue) => issue.identity.issueId === issueId);
  if (native === undefined) {
    throw new IssueError("issue.not-found", `Provider issue ${issueId} is not observed in project ${projectId}; nothing was written.`);
  }
  if (native.mstar !== null) {
    throw new StoreError(
      "remote.scope-mismatch",
      `Provider issue ${issueId} already carries an MStar marker (${native.mstar.issueRef}); adoption addresses only an ` +
        "observed unmarked native issue, and a differing marker is never replaced. Nothing was written.",
      { projectId, issueId },
    );
  }
  if (adoption.kind === "retain") {
    const bound = scope.snapshot.issues.find((issue) => issue.mstar !== null && issue.mstar.issueRef === adoption.issueRef);
    if (bound !== undefined) {
      throw new StoreError(
        "remote.scope-mismatch",
        `Issue reference ${adoption.issueRef} is already bound to provider issue ${bound.identity.issueId}; a retain never ` +
          "re-adopts a bound reference. Nothing was written.",
        { projectId, issueRef: adoption.issueRef },
      );
    }
  } else {
    // note: Reuse normal capture validation with the binding's project and the VERIFIED
    // native title. A caller-supplied project or title is not part of the DTO.
    assertCaptureRequest({ ...adoption.capture, projectId, title: native.nativeTitle });
  }
  const subject = adoptionSubject(adoption, native.nativeTitle, projectId);
  return prepareRemoteIssueWrite(context, {
    projectId,
    operationId,
    ...(adoption.kind === "retain" ? { issueRef: adoption.issueRef } : {}),
    issueId,
    kind: "issue-adopt",
    next: () => subject,
  });
}

// ---------------------------------------------------------------------------
// note: prepareRemoteIntent / readPendingIntents (Q2 outbox)
// ---------------------------------------------------------------------------

/** note: The provider binding an intent was frozen under, exactly as the cache materialized it. */
export type RemoteIntentBinding = Readonly<{
  generation: number;
  projectKey: string;
  selectorCommit: string;
  provider: "linear";
  workspaceId: string;
  teamId: string;
  projectId: string;
  journalIssueId: string;
  writerId: string | null;
}>;

export type RemoteEventChange =
  | Readonly<{
      kind: "issue-create" | "issue-adopt" | "issue-replace";
      issueRef: string;
      mstar: Record<string, unknown>;
    }>
  | Readonly<{ kind: "project-replace"; project: Record<string, unknown> }>;

/** note: The frozen provider event the Host Agent appends; its parents are content digests. */
export type RemoteEvent = Readonly<{
  version: 1;
  repoKey: string;
  projectId: string;
  operationId: string;
  parents: readonly string[];
  change: RemoteEventChange;
}>;

/** note: The execution reservation a composite intent also owns; null for an ordinary intent. */
export type RemoteIntentExecutionKey = Readonly<{
  executionStoreId: string;
  executionEpoch: number;
  operationId: string;
}>;

export type RemoteIntentRequest = Readonly<{
  binding: RemoteIntentBinding;
  event: RemoteEvent;
  target: string | null;
  expectedHeads: readonly string[];
  executionKey?: RemoteIntentExecutionKey | null;
}>;

export type RemoteIntentState = "enqueued" | "unconfirmed" | "confirmed" | "conflict" | "abandoned";

/** note: One intent as its prepare reported it; `replayed` is true only for an identical re-prepare. */
export type RemoteIntent = Readonly<{
  version: 1;
  operationId: string;
  projectId: string;
  generation: number;
  state: RemoteIntentState;
  requestHash: string;
  target: string | null;
  executionKey: RemoteIntentExecutionKey | null;
  replayed: boolean;
  createdAt: string;
  updatedAt: string;
}>;

/** note: A pending summary: enough to order and select an intent, never a send permit. */
export type RemotePendingIntent = Readonly<{
  operationId: string;
  projectId: string;
  state: "enqueued";
  requestHash: string;
  target: string | null;
  kind: RemoteEventChange["kind"];
  createdAt: string;
}>;

export type RemotePendingIntents = Readonly<{
  version: 1;
  projectId: string;
  generation: number;
  intents: readonly RemotePendingIntent[];
}>;

const REMOTE_CHANGE_KINDS = ["issue-create", "issue-adopt", "issue-replace", "project-replace"] as const;

/** note: Stable JSON: object keys sorted, so equal semantics always hash equally. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const body = value as Record<string, unknown>;
  return `{${Object.keys(body)
    .filter((key) => body[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(body[key])}`)
    .join(",")}}`;
}

/**
 * invariant: The event's issue subject is the complete normalized MStar document
 * with the same field allowlists the snapshot applies, minus the derived `head`
 * and the outer duplicate `issueRef`. An empty or partial subject never freezes.
 */
function frozenIssueSubject(value: unknown, path: string): Record<string, unknown> {
  const body = record(value, path);
  if ("head" in body) invalid(`${path}.head`, "is derived and is not frozen");
  if ("issueRef" in body) invalid(`${path}.issueRef`, "duplicates the event's reference");
  allowOnly(body, path, ["fields", "occurrences", "transitions", "relations", "provenance", "projectMoves"]);
  return {
    fields: mstarFields(body.fields, `${path}.fields`),
    occurrences: list(body.occurrences, `${path}.occurrences`).map((entry, index) =>
      frozenOccurrence(entry, `${path}.occurrences[${index}]`),
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

/**
 * invariant: The event's project subject is the snapshot's normalized project
 * document - every member present, no derived `head`, no `binding` (the
 * selected transport scope supplies it) and nothing outside the allowlist.
 */
function frozenProjectSubject(value: unknown, path: string, projectKey: string): Record<string, unknown> {
  const body = record(value, path);
  if ("head" in body) invalid(`${path}.head`, "is derived and is not frozen");
  if ("binding" in body) invalid(`${path}.binding`, "is supplied by the selected scope");
  allowOnly(body, path, ["projectId", "milestones", "roadmap", "catalogEntities", "catalogLinks"]);
  const projectId = text(body.projectId, `${path}.projectId`);
  if (projectId !== projectKey) invalid(`${path}.projectId`, "must be the event's project");
  const milestones = list(body.milestones, `${path}.milestones`).map((entry, index) =>
    milestone(entry, `${path}.milestones[${index}]`),
  );
  if (new Set(milestones.map((entry) => entry.milestoneId)).size !== milestones.length) {
    invalid(`${path}.milestones`, "must not repeat a milestone id");
  }
  const catalogEntities = list(body.catalogEntities, `${path}.catalogEntities`).map((entry, index) =>
    catalogEntity(entry, `${path}.catalogEntities[${index}]`),
  );
  if (new Set(catalogEntities.map((entry) => `${entry.kind}:${entry.id}`)).size !== catalogEntities.length) {
    invalid(`${path}.catalogEntities`, "must not repeat a (kind, id) pair");
  }
  return {
    projectId,
    milestones,
    roadmap: roadmap(body.roadmap, `${path}.roadmap`),
    catalogEntities,
    catalogLinks: list(body.catalogLinks, `${path}.catalogLinks`).map((entry, index) =>
      catalogLink(entry, `${path}.catalogLinks[${index}]`),
    ),
  };
}

function intentBinding(raw: unknown): RemoteIntentBinding {
  const body = record(raw, "request.binding");
  allowOnly(body, "request.binding", [
    "generation", "projectKey", "selectorCommit", "provider", "workspaceId", "teamId", "projectId", "journalIssueId",
    "writerId",
  ]);
  const selectorCommit = text(body.selectorCommit, "request.binding.selectorCommit");
  if (!GIT_OBJECT_ID.test(selectorCommit)) invalid("request.binding.selectorCommit", "must be a Git object id");
  const writerId = nullableString(body.writerId, "request.binding.writerId");
  return {
    generation: positiveInteger(body.generation, "request.binding.generation"),
    projectKey: text(body.projectKey, "request.binding.projectKey"),
    selectorCommit,
    provider: oneOf(body.provider, ["linear"] as const, "request.binding.provider"),
    workspaceId: linearId(body.workspaceId, "request.binding.workspaceId"),
    teamId: linearId(body.teamId, "request.binding.teamId"),
    projectId: linearId(body.projectId, "request.binding.projectId"),
    journalIssueId: linearId(body.journalIssueId, "request.binding.journalIssueId"),
    writerId: writerId === null ? null : linearId(writerId, "request.binding.writerId"),
  };
}

function intentExecutionKey(raw: unknown, operationId: string): RemoteIntentExecutionKey {
  const body = record(raw, "request.executionKey");
  allowOnly(body, "request.executionKey", ["executionStoreId", "executionEpoch", "operationId"]);
  const keyed = linearId(body.operationId, "request.executionKey.operationId");
  if (keyed !== operationId) invalid("request.executionKey.operationId", "must name this intent's operation");
  return {
    executionStoreId: text(body.executionStoreId, "request.executionKey.executionStoreId"),
    executionEpoch: positiveInteger(body.executionEpoch, "request.executionKey.executionEpoch"),
    operationId: keyed,
  };
}

function remoteEvent(raw: unknown, binding: RemoteIntentBinding): RemoteEvent {
  const body = record(raw, "request.event");
  allowOnly(body, "request.event", ["version", "repoKey", "projectId", "operationId", "parents", "change"]);
  if (body.version !== 1) invalid("request.event.version", "must be 1");
  const projectId = text(body.projectId, "request.event.projectId");
  if (projectId !== binding.projectKey) invalid("request.event.projectId", "must be the binding's project");
  const change = record(body.change, "request.event.change");
  const kind = oneOf(change.kind, REMOTE_CHANGE_KINDS, "request.event.change.kind");
  const parents = digestHead(body.parents, "request.event.parents");
  // invariant: `[]` is initial genesis or adoption only: a replacement cites the heads it replaces.
  if (kind === "issue-replace" && parents.length === 0) {
    invalid("request.event.parents", "a replacement must cite at least one replaced head");
  }
  let frozen: RemoteEventChange;
  if (kind === "project-replace") {
    allowOnly(change, "request.event.change", ["kind", "project"]);
    frozen = { kind, project: frozenProjectSubject(change.project, "request.event.change.project", projectId) };
  } else {
    allowOnly(change, "request.event.change", ["kind", "issueRef", "mstar"]);
    frozen = {
      kind,
      issueRef: assertIssueRef(change.issueRef),
      mstar: frozenIssueSubject(change.mstar, "request.event.change.mstar"),
    };
  }
  return {
    version: 1,
    repoKey: text(body.repoKey, "request.event.repoKey"),
    projectId,
    operationId: linearId(body.operationId, "request.event.operationId"),
    parents,
    change: frozen,
  };
}

/** note: A create addresses no native record; every other change appends to one immutable target. */
function intentTarget(raw: unknown, change: RemoteEventChange, binding: RemoteIntentBinding): string | null {
  if (change.kind === "issue-create") {
    if (raw !== null && raw !== undefined) invalid("request.target", "must be null for a create");
    return null;
  }
  const target = linearId(raw, "request.target");
  if (change.kind === "project-replace" && target !== binding.journalIssueId) {
    invalid("request.target", "must be the selected journal anchor for a project event");
  }
  return target;
}

/**
 * `prepareRemoteIntent`: freeze one normalized remote write and commit it as an
 * `enqueued` intent before anything is reported. The request must address the
 * checked selector's current binding; the stored row carries the exact canonical
 * request and its SHA-256. An identical re-prepare returns the stored state; the
 * same operation id under a different request or binding refuses without
 * mutation. The lane must be a v3 cache, so a missing or older outbox never
 * accepts an intent.
 */
export async function prepareRemoteIntent(context: StoreContext, request: unknown): Promise<RemoteIntent> {
  const body = record(request, "request");
  allowOnly(body, "request", ["binding", "event", "target", "expectedHeads", "executionKey"]);
  const binding = intentBinding(body.binding);
  const event = remoteEvent(body.event, binding);
  const target = intentTarget(body.target, event.change, binding);
  const expectedHeads = digestHead(body.expectedHeads, "request.expectedHeads");
  const executionKey = body.executionKey === undefined || body.executionKey === null
    ? null
    : intentExecutionKey(body.executionKey, event.operationId);
  const location = resolveCollaborationLocation(context);
  const selection = remoteSelection(location);
  if (selection.phase !== "active") {
    throw new StoreError(
      "collaboration.stale-binding",
      `The checked selector generation ${String(selection.generation)} is draining, so no new remote intent is prepared. ` +
        `Reconcile the outstanding intents and complete the reviewed transition; nothing was enqueued.`,
    );
  }
  if (event.repoKey !== location.repoKey) {
    throw new StoreError(
      "remote.scope-mismatch",
      `The event names repository ${event.repoKey}, not this checkout's ${location.repoKey}; nothing was enqueued.`,
    );
  }
  const selected = selectedProject(selection, binding.projectKey);
  const addresses =
    binding.generation === selection.generation &&
    binding.selectorCommit === selection.commit &&
    binding.workspaceId === selected.workspaceId &&
    binding.teamId === selected.teamId &&
    binding.projectId === selected.projectId &&
    binding.journalIssueId === selected.journalIssueId &&
    binding.writerId === selected.writerId;
  if (!addresses) {
    throw new StoreError(
      "remote.scope-mismatch",
      `The request's binding does not address the checked selector commit ${selection.commit} generation ` +
        `${String(selection.generation)} for project ${selected.localProjectId}; nothing was enqueued.`,
    );
  }
  // note: The frozen request is exactly the contract's four members; the execution key is its own
  // column, so an ordinary intent and a composite intent never differ in their request hash scope.
  const frozenRequest = { binding, event, target, expectedHeads };
  const requestJson = canonicalJson(frozenRequest);
  const requestHash = createHash("sha256").update(requestJson, "utf8").digest("hex");
  const executionJson = executionKey === null ? null : canonicalJson(executionKey);

  return withRemoteCacheWrite(context, (handle) => {
    const db = handle.db;
    const stored = db
      .prepare(
        "select selector_commit, provider, workspace_id, team_id, provider_project_id, journal_issue_id, writer_id " +
          "from remote_bindings where generation = ? and project_key = ?",
      )
      .get(binding.generation, binding.projectKey) as Record<string, unknown> | undefined;
    const materialized =
      stored !== undefined &&
      stored.selector_commit === binding.selectorCommit &&
      stored.provider === binding.provider &&
      stored.workspace_id === binding.workspaceId &&
      stored.team_id === binding.teamId &&
      stored.provider_project_id === binding.projectId &&
      stored.journal_issue_id === binding.journalIssueId &&
      (typeof stored.writer_id === "string" ? stored.writer_id : null) === binding.writerId;
    if (!materialized) {
      throw new StoreError(
        "remote.scope-mismatch",
        `The cache does not record this request's binding at generation ${String(binding.generation)} for ` +
          `${binding.projectKey}; nothing was enqueued.`,
      );
    }
    const existing = db
      .prepare(
        "select generation, project_key, request_hash, state, created_at, updated_at, execution_key_json " +
          "from remote_outbox where operation_id = ?",
      )
      .get(event.operationId) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      if (
        existing.request_hash !== requestHash ||
        existing.generation !== binding.generation ||
        existing.project_key !== binding.projectKey ||
        (typeof existing.execution_key_json === "string" ? existing.execution_key_json : null) !== executionJson
      ) {
        throw new StoreError(
          "remote.operation-conflict",
          `Operation ${event.operationId} is already recorded under a different request or binding. An operation id is ` +
            `reused only with the identical binding, request and execution key; inspect it with outbox-show and submit ` +
            `a new id for a corrected write. Nothing was enqueued.`,
          { operationId: event.operationId, state: existing.state },
        );
      }
      return intentOf(event.operationId, target, existing, binding, executionKey, true);
    }
    const at = nowRfc3339();
    db.prepare(
      "insert into remote_outbox(operation_id, generation, project_key, request_hash, request_json, " +
        "execution_key_json, state, created_at, updated_at) values (?, ?, ?, ?, ?, ?, 'enqueued', ?, ?)",
    ).run(event.operationId, binding.generation, binding.projectKey, requestHash, requestJson, executionJson, at, at);
    return {
      version: 1,
      operationId: event.operationId,
      projectId: binding.projectKey,
      generation: binding.generation,
      state: "enqueued",
      requestHash,
      target,
      executionKey,
      replayed: false,
      createdAt: at,
      updatedAt: at,
    } satisfies RemoteIntent;
  });
}

const REMOTE_INTENT_STATES: readonly RemoteIntentState[] = [
  "enqueued",
  "unconfirmed",
  "confirmed",
  "conflict",
  "abandoned",
];

/** note: The stored row projected for a caller, never a send permit: no attempt id leaves this module. */
function intentOf(
  operationId: string,
  target: string | null,
  row: Record<string, unknown>,
  binding: RemoteIntentBinding,
  executionKey: RemoteIntentExecutionKey | null,
  replayed: boolean,
): RemoteIntent {
  if (
    row.generation !== binding.generation ||
    typeof row.created_at !== "string" ||
    typeof row.updated_at !== "string" ||
    typeof row.request_hash !== "string" ||
    !REMOTE_INTENT_STATES.includes(row.state as RemoteIntentState)
  ) {
    throw new StoreError(
      "collaboration.unreadable",
      `The stored outbox row for operation ${operationId} is malformed; nothing was enqueued or changed.`,
    );
  }
  return {
    version: 1,
    operationId,
    projectId: binding.projectKey,
    generation: binding.generation,
    state: row.state as RemoteIntentState,
    requestHash: row.request_hash,
    target,
    executionKey,
    replayed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * `outbox-pending`: the current binding's `enqueued` intents only, FIFO by
 * `(createdAt, operationId)`, as summaries without a send permit or an attempt id.
 */
export async function readPendingIntents(context: StoreContext, projectId: string): Promise<RemotePendingIntents> {
  const project = text(projectId, "projectId");
  const location = resolveCollaborationLocation(context);
  const selection = remoteSelection(location);
  selectedProject(selection, project);
  const handle = await openRemoteCache(context, "read");
  try {
    const rows = handle.db
      .prepare(
        "select operation_id, request_hash, request_json, created_at from remote_outbox " +
          "where generation = ? and project_key = ? and state = 'enqueued' " +
          "order by created_at, operation_id",
      )
      .all(selection.generation, project) as Array<Record<string, unknown>>;
    return {
      version: 1,
      projectId: project,
      generation: selection.generation,
      intents: rows.map((row) => pendingIntentOf(row, project)),
    };
  } finally {
    handle.close();
  }
}

function pendingIntentOf(row: Record<string, unknown>, project: string): RemotePendingIntent {
  const unreadable = (): never => {
    throw new StoreError(
      "collaboration.unreadable",
      `The stored outbox row for project ${project} is malformed; nothing was read as a pending intent.`,
    );
  };
  if (typeof row.operation_id !== "string" || typeof row.request_hash !== "string" || typeof row.created_at !== "string") {
    return unreadable();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof row.request_json === "string" ? row.request_json : "");
  } catch {
    return unreadable();
  }
  const event = isRecord(parsed) && isRecord(parsed.event) ? parsed.event : undefined;
  const change = event !== undefined && isRecord(event.change) ? event.change : undefined;
  const kind = change?.kind;
  if (typeof kind !== "string" || !REMOTE_CHANGE_KINDS.includes(kind as RemoteEventChange["kind"])) return unreadable();
  return {
    operationId: row.operation_id,
    projectId: project,
    state: "enqueued",
    requestHash: row.request_hash,
    target: isRecord(parsed) && typeof parsed.target === "string" ? parsed.target : null,
    kind: kind as RemoteEventChange["kind"],
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// note: Q2 outbox lifecycle: inspection, one send permit, receipts and recovery
// ---------------------------------------------------------------------------

/** note: The closed receipt outcomes the Host Agent may submit for one attempt. */
export type RemoteReceiptOutcome =
  | Readonly<{ kind: "confirmed"; identity: ProviderIssueIdentity; recordId: string; event: RemoteEvent }>
  | Readonly<{ kind: "unconfirmed"; reason: "no-response" | "not-found" | "ambiguous" | "provider-unavailable" }>
  | Readonly<{
      kind: "conflict";
      expectedHeads: readonly string[];
      observedHeads: readonly string[];
      observedRecords: readonly Readonly<{ identity: ProviderIssueIdentity; recordId: string; event: RemoteEvent }>[];
    }>
  | Readonly<{ kind: "not-sent"; code: string }>;

/** note: One recorded receipt or reconciliation; the evidence behind a durable state. */
export type RemoteReceiptRecord = Readonly<{
  source: "receipt" | "reconcile";
  receiptHash: string;
  outcome: RemoteReceiptOutcome;
  recordedAt: string;
}>;

/** note: `outbox-show`: the frozen request and its durable state, never a send permit. */
export type RemoteIntentRead = Readonly<{
  version: 1;
  operationId: string;
  projectId: string;
  generation: number;
  state: RemoteIntentState;
  attemptId: string | null;
  requestHash: string;
  binding: RemoteIntentBinding;
  event: RemoteEvent;
  target: string | null;
  expectedHeads: readonly string[];
  executionKey: RemoteIntentExecutionKey | null;
  operator: string | null;
  reason: string | null;
  resolves: string | null;
  resolvedBy: string | null;
  abandonReason: string | null;
  receipts: readonly RemoteReceiptRecord[];
  createdAt: string;
  updatedAt: string;
}>;

/** note: The one permit one dispatch issues: the frozen request, one attempt id. */
export type RemoteDispatchPermit = Readonly<{
  version: 1;
  attemptId: string;
  binding: RemoteIntentBinding;
  operationId: string;
  requestHash: string;
  frozenRequest: RemoteIntentRequest;
}>;

export type RemoteDispatchResult =
  | Readonly<{ kind: "permit"; permit: RemoteDispatchPermit }>
  | Readonly<{ kind: "state"; operationId: string; state: RemoteIntentState; requestHash: string }>;

/** note: `outbox-resolve`: the reviewed replacement event for one conflicted intent. */
export type RemoteResolution = Readonly<{
  operationId: string;
  operator: string;
  reason: string;
  event: unknown;
}>;

/** note: One frozen request together with the stored facts the lifecycle dispatches on. */
type StoredRequest = Readonly<{
  request: RemoteIntentRequest;
  operator: string | null;
  reason: string | null;
}>;

type OutboxIntentRow = Readonly<{
  operationId: string;
  generation: number;
  projectKey: string;
  requestHash: string;
  requestJson: string;
  executionKeyJson: string | null;
  state: RemoteIntentState;
  attemptId: string | null;
  createdAt: string;
  updatedAt: string;
  abandonReason: string | null;
  resolves: string | null;
  resolvedBy: string | null;
}>;

const INTENT_STATES: readonly RemoteIntentState[] = ["enqueued", "unconfirmed", "confirmed", "conflict", "abandoned"];

function malformedIntent(operationId: string, detail: string): StoreError {
  return new StoreError(
    "collaboration.unreadable",
    `The stored outbox row for operation ${operationId} ${detail}; nothing was read or changed.`,
  );
}

function intentRow(db: StoreDb, operationId: string): OutboxIntentRow {
  const row = db
    .prepare(
      "select operation_id, generation, project_key, request_hash, request_json, execution_key_json, state, attempt_id, " +
        "created_at, updated_at, abandon_reason, resolves, resolved_by from remote_outbox where operation_id = ?",
    )
    .get(operationId) as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new StoreError(
      "remote.intent-not-found",
      `No outbox intent is recorded for operation ${operationId}; an unknown id names nothing to inspect, dispatch or ` +
        `reconcile. Read the pending intents for the project first. Nothing was changed.`,
      { operationId },
    );
  }
  if (
    typeof row.operation_id !== "string" ||
    typeof row.generation !== "number" ||
    typeof row.project_key !== "string" ||
    typeof row.request_hash !== "string" ||
    typeof row.request_json !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.updated_at !== "string" ||
    !INTENT_STATES.includes(row.state as RemoteIntentState)
  ) {
    throw malformedIntent(operationId, "is structurally incomplete");
  }
  return {
    operationId: row.operation_id,
    generation: row.generation,
    projectKey: row.project_key,
    requestHash: row.request_hash,
    requestJson: row.request_json,
    executionKeyJson: typeof row.execution_key_json === "string" ? row.execution_key_json : null,
    state: row.state as RemoteIntentState,
    attemptId: typeof row.attempt_id === "string" ? row.attempt_id : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    abandonReason: typeof row.abandon_reason === "string" ? row.abandon_reason : null,
    resolves: typeof row.resolves === "string" ? row.resolves : null,
    resolvedBy: typeof row.resolved_by === "string" ? row.resolved_by : null,
  };
}

/**
 * invariant: A stored request is re-validated against the current contract before any lifecycle
 * reads it, so a hand-edited or partially written row refuses as unreadable instead of
 * driving a send. The reviewed resolution additionally carries its operator and reason.
 */
function storedRequest(row: OutboxIntentRow): StoredRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.requestJson);
  } catch {
    throw malformedIntent(row.operationId, "carries no readable frozen request");
  }
  try {
    const body = record(parsed, "request");
    allowOnly(body, "request", ["binding", "event", "target", "expectedHeads", "executionKey", "operator", "reason"]);
    const binding = intentBinding(body.binding);
    const event = remoteEvent(body.event, binding);
    const target = intentTarget(body.target, event.change, binding);
    const expectedHeads = digestHead(body.expectedHeads, "request.expectedHeads");
    const executionKey =
      body.executionKey === undefined || body.executionKey === null
        ? null
        : intentExecutionKey(body.executionKey, event.operationId);
    return {
      request: { binding, event, target, expectedHeads, executionKey },
      operator: typeof body.operator === "string" ? body.operator : null,
      reason: typeof body.reason === "string" ? body.reason : null,
    };
  } catch {
    throw malformedIntent(row.operationId, "carries a frozen request the contract cannot read");
  }
}

/** note: The cache's materialized binding must equal the frozen one before any lifecycle act. */
function assertFrozenBinding(db: StoreDb, binding: RemoteIntentBinding, operationId: string): void {
  const stored = db
    .prepare(
      "select selector_commit, provider, workspace_id, team_id, provider_project_id, journal_issue_id, writer_id " +
        "from remote_bindings where generation = ? and project_key = ?",
    )
    .get(binding.generation, binding.projectKey) as Record<string, unknown> | undefined;
  if (
    stored === undefined ||
    stored.selector_commit !== binding.selectorCommit ||
    stored.provider !== binding.provider ||
    stored.workspace_id !== binding.workspaceId ||
    stored.team_id !== binding.teamId ||
    stored.provider_project_id !== binding.projectId ||
    stored.journal_issue_id !== binding.journalIssueId ||
    (typeof stored.writer_id === "string" ? stored.writer_id : null) !== binding.writerId
  ) {
    throw new StoreError(
      "collaboration.stale-binding",
      `Operation ${operationId} was frozen under a binding the cache no longer records at generation ` +
        `${String(binding.generation)} for ${binding.projectKey}; it is read only under its original binding. ` +
        `Nothing was changed.`,
      { operationId, generation: binding.generation },
    );
  }
}

function receiptRows(db: StoreDb, operationId: string): RemoteReceiptRecord[] {
  const rows = db
    .prepare(
      "select receipt_hash, source, evidence_json, recorded_at from remote_outbox_receipts " +
        "where operation_id = ? order by recorded_at, receipt_hash",
    )
    .all(operationId) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    if (
      typeof row.receipt_hash !== "string" ||
      (row.source !== "receipt" && row.source !== "reconcile") ||
      typeof row.evidence_json !== "string" ||
      typeof row.recorded_at !== "string"
    ) {
      throw malformedIntent(operationId, "holds an unreadable receipt row");
    }
    let evidence: unknown;
    try {
      evidence = JSON.parse(row.evidence_json);
    } catch {
      throw malformedIntent(operationId, "holds a receipt the contract cannot read");
    }
    const body = record(evidence, "receipt");
    return {
      source: row.source as "receipt" | "reconcile",
      receiptHash: row.receipt_hash,
      recordedAt: row.recorded_at,
      outcome: receiptOutcomeOf(body.outcome, operationId),
    };
  });
}

/** note: A stored outcome is re-read for the disclosure only: its shape is validated, not re-judged. */
function receiptOutcomeOf(raw: unknown, operationId: string): RemoteReceiptOutcome {
  try {
    return receiptOutcome(raw, "receipt.outcome");
  } catch {
    throw malformedIntent(operationId, "holds a receipt outcome the contract cannot read");
  }
}

/**
 * invariant: One receipt outcome, exactly as the contract closes it. `confirmed` must name the
 * target's provider identity and the exact event the caller decoded back, so a receipt can
 * never be confused with a reviewer's summary. The frozen binding's scope is required.
 */
function receiptOutcome(raw: unknown, path: string): RemoteReceiptOutcome {
  const body = record(raw, path);
  const kind = oneOf(body.kind, ["confirmed", "unconfirmed", "conflict", "not-sent"] as const, `${path}.kind`);
  if (kind === "confirmed") {
    allowOnly(body, path, ["kind", "identity", "recordId", "event"]);
    return {
      kind,
      identity: issueIdentity(body.identity, `${path}.identity`),
      recordId: linearId(body.recordId, `${path}.recordId`),
      event: frozenEvent(body.event, `${path}.event`),
    };
  }
  if (kind === "unconfirmed") {
    allowOnly(body, path, ["kind", "reason"]);
    return {
      kind,
      reason: oneOf(
        body.reason,
        ["no-response", "not-found", "ambiguous", "provider-unavailable"] as const,
        `${path}.reason`,
      ),
    };
  }
  if (kind === "conflict") {
    allowOnly(body, path, ["kind", "expectedHeads", "observedHeads", "observedRecords"]);
    return {
      kind,
      expectedHeads: digestHead(body.expectedHeads, `${path}.expectedHeads`),
      observedHeads: digestHead(body.observedHeads, `${path}.observedHeads`),
      observedRecords: list(body.observedRecords, `${path}.observedRecords`).map((entry, index) => {
        const record_ = record(entry, `${path}.observedRecords[${index}]`);
        allowOnly(record_, `${path}.observedRecords[${index}]`, ["identity", "recordId", "event"]);
        return {
          identity: issueIdentity(record_.identity, `${path}.observedRecords[${index}].identity`),
          recordId: linearId(record_.recordId, `${path}.observedRecords[${index}].recordId`),
          event: frozenEvent(record_.event, `${path}.observedRecords[${index}].event`),
        };
      }),
    };
  }
  allowOnly(body, path, ["kind", "code"]);
  return { kind, code: text(body.code, `${path}.code`) };
}

/**
 * note: A receipt's event is validated against the contract's own event shape with a
 * placeholder binding; the exact equality with the frozen event is the caller's check.
 */
function frozenEvent(raw: unknown, path: string): RemoteEvent {
  const body = record(raw, path);
  const binding = intentBinding({
    generation: 1,
    projectKey: text(body.projectId, `${path}.projectId`),
    selectorCommit: "0".repeat(40),
    provider: "linear",
    workspaceId: "00000000-0000-4000-8000-000000000000",
    teamId: "00000000-0000-4000-8000-000000000000",
    projectId: "00000000-0000-4000-8000-000000000000",
    journalIssueId: "00000000-0000-4000-8000-000000000000",
    writerId: null,
  });
  return remoteEvent(body, binding);
}

function assertReceiptTargets(outcome: RemoteReceiptOutcome, request: StoredRequest, operationId: string): void {
  if (outcome.kind !== "confirmed") return;
  const expectedIssue = request.request.target ?? request.request.binding.journalIssueId;
  const scope = request.request.binding;
  if (
    outcome.identity.workspaceId !== scope.workspaceId ||
    outcome.identity.teamId !== scope.teamId ||
    outcome.identity.projectId !== scope.projectId ||
    outcome.identity.issueId !== expectedIssue
  ) {
    throw new StoreError(
      "remote.scope-mismatch",
      `The confirmed record of operation ${operationId} is not the immutable provider record this intent addresses ` +
        `(${expectedIssue} in the bound project); a receipt from another scope never confirms it. Nothing was changed.`,
      { operationId, expectedIssue, observedIssue: outcome.identity.issueId },
    );
  }
  if (canonicalJson(outcome.event) !== canonicalJson(request.request.event)) {
    throw new StoreError(
      "remote.operation-conflict",
      `The confirmed record of operation ${operationId} carries another event than the frozen request; a differing ` +
        `effect is a conflict to review, never a confirmation. Nothing was changed.`,
      { operationId },
    );
  }
}

/** note: The receipt's own durable identity: a replay of the same submission never doubles the evidence. */
function receiptHashOf(source: "receipt" | "reconcile", receipt: RemoteReceiptEnvelope, outcome: RemoteReceiptOutcome): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        source,
        attemptId: receipt.attemptId,
        generation: receipt.generation,
        observedAt: receipt.observedAt,
        operationId: receipt.operationId,
        outcome,
        projectId: receipt.projectId,
        requestHash: receipt.requestHash,
        selectorCommit: receipt.selectorCommit,
      }),
      "utf8",
    )
    .digest("hex");
}

type RemoteReceiptEnvelope = Readonly<{
  version: 1;
  selectorCommit: string;
  generation: number;
  projectId: string;
  operationId: string;
  attemptId: string;
  requestHash: string;
  observedAt: string;
  outcome: unknown;
}>;

function receiptEnvelope(raw: unknown): RemoteReceiptEnvelope {
  const body = record(raw, "receipt");
  allowOnly(body, "receipt", [
    "version", "selectorCommit", "generation", "projectId", "operationId", "attemptId", "requestHash", "observedAt",
    "outcome",
  ]);
  if (body.version !== 1) invalid("receipt.version", "must be 1");
  const selectorCommit = text(body.selectorCommit, "receipt.selectorCommit");
  if (!GIT_OBJECT_ID.test(selectorCommit)) invalid("receipt.selectorCommit", "must be a Git object id");
  return {
    version: 1,
    selectorCommit,
    generation: positiveInteger(body.generation, "receipt.generation"),
    projectId: text(body.projectId, "receipt.projectId"),
    operationId: linearId(body.operationId, "receipt.operationId"),
    attemptId: linearId(body.attemptId, "receipt.attemptId"),
    requestHash: digest(body.requestHash, "receipt.requestHash"),
    observedAt: instant(body.observedAt, "receipt.observedAt"),
    outcome: body.outcome,
  };
}

/** note: A confirmed effect invalidates the snapshot it moved: the cache stops serving a stale base. */
function invalidateConfirmedBase(db: StoreDb, generation: number, projectKey: string): void {
  const at = nowRfc3339();
  db.prepare(
    "update remote_observations set revision = revision + 1, as_of = null, completeness = 'unavailable', " +
      "code = 'remote.effect-confirmed', snapshot_json = null, received_at = ? where generation = ? and project_key = ?",
  ).run(at, generation, projectKey);
  db.prepare("delete from remote_issue_identities where generation = ? and project_key = ?").run(generation, projectKey);
}

/**
 * `recordRemoteReceipt` / `outbox-receipt`: record what one dispatched attempt observed.
 * The receipt must address the intent's own attempt, request and binding; a confirmed effect
 * must be the exact frozen event on the exact addressed record. The evidence row and the
 * resulting state commit together, so a lost response is never reported as either outcome.
 */
export async function recordRemoteReceipt(context: StoreContext, receipt: unknown): Promise<RemoteIntentRead> {
  return recordReceiptEvidence(context, receipt, "receipt");
}

/**
 * `reconcileRemoteIntent` / `outbox-reconcile`: read-only recovery of one uncertain attempt
 * under its ORIGINAL binding (including a draining generation). It never issues a permit and
 * never sends; only a unique exact match advances the intent to `confirmed`.
 */
export async function reconcileRemoteIntent(context: StoreContext, receipt: unknown): Promise<RemoteIntentRead> {
  return recordReceiptEvidence(context, receipt, "reconcile");
}

async function recordReceiptEvidence(
  context: StoreContext,
  raw: unknown,
  source: "receipt" | "reconcile",
): Promise<RemoteIntentRead> {
  const envelope = receiptEnvelope(raw);
  return withRemoteCacheWrite(context, (handle) => {
    const db = handle.db;
    const row = intentRow(db, envelope.operationId);
    if (row.generation !== envelope.generation || row.projectKey !== envelope.projectId) {
      throw new StoreError(
        "collaboration.stale-binding",
        `Operation ${envelope.operationId} was frozen for project ${row.projectKey} at generation ` +
          `${String(row.generation)}, not the receipt's ${envelope.projectId} at generation ` +
          `${String(envelope.generation)}; recovery runs under the original binding. Nothing was changed.`,
        { operationId: envelope.operationId },
      );
    }
    const stored = storedRequest(row);
    if (envelope.selectorCommit !== stored.request.binding.selectorCommit) {
      throw new StoreError(
        "collaboration.stale-binding",
        `Operation ${envelope.operationId} was frozen under selector commit ${stored.request.binding.selectorCommit}, ` +
          `not the receipt's ${envelope.selectorCommit}; an attempt is only ever settled under the binding it was sent ` +
          `under. Nothing was changed.`,
        { operationId: envelope.operationId },
      );
    }
    if (envelope.requestHash !== row.requestHash) {
      throw new StoreError(
        "remote.operation-conflict",
        `The receipt names request hash ${envelope.requestHash}, but operation ${envelope.operationId} is frozen under ` +
          `${row.requestHash}; evidence of another request never settles this intent. Nothing was changed.`,
        { operationId: envelope.operationId },
      );
    }
    if (row.attemptId === null || row.attemptId !== envelope.attemptId) {
      throw new StoreError(
        "remote.dispatch-refused",
        row.attemptId === null
          ? `Operation ${envelope.operationId} was never dispatched, so no attempt exists to ${source}; prepare and ` +
            `dispatch it, or abandon it. Nothing was changed.`
          : `The receipt names attempt ${envelope.attemptId}, but operation ${envelope.operationId} has attempt ` +
            `${row.attemptId}; evidence of another send never settles this attempt. Nothing was changed.`,
        { operationId: envelope.operationId },
      );
    }
    const outcome = receiptOutcome(envelope.outcome, "receipt.outcome");
    assertReceiptTargets(outcome, stored, envelope.operationId);
    const receiptHash = receiptHashOf(source, envelope, outcome);
    const recorded = db
      .prepare("select 1 as found from remote_outbox_receipts where operation_id = ? and receipt_hash = ?")
      .get(envelope.operationId, receiptHash) as { found?: number } | undefined;
    if (recorded !== undefined) {
      // invariant: The same submission replays its recorded evidence and never re-applies a state change.
      return intentRead(db, row, stored);
    }
    if (row.state !== "unconfirmed" && row.state !== "conflict") {
      throw new StoreError(
        "remote.dispatch-refused",
        `Operation ${envelope.operationId} is ${row.state}; only an unconfirmed or conflicted send accepts a new receipt ` +
          `or reconciliation. Nothing was changed.`,
        { operationId: envelope.operationId, state: row.state },
      );
    }
    const at = nowRfc3339();
    db.prepare(
      "insert into remote_outbox_receipts(operation_id, receipt_hash, source, outcome, evidence_json, recorded_at) " +
        "values (?, ?, ?, ?, ?, ?)",
    ).run(
      envelope.operationId,
      receiptHash,
      source,
      outcome.kind,
      JSON.stringify({
        attemptId: envelope.attemptId,
        generation: envelope.generation,
        observedAt: envelope.observedAt,
        operationId: envelope.operationId,
        outcome,
        projectId: envelope.projectId,
        requestHash: envelope.requestHash,
        selectorCommit: envelope.selectorCommit,
        source,
      }),
      at,
    );
    // invariant: A not-sent refusal leaves the state unconfirmed until explicit abandonment;
    // only exact evidence of the frozen effect or of a fork advances it.
    if (outcome.kind === "confirmed") {
      db.prepare("update remote_outbox set state = 'confirmed', updated_at = ? where operation_id = ? and state = ?").run(
        at,
        envelope.operationId,
        row.state,
      );
      invalidateConfirmedBase(db, row.generation, row.projectKey);
    } else if (outcome.kind === "conflict") {
      db.prepare("update remote_outbox set state = 'conflict', updated_at = ? where operation_id = ? and state = ?").run(
        at,
        envelope.operationId,
        row.state,
      );
    }
    return intentRead(db, intentRow(db, envelope.operationId), stored);
  });
}

function intentRead(db: StoreDb, row: OutboxIntentRow, stored: StoredRequest): RemoteIntentRead {
  return {
    version: 1,
    operationId: row.operationId,
    projectId: row.projectKey,
    generation: row.generation,
    state: row.state,
    attemptId: row.attemptId,
    requestHash: row.requestHash,
    binding: stored.request.binding,
    event: stored.request.event,
    target: stored.request.target,
    expectedHeads: stored.request.expectedHeads,
    executionKey: stored.request.executionKey ?? null,
    operator: stored.operator,
    reason: stored.reason,
    resolves: row.resolves,
    resolvedBy: row.resolvedBy,
    abandonReason: row.abandonReason,
    receipts: receiptRows(db, row.operationId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** note: `outbox-show`: one intent under the binding it was frozen under, never a send permit. */
export async function readRemoteIntent(context: StoreContext, operationId: string): Promise<RemoteIntentRead> {
  const target = linearId(operationId, "operationId");
  const handle = await openRemoteCache(context, "read");
  try {
    const row = intentRow(handle.db, target);
    const stored = storedRequest(row);
    assertFrozenBinding(handle.db, stored.request.binding, target);
    return intentRead(handle.db, row, stored);
  } finally {
    handle.close();
  }
}

/** note: The joined binding and observation one project's dispatch reads, as the cache holds it. */
function scopeRow(db: StoreDb, generation: number, projectKey: string): Record<string, unknown> | undefined {
  return (db
    .prepare(
      "select b.selector_commit, b.provider, b.workspace_id, b.team_id, b.provider_project_id, b.journal_issue_id, " +
        "b.writer_id, b.verified_at, b.verification_json, o.completeness, o.snapshot_json " +
        "from remote_bindings b left join remote_observations o " +
        "on o.generation = b.generation and o.project_key = b.project_key " +
        "where b.generation = ? and b.project_key = ?",
    )
    .get(generation, projectKey)) as Record<string, unknown> | undefined;
}

/** note: The observed heads of the target the frozen event replaces, from one complete snapshot. */
function observedHeads(snapshot: RemoteSnapshot, event: RemoteEvent, target: string | null): readonly string[] {
  if (event.change.kind === "project-replace") return snapshot.project.head ?? [];
  const native = snapshot.issues.find((issue) => issue.identity.issueId === target);
  if (native === undefined || native.mstar === null) return [];
  return native.mstar.head;
}

/**
 * invariant: A dispatch only issues its one permit against the CURRENT persisted head the frozen
 * event names. A create must still be unobserved; an adoption must still address an unmarked
 * issue; a replacement must cite exactly the head the snapshot observes.
 */
function assertDispatchBase(db: StoreDb, row: OutboxIntentRow, stored: StoredRequest): void {
  const scope = scopeRow(db, row.generation, row.projectKey);
  const refuse = (detail: string): never => {
    throw new StoreError(
      "remote.dispatch-refused",
      `${detail} Operation ${row.operationId} is not dispatched; re-observe the scope and prepare a fresh base, or ` +
        `abandon the intent while it is provably unsent.`,
      { operationId: row.operationId },
    );
  };
  if (scope === undefined || scope.completeness !== "complete" || typeof scope.snapshot_json !== "string") {
    return refuse(`The current observation of ${row.projectKey} is not complete, so no base can be proven for it.`);
  }
  let snapshot: RemoteSnapshot;
  try {
    snapshot = JSON.parse(scope.snapshot_json) as RemoteSnapshot;
  } catch {
    return refuse(`The stored observation of ${row.projectKey} is unreadable.`);
  }
  const event = stored.request.event;
  const target = stored.request.target;
  const expected = stored.request.expectedHeads;
  if (canonicalJson(expected) !== canonicalJson(event.parents)) {
    return refuse(`The frozen base and the frozen parents of ${row.operationId} disagree.`);
  }
  if (row.resolves !== null) {
    // invariant: A reviewed resolution's base is the fresh FULL fork evidence, not a complete snapshot head.
    const conflict = db
      .prepare(
        "select evidence_json from remote_outbox_receipts where operation_id = ? and outcome = 'conflict' " +
          "order by recorded_at desc limit 1",
      )
      .get(row.resolves) as { evidence_json?: unknown } | undefined;
    if (typeof conflict?.evidence_json !== "string") {
      return refuse(`The resolution of ${row.resolves} has no recorded fork evidence to prove its base against.`);
    }
    let fork: readonly string[];
    try {
      const parsed: unknown = JSON.parse(conflict.evidence_json);
      const body = record(parsed, "conflict");
      fork = digestHead(record(body, "conflict").outcome === undefined ? [] : (record(body.outcome, "conflict.outcome").observedHeads), "fork");
    } catch {
      return refuse(`The recorded fork evidence of ${row.resolves} is unreadable.`);
    }
    if (canonicalJson(fork) !== canonicalJson(stored.request.event.parents)) {
      return refuse(`The resolution's parents are not the fork heads ${row.resolves} recorded.`);
    }
    if (canonicalJson(observedHeads(snapshot, event, target)) !== canonicalJson(fork)) {
      return refuse(
        `The scope observed for ${row.projectKey} no longer carries the fork ${row.resolves} recorded; a changed provider ` +
          `base is never permission to send a resolution.`,
      );
    }
    return;
  }
  if (event.change.kind === "issue-create") {
    const created = event.change.issueRef;
    if (snapshot.issues.some((issue) => issue.mstar !== null && issue.mstar.issueRef === created)) {
      return refuse(`The reference of the create is already bound in the observed project, so it would duplicate a record.`);
    }
    if (expected.length !== 0) return refuse("A create starts from an empty base.");
    return;
  }
  if (event.change.kind === "issue-adopt") {
    const native = snapshot.issues.find((issue) => issue.identity.issueId === target);
    if (native === undefined) return refuse(`Provider issue ${String(target)} is not observed in ${row.projectKey}.`);
    if (native.mstar !== null) return refuse(`Provider issue ${String(target)} already carries the MStar marker ${native.mstar.issueRef}.`);
    if (expected.length !== 0) return refuse("An adoption starts from an empty base.");
    return;
  }
  if (canonicalJson(observedHeads(snapshot, event, target)) !== canonicalJson(expected)) {
    return refuse(
      `The observed head of the addressed record is not the frozen base of ${row.operationId}; the provider base moved ` +
        `since the intent was prepared.`,
    );
  }
}

/** note: The verified-writer and freshness facts a dispatch requires. */
function assertDispatchScope(scope: Record<string, unknown>, stored: StoredRequest, operationId: string): void {
  const refuse = (detail: string): never => {
    throw new StoreError(
      "remote.dispatch-refused",
      `${detail} Operation ${operationId} is not dispatched and no send permit was issued.`,
      { operationId },
    );
  };
  const writerId = typeof scope.writer_id === "string" ? scope.writer_id : null;
  if (stored.request.binding.writerId === null || writerId !== stored.request.binding.writerId) {
    return refuse(
      `The binding records no verified writer equal to ${String(stored.request.binding.writerId)}, so there is no sender ` +
        `this generation authorizes.`,
    );
  }
  if (typeof scope.verification_json !== "string" || outcomeLabel(scope.verification_json) !== "verified") {
    return refuse(`The latest access check of ${stored.request.binding.projectKey} is not a verified scope.`);
  }
  const verifiedAt = typeof scope.verified_at === "string" ? scope.verified_at : "";
  if (Math.abs(Date.now() - Date.parse(verifiedAt)) > REMOTE_SCOPE_TTL_MS) {
    return refuse(`The verified access check of ${stored.request.binding.projectKey} is no longer current.`);
  }
  if (typeof scope.snapshot_json !== "string") {
    return refuse(`No complete observation exists to prove the base for ${stored.request.binding.projectKey}.`);
  }
}

/**
 * `dispatchRemoteIntent` / `outbox-dispatch`: issue the ONE send permit for the oldest enqueued
 * intent of its binding, atomically marking it `unconfirmed` before returning it. The frozen
 * base is re-checked against the persisted current head; a lost permit response is never a
 * second permit, and an unresolved send, conflict or foreign older intent refuses first.
 */
export async function dispatchRemoteIntent(context: StoreContext, operationId: string): Promise<RemoteDispatchResult> {
  const target = linearId(operationId, "operationId");
  const location = resolveCollaborationLocation(context);
  const selection = remoteSelection(location);
  if (selection.phase !== "active") {
    throw new StoreError(
      "remote.dispatch-refused",
      `The checked selector generation ${String(selection.generation)} is draining, so no dispatch is admitted. ` +
        `Reconcile the outstanding intents under the previous binding and complete the reviewed transition; nothing was sent.`,
    );
  }
  const binding = readCollaborationBinding(context);
  if (binding === null || binding.version !== 3 || binding.state !== "active") {
    throw new StoreError(
      "collaboration.stale-binding",
      "This checkout holds no finalized remote binding, so no intent of it can be dispatched. Run the reviewed remote " +
        "bind first; nothing was sent.",
    );
  }
  return withRemoteCacheWrite(context, (handle) => {
    const db = handle.db;
    const row = intentRow(db, target);
    const stored = storedRequest(row);
    assertFrozenBinding(db, stored.request.binding, target);
    if (row.generation !== selection.generation || row.projectKey !== stored.request.binding.projectKey) {
      throw new StoreError(
        "collaboration.stale-binding",
        `Operation ${target} belongs to generation ${String(row.generation)}, not the checked generation ` +
          `${String(selection.generation)}; a dispatch of another generation is never admitted. Nothing was sent.`,
        { operationId: target },
      );
    }
    if (row.state === "unconfirmed") {
      // invariant: A lost permit response never issues another permit: the attempt id stays
      // with the outbox and only the durable state is returned.
      return { kind: "state", operationId: target, state: row.state, requestHash: row.requestHash } satisfies RemoteDispatchResult;
    }
    if (row.state !== "enqueued") {
      throw new StoreError(
        "remote.dispatch-refused",
        `Operation ${target} is ${row.state}; only an enqueued intent is dispatched. Inspect it with outbox-show and ` +
          `reconcile an uncertain attempt with outbox-reconcile. Nothing was sent.`,
        { operationId: target, state: row.state },
      );
    }
    const unresolved = db
      .prepare(
        "select operation_id, state from remote_outbox where generation = ? and project_key = ? and operation_id <> ? " +
          "and state in ('unconfirmed','conflict') order by created_at, operation_id limit 1",
      )
      .get(row.generation, row.projectKey, target) as { operation_id?: unknown; state?: unknown } | undefined;
    if (unresolved !== undefined) {
      const aheadId = typeof unresolved.operation_id === "string" ? unresolved.operation_id : "?";
      const aheadState = typeof unresolved.state === "string" ? unresolved.state : "?";
      throw new StoreError(
        "remote.dispatch-refused",
        `Operation ${aheadId} is ${aheadState}, so no further send is admitted until it is reconciled or resolved. ` +
          `Nothing was sent.`,
        { operationId: target, ahead: aheadId, aheadState },
      );
    }
    const oldest = db
      .prepare(
        "select operation_id from remote_outbox where generation = ? and project_key = ? and state = 'enqueued' " +
          "order by created_at, operation_id limit 1",
      )
      .get(row.generation, row.projectKey) as { operation_id?: unknown } | undefined;
    if (typeof oldest?.operation_id === "string" && oldest.operation_id !== target) {
      throw new StoreError(
        "remote.dispatch-refused",
        `Operation ${oldest.operation_id} was enqueued before ${target} and is still pending; sends are serialized in ` +
          `FIFO order per binding, so this intent waits. Nothing was sent.`,
        { operationId: target, ahead: oldest.operation_id, aheadState: "enqueued" },
      );
    }
    const scope = scopeRow(db, row.generation, row.projectKey);
    if (scope === undefined) {
      throw new StoreError(
        "collaboration.stale-binding",
        `The cache records no binding for ${row.projectKey} at generation ${String(row.generation)}; nothing was sent.`,
        { operationId: target },
      );
    }
    assertDispatchScope(scope, stored, target);
    assertDispatchBase(db, row, stored);
    const attemptId = randomUUID();
    const at = nowRfc3339();
    const changed = db
      .prepare(
        "update remote_outbox set state = 'unconfirmed', attempt_id = ?, updated_at = ? " +
          "where operation_id = ? and state = 'enqueued'",
      )
      .run(attemptId, at, target) as { changes?: number };
    if (changed.changes !== 1) {
      throw new StoreError(
        "remote.dispatch-refused",
        `Operation ${target} changed state while its permit was issued; no permit was returned. Inspect it with ` +
          `outbox-show before retrying. Nothing was sent.`,
        { operationId: target },
      );
    }
    return {
      kind: "permit",
      permit: {
        version: 1,
        attemptId,
        binding: stored.request.binding,
        operationId: target,
        requestHash: row.requestHash,
        frozenRequest: stored.request,
      },
    } satisfies RemoteDispatchResult;
  });
}

/**
 * `prepareRemoteResolution` / `outbox-resolve`: freeze a reviewed replacement event for one
 * conflicted intent. The replacement carries its own operation id, the SAME target and binding,
 * and the freshly observed complete fork-head set as parents; the original event is never
 * rewritten and its conflict proof is retained.
 */
export async function prepareRemoteResolution(
  context: StoreContext,
  conflictedOperationId: string,
  resolution: RemoteResolution,
): Promise<RemoteIntent> {
  const conflicted = linearId(conflictedOperationId, "conflictedOperationId");
  const operationId = linearId(resolution?.operationId, "operationId");
  const operator = text(resolution?.operator, "operator");
  const reason = text(resolution?.reason, "reason");
  if (operationId === conflicted) {
    throw new StoreError(
      "remote.operation-conflict",
      `A resolution is a new operation id; ${operationId} names the conflicted intent itself. Nothing was enqueued.`,
    );
  }
  const location = resolveCollaborationLocation(context);
  const selection = remoteSelection(location);
  if (selection.phase !== "active") {
    throw new StoreError(
      "collaboration.stale-binding",
      `The checked selector generation ${String(selection.generation)} is draining, so no resolution is prepared. ` +
        `Nothing was enqueued.`,
    );
  }
  return withRemoteCacheWrite(context, (handle) => {
    const db = handle.db;
    const original = intentRow(db, conflicted);
    const stored = storedRequest(original);
    assertFrozenBinding(db, stored.request.binding, conflicted);
    const binding = stored.request.binding;
    const event = remoteEvent(resolution.event, binding);
    if (event.operationId !== operationId) {
      invalid("resolution.event.operationId", "must name the resolution's own operation id");
    }
    if (event.projectId !== stored.request.event.projectId) {
      invalid("resolution.event.projectId", "must be the conflicted intent's project");
    }
    if (event.repoKey !== stored.request.event.repoKey) {
      invalid("resolution.event.repoKey", "must be the conflicted intent's repository");
    }
    const target = intentTarget(stored.request.target, event.change, binding);
    if (target !== stored.request.target) {
      invalid("resolution.event.change.kind", "a resolution keeps the conflicted intent's target");
    }
    const parents = event.parents;
    const existing = db
      .prepare("select generation, project_key, request_hash, state, created_at, updated_at from remote_outbox where operation_id = ?")
      .get(operationId) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      // note: An identical replay returns the same resolution intent; a different one is a new conflicting id.
      const recorded = intentRow(db, operationId);
      const recordedRequest = storedRequest(recorded);
      if (
        recorded.resolves === conflicted &&
        recordedRequest.operator === operator &&
        recordedRequest.reason === reason &&
        canonicalJson(recordedRequest.request.event) === canonicalJson(event)
      ) {
        return {
          version: 1,
          operationId,
          projectId: recorded.projectKey,
          generation: recorded.generation,
          state: recorded.state,
          requestHash: recorded.requestHash,
          target: recordedRequest.request.target,
          executionKey: recordedRequest.request.executionKey ?? null,
          replayed: true,
          createdAt: recorded.createdAt,
          updatedAt: recorded.updatedAt,
        } satisfies RemoteIntent;
      }
      throw new StoreError(
        "remote.operation-conflict",
        `Operation ${operationId} is already recorded under another request; a resolution is a new, unused operation id. ` +
          `Nothing was enqueued.`,
        { operationId },
      );
    }
    if (original.state !== "conflict") {
      throw new StoreError(
        "remote.operation-conflict",
        `Operation ${conflicted} is ${original.state}, not conflicted, so there is no fork a resolution may replace. ` +
          `Nothing was enqueued.`,
        { operationId: conflicted, state: original.state },
      );
    }
    const conflict = db
      .prepare(
        "select evidence_json from remote_outbox_receipts where operation_id = ? and outcome = 'conflict' " +
          "order by recorded_at desc limit 1",
      )
      .get(conflicted) as { evidence_json?: unknown } | undefined;
    if (typeof conflict?.evidence_json !== "string") {
      throw new StoreError(
        "remote.operation-conflict",
        `Operation ${conflicted} is conflicted but holds no recorded fork evidence, so a resolution cannot cite the ` +
          `observed heads it replaces. Reconcile the fork first. Nothing was enqueued.`,
        { operationId: conflicted },
      );
    }
    let fork: readonly string[];
    try {
      const parsed: unknown = JSON.parse(conflict.evidence_json);
      const outcome = record(record(parsed, "evidence").outcome, "evidence.outcome");
      fork = digestHead(outcome.observedHeads, "evidence.outcome.observedHeads");
    } catch {
      throw new StoreError(
        "collaboration.unreadable",
        `The recorded fork evidence of ${conflicted} is unreadable; nothing was enqueued.`,
        { operationId: conflicted },
      );
    }
    if (canonicalJson(parents) !== canonicalJson(fork)) {
      throw new StoreError(
        "remote.operation-conflict",
        `The resolution's parents must be the complete fork-head set ${conflicted} recorded; a partial fork never ` +
          `authorizes a replacement. Nothing was enqueued.`,
        { operationId: conflicted, fork },
      );
    }
    const requestJson = canonicalJson({
      binding,
      event,
      target,
      expectedHeads: parents,
      operator,
      reason,
    });
    const requestHash = createHash("sha256").update(requestJson, "utf8").digest("hex");
    const at = nowRfc3339();
    db.prepare(
      "insert into remote_outbox(operation_id, generation, project_key, request_hash, request_json, execution_key_json, " +
        "state, created_at, updated_at, resolves) values (?, ?, ?, ?, ?, null, 'enqueued', ?, ?, ?)",
    ).run(operationId, original.generation, original.projectKey, requestHash, requestJson, at, at, conflicted);
    db.prepare("update remote_outbox set resolved_by = ?, updated_at = ? where operation_id = ?").run(
      operationId,
      at,
      conflicted,
    );
    return {
      version: 1,
      operationId,
      projectId: original.projectKey,
      generation: original.generation,
      state: "enqueued",
      requestHash,
      target,
      executionKey: null,
      replayed: false,
      createdAt: at,
      updatedAt: at,
    } satisfies RemoteIntent;
  });
}

/**
 * `abandonRemoteIntent` / `outbox-abandon`: explicit abandonment, only before dispatch, or after
 * durable evidence that nothing was sent. An ambiguous effect is never abandoned as absent; the
 * reason and the attempt history are retained.
 */
export async function abandonRemoteIntent(
  context: StoreContext,
  input: Readonly<{ operationId: string; reason: string }>,
): Promise<RemoteIntent> {
  const operationId = linearId(input?.operationId, "operationId");
  const reason = text(input?.reason, "reason");
  return withRemoteCacheWrite(context, (handle) => {
    const db = handle.db;
    const row = intentRow(db, operationId);
    if (row.state === "abandoned") {
      throw new StoreError(
        "remote.dispatch-refused",
        `Operation ${operationId} is already abandoned (${String(row.abandonReason)}); an abandonment replays through ` +
          `outbox-show and is never rewritten.`,
        { operationId, state: row.state },
      );
    }
    if (row.state === "confirmed" || row.state === "conflict") {
      throw new StoreError(
        "remote.dispatch-refused",
        `Operation ${operationId} is ${row.state}; a confirmed or conflicted effect is resolved under its original ` +
          `binding, never abandoned. Nothing was changed.`,
        { operationId, state: row.state },
      );
    }
    if (row.state === "unconfirmed") {
      const notSent = db
        .prepare(
          "select 1 as found from remote_outbox_receipts where operation_id = ? and outcome = 'not-sent' limit 1",
        )
        .get(operationId) as { found?: number } | undefined;
      if (notSent === undefined) {
        throw new StoreError(
          "remote.dispatch-refused",
          `Operation ${operationId} was dispatched and holds no proof that nothing was sent; an ambiguous effect is never ` +
            `abandoned as absent. Reconcile it under its original binding, then resolve or abandon it with evidence. ` +
            `Nothing was changed.`,
          { operationId, state: row.state },
        );
      }
    }
    const at = nowRfc3339();
    db.prepare("update remote_outbox set state = 'abandoned', abandon_reason = ?, updated_at = ? where operation_id = ?").run(
      reason,
      at,
      operationId,
    );
    const stored = storedRequest(row);
    return {
      version: 1,
      operationId,
      projectId: row.projectKey,
      generation: row.generation,
      state: "abandoned",
      requestHash: row.requestHash,
      target: stored.request.target,
      executionKey: stored.request.executionKey ?? null,
      replayed: false,
      createdAt: row.createdAt,
      updatedAt: at,
    } satisfies RemoteIntent;
  });
}

// ---------------------------------------------------------------------------
// note: ordinary remote writers: a normalized intent instead of a local row
// ---------------------------------------------------------------------------

/** note: The observed scope one ordinary write freezes its base from. */
type ObservedScope = Readonly<{
  location: CollaborationLocation;
  selection: CollaborationSelection;
  binding: RemoteIntentBinding;
  snapshot: RemoteSnapshot;
}>;

/** note: The cache's materialized binding of one project, as the outbox freezes it. */
function materializedIntentBinding(scope: Record<string, unknown>, projectKey: string): RemoteIntentBinding {
  const text_ = (value: unknown, what: string): string => {
    if (typeof value !== "string" || value === "") {
      throw new StoreError("collaboration.unreadable", `The cache's binding for ${projectKey} has no readable ${what}; nothing was enqueued.`);
    }
    return value;
  };
  return {
    generation: 0,
    projectKey,
    selectorCommit: text_(scope.selector_commit, "selector commit"),
    provider: "linear",
    workspaceId: text_(scope.workspace_id, "workspace id"),
    teamId: text_(scope.team_id, "team id"),
    projectId: text_(scope.provider_project_id, "provider project id"),
    journalIssueId: text_(scope.journal_issue_id, "journal issue id"),
    writerId: typeof scope.writer_id === "string" ? scope.writer_id : null,
  };
}

/**
 * Read the project's current complete observation together with the binding it was frozen
 * under. An ordinary remote write needs an exact base: a partial, absent or stale observation
 * refuses instead of freezing a guessed parent set.
 */
async function readWriteScope(context: StoreContext, projectId: string): Promise<ObservedScope> {
  const location = resolveCollaborationLocation(context);
  const selection = remoteSelection(location);
  if (selection.phase !== "active") {
    throw new StoreError(
      "collaboration.stale-binding",
      `The checked selector generation ${String(selection.generation)} is draining, so no new remote intent is prepared. ` +
        `Nothing was enqueued.`,
    );
  }
  selectedProject(selection, projectId);
  const binding = readCollaborationBinding(context);
  if (binding === null || binding.version !== 3 || binding.state !== "active") {
    throw new StoreError(
      "collaboration.stale-binding",
      "This checkout holds no finalized remote binding, so a remote write cannot address its observed scope. Run the " +
        "reviewed remote bind first; nothing was enqueued.",
    );
  }
  const handle = await openRemoteCache(context, "read", { location, binding });
  try {
    const scope = scopeRow(handle.db, binding.generation, projectId);
    if (scope === undefined) {
      throw new StoreError(
        "remote.scope-mismatch",
        `Project ${projectId} is not bound at generation ${String(binding.generation)} in this cache; nothing was enqueued.`,
      );
    }
    if (scope.completeness !== "complete" || typeof scope.snapshot_json !== "string") {
      throw new StoreError(
        "remote.unavailable",
        `A remote write to project ${projectId} requires a complete, current observation. Run \`remote observe\` with the ` +
          `whole scope, then retry; nothing was enqueued.`,
      );
    }
    const verifiedAt = typeof scope.verified_at === "string" ? scope.verified_at : "";
    if (outcomeLabel(typeof scope.verification_json === "string" ? scope.verification_json : "{}") !== "verified") {
      throw new StoreError(
        "remote.unavailable",
        `A remote write to project ${projectId} requires a verified access check. Reverify the scope and resubmit the ` +
          `observation; nothing was enqueued.`,
      );
    }
    if (Math.abs(Date.now() - Date.parse(verifiedAt)) > REMOTE_SCOPE_TTL_MS) {
      throw new StoreError(
        "collaboration.observation-stale",
        `The access check of project ${projectId} is no longer current, so no base can be frozen for it. Reverify the ` +
          `scope and resubmit the observation; nothing was enqueued.`,
      );
    }
    let snapshot: RemoteSnapshot;
    try {
      snapshot = JSON.parse(scope.snapshot_json) as RemoteSnapshot;
    } catch {
      throw new StoreError(
        "collaboration.unreadable",
        `The stored observation of project ${projectId} is unreadable; nothing was enqueued.`,
      );
    }
    return {
      location,
      selection,
      binding: { ...materializedIntentBinding(scope, projectId), generation: binding.generation },
      snapshot,
    };
  } finally {
    handle.close();
  }
}

/** note: The observed issue one remote write addresses, with the project scope it was found in. */
type ObservedIssue = Readonly<{
  scope: ObservedScope;
  native: RemoteIssue;
  /** note: The bound project when the caller named none: the write still addresses exactly one. */
  projectId: string;
}>;

/**
 * Resolve the project one addressed issue lives in. A remote write addresses one project; a
 * caller that names none is answered by scanning the SELECTED projects only, and an issue the
 * caches do not observe is never guessed into an unbound project.
 */
async function resolveObservedIssue(
  context: StoreContext,
  addressed: string,
  projectId: string | undefined,
): Promise<ObservedIssue> {
  const byRef = ISSUE_REF_PATTERN.test(addressed);
  const candidates = projectId === undefined
    ? remoteSelection(resolveCollaborationLocation(context)).projects.map((project) => project.localProjectId)
    : [projectId];
  for (const candidate of candidates) {
    let scope: ObservedScope;
    try {
      scope = await readWriteScope(context, candidate);
    } catch (error) {
      // note: A project with no usable observation is skipped by the scan, never read as an absence.
      if (projectId !== undefined) throw error;
      if (
        error instanceof StoreError &&
        (error.code === "remote.unavailable" || error.code === "collaboration.observation-stale")
      ) {
        continue;
      }
      throw error;
    }
    const native = byRef
      ? scope.snapshot.issues.find((issue) => issue.mstar !== null && issue.mstar.issueRef === addressed)
      : scope.snapshot.issues.find((issue) => issue.identity.issueId === addressed);
    if (native !== undefined) return { scope, native, projectId: candidate };
  }
  throw new IssueError(
    "issue.not-found",
    `Issue ${addressed} is not observed in ${projectId === undefined ? "any selected project" : `project ${projectId}`}; ` +
      `nothing was enqueued.`,
  );
}

export type RemoteIssueWrite = Readonly<{
  projectId?: string;
  operationId: string;
  /** note: The change kind: a create writes the native description, adoption and replacement append a comment. */
  kind: "issue-create" | "issue-adopt" | "issue-replace";
  /** note: The stable reference a create mints and a change keeps. */
  issueRef?: string;
  /** note: The addressed issue, by stable reference or immutable provider id; absent for a create. */
  issueId?: string;
  /** note: The complete normalized subject, derived from the observed one (null for a create/adoption). */
  next(current: Record<string, unknown> | null): Record<string, unknown>;
  /** note: A composite's execution reservation, so the provider effect settles it. */
  executionKey?: RemoteIntentExecutionKey | null;
}>;

/**
 * note: A create's stable reference, derived from its operation id: one operation mints exactly
 * one reference, and a replay of that operation freezes the identical event instead of minting a
 * second identity for the same write.
 */
export function issueRefForOperation(operationId: string): string {
  const bytes = createHash("sha256").update(`issue-ref:${operationId}`, "utf8").digest();
  return `mstar:issue:${derivedUuid(bytes)}`;
}

/** note: A well-formed v4-shaped UUID from a digest, so a derived id satisfies the contract's id shape. */
function derivedUuid(bytes: Buffer): string {
  const hex = Buffer.from(bytes.subarray(0, 16)).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The replay of one ordinary write: an operation id that already holds a frozen intent returns
 * THAT intent, so a retried verb never re-derives a different subject (a minted reference, a
 * milestone id, a recorded time) and never rewrites the accepted request. The outbox remains the
 * authority for the identity: only the same id, kind and stable reference replay.
 */
async function replayedIntent(
  context: StoreContext,
  operationId: string,
  kind: RemoteEventChange["kind"],
  issueRef: string | null,
): Promise<RemoteIntent | null> {
  let read: RemoteIntentRead;
  try {
    read = await readRemoteIntent(context, operationId);
  } catch (error) {
    if (error instanceof StoreError && error.code === "remote.intent-not-found") return null;
    throw error;
  }
  if (read.event.change.kind !== kind || (issueRef !== null && read.event.change.kind !== "project-replace" && read.event.change.issueRef !== issueRef)) {
    throw new StoreError(
      "remote.operation-conflict",
      `Operation ${operationId} is already frozen as a ${read.event.change.kind} intent; a different write never replays ` +
        `under the same operation id. Submit a new id for the corrected request. Nothing was enqueued.`,
      { operationId, state: read.state },
    );
  }
  return {
    version: 1,
    operationId: read.operationId,
    projectId: read.projectId,
    generation: read.generation,
    state: read.state,
    requestHash: read.requestHash,
    target: read.target,
    executionKey: read.executionKey,
    replayed: true,
    createdAt: read.createdAt,
    updatedAt: read.updatedAt,
  };
}

/**
 * Freeze one ordinary ISSUE change as a durable remote intent: the caller supplies the
 * normalized subject it derived from the observed one, and this boundary proves the base,
 * the project and the binding before anything is enqueued. The caller then refuses with
 * `remote.effect-pending`: a durable enqueue is never business success.
 */
export async function prepareRemoteIssueWrite(context: StoreContext, write: RemoteIssueWrite): Promise<RemoteIntent> {
  const operationId = linearId(write?.operationId, "operationId");
  const kind = oneOf(write?.kind, ["issue-create", "issue-adopt", "issue-replace"] as const, "kind");
  const executionKey = write?.executionKey ?? null;
  const declaredRef = write?.issueRef === undefined ? null : assertIssueRef(write.issueRef);
  const replay = await replayedIntent(
    context,
    operationId,
    kind,
    // invariant: A create/adoption reference is derived from its operation id, so a replay repeats it.
    declaredRef ?? (kind === "issue-replace" ? null : issueRefForOperation(operationId)),
  );
  if (replay !== null) return replay;
  if (kind === "issue-create") {
    const issueRef = declaredRef ?? issueRefForOperation(operationId);
    if (write?.issueId !== undefined && write.issueId !== null) invalid("issueId", "must be absent for a create");
    const projectId = text(write?.projectId, "projectId");
    const scope = await readWriteScope(context, projectId);
    if (scope.snapshot.issues.some((issue) => issue.mstar !== null && issue.mstar.issueRef === issueRef)) {
      throw new StoreError(
        "remote.scope-mismatch",
        `Reference ${issueRef} is already bound in project ${projectId}; a create never duplicates an observed subject. ` +
          `Nothing was enqueued.`,
        { projectId, issueRef },
      );
    }
    return prepareRemoteIntent(context, {
      binding: scope.binding,
      event: {
        version: 1,
        repoKey: scope.location.repoKey,
        projectId,
        operationId,
        parents: [],
        change: { kind, issueRef, mstar: write.next(null) },
      },
      target: null,
      expectedHeads: [],
      executionKey,
    });
  }
  const addressed = text(write?.issueId, "issueId");
  const { scope, native, projectId } = await resolveObservedIssue(context, addressed, write.projectId);
  if (kind === "issue-adopt" && native.mstar !== null) {
    throw new StoreError(
      "remote.scope-mismatch",
      `Provider issue ${native.identity.issueId} already carries the MStar marker ${native.mstar.issueRef}; an adoption ` +
        `addresses only an observed unmarked native issue. Nothing was enqueued.`,
      { projectId, issueId: native.identity.issueId },
    );
  }
  if (kind === "issue-replace" && native.mstar === null) {
    throw new IssueError(
      "issue.not-found",
      `Provider issue ${native.identity.issueId} carries no MStar subject, so no replacement addresses it; nothing was enqueued.`,
    );
  }
  const issueRef = assertIssueRef(write?.issueRef ?? native.mstar?.issueRef);
  if (native.mstar !== null && native.mstar.issueRef !== issueRef) {
    throw new StoreError(
      "remote.scope-mismatch",
      `Provider issue ${native.identity.issueId} carries reference ${native.mstar.issueRef}, not ${issueRef}; ` +
        `nothing was enqueued.`,
      { projectId, issueId: native.identity.issueId },
    );
  }
  const parents = native.mstar === null ? [] : native.mstar.head;
  return prepareRemoteIntent(context, {
    binding: scope.binding,
    event: {
      version: 1,
      repoKey: scope.location.repoKey,
      projectId,
      operationId,
      parents,
      change: { kind, issueRef, mstar: write.next(native.mstar === null ? null : currentIssueSubject(native.mstar)) },
    },
    target: native.identity.issueId,
    expectedHeads: parents,
    executionKey,
  });
}

/** note: The frozen issue subject is the stored one minus its derived members. */
function currentIssueSubject(mstar: RemoteMstarIssue): Record<string, unknown> {
  return {
    fields: mstar.fields,
    occurrences: mstar.occurrences,
    transitions: mstar.transitions,
    relations: mstar.relations,
    provenance: mstar.provenance,
    projectMoves: mstar.projectMoves,
  };
}

export type RemoteProjectWrite = Readonly<{
  projectId: string;
  operationId: string;
  /** note: The complete normalized project document, derived from the observed one and its project's issues. */
  next(current: Record<string, unknown>, issues: readonly RemoteIssue[]): Record<string, unknown>;
  executionKey?: RemoteIntentExecutionKey | null;
}>;

/**
 * Freeze one ordinary PROJECT-JOURNAL change (milestones, roadmap, portable catalog) as a
 * durable remote intent against the observed journal head. Never a local SQL effect.
 */
export async function prepareRemoteProjectWrite(context: StoreContext, write: RemoteProjectWrite): Promise<RemoteIntent> {
  const projectId = text(write?.projectId, "projectId");
  const operationId = linearId(write?.operationId, "operationId");
  const replay = await replayedIntent(context, operationId, "project-replace", null);
  if (replay !== null) return replay;
  const scope = await readWriteScope(context, projectId);
  const parents = scope.snapshot.project.head ?? [];
  const subject = write.next(
    {
      projectId,
      milestones: scope.snapshot.project.milestones,
      roadmap: scope.snapshot.project.roadmap,
      catalogEntities: scope.snapshot.project.catalogEntities,
      catalogLinks: scope.snapshot.project.catalogLinks,
    },
    scope.snapshot.issues,
  );
  return prepareRemoteIntent(context, {
    binding: scope.binding,
    event: {
      version: 1,
      repoKey: scope.location.repoKey,
      projectId,
      operationId,
      parents,
      change: { kind: "project-replace", project: subject },
    },
    target: scope.binding.journalIssueId,
    expectedHeads: parents,
    executionKey: write.executionKey ?? null,
  });
}

/**
 * invariant: The ordinary business verbs' outcome of a remote write. A durable enqueue is never
 * mapped to business success: the caller returns this refusal with the actual outbox state, and
 * only the recorded receipt (outbox-show) is the confirmed outcome.
 */
export function pendingRemoteEffect(intent: RemoteIntent): StoreError {
  const confirmed = intent.state === "confirmed";
  return new StoreError(
    "remote.effect-pending",
    confirmed
      ? `Operation ${intent.operationId} is recorded and its provider effect is confirmed. Read the recorded outcome with ` +
        `\`outbox-show\`; this route never reports a local business receipt for a remote write.`
      : `The write is durably enqueued as operation ${intent.operationId} in state ${intent.state}. It is not a business ` +
        `success yet: dispatch it with \`outbox-dispatch\`, then record the provider result with \`outbox-receipt\`. ` +
        `Inspect it with \`outbox-show\`.`,
    {
      operationId: intent.operationId,
      state: intent.state,
      confirmedComponents: confirmed ? ["provider:confirmed"] : [],
      recovery: confirmed
        ? "Read `outbox-show --operation <id>` for the recorded receipt."
        : "`outbox-show` for the state, `outbox-dispatch` for the one send permit, `outbox-receipt` for the result.",
    },
  );
}
