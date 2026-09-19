/**
 * issue.ts — capture, occurrences, reads, and authorized disposition (plan C2/C3).
 *
 * In-process domain verbs on the C1 store boundary. Dedup is source /
 * root-cause / acceptance (`identity_key`), never title. Observation
 * identity lives in `occurrence_key`. Unknown semantic identity refuses
 * `issue.ambiguous-identity` instead of guessing a merge.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readSessionEnvelope, sessionFilePath, type CoordinationSession } from "./coordination.js";
import type { CoordinatorBinding, RowCoordination } from "./coordination-write.js";
import { canonicalizeNearestExisting, resolveWorkflowDir } from "./path.js";
import { rowPlanIds } from "./status.js";
import { openStore, type StoreContext, type StoreDb, type StoreHandle } from "./store-db.js";
import {
  WORKFLOW_SNAPSHOT_FILE,
  isTerminalSnapshot,
  readWorkflowSnapshot,
  type WorkflowSnapshot,
} from "./workflow.js";

export type IssueKind = "bug" | "risk" | "improvement" | "request" | "decision" | "review-obligation";
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type TerminalDisposition = "resolved" | "waived" | "duplicate" | "superseded";
export type Disposition = "open" | TerminalDisposition;

export type MutationContext = {
  operationId: string;
  actor: string;
  sessionFile?: string;
  expectedRevision?: number;
};

export type CaptureInput = {
  projectId: string;
  title: string;
  kind: IssueKind;
  severity: Severity;
  impact: string;
  acceptance: string;
  owner?: string;
  sourceIdentity: string;
  rootCauseKey: string;
  acceptanceKey: string;
  occurrenceKey: string;
  sourceKind: string;
  location: string;
  observedBehavior: string;
  evidence: string[];
  discoveredAt: string;
};

export type OccurrenceInput = {
  sourceIdentity: string;
  rootCauseKey: string;
  acceptanceKey: string;
  occurrenceKey: string;
  sourceKind: string;
  location: string;
  observedBehavior: string;
  evidence: string[];
  discoveredAt: string;
};

export type IssueReceipt = {
  issueId: string;
  occurrenceId?: number;
  revision: number;
  storeRevision: number;
  created: boolean;
};

export type IssueFilter = {
  projectId?: string;
  disposition?: Disposition;
  kind?: IssueKind;
  severity?: Severity;
  query?: string;
  limit?: number;
  offset?: number;
};

export type IssueSummary = {
  id: string;
  projectId: string;
  title: string;
  kind: IssueKind;
  severity: Severity;
  disposition: Disposition;
  registeredAt: string | null;
  lastActivity: string | null;
  revision: number;
};

export type IssuePage = {
  items: IssueSummary[];
  total: number;
  storeRevision: number;
};

export type IssueOccurrence = {
  id: number;
  occurrenceKey: string;
  sourceKind: string;
  sourceIdentity: string;
  rootCauseKey: string;
  acceptanceKey: string;
  location: string;
  observedBehavior: string;
  evidence: string[];
  discoveredAt: string | null;
  recordedAt: string;
  imported: boolean;
};

export type IssueTransition = {
  id: number;
  fromDisposition: string;
  toDisposition: string;
  actor: string | null;
  occurredAt: string | null;
  recordedAt: string;
  reason: string;
  evidence: unknown;
  imported: boolean;
  issueRevision: number;
};

export type IssueRelation = {
  fromIssue: string;
  relation: string;
  toIssue: string;
};

export type IssueProvenance = {
  id: number;
  kind: string;
  target: string;
  sourceHash: string;
  legacyProject: string | null;
  legacyBucket: string | null;
  legacyEntryId: string | null;
  legacyJson: string | null;
  importedAt: string | null;
};

export type IssueDetail = {
  id: string;
  projectId: string;
  title: string;
  kind: IssueKind;
  severity: Severity;
  disposition: Disposition;
  impact: string;
  acceptance: string;
  owner: string | null;
  registeredAt: string | null;
  closedAt: string | null;
  closureNote: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
  provider: string;
  externalId: string | null;
  url: string | null;
  identityKey: string;
  occurrences: IssueOccurrence[];
  transitions: IssueTransition[];
  relations: IssueRelation[];
  provenance: IssueProvenance[];
};

export type IssueTriage = {
  kind?: IssueKind;
  severity?: Severity;
  impact?: string;
  acceptance?: string;
  owner?: string | null;
  reason: string;
};

/**
 * Closure evidence (contract §4/§5). `references` carry the acceptance
 * evidence a `resolved` closure rests on; `alignmentRef` records the
 * **authority** that supplied it — the QA gate's acceptance when the QA seat
 * produced the evidence, or the PM acceptance record when it did not (§6:
 * leaf audit/QC/QA seats return evidence and never write the store, so the QA
 * gate is an evidence authority and the envelope-proven seat performs the
 * write). `waived` keeps its own alignmentRef requirement (user/architect
 * alignment), and duplicate/superseded name their canonical issue.
 */
export type ClosureEvidence = {
  reason: string;
  scope?: string;
  references: string[];
  canonicalIssueId?: string;
  alignmentRef?: string;
};

export type IssueLink =
  | { relation: "related" | "blocks" | "duplicate-of" | "superseded-by"; issueId: string }
  | { kind: "plan" | "iteration" | "pr" | "report"; target: string };


export type IssueErrorCode =
  | "issue.not-found"
  | "issue.ambiguous-identity"
  | "issue.occurrence-conflict"
  | "issue.scope-refused"
  | "issue.revision-conflict"
  | "issue.invalid-disposition"
  | "store.not-active"
  | "store.operation-conflict";

export class IssueError extends Error {
  readonly code: IssueErrorCode;

  constructor(code: IssueErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "IssueError";
    this.code = code;
  }
}

const KINDS: Record<IssueKind, true> = {
  bug: true,
  risk: true,
  improvement: true,
  request: true,
  decision: true,
  "review-obligation": true,
};
const SEVERITIES: Record<Severity, true> = {
  critical: true,
  high: true,
  medium: true,
  low: true,
  info: true,
};
const DISPOSITIONS: Record<Disposition, true> = {
  open: true,
  resolved: true,
  waived: true,
  duplicate: true,
  superseded: true,
};
const RELATIONS: Record<"related" | "blocks" | "duplicate-of" | "superseded-by", true> = {
  related: true,
  blocks: true,
  "duplicate-of": true,
  "superseded-by": true,
};
const PROVENANCE_KINDS: Record<"plan" | "iteration" | "pr" | "report", true> = {
  plan: true,
  iteration: true,
  pr: true,
  report: true,
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function nowRfc3339(): string {
  return new Date().toISOString();
}

/** Length-delimited tuple so field values cannot collide across the join. */
export function lengthDelimited(parts: readonly string[]): string {
  return parts.map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("\n");
}

export function computeIdentityKey(
  projectId: string,
  sourceIdentity: string,
  rootCauseKey: string,
  acceptanceKey: string,
): string {
  const normalized = sourceIdentity.normalize("NFC").trim();
  return sha256(lengthDelimited([projectId, normalized, rootCauseKey, acceptanceKey]));
}

function requireNonblank(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new IssueError("issue.scope-refused", `${label} must be nonblank`);
  }
  return trimmed;
}

