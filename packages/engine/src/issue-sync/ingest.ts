/**
 * ingest.ts — associate remote issues with the local rows they mirror, from a
 * listing the caller fetched with its own tools.
 *
 * It writes NOTHING outside the sync ledger: no local issue is created, updated
 * or closed, and no remote issue is touched. The association key is
 * `(repo, local)` read from the correlation marker (`marker.ts`), so the same
 * local id in two different repositories never collides:
 *
 * 1. the marker decodes, its `repo` is this repository's, its `author` is this
 *    checkout's, and `local` exists here → ASSOCIATE: the push row takes the
 *    remote id when it has none, takes the remote revision watermark, and the
 *    remote content is compared with the hash mstar last confirmed for it. A
 *    difference is DRIFT: reported, never repaired (mstar does not write back).
 * 2. ... its `author` differs from this checkout's → FOREIGN: another
 *    operator's clone of the same repository pushed it. Reported, no write.
 * 3. ... `local` is unknown in this store, or belongs to another project → ORPHAN.
 *    Reported, no write.
 * 4. no marker, a marker of the deleted format, or another repository's marker
 *    → UNMANAGED. Never adopted by title or description, and never written.
 *
 * shortcut: association is repo + local + git author, not a store id, so two
 * stores of the same repository used by one author can both hold `I-000123`; a
 * content difference then shows up as drift for the operator to resolve.
 * upgrade: carry a store id in the marker when same-author multi-clone drift
 * becomes common.
 *
 * This ingest deliberately bypasses the run lease. Association is not a send
 * right: it records a FACT about the remote (this issue carries this marker),
 * so two concurrent ingests associate the same fact and nothing races. What
 * protects a residue from being claimed by a run that did not plan it is the
 * unclaimed-row guard in `push.ts` `recordResults`, not this lease - which is
 * also why the association must never be recorded after an identity-conflict
 * refusal.
 */
import type { StoreDb } from "../store-db.js";
import type { LinearFacetMapping } from "../mstarc.js";
import {
  PUSH_DIRECTION,
  requestHash,
} from "./push.js";
import { priorityOfSeverity, severityOfPriority } from "./field-mapping.js";
import { decodeMarker } from "./marker.js";
import type { ProviderItem, ProviderWritePayload } from "./provider.js";
import { isNewerInstant, SyncError, markApplied, planItem as openLedgerCycle, readItem } from "../issue-sync.js";

/** What one associated (or refused) record says, in one shape per bucket. */
export type IngestEntry = {
  /** note: The local issue the marker names; null when the record carries no usable marker. */
  localId: string | null;
  externalId: string;
  url: string;
  /** note: Why the record landed in this bucket; absent on a clean association. */
  cause?: string;
};

export type IngestReport = {
  /** note: Associated and converged: the ledger now knows this remote issue. */
  associated: IngestEntry[];
  /**
   * note: Needs the operator. Three cases, all "nothing was rewritten here": the remote
   * content no longer matches what mstar confirmed, two remote issues claim one
   * local issue, or the ledger row cannot take an association (a released/failed
   * create). The cause names the recovery.
   */
  drift: IngestEntry[];
  /** note: Another git author's push of a local id in this same repository. */
  foreign: IngestEntry[];
  /** note: A marker naming a local issue this store does not have. */
  orphan: IngestEntry[];
  /** note: No usable marker, or one from another repository. */
  unmanaged: IngestEntry[];
};

/** Everything one ingest needs that is not the listing. */
export type IngestContext = {
  /** note: `"linear:<project_id>"`, the ledger's binding key. */
  bindingId: string;
  /** note: This checkout's repository identity and git author. */
  identity: { repo: string; author: string };
  /** note: The `.mstarc` mapping the pushed payload was built with. */
  mapping?: LinearFacetMapping;
};

/**
 * The payload hash a remote record describes, in the same shape `requestHash`
 * hashes, so it is comparable with the ledger's `last_request_hash`.
 *
 * shortcut: the priority band is recovered through the severity round trip, so
 * an absent or unrecognized remote priority reads as the medium band (3) rather
 * than as "no priority". upgrade: carry the priority band explicitly when the
 * remote starts omitting it.
 */
