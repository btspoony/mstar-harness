/**
 * issue.ts — capture identity, occurrences and public reads (plan C2).
 *
 * In-process domain verbs on the C1 store boundary. Dedup is source /
 * root-cause / acceptance (`identity_key`), never title. Observation
 * identity lives in `occurrence_key`. Unknown semantic identity refuses
 * `issue.ambiguous-identity` instead of guessing a merge.
 */
import { createHash } from "node:crypto";
import { openStore, type StoreContext, type StoreDb, type StoreHandle } from "./store-db.js";

export type IssueKind = "bug" | "risk" | "improvement" | "request" | "decision" | "review-obligation";
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Disposition = "open" | "resolved" | "waived" | "duplicate" | "superseded";

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

export type IssueErrorCode =
  | "issue.not-found"
  | "issue.ambiguous-identity"
  | "issue.scope-refused"
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

function findOccurrence(db: StoreDb, occurrenceKey: string): { id: number; issue_id: string } | undefined {
  return db.prepare("select id, issue_id from occurrences where occurrence_key = ?").get(occurrenceKey) as
    | { id: number; issue_id: string }
    | undefined;
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
  if (!KINDS[input.kind] || !SEVERITIES[input.severity]) {
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
      const issue = db.prepare("select id, revision from issues where id = ?").get(existingOcc.issue_id) as {
        id: string;
        revision: number;
      };
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

    const issue = db.prepare("select id, revision, disposition from issues where id = ?").get(issueId) as
      | { id: string; revision: number; disposition: string }
      | undefined;
    if (!issue) {
      throw new IssueError("issue.not-found", `Issue ${issueId} does not exist`);
    }

    const existingOcc = findOccurrence(db, cols.occurrenceKey);
    if (existingOcc) {
      if (existingOcc.issue_id !== issueId) {
        throw new IssueError(
          "issue.ambiguous-identity",
          "occurrence_key already belongs to a different issue; refusing a guessed merge",
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
  if (!DISPOSITIONS[disposition]) {
    throw new IssueError("issue.scope-refused", "disposition is not a contract vocabulary value");
  }
  clauses.push("issues.disposition = ?");
  params.push(disposition);
  if (filter.kind) {
    if (!KINDS[filter.kind]) throw new IssueError("issue.scope-refused", "kind is not a contract vocabulary value");
    clauses.push("issues.kind = ?");
    params.push(filter.kind);
  }
  if (filter.severity) {
    if (!SEVERITIES[filter.severity]) {
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