function requireSemanticKey(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /^unknown$/i.test(trimmed) || trimmed === "?") {
    throw new IssueError(
      "issue.ambiguous-identity",
      `${label} is unknown or ambiguous; capture refuses a guessed dedup. Record a PM triage decision.`,
    );
  }
  return trimmed;
}


function parseEvidence(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return [];
    return parsed;
  } catch {
    return [];
  }
}

function requestHash(kind: string, payload: unknown): string {
  return sha256(`${kind}\n${JSON.stringify(payload)}`);
}

function readMeta(db: StoreDb): { authorityState: string; revision: number } {
  const row = db.prepare("select authority_state as authorityState, revision from store_meta where id = 1").get() as
    | { authorityState?: string; revision?: number }
    | undefined;
  if (!row || typeof row.authorityState !== "string" || typeof row.revision !== "number") {
    throw new IssueError("store.not-active", "store_meta is missing; the store cannot accept issue mutations");
  }
  return { authorityState: row.authorityState, revision: row.revision };
}

function assertActive(db: StoreDb): void {
  const meta = readMeta(db);
  if (meta.authorityState !== "active") {
    throw new IssueError(
      "store.not-active",
      `The issue store is ${meta.authorityState}; ordinary capture/query mutations require an active store.`,
    );
  }
}

function bumpStoreRevision(db: StoreDb): number {
  db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
  const row = db.prepare("select revision from store_meta where id = 1").get() as { revision: number };
  return row.revision;
}

function lookupOperation(db: StoreDb, operationId: string): { request_hash: string; result_json: string } | undefined {
  return db.prepare("select request_hash, result_json from store_operations where operation_id = ?").get(operationId) as
    | { request_hash: string; result_json: string }
    | undefined;
}

function replayOrConflict(existing: { request_hash: string; result_json: string }, hash: string): IssueReceipt {
  if (existing.request_hash !== hash) {
    throw new IssueError(
      "store.operation-conflict",
      "The same operationId was reused with a different request; the original receipt is retained.",
    );
  }
  return JSON.parse(existing.result_json) as IssueReceipt;
}

function recordOperation(db: StoreDb, operationId: string, hash: string, receipt: IssueReceipt, at: string): void {
  db.prepare("insert into store_operations(operation_id, request_hash, result_json, committed_at) values (?, ?, ?, ?)").run(
    operationId,
    hash,
    JSON.stringify(receipt),
    at,
  );
}

type OccurrenceColumns = {
  sourceIdentity: string;
  rootCauseKey: string;
  acceptanceKey: string;
  occurrenceKey: string;
  sourceKind: string;
  location: string;
  observedBehavior: string;
  evidenceJson: string;
  discoveredAt: string | null;
};

function occurrenceColumns(input: OccurrenceInput): OccurrenceColumns {
  return {
    sourceIdentity: requireNonblank("sourceIdentity", input.sourceIdentity),
    rootCauseKey: requireSemanticKey("rootCauseKey", input.rootCauseKey),
    acceptanceKey: requireSemanticKey("acceptanceKey", input.acceptanceKey),
    occurrenceKey: requireNonblank("occurrenceKey", input.occurrenceKey),
    sourceKind: requireNonblank("sourceKind", input.sourceKind),
    location: requireNonblank("location", input.location),
    observedBehavior: requireNonblank("observedBehavior", input.observedBehavior),
    evidenceJson: JSON.stringify(input.evidence ?? []),
    discoveredAt: input.discoveredAt.trim() ? input.discoveredAt.trim() : null,
  };
}

type IssueRow = {
  id: string;
  identity_key: string;
  revision: number;
  disposition: string;
};

function findByIdentity(db: StoreDb, identityKey: string): IssueRow | undefined {
  return db
    .prepare("select id, identity_key, revision, disposition from issues where identity_key = ?")
    .get(identityKey) as IssueRow | undefined;
}

type StoredOccurrence = {
  id: number;
  issue_id: string;
  source_identity: string;
  root_cause_key: string;
  acceptance_key: string;
  source_kind: string;
  location: string;
  observed_behavior: string;
  evidence_json: string;
  discovered_at: string | null;
};

function findOccurrence(db: StoreDb, occurrenceKey: string): StoredOccurrence | undefined {
  return db
    .prepare(
      "select id, issue_id, source_identity, root_cause_key, acceptance_key, source_kind, location, observed_behavior, evidence_json, discovered_at from occurrences where occurrence_key = ?",
    )
    .get(occurrenceKey) as StoredOccurrence | undefined;
}

function occurrenceMatches(stored: StoredOccurrence, cols: OccurrenceColumns): boolean {
  return (
    stored.source_identity === cols.sourceIdentity &&
    stored.root_cause_key === cols.rootCauseKey &&
    stored.acceptance_key === cols.acceptanceKey &&
    stored.source_kind === cols.sourceKind &&
    stored.location === cols.location &&
    stored.observed_behavior === cols.observedBehavior &&
    stored.evidence_json === cols.evidenceJson &&
    stored.discovered_at === cols.discoveredAt
  );
}

function insertOccurrence(
  db: StoreDb,
  issueId: string,
  cols: OccurrenceColumns,
  recordedAt: string,
): number {
  db.prepare(
    "insert into occurrences(issue_id, occurrence_key, source_kind, source_identity, root_cause_key, acceptance_key, location, observed_behavior, evidence_json, discovered_at, recorded_at, imported) " +
      "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
  ).run(
    issueId,
    cols.occurrenceKey,
    cols.sourceKind,
    cols.sourceIdentity,
    cols.rootCauseKey,
    cols.acceptanceKey,
    cols.location,
    cols.observedBehavior,
    cols.evidenceJson,
    cols.discoveredAt,
    recordedAt,
  );
  const row = db.prepare("select id from occurrences where occurrence_key = ?").get(cols.occurrenceKey) as { id: number };
  return row.id;
}

function insertCaptureProvenance(db: StoreDb, issueId: string, cols: OccurrenceColumns): void {
  db.prepare(
    "insert into provenance(issue_id, kind, target, source_hash) values (?, ?, ?, ?)",
  ).run(issueId, "capture", cols.sourceIdentity, sha256(cols.occurrenceKey));
}

