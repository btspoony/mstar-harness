/**
 * issue-sync/import.ts — M0 read-only ingest (mirror-import plan Task 3).
 *
 * Pulls one page of provider records into the local store through the existing
 * capture path and the P1 ledger verbs; it never talks to a network, never
 * deletes and never pushes. A page is NOT atomic (spec §2): each step is its own
 * transaction, the loop consults `readItem` before re-planning, and a crash
 * between steps leaves a `pending` row the next run resumes.
 *
 * Imported rows are visibly external — `provider='linear'`, `external_id`,
 * `url` — and carry the synthetic identity triple below instead of a local one,
 * so a local capture can never be merged into them and a local-only gate that
 * filters `provider='local'` never counts them.
 */
import { createHash } from "node:crypto";
import {
  assertIssueStoreActive,
  captureIssueOn,
  computeIdentityKey,
  type CaptureInput,
  type IssueKind,
  type Severity,
} from "../issue.js";
import type { LinearFacetMapping } from "../mstarc.js";
import {
  isNewerInstant,
  isOlderInstant,
  markApplied,
  markFailed,
  planItem,
  readItem,
  replanItem,
  SyncError,
  type SyncDirection,
} from "../issue-sync.js";
import type { StoreDb } from "../store-db.js";
import type { ProviderItem } from "./provider.js";

/**
 * Synthetic identity triple for imported Linear rows: `computeIdentityKey`
 * (`issue.ts`) requires a source/root-cause/acceptance triple that a remote item
 * cannot carry. The keys below are fixed; sourceIdentity is per-item
 * (`"linear:" + externalId`) so each row gets a distinct, stable `identity_key`.
 * The reserved `"linear:"` namespace cannot collide with a local capture, whose
 * sourceIdentity is human-authored text.
 */
export const IMPORTED_ROOT_CAUSE_KEY = "linear:external";
export const IMPORTED_ACCEPTANCE_KEY = "linear:external";

/** The only provider this iteration knows; mirrors `project_bindings.provider`. */
export const LINEAR_PROVIDER = "linear";
/** One direction: this iteration only imports. */
export const IMPORT_DIRECTION: SyncDirection = "import";

/** The audited actor recorded on an import's capture receipt. */
const IMPORT_ACTOR = "sync-import";

export type ImportPageResult = {
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
};

/**
 * Import one listing page for the binding `"<provider>:<project_id>"`.
 *
 * Per item, in this order:
 * - no ledger row and no local row → capture, plan, apply → `imported`
 * - a local row but no ledger row (a crash after capture) → plan, apply → `updated`
 * - `applied` + an unchanged or older remote revision → nothing at all → `skipped`
 * - `applied` + a newer remote revision → `replanItem`, mirror the fields, apply
 *   → `updated`
 * - `pending` (a previous run stopped mid-item) → mirror, apply → `updated`
 * - `failed` → `planItem` retry, mirror, apply → `updated`
 * - `skipped` → `skipped` (the contract has no out-edge from it)
 * - any per-item error → `markFailed` where a pending row exists → `failed`
 */
