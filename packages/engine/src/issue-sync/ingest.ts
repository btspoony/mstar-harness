/**
 * ingest.ts — associate remote issues with the local rows they mirror, from a
 * listing the caller fetched with its own tools.
 *
 * It writes NOTHING outside the sync ledger: no local issue is created, updated
 * or closed, and no remote issue is touched. The association key is
 * \`(repo, local)\` read from the correlation marker (\`marker.ts\`), so the same
 * local id in two different repositories never collides:
 *
 * 1. the marker decodes, its \`repo\` is this repository's, its \`author\` is this
 *    checkout's, and \`local\` exists here → ASSOCIATE: the push row takes the
 *    remote id when it has none, takes the remote revision watermark, and the
 *    remote content is compared with the hash mstar last confirmed for it. A
 *    difference is DRIFT: reported, never repaired (mstar does not write back).
 * 2. ... its \`author\` differs from this checkout's → FOREIGN: another
 *    operator's clone of the same repository pushed it. Reported, no write.
 * 3. ... \`local\` is unknown in this store → ORPHAN. Reported, no write.
 * 4. no marker, a marker of the deleted format, or another repository's marker
 *    → UNMANAGED. Never adopted by title or description, and never written.
 *
 * shortcut: association is repo + local + git author, not a store id, so two
 * stores of the same repository used by one author can both hold \`I-000123\`; a
 * content difference then shows up as drift for the operator to resolve.
 * Revisit if same-author multi-clone drift becomes common.
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
import { SyncError, markApplied, planItem as openLedgerCycle, readItem } from "../issue-sync.js";

/** What one associated (or refused) record says, in one shape per bucket. */
export type IngestEntry = {
  /** The local issue the marker names; null when the record carries no usable marker. */
  localId: string | null;
  externalId: string;
  url: string;
  /** Why the record landed in this bucket; absent on a clean association. */
  cause?: string;
};

export type IngestReport = {
  /** Associated and converged: the ledger now knows this remote issue. */
  associated: IngestEntry[];
  /** Associated, but the remote content no longer matches what mstar confirmed. */
  drift: IngestEntry[];
  /** Another git author's push of a local id in this same repository. */
  foreign: IngestEntry[];
  /** A marker naming a local issue this store does not have. */
  orphan: IngestEntry[];
  /** No usable marker, or one from another repository. */
  unmanaged: IngestEntry[];
};

/** Everything one ingest needs that is not the listing. */
export type IngestContext = {
  /** \`"linear:<project_id>"\`, the ledger's binding key. */
  bindingId: string;
  /** This checkout's repository identity and git author. */
  identity: { repo: string; author: string };
  /** The \`.mstarc\` mapping the pushed payload was built with. */
  mapping?: LinearFacetMapping;
};

/**
 * The payload hash a remote record describes, in the same shape \`requestHash\`
 * hashes, so it is comparable with the ledger's \`last_request_hash\`.
 *
 * shortcut: the priority band is recovered through the severity round trip, so
 * an absent or unrecognized remote priority reads as the medium band (3) rather
 * than as "no priority"; revisit if the remote starts omitting priority.
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

/** Does this store hold the local issue the marker names? */
function localIssueExists(db: StoreDb, localId: string): boolean {
  return db.prepare("select id from issues where id = ?").get(localId) !== undefined;
}

/**
 * Record the association on the push row: the remote identity when the row has
 * none, and the remote revision watermark always.
 *
 * A row that never existed is opened first, because the ledger has no way to
 * record an identity without a cycle — the row ends \`applied\`, so the next
 * \`pending\` plans an update of the existing remote issue instead of creating a
 * second one.
 */
function associate(db: StoreDb, context: IngestContext, localId: string, record: ProviderItem): void {
  const key = { bindingId: context.bindingId, direction: PUSH_DIRECTION, localId };
  const ledger = readItem(db, key);
  const step = "linear-ingest:" + context.bindingId + ":" + record.externalId + ":" + record.updatedAt;
  if (ledger === null) {
    openLedgerCycle(db, { ...key, externalId: record.externalId, operationId: step + ":plan" });
  }
  markApplied(db, {
    ...key,
    // Only a row with no identity takes this one: an identity mstar already
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
    if (!localIssueExists(db, marker.localId)) {
      report.orphan.push({
        ...entry,
        localId: marker.localId,
        cause:
          "names local issue " + JSON.stringify(marker.localId) + ", which this store does not hold; nothing was written. Capture that issue here, or close the remote one yourself if it is obsolete",
      });
      continue;
    }
    try {
      const ledger = readItem(db, { bindingId: context.bindingId, direction: PUSH_DIRECTION, localId: marker.localId });
      // The identity conflict is decided BEFORE anything is written: associating
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
      const cause = error instanceof Error ? error.message : String(error);
      throw new SyncError(
        "sync.illegal-transition",
        "associating remote issue " + record.externalId + " with local issue " + marker.localId +
          " was refused by the ledger: " + cause + ". Nothing else was written for it",
      );
    }
  }
  return report;
}