async function withWrite<T>(context: StoreContext, fn: (handle: StoreHandle) => T): Promise<T> {
  const handle = await openStore(context, "write");
  try {
    assertActive(handle.db);
    handle.db.exec("begin immediate");
    try {
      const result = fn(handle);
      handle.db.exec("commit");
      return result;
    } catch (error) {
      try {
        handle.db.exec("rollback");
      } catch {
        // nothing committed
      }
      throw error;
    }
  } finally {
    handle.close();
  }
}

export async function captureIssue(
  context: StoreContext,
  input: CaptureInput,
  mutation: MutationContext,
): Promise<IssueReceipt> {
  requireCaptureSeat(mutation.actor);
  if (!Object.hasOwn(KINDS, input.kind) || !Object.hasOwn(SEVERITIES, input.severity)) {
    throw new IssueError("issue.scope-refused", "kind or severity is not a contract vocabulary value");
  }
  const title = requireNonblank("title", input.title);
  const impact = requireNonblank("impact", input.impact);
  const acceptance = requireNonblank("acceptance", input.acceptance);
  const projectId = requireNonblank("projectId", input.projectId);
  const cols = occurrenceColumns(input);
  const identityKey = computeIdentityKey(projectId, cols.sourceIdentity, cols.rootCauseKey, cols.acceptanceKey);
  const hash = requestHash("captureIssue", { input, mutation: { operationId: mutation.operationId, actor: mutation.actor } });

  return withWrite(context, (handle) => {
    const db = handle.db;
    const existingOp = lookupOperation(db, mutation.operationId);
    if (existingOp) return replayOrConflict(existingOp, hash);

    const existingOcc = findOccurrence(db, cols.occurrenceKey);
    if (existingOcc) {
      const issue = db.prepare("select id, revision, identity_key from issues where id = ?").get(existingOcc.issue_id) as {
        id: string;
        revision: number;
        identity_key: string;
      };
      if (issue.identity_key !== identityKey) {
        throw new IssueError(
          "issue.ambiguous-identity",
          "occurrence_key already belongs to a different identity; refusing a guessed merge",
        );
      }
      if (!occurrenceMatches(existingOcc, cols)) {
        throw new IssueError(
          "issue.occurrence-conflict",
          "occurrence_key was reused with a different observation; the original occurrence is retained.",
        );
      }
      const receipt: IssueReceipt = {
        issueId: issue.id,
        occurrenceId: existingOcc.id,
        revision: issue.revision,
        storeRevision: readMeta(db).revision,
        created: false,
      };
      recordOperation(db, mutation.operationId, hash, receipt, nowRfc3339());
      return receipt;
    }

    const existing = findByIdentity(db, identityKey);
    const at = nowRfc3339();
    if (existing) {
      const occurrenceId = insertOccurrence(db, existing.id, cols, at);
      const revision = existing.revision + 1;
      db.prepare("update issues set revision = ?, updated_at = ? where id = ?").run(revision, at, existing.id);
      const storeRevision = bumpStoreRevision(db);
      const receipt: IssueReceipt = {
        issueId: existing.id,
        occurrenceId,
        revision,
        storeRevision,
        created: false,
      };
      recordOperation(db, mutation.operationId, hash, receipt, at);
      return receipt;
    }

    const counter = db.prepare("select next_value as nextValue from issue_counter where id = 1").get() as {
      nextValue: number;
    };
    const issueId = `I-${String(counter.nextValue).padStart(6, "0")}`;
    db.prepare("update issue_counter set next_value = next_value + 1 where id = 1").run();
    db.prepare(
      "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, owner, registered_at, created_at, updated_at, revision, provider, identity_key) " +
        "values (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, 1, 'local', ?)",
    ).run(
      issueId,
      projectId,
      title,
      input.kind,
      input.severity,
      impact,
      acceptance,
      input.owner ?? null,
      at,
      at,
      at,
      identityKey,
    );
    const occurrenceId = insertOccurrence(db, issueId, cols, at);
    insertCaptureProvenance(db, issueId, cols);
    const storeRevision = bumpStoreRevision(db);
    const receipt: IssueReceipt = {
      issueId,
      occurrenceId,
      revision: 1,
      storeRevision,
      created: true,
    };
    recordOperation(db, mutation.operationId, hash, receipt, at);
    return receipt;
  });
}

export async function appendOccurrence(
  context: StoreContext,
  issueId: string,
  input: OccurrenceInput,
  mutation: MutationContext,
): Promise<IssueReceipt> {
  requireCaptureSeat(mutation.actor);
  const cols = occurrenceColumns(input);
  const hash = requestHash("appendOccurrence", {
    issueId,
    input,
    mutation: { operationId: mutation.operationId, actor: mutation.actor },
  });

  return withWrite(context, (handle) => {
    const db = handle.db;
    const existingOp = lookupOperation(db, mutation.operationId);
    if (existingOp) return replayOrConflict(existingOp, hash);

    const issue = db.prepare("select id, revision, disposition, project_id, identity_key from issues where id = ?").get(issueId) as
      | { id: string; revision: number; disposition: string; project_id: string; identity_key: string }
      | undefined;
    if (!issue) {
      throw new IssueError("issue.not-found", `Issue ${issueId} does not exist`);
    }
    // A recurrence is another observation of the SAME identity (contract §3):
    // a distinct source/root-cause/acceptance pair belongs to its own issue.
    if (computeIdentityKey(issue.project_id, cols.sourceIdentity, cols.rootCauseKey, cols.acceptanceKey) !== issue.identity_key) {
      throw new IssueError(
        "issue.ambiguous-identity",
        "The occurrence's source/root-cause/acceptance identity does not match this issue; refusing a guessed merge",
      );
    }

    const existingOcc = findOccurrence(db, cols.occurrenceKey);
    if (existingOcc) {
      if (existingOcc.issue_id !== issueId) {
        throw new IssueError(
          "issue.ambiguous-identity",
          "occurrence_key already belongs to a different issue; refusing a guessed merge",
        );
      }
      if (!occurrenceMatches(existingOcc, cols)) {
        throw new IssueError(
          "issue.occurrence-conflict",
          "occurrence_key was reused with a different observation; the original occurrence is retained.",
        );
      }
      const receipt: IssueReceipt = {
        issueId,
        occurrenceId: existingOcc.id,
        revision: issue.revision,
        storeRevision: readMeta(db).revision,
        created: false,
      };
      recordOperation(db, mutation.operationId, hash, receipt, nowRfc3339());
      return receipt;
    }

    const at = nowRfc3339();
    const occurrenceId = insertOccurrence(db, issueId, cols, at);
    const revision = issue.revision + 1;
    db.prepare("update issues set revision = ?, updated_at = ? where id = ?").run(revision, at, issueId);
    const storeRevision = bumpStoreRevision(db);
    const receipt: IssueReceipt = {
      issueId,
      occurrenceId,
      revision,
      storeRevision,
      created: false,
    };
    recordOperation(db, mutation.operationId, hash, receipt, at);
    return receipt;
  });
}