export function importPage(
  db: StoreDb,
  bindingId: string,
  items: readonly ProviderItem[],
  mapping?: LinearFacetMapping,
): ImportPageResult {
  const projectId = projectIdOf(bindingId);
  // Every other capture route refuses a store that is not active
  // (`issue.ts` captureIssue); the ingest path is a store mutation and must not
  // be the one door that writes into a staged store.
  assertIssueStoreActive(db);
  const result: ImportPageResult = { imported: 0, updated: 0, skipped: 0, failed: 0 };
  for (const item of items) {
    const externalId = requireField(item.externalId, "externalId");
    let localId: string | undefined;
    try {
      const existing = findImportedIssue(db, externalId);
      if (existing === null) {
        assertNoLocalIdentityCollision(db, projectId, externalId);
        localId = captureImportedIssue(db, projectId, item, mapping);
        planAndApply(db, bindingId, localId, externalId, item);
        result.imported++;
        continue;
      }
      localId = existing;
      const ledger = readItem(db, { bindingId, direction: IMPORT_DIRECTION, localId });
      if (ledger === null) {
        planAndApply(db, bindingId, localId, externalId, item);
        result.updated++;
        continue;
      }
      if (ledger.itemState === "skipped") {
        result.skipped++;
        continue;
      }
      if (ledger.itemState === "applied" && !isNewerInstant(item.updatedAt, ledger.lastRemoteUpdatedAt)) {
        // Zero-delta: no ledger write, no issue write, not even a timestamp.
        result.skipped++;
        continue;
      }
      if (ledger.itemState === "applied") {
        replanItem(db, {
          bindingId,
          direction: IMPORT_DIRECTION,
          localId,
          externalId,
          remoteUpdatedAt: item.updatedAt,
          operationId: operationId(bindingId, item, "replan"),
        });
      } else if (ledger.itemState === "pending" && isOlderInstant(item.updatedAt, ledger.lastRemoteUpdatedAt)) {
        // A resumed cycle whose page is STALE relative to the recorded
        // watermark must not mirror older content: close the cycle on the
        // recorded revision instead, so a replayed page cannot walk the row
        // backwards and then read as zero-delta forever.
        markApplied(db, {
          bindingId,
          direction: IMPORT_DIRECTION,
          localId,
          // Its own id: the page's revision is older than the one this cycle was
          // opened for, so it must not replay that revision's `applied` receipt.
          operationId: `linear-import:${bindingId}:${localId}:stale-applied:${ledger.lastRemoteUpdatedAt ?? "none"}`,
        });
        result.skipped++;
        continue;
      } else if (ledger.itemState === "failed") {
        planItem(db, {
          bindingId,
          direction: IMPORT_DIRECTION,
          localId,
          externalId,
          remoteUpdatedAt: item.updatedAt,
          // A DIFFERENT id per attempt. Reusing the failed attempt's id replays
          // its receipt, so `planItem` returns the row untouched and a failed
          // item could never be retried — the ledger would stay `failed`
          // forever while every run reported another failure.
          operationId: `linear-import:${bindingId}:${localId}:retry:${item.updatedAt}:${ledger.revision}`,
        });
      }
      // `pending` needs no transition: a previous run already opened this cycle.
      mirrorRemoteFields(db, localId, externalId, item);
      // Fields are copied FIRST; the watermark rides the applied commit, so a
      // crash between the two leaves a pending row on the old revision instead
      // of a newer timestamp over stale content.
      markApplied(db, {
        bindingId,
        direction: IMPORT_DIRECTION,
        localId,
        remoteUpdatedAt: item.updatedAt,
        operationId: operationId(bindingId, item, "applied"),
      });
      result.updated++;
    } catch (error) {
      result.failed++;
      if (localId !== undefined) recordFailure(db, bindingId, localId, error);
    }
  }
  return result;
}

/** `"<provider>:<project_id>"` → the store project id (`sync.invalid-input` otherwise). */
function projectIdOf(bindingId: string): string {
  const prefix = `${LINEAR_PROVIDER}:`;
  if (typeof bindingId !== "string" || !bindingId.startsWith(prefix) || bindingId.length === prefix.length) {
    throw new SyncError(
      "sync.invalid-input",
      `bindingId must be "${LINEAR_PROVIDER}:<project_id>"; this iteration imports one Linear binding only`,
    );
  }
  return bindingId.slice(prefix.length);
}

function requireField(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SyncError("sync.invalid-input", `${name} must be a non-empty string`);
  }
  return value;
}

/** Deterministic per item and step, so a resumed run replays instead of duplicating. */
function operationId(bindingId: string, item: ProviderItem, step: string): string {
  return `linear-import:${bindingId}:${item.externalId}:${item.updatedAt}:${step}`;
}

function planAndApply(
  db: StoreDb,
  bindingId: string,
  localId: string,
  externalId: string,
  item: ProviderItem,
): void {
  planItem(db, {
    bindingId,
    direction: IMPORT_DIRECTION,
    localId,
    externalId,
    remoteUpdatedAt: item.updatedAt,
    operationId: operationId(bindingId, item, "plan"),
  });
  markApplied(db, {
    bindingId,
    direction: IMPORT_DIRECTION,
    localId,
    remoteUpdatedAt: item.updatedAt,
    operationId: operationId(bindingId, item, "applied"),
  });
}

