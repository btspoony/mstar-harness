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
import { isDeepStrictEqual } from "node:util";
import {
  conflictRepairSettled,
  hasConfirmedReceipt,
  hasReceiptLedger,
  readCollaborationBinding,
  REMOTE_CACHE_REBUILD_ROUTE,
  initializeRemoteCacheStore,
  ISSUE_REF_PATTERN,
  localPredecessorRetiredPath,
  mintIssueRef,
  openRemoteCache,
  openRemoteCacheRecovery,
  readLocalPredecessorLane,
  retireLocalPredecessorLane,
  writeRemoteCacheStage,
  writeRemoteCollaborationBinding,
  withRemoteCacheRecoveryWrite,
  withRemoteCacheWrite,
  withRemoteCacheWriteHeld,
  assertIssueRef,
  assertRemoteCacheIdentity,
  type CollaborationAuthority,
  type CollaborationBinding,
  type CollaborationStoreHandle,
  type IssueRef,
} from "./collaboration-store.js";
import { DOCUMENT_KIND_NAMES, type CatalogDocumentKind } from "./catalog.js";
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
import { declinedReservationCause } from "./execution-store.js";
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

/**
 * note: The inspection-sample gap seam: a regression binds a successor between the v3 sample an
 * inspection discloses under and the cache open that admits it. Production runs without a callback.
 */
let remoteIntentSampleGapForTest: (() => void | Promise<void>) | undefined;
export function setRemoteIntentSampleGapForTest(callback: (() => void | Promise<void>) | undefined): void {
  remoteIntentSampleGapForTest = callback;
}

/**
 * note: The write-scope gap seam: a regression re-observes the scope between the sampled base a
 * caller deduped against and the write that freezes against it. Production runs without a callback.
 */
let remoteWriteScopeGapForTest: (() => void | Promise<void>) | undefined;
export function setRemoteWriteScopeGapForTest(callback: (() => void | Promise<void>) | undefined): void {
  remoteWriteScopeGapForTest = callback;
}

/**
 * note: The replay-admission gap seam: a regression completes a concurrent same-id attempt
 * between the replay admission that saw no durable row and the scope read that decides the
 * write, so the write is decided against the state the winner's settled effect produced.
 * Production runs without a callback.
 */
let remoteReplayAdmissionGapForTest: (() => void | Promise<void>) | undefined;
export function setRemoteReplayAdmissionGapForTest(callback: (() => void | Promise<void>) | undefined): void {
  remoteReplayAdmissionGapForTest = callback;
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
  effortSessions: number | null;
  status: "planned" | "active" | "delivered" | "dropped";
  ordinal: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}>;

export type RemoteCatalogEntity = Readonly<{
  kind: "project" | "iteration" | "plan" | "document";
  id: string;
  title: string;
  description: string | null;
  /** see packages/engine/src/collaboration-remote.ts - The catalog's own kind vocabulary, not arbitrary text: the retired value never reaches a DTO. */
  documentKind: CatalogDocumentKind | null;
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
  catalogEntities: readonly RemoteCatalogEntity[];
  catalogLinks: readonly RemoteCatalogLink[];
}>;

/**
 * invariant: The ONE place a retired catalog kind is removed from admitted evidence. It runs on the parsed
 * document - never the stored bytes - so both the read boundary and the write/freeze boundary speak the
 * surviving vocabulary while the admitted evidence stays exactly what the predecessor wrote. Identity,
 * revision and registration are untouched; only the retired value changes.
 */
export function normalizeRetiredDocumentKind(snapshot: RemoteSnapshot): RemoteSnapshot {
  const project = snapshot.project as unknown as { catalogEntities?: Array<Record<string, unknown>> } | undefined;
  if (project === undefined || !Array.isArray(project.catalogEntities)) return snapshot;
  for (const entity of project.catalogEntities) {
    if (entity.documentKind === "roadmap") entity.documentKind = "other";
  }
  return snapshot;
}

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

/** note: The header as read from the input: `snapshot` stays raw until ingest proves its fidelity. */
type ObservationHeader = Omit<ObservationSubmission, "snapshot"> & Readonly<{ snapshot: unknown }>;

// ---------------------------------------------------------------------------
// note: Narrow DTO validation. Every message names the offending field path so a
// Host Agent author can fix the document, never guess.
// ---------------------------------------------------------------------------

const RCF3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
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
 * refuses the whole observation and invalidates the addressed cache, so no reader
 * keeps serving the previous snapshot as current.
 */
function unsafeFidelity(path: string, detail: string): never {
  throw new StoreError("remote.unsafe-fidelity", `${path}: ${detail}. The addressed cache is invalidated instead of serving it.`);
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
    // shortcut: a URL the parser rejects is refused only by its visible home path; upgrade: when a malformed form can carry a credential.
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

/**
 * note: Reject every member the contract does not name, so no unlisted material reaches the cache.
 * With `errors` supplied, the unknown members are collected instead of thrown, so one refusal can
 * answer the whole submitted document.
 */
function allowOnly(
  body: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
  errors?: string[],
): void {
  for (const key of Object.keys(body)) {
    if (allowed.includes(key)) continue;
    if (errors === undefined) invalid(`${path}.${key}`, "is not a contract field");
    errors.push(`${path}.${key}: is not a contract field`);
  }
}

/** note: One collected diagnostic's text, without the refusal sentence the aggregate adds once. */
function diagnosticOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.endsWith(NOTHING_WRITTEN) ? message.slice(0, -NOTHING_WRITTEN.length) : message;
}

const NOTHING_WRITTEN = ". Nothing was written.";