const LAST_ACTIVITY_SQL = `(select max(ts) from (
  select issues.registered_at as ts
  union all select o.discovered_at from occurrences o where o.issue_id = issues.id
  union all select t.occurred_at from issue_transitions t where t.issue_id = issues.id
))`;

function bindFilter(filter: IssueFilter): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.projectId) {
    clauses.push("issues.project_id = ?");
    params.push(filter.projectId);
  }
  const disposition = filter.disposition ?? "open";
  if (!Object.hasOwn(DISPOSITIONS, disposition)) {
    throw new IssueError("issue.scope-refused", "disposition is not a contract vocabulary value");
  }
  clauses.push("issues.disposition = ?");
  params.push(disposition);
  if (filter.kind) {
    if (!Object.hasOwn(KINDS, filter.kind)) throw new IssueError("issue.scope-refused", "kind is not a contract vocabulary value");
    clauses.push("issues.kind = ?");
    params.push(filter.kind);
  }
  if (filter.severity) {
    if (!Object.hasOwn(SEVERITIES, filter.severity)) {
      throw new IssueError("issue.scope-refused", "severity is not a contract vocabulary value");
    }
    clauses.push("issues.severity = ?");
    params.push(filter.severity);
  }
  if (filter.query !== undefined && filter.query !== "") {
    // Literal substring: bound parameter, never a LIKE/GLOB pattern.
    clauses.push(
      "(instr(lower(issues.title), lower(?)) > 0 or exists (select 1 from occurrences o where o.issue_id = issues.id and instr(lower(o.observed_behavior || char(10) || o.evidence_json || char(10) || o.location), lower(?)) > 0))",
    );
    params.push(filter.query, filter.query);
  }
  return { where: clauses.length ? `where ${clauses.join(" and ")}` : "", params };
}

export async function listIssues(context: StoreContext, filter: IssueFilter): Promise<IssuePage> {
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) {
    throw new IssueError("issue.scope-refused", "limit must be 1..200 and offset must be nonnegative");
  }
  const { where, params } = bindFilter(filter);
  const handle = await openStore(context, "read");
  try {
    const db = handle.db;
    // FW-6: a staged import is not read authority (apply≠activate) — the read
    // verbs refuse `store.not-active` exactly like the mutations; staged data
    // is inspectable through the migration surface (manifest/receipt), never
    // as queryable issues.
    assertActive(db);
    const storeRevision = readMeta(db).revision;
    const totalRow = db.prepare(`select count(*) as n from issues ${where}`).get(...params) as { n: number };
    const order = `order by case issues.severity
        when 'critical' then 5 when 'high' then 4 when 'medium' then 3 when 'low' then 2 when 'info' then 1 else 0 end desc,
      case when (${LAST_ACTIVITY_SQL}) is null then 1 else 0 end asc,
      (${LAST_ACTIVITY_SQL}) desc,
      issues.id asc`;
    const rows = db
      .prepare(
        `select issues.id, issues.project_id as projectId, issues.title, issues.kind, issues.severity, issues.disposition,
                issues.registered_at as registeredAt, issues.revision,
                (${LAST_ACTIVITY_SQL}) as lastActivity
         from issues ${where} ${order} limit ? offset ?`,
      )
      .all(...params, limit, offset) as Array<{
      id: string;
      projectId: string;
      title: string;
      kind: IssueKind;
      severity: Severity;
      disposition: Disposition;
      registeredAt: string | null;
      revision: number;
      lastActivity: string | null;
    }>;
    return {
      items: rows.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        title: row.title,
        kind: row.kind,
        severity: row.severity,
        disposition: row.disposition,
        registeredAt: row.registeredAt,
        lastActivity: row.lastActivity,
        revision: row.revision,
      })),
      total: totalRow.n,
      storeRevision,
    };
  } finally {
    handle.close();
  }
}

export async function getIssue(context: StoreContext, id: string): Promise<IssueDetail> {
  const handle = await openStore(context, "read");
  try {
    const db = handle.db;
    // FW-6: same stage gate as listIssues — a staged store is refused, never
    // served as read authority.
    assertActive(db);
    const issue = db
      .prepare(
        "select id, project_id, title, kind, severity, disposition, impact, acceptance, owner, registered_at, closed_at, closure_note, created_at, updated_at, revision, provider, external_id, url, identity_key from issues where id = ?",
      )
      .get(id) as
      | {
          id: string;
          project_id: string;
          title: string;
          kind: IssueKind;
          severity: Severity;
          disposition: Disposition;
          impact: string;
          acceptance: string;
          owner: string | null;
          registered_at: string | null;
          closed_at: string | null;
          closure_note: string | null;
          created_at: string;
          updated_at: string;
          revision: number;
          provider: string;
          external_id: string | null;
          url: string | null;
          identity_key: string;
        }
      | undefined;
    if (!issue) throw new IssueError("issue.not-found", `Issue ${id} does not exist`);

    const occurrences = (
      db
        .prepare(
          "select id, occurrence_key, source_kind, source_identity, root_cause_key, acceptance_key, location, observed_behavior, evidence_json, discovered_at, recorded_at, imported from occurrences where issue_id = ? order by id asc",
        )
        .all(id) as Array<{
        id: number;
        occurrence_key: string;
        source_kind: string;
        source_identity: string;
        root_cause_key: string;
        acceptance_key: string;
        location: string;
        observed_behavior: string;
        evidence_json: string;
        discovered_at: string | null;
        recorded_at: string;
        imported: number;
      }>
    ).map((row) => ({
      id: row.id,
      occurrenceKey: row.occurrence_key,
      sourceKind: row.source_kind,
      sourceIdentity: row.source_identity,
      rootCauseKey: row.root_cause_key,
      acceptanceKey: row.acceptance_key,
      location: row.location,
      observedBehavior: row.observed_behavior,
      evidence: parseEvidence(row.evidence_json),
      discoveredAt: row.discovered_at,
      recordedAt: row.recorded_at,
      imported: row.imported === 1,
    }));

    const transitions = (
      db
        .prepare(
          "select id, from_disposition, to_disposition, actor, occurred_at, recorded_at, reason, evidence_json, imported, issue_revision from issue_transitions where issue_id = ? order by id asc",
        )
        .all(id) as Array<{
        id: number;
        from_disposition: string;
        to_disposition: string;
        actor: string | null;
        occurred_at: string | null;
        recorded_at: string;
        reason: string;
        evidence_json: string;
        imported: number;
        issue_revision: number;
      }>
    ).map((row) => ({
      id: row.id,
      fromDisposition: row.from_disposition,
      toDisposition: row.to_disposition,
      actor: row.actor,
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      reason: row.reason,
      evidence: JSON.parse(row.evidence_json) as unknown,
      imported: row.imported === 1,
      issueRevision: row.issue_revision,
    }));

    const relations = db
      .prepare(
        "select from_issue as fromIssue, relation, to_issue as toIssue from relations where from_issue = ? or to_issue = ?",
      )
      .all(id, id) as IssueRelation[];

    const provenance = (
      db
        .prepare(
          "select id, kind, target, source_hash, legacy_project, legacy_bucket, legacy_entry_id, legacy_json, imported_at from provenance where issue_id = ? order by id asc",
        )
        .all(id) as Array<{
        id: number;
        kind: string;
        target: string;
        source_hash: string;
        legacy_project: string | null;
        legacy_bucket: string | null;
        legacy_entry_id: string | null;
        legacy_json: string | null;
        imported_at: string | null;
      }>
    ).map((row) => ({
      id: row.id,
      kind: row.kind,
      target: row.target,
      sourceHash: row.source_hash,
      legacyProject: row.legacy_project,
      legacyBucket: row.legacy_bucket,
      legacyEntryId: row.legacy_entry_id,
      legacyJson: row.legacy_json,
      importedAt: row.imported_at,
    }));

    return {
      id: issue.id,
      projectId: issue.project_id,
      title: issue.title,
      kind: issue.kind,
      severity: issue.severity,
      disposition: issue.disposition,
      impact: issue.impact,
      acceptance: issue.acceptance,
      owner: issue.owner,
      registeredAt: issue.registered_at,
      closedAt: issue.closed_at,
      closureNote: issue.closure_note,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      revision: issue.revision,
      provider: issue.provider,
      externalId: issue.external_id,
      url: issue.url,
      identityKey: issue.identity_key,
      occurrences,
      transitions,
      relations,
      provenance,
    };
  } finally {
    handle.close();
  }
}