/** The local row that already mirrors this remote item, if any. */
function findImportedIssue(db: StoreDb, externalId: string): string | null {
  const row = db
    .prepare("select id from issues where provider = ? and external_id = ?")
    .get(LINEAR_PROVIDER, externalId) as { id: string } | undefined;
  return row === undefined ? null : row.id;
}

/**
 * The synthetic identity must be unused by a local row. A local capture whose
 * `sourceIdentity` starts with `linear:` would land on the same identity, so the
 * collision is named here instead of silently merging two different things.
 */
function assertNoLocalIdentityCollision(db: StoreDb, projectId: string, externalId: string): void {
  const identityKey = computeIdentityKey(
    projectId,
    sourceIdentity(externalId),
    IMPORTED_ROOT_CAUSE_KEY,
    IMPORTED_ACCEPTANCE_KEY,
  );
  const clash = db.prepare("select id, provider from issues where identity_key = ?").get(identityKey) as
    | { id: string; provider: string }
    | undefined;
  if (clash !== undefined && clash.provider !== LINEAR_PROVIDER) {
    throw new SyncError(
      "linear.identity-collision",
      `Linear issue ${externalId} maps to identity of local issue ${clash.id}; the reserved "linear:" namespace is not a local identity. Rename the local sourceIdentity and retry.`,
    );
  }
}

function sourceIdentity(externalId: string): string {
  return `${LINEAR_PROVIDER}:${externalId}`;
}

/**
 * Capture the remote item through the existing capture path, in ONE transaction
 * that also stamps the reserved external columns. The capture receipt is keyed
 * by its operation id, so a resumed run replays it instead of creating a second
 * issue.
 */
function captureImportedIssue(db: StoreDb, projectId: string, item: ProviderItem, mapping?: LinearFacetMapping): string {
  const externalId = requireField(item.externalId, "externalId");
  const input = captureInput(projectId, item, mapping);
  db.exec("begin immediate");
  try {
    const receipt = captureIssueOn(db, input, {
      operationId: operationId(`${LINEAR_PROVIDER}:${projectId}`, item, "capture"),
      actor: IMPORT_ACTOR,
    });
    db.prepare("update issues set provider = ?, external_id = ?, url = ? where id = ?").run(
      LINEAR_PROVIDER,
      externalId,
      input.location,
      receipt.issueId,
    );
    db.exec("commit");
    return receipt.issueId;
  } catch (error) {
    try {
      db.exec("rollback");
    } catch {
      // nothing was committed
    }
    throw error;
  }
}

/**
 * Mirror the remote fields the local row reflects (title, description, link).
 * Writes only when something differs, so a resumed run is a no-op rather than a
 * second `updated_at` bump; the row's `revision` advances with a real change.
 *
 * Receipt decision (QC F11): this is a raw-SQL field mirror with no
 * `store_operations` receipt of its own, and its RECEIPT IS THE SURROUNDING
 * TRANSACTION — the `begin immediate` … `commit` below is the atomic unit, so an
 * interrupted mirror leaves no partial row. The durable "this remote revision is
 * applied" record is the ledger receipt the caller writes with `markApplied`,
 * keyed by `(bindingId, localId, updatedAt)`: that operation id is what a resumed
 * run replays, and it is written after the mirror in the same item cycle.
 */
function mirrorRemoteFields(db: StoreDb, localId: string, externalId: string, item: ProviderItem): void {
  const description = impactOf(item);
  db.exec("begin immediate");
  try {
    const row = db
      .prepare("select title, impact, url from issues where id = ?")
      .get(localId) as { title: string; impact: string; url: string | null } | undefined;
    if (row === undefined) {
      throw new SyncError("sync.local-issue-missing", `localId '${localId}' is not an issue in this store`);
    }
    if (row.title !== item.title || row.impact !== description || row.url !== item.url) {
      db.prepare("update issues set title = ?, impact = ?, url = ?, revision = revision + 1, updated_at = ? where id = ?").run(
        item.title,
        description,
        item.url,
        new Date().toISOString(),
        localId,
      );
    }
    db.exec("commit");
  } catch (error) {
    try {
      db.exec("rollback");
    } catch {
      // nothing was committed
    }
    throw error;
  }
  // `externalId` is the ledger's own key; the row's copy is written at capture
  // time, so a mirror never re-points it.
  void externalId;
}