function remoteHash(record: ProviderItem, mapping?: LinearFacetMapping): string {
  const payload: ProviderWritePayload = {
    title: record.title,
    description: record.description,
    priority: priorityOfSeverity(severityOfPriority(record.priority, mapping), mapping),
    state: record.state,
    labels: [...(record.labels ?? [])],
  };
  return requestHash(payload);
}

/** note: The store project a `"linear:<project_id>"` binding drives (`sync.invalid-input` otherwise). */
function projectIdOf(bindingId: string): string {
  const prefix = "linear:";
  if (typeof bindingId !== "string" || !bindingId.startsWith(prefix) || bindingId.length === prefix.length) {
    throw new SyncError("sync.invalid-input", `bindingId must be "${prefix}<project_id>"; ingest drives one Linear binding`);
  }
  return bindingId.slice(prefix.length);
}

/** note: Does ANY issue in this store carry this id? Used only to word the orphan cause. */
function localIssueExists(db: StoreDb, localId: string): boolean {
  return db.prepare("select id from issues where id = ?").get(localId) !== undefined;
}

/**
 * note: Is the local issue the marker names part of THIS binding's project?
 *
 * Existence alone is not enough: issue ids are store-wide, so a marker from
 * another project of the same store would otherwise be associated under the
 * project this run was asked to mirror.
 */
function localIssueInProject(db: StoreDb, projectId: string, localId: string): boolean {
  return db.prepare("select id from issues where id = ? and project_id = ?").get(localId, projectId) !== undefined;
}

/**
 * note: Record the association on the push row: the remote identity when the row has
 * none, and the remote revision watermark always.
 *
 * A row that never existed is opened first, because the ledger has no way to
 * record an identity without a cycle — the row ends `applied`, so the next
 * `pending` plans an update of the existing remote issue instead of creating a
 * second one.
 *
 * Re-ingesting the same record is a NO-OP, not a rewrite: the row already says
 * exactly this, and writing again would reuse a claim receipt with a different
 * request (the ledger refuses that as an operation conflict). The caller owns
 * the state check (a row that cannot take an association never reaches here).
 */
function associate(db: StoreDb, context: IngestContext, localId: string, record: ProviderItem): void {
  const key = { bindingId: context.bindingId, direction: PUSH_DIRECTION, localId };
  const ledger = readItem(db, key);
  if (
    ledger !== null &&
    ledger.itemState === "applied" &&
    ledger.externalId === record.externalId &&
    !isNewerInstant(record.updatedAt, ledger.lastRemoteUpdatedAt)
  ) {
    return;
  }
  const step = "linear-ingest:" + context.bindingId + ":" + record.externalId + ":" + record.updatedAt;
  if (ledger === null) {
    openLedgerCycle(db, { ...key, externalId: record.externalId, operationId: step + ":plan" });
  }
  markApplied(db, {
    ...key,
    // why: Only a row with no identity takes this one: an identity mstar already
    // confirmed is a fact, and overwriting it would move the mirror silently.
    ...(ledger?.externalId == null ? { externalId: record.externalId } : {}),
    remoteUpdatedAt: record.updatedAt,
    operationId: step + ":applied",
  });
}