/** note: Read one member, or collect its diagnostic and fall back while the aggregate is being built. */
function collected<T>(errors: string[] | undefined, read: () => T, fallback: T): T {
  if (errors === undefined) return read();
  try {
    return read();
  } catch (error) {
    // invariant: `remote.unsafe-fidelity` is its own refusal class (the observation boundary
    // records and replays it), so it is never flattened into a structural aggregate.
    if (error instanceof StoreError && error.code === "remote.unsafe-fidelity") throw error;
    errors.push(diagnosticOf(error));
    return fallback;
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

/**
 * note: A project's provider tuple, validated without the issue identity. With `errors`, every
 * member is collected instead of failing on the first defect. Unknown keys are the caller's
 * check: the identity names one more member than the scope does.
 */
function projectScope(value: unknown, path: string, errors?: string[]): ProviderProjectScope {
  const body = record(value, path);
  return {
    provider: collected(errors, () => oneOf(body.provider, ["linear"] as const, `${path}.provider`), "linear"),
    workspaceId: collected(errors, () => linearId(body.workspaceId, `${path}.workspaceId`), ""),
    teamId: collected(errors, () => linearId(body.teamId, `${path}.teamId`), ""),
    projectId: collected(errors, () => linearId(body.projectId, `${path}.projectId`), ""),
  };
}

function issueIdentity(value: unknown, path: string, errors?: string[]): ProviderIssueIdentity {
  const body = record(value, path);
  allowOnly(body, path, ["provider", "workspaceId", "teamId", "projectId", "issueId"], errors);
  return { ...projectScope(body, path, errors), issueId: collected(errors, () => linearId(body.issueId, `${path}.issueId`), "") };
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
  if (Object.hasOwn(body, "target")) invalid(`${path}.target`, '"target" is retired; submit "effortSessions" as null or an integer of at least 1 (a count of standard sessions)');
  return {
    milestoneId: text(body.milestoneId, `${path}.milestoneId`),
    name: text(body.name, `${path}.name`),
    effortSessions: body.effortSessions === null ? null : positiveInteger(body.effortSessions, `${path}.effortSessions`),
    status: oneOf(body.status, ["planned", "active", "delivered", "dropped"], `${path}.status`),
    ordinal: nonNegativeInteger(body.ordinal, `${path}.ordinal`),
    revision: positiveInteger(body.revision, `${path}.revision`),
    createdAt: instant(body.createdAt, `${path}.createdAt`),
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
  // see packages/engine/src/collaboration-remote.ts - // invariant: The retired catalog kind is refused by path here, before any write: the project
  // snapshot's catalog entries carry the same vocabulary the local catalog verbs enforce, so a
  // retired value cannot re-enter through the remote surface.
  if (documentKind !== null && !(DOCUMENT_KIND_NAMES as readonly string[]).includes(documentKind)) {
    invalid(`${path}.documentKind`, `is not a document kind; expected one of ${DOCUMENT_KIND_NAMES.join(", ")}`);
  }
  return {
    kind: oneOf(body.kind, CATALOG_KINDS, `${path}.kind`),
    id: text(body.id, `${path}.id`),
    title: text(body.title, `${path}.title`),
    description: optionalText(body.description, `${path}.description`),
    documentKind: documentKind as CatalogDocumentKind | null,
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

function mstarFields(value: unknown, path: string, errors?: string[]): Record<string, unknown> {
  const body = collected(errors, () => record(value, path), {} as Record<string, unknown>);
  allowOnly(body, path, MSTAR_FIELD_KEYS, errors);
  return {
    title: collected(errors, () => text(body.title, `${path}.title`), ""),
    kind: collected(errors, () => oneOf(body.kind, ISSUE_KINDS, `${path}.kind`), "bug"),
    severity: collected(errors, () => oneOf(body.severity, ISSUE_SEVERITIES, `${path}.severity`), "high"),
    disposition: collected(errors, () => oneOf(body.disposition, ISSUE_DISPOSITIONS, `${path}.disposition`), "open"),
    impact: collected(errors, () => text(body.impact, `${path}.impact`), ""),
    acceptance: collected(errors, () => text(body.acceptance, `${path}.acceptance`), ""),
    owner: collected(errors, () => nullableString(body.owner, `${path}.owner`), null),
    registeredAt: collected(errors, () => nullableInstant(body.registeredAt, `${path}.registeredAt`), null),
    closedAt: collected(errors, () => nullableInstant(body.closedAt, `${path}.closedAt`), null),
    closureNote: collected(errors, () => nullableString(body.closureNote, `${path}.closureNote`), null),
    createdAt: collected(errors, () => instant(body.createdAt, `${path}.createdAt`), ""),
    updatedAt: collected(errors, () => instant(body.updatedAt, `${path}.updatedAt`), ""),
    revision: collected(errors, () => positiveInteger(body.revision, `${path}.revision`), 0),
    milestoneId: collected(errors, () => nullableString(body.milestoneId, `${path}.milestoneId`), null),
  };
}

const OCCURRENCE_KEYS = [
  "eventId", "occurrenceKey", "sourceKind", "sourceIdentity", "rootCauseKey", "acceptanceKey", "location",
  "observedBehavior", "evidence", "discoveredAt", "recordedAt", "imported",
] as const;

function occurrence(value: unknown, path: string, errors?: string[]): Record<string, unknown> {
  const body = record(value, path);
  allowOnly(body, path, OCCURRENCE_KEYS, errors);
  return {
    eventId: collected(errors, () => eventId(body.eventId, `${path}.eventId`), ""),
    occurrenceKey: collected(errors, () => text(body.occurrenceKey, `${path}.occurrenceKey`), ""),
    sourceKind: collected(errors, () => text(body.sourceKind, `${path}.sourceKind`), ""),
    sourceIdentity: collected(errors, () => text(body.sourceIdentity, `${path}.sourceIdentity`), ""),
    rootCauseKey: collected(errors, () => text(body.rootCauseKey, `${path}.rootCauseKey`), ""),
    acceptanceKey: collected(errors, () => text(body.acceptanceKey, `${path}.acceptanceKey`), ""),
    location: collected(errors, () => text(body.location, `${path}.location`), ""),
    observedBehavior: collected(errors, () => text(body.observedBehavior, `${path}.observedBehavior`), ""),
    evidence: collected(errors, () => stringList(body.evidence, `${path}.evidence`), []),
    discoveredAt: collected(errors, () => nullableInstant(body.discoveredAt, `${path}.discoveredAt`), null),
    recordedAt: collected(errors, () => instant(body.recordedAt, `${path}.recordedAt`), ""),
    // note: The domain's imported provenance is a business field of the history, not a private detail.
    imported: collected(errors, () => boolean(body.imported, `${path}.imported`), false),
  };
}

/**
 * invariant: Freezing a new intent applies the issue domain's dedup rule; an
 * observed chain is provider evidence and is never re-judged by this boundary.
 */
function frozenOccurrence(value: unknown, path: string, errors?: string[]): Record<string, unknown> {
  const row = occurrence(value, path, errors);
  return {
    ...row,
    rootCauseKey: collected(errors, () => semanticKey(row.rootCauseKey, `${path}.rootCauseKey`), ""),
    acceptanceKey: collected(errors, () => semanticKey(row.acceptanceKey, `${path}.acceptanceKey`), ""),
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

function transitionEvidence(value: unknown, path: string, errors?: string[]): Record<string, unknown> {
  const body = record(value, path);
  allowOnly(body, path, TRANSITION_EVIDENCE_KEYS, errors);
  const evidence: Record<string, unknown> = {};
  for (const key of TRANSITION_EVIDENCE_KEYS) {
    if (!(key in body)) continue;
    evidence[key] = collected(
      errors,
      () =>
        key === "references" ? stringList(body.references, `${path}.references`) : nullableString(body[key], `${path}.${key}`),
      key === "references" ? [] : null,
    );
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

function importedRecord(value: unknown, path: string, errors?: string[]): Record<string, string | null> {
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
      const message = `${path}.${key}: duplicates ${legacy}; send one spelling`;
      if (errors === undefined) invalid(`${path}.${key}`, `duplicates ${legacy}; send one spelling`);
      errors.push(message);
    }
    if (!(legacy in body) && !(key in body)) continue;
    // note: A refusal names the spelling the sender used, so the offending field is findable.
    // `portableValue` stays outside the collector: its fidelity refusal is its own class.
    const sent = legacy in body ? legacy : key;
    const read = () => portableValue(body[sent], `${path}.${sent}`);
    if (errors === undefined) {
      portable[key] = read();
      continue;
    }
    try {
      portable[key] = read();
    } catch (error) {
      if (error instanceof StoreError && error.code !== "remote.unsafe-fidelity") {
        errors.push(diagnosticOf(error));
        portable[key] = null;
        continue;
      }
      throw error;
    }
  }
  if (Object.keys(portable).length === 0) {
    const message = `${path}: must carry the imported record's business fields (legacy id, title, lifecycle, ...)`;
    if (errors === undefined) invalid(path, "must carry the imported record's business fields (legacy id, title, lifecycle, ...)");
    errors.push(message);
  }
  return portable;
}

function transition(value: unknown, path: string, errors?: string[]): Record<string, unknown> {
  const body = record(value, path);
  allowOnly(body, path, TRANSITION_KEYS, errors);
  if (!("evidence" in body)) {
    const message = `${path}.evidence: must be present (the recorded transition evidence)`;
    if (errors === undefined) invalid(`${path}.evidence`, "must be present (the recorded transition evidence)");
    errors.push(message);
  }
  const imported = collected(errors, () => boolean(body.imported, `${path}.imported`), false);
  return {
    eventId: collected(errors, () => eventId(body.eventId, `${path}.eventId`), ""),
    fromDisposition: collected(errors, () => oneOf(body.fromDisposition, ISSUE_DISPOSITIONS, `${path}.fromDisposition`), "open"),
    toDisposition: collected(errors, () => oneOf(body.toDisposition, ISSUE_DISPOSITIONS, `${path}.toDisposition`), "open"),
    actor: collected(errors, () => nullableString(body.actor, `${path}.actor`), null),
    occurredAt: collected(errors, () => nullableInstant(body.occurredAt, `${path}.occurredAt`), null),
    recordedAt: collected(errors, () => instant(body.recordedAt, `${path}.recordedAt`), ""),
    reason: collected(errors, () => text(body.reason, `${path}.reason`), ""),
    evidence: imported
      ? importedRecord(body.evidence, `${path}.evidence`, errors)
      : transitionEvidence(body.evidence, `${path}.evidence`, errors),
    issueRevision: collected(errors, () => nonNegativeInteger(body.issueRevision, `${path}.issueRevision`), 0),
    imported,
  };
}

const RELATION_KEYS = ["relation", "target"] as const;

function relation(value: unknown, path: string, errors?: string[]): Record<string, unknown> {
  const body = record(value, path);
  allowOnly(body, path, RELATION_KEYS, errors);
  return {
    relation: collected(errors, () => oneOf(body.relation, ISSUE_RELATIONS, `${path}.relation`), "related"),
    // note: A dangling target stays as the spellable reference; the read boundary renders it unresolved.
    target: collected(errors, () => assertIssueRef(text(body.target, `${path}.target`)), "mstar:issue:00000000-0000-4000-8000-000000000000"),
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
function provenanceRecord(body: Record<string, unknown>, path: string, errors?: string[]): Record<string, string | null> | null {
  if ("legacyJson" in body && "legacyRecord" in body) {
    const message = `${path}.legacyRecord: duplicates legacyJson; send one representation`;
    if (errors === undefined) invalid(`${path}.legacyRecord`, "duplicates legacyJson; send one representation");
    errors.push(message);
  }
  if ("legacyRecord" in body) {
    return body.legacyRecord === null ? null : importedRecord(body.legacyRecord, `${path}.legacyRecord`, errors);
  }
  if (!("legacyJson" in body) || body.legacyJson === null) return null;
  const raw = body.legacyJson;
  if (typeof raw !== "string") unsafeFidelity(`${path}.legacyJson`, "must be the legacy row's JSON text or null");
  // shortcut: one legacy register row is a small JSON document; 64 KiB is far above any
  // observed row, and a larger one is refused rather than parsed unbounded.
  // upgrade: when a legacy register row can exceed 64 KiB.
  if (raw.length > 64 * 1024) unsafeFidelity(`${path}.legacyJson`, "is too large to be one legacy register row");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    unsafeFidelity(`${path}.legacyJson`, "is not JSON the reviewed representation can read");
  }
  return importedRecord(parsed, `${path}.legacyJson`, errors);
}

function provenanceLink(value: unknown, path: string, errors?: string[]): Record<string, unknown> {
  const body = record(value, path);
  allowOnly(body, path, PROVENANCE_KEYS, errors);
  // note: `portableValue` stays outside the collector: its fidelity refusal is its own class.
  const readTarget = () => {
    const target = portableValue(text(body.target, `${path}.target`), `${path}.target`);
    if (target === null) invalid(`${path}.target`, "must be a non-empty string");
    return target;
  };
  const readHash = () => {
    const sourceHash = text(body.sourceHash, `${path}.sourceHash`);
    if (!SHA256.test(sourceHash)) invalid(`${path}.sourceHash`, "must be a canonical lowercase SHA-256 digest");
    return sourceHash;
  };
  return {
    eventId: collected(errors, () => eventId(body.eventId, `${path}.eventId`), ""),
    kind: collected(errors, () => oneOf(body.kind, provenanceKinds(), `${path}.kind`), "plan"),
    target: collected(errors, readTarget, ""),
    sourceHash: collected(errors, readHash, ""),
    origin: collected(errors, () => oneOf(body.origin, ["scoped", "unscoped"] as const, `${path}.origin`), "scoped"),
    legacyProject: collected(errors, () => portableValue(body.legacyProject, `${path}.legacyProject`), null),
    legacyBucket: collected(errors, () => portableValue(body.legacyBucket, `${path}.legacyBucket`), null),
    legacyEntryId: collected(errors, () => portableValue(body.legacyEntryId, `${path}.legacyEntryId`), null),
    legacyRecord: provenanceRecord(body, path, errors),
    importedAt: collected(errors, () => nullableInstant(body.importedAt, `${path}.importedAt`), null),
  };
}

const PROJECT_MOVE_KEYS = ["eventId", "fromProject", "toProject", "actor", "reason", "occurredAt", "issueRevision"] as const;

function projectMove(value: unknown, path: string, errors?: string[]): Record<string, unknown> {
  const body = record(value, path);
  allowOnly(body, path, PROJECT_MOVE_KEYS, errors);
  return {
    eventId: collected(errors, () => eventId(body.eventId, `${path}.eventId`), ""),
    fromProject: collected(errors, () => text(body.fromProject, `${path}.fromProject`), ""),
    toProject: collected(errors, () => text(body.toProject, `${path}.toProject`), ""),
    actor: collected(errors, () => text(body.actor, `${path}.actor`), ""),
    reason: collected(errors, () => text(body.reason, `${path}.reason`), ""),
    occurredAt: collected(errors, () => instant(body.occurredAt, `${path}.occurredAt`), ""),
    issueRevision: collected(errors, () => nonNegativeInteger(body.issueRevision, `${path}.issueRevision`), 0),
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
  // see packages/engine/src/collaboration-remote.ts - // invariant: The project document's members are the contract's own. The retired `roadmap` member
  // is refused by name at its path, and its absence is the only accepted shape - the shape was
  // revised in place, so the submission stays `version: 1`.
  allowOnly(project, "submission.snapshot.project", ["projectId", "head", "binding", "milestones", "catalogEntities", "catalogLinks"]);
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
      catalogEntities,
      catalogLinks,
    },
    issues,
  };
}

function observationSubmission(value: unknown): ObservationHeader {
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
    snapshot: body.snapshot,
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
  // invariant: A pre-v3 cache is replaced only after the bytes about to go are proven to be the
  // generation this checkout recorded, so the release never discards another record's cache.
  const staged = await initializeRemoteCacheStore(
    location,
    recorded !== null && recorded.version === 3 ? { storeId: recorded.storeId, epoch: recorded.epoch } : undefined,
  );
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
      if (isRecord(previous)) assertCheckAdvances(selected.localProjectId, check, previous, { replayUnsafeFidelity: false });
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
 * a conflicting tie cannot replace the recorded one. Three asymmetric ties are
 * admitted: a byte-identical replay, an addressed negative check tied with a
 * recorded positive - a revocation invalidates serving even in the same
 * millisecond - and, only where `replayUnsafeFidelity` says this submission is the
 * decoded `unsafe-fidelity` refusal it is admitted for, the exact positive check
 * such an observation recorded under its negative outcome. The reverse never holds:
 * a tied positive cannot reverse a recorded negative and restore the binding.
 */
function assertCheckAdvances(
  projectId: string,
  check: ScopeCheck,
  recorded: Record<string, unknown>,
  options: Readonly<{ replayUnsafeFidelity: boolean }>,
): void {
  if (typeof recorded.verified_at !== "string") return;
  const prior = Date.parse(recorded.verified_at);
  const current = Date.parse(check.checkedAt);
  if (current > prior) return;
  if (current === prior) {
    if (recorded.verification_json === JSON.stringify(serializeCheck(check))) return;
    // invariant: A decoder-detected fidelity refusal records the submitted check under its
    // effective negative outcome, so the observation resubmitting exactly that check is a
    // replay rather than a stale timestamp. Only that replay admits it: a bind never restores
    // verification or the writer from a refusal it would not re-record.
    if (
      options.replayUnsafeFidelity &&
      check.outcome.kind === "verified" &&
      recordedOutcome(recorded) === "unsafe-fidelity" &&
      recorded.verification_json === JSON.stringify(serializeCheck({ ...check, outcome: { kind: "unsafe-fidelity" } }))
    ) return;
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
 * projection and is then returned as its named refusal. A snapshot whose portable
 * representation cannot keep a field is refused the same way: the addressed cache
 * is invalidated with `remote.unsafe-fidelity` before that refusal is reported.
 * A positive check requires the whole project snapshot (never a diff: the cache
 * replaces the project atomically) and commits at `expectRevision`; a stale base
 * refuses `collaboration.observation-stale` and a known gap is stored as `partial`.
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

  // note: Snapshot fidelity is proven here rather than while reading the header: content the
  // portable representation cannot keep invalidates the addressed cache with its named refusal,
  // so the previously served snapshot never stays current behind a refused observation.
  let snapshotValue: RemoteSnapshot | null = null;
  let unsafe: StoreError | null = null;
  if (submission.snapshot !== null) {
    try {
      snapshotValue = snapshot(submission.snapshot, submission.check);
    } catch (error) {
      if (error instanceof StoreError && error.code === "remote.unsafe-fidelity") unsafe = error;
      else throw error;
    }
  }

  const outcome = await withRemoteCacheWrite(context, ({ db }) =>
    recordObservation(db, submission, negative, snapshotValue, unsafe),
    // note: An observation is the ONLY way to refresh the access check a settlement re-proves, so it is
    // admitted on a v3 cache exactly as the settlement verbs are: refusing it there left an expired
    // check behind an unsettled intent with no route forward (the replacement refuses while it is unsettled).
    { settleOutbox: true },
  );

  // invariant: The invalidation is durable BEFORE its refusal is reported: a caller that saw
  // the error still finds the cache marked unavailable.
  if ("refused" in outcome) throw outcome.refused;
  return outcome.recorded;
}

/** note: One submission's whole cache transaction, run under the writer's guarded connection. */
function recordObservation(
  db: StoreDb,
  submission: ObservationHeader,
  negative: StoreError | null,
  snapshotValue: RemoteSnapshot | null,
  unsafe: StoreError | null,
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
  // invariant: Only the branch that re-persists a decoded `unsafe-fidelity` refusal may replay
  // the check that refusal was recorded from. A snapshot that now decodes is a positive
  // observation, and a tied positive never restores what the refusal revoked.
  assertCheckAdvances(submission.check.projectId, submission.check, stored, {
    replayUnsafeFidelity: unsafe !== null,
  });
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
  const refusal = negative ?? unsafe;
  // invariant: The check itself becomes the binding's latest evidence before either branch,
  // so status, freshness and ordering all read the verification a reader can see. A negative
  // check stands as submitted, and a snapshot the portable representation cannot keep is
  // recorded under that same named outcome: the submitted verification alone must never keep
  // disclosing frozen content or naming a writer. Either refusal revokes the writer in this
  // same transaction, so no permit — reviewed resolutions included — survives behind it.
  const recordedCheck =
    negative === null && unsafe !== null ? { ...submission.check, outcome: { kind: "unsafe-fidelity" as const } } : submission.check;
  db.prepare(
    "update remote_bindings set verified_at = ?, verification_json = ?, writer_id = ? " +
      "where generation = ? and project_key = ?",
  ).run(
    submission.check.checkedAt,
    JSON.stringify(serializeCheck(recordedCheck)),
    refusal === null && submission.check.outcome.kind === "verified" ? submission.check.outcome.writerId : null,
    submission.generation,
    submission.check.projectId,
  );
  if (refusal !== null) {
    // invariant: A revocation or a snapshot the portable representation cannot keep invalidates
    // serving as soon as it is submitted. It never waits for the snapshot replacement CAS to
    // match: a host that last read an older revision must still invalidate.
    db.prepare(
      "update remote_observations set revision = ?, as_of = null, completeness = 'unavailable', code = ?, " +
        "snapshot_json = null, received_at = ? where generation = ? and project_key = ?",
    ).run(next, refusal.code, at, submission.generation, submission.check.projectId);
    db.prepare("delete from remote_issue_identities where generation = ? and project_key = ?").run(
      submission.generation,
      submission.check.projectId,
    );
    return { refused: refusal };
  }
  if (submission.expectRevision !== revision) {
    throw new StoreError(
      "collaboration.observation-stale",
      `The submission expects observation revision ${String(submission.expectRevision)}, but the cache holds ` +
        `${String(revision)} for ${submission.check.projectId}. Re-read the scope and resubmit; nothing was written.`,
    );
  }
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
 * note: The genesis subject an adoption appends: the reviewed complete MStar subject for `retain`,
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
 * note: The intent a replay answered. A verb that admits no no-change outcome refuses an
 * established claim instead of mapping it to a success.
 */
function replayedOnly(outcome: RemoteIntent | RemoteNoChange, operationId: string): RemoteIntent {
  if ("noChange" in outcome) {
    throw new StoreError(
      "remote.operation-conflict",
      `Operation ${operationId} records an established no-change write; this verb is a different request and needs a ` +
        `new operation id. Nothing was enqueued.`,
      { operationId },
    );
  }
  return outcome;
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
  // invariant: A `retain` keeps the reviewed reference; a `new` adoption mints it once from its
  // operation id, so the identical replay names the same reference instead of a second one.
  const issueRef = adoption.kind === "retain" ? adoption.issueRef : issueRefForOperation(operationId);
  // invariant: An already-frozen adoption is a replay of THIS verb, so it answers its stored
  // operation before inspecting a base the adoption itself changed (a marked native issue, or the
  // snapshot its confirmation invalidated). Only a first freeze inspects the observed issue.
  const replay = await replayedIntent(context, operationId, "issue-adopt", projectId, issueId, issueRef, null, {
    verb: "issue-adopt",
    request: { projectId, issueId, adoption },
  });
  if (replay !== null) return replayedOnly(replay, operationId);
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
  return frozenIntent(await prepareRemoteIssueWrite(context, {
    projectId,
    operationId,
    issueRef,
    issueId,
    kind: "issue-adopt",
    next: () => subject,
    // invariant: A replay compares the reviewed adoption document, never the ids and times its
    // first freeze generated: only the identical adoption replays under this operation id.
    origin: { verb: "issue-adopt", request: { projectId, issueId, adoption } },
  }));
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

/**
 * note: The composite RESERVATION a provider intent belongs to. It is not persisted: the freeze
 * honors it only to prove that reservation is still `prepared`, so a decline that committed while
 * the attempt was already admitted cannot be followed by a durable intent under it.
 */
export type RemoteReservationKey = Readonly<{
  executionStoreId: string;
  executionEpoch: number;
  operationId: string;
}>;

/**
 * note: The business verb and its COMPLETE normalized request, as the ordinary writer that froze
 * the intent received them. Two different verbs (or payloads) never replay as one operation, and
 * neither does a changed request: the final document they produced is not their identity.
 */
export type RemoteWriteOrigin = Readonly<{
  verb: string;
  request: Record<string, unknown>;
}>;

export type RemoteIntentRequest = Readonly<{
  binding: RemoteIntentBinding;
  event: RemoteEvent;
  target: string | null;
  expectedHeads: readonly string[];
  executionKey?: RemoteIntentExecutionKey | null;
  /** note: Present on an ordinary writer's intent; the low-level prepare and a resolution carry none. */
  origin?: RemoteWriteOrigin | null;
  /** note: The business result the writer derived from the observed document, recorded for its replay. */
  result?: unknown;
}>;

export type RemoteIntentState = "enqueued" | "unconfirmed" | "confirmed" | "conflict" | "abandoned";

/** note: The provider record a confirmed receipt proved, kept so a business replay can report it. */
export type RemoteConfirmedEffect = Readonly<{
  identity: ProviderIssueIdentity;
  recordId: string;
  event: RemoteEvent;
}>;

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
  /** note: The recorded confirmed effect, so a replay of the business verb reports it instead of pending. */
  confirmed: RemoteConfirmedEffect | null;
  /** note: The business result recorded when the request was frozen, so its replay reports that exact result. */
  result: unknown | null;
  replayed: boolean;
  createdAt: string;
  updatedAt: string;
}>;

/**
 * note: The states a row holds while it still needs settlement - exactly what the listing reports.
 * A `confirmed` or `abandoned` row is settled and never listed.
 */
const REMOTE_UNSETTLED_STATES = ["enqueued", "unconfirmed", "conflict"] as const;
type RemoteUnsettledState = (typeof REMOTE_UNSETTLED_STATES)[number];

/** note: A pending summary: enough to order, select and settle an intent, never a send permit. */
export type RemotePendingIntent = Readonly<{
  operationId: string;
  projectId: string;
  state: RemoteUnsettledState;
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
 * note: The canonical content digest of one event: the head a child event cites as its parent, so
 * a conflict's named heads are proved against the records they claim to name.
 */
export function remoteEventHead(event: RemoteEvent): string {
  return createHash("sha256").update(canonicalJson(event), "utf8").digest("hex");
}

/** note: Two head lists name the same records exactly when the same head sits at every index. */
function sameHeads(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((head, index) => head === right[index]);
}

/** note: Plain JSON, normalized: what a frozen business request or result may carry, nothing else. */
function plainJson(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // note: JSON has no undefined: an absent optional member is dropped, an absent array slot is null.
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry, index) => plainJson(entry, `${path}[${index}]`));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, plainJson(entry, `${path}.${key}`)]),
    );
  }
  return invalid(path, "must be plain JSON");
}

/** note: The frozen origin of one ordinary write: its verb and the complete request it was made from. */
function writeOrigin(value: unknown, path: string): RemoteWriteOrigin {
  const body = record(value, path);
  allowOnly(body, path, ["verb", "request"]);
  return {
    verb: text(body.verb, `${path}.verb`),
    request: record(plainJson(body.request, `${path}.request`), `${path}.request`),
  };
}

/**
 * invariant: The event's issue subject is the complete normalized MStar document
 * with the same field allowlists the snapshot applies, minus the derived `head`
 * and the outer duplicate `issueRef`. An empty or partial subject never freezes.
 */
function frozenIssueSubject(value: unknown, path: string, errors?: string[]): Record<string, unknown> {
  const body = collected(errors, () => record(value, path), {} as Record<string, unknown>);
  if ("head" in body) invalid(`${path}.head`, "is derived and is not frozen");
  if ("issueRef" in body) invalid(`${path}.issueRef`, "duplicates the event's reference");
  allowOnly(body, path, ["fields", "occurrences", "transitions", "relations", "provenance", "projectMoves"], errors);
  // invariant: Each history ENTRY is its own collection boundary: a malformed entry (a null row, a
  // bad field) names its own diagnostic and the sibling entries after it are still read, so one
  // refusal answers every history defect of the subject.
  return {
    fields: mstarFields(body.fields, `${path}.fields`, errors),
    occurrences: collected(errors, () => list(body.occurrences, `${path}.occurrences`), []).map((entry, index) =>
      collected(errors, () => frozenOccurrence(entry, `${path}.occurrences[${index}]`, errors), {}),
    ),
    transitions: collected(errors, () => list(body.transitions, `${path}.transitions`), []).map((entry, index) =>
      collected(errors, () => transition(entry, `${path}.transitions[${index}]`, errors), {}),
    ),
    relations: collected(errors, () => list(body.relations, `${path}.relations`), []).map((entry, index) =>
      collected(errors, () => relation(entry, `${path}.relations[${index}]`, errors), {}),
    ),
    provenance: collected(errors, () => list(body.provenance, `${path}.provenance`), []).map((entry, index) =>
      collected(errors, () => provenanceLink(entry, `${path}.provenance[${index}]`, errors), {}),
    ),
    projectMoves: collected(errors, () => list(body.projectMoves, `${path}.projectMoves`), []).map((entry, index) =>
      collected(errors, () => projectMove(entry, `${path}.projectMoves[${index}]`, errors), {}),
    ),
  };
}

/**
 * invariant: The event's project subject is the snapshot's normalized project
 * document - every member present, no derived `head`, no `binding` (the
 * selected transport scope supplies it) and nothing outside the allowlist.
 */
function frozenProjectSubject(value: unknown, path: string, projectKey: string, errors?: string[]): Record<string, unknown> {
  const body = collected(errors, () => record(value, path), {} as Record<string, unknown>);
  if ("head" in body) invalid(`${path}.head`, "is derived and is not frozen");
  if ("binding" in body) invalid(`${path}.binding`, "is supplied by the selected scope");
  allowOnly(body, path, ["projectId", "milestones", "catalogEntities", "catalogLinks"], errors);
  const projectId = collected(errors, () => text(body.projectId, `${path}.projectId`), "");
  if (projectId !== "" && projectId !== projectKey) {
    const message = `${path}.projectId: must be the event's project`;
    if (errors === undefined) invalid(`${path}.projectId`, "must be the event's project");
    errors.push(message);
  }
  // invariant: Each collection is its own boundary, and a uniqueness check runs only on the
  // identities that PARSED: a placeholder row names no id, so it can never fabricate a duplicate
  // that hides the diagnostic of the row it stands in for.
  const repeated = (member: string, keys: readonly string[], detail: string): void => {
    if (new Set(keys).size === keys.length) return;
    if (errors === undefined) invalid(`${path}.${member}`, detail);
    errors.push(`${path}.${member}: ${detail}`);
  };
  const milestones = collected(errors, () => list(body.milestones, `${path}.milestones`), []).map((entry, index) =>
    collected(errors, () => milestone(entry, `${path}.milestones[${index}]`), {} as unknown as RemoteMilestone),
  );
  repeated(
    "milestones",
    milestones.map((entry) => entry.milestoneId).filter((id): id is string => typeof id === "string" && id !== ""),
    "must not repeat a milestone id",
  );
  const catalogEntities = collected(errors, () => list(body.catalogEntities, `${path}.catalogEntities`), []).map(
    (entry, index) =>
      collected(errors, () => catalogEntity(entry, `${path}.catalogEntities[${index}]`), {} as unknown as RemoteCatalogEntity),
  );
  repeated(
    "catalogEntities",
    catalogEntities
      .filter((entry) => typeof entry.kind === "string" && typeof entry.id === "string")
      .map((entry) => `${entry.kind}:${entry.id}`),
    "must not repeat a (kind, id) pair",
  );
  return {
    projectId,
    milestones,
    catalogEntities,
    catalogLinks: collected(errors, () => list(body.catalogLinks, `${path}.catalogLinks`), []).map((entry, index) =>
      collected(errors, () => catalogLink(entry, `${path}.catalogLinks[${index}]`), {} as unknown as RemoteCatalogLink),
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

function remoteEvent(raw: unknown, binding: RemoteIntentBinding, errors?: string[], path = "request.event"): RemoteEvent {
  const body = record(raw, path);
  allowOnly(body, path, ["version", "repoKey", "projectId", "operationId", "parents", "change"], errors);
  const versionOk = body.version === 1;
  if (!versionOk) {
    const message = `${path}.version: must be 1`;
    if (errors === undefined) invalid(`${path}.version`, "must be 1");
    errors.push(message);
  }
  const repoKey = collected(errors, () => text(body.repoKey, `${path}.repoKey`), "");
  const projectId = collected(errors, () => text(body.projectId, `${path}.projectId`), "");
  const operationId = collected(errors, () => linearId(body.operationId, `${path}.operationId`), "");
  // note: The project check is meaningful only against the caller's own binding; the receipt's
  // placeholder binding derives no project, so the collected mode skips it.
  if (errors === undefined && projectId !== binding.projectKey) {
    invalid(`${path}.projectId`, "must be the binding's project");
  }
  const parents = collected(errors, () => digestHead(body.parents, `${path}.parents`), []);
  const change = record(body.change, `${path}.change`);
  const kind = oneOf(change.kind, REMOTE_CHANGE_KINDS, `${path}.change.kind`);
  // invariant: `[]` is initial genesis or adoption only: a replacement cites the heads it replaces.
  if (kind === "issue-replace" && parents.length === 0) {
    if (errors === undefined) invalid(`${path}.parents`, "a replacement must cite at least one replaced head");
    errors.push(`${path}.parents: a replacement must cite at least one replaced head`);
  }
  let frozen: RemoteEventChange;
  if (kind === "project-replace") {
    allowOnly(change, `${path}.change`, ["kind", "project"], errors);
    frozen = { kind, project: frozenProjectSubject(change.project, `${path}.change.project`, projectId, errors) };
  } else {
    allowOnly(change, `${path}.change`, ["kind", "issueRef", "mstar"], errors);
    frozen = {
      kind,
      issueRef: collected(
        errors,
        () => {
          if (typeof change.issueRef !== "string" || !ISSUE_REF_PATTERN.test(change.issueRef)) {
            invalid(`${path}.change.issueRef`, "must be an 'mstar:issue:<lowercase uuid>' reference");
          }
          return change.issueRef as IssueRef;
        },
        "",
      ),
      mstar: frozenIssueSubject(change.mstar, `${path}.change.mstar`, errors),
    };
  }
  return { version: 1, repoKey, projectId, operationId, parents, change: frozen };
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
 *
 * `guard` runs INSIDE the freeze transaction, after an identical replay has answered, so a caller
 * holding an observed revision proves it against the lane the intent is actually written to.
 *
 * `reservation` names the composite reservation this intent belongs to. It is proved INSIDE the
 * same write lane, before the row is written: a decline holds that lane across its own durable
 * phase, so a reservation declined while this attempt was already admitted refuses here instead of
 * freezing an intent the decline's replay could never finalize.
 */
export async function prepareRemoteIntent(
  context: StoreContext,
  request: unknown,
  guard?: (observed: { observationRevision: number }, db: StoreDb) => void,
  reservation?: RemoteReservationKey | null,
): Promise<RemoteIntent> {
  const body = record(request, "request");
  allowOnly(body, "request", [
    "binding", "event", "target", "expectedHeads", "executionKey", "origin", "result",
  ]);
  const binding = intentBinding(body.binding);
  const event = remoteEvent(body.event, binding);
  const target = intentTarget(body.target, event.change, binding);
  const expectedHeads = digestHead(body.expectedHeads, "request.expectedHeads");
  const origin = body.origin === undefined || body.origin === null ? null : writeOrigin(body.origin, "request.origin");
  const result = body.result === undefined ? null : plainJson(body.result, "request.result");
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
  // note: The request hash covers exactly the contract's four members; the business origin and the
  // result it derived are recorded beside them, so neither changes an operation's identity.
  const frozenRequest = { binding, event, target, expectedHeads };
  const requestHash = createHash("sha256").update(canonicalJson(frozenRequest), "utf8").digest("hex");
  const requestJson =
    origin === null && result === null
      ? canonicalJson(frozenRequest)
      : canonicalJson({ ...frozenRequest, origin, result });
  const executionJson = executionKey === null ? null : canonicalJson(executionKey);

  const insert = (handle: CollaborationStoreHandle): RemoteIntent => {
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
        "select generation, project_key, request_hash, state, created_at, updated_at, execution_key_json, request_json " +
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
            `reused only with the identical binding, request and execution key; inspect it with ` +
            `\`mstar store collaboration remote outbox-show --harness <abs> --operation <uuid>\` and submit a new id ` +
            `for a corrected write. Nothing was enqueued.`,
          { operationId: event.operationId, state: existing.state, durable_intent: true },
        );
      }
      return intentOf(
        event.operationId,
        target,
        existing,
        binding,
        executionKey,
        confirmedEffectOf(db, event.operationId),
        recordedResult(existing.request_json, event.operationId),
        true,
      );
    }
    const at = nowRfc3339();
    // invariant: The caller's observed base is proved against the lane this row is written to, in
    // the same transaction: an observation or a competing effect that landed after the caller read
    // it refuses instead of overwriting the newer base.
    guard?.({ observationRevision: observationRevisionOf(db, binding.generation, binding.projectKey) }, db);
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
      confirmed: null,
      result,
      replayed: false,
      createdAt: at,
      updatedAt: at,
    } satisfies RemoteIntent;
  };
  if (reservation === undefined || reservation === null) return withRemoteCacheWrite(context, insert);
  // invariant: A composite's freeze takes the SAME lane the decline holds across its durable
  // phase, and proves the reservation's phase inside it: a decline that committed while this
  // attempt was already admitted refuses the freeze instead of leaving a durable intent under a
  // reservation whose same-id replay only raises the decline.
  return withRemoteCacheWriteHeld(context, async (handle) => {
    const declined = await declinedReservationCause(context, reservation);
    if (declined !== null) throw declinedReservationRefusal(reservation, declined);
    return insert(handle);
  });
}

/** note: The freeze's refusal of a reservation that was declined while this attempt was admitted. */
function declinedReservationRefusal(
  reservation: RemoteReservationKey,
  cause: Readonly<{ code: string; message: string; details: Record<string, unknown> | null }>,
): StoreError {
  return new StoreError(
    "collaboration.operation-partial",
    `The composite reservation ${JSON.stringify(reservation.operationId)} was declined durably before this provider ` +
      `intent was frozen (${cause.code}: ${cause.message}), so nothing was enqueued and no provider state is claimed. ` +
      `The next same-id attempt replays that recorded decline; issue the corrected request under a NEW operation id.`,
    {
      operation_id: reservation.operationId,
      phase: "declined",
      cause: { code: cause.code, message: cause.message, ...(cause.details === null ? {} : { details: cause.details }) },
      recovery:
        `Reissue the SAME verb with the SAME --operation id to replay the recorded decline, or issue the corrected ` +
        `request under a NEW operation id.`,
    },
  );
}

const REMOTE_INTENT_STATES: readonly RemoteIntentState[] = [
  "enqueued",
  "unconfirmed",
  "confirmed",
  "conflict",
  "abandoned",
];

/** note: The outcome of one composite decline the frame decides under the freeze's own lane. */
export type FreezeDeclineDecision =
  | { kind: "declined" }
  | { kind: "durable"; operationIds: readonly string[] }
  | { kind: "unproven"; error: unknown }
  | { kind: "unsettled"; error: unknown };

/**
 * invariant: The composite decline and the provider freeze are ONE pair of decisions over the
 * remote outbox, so both take the remote-cache write lane and neither leaves the lane while its
 * decision is undecided:
 * - a durable intent found here retains the reservation, so a winner that froze before this
 *   decision is never declined away (the absence check is INSIDE the decline's own lane, not a
 *   sample taken beside it);
 * - the durable execution decline is committed WHILE the lane is held, so a freeze that begins
 *   afterwards meets `prepareRemoteIntent`'s own declined-reservation proof inside the same lane
 *   and refuses instead of enqueuing.
 * A lane that cannot be read proves nothing either way (`unproven`): the reservation is retained.
 */
export async function declineUnderFreezeLane(
  context: StoreContext,
  operationIds: readonly string[],
  decline: () => Promise<{ settled: true } | { settled: false; error: unknown }>,
): Promise<FreezeDeclineDecision> {
  if (operationIds.length === 0) {
    const settlement = await decline();
    return settlement.settled ? { kind: "declined" } : { kind: "unsettled", error: settlement.error };
  }
  try {
    return await withRemoteCacheWriteHeld(context, async (handle) => {
      const durable = operationIds.filter(
        (operationId) =>
          handle.db.prepare("select 1 as found from remote_outbox where operation_id = ?").get(operationId) !== undefined,
      );
      if (durable.length > 0) return { kind: "durable" as const, operationIds: durable };
      const settlement = await decline();
      return settlement.settled ? { kind: "declined" as const } : { kind: "unsettled" as const, error: settlement.error };
    });
  } catch (error) {
    return { kind: "unproven", error };
  }
}

/**
 * note: The one confirmed receipt an intent recorded, re-validated through the contract's
 * outcome reader. It is the business outcome a replay of the original verb reports; an
 * unreadable or non-confirmed record yields null instead of a guessed effect.
 */
function confirmedEffectOf(db: StoreDb, operationId: string): RemoteConfirmedEffect | null {
  const row = db
    .prepare(
      "select evidence_json from remote_outbox_receipts where operation_id = ? and outcome = 'confirmed' " +
        "order by recorded_at, receipt_hash limit 1",
    )
    .get(operationId) as { evidence_json?: unknown } | undefined;
  if (typeof row?.evidence_json !== "string") return null;
  try {
    const evidence = record(JSON.parse(row.evidence_json), "receipt");
    const outcome = receiptOutcomeOf(evidence.outcome, operationId);
    return outcome.kind === "confirmed"
      ? { identity: outcome.identity, recordId: outcome.recordId, event: outcome.event }
      : null;
  } catch {
    return null;
  }
}

/** note: The recorded business result of one frozen request, or null when the writer recorded none. */
function recordedResult(requestJson: unknown, operationId: string): unknown {
  if (typeof requestJson !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestJson);
  } catch {
    throw malformedIntent(operationId, "carries no readable frozen request");
  }
  const body = record(parsed, "request");
  return body.result === undefined ? null : plainJson(body.result, "request.result");
}

/** note: The stored row projected for a caller, never a send permit: no attempt id leaves this module. */
function intentOf(
  operationId: string,
  target: string | null,
  row: Record<string, unknown>,
  binding: RemoteIntentBinding,
  executionKey: RemoteIntentExecutionKey | null,
  confirmed: RemoteConfirmedEffect | null,
  result: unknown,
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
    confirmed,
    result,
    replayed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * `outbox-pending`: every unsettled intent of the current binding - `enqueued`, `unconfirmed` or
 * `conflict` - FIFO by `(createdAt, operationId)`, as summaries carrying their state, and without a
 * send permit or an attempt id. It is a read: no send right is implied by listing, and a settled
 * (`confirmed` or `abandoned`) row is never listed. A `conflict` row is settled by the SAME rule
 * the cache-replacement guard applies: when its `resolvedBy` repair chain reaches a `confirmed`
 * repair holding its recorded confirmed receipt. Listing such a parent would send the operator to
 * `outbox-resolve`, which refuses while that live resolution stands.
 */
export async function readPendingIntents(context: StoreContext, projectId: string): Promise<RemotePendingIntents> {
  const project = text(projectId, "projectId");
  const location = resolveCollaborationLocation(context);
  const selection = remoteSelection(location);
  selectedProject(selection, project);
  // note: Recovery reads admit the PINNED previous generation while the selector drains; the
  // listing carries no send right, so it is exactly what an operator needs to reconcile.
  const draining = selection.phase === "draining" && selection.previous?.mode === "remote";
  const generation = draining ? selection.previous!.generation : selection.generation;
  // note: Recovery read: admits a below-current cache whose inventory this build still declares,
  // restricted to the outbox surface — this listing is exactly the guard's first recovery step.
  const handle = await openRemoteCacheRecovery(context, "read", undefined, { previousDuringDraining: draining });
  try {
    const rows = handle.db
      .prepare(
        "select operation_id, generation, project_key, state, resolved_by, request_hash, request_json, created_at " +
          "from remote_outbox " +
          `where generation = ? and project_key = ? and state in (${REMOTE_UNSETTLED_STATES.map(() => "?").join(", ")}) ` +
          "order by created_at, operation_id",
      )
      .all(generation, project, ...REMOTE_UNSETTLED_STATES) as PendingOutboxRow[];
    // invariant: The listing and the cache-replacement guard settle a conflict row by ONE rule, so
    // they can never disagree about the same row: a parent whose repair chain is settled is not
    // awaiting settlement, and offering it would route the operator to a refusing `outbox-resolve`.
    const receiptsPresent = hasReceiptLedger(handle.db);
    return {
      version: 1,
      projectId: project,
      generation,
      intents: rows
        .filter((row) => !(receiptsPresent && conflictRepairSettled(handle.db, row, receiptsPresent)))
        .map((row) => pendingIntentOf(row, project)),
    };
  } finally {
    handle.close();
  }
}

/** note: The outbox columns the settle rule and the listed summary both read. */
type PendingOutboxRow = {
  operation_id: string;
  generation: unknown;
  project_key: unknown;
  state: string;
  resolved_by: unknown;
  request_hash: string;
  request_json: string;
  created_at: string;
};

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
  const state = row.state;
  if (typeof state !== "string" || !REMOTE_UNSETTLED_STATES.includes(state as RemoteUnsettledState)) return unreadable();
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
    state: state as RemoteUnsettledState,
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

/**
 * note: `outbox-show`: the durable state plus, only while the scope's current read permission
 * holds, the frozen request and its evidence. `disclosure:"metadata"` withholds every frozen
 * content member (see Q2: expired/denied access exposes metadata only); it is never a send permit.
 */
export type RemoteIntentRead = Readonly<{
  version: 1;
  operationId: string;
  projectId: string;
  generation: number;
  state: RemoteIntentState;
  attemptId: string | null;
  requestHash: string;
  binding: RemoteIntentBinding;
  disclosure: "full" | "metadata";
  /** note: The recorded confirmed effect, so the business verb's replay reports it; withheld with the content. */
  confirmed: RemoteConfirmedEffect | null;
  event: RemoteEvent | null;
  /**
   * note: The recorded replay identity of a settled no-change claim; `event` is null for it, since a
   * claim never represents observed history as a provider event. Withheld with the content.
   */
  settled: Readonly<{ kind: RemoteEventChange["kind"]; issueRef: IssueRef }> | null;
  target: string | null;
  expectedHeads: readonly string[];
  executionKey: RemoteIntentExecutionKey | null;
  /** note: The business verb and request the writer froze; withheld with the content. */
  origin: RemoteWriteOrigin | null;
  /** note: The business result recorded at preparation; withheld with the content. */
  result: unknown | null;
  operator: string | null;
  reason: string | null;
  /**
   * note: The stored request was written before the effort contract and read under it: its
   * milestone `target` members were normalized to `effortSessions: null` at read time. Reported
   * regardless of disclosure - it is the row's provenance, never frozen content.
   */
  normalizedFromLegacy: boolean;
  resolves: string | null;
  resolvedBy: string | null;
  abandonReason: string | null;
  receipts: readonly RemoteReceiptRecord[];
  createdAt: string;
  updatedAt: string;
}>;

/**
 * note: `outbox-dispatch` evidence for a reviewed resolution: one host-attested traversal of the
 * fork's stream that began after the conflict evidence and terminated, carrying the complete,
 * sorted fork-head set. The engine validates it; the provider traversal itself is the host's.
 */
export type ForkObservation = Readonly<{
  version: 1;
  selectorCommit: string;
  generation: number;
  projectId: string;
  conflictOperationId: string;
  asOf: string;
  coverage: "complete";
  heads: readonly Readonly<{ recordId: string; issueRef: string; head: string }>[];
}>;

/** note: The one permit one dispatch issues: the frozen request, one attempt id. */
export type RemoteDispatchPermit = Readonly<{
  version: 1;
  attemptId: string;
  binding: RemoteIntentBinding;
  operationId: string;
  requestHash: string;
  frozenRequest: RemoteIntentRequest;
  /** note: The frozen request was read under the pre-upgrade contract and normalized to the current one. */
  normalizedFromLegacy: boolean;
  /** note: The observation the base was proven against: its generation, cache revision and traversal start. */
  observation: Readonly<{ generation: number; revision: number; asOf: string | null }>;
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
  origin: RemoteWriteOrigin | null;
  result: unknown | null;
  /** note: The stored request was read under the pre-upgrade contract and normalized to the current one. */
  legacyRead: boolean;
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
/** note: One stored request's reading: unmodified, normalized from the uniform pre-upgrade shape, or mixed. */
type LegacyReading = Readonly<{ body: unknown; legacy: boolean }>;

/**
 * invariant: A frozen request is read under the contract that FROZE it. The effort contract
 * retired a milestone's calendar `target` for a session count, and a date is not a count. The old
 * writer had one shape: a genuine pre-upgrade request carries `target` on EVERY milestone row and
 * `effortSessions` on NONE. Exactly that uniform shape is normalized (each milestone reads as
 * unestimated, `effortSessions: null`) and is reported as such. Anything else that carries
 * `target` - a partially written or hand-edited row that mixes the two members - is a
 * contradiction no writer ever produced: `mixed` refuses as unreadable instead of driving a send.
 * A new submission is unaffected - `milestone` still refuses `target` at the boundary, so the
 * widening is the stored path's alone.
 */
function legacyFrozenRequest(parsed: unknown): LegacyReading | "mixed" {
  if (typeof parsed !== "object" || parsed === null) return { body: parsed, legacy: false };
  const event = (parsed as Record<string, unknown>).event;
  if (typeof event !== "object" || event === null) return { body: parsed, legacy: false };
  const change = (event as Record<string, unknown>).change;
  if (typeof change !== "object" || change === null) return { body: parsed, legacy: false };
  const project = (change as Record<string, unknown>).project;
  if (typeof project !== "object" || project === null) return { body: parsed, legacy: false };
  const milestones = (project as Record<string, unknown>).milestones;
  if (!Array.isArray(milestones)) return { body: parsed, legacy: false };
  let withTarget = 0;
  let withSessions = 0;
  for (const entry of milestones) {
    if (typeof entry !== "object" || entry === null) continue;
    if (Object.hasOwn(entry, "target")) withTarget += 1;
    if (Object.hasOwn(entry, "effortSessions")) withSessions += 1;
  }
  if (withTarget === 0) return { body: parsed, legacy: false };
  // invariant: The pre-upgrade shape was uniform. A row where some milestones carry `target`,
  // or one carries both members, is damage - not a legacy row to normalize.
  if (withTarget !== milestones.length || withSessions !== 0) return "mixed";
  for (const entry of milestones) {
    if (typeof entry !== "object" || entry === null) continue;
    const milestone = entry as Record<string, unknown>;
    delete milestone.target;
    if (!Object.hasOwn(milestone, "effortSessions")) milestone.effortSessions = null;
  }
  return { body: parsed, legacy: true };
}

function storedRequest(row: OutboxIntentRow): StoredRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.requestJson);
  } catch {
    throw malformedIntent(row.operationId, "carries no readable frozen request");
  }
  const legacy = legacyFrozenRequest(parsed);
  if (legacy === "mixed") {
    throw malformedIntent(
      row.operationId,
      "mixes the retired milestone `target` with `effortSessions` - no writer produced that shape",
    );
  }
  try {
    const body = record(legacy.body, "request");
    allowOnly(body, "request", [
      "binding", "event", "target", "expectedHeads", "executionKey", "operator", "reason", "origin", "result",
    ]);
    const binding = intentBinding(body.binding);
    const event = remoteEvent(body.event, binding);
    const target = intentTarget(body.target, event.change, binding);
    const expectedHeads = digestHead(body.expectedHeads, "request.expectedHeads");
    // note: The execution key lives in its own column, so a replay compares the COLUMN's key;
    // the request document itself never carried it.
    const recordedKey = row.executionKeyJson === null ? null : (JSON.parse(row.executionKeyJson) as unknown);
    const executionKey = recordedKey === null ? null : intentExecutionKey(recordedKey, event.operationId);
    return {
      request: { binding, event, target, expectedHeads, executionKey },
      operator: typeof body.operator === "string" ? body.operator : null,
      reason: typeof body.reason === "string" ? body.reason : null,
      origin: body.origin === undefined || body.origin === null ? null : writeOrigin(body.origin, "request.origin"),
      result: body.result === undefined ? null : plainJson(body.result, "request.result"),
      legacyRead: legacy.legacy,
    };
  } catch {
    throw malformedIntent(row.operationId, "carries a frozen request the contract cannot read");
  }
}

/**
 * invariant: The settled no-change claim's closed record. It carries the REPLAY IDENTITY of the
 * established write — its kind, portable reference, target and complete business request — and the
 * business answer, never the observed subject: an observation legitimately holds history the
 * replacement contract refuses (a guessed dedup key), and a claim is not a provider event, so it is
 * validated by its own shape instead of `storedRequest`'s frozen-event rules.
 */
type SettledClaim = Readonly<{
  binding: RemoteIntentBinding;
  kind: RemoteEventChange["kind"];
  issueRef: IssueRef;
  target: string;
  executionKey: RemoteIntentExecutionKey | null;
  origin: RemoteWriteOrigin;
  answer: unknown;
}>;

const SETTLED_CLAIM_KEYS = ["settled", "binding", "kind", "issueRef", "target", "origin", "result"] as const;

/** note: The recorded no-change claim of one outbox row, or null when the row holds a frozen request. */
function settledClaim(row: OutboxIntentRow): SettledClaim | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.requestJson);
  } catch {
    throw malformedIntent(row.operationId, "carries no readable frozen request");
  }
  if (!isRecord(parsed) || parsed.settled === undefined) return null;
  try {
    allowOnly(parsed, "request", SETTLED_CLAIM_KEYS);
    if (parsed.settled !== 1) invalid("request.settled", "must be 1");
    const recordedKey = row.executionKeyJson === null ? null : (JSON.parse(row.executionKeyJson) as unknown);
    const answer = recordedNoChange(plainJson(parsed.result, "request.result"));
    if (answer === null) invalid("request.result", "must record the no-change answer");
    return {
      binding: intentBinding(parsed.binding),
      kind: oneOf(parsed.kind, REMOTE_CHANGE_KINDS, "request.kind"),
      issueRef: assertIssueRef(text(parsed.issueRef, "request.issueRef")),
      target: linearId(parsed.target, "request.target"),
      executionKey: recordedKey === null ? null : intentExecutionKey(recordedKey, row.operationId),
      origin: writeOrigin(parsed.origin, "request.origin"),
      answer: answer.answer,
    };
  } catch {
    throw malformedIntent(row.operationId, "carries a settled claim the contract cannot read");
  }
}