const TERMINAL: Record<TerminalDisposition, true> = {
  resolved: true,
  waived: true,
  duplicate: true,
  superseded: true,
};

/**
 * Seats an existing session envelope authorizes (contract §4: existing harness
 * authorization semantics, not a new local auth service). Both roles
 * `readSessionEnvelope` accepts are PM seats — `plan-pm` binds one plan,
 * `coordinator` binds the lifecycle — so a validated envelope proves the
 * `project-manager` seat. The requested actor stays an audit label: it must
 * match the seat the envelope proves and is never the authority.
 */
const ENVELOPE_SEATS: Record<CoordinationSession["role"], string> = {
  "plan-pm": "project-manager",
  coordinator: "project-manager",
};

/**
 * The seat that owns a confirmed outcome and may write it (contract §6): the
 * PM seat orchestrates dispatch/consolidation, QC tri, iteration close and a
 * PR-review round's Stage 3 synthesis. Leaf implementation/audit/QC/QA seats
 * return evidence and never write the store, and unscoped capture needs no plan.
 */
const CAPTURE_SEAT = "project-manager";

function requireCaptureSeat(actor: string): void {
  const seat = requireNonblank("actor", actor);
  if (seat !== CAPTURE_SEAT) {
    throw new IssueError(
      "issue.scope-refused",
      `Actor "${actor}" does not hold the ${CAPTURE_SEAT} seat. Capture is restricted to the seat that owns the ` +
        `confirmed outcome; leaf seats return evidence and never write the store.`,
    );
  }
}

/**
 * Bind the envelope that authorizes a privileged mutation to the engine's own
 * record (contract §4: existing harness authorization semantics, not a new
 * local auth service), then derive the seat from it.
 *
 * A JSON document that merely *parses* as an envelope is never a credential,
 * so the caller cannot choose the authority file. The envelope must be the one
 * the engine itself issues (`bindPlanSession`):
 *
 *  1. at the path the workflow's own record binds — `assertEngineIssuedSession`
 *     compares the presented file with the snapshot's recorded
 *     `coordination.session.session_file` / `coordination.coordinator.session_file`
 *     exactly (the same recorded-path rule the coordination writers enforce), and
 *     accepts that bound path in either engine-issued shape: the canonical
 *     `sessions/<role>-<session_id>.json` a current bind writes, or the pre-#264
 *     bare `sessions/<session_id>.json` that released 3.11.0 workflows record
 *     (both roles — 3.11.0 had no role prefix). A copy at any other path refuses
 *     even when byte-identical and fully bound;
 *  2. under the harness root that owns this store — an envelope issued for
 *     another control root refuses;
 *  3. for a **live** workflow — the workflow's snapshot must exist, validate,
 *     and not be terminal (`completed|failed|stopped`);
 *  4. and that workflow's own coordination record must point back at exactly
 *     this file and session id — the snapshot's `coordination.coordinator` for
 *     a `coordinator` envelope, the named plan row's `coordination.session` for
 *     a `plan-pm` envelope.
 *
 * Point 4 is the binding `assertCoordinatedSnapshotWriter` (`workflow.ts`)
 * already enforces against a snapshot's recorded session file, and the one the
 * scoped writers enforce through `assertCoordinatorBinding` /
 * `assertRowBinding` (`coordination.ts`); the store applies the same rule to
 * its own privileged verbs instead of inventing a signature scheme. It raises
 * the authority artifact from "a file the caller picked" to "the engine's
 * record for a live workflow": forging authority now requires rewriting the
 * workflow's validated, engine-owned coordination record, not just dropping a
 * plausible JSON file somewhere — the level of trust contract §4 accepts
 * ("do not claim security against a user who directly controls the DB file").
 */
function authorizeMutation(context: StoreContext, mutation: MutationContext): CoordinationSession {
  const { session, sessionPath } = readScopedSession(mutation.sessionFile);
  assertEngineIssuedSession(context.harnessDir, sessionPath, session);
  const seat = ENVELOPE_SEATS[session.role];
  if (mutation.actor.trim() !== seat) {
    throw new IssueError(
      "issue.scope-refused",
      `Actor "${mutation.actor}" is not the "${seat}" seat the session envelope authorizes; a privileged ` +
        `mutation is authorized by the envelope, not by the actor label.`,
    );
  }
  return session;
}

/**
 * The workflow directory of this session, and the envelope path shape(s) an
 * engine bind ever issued for it — the canonical `{WORKFLOW_DIR}/<id>/
 * sessions/<role>-<session-id>.json` a current bind writes, and the pre-#264
 * bare name `sessions/<session-id>.json`.
 *
 * Upgrade tolerance (path SHAPE of the recorded binding only): the released
 * 3.11.0 engine issued EVERY role's envelope at the bare name (v3.11.0
 * `sessionFilePath` had no role parameter), and the workflows it created
 * recorded exactly that binding, so an upgraded binary must still accept the
 * shape for both roles or refuse a valid legacy session. Acceptance itself is
 * tied to the workflow's recorded `session_file` (see
 * `assertEngineIssuedSession`) — every content binding (workflow, plan row or
 * coordinator record, session id, live lifecycle) is checked unchanged.
 */