/** Ingest one listing. Records are independent: one bucket entry each, in order. */
export function ingestRecords(
  db: StoreDb,
  context: IngestContext,
  records: readonly ProviderItem[],
): IngestReport {
  const report: IngestReport = { associated: [], drift: [], foreign: [], orphan: [], unmanaged: [] };
  for (const record of records) {
    const entry: IngestEntry = { localId: null, externalId: record.externalId, url: record.url };
    const marker = decodeMarker(record.description);
    if (marker === null) {
      report.unmanaged.push({
        ...entry,
        cause:
          "carries no mstar correlation marker (or one of the deleted format); mstar never adopts a remote issue by title or description - name its local issue with 'issue-sync apply --adopt <localId>=<issueUrl|externalId>' if it belongs to this repository",
      });
      continue;
    }
    if (marker.repo !== context.identity.repo) {
      report.unmanaged.push({
        ...entry,
        localId: marker.localId,
        cause:
          "carries a marker for repository " + JSON.stringify(marker.repo) + ", not this checkout's " +
          JSON.stringify(context.identity.repo) + "; nothing was associated",
      });
      continue;
    }
    if (marker.author !== context.identity.author) {
      report.foreign.push({
        ...entry,
        localId: marker.localId,
        cause:
          "was pushed by " + JSON.stringify(marker.author) + ", not this checkout's " + JSON.stringify(context.identity.author) +
          "; another operator's clone of this repository owns it, so nothing was written here",
      });
      continue;
    }
    const projectId = projectIdOf(context.bindingId);
    if (!localIssueInProject(db, projectId, marker.localId)) {
      const elsewhere = localIssueExists(db, marker.localId);
      report.orphan.push({
        ...entry,
        localId: marker.localId,
        cause: elsewhere
          ? "names local issue " + JSON.stringify(marker.localId) + ", which belongs to a DIFFERENT project than the one this run mirrors (" +
            JSON.stringify(projectId) + "); nothing was written. Run ingest for the project that owns it, or capture the issue here first"
          : "names local issue " + JSON.stringify(marker.localId) + ", which this store does not hold; nothing was written. Capture that issue here, or close the remote one yourself if it is obsolete",
      });
      continue;
    }
    try {
      const ledger = readItem(db, { bindingId: context.bindingId, direction: PUSH_DIRECTION, localId: marker.localId });
      // why: The identity conflict is decided BEFORE anything is written: associating
      // first and then reporting the mismatch would still have moved the row's
      // watermark to a revision the ledger refuses to own.
      if (ledger?.externalId != null && ledger.externalId !== record.externalId) {
        report.drift.push({
          ...entry,
          localId: marker.localId,
          cause:
            "the ledger holds " + JSON.stringify(ledger.externalId) + " for this item while this remote issue carries its marker; " +
            "two remote issues claim one local issue - keep the right one with 'issue-sync apply --adopt <localId>=<issueUrl|externalId>'. Nothing was written for this record",
        });
        continue;
      }
      // why: A row that cannot take an association is a TARGETED refusal, not a
      // whole-run abort: a `failed` row is where a released create lands, and the
      // remote request that created the issue can still arrive after the release.
      if (ledger !== null && ledger.itemState !== "applied" && ledger.itemState !== "pending") {
        report.drift.push({
          ...entry,
          localId: marker.localId,
          cause:
            "the push ledger row for this item is " + JSON.stringify(ledger.itemState) +
            ", so this association cannot be recorded and nothing was written. When the remote issue is the right one, record it with " +
            "'issue-sync apply --adopt <localId>=<issueUrl|externalId>'; if the create never reached Linear, the next 'issue-sync pending' already plans it again",
        });
        continue;
      }
      associate(db, context, marker.localId, record);
      if (ledger?.lastRequestHash != null && remoteHash(record, context.mapping) !== ledger.lastRequestHash) {
        report.drift.push({
          ...entry,
          localId: marker.localId,
          cause:
            "the remote issue no longer matches the payload mstar last confirmed for it; nothing was rewritten locally - " +
            "edit it in Linear or re-run 'issue-sync pending' to push the local content over it",
        });
        continue;
      }
      report.associated.push({ ...entry, localId: marker.localId });
    } catch (error) {
      // why: Only a ledger refusal is this record's own answer. A storage failure may
      // have written the association before its receipt failed, so it must abort the
      // batch and roll back, never be reported as a drifted record.
      if (!(error instanceof SyncError)) throw error;
      const cause = error.message;
      throw new SyncError(
        "sync.illegal-transition",
        "associating remote issue " + record.externalId + " with local issue " + marker.localId +
          " was refused by the ledger: " + cause + ". Nothing else was written for it",
      );
    }
  }
  return report;
}