/**
 * invariant: A settled claim was never dispatched, so no lifecycle verb applies to it. Each such
 * verb names the claim and the read that answers it instead of reporting an unreadable row.
 */
function noSettledClaim(row: OutboxIntentRow, attempt: string): void {
  if (settledClaim(row) === null) return;
  throw new StoreError(
    "remote.dispatch-refused",
    `Operation ${row.operationId} holds a settled no-change claim: the observed authority already carried that write, ` +
      `so nothing was ever sent and no dispatch, receipt, reconciliation, resolution or abandonment applies to it. ` +
      `${attempt} A new write needs a new operation id.`,
    { operationId: row.operationId, settled_no_change: true },
  );
}

/**
 * note: The cache's materialized binding must equal the frozen one before any lifecycle act.
 * The writer id is NOT part of that identity: a denial, revocation or expiry clears it in place,
 * so including it would refuse a row that must stay inspectable as metadata. Sending still
 * re-proves the verified writer against the scope in `assertDispatchScope`.
 */
function assertFrozenBinding(db: StoreDb, binding: RemoteIntentBinding, operationId: string): void {
  const stored = db
    .prepare(
      "select selector_commit, provider, workspace_id, team_id, provider_project_id, journal_issue_id " +
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
    stored.journal_issue_id !== binding.journalIssueId
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

/**
 * invariant: The private lane a row may be disclosed or changed from is the one THIS checkout is
 * admitted to. A successor bind leaves the predecessor's rows in place, so their own still-fresh
 * access check is not what authorizes them: the admitted selector does. Predecessor rows stay
 * inspection-only (metadata), and no recovery verb rewrites them.
 *
 * The `{location,binding}` pair is sampled ONCE here and is the only pair a request acts under:
 * the cache open, the admitted-lane fence and disclosure all read this sample, never a second
 * read of the v3 file that could authorize a predecessor's payload under a successor's handle.
 */
type SampledLane = Readonly<{
  location: CollaborationLocation;
  binding: CollaborationBinding;
  generation: number;
  selectorCommit: string;
}>;

function admittedLane(context: StoreContext): SampledLane {
  const location = resolveCollaborationLocation(context);
  const binding = readCollaborationBinding(context);
  if (binding === null || binding.version !== 3 || binding.state !== "active") {
    throw new StoreError(
      "collaboration.stale-binding",
      "This checkout holds no finalized remote binding, so no outbox row belongs to its admitted lane. Run the reviewed " +
        "remote bind first; nothing was read or changed.",
    );
  }
  return { location, binding, generation: binding.generation, selectorCommit: binding.selectorCommit };
}

/** note: Whether the checkout still records the sampled binding: a rebind makes that sample inspection-only. */
function laneStillRecorded(context: StoreContext, lane: SampledLane): boolean {
  const current = readCollaborationBinding(context);
  return (
    current !== null &&
    current.version === 3 &&
    current.state === "active" &&
    current.generation === lane.generation &&
    current.selectorCommit === lane.selectorCommit
  );
}

/**
 * note: Whether the origin still publishes the sampled selector. A successor published before
 * this checkout binds it makes the sampled pair inspection-only all the same, so a moved or
 * vanished ref withholds the payload instead of refusing the row.
 */
function laneStillPublished(context: StoreContext, lane: SampledLane): boolean {
  try {
    assertSelectionUnchanged(context, lane.location);
    return true;
  } catch {
    return false;
  }
}

function assertAdmittedLane(
  lane: { generation: number; selectorCommit: string },
  row: OutboxIntentRow,
  binding: RemoteIntentBinding,
  operationId: string,
  act: string,
): void {
  if (row.generation === lane.generation && binding.selectorCommit === lane.selectorCommit) return;
  throw new StoreError(
    "collaboration.stale-binding",
    `Operation ${operationId} was frozen under selector commit ${binding.selectorCommit} generation ` +
      `${String(binding.generation)}, but this checkout is admitted to ${lane.selectorCommit} generation ` +
      `${String(lane.generation)}; a predecessor row is inspection-only and ${act} stays with the admitted lane. ` +
      `Complete the reviewed bind for the generation that owns it; nothing was changed.`,
    { operationId, generation: binding.generation, admittedGeneration: lane.generation },
  );
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

/** note: The outcomes one dispatched attempt's receipt may report, and the subset a reconciliation may. */
const RECEIPT_OUTCOME_KINDS = ["confirmed", "unconfirmed", "conflict", "not-sent"] as const;
const RECONCILE_OUTCOME_KINDS = ["confirmed", "unconfirmed", "conflict"] as const;

/**
 * invariant: One receipt outcome, exactly as the contract closes it. `confirmed` must name the
 * target's provider identity and the exact event the caller decoded back, so a receipt can
 * never be confused with a reviewer's summary. The frozen binding's scope is required.
 *
 * A reconciliation reports what a lookup SAW, so its document has no `not-sent` arm at all: only
 * the original host's own receipt can prove an attempt was never sent.
 *
 * With `errors` supplied, every member is read through `collected`: the caller aggregates the
 * whole submitted document's structural diagnostics into one refusal, and the placeholder this
 * mode may return is discarded with those errors.
 */
function receiptOutcome(
  raw: unknown,
  path: string,
  errors?: string[],
  source: "receipt" | "reconcile" = "receipt",
): RemoteReceiptOutcome {
  const kinds = source === "reconcile" ? RECONCILE_OUTCOME_KINDS : RECEIPT_OUTCOME_KINDS;
  const body = collected(errors, () => record(raw, path), undefined);
  if (body === undefined) return { kind: "unconfirmed", reason: "no-response" };
  if (source === "reconcile" && body.kind === "not-sent") {
    const message =
      `${path}.kind: a reconciliation reports what a lookup saw, so its document has no not-sent arm; record the ` +
      `pre-send refusal with \`mstar store collaboration remote outbox-receipt --harness <abs> --input <file|->\``;
    if (errors === undefined) throw new StoreError("remote.input-invalid", `${message}${NOTHING_WRITTEN}`);
    errors.push(message);
    return { kind: "unconfirmed", reason: "no-response" };
  }
  const kind = typeof body.kind === "string" && (kinds as readonly string[]).includes(body.kind)
    ? (body.kind as RemoteReceiptOutcome["kind"])
    : undefined;
  if (kind === undefined) {
    const message = `${path}.kind: must be one of ${kinds.join("|")}`;
    if (errors === undefined) throw new StoreError("remote.input-invalid", `${message}${NOTHING_WRITTEN}`);
    errors.push(message);
    return { kind: "unconfirmed", reason: "no-response" };
  }
  if (kind === "confirmed") {
    allowOnly(body, path, ["kind", "identity", "recordId", "event"], errors);
    return {
      kind,
      identity: collected(errors, () => issueIdentity(body.identity, `${path}.identity`, errors), {} as ProviderIssueIdentity),
      recordId: collected(errors, () => linearId(body.recordId, `${path}.recordId`), ""),
      event: collected(errors, () => frozenEvent(body.event, `${path}.event`, errors), undefined as unknown as RemoteEvent),
    };
  }
  if (kind === "unconfirmed") {
    allowOnly(body, path, ["kind", "reason"], errors);
    return {
      kind,
      reason: collected(
        errors,
        () =>
          oneOf(
            body.reason,
            ["no-response", "not-found", "ambiguous", "provider-unavailable"] as const,
            `${path}.reason`,
          ),
        "no-response",
      ),
    };
  }
  if (kind === "conflict") {
    allowOnly(body, path, ["kind", "expectedHeads", "observedHeads", "observedRecords"], errors);
    return {
      kind,
      expectedHeads: collected(errors, () => digestHead(body.expectedHeads, `${path}.expectedHeads`), []),
      observedHeads: collected(errors, () => digestHead(body.observedHeads, `${path}.observedHeads`), []),
      observedRecords: collected(
        errors,
        () =>
          list(body.observedRecords, `${path}.observedRecords`).map((entry, index) => {
            const recordPath = `${path}.observedRecords[${index}]`;
            const record_ = collected(errors, () => record(entry, recordPath), {} as Record<string, unknown>);
            allowOnly(record_, recordPath, ["identity", "recordId", "event"], errors);
            return {
              identity: collected(
                errors,
                () => issueIdentity(record_.identity, `${recordPath}.identity`, errors),
                {} as ProviderIssueIdentity,
              ),
              recordId: collected(errors, () => linearId(record_.recordId, `${recordPath}.recordId`), ""),
              event: collected(
                errors,
                () => frozenEvent(record_.event, `${recordPath}.event`, errors),
                undefined as unknown as RemoteEvent,
              ),
            };
          }),
        [],
      ),
    };
  }
  allowOnly(body, path, ["kind", "code"], errors);
  return { kind, code: collected(errors, () => text(body.code, `${path}.code`), "") };
}

/**
 * note: A receipt's event is validated against the contract's own event shape with a
 * placeholder binding; the exact equality with the frozen event is the caller's check.
 * With `errors`, every member defect is collected instead of failing on the first one.
 */
function frozenEvent(raw: unknown, path: string, errors?: string[]): RemoteEvent {
  const body = collected(errors, () => record(raw, path), {} as Record<string, unknown>);
  // note: The placeholder binding only satisfies intentBinding's shape so the event's own members
  // can all be read and aggregated. Its project key derives from the event's own projectId
  // unchecked, so the stored-receipt readback (which re-judges nothing) passes the project check,
  // and the collected mode skips that check for an unreadable projectId.
  const binding = intentBinding({
    generation: 1,
    projectKey: typeof body.projectId === "string" && body.projectId !== "" ? body.projectId : "frozen-event-placeholder",
    selectorCommit: "0".repeat(40),
    provider: "linear",
    workspaceId: "00000000-0000-4000-8000-000000000000",
    teamId: "00000000-0000-4000-8000-000000000000",
    projectId: "00000000-0000-4000-8000-000000000000",
    journalIssueId: "00000000-0000-4000-8000-000000000000",
    writerId: null,
  });
  return remoteEvent(body, binding, errors, path);
}

/**
 * invariant: A confirmed receipt names the record this intent addresses: the immutable target of
 * a replacement/adoption or the selected journal anchor of a project event. A create addresses no
 * record yet, so its receipt names the NEW issue identity in the selected scope - accepting it
 * only together with the exact frozen event, which is the unique effect this intent produced.
 */
function assertReceiptTargets(outcome: RemoteReceiptOutcome, request: StoredRequest, operationId: string): void {
  if (outcome.kind !== "confirmed") return;
  const scope = request.request.binding;
  const kind = request.request.event.change.kind;
  const expectedIssue = kind === "issue-create" ? null : request.request.target;
  if (
    outcome.identity.workspaceId !== scope.workspaceId ||
    outcome.identity.teamId !== scope.teamId ||
    outcome.identity.projectId !== scope.projectId ||
    (expectedIssue !== null && outcome.identity.issueId !== expectedIssue) ||
    (expectedIssue === null && outcome.identity.issueId === scope.journalIssueId)
  ) {
    throw new StoreError(
      "remote.scope-mismatch",
      `The confirmed record of operation ${operationId} is not the provider record this intent addresses (` +
        `${expectedIssue ?? "a new issue in the bound project"}) in the bound project; a receipt from another scope ` +
        `never confirms it. Nothing was changed.`,
      { operationId, expectedIssue, observedIssue: outcome.identity.issueId },
    );
  }
  if (remoteEventHead(outcome.event) !== remoteEventHead(request.request.event)) {
    throw new StoreError(
      "remote.operation-conflict",
      `The confirmed record of operation ${operationId} carries another event than the frozen request; a differing ` +
        `effect is a conflict to review, never a confirmation. Nothing was changed.`,
      { operationId },
    );
  }
  // invariant: A create's genesis event lives in its native issue's description, so the immutable
  // record it names IS the issue it names. Two different ids attest no single record.
  if (kind === "issue-create" && outcome.recordId !== outcome.identity.issueId) {
    throw new StoreError(
      "remote.operation-conflict",
      `The confirmed record of operation ${operationId} names immutable record ${outcome.recordId}, not the created issue ` +
        `${outcome.identity.issueId} that carries its genesis event; a create is confirmed only on the exact issue it names. ` +
        `Nothing was changed.`,
      { operationId, recordId: outcome.recordId, issueId: outcome.identity.issueId },
    );
  }
}

/**
 * invariant: A conflict record is complete, bound evidence of a fork: its expected heads are the
 * frozen base, every named observed head carries exactly one immutable record, those records
 * address this intent's own project/record, and none of them is the frozen effect itself. A
 * partial or foreign fork is refused instead of being stored as reviewable evidence.
 */
function assertConflictEvidence(outcome: RemoteReceiptOutcome, request: StoredRequest, operationId: string): void {
  if (outcome.kind !== "conflict") return;
  const frozen = request.request;
  const scope = frozen.binding;
  const conflict = (detail: string, details: Record<string, unknown> = {}): never => {
    throw new StoreError(
      "remote.operation-conflict",
      `The conflict record of operation ${operationId} ${detail}; a complete, bound fork is required before it can be ` +
        `recorded, so nothing was changed.`,
      { operationId, ...details },
    );
  };
  const foreign = (detail: string, details: Record<string, unknown> = {}): never => {
    throw new StoreError(
      "remote.scope-mismatch",
      `The conflict record of operation ${operationId} ${detail}; evidence of another scope never settles this intent, ` +
        `so nothing was changed.`,
      { operationId, ...details },
    );
  };
  if (frozen.event.change.kind === "issue-create") {
    return conflict("names a create, which has no forked record to observe");
  }
  if (!sameHeads(outcome.expectedHeads, frozen.expectedHeads)) {
    return conflict("does not cite the frozen base as its expected heads", { expectedHeads: frozen.expectedHeads });
  }
  if (outcome.observedHeads.length === 0) return conflict("names no observed fork head");
  if (outcome.observedRecords.length !== outcome.observedHeads.length) {
    return conflict("does not carry exactly one record per observed head", {
      observedHeads: outcome.observedHeads.length,
      observedRecords: outcome.observedRecords.length,
    });
  }
  const frozenHead = remoteEventHead(frozen.event);
  const seen = new Set<string>();
  const recordIds = new Set<string>();
  const heads: string[] = [];
  for (const observed of outcome.observedRecords) {
    const identity = observed.identity;
    if (
      identity.workspaceId !== scope.workspaceId ||
      identity.teamId !== scope.teamId ||
      identity.projectId !== scope.projectId ||
      identity.issueId !== frozen.target
    ) {
      return foreign("observes a record outside the intent's bound target", { observedIssue: identity.issueId });
    }
    if (recordIds.has(observed.recordId)) {
      return conflict("names one immutable record id for two heads", { recordId: observed.recordId });
    }
    recordIds.add(observed.recordId);
    const event = observed.event;
    if (
      event.repoKey !== frozen.event.repoKey ||
      event.projectId !== frozen.event.projectId ||
      event.change.kind !== frozen.event.change.kind
    ) {
      return foreign("carries a record of another repository, project or change kind", {
        observedOperation: event.operationId,
      });
    }
    if (event.change.kind !== "project-replace" && frozen.event.change.kind !== "project-replace") {
      if (event.change.issueRef !== frozen.event.change.issueRef) {
        return foreign("carries a record of another portable issue", { observedIssueRef: event.change.issueRef });
      }
    }
    const head = remoteEventHead(event);
    if (head === frozenHead) return conflict("names the frozen effect itself as a competing head");
    if (seen.has(head)) return conflict("repeats one observed record for two heads");
    seen.add(head);
    heads.push(head);
  }
  // invariant: A named head IS the canonical content digest of the record it claims to name, so
  // arbitrary digests can never be paired with unrelated records and cited as a complete fork.
  heads.sort();
  if (!sameHeads(heads, outcome.observedHeads)) {
    return conflict("does not cite the content digest of each observed record", {
      observedHeads: outcome.observedHeads,
      recordHeads: heads,
    });
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
  outcome: RemoteReceiptOutcome;
}>;

/**
 * invariant: The submission's STRUCTURE is proved before any outbox access, and one refusal
 * answers every structural defect the document carries - an unknown member at any level, a
 * missing or unreadable member, an arm this verb's document does not define - so a caller
 * corrects the whole document instead of discovering one defect per submission.
 */
function receiptEnvelope(raw: unknown, source: "receipt" | "reconcile"): RemoteReceiptEnvelope {
  const command = `store.collaboration.remote.outbox-${source}`;
  const errors: string[] = [];
  const body = collected(errors, () => record(raw, "receipt"), {} as Record<string, unknown>);
  allowOnly(body, "receipt", [
    "version", "selectorCommit", "generation", "projectId", "operationId", "attemptId", "requestHash", "observedAt",
    "outcome",
  ], errors);
  if (body.version !== 1) errors.push("receipt.version: must be 1");
  const selectorCommit = collected(errors, () => text(body.selectorCommit, "receipt.selectorCommit"), "");
  if (selectorCommit !== "" && !GIT_OBJECT_ID.test(selectorCommit)) {
    errors.push("receipt.selectorCommit: must be a Git object id");
  }
  const generation = collected(errors, () => positiveInteger(body.generation, "receipt.generation"), 0);
  const projectId = collected(errors, () => text(body.projectId, "receipt.projectId"), "");
  const operationId = collected(errors, () => linearId(body.operationId, "receipt.operationId"), "");
  const attemptId = collected(errors, () => linearId(body.attemptId, "receipt.attemptId"), "");
  const requestHash = collected(errors, () => digest(body.requestHash, "receipt.requestHash"), "");
  const observedAt = collected(errors, () => instant(body.observedAt, "receipt.observedAt"), "");
  const outcome = receiptOutcome(body.outcome, "receipt.outcome", errors, source);
  if (errors.length > 0) {
    throw new StoreError(
      "remote.input-invalid",
      `${errors.join("; ")}. Nothing was written. Run \`mstar schema --command ${command}\` for this document's ` +
        `shape, then resubmit the corrected --input document.`,
    );
  }
  return {
    version: 1,
    selectorCommit,
    generation,
    projectId,
    operationId,
    attemptId,
    requestHash,
    observedAt,
    outcome,
  };
}

/** note: A settled write invalidates the snapshot it moved: the cache stops serving a stale base. */
function invalidateConfirmedBase(db: StoreDb, generation: number, projectKey: string, code = "remote.effect-confirmed"): void {
  const at = nowRfc3339();
  db.prepare(
    "update remote_observations set revision = revision + 1, as_of = null, completeness = 'unavailable', " +
      "code = ?, snapshot_json = null, received_at = ? where generation = ? and project_key = ?",
  ).run(code, at, generation, projectKey);
  db.prepare("delete from remote_issue_identities where generation = ? and project_key = ?").run(generation, projectKey);
}

/** note: The conflict evidence a recorded fork carries: reopening never overrules it. */
function hasConflictReceipt(db: StoreDb, operationId: string): boolean {
  return (
    db
      .prepare("select 1 as found from remote_outbox_receipts where operation_id = ? and outcome = 'conflict' limit 1")
      .get(operationId) !== undefined
  );
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
  const envelope = receiptEnvelope(raw, source);
  // note: Q1/Q2 recovery runs under the intent's ORIGINAL binding, including a draining
  // generation's pinned previous one; this never prepares or dispatches anything. The settlement
  // write takes the outbox recovery lane, which also admits a below-current cache this build can
  // still prove against its own declared inventory.
  return withRemoteCacheRecoveryWrite(context, (handle) => {
    const db = handle.db;
    const row = intentRow(db, envelope.operationId);
    noSettledClaim(row, "A receipt names what one dispatched attempt observed, and this claim was never sent.");
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
    assertAdmittedLane(admittedLane(context), row, stored.request.binding, envelope.operationId, `${source} of this attempt`);
    if (envelope.selectorCommit !== stored.request.binding.selectorCommit) {
      throw new StoreError(
        "collaboration.stale-binding",
        `Operation ${envelope.operationId} was frozen under selector commit ${stored.request.binding.selectorCommit}, ` +
          `not the receipt's ${envelope.selectorCommit}; an attempt is only ever settled under the binding it was sent ` +
          `under. Nothing was changed.`,
        { operationId: envelope.operationId },
      );
    }
    if (row.requestHash !== envelope.requestHash) {
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
    // invariant: Q2: the reconciliation's own document has no not-sent arm, so the structural
    // refusal already answered that submission before this attempt was read.
    const outcome = envelope.outcome;
    assertReceiptTargets(outcome, stored, envelope.operationId);
    assertConflictEvidence(outcome, stored, envelope.operationId);
    const receiptHash = receiptHashOf(source, envelope, outcome);
    const recorded = db
      .prepare("select 1 as found from remote_outbox_receipts where operation_id = ? and receipt_hash = ?")
      .get(envelope.operationId, receiptHash) as { found?: number } | undefined;
    if (recorded !== undefined) {
      // invariant: The same submission replays its recorded evidence and never re-applies a state change.
      return intentRead(db, row, stored, readPermission(db, row.generation, row.projectKey));
    }
    // invariant: A row whose state claims `confirmed` while no confirmed receipt is recorded holds
    // no provable effect - damaged cache bytes, since only this transaction writes that state. The
    // receipt that proves it is exactly what settles the intent, so recording it stays admitted.
    const unprovenConfirmation = row.state === "confirmed" && !hasConfirmedReceipt(db, envelope.operationId);
    // invariant: The reopening only completes a MISSING confirmation; it never overrules recorded
    // evidence. A state column tampered to 'confirmed' beside an existing conflict receipt would
    // otherwise launder the row into a settled parent without a second reviewed resolution.
    if (unprovenConfirmation && hasConflictReceipt(db, envelope.operationId)) {
      throw new StoreError(
        "remote.dispatch-refused",
        `Operation ${envelope.operationId} already holds a recorded conflict receipt, so a confirmation is never recorded onto it: the row's recorded state contradicts its recorded evidence, so this scope cannot settle it in place - ${REMOTE_CACHE_REBUILD_ROUTE} Nothing was changed.`,
        { operationId: envelope.operationId },
      );
    }
    if (row.state !== "unconfirmed" && row.state !== "conflict" && !unprovenConfirmation) {
      throw new StoreError(
        "remote.dispatch-refused",
        `Operation ${envelope.operationId} is ${row.state}; only an unconfirmed or conflicted send accepts a new receipt ` +
          `or reconciliation. Nothing was changed.`,
        { operationId: envelope.operationId, state: row.state },
      );
    }
    if (row.state === "conflict" && outcome.kind === "confirmed") {
      // invariant: Q2: a recorded conflict is TERMINAL for that intent. Only a reviewed resolution
      // (a new intent citing both branches) moves past it; the original is never rewritten.
      throw new StoreError(
        "remote.dispatch-refused",
        `Operation ${envelope.operationId} is conflicted, and a conflict is never rewritten into a confirmation: the ` +
          `recorded fork must be resolved by review (outbox-resolve) as a new intent that cites both branches. ` +
          `Nothing was changed.`,
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
      // invariant: The recorded fork is durable proof the base moved, so the previously complete
      // snapshot stops satisfying counts and gates in the SAME transaction; only a refresh clears it.
      invalidateConfirmedBase(db, row.generation, row.projectKey, "remote.effect-conflict");
    }
    return intentRead(db, intentRow(db, envelope.operationId), stored, readPermission(db, row.generation, row.projectKey));
  }, { previousDuringDraining: source === "reconcile", settleOutbox: true });
}

function intentRead(
  db: StoreDb,
  row: OutboxIntentRow,
  stored: StoredRequest,
  disclosure: "full" | "metadata",
): RemoteIntentRead {
  const full = disclosure === "full";
  return {
    version: 1,
    operationId: row.operationId,
    projectId: row.projectKey,
    generation: row.generation,
    state: row.state,
    attemptId: row.attemptId,
    requestHash: row.requestHash,
    binding: stored.request.binding,
    disclosure,
    confirmed: full ? confirmedEffectOf(db, row.operationId) : null,
    event: full ? stored.request.event : null,
    settled: null,
    target: full ? stored.request.target : null,
    expectedHeads: full ? stored.request.expectedHeads : [],
    executionKey: full ? (stored.request.executionKey ?? null) : null,
    origin: full ? stored.origin : null,
    result: full ? stored.result : null,
    operator: full ? stored.operator : null,
    reason: full ? stored.reason : null,
    normalizedFromLegacy: stored.legacyRead,
    resolves: row.resolves,
    resolvedBy: row.resolvedBy,
    abandonReason: full ? row.abandonReason : null,
    receipts: full ? receiptRows(db, row.operationId) : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * note: `outbox-show` of a settled no-change claim: the same durable row view, with the recorded
 * replay identity and answer in place of a frozen event the claim never carried.
 */
function claimIntentRead(
  db: StoreDb,
  row: OutboxIntentRow,
  claim: SettledClaim,
  disclosure: "full" | "metadata",
): RemoteIntentRead {
  const full = disclosure === "full";
  return {
    version: 1,
    operationId: row.operationId,
    projectId: row.projectKey,
    generation: row.generation,
    state: row.state,
    attemptId: row.attemptId,
    requestHash: row.requestHash,
    binding: claim.binding,
    disclosure,
    confirmed: null,
    event: null,
    settled: full ? { kind: claim.kind, issueRef: claim.issueRef } : null,
    target: full ? claim.target : null,
    expectedHeads: [],
    executionKey: full ? claim.executionKey : null,
    origin: full ? claim.origin : null,
    result: full ? { noChange: claim.answer } : null,
    operator: null,
    reason: null,
    normalizedFromLegacy: false,
    resolves: row.resolves,
    resolvedBy: row.resolvedBy,
    abandonReason: full ? row.abandonReason : null,
    receipts: full ? receiptRows(db, row.operationId) : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * note: Whether this project's latest verified access check still authorizes disclosing the
 * frozen request. A negative, missing or expired check withholds the content, never the state.
 */
function readPermission(db: StoreDb, generation: number, projectKey: string): "full" | "metadata" {
  const scope = scopeRow(db, generation, projectKey);
  if (
    scope === undefined ||
    typeof scope.verification_json !== "string" ||
    outcomeLabel(scope.verification_json) !== "verified"
  ) {
    return "metadata";
  }
  const verifiedAt = typeof scope.verified_at === "string" ? scope.verified_at : "";
  return Math.abs(Date.now() - Date.parse(verifiedAt)) > REMOTE_SCOPE_TTL_MS ? "metadata" : "full";
}

/**
 * note: `outbox-show`: one intent under the binding it was frozen under, including a draining
 * generation's pinned previous binding, never a send permit. Frozen content is disclosed only
 * while the project's current read permission holds AND the admitted pair still authorizes this
 * row: the sample read once here is the pair the cache open admits.
 */
export async function readRemoteIntent(context: StoreContext, operationId: string): Promise<RemoteIntentRead> {
  const target = linearId(operationId, "operationId");
  const lane = admittedLane(context);
  // note: The sample is the request's whole admission: the open below validates exactly this
  // pair, and disclosure compares against it instead of a second read of the v3 binding.
  await remoteIntentSampleGapForTest?.();
  const handle = await openRemoteCacheRecovery(context, "read", { location: lane.location, binding: lane.binding }, {
    previousDuringDraining: true,
    settleOutbox: true,
  });
  try {
    const row = intentRow(handle.db, target);
    const claim = settledClaim(row);
    const stored = claim === null ? storedRequest(row) : null;
    const frozenBinding = claim === null ? stored!.request.binding : claim.binding;
    assertFrozenBinding(handle.db, frozenBinding, target);
    // invariant: Disclosure follows the pair this open admitted. A checkout that rebound, or an
    // origin that published a successor this checkout has not bound yet, while the lane opened
    // authorized nothing here, however current the row's own check still is: the row stays
    // inspectable, its frozen content does not.
    const admitted =
      row.generation === lane.generation &&
      frozenBinding.selectorCommit === lane.selectorCommit &&
      laneStillRecorded(context, lane) &&
      laneStillPublished(context, lane);
    const disclosure = admitted ? readPermission(handle.db, row.generation, row.projectKey) : "metadata";
    return claim === null
      ? intentRead(handle.db, row, stored!, disclosure)
      : claimIntentRead(handle.db, row, claim, disclosure);
  } finally {
    handle.close();
  }
}

/** note: The joined binding and observation one project's dispatch reads, as the cache holds it. */
function scopeRow(db: StoreDb, generation: number, projectKey: string): Record<string, unknown> | undefined {
  return (db
    .prepare(
      "select b.selector_commit, b.provider, b.workspace_id, b.team_id, b.provider_project_id, b.journal_issue_id, " +
        "b.writer_id, b.verified_at, b.verification_json, o.revision, o.as_of, o.completeness, o.snapshot_json " +
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
 * note: The complete fork evidence one conflicted intent recorded, re-validated against that
 * intent's own frozen request. A conflict without readable, bound evidence names no base a
 * reviewed resolution could cite.
 */
function recordedFork(db: StoreDb, conflicted: string): Extract<RemoteReceiptOutcome, { kind: "conflict" }> {
  const row = intentRow(db, conflicted);
  const stored = storedRequest(row);
  const conflicts = receiptRows(db, conflicted).filter(
    (receipt): receipt is RemoteReceiptRecord & { outcome: Extract<RemoteReceiptOutcome, { kind: "conflict" }> } =>
      receipt.outcome.kind === "conflict",
  );
  const recorded = conflicts.at(-1);
  if (recorded === undefined) {
    throw new StoreError(
      "remote.operation-conflict",
      `Operation ${conflicted} holds no recorded fork evidence, so no reviewed resolution can cite the heads it ` +
        `replaces. Reconcile the fork first; nothing was sent or enqueued.`,
      { operationId: conflicted },
    );
  }
  assertConflictEvidence(recorded.outcome, stored, conflicted);
  return recorded.outcome;
}

/** note: The cached observation revision of one project; a project with no observation holds revision 0. */
function observationRevisionOf(db: StoreDb, generation: number, projectKey: string): number {
  const row = db
    .prepare("select revision from remote_observations where generation = ? and project_key = ?")
    .get(generation, projectKey) as { revision?: unknown } | undefined;
  return typeof row?.revision === "number" && Number.isSafeInteger(row.revision) ? row.revision : 0;
}

/**
 * note: The durable time of the last recorded conflict evidence. A resolution's fork observation
 * must have STARTED strictly after it, so a traversal that could have begun before the conflict
 * is never proof that the fork still stands.
 */
function conflictEvidenceRecordedAt(db: StoreDb, conflicted: string): string | null {
  const row = db
    .prepare(
      "select recorded_at from remote_outbox_receipts where operation_id = ? and outcome = 'conflict' " +
        "order by recorded_at desc, receipt_hash desc limit 1",
    )
    .get(conflicted) as { recorded_at?: unknown } | undefined;
  return typeof row?.recorded_at === "string" ? row.recorded_at : null;
}

/**
 * note: Validate the closed `ForkObservation` shape. Every refusal is a dispatch refusal, never an
 * input error: evidence that cannot prove the fork simply never issues a send permit.
 */
function forkObservationOf(raw: unknown): ForkObservation {
  const refuse = (detail: string, details: Record<string, unknown> = {}): never => {
    throw new StoreError(
      "remote.dispatch-refused",
      `The fork observation ${detail}; a reviewed resolution needs a complete host-attested traversal that began ` +
        `after the conflict evidence. Nothing was sent.`,
      details,
    );
  };
  if (!isRecord(raw)) return refuse("is missing or not an object");
  if (raw.version !== 1) return refuse("names an unsupported version");
  if (typeof raw.selectorCommit !== "string" || !GIT_OBJECT_ID.test(raw.selectorCommit)) {
    return refuse("does not name a selector commit");
  }
  if (typeof raw.generation !== "number" || !Number.isSafeInteger(raw.generation) || raw.generation <= 0) {
    return refuse("does not name a generation");
  }
  if (typeof raw.projectId !== "string" || raw.projectId.length === 0) return refuse("does not name a project");
  if (typeof raw.conflictOperationId !== "string" || !LINEAR_ID.test(raw.conflictOperationId)) {
    return refuse("does not name the conflicted operation");
  }
  if (typeof raw.asOf !== "string" || !RCF3339.test(raw.asOf) || !Number.isFinite(Date.parse(raw.asOf))) {
    return refuse("carries no provider traversal start (asOf)");
  }
  if (raw.coverage !== "complete") return refuse("is not a complete traversal");
  if (!Array.isArray(raw.heads) || raw.heads.length === 0) return refuse("names no fork head");
  const heads = raw.heads.map((entry, index) => {
    if (!isRecord(entry)) return refuse(`has an unreadable head at index ${String(index)}`);
    if (typeof entry.recordId !== "string" || !LINEAR_ID.test(entry.recordId)) {
      return refuse(`has no provider record id at index ${String(index)}`);
    }
    if (typeof entry.issueRef !== "string" || !ISSUE_REF_PATTERN.test(entry.issueRef)) {
      return refuse(`has no portable issue reference at index ${String(index)}`);
    }
    if (typeof entry.head !== "string" || !SHA256.test(entry.head)) {
      return refuse(`has no canonical content digest at index ${String(index)}`);
    }
    return { recordId: entry.recordId, issueRef: entry.issueRef, head: entry.head };
  });
  if (new Set(heads.map((entry) => entry.recordId)).size !== heads.length) {
    return refuse("names one immutable record id for two heads");
  }
  const digests = heads.map((entry) => entry.head);
  if (new Set(digests).size !== digests.length) return refuse("repeats one fork head");
  if (digests.some((digest, index) => index > 0 && digests[index - 1]! > digest)) return refuse("is not sorted by head");
  return {
    version: 1,
    selectorCommit: raw.selectorCommit,
    generation: raw.generation,
    projectId: raw.projectId,
    conflictOperationId: raw.conflictOperationId,
    asOf: raw.asOf,
    coverage: "complete",
    heads,
  };
}

/**
 * invariant: A dispatch only issues its one permit against the CURRENT persisted head the frozen
 * event names. A create must still be unobserved; an adoption must still address an unmarked
 * issue; a replacement must cite exactly the head the snapshot observes. The one exception is a
 * reviewed resolution of a named fork: its base is the recorded fork evidence, proven by the
 * host-attested `ForkObservation` that dispatch carries.
 */
function assertDispatchBase(
  db: StoreDb,
  row: OutboxIntentRow,
  stored: StoredRequest,
  observation: ForkObservation | null,
): void {
  const scope = scopeRow(db, row.generation, row.projectKey);
  const refuse = (detail: string): never => {
    throw new StoreError(
      "remote.dispatch-refused",
      `${detail} Operation ${row.operationId} is not dispatched; re-observe the scope and prepare a fresh base, or ` +
        `abandon the intent while it is provably unsent.`,
      { operationId: row.operationId },
    );
  };
  const event = stored.request.event;
  const target = stored.request.target;
  const expected = stored.request.expectedHeads;
  if (!sameHeads(expected, event.parents)) {
    return refuse(`The frozen base and the frozen parents of ${row.operationId} disagree.`);
  }
  if (row.resolves !== null) {
    // invariant: A reviewed resolution's base is the fork evidence that conflict recorded, and
    // that evidence is proved by a host-attested traversal which began AFTER the conflict and
    // terminated over the whole fork: a partial, pre-conflict or mismatched observation never
    // issues the permit. The cached snapshot is not fork evidence.
    let recorded: Extract<RemoteReceiptOutcome, { kind: "conflict" }>;
    try {
      recorded = recordedFork(db, row.resolves);
    } catch {
      return refuse(`The resolution of ${row.resolves} has no readable fork evidence to prove its base against.`);
    }
    if (!sameHeads(recorded.observedHeads, event.parents)) {
      return refuse(`The resolution's parents are not the fork heads ${row.resolves} recorded.`);
    }
    if (observation === null) {
      return refuse(
        `The reviewed resolution of ${row.resolves} carries no ForkObservation; a complete traversal that began ` +
          `after the conflict evidence is the only proof of its base.`,
      );
    }
    assertForkObservation(db, row, stored, observation, recorded);
    return;
  }
  let snapshot: RemoteSnapshot | null = null;
  if (scope !== undefined && typeof scope.snapshot_json === "string") {
    try {
      snapshot = normalizeRetiredDocumentKind(JSON.parse(scope.snapshot_json) as RemoteSnapshot);
    } catch {
      return refuse(`The stored observation of ${row.projectKey} is unreadable.`);
    }
  }
  if (snapshot === null || scope?.completeness !== "complete") {
    return refuse(`The current observation of ${row.projectKey} is not complete, so no base can be proven for it.`);
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
  if (!sameHeads(observedHeads(snapshot, event, target), expected)) {
    return refuse(
      `The observed head of the addressed record is not the frozen base of ${row.operationId}; the provider base moved ` +
        `since the intent was prepared.`,
    );
  }
}

/**
 * invariant: A reviewed resolution's permit is bound to the observation that proves it: the same
 * binding, generation, project and conflict; every recorded fork head under its own immutable
 * record id and portable issue reference; complete coverage; and a traversal that BEGAN strictly
 * after the conflict evidence was recorded.
 */
function assertForkObservation(
  db: StoreDb,
  row: OutboxIntentRow,
  stored: StoredRequest,
  observation: ForkObservation,
  recorded: Extract<RemoteReceiptOutcome, { kind: "conflict" }>,
): void {
  const refuse = (detail: string, details: Record<string, unknown> = {}): never => {
    throw new StoreError(
      "remote.dispatch-refused",
      `${detail} The reviewed resolution ${row.operationId} is not dispatched and no send permit was issued.`,
      { operationId: row.operationId, ...details },
    );
  };
  const binding = stored.request.binding;
  if (
    observation.selectorCommit !== binding.selectorCommit ||
    observation.generation !== row.generation ||
    observation.projectId !== binding.projectKey ||
    observation.conflictOperationId !== row.resolves
  ) {
    return refuse(
      `The fork observation of ${row.operationId} does not name its binding, generation, project and conflict; evidence of ` +
        `another scope proves nothing.`,
      { observedConflict: observation.conflictOperationId, conflict: row.resolves },
    );
  }
  const fork = recorded.observedHeads;
  const heads = observation.heads.map((entry) => entry.head);
  if (!sameHeads(heads, fork)) {
    return refuse(
      `The fork observation of ${row.operationId} does not carry exactly the fork heads ${String(row.resolves)} recorded; ` +
        `a changed provider base is never permission to send a resolution.`,
      { observedHeads: heads, fork },
    );
  }
  // invariant: A head is the immutable record the conflict bound to its digest. The same digests
  // under other record ids or another portable issue do not prove the recorded fork still stands.
  const bound = new Map(
    recorded.observedRecords.map((entry) => [
      entry.recordId,
      {
        head: remoteEventHead(entry.event),
        issueRef: entry.event.change.kind === "project-replace" ? null : entry.event.change.issueRef,
      },
    ]),
  );
  for (const entry of observation.heads) {
    const record = bound.get(entry.recordId);
    if (record === undefined || record.head !== entry.head) {
      return refuse(
        `The fork observation of ${row.operationId} names immutable record ${entry.recordId}, which the recorded fork ` +
          `does not bind to that digest; only the records ${String(row.resolves)} recorded prove its base.`,
        { recordId: entry.recordId },
      );
    }
    if (record.issueRef !== null && record.issueRef !== entry.issueRef) {
      return refuse(
        `The fork observation of ${row.operationId} names record ${entry.recordId} under portable issue ` +
          `${entry.issueRef}, not the recorded ${record.issueRef}; evidence of another issue proves nothing.`,
        { recordId: entry.recordId, observedIssueRef: entry.issueRef, issueRef: record.issueRef },
      );
    }
  }
  const conflictAt = conflictEvidenceRecordedAt(db, row.resolves!);
  if (conflictAt === null) {
    return refuse(`The conflict of ${row.operationId} carries no recorded evidence time to prove the observation is newer.`);
  }
  if (Date.parse(observation.asOf) <= Date.parse(conflictAt)) {
    return refuse(
      `The fork observation of ${row.operationId} began at ${observation.asOf}, at or before the conflict evidence ` +
        `(${conflictAt}); a traversal that may have started before the conflict proves nothing.`,
    );
  }
}

/** note: The verified-writer and freshness facts a dispatch requires. */
function assertDispatchScope(
  scope: Record<string, unknown>,
  stored: StoredRequest,
  operationId: string,
  resolution: boolean,
): void {
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
  // invariant: A reviewed resolution's base is its recorded fork evidence, so it is the one intent
  // that does not require a complete observation; every other send proves a complete base AND a
  // traversal that started inside the freshness window.
  if (!resolution) {
    if (typeof scope.snapshot_json !== "string") {
      return refuse(`No complete observation exists to prove the base for ${stored.request.binding.projectKey}.`);
    }
    if (!traversalCurrent(scope.as_of)) {
      return refuse(
        `The stored observation of ${stored.request.binding.projectKey} began its provider traversal at ` +
          `${String(scope.as_of ?? "an unrecorded time")}, outside the ${String(REMOTE_SCOPE_TTL_MS / 1000)}-second freshness ` +
          `window, so its snapshot cannot prove the base even though the access check is current.`,
      );
    }
  }
}

/**
 * note: The conflicts one intent transitively repairs, following its own `resolves` link upward.
 * A reviewed repair may itself conflict and be repaired, so only the whole chain proves that the
 * forks a send settles are the ones it was reviewed against.
 */
function repairedForks(db: StoreDb, operationId: string): Set<string> {
  const forks = new Set<string>();
  const visited = new Set<string>();
  let cursor: string | null = operationId;
  while (cursor !== null && !visited.has(cursor)) {
    visited.add(cursor);
    const row = db
      .prepare("select resolves from remote_outbox where operation_id = ?")
      .get(cursor) as { resolves?: unknown } | undefined;
    cursor = typeof row?.resolves === "string" ? row.resolves : null;
    if (cursor !== null) forks.add(cursor);
  }
  return forks;
}

/** note: One outbox row's state and its `resolved_by` link, as a resolution-chain walk needs them. */
type ResolutionLink = Readonly<{ state: string; resolvedBy: string | null }>;

/**
 * note: The one chain walk BOTH the settle rule and the taken-over refusal use. It follows each
 * conflicted row's own `resolvedBy` resolution and names where it ends: a confirmed repair (the
 * chain settled the fork), the first ACTIONABLE row (a conflicted row with no live successor, or
 * the parent of an abandoned repair), or damage (a cycle or a missing link) no step can settle.
 */
type ChainTail =
  | Readonly<{ kind: "settled"; repair: string }>
  | Readonly<{ kind: "actionable"; operationId: string; state: string }>
  | Readonly<{ kind: "damaged" }>;

function chainTail(chain: ReadonlyMap<string, ResolutionLink>, operationId: string): ChainTail {
  const visited = new Set<string>();
  let cursor: string | null = operationId;
  // note: The parent of an abandoned repair is itself the actionable conflict row.
  let parent = operationId;
  while (cursor !== null && !visited.has(cursor)) {
    visited.add(cursor);
    const link = chain.get(cursor);
    if (link === undefined) return { kind: "damaged" };
    if (link.state === "confirmed") return { kind: "settled", repair: cursor };
    if (link.state === "conflict") {
      if (link.resolvedBy === null) return { kind: "actionable", operationId: cursor, state: link.state };
      parent = cursor;
      cursor = link.resolvedBy;
      continue;
    }
    if (link.state === "abandoned") return { kind: "actionable", operationId: parent, state: "conflict" };
    return { kind: "actionable", operationId: cursor, state: link.state };
  }
  return { kind: "damaged" };
}

/** note: The live chain's terminal confirmed repair id, or null when it reaches no confirmation. */
function settledRepair(chain: ReadonlyMap<string, ResolutionLink>, operationId: string): string | null {
  const tail = chainTail(chain, operationId);
  return tail.kind === "settled" ? tail.repair : null;
}

/**
 * note: Whether a recorded conflict reopens admission: its live `resolved_by` chain reaches a
 * confirmed terminal repair AND the observation shows that fork merged — exactly one current head
 * on the repaired record, and not one of the competing heads the conflict recorded. A complete
 * snapshot still carrying the fork proves the rows, never the merge.
 */
export function conflictMerged(
  db: StoreDb,
  chain: ReadonlyMap<string, ResolutionLink>,
  operationId: string,
  snapshot: RemoteSnapshot | null,
): boolean {
  const terminal = settledRepair(chain, operationId);
  if (terminal === null || snapshot === null) return false;
  let repair: StoredRequest;
  let fork: Extract<RemoteReceiptOutcome, { kind: "conflict" }>;
  try {
    repair = storedRequest(intentRow(db, terminal));
    fork = recordedFork(db, operationId);
  } catch {
    return false;
  }
  const heads = observedHeads(snapshot, repair.request.event, repair.request.target);
  const [head, ...rest] = heads;
  return head !== undefined && rest.length === 0 && !fork.observedHeads.includes(head);
}

/** note: The stored project snapshot a merge proof is read from, or null when absent or unreadable. */
function storedSnapshot(db: StoreDb, generation: number, projectKey: string): RemoteSnapshot | null {
  const scope = scopeRow(db, generation, projectKey);
  if (scope === undefined || typeof scope.snapshot_json !== "string") return null;
  try {
    return normalizeRetiredDocumentKind(JSON.parse(scope.snapshot_json) as RemoteSnapshot);
  } catch {
    return null;
  }
}

/** note: One binding lane's outbox rows, keyed by operation id, for resolution-chain walks. */
function outboxChain(db: StoreDb, generation: number, projectKey: string): Map<string, ResolutionLink> {
  const rows = db
    .prepare("select operation_id, state, resolved_by from remote_outbox where generation = ? and project_key = ?")
    .all(generation, projectKey) as Array<{ operation_id?: unknown; state?: unknown; resolved_by?: unknown }>;
  const chain = new Map<string, ResolutionLink>();
  for (const entry of rows) {
    if (typeof entry.operation_id !== "string" || typeof entry.state !== "string") continue;
    chain.set(entry.operation_id, {
      state: entry.state,
      resolvedBy: typeof entry.resolved_by === "string" ? entry.resolved_by : null,
    });
  }
  return chain;
}

/**
 * `dispatchRemoteIntent` / `outbox-dispatch`: issue the ONE send permit for the oldest enqueued
 * intent of its binding, atomically marking it `unconfirmed` before returning it. The frozen
 * base is re-checked against the persisted current head; a lost permit response is never a
 * second permit, and an unresolved send, conflict or foreign older intent refuses first. A
 * reviewed resolution must carry the `ForkObservation` that proves its fork, and the permit
 * binds that observation's generation, traversal start and cache revision.
 */
export async function dispatchRemoteIntent(
  context: StoreContext,
  operationId: string,
  forkObservation?: unknown,
): Promise<RemoteDispatchResult> {
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
  // note: The dispatch is the enqueued intent's own settlement route; it takes the outbox recovery
  // lane so a below-current cache can still dispatch and settle what it holds.
  return withRemoteCacheRecoveryWrite(context, (handle) => {
    const db = handle.db;
    const row = intentRow(db, target);
    noSettledClaim(row, "Only an enqueued intent is dispatched, and this claim was already carried by the observation.");
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
        `Operation ${target} is ${row.state}; only an enqueued intent is dispatched. Inspect it with ` +
          `\`mstar store collaboration remote outbox-show --harness <abs> --operation <uuid>\` and reconcile an ` +
          `uncertain attempt with \`mstar store collaboration remote outbox-reconcile --harness <abs> --input ` +
          `<file|->\`. Nothing was sent.`,
        { operationId: target, state: row.state },
      );
    }
    const resolution = row.resolves !== null;
    if (!resolution && forkObservation !== undefined && forkObservation !== null) {
      throw new StoreError(
        "remote.dispatch-refused",
        `Operation ${target} is not a reviewed resolution, so a fork observation is not its dispatch evidence; only an ` +
          `ordinary base re-check admits it. Nothing was sent.`,
        { operationId: target },
      );
    }
    // note: The observation is the reviewed resolution's whole base proof; ordinary sends never carry one.
    const observation =
      resolution && forkObservation !== undefined && forkObservation !== null ? forkObservationOf(forkObservation) : null;
    // invariant: An in-flight attempt or an unresolved conflict serializes sends. The forks a
    // reviewed intent repairs are exempt - its own resolved fork and every ancestor fork of that
    // repair (a repair can itself conflict) - so a reviewed successor of a conflicted repair
    // proceeds. Every other conflict still blocks until its LIVE chain reaches a confirmed
    // terminal repair AND the cached observation shows that fork merged; an abandoned repair keeps
    // the fork closed until a replacement resolution takes it over.
    const chain = outboxChain(db, row.generation, row.projectKey);
    const snapshot = storedSnapshot(db, row.generation, row.projectKey);
    const blocking = db
      .prepare(
        "select operation_id, state from remote_outbox where generation = ? and project_key = ? " +
          "and operation_id <> ? and state in ('unconfirmed','conflict') order by created_at, operation_id",
      )
      .all(row.generation, row.projectKey, target) as Array<{ operation_id?: unknown; state?: unknown }>;
    const repaired = repairedForks(db, target);
    const unresolved = blocking.find((entry) => {
      if (entry.state === "unconfirmed") return true;
      if (typeof entry.operation_id !== "string") return true;
      if (repaired.has(entry.operation_id)) return false;
      return !conflictMerged(db, chain, entry.operation_id, snapshot);
    });
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
    // invariant: A reviewed resolution is not an ordinary send: it repairs the fork the ordinary
    // intents ahead of it were prepared against, and each of those is refused by its OWN base
    // check once the fork moved, so queueing the repair behind them would deadlock both.
    if (row.resolves === null) {
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
    }
    const scope = scopeRow(db, row.generation, row.projectKey);
    if (scope === undefined) {
      throw new StoreError(
        "collaboration.stale-binding",
        `The cache records no binding for ${row.projectKey} at generation ${String(row.generation)}; nothing was sent.`,
        { operationId: target },
      );
    }
    assertDispatchScope(scope, stored, target, row.resolves !== null);
    assertDispatchBase(db, row, stored, observation);
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
          `\`mstar store collaboration remote outbox-show --harness <abs> --operation <uuid>\` before retrying. ` +
          `Nothing was sent.`,
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
        normalizedFromLegacy: stored.legacyRead,
        observation: {
          generation: observation === null ? row.generation : observation.generation,
          revision: typeof scope.revision === "number" ? scope.revision : 0,
          asOf: observation === null ? (typeof scope.as_of === "string" ? scope.as_of : null) : observation.asOf,
        },
      },
    } satisfies RemoteDispatchResult;
  }, { settleOutbox: true });
}

/** note: The history collections an issue subject carries; a merge keeps every branch's rows. */
const ISSUE_HISTORY_KEYS = ["occurrences", "transitions", "relations", "provenance", "projectMoves"] as const;

/**
 * invariant: A reviewed merge preserves BOTH branches. The event DAG keeps each branch as an
 * ancestor; this keeps that branch's rows inside the merged subject, so a replacement cannot
 * silently drop the history an operator reviewed.
 */
function assertResolutionHistory(
  frozen: RemoteEvent,
  recorded: Extract<RemoteReceiptOutcome, { kind: "conflict" }>,
  replacement: RemoteEvent,
  conflicted: string,
): void {
  if (replacement.change.kind !== "issue-replace") return;
  const merged = replacement.change.mstar;
  for (const branch of [frozen, ...recorded.observedRecords.map((entry) => entry.event)]) {
    if (branch.change.kind === "project-replace") continue;
    for (const key of ISSUE_HISTORY_KEYS) {
      const mergedRows = merged[key];
      const kept = new Set((Array.isArray(mergedRows) ? mergedRows : []).map((row) => canonicalJson(row)));
      const branchRows = branch.change.mstar[key];
      for (const row of Array.isArray(branchRows) ? branchRows : []) {
        if (kept.has(canonicalJson(row))) continue;
        throw new StoreError(
          "remote.operation-conflict",
          `The reviewed resolution of ${conflicted} drops a ${key} row that branch ${branch.operationId} carries; ` +
            `a merge preserves both branches' history. Nothing was enqueued.`,
          { operationId: conflicted, history: key, branch: branch.operationId },
        );
      }
    }
  }
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
  // note: The resolution settles a conflicted intent, so it takes the outbox recovery lane.
  return withRemoteCacheRecoveryWrite(context, (handle) => {
    const db = handle.db;
    const original = intentRow(db, conflicted);
    noSettledClaim(original, "A reviewed resolution needs a conflicted fork, and a settled claim has no fork.");
    const stored = storedRequest(original);
    assertFrozenBinding(db, stored.request.binding, conflicted);
    assertAdmittedLane(admittedLane(context), original, stored.request.binding, conflicted, "a reviewed resolution");
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
    // invariant: Q2: a resolution IS a replacement of the same subject. An issue conflict is
    // repaired by an issue-replace that keeps its portable reference; a project conflict by a
    // project-replace on the journal anchor. A create/adopt, or a re-keyed reference, is another
    // write rather than a repair of this fork.
    const intentChange = stored.request.event.change;
    if (intentChange.kind === "project-replace") {
      if (event.change.kind !== "project-replace") {
        invalid("resolution.event.change.kind", "a project-journal conflict is resolved by a project replacement");
      }
    } else if (event.change.kind !== "issue-replace") {
      invalid("resolution.event.change.kind", `a ${intentChange.kind} conflict is resolved by an issue replacement`);
    } else if (event.change.issueRef !== intentChange.issueRef) {
      invalid("resolution.event.change.issueRef", "must keep the conflicted issue's portable reference");
    }
    const parents = event.parents;
    const existing = db
      .prepare("select generation, project_key, request_hash, state, created_at, updated_at from remote_outbox where operation_id = ?")
      .get(operationId) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      // note: An identical replay returns the same resolution intent; a different one is a new conflicting id.
      const recorded = intentRow(db, operationId);
      if (settledClaim(recorded) !== null) {
        throw new StoreError(
          "remote.operation-conflict",
          `Operation ${operationId} is already recorded as a settled no-change claim; a resolution is a new, unused ` +
            `operation id. Nothing was enqueued.`,
          { operationId },
        );
      }
      const recordedRequest = storedRequest(recorded);
      if (
        recorded.resolves === conflicted &&
        recordedRequest.operator === operator &&
        recordedRequest.reason === reason &&
        remoteEventHead(recordedRequest.request.event) === remoteEventHead(event)
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
          confirmed: confirmedEffectOf(db, operationId),
          result: recordedResult(recorded.requestJson, operationId),
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
    if (original.resolvedBy !== null) {
      // note: A missing or unreadable link is DAMAGE the chain walk refuses below, not an intent-not-found.
      const linkedState = (() => {
        try {
          return intentRow(db, original.resolvedBy).state;
        } catch {
          return "missing";
        }
      })();
      if (linkedState !== "abandoned") {
        // note: The refusal names the row the SAME walk the settle rule follows ends at: the chain
        // tail is the row an operator can settle NOW, not the parent this command addressed.
        const tail = chainTail(outboxChain(db, original.generation, original.projectKey), conflicted);
        const step =
          tail.kind === "actionable"
            ? tail.state === "conflict"
              ? `record a reviewed replacement of THAT row with \`mstar store collaboration remote outbox-resolve ` +
                `--harness <abs> --operation ${tail.operationId} --input <file|->\` - a resolve only enqueues the repair - ` +
                `then dispatch it with \`mstar store collaboration remote outbox-dispatch --harness <abs> --operation ` +
                `<new-uuid> --input <file|->\` and record its confirming receipt`
              : tail.state === "enqueued"
                ? `dispatch it with \`mstar store collaboration remote outbox-dispatch --harness <abs> --operation ` +
                  `${tail.operationId} --input <file|->\` (or withdraw it with \`mstar store collaboration remote ` +
                  `outbox-abandon --harness <abs> --operation ${tail.operationId} --reason <text>\`)`
                : `inspect it with \`mstar store collaboration remote outbox-show --harness <abs> --operation ` +
                  `${tail.operationId}\`, then record that attempt's evidence with \`mstar store collaboration remote ` +
                  `outbox-receipt --harness <abs> --input <file|->\` or \`mstar store collaboration remote ` +
                  `outbox-reconcile --harness <abs> --input <file|->\``
            : tail.kind === "settled"
              ? `its chain ends at the confirmed repair ${tail.repair}, which holds the fork; inspect it with ` +
                `\`mstar store collaboration remote outbox-show --harness <abs> --operation ${tail.repair}\``
              : `its chain is damaged - a cycle or a missing link - so no row it names is settleable in place and ` +
                `the cache rebuild is the route: ${REMOTE_CACHE_REBUILD_ROUTE}`;
        const named =
          tail.kind === "actionable"
            ? `its live resolution chain (each conflicted row's own resolvedBy link) reaches ${tail.operationId}, which ` +
              `is ${tail.state}, and that is the row an operator can settle now - not ${conflicted} this command ` +
              `addressed: ${step}. `
            : `${step}. `;
        throw new StoreError(
          "remote.operation-conflict",
          `Operation ${conflicted} is already taken over: ${named}One live reviewed resolution per fork is admitted. ` +
            `Nothing was enqueued.`,
          tail.kind === "actionable"
            ? { operationId: conflicted, resolvedBy: original.resolvedBy, actionable: tail.operationId, actionableState: tail.state }
            : { operationId: conflicted, resolvedBy: original.resolvedBy },
        );
      }
      // invariant: An abandoned repair is a withdrawn review. Its row, `resolves` edge, reason and
      // receipts stay for audit, while a new reviewed replacement takes over the same fork.
    }
    const recorded = recordedFork(db, conflicted);
    if (!sameHeads(parents, recorded.observedHeads)) {
      throw new StoreError(
        "remote.operation-conflict",
        `The resolution's parents must be the complete fork-head set ${conflicted} recorded; a partial fork never ` +
          `authorizes a replacement. Nothing was enqueued.`,
        { operationId: conflicted, fork: recorded.observedHeads },
      );
    }
    assertResolutionHistory(stored.request.event, recorded, event, conflicted);
    // note: A merge legitimately decides the CURRENT fields (a reviewed resolution of a fork may
    // keep either branch's disposition), so admission proves the history both branches carry. The
    // business OUTCOME the original request named is proved later, by the composite that acknowledges
    // it: a settled repair whose recorded disposition is not the requested one is never acknowledged.
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
      confirmed: null,
      result: null,
      replayed: false,
      createdAt: at,
      updatedAt: at,
    } satisfies RemoteIntent;
  }, { settleOutbox: true });
}

/**
 * `abandonRemoteIntent` / `outbox-abandon`: explicit abandonment, only before dispatch, or after
 * durable evidence that nothing was sent. An ambiguous effect is never abandoned as absent; the
 * reason and the attempt history are retained.
 */
export async function abandonRemoteIntent(
  context: StoreContext,
  input: Readonly<{ operationId: string; reason: string }>,
): Promise<RemoteIntentRead> {
  const operationId = linearId(input?.operationId, "operationId");
  const reason = text(input?.reason, "reason");
  // note: The abandonment settles one intent, so it takes the outbox recovery lane.
  return withRemoteCacheRecoveryWrite(context, (handle) => {
    const db = handle.db;
    const row = intentRow(db, operationId);
    noSettledClaim(row, "An abandonment names an unpublished request, and this claim was already settled by the observation.");
    const stored = storedRequest(row);
    assertAdmittedLane(admittedLane(context), row, stored.request.binding, operationId, "an abandonment");
    // note: The retained reason and the row's state share one disclosure decision: a denial or an
    // expired check withholds the free text from every response, refusals included.
    const disclosure = readPermission(db, row.generation, row.projectKey);
    if (row.state === "abandoned") {
      const retained = disclosure === "full" ? ` (${String(row.abandonReason)})` : "";
      throw new StoreError(
        "remote.dispatch-refused",
        `Operation ${operationId} is already abandoned${retained}; an abandonment replays through ` +
          `\`mstar store collaboration remote outbox-show --harness <abs> --operation <uuid>\` and is never ` +
          `rewritten.` +
          (disclosure === "full" ? "" : " Its retained reason stays withheld while this scope's read permission does not hold."),
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
      // invariant: Only the ORIGINAL host's pre-send receipt proves nothing was sent; a
      // reconciliation is never accepted as that proof.
      const notSent = db
        .prepare(
          "select 1 as found from remote_outbox_receipts where operation_id = ? and outcome = 'not-sent' " +
            "and source = 'receipt' limit 1",
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
    // invariant: The response is an inspection of the abandoned row, so a denied or expired
    // access check withholds the retained business payload instead of echoing it back.
    return intentRead(db, intentRow(db, operationId), stored, disclosure);
  }, { settleOutbox: true });
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
  /** note: The observation revision this snapshot was read at; the freeze transaction re-proves it. */
  observationRevision: number;
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
 * note: Whether a provider traversal STARTED inside the freshness window. Distinct from the
 * access check: a verification proves authorization, not when the provider data was traversed.
 */
function traversalCurrent(asOf: unknown): boolean {
  return (
    typeof asOf === "string" &&
    Number.isFinite(Date.parse(asOf)) &&
    Math.abs(Date.now() - Date.parse(asOf)) <= REMOTE_SCOPE_TTL_MS
  );
}

/**
 * note: Read the project's current complete observation together with the binding it was frozen
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
    // invariant: The access check and the provider traversal are separate clocks: a check made
    // now over a traversal that started outside the window still cannot freeze a base.
    if (!traversalCurrent(scope.as_of)) {
      throw new StoreError(
        "collaboration.observation-stale",
        `The provider traversal of project ${projectId} began at ${String(scope.as_of ?? "an unrecorded time")}, outside the ` +
          `${String(REMOTE_SCOPE_TTL_MS / 1000)}-second freshness window, so no base can be frozen from it even though its ` +
          `access check is current. Re-observe the whole scope; nothing was enqueued.`,
      );
    }
    let snapshot: RemoteSnapshot;
    try {
      // see packages/engine/src/collaboration-remote.ts - // invariant: The write path parses the SAME admitted evidence the read path does, so it takes the
      // same normalization: a cache admitted before the retirement must not make this process refuse its
      // own project-replace over a kind it no longer knows.
      snapshot = normalizeRetiredDocumentKind(JSON.parse(scope.snapshot_json) as RemoteSnapshot);
    } catch {
      throw new StoreError(
        "collaboration.unreadable",
        `The stored observation of project ${projectId} is unreadable; nothing was enqueued.`,
      );
    }
    await remoteWriteScopeGapForTest?.();
    return {
      location,
      selection,
      binding: { ...materializedIntentBinding(scope, projectId), generation: binding.generation },
      snapshot,
      observationRevision: typeof scope.revision === "number" && Number.isSafeInteger(scope.revision) ? scope.revision : 0,
    };
  } finally {
    handle.close();
  }
}

/**
 * invariant: A `remote` source has no `issues` row, so no lane trigger can guard its record. This is
 * that fence, once, for every remote issue write: a source row in a blocking phase refuses the write
 * exactly as the local triggers refuse a local one. The move's own steps declare themselves through
 * their origin verb and pass; every other write meets the same refusal the local lane's triggers raise.
 *
 * The returned check reads the ledger INSIDE the transaction that freezes the intent, so a move staged
 * between the observation and the freeze still refuses instead of slipping past a separate look. It is
 * resolved by the record's REFERENCE — the one address a provider-UUID-addressed replacement also
 * resolves — so no addressing shape escapes the fence.
 */
type MoveFence = (db: StoreDb) => void;

async function moveFenceOf(
  context: StoreContext,
  issueRef: IssueRef | null,
  origin: RemoteWriteOrigin,
): Promise<MoveFence | undefined> {
  if (issueRef === null) return undefined;
  if (origin.verb === "issue-move") return undefined;
  if (resolveCollaborationLocation(context).mode !== "remote") return undefined;
  const { blockingMoveForRef } = await import("./cross-authority-move.js");
  return (db) => {
    const frozen = blockingMoveForRef(db, issueRef);
    if (frozen === null) return;
    throw new StoreError(
      "issue.move-in-progress",
      `${issueRef} is frozen by move ${frozen.operationId} in phase ${frozen.phase}, so no provider write addresses it until ` +
        `that move publishes or is discarded. Nothing was enqueued.`,
      {
        issue_ref: issueRef,
        operation_id: frozen.operationId,
        phase: frozen.phase,
        recovery:
          `Finish the move with the same operation id, or discard it with \`--discard\` before the destination admits the ` +
          `record; then retry this write.`,
      },
    );
  };
}

/** note: The caller's observed base and the move fence, both proved in the same freeze transaction. */
function freezeGuards(
  base: ((observed: { observationRevision: number }, db: StoreDb) => void) | undefined,
  fence: MoveFence | undefined,
): ((observed: { observationRevision: number }, db: StoreDb) => void) | undefined {
  if (fence === undefined) return base;
  return (observed, db) => {
    base?.(observed, db);
    fence(db);
  };
}

/** note: The observed issue one remote write addresses, with the project scope it was found in. */
type ObservedIssue = Readonly<{
  scope: ObservedScope;
  native: RemoteIssue;
  /** note: The bound project when the caller named none: the write still addresses exactly one. */
  projectId: string;
}>;

/**
 * note: The observed issues one remote capture dedupes against, read under the same
 * complete-and-current scope proof a write freezes under. A capture needs the
 * authority's established occurrences BEFORE it chooses create versus append, so it
 * reads this instead of guessing from nothing.
 */
export async function readRemoteObservedIssues(
  context: StoreContext,
  projectId: string,
): Promise<readonly RemoteIssue[]> {
  return (await readWriteScope(context, projectId)).snapshot.issues;
}

/**
 * note: Resolve the project one addressed issue lives in. A remote write addresses one project; a
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
  const unreadable: string[] = [];
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
        unreadable.push(candidate);
        continue;
      }
      throw error;
    }
    const native = byRef
      ? scope.snapshot.issues.find((issue) => issue.mstar !== null && issue.mstar.issueRef === addressed)
      : scope.snapshot.issues.find((issue) => issue.identity.issueId === addressed);
    if (native !== undefined) return { scope, native, projectId: candidate };
  }
  // invariant: A lookup miss is proven only over complete, current observations. An unreadable
  // candidate leaves the provider state unknown, which is never reported as an absence.
  if (unreadable.length > 0) {
    throw new StoreError(
      "remote.unavailable",
      `Issue ${addressed} was matched in no readable project, and ${unreadable.join(", ")} could not be read with a ` +
        `complete, current observation. An unavailable scope never proves absence. Refresh it with \`remote observe\` ` +
        `and retry; nothing was enqueued.`,
      { candidates: unreadable },
    );
  }
  throw new IssueError(
    "issue.not-found",
    `Issue ${addressed} is not observed in ${projectId === undefined ? "any selected project" : `project ${projectId}`}; ` +
      `nothing was enqueued.`,
  );
}

/** note: The observed scope one remote issue write derives its subject and referenced entities from. */
export type RemoteObservedSubject = Readonly<{
  projectId: string;
  project: RemoteSnapshotProject;
  issues: readonly RemoteIssue[];
}>;

/**
 * note: A write the observed authority ALREADY carries: the domain's own idempotent outcome, with
 * nothing frozen. The local verb returns the established receipt for the same observation; freezing
 * a second event for it would append duplicate history.
 */
export type RemoteNoChange = Readonly<{ noChange: unknown }>;

/**
 * invariant: The boundary an established answer is proved at, exactly as an insert is: inside
 * the remote-cache write lane, the lock every freeze takes. The `unchanged` decision read a
 * SAMPLE, so at the decision boundary this re-reads the outbox row under the operation id — a
 * concurrent capture that froze it between the replay lookup and this answer is a replay or a
 * collision, never an established success answered over it — and re-proves the sampled
 * observation revision, refusing a no-op decided on a superseded base.
 *
 * A PROVEN answer is then recorded, not merely reported: the operation id is claimed under the
 * outbox's own uniqueness boundary with the request identity that established it and the business
 * result, as a SETTLED CLAIM that is never dispatchable (nothing was sent, and nothing ever will
 * be). The claim carries its replay identity, never the observed subject: an observation may hold
 * history the replacement contract refuses, and no provider event is ever represented by it. A
 * later write under that id therefore meets a durable row instead of freezing a different provider
 * effect, and an identical request replays the recorded answer.
 */
async function recordEstablishedNoOp(
  context: StoreContext,
  claim: {
    operationId: string;
    binding: RemoteIntentBinding;
    sampledRevision: number;
    /** note: The replay identity of the established write: what an identical replay must match. */
    identity: Readonly<{
      kind: RemoteEventChange["kind"];
      issueRef: IssueRef;
      target: string;
      executionKey: RemoteIntentExecutionKey | null;
      origin: RemoteWriteOrigin;
    }>;
    result: unknown;
    /** note: The move fence, read in the same transaction as the settled claim. */
    fence?: MoveFence;
  },
): Promise<"durable" | "recorded"> {
  return withRemoteCacheWrite(context, (handle) => {
    const row = handle.db
      .prepare("select 1 as found from remote_outbox where operation_id = ?")
      .get(claim.operationId) as { found?: number } | undefined;
    if (row !== undefined) return "durable" as const;
    claim.fence?.(handle.db);
    const current = observationRevisionOf(handle.db, claim.binding.generation, claim.binding.projectKey);
    if (current !== claim.sampledRevision) {
      throw new StoreError(
        "collaboration.observation-stale",
        `The observed scope of project ${claim.binding.projectKey} moved under this write's sampled base (observation ` +
          `revision ${String(claim.sampledRevision)} at read, ${String(current)} at the established answer), so its ` +
          `no-op decision cannot answer on it. Re-run \`mstar store collaboration remote observe\` and reissue the ` +
          `SAME verb with the SAME operation id; nothing was enqueued.`,
        {
          projectId: claim.binding.projectKey,
          sampledRevision: claim.sampledRevision,
          freezeRevision: current,
          recovery:
            "Re-run `mstar store collaboration remote observe --harness <abs> --input <file|->` for this project, then reissue the SAME verb with the SAME operation id.",
        },
      );
    }
    const identity = {
      settled: 1,
      binding: claim.binding,
      kind: claim.identity.kind,
      issueRef: claim.identity.issueRef,
      target: claim.identity.target,
      origin: claim.identity.origin,
    };
    const requestHash = createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex");
    const at = nowRfc3339();
    handle.db
      .prepare(
        "insert into remote_outbox(operation_id, generation, project_key, request_hash, request_json, execution_key_json, " +
          "state, created_at, updated_at, abandon_reason) values (?, ?, ?, ?, ?, ?, 'abandoned', ?, ?, ?)",
      )
      .run(
        claim.operationId,
        claim.binding.generation,
        claim.binding.projectKey,
        requestHash,
        canonicalJson({ ...identity, result: { noChange: claim.result } }),
        claim.identity.executionKey === null ? null : canonicalJson(claim.identity.executionKey),
        at,
        at,
        NO_CHANGE_REASON,
      );
    return "recorded" as const;
  });
}

/** note: The retained cause of a recorded no-change claim: no provider effect was ever needed. */
const NO_CHANGE_REASON =
  "no-change: the observed authority already carried this request, so no provider effect was needed and nothing was sent";

/**
 * note: The business answer a SETTLED no-change claim records, or null for an ordinary intent: its
 * freeze report carries the domain result rather than the intent's own receipt shapes.
 */
function recordedNoChange(result: unknown): { answer: unknown } | null {
  if (!isRecord(result) || Object.keys(result).length !== 1 || !("noChange" in result)) return null;
  return { answer: result.noChange };
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
  next(current: Record<string, unknown> | null, observed: RemoteObservedSubject): Record<string, unknown>;
  /**
   * note: The occurrence key this write appends or creates, when it carries one: a confirmed
   * replay's receipt names THAT occurrence's eventId in the confirmed event, so the business
   * answer points at the recorded occurrence.
   */
  occurrenceKey?: string;
  /**
   * note: The replay identity: the business verb and its COMPLETE normalized request. Only the
   * identical request replays; another verb, target or payload under the same operation id refuses.
   */
  origin: RemoteWriteOrigin;
  /**
   * note: The domain's no-change outcome when the observed subject already carries this very
   * observation; a non-null answer freezes nothing and is returned to the caller.
   */
  unchanged?(
    current: Record<string, unknown> | null,
    observed: RemoteObservedSubject,
  ): unknown | null;
  /**
   * note: A caller-observed base proved inside the freeze transaction, exactly as a project
   * write's guard is: a caller whose `--expect-store` moved under it refuses instead of
   * silently superseding the newer base.
   */
  guard?: (observed: { observationRevision: number }, db: StoreDb) => void;
  /** note: A composite's execution reservation, so the provider effect settles it. */
  executionKey?: RemoteIntentExecutionKey | null;
  /** note: The composite reservation this intent belongs to; its durable decline refuses the freeze. */
  reservation?: RemoteReservationKey | null;
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
 * invariant: The freeze transaction re-proves the observation the write's decisions were made
 * against: dedupe, gates and no-op answers all read a SAMPLE, and only the revision checked
 * inside the freeze transaction proves that sample still IS the current observation. A moved
 * scope refuses instead of freezing decisions about a superseded base.
 */
function proveSampledBase(
  sampledProjectId: string,
  sampledRevision: number,
  callerGuard: ((observed: { observationRevision: number }, db: StoreDb) => void) | undefined,
): (observed: { observationRevision: number }, db: StoreDb) => void {
  return (observed, db) => {
    if (observed.observationRevision !== sampledRevision) {
      throw new StoreError(
        "collaboration.observation-stale",
        `The observed scope of project ${sampledProjectId} moved under this write's sampled base (observation ` +
          `revision ${String(sampledRevision)} at read, ${String(observed.observationRevision)} at freeze), so its ` +
          `dedupe and gate decisions cannot freeze on it. Re-run \`mstar store collaboration remote observe\` and ` +
          `reissue the SAME verb with the SAME operation id; nothing was enqueued.`,
        {
          projectId: sampledProjectId,
          sampledRevision,
          freezeRevision: observed.observationRevision,
          recovery:
            "Re-run `mstar store collaboration remote observe --harness <abs> --input <file|->` for this project, then reissue the SAME verb with the SAME operation id.",
        },
      );
    }
    callerGuard?.(observed, db);
  };
}

/** note: Field-wise identity of one execution reservation; the frozen key is never compared as serialized JSON. */
function sameExecutionKey(left: RemoteIntentExecutionKey | null, right: RemoteIntentExecutionKey | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.executionStoreId === right.executionStoreId &&
    left.executionEpoch === right.executionEpoch &&
    left.operationId === right.operationId
  );
}

/**
 * note: The replay of one ordinary write: an operation id that already holds a frozen intent returns
 * THAT intent, so a retried verb never re-derives a different subject (a minted reference, a
 * milestone id, a recorded time) and never rewrites the accepted request. The identity is the
 * recorded business verb and its complete normalized request: a different verb, target or payload
 * under the same id is a conflict, never a replay.
 */
async function replayedIntent(
  context: StoreContext,
  operationId: string,
  kind: RemoteEventChange["kind"],
  projectKey: string | null,
  target: string | null | undefined,
  issueRef: string | null,
  executionKey: RemoteIntentExecutionKey | null,
  origin: RemoteWriteOrigin,
): Promise<RemoteIntent | RemoteNoChange | null> {
  let read: RemoteIntentRead;
  try {
    read = await readRemoteIntent(context, operationId);
  } catch (error) {
    if (error instanceof StoreError && error.code === "remote.intent-not-found") return null;
    throw error;
  }
  if (read.disclosure !== "full" || (read.event === null && read.settled === null)) {
    throw new StoreError(
      "remote.unavailable",
      `Operation ${operationId} cannot be replayed: the project's current read access is denied or expired, so its frozen ` +
        `request stays withheld. Reverify the scope with \`remote observe\` and retry; nothing was enqueued.`,
      { operationId, state: read.state },
    );
  }
  const selection = remoteSelection(resolveCollaborationLocation(context));
  const conflict = (detail: string, details: Record<string, unknown> = {}): never => {
    throw new StoreError(
      "remote.operation-conflict",
      `Operation ${operationId} ${detail}; an operation id is reused only for the identical binding, target, request and ` +
        `execution key. Inspect it with ` +
        `\`mstar store collaboration remote outbox-show --harness <abs> --operation <uuid>\` and submit a new id for ` +
        `the corrected write. Nothing was enqueued.`,
      // invariant: This refusal READ a durable outbox row, so it proves the failure happened AFTER
      // a freeze — never a pre-freeze decline fact for a composite frame.
      { operationId, state: read.state, durable_intent: true, ...details },
    );
  };
  const event = read.event;
  // invariant: A settled no-change claim carries its own recorded replay identity; it is not a
  // provider event, so the identity comparison reads whichever shape the row recorded.
  const settled = read.settled;
  if (read.generation !== selection.generation) {
    return conflict(`was frozen under generation ${String(read.generation)}, not the checked ${String(selection.generation)}`);
  }
  if (projectKey !== null && read.projectId !== projectKey) {
    return conflict(`addresses project ${read.projectId}, not ${projectKey}`);
  }
  const frozenKind = settled === null ? event!.change.kind : settled.kind;
  if (frozenKind !== kind) return conflict(`is already frozen as a ${frozenKind} intent`);
  const frozenRef =
    settled !== null ? settled.issueRef : event!.change.kind === "project-replace" ? null : event!.change.issueRef;
  if (issueRef !== null && frozenRef !== issueRef) {
    return conflict(`addresses portable issue ${String(frozenRef)}, not ${issueRef}`);
  }
  if (target !== undefined && read.target !== target) {
    return conflict(`addresses provider record ${String(read.target)}, not ${String(target)}`);
  }
  if (!sameExecutionKey(read.executionKey, executionKey)) {
    return conflict("was frozen under another execution reservation");
  }
  if (read.origin === null || read.origin.verb !== origin.verb || !isDeepStrictEqual(read.origin.request, origin.request)) {
    return conflict(`is frozen under the business request ${read.origin === null ? "of no recorded verb" : `"${read.origin.verb}"`}`);
  }
  // invariant: A RECORDED settled claim returns its answer, never a pending intent: it was settled
  // by construction (no attempt, no receipt), and a different request under the id refused above.
  if (settled !== null) {
    const recorded = recordedNoChange(read.result);
    if (recorded === null) {
      throw new StoreError(
        "store.corrupt",
        `Operation ${operationId} holds a settled no-change claim with no recorded answer; nothing was enqueued.`,
        { operationId },
      );
    }
    return { noChange: recorded.answer };
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
    confirmed: read.confirmed,
    result: read.result,
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
export async function prepareRemoteIssueWrite(
  context: StoreContext,
  write: RemoteIssueWrite,
): Promise<RemoteIntent | RemoteNoChange> {
  const operationId = linearId(write?.operationId, "operationId");
  const kind = oneOf(write?.kind, ["issue-create", "issue-adopt", "issue-replace"] as const, "kind");
  const origin = writeOrigin(write?.origin, "origin");
  const executionKey = write?.executionKey ?? null;
  const declaredRef = write?.issueRef === undefined ? null : assertIssueRef(write.issueRef);
  // invariant: A create/adoption reference is derived from its operation id, so a replay repeats it.
  // A replacement addressed by stable reference compares that reference; one addressed by provider id
  // compares the frozen target. Either way another target of the same kind never replays.
  const addressedIssue = write?.issueId;
  const replayRef =
    declaredRef ??
    (kind === "issue-replace"
      ? addressedIssue !== undefined && ISSUE_REF_PATTERN.test(addressedIssue)
        ? addressedIssue
        : null
      : issueRefForOperation(operationId));
  const replayTarget =
    addressedIssue === undefined || !UUID.test(addressedIssue) ? undefined : linearId(addressedIssue, "issueId");
  const replayProjectKey = write?.projectId === undefined ? null : text(write.projectId, "projectId");
  const replay = await replayedIntent(
    context,
    operationId,
    kind,
    replayProjectKey,
    replayTarget,
    replayRef,
    executionKey,
    origin,
  );
  if (replay !== null) return replay;
  await remoteReplayAdmissionGapForTest?.();
  if (kind === "issue-create") {
    const issueRef = declaredRef ?? issueRefForOperation(operationId);
    const fence = await moveFenceOf(context, issueRef, origin);
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
    const observed = { projectId, project: scope.snapshot.project, issues: scope.snapshot.issues };
    return prepareRemoteIntent(context, {
      binding: scope.binding,
      event: {
        version: 1,
        repoKey: scope.location.repoKey,
        projectId,
        operationId,
        parents: [],
        change: { kind, issueRef, mstar: write.next(null, observed) },
      },
      target: null,
      expectedHeads: [],
      executionKey,
      origin,
    }, freezeGuards(proveSampledBase(projectId, scope.observationRevision, write.guard), fence), write.reservation ?? null);
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
  const observed = { projectId, project: scope.snapshot.project, issues: scope.snapshot.issues };
  const current = native.mstar === null ? null : currentIssueSubject(native.mstar);
  // note: The fence is resolved from the OBSERVED reference, so an adoption or replacement addressed by
  // provider id is fenced exactly as one addressed by reference.
  const fence = await moveFenceOf(context, issueRef, origin);
  // invariant: A write the observed authority already carries is the domain's own no-op, decided
  // BEFORE a second event is frozen; a conflicting payload refuses through the same callback. The
  // answer is replay-first and observation-proven like an insert: the boundary re-check under the
  // write lane serves a durable same-id operation instead of it, and refuses a no-op whose
  // sampled base a concurrent effect superseded.
  const established = write.unchanged?.(current, observed) ?? null;
  if (established !== null) {
    // note: An adoption or replacement always observes the subject it rewrites, so the satisfied
    // request has a replay identity; a create never reaches this branch.
    const proof = await recordEstablishedNoOp(context, {
      operationId,
      binding: scope.binding,
      sampledRevision: scope.observationRevision,
      identity: { kind, issueRef, target: native.identity.issueId, executionKey, origin },
      result: established,
      ...(fence === undefined ? {} : { fence }),
    });
    if (proof === "durable") {
      const durable = await replayedIntent(context, operationId, kind, replayProjectKey, replayTarget, replayRef, executionKey, origin);
      if (durable === null) {
        throw new StoreError(
          "store.corrupt",
          `Operation ${operationId} holds a durable outbox row that no longer replays; nothing was enqueued.`,
          { operationId },
        );
      }
      return durable;
    }
    return { noChange: established };
  }
  return prepareRemoteIntent(context, {
    binding: scope.binding,
    event: {
      version: 1,
      repoKey: scope.location.repoKey,
      projectId,
      operationId,
      parents,
      change: {
        kind,
        issueRef,
        mstar: write.next(current, observed),
      },
    },
    target: native.identity.issueId,
    expectedHeads: parents,
    executionKey,
    origin,
  }, freezeGuards(proveSampledBase(projectId, scope.observationRevision, write.guard), fence), write.reservation ?? null);
}

/**
 * note: The intent a prepare froze. Only a write that declared a no-change callback can answer
 * otherwise, so a caller that admits no such outcome refuses instead of mapping it to a success.
 */
export function frozenIntent(outcome: RemoteIntent | RemoteNoChange): RemoteIntent {
  if ("noChange" in outcome) {
    throw new StoreError(
      "store.corrupt",
      "A write the observed authority already carries reached a caller that admits no no-change outcome; nothing was " +
        "enqueued and nothing was changed.",
    );
  }
  return outcome;
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
  /**
   * note: The replay identity, exactly as `RemoteIssueWrite.origin`: only the identical business
   * verb and complete request replay; a different verb or payload refuses.
   */
  origin: RemoteWriteOrigin;
  /**
   * note: The business result of this request, derived from the SAME observed document `next` read.
   * It is recorded with the intent, because the post-write observation no longer carries the
   * before-state a replay would need to re-derive it.
   */
  result?(current: Record<string, unknown>, subject: Record<string, unknown>): unknown;
  executionKey?: RemoteIntentExecutionKey | null;
  /** note: The composite reservation this intent belongs to; its durable decline refuses the freeze. */
  reservation?: RemoteReservationKey | null;
  /** note: A caller-observed base proved inside the freeze transaction; a moved base refuses the write. */
  guard?: (observed: { observationRevision: number }) => void;
}>;

/**
 * Freeze one ordinary PROJECT-JOURNAL change (milestones, portable catalog) as a
 * durable remote intent against the observed journal head. Never a local SQL effect.
 */
export async function prepareRemoteProjectWrite(context: StoreContext, write: RemoteProjectWrite): Promise<RemoteIntent> {
  const projectId = text(write?.projectId, "projectId");
  const operationId = linearId(write?.operationId, "operationId");
  const origin = writeOrigin(write?.origin, "origin");
  const replay = await replayedIntent(
    context,
    operationId,
    "project-replace",
    projectId,
    undefined,
    null,
    write.executionKey ?? null,
    origin,
  );
  if (replay !== null) return replayedOnly(replay, operationId);
  const scope = await readWriteScope(context, projectId);
  const parents = scope.snapshot.project.head ?? [];
  const current = {
    projectId,
    milestones: scope.snapshot.project.milestones,
    catalogEntities: scope.snapshot.project.catalogEntities,
    catalogLinks: scope.snapshot.project.catalogLinks,
  };
  const subject = write.next(current, scope.snapshot.issues);
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
    origin,
    ...(write.result === undefined ? {} : { result: write.result(current, subject) }),
  }, write.guard, write.reservation ?? null);
}

/**
 * invariant: The ordinary business verbs' outcome of a remote write. A durable enqueue is never
 * mapped to business success: the caller returns this refusal with the actual outbox state. A
 * CONFIRMED intent never reaches this function - the verb derives its recorded business result
 * from `intent.confirmed` instead (Q2: a replay of the confirmed verb returns its recorded result).
 */
export function pendingRemoteEffect(intent: RemoteIntent): StoreError {
  if (intent.state === "confirmed") {
    throw new StoreError(
      "store.corrupt",
      `Operation ${intent.operationId} is confirmed, so it is reported by its recorded business result, never as a ` +
        `pending refusal. This is an internal inconsistency; nothing was changed.`,
      { operationId: intent.operationId, state: intent.state },
    );
  }
  return new StoreError(
    "remote.effect-pending",
    `The write is durably enqueued as operation ${intent.operationId} in state ${intent.state}. It is not a business ` +
      `success yet: dispatch it with \`mstar store collaboration remote outbox-dispatch --harness <abs> --operation ` +
      `<uuid>\`, then record the provider result with \`mstar store collaboration remote outbox-receipt --harness ` +
      `<abs> --input <file|->\`. Inspect it with \`mstar store collaboration remote outbox-show --harness <abs> ` +
      `--operation <uuid>\`.`,
    {
      operationId: intent.operationId,
      state: intent.state,
      confirmedComponents: [],
      recovery:
        "`mstar store collaboration remote outbox-show --harness <abs> --operation <uuid>` for the state, " +
        "`mstar store collaboration remote outbox-dispatch --harness <abs> --operation <uuid>` for the one send permit, " +
        "`mstar store collaboration remote outbox-receipt --harness <abs> --input <file|->` for the result, then " +
        "reissue this same verb with the same operation id to receive the recorded business result.",
    },
  );
}