function issuedSessionLocation(session: CoordinationSession): { dir: string; path: string; legacyPath: string } {
  const dir = join(resolveWorkflowDir(session.harness_root, { harnessDir: session.harness_root }), session.workflow_id);
  return {
    dir,
    path: sessionFilePath(session.harness_root, session.workflow_id, session.role, session.session_id),
    legacyPath: join(dir, "sessions", `${session.session_id}.json`),
  };
}

/** True when `sessionPath` is a path shape an engine bind ever issued for
 * this session: the current canonical name, or the pre-#264 bare name. */
function isIssuedSessionPath(sessionPath: string, issued: { path: string; legacyPath: string }): boolean {
  return (
    canonicalizeNearestExisting(sessionPath) === canonicalizeNearestExisting(issued.path) ||
    canonicalizeNearestExisting(sessionPath) === canonicalizeNearestExisting(issued.legacyPath)
  );
}

/** A §4 authority refusal — the store's existing code, never a new one. */
function refuseAuthority(message: string): IssueError {
  return new IssueError(
    "issue.scope-refused",
    `${message}. A privileged mutation is authorized only by the engine-issued session envelope of a live ` +
      `workflow (contract \u00a74); a file that merely parses as an envelope is not a credential.`,
  );
}

/** The live workflow's snapshot, or a refusal (a terminal workflow authorizes nothing). */
function liveSnapshotOf(
  session: CoordinationSession,
  sessionPath: string,
  workflowDir: string,
): WorkflowSnapshot {
  let snapshot: WorkflowSnapshot;
  try {
    snapshot = readWorkflowSnapshot(workflowDir).snapshot;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw refuseAuthority(
      `Session envelope ${sessionPath} names workflow ${session.workflow_id}, whose snapshot is not readable (${message})`,
    );
  }
  if (snapshot.id !== session.workflow_id) {
    throw refuseAuthority(
      `Workflow snapshot ${join(workflowDir, WORKFLOW_SNAPSHOT_FILE)} records id ${JSON.stringify(snapshot.id)}, not the envelope's workflow_id ${JSON.stringify(session.workflow_id)}`,
    );
  }
  if (isTerminalSnapshot(snapshot)) {
    throw refuseAuthority(`Workflow ${snapshot.id} is ${snapshot.status} \u2014 a finished lifecycle holds no live authority`);
  }
  return snapshot;
}

/** The session binding of the one plan row `plan_id` addresses (or a refusal). */
function planSessionBinding(snapshot: WorkflowSnapshot, session: CoordinationSession): CoordinatorBinding | undefined {
  const planId = session.plan_id ?? "";
  const rows = snapshot.plans.filter((row) => rowPlanIds(row).includes(planId));
  if (rows.length !== 1) {
    throw refuseAuthority(
      `Session envelope names plan ${JSON.stringify(planId)}, which is ${rows.length === 0 ? "no row" : `${rows.length} rows`} of workflow ${snapshot.id}`,
    );
  }
  // Boundary cast: `readWorkflowSnapshot` validated every row coordination
  // block (`validateRowCoordination`), so a present `session` is a binding.
  const coordination = rows[0]?.coordination as RowCoordination | undefined;
  return coordination?.session;
}

/** Every §4 condition above, or a refusal. */
function assertEngineIssuedSession(harnessDir: string, sessionPath: string, session: CoordinationSession): void {
  if (canonicalizeNearestExisting(session.harness_root) !== canonicalizeNearestExisting(harnessDir)) {
    throw refuseAuthority(
      `Session envelope ${sessionPath} was issued for harness root ${session.harness_root}, not for the root that owns this store (${harnessDir})`,
    );
  }
  const issued = issuedSessionLocation(session);
  const snapshot = liveSnapshotOf(session, sessionPath, issued.dir);
  const binding = session.role === "coordinator" ? snapshot.coordination?.coordinator : planSessionBinding(snapshot, session);
  if (binding === undefined) {
    throw refuseAuthority(
      session.role === "coordinator"
        ? `Workflow ${snapshot.id} records no coordinator binding for ${issued.path}`
        : `Plan ${JSON.stringify(session.plan_id)} of workflow ${snapshot.id} records no session binding for ${issued.path}`,
    );
  }
  if (binding.session_id !== session.session_id) {
    throw refuseAuthority(
      `Workflow ${snapshot.id} records session ${binding.session_id}, not the envelope's session ${session.session_id}`,
    );
  }
  // The recorded bound path itself must be a shape an engine bind ever
  // issued (canonical, or the pre-#264 bare name that released 3.11.0
  // workflows record). A record at any other path is not an engine record.
  if (!isIssuedSessionPath(binding.session_file, issued)) {
    throw refuseAuthority(
      `Workflow ${snapshot.id} records session ${binding.session_id} at ${binding.session_file}, which is not an engine-issued ` +
        `path for this session (${issued.path} or the pre-#264 bound form ${issued.legacyPath})`,
    );
  }
  // Tie: the presented file must be exactly the workflow's bound session
  // file (the recorded-path rule the coordination writers already enforce).
  // A byte-identical copy at any other path — canonical-named or
  // legacy-named — is not a credential.
  if (canonicalizeNearestExisting(sessionPath) !== canonicalizeNearestExisting(binding.session_file)) {
    throw refuseAuthority(
      `Session envelope ${sessionPath} is not the workflow's bound session file ${binding.session_file} \u2014 issue authorization follows the recorded path exactly`,
    );
  }
}

/**
 * Plan/iteration provenance uses the existing coordination session envelope.
 * Credentials are never written into SQLite.
 */
function readScopedSession(sessionFile: string | undefined): { session: CoordinationSession; sessionPath: string } {
  if (!sessionFile) {
    throw new IssueError(
      "issue.scope-refused",
      "This mutation requires an existing scoped session envelope; no session credential is written to the store.",
    );
  }
  try {
    return { session: readSessionEnvelope(sessionFile), sessionPath: sessionFile };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new IssueError("issue.scope-refused", message);
  }
}

/** Identity for new plan/iteration links is the validated envelope's plan_id / workflow_id (no catalog table in this plan). */
function assertPlanIterationIdentity(
  kind: "plan" | "iteration",
  target: string,
  session: CoordinationSession,
): void {
  if (kind === "plan") {
    if (session.role !== "plan-pm" || session.plan_id !== target) {
      throw new IssueError(
        "issue.scope-refused",
        "New plan provenance must match the plan-pm session envelope plan_id; arbitrary targets are refused until catalog identity exists.",
      );
    }
    return;
  }
  if (session.workflow_id !== target) {
    throw new IssueError(
      "issue.scope-refused",
      "New iteration provenance must match the session envelope workflow_id; arbitrary targets are refused until catalog identity exists.",
    );
  }
}