/** Best-effort: record the failure on a pending row so the next run retries it. */
function recordFailure(db: StoreDb, bindingId: string, localId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const ledger = readItem(db, { bindingId, direction: IMPORT_DIRECTION, localId });
    if (ledger === null || ledger.itemState !== "pending") return;
    // Keyed by the CAUSE as well as the row revision: two different causes on
    // the same revision are two different requests, and reusing one id for both
    // would refuse the second as `sync.operation-conflict`.
    const causeKey = createHash("sha256").update(message).digest("hex").slice(0, 12);
    markFailed(db, {
      bindingId,
      direction: IMPORT_DIRECTION,
      localId,
      operationId: `linear-import:${bindingId}:${localId}:failed:${ledger.revision}:${causeKey}`,
      error: message,
    });
  } catch {
    // The page loop's failure count is the report of record; a ledger refusal
    // here must not mask the original cause.
  }
}

function impactOf(item: ProviderItem): string {
  const description = typeof item.description === "string" ? item.description.trim() : "";
  return description === "" ? item.title : description;
}

/**
 * Apply one `[linear.mapping]` facet. The override is keyed by the value the
 * default mapping produced, so an operator can retarget a facet without
 * restating the whole correspondence; an unmapped value passes through.
 */
function facet<T extends string>(
  overrides: Record<string, string> | undefined,
  value: T,
  allowed: readonly T[],
): T {
  const mapped = overrides?.[value];
  if (mapped === undefined || mapped.trim() === "") return value;
  // A correspondence that targets a value the local enum does not have is
  // refused by name: storing it would fail validation later with a message that
  // no longer points at the .mstarc line that caused it.
  if (!allowed.includes(mapped as T)) {
    throw new SyncError(
      "sync.invalid-input",
      `[linear.mapping] maps ${JSON.stringify(value)} to ${JSON.stringify(mapped)}, which is not a recognised value`,
    );
  }
  return mapped as T;
}

function captureInput(projectId: string, item: ProviderItem, mapping?: LinearFacetMapping): CaptureInput {
  const externalId = requireField(item.externalId, "externalId");
  const identity = sourceIdentity(externalId);
  return {
    projectId,
    title: requireField(item.title, "title"),
    kind: facet(mapping?.kind, kindOf(item), KIND_VALUES),
    severity: facet(mapping?.severity, severityOf(item.priority), SEVERITY_VALUES),
    impact: impactOf(item),
    acceptance: `Mirror of Linear issue ${externalId}; the remote item owns its own acceptance.`,
    sourceIdentity: identity,
    rootCauseKey: IMPORTED_ROOT_CAUSE_KEY,
    acceptanceKey: IMPORTED_ACCEPTANCE_KEY,
    occurrenceKey: identity,
    sourceKind: LINEAR_PROVIDER,
    location: typeof item.url === "string" ? item.url : "",
    observedBehavior: item.title,
    evidence: [item.url],
    discoveredAt: item.updatedAt,
  };
}

const KIND_VALUES: readonly IssueKind[] = ["bug", "risk", "improvement", "request", "decision", "review-obligation"];
const SEVERITY_VALUES: readonly Severity[] = ["critical", "high", "medium", "low", "nit"];

/**
 * Compass D4's default correspondence: a label naming a local kind selects it,
 * otherwise the lossy fallback `request` (a remote item carries no local kind
 * of its own; the `[linear.mapping]` override is the supported way to change it).
 */
function kindOf(item: ProviderItem): IssueKind {
  for (const label of item.labels ?? []) {
    const candidate = label.trim().toLowerCase();
    const match = KIND_VALUES.find((kind) => kind === candidate);
    if (match !== undefined) return match;
  }
  return "request";
}

/**
 * Compass D4's fixed lossy `priority → severity` mapping. The local enum has no
 * "unset", so a missing or unrecognised priority lands on the neutral `medium`.
 */
function severityOf(priority: string | null): Severity {
  switch ((priority ?? "").trim().toLowerCase()) {
    case "urgent":
    case "1":
      return "critical";
    case "high":
    case "2":
      return "high";
    case "low":
    case "4":
      return "low";
    case "medium":
    case "normal":
    case "3":
    default:
      return "medium";
  }
}