function requireExpectedRevision(mutation: MutationContext, current: number): void {
  if (mutation.expectedRevision === undefined) {
    throw new IssueError("issue.revision-conflict", "expectedRevision is mandatory for triage, disposition and relation changes");
  }
  if (mutation.expectedRevision !== current) {
    throw new IssueError(
      "issue.revision-conflict",
      `expectedRevision ${mutation.expectedRevision} does not match issue revision ${current}; nothing was changed.`,
    );
  }
}

/**
 * Disposition-specific evidence requirements (contract §4/§6).
 *
 * Who may close is decided by `authorizeMutation` before this runs: the
 * envelope proves the seat, and an actor string is never authority. That is
 * §4's whole execution route, because §6 makes the leaf QA seat an **evidence
 * authority**, not a second execution credential — "leaf audit/QC/QA seats
 * return evidence and never write the store". So when the QA gate is the
 * authority for a `resolved` closure, the QA seat's acceptance arrives as this
 * closure's evidence and the envelope-proven seat performs the write; the
 * store therefore declares no unreachable `qa-engineer` credential path.
 *
 * `resolved` requires both halves of that evidence: the verification
 * `references` (what was accepted) and the acceptance authority in
 * `alignmentRef` (who accepted it — the QA gate's acceptance or the PM
 * acceptance record). Recording the authority is what keeps a QA-gate-backed
 * closure distinguishable in the append-only history from one resting on no
 * acceptance evidence at all; without it, a `resolved` closure would record
 * nothing about which §4 authority it was made under.
 */
function assertClosureAuthority(disposition: TerminalDisposition, evidence: ClosureEvidence): void {
  requireNonblank("reason", evidence.reason);
  if (disposition === "resolved") {
    if (!evidence.references || evidence.references.length === 0) {
      throw new IssueError("issue.invalid-disposition", "resolved requires acceptance evidence in references");
    }
    if (!evidence.alignmentRef?.trim()) {
      throw new IssueError(
        "issue.invalid-disposition",
        "resolved requires the acceptance authority in alignmentRef \u2014 the QA gate's acceptance (contract \u00A74 " +
          "`qa-engineer`, supplied as evidence per \u00a76) or the PM acceptance record the references were verified under",
      );
    }
    return;
  }
  if (disposition === "waived") {
    if (!evidence.scope?.trim() || !evidence.alignmentRef?.trim()) {
      throw new IssueError(
        "issue.invalid-disposition",
        "waived requires rationale, named scope, and a recorded user/architect alignmentRef",
      );
    }
    return;
  }
  if (!evidence.canonicalIssueId?.trim()) {
    throw new IssueError("issue.invalid-disposition", `${disposition} requires an existing canonical/replacement issue`);
  }
}

function linkedPlanTargets(db: StoreDb, issueId: string): string[] {
  const rows = db
    .prepare("select distinct target from provenance where issue_id = ? and kind = 'plan' order by target")
    .all(issueId) as Array<{ target: string }>;
  return rows.map((row) => row.target);
}

function assertMultiPlanAcceptance(db: StoreDb, issueId: string, evidence: ClosureEvidence): void {
  const plans = linkedPlanTargets(db, issueId);
  if (plans.length < 2) return;
  const refs: Record<string, true> = {};
  for (const ref of evidence.references ?? []) refs[ref] = true;
  const coversAll = evidence.scope === "all" || plans.every((plan) => refs[plan]);
  if (!coversAll) {
    throw new IssueError(
      "issue.invalid-disposition",
      "A multi-plan obligation stays open until its whole acceptance is verified; one linked plan is not enough.",
    );
  }
}

export async function triageIssue(
  context: StoreContext,
  issueId: string,
  patch: IssueTriage,
  mutation: MutationContext,
): Promise<IssueReceipt> {
  requireNonblank("reason", patch.reason);
  if (patch.kind !== undefined && !Object.hasOwn(KINDS, patch.kind)) {
    throw new IssueError("issue.scope-refused", "kind is not a contract vocabulary value");
  }
  if (patch.severity !== undefined && !Object.hasOwn(SEVERITIES, patch.severity)) {
    throw new IssueError("issue.scope-refused", "severity is not a contract vocabulary value");
  }
  authorizeMutation(context, mutation);
  const hash = requestHash("triageIssue", {
    issueId,
    patch,
    mutation: { operationId: mutation.operationId, actor: mutation.actor, expectedRevision: mutation.expectedRevision },
  });

  return withWrite(context, (handle) => {
    const db = handle.db;
    const existingOp = lookupOperation(db, mutation.operationId);
    if (existingOp) return replayOrConflict(existingOp, hash);

    const issue = db.prepare("select id, revision, kind, severity, impact, acceptance, owner from issues where id = ?").get(issueId) as
      | {
          id: string;
          revision: number;
          kind: IssueKind;
          severity: Severity;
          impact: string;
          acceptance: string;
          owner: string | null;
        }
      | undefined;
    if (!issue) throw new IssueError("issue.not-found", `Issue ${issueId} does not exist`);
    requireExpectedRevision(mutation, issue.revision);

    const at = nowRfc3339();
    db.prepare(
      "update issues set kind = ?, severity = ?, impact = ?, acceptance = ?, owner = ?, revision = ?, updated_at = ? where id = ?",
    ).run(
      patch.kind ?? issue.kind,
      patch.severity ?? issue.severity,
      patch.impact !== undefined ? requireNonblank("impact", patch.impact) : issue.impact,
      patch.acceptance !== undefined ? requireNonblank("acceptance", patch.acceptance) : issue.acceptance,
      patch.owner !== undefined ? patch.owner : issue.owner,
      issue.revision + 1,
      at,
      issueId,
    );
    const storeRevision = bumpStoreRevision(db);
    const receipt: IssueReceipt = {
      issueId,
      revision: issue.revision + 1,
      storeRevision,
      created: false,
    };
    recordOperation(db, mutation.operationId, hash, receipt, at);
    return receipt;
  });
}

export async function closeIssue(
  context: StoreContext,
  issueId: string,
  disposition: TerminalDisposition,
  evidence: ClosureEvidence,
  mutation: MutationContext,
): Promise<IssueReceipt> {
  if (!Object.hasOwn(TERMINAL, disposition)) {
    throw new IssueError("issue.invalid-disposition", "Terminal dispositions are exactly resolved|waived|duplicate|superseded");
  }
  authorizeMutation(context, mutation);
  assertClosureAuthority(disposition, evidence);
  const hash = requestHash("closeIssue", {
    issueId,
    disposition,
    evidence,
    mutation: { operationId: mutation.operationId, actor: mutation.actor, expectedRevision: mutation.expectedRevision },
  });

  return withWrite(context, (handle) => {
    const db = handle.db;
    const existingOp = lookupOperation(db, mutation.operationId);
    if (existingOp) return replayOrConflict(existingOp, hash);

    const issue = db.prepare("select id, revision, disposition from issues where id = ?").get(issueId) as
      | { id: string; revision: number; disposition: string }
      | undefined;
    if (!issue) throw new IssueError("issue.not-found", `Issue ${issueId} does not exist`);
    requireExpectedRevision(mutation, issue.revision);

    if (issue.disposition !== "open") {
      throw new IssueError(
        "issue.invalid-disposition",
        `Only open\u2192terminal is accepted; ${issue.disposition} cannot transition to ${disposition}`,
      );
    }

    if (disposition === "duplicate" || disposition === "superseded") {
      const canonical = evidence.canonicalIssueId!;
      const other = db.prepare("select id from issues where id = ?").get(canonical) as { id: string } | undefined;
      if (!other) {
        throw new IssueError("issue.not-found", `Canonical issue ${canonical} does not exist`);
      }
      if (canonical === issueId) {
        throw new IssueError("issue.invalid-disposition", "canonical issue cannot be the closing issue itself");
      }
    }

    if (disposition === "resolved") {
      assertMultiPlanAcceptance(db, issueId, evidence);
    }

    const at = nowRfc3339();
    const revision = issue.revision + 1;
    const evidenceJson = JSON.stringify({
      reason: evidence.reason,
      scope: evidence.scope ?? null,
      references: evidence.references,
      canonicalIssueId: evidence.canonicalIssueId ?? null,
      alignmentRef: evidence.alignmentRef ?? null,
    });
    db.prepare(
      "update issues set disposition = ?, closed_at = ?, closure_note = ?, revision = ?, updated_at = ? where id = ?",
    ).run(disposition, at, evidence.reason, revision, at, issueId);
    db.prepare(
      "insert into issue_transitions(issue_id, from_disposition, to_disposition, actor, occurred_at, recorded_at, reason, evidence_json, imported, issue_revision) values (?, 'open', ?, ?, ?, ?, ?, ?, 0, ?)",
    ).run(issueId, disposition, mutation.actor, at, at, evidence.reason, evidenceJson, revision);
    if (disposition === "duplicate") {
      db.prepare("insert or ignore into relations(from_issue, relation, to_issue) values (?, 'duplicate-of', ?)").run(
        issueId,
        evidence.canonicalIssueId,
      );
    }
    if (disposition === "superseded") {
      db.prepare("insert or ignore into relations(from_issue, relation, to_issue) values (?, 'superseded-by', ?)").run(
        issueId,
        evidence.canonicalIssueId,
      );
    }
    const storeRevision = bumpStoreRevision(db);
    const receipt: IssueReceipt = { issueId, revision, storeRevision, created: false };
    recordOperation(db, mutation.operationId, hash, receipt, at);
    return receipt;
  });
}

export async function linkIssue(
  context: StoreContext,
  issueId: string,
  link: IssueLink,
  mutation: MutationContext,
): Promise<IssueReceipt> {
  const session = authorizeMutation(context, mutation);
  if ("relation" in link) {
    if (!Object.hasOwn(RELATIONS, link.relation)) {
      throw new IssueError("issue.scope-refused", "relation is not a contract vocabulary value");
    }
  } else if (!Object.hasOwn(PROVENANCE_KINDS, link.kind)) {
    throw new IssueError("issue.scope-refused", "provenance kind is not a contract vocabulary value");
  }
  if ("kind" in link && (link.kind === "plan" || link.kind === "iteration")) {
    assertPlanIterationIdentity(link.kind, requireNonblank("target", link.target), session);
  }
  const hash = requestHash("linkIssue", {
    issueId,
    link,
    mutation: { operationId: mutation.operationId, actor: mutation.actor, expectedRevision: mutation.expectedRevision },
  });

  return withWrite(context, (handle) => {
    const db = handle.db;
    const existingOp = lookupOperation(db, mutation.operationId);
    if (existingOp) return replayOrConflict(existingOp, hash);

    const issue = db.prepare("select id, revision from issues where id = ?").get(issueId) as
      | { id: string; revision: number }
      | undefined;
    if (!issue) throw new IssueError("issue.not-found", `Issue ${issueId} does not exist`);
    requireExpectedRevision(mutation, issue.revision);

    const at = nowRfc3339();
    if ("relation" in link) {
      const other = requireNonblank("issueId", link.issueId);
      if (other === issueId) {
        throw new IssueError("issue.scope-refused", "Self-edges are not allowed");
      }
      const otherRow = db.prepare("select id from issues where id = ?").get(other) as { id: string } | undefined;
      if (!otherRow) throw new IssueError("issue.not-found", `Related issue ${other} does not exist`);
      let from = issueId;
      let to = other;
      if (link.relation === "related" && from > to) {
        const swap = from;
        from = to;
        to = swap;
      }
      const already = db
        .prepare("select 1 as ok from relations where from_issue = ? and relation = ? and to_issue = ?")
        .get(from, link.relation, to) as { ok: number } | undefined;
      if (already) {
        const receipt: IssueReceipt = {
          issueId,
          revision: issue.revision,
          storeRevision: readMeta(db).revision,
          created: false,
        };
        recordOperation(db, mutation.operationId, hash, receipt, at);
        return receipt;
      }
      db.prepare("insert into relations(from_issue, relation, to_issue) values (?, ?, ?)").run(from, link.relation, to);
    } else {
      const target = requireNonblank("target", link.target);
      const sourceHash = sha256(lengthDelimited([link.kind, target]));
      const already = db
        .prepare("select 1 as ok from provenance where issue_id = ? and kind = ? and target = ?")
        .get(issueId, link.kind, target) as { ok: number } | undefined;
      if (already) {
        const receipt: IssueReceipt = {
          issueId,
          revision: issue.revision,
          storeRevision: readMeta(db).revision,
          created: false,
        };
        recordOperation(db, mutation.operationId, hash, receipt, at);
        return receipt;
      }
      db.prepare("insert into provenance(issue_id, kind, target, source_hash) values (?, ?, ?, ?)").run(
        issueId,
        link.kind,
        target,
        sourceHash,
      );
    }

    const revision = issue.revision + 1;
    db.prepare("update issues set revision = ?, updated_at = ? where id = ?").run(revision, at, issueId);
    const storeRevision = bumpStoreRevision(db);
    const receipt: IssueReceipt = { issueId, revision, storeRevision, created: false };
    recordOperation(db, mutation.operationId, hash, receipt, at);
    return receipt;
  });
}
