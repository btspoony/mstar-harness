/**
 * note: issue-sync/push.ts — the one-way push direction over the sync ledger.
 *
 * mstar performs no external call here. An agent holding the host's Linear tools
 * does the writing; this module owns the local half of the run:
 *
 * - CANDIDATES are the bound project's local issues ('provider = local').
 *   Each is normalized through the shared field mapping into one payload and
 *   hashed. The hash is the SKIP RULE — equal hash means the remote content is
 *   already what local says, so nothing is due. It is NOT an exactly-once proof:
 *   the hash is computed from local content, and only a confirmed result (or an
 *   operator '--adopt') ever records an external id.
 * - PLANNING records intent. 'planItem' claims the create BEFORE the caller's
 *   tool call, so an unconfirmed result leaves a 'pending' residue a later run
 *   reconciles instead of creating twice.
 * - A CONFIRMED result is the only thing that writes 'external_id'.
 *   'ambiguous' leaves a create 'pending' with no id: the caller must reconcile.
 * - AMBIGUOUS CREATE RECOVERY is marker equality, never prose. Every payload
 *   description ends with the marker 'marker.ts' encodes — this repository's
 *   'owner/name', the local issue id, and the pushing checkout's git author — so
 *   another clone of the same repository never adopts this store's rows by
 *   accident, and a unique title+description match proves nothing about
 *   ownership and is never adopted.
 *
 * THE RUN LEASE IS NOT CONCURRENCY. One lease per binding ('sync_runs') is held
 * by the pending/apply pair, and every ledger write carries the run token, so a
 * run that a '--take-run' predecessor replaced has its later writes refused
 * ('sync.run-taken') instead of applied. What that buys is bounded, and the
 * bound is the honest claim:
 * - No RUNNING run's create can be in flight beside this one's, because only one
 *   run holds the direction.
 * - A tool call already ISSUED by a holder that died mid-call may still land at
 *   the remote after the successor has planned. Nothing here can recall it,
 *   which is why reconcile-by-correlation-marker remains the FIRST recovery and
 *   why a 'pending' residue is never created over.
 * - Taking the run over from a LIVE holder is unsafe: the takeover cannot stop
 *   the predecessor's in-flight call, only its later ledger writes. '--take-run'
 *   is for a holder the operator confirmed is dead.
 *
 * Credential-free by construction: no transport, no token, and no machine path
 * reaches this module.
 */
import { createHash } from "node:crypto";
import type { StoreDb } from "../store-db.js";
import type { Disposition, IssueKind, Severity } from "../issue.js";
import type { LinearFacetMapping } from "../mstarc.js";
import {
  isOlderInstant,
  SyncError,
  claimItem,
  markApplied,
  markFailed,
  markUnconfirmed,
  planItem as openLedgerCycle,
  readItem,
  readRun,
  recordRefusal,
  requireRunLease,
  type SyncItem,
} from "../issue-sync.js";
import { providerPayloadFields } from "./field-mapping.js";
import { decodeMarker, encodeMarker } from "./marker.js";
import type { ProviderItem, ProviderWritePayload } from "./provider.js";

/** The only direction this module drives. */
export const PUSH_DIRECTION = "push" as const;

/** Everything one item plan needs that is not local content. */
export type PushContext = {
  /** note: '"linear:<project_id>"', the ledger's binding key. */
  bindingId: string;
  /** note: This checkout's repository identity and git author, stamped into the marker. */
  identity: { repo: string; author: string };
  mapping?: LinearFacetMapping;
  /**
   * note: The run lease this run holds ('RunLease.runId'). Every ledger write this
   * run performs carries it, so a run that '--take-run' replaced mid-flight has
   * its later writes REFUSED ('sync.run-taken') instead of applied — the lease
   * check at acquisition cannot cover a write the predecessor had not made yet.
   * Omitted by a caller with no lease, which is the same path import takes.
   */
  runId?: string;
};

/** One local issue, with the content a payload needs. */
export type PushCandidate = {
  localId: string;
  title: string;
  kind: IssueKind;
  severity: Severity;
  disposition: Disposition;
  impact: string;
  acceptance: string;
};

/**
 * One item ready to be written by the caller's own tools: the payload, the
 * marker its description carries, and the hash the skip rule compares.
 */
export type PushPlan = {
  localId: string;
  /** note: 'create' when the ledger holds no identity for this item yet. */
  operation: "create" | "update";
  externalId: string | null;
  payload: ProviderWritePayload;
  /** note: The marker the description ends with, reported so a caller can check it. */
  marker: string;
  requestHash: string;
};

/** What planning one candidate produced. */
export type PlanOutcome =
  | { outcome: "planned"; plan: PushPlan }
  | { outcome: "skipped"; localId: string; externalId: string; reason: string }
  | { outcome: "unresolved"; localId: string; cause: string };

/**
 * What the caller's tool reported for one item. 'refused' is provably NOT
 * delivered (safe to retry); 'ambiguous' was sent but unconfirmed, so a retry
 * could duplicate a create and the caller must reconcile instead; 'confirmed'
 * carries the identity the remote actually returned.
 */
export type PushResult = {
  localId: string;
  outcome: "confirmed" | "refused" | "ambiguous";
  externalId?: string | null;
  url?: string | null;
  /** note: ISO-8601 instant the remote reports for the written issue. */
  remoteUpdatedAt?: string | null;
  /** note: The tool's own cause text, for 'refused' and 'ambiguous'. */
  cause?: string | null;
};

/** What recording one result proved, per ledger verb. */
export type PushOutcome = {
  localId: string;
  outcome: "applied" | "unconfirmed" | "refused";
  externalId: string | null;
  cause?: string;
};

/**
 * The bound project's pushable issues: local captures, never imported mirrors.
 * An imported row's 'provider' is 'linear', so the import direction can never
 * echo its own mirror back as a create.
 */
export function selectPushCandidates(db: StoreDb, bindingId: string): PushCandidate[] {
  const projectId = projectIdOf(bindingId);
  return db
    .prepare(
      "select id as localId, title, kind, severity, disposition, impact, acceptance from issues" +
        " where project_id = ? and provider = 'local' order by id",
    )
    .all(projectId) as PushCandidate[];
}

/** note: The content of one local issue, for the ledger write that names it. */
function candidateOf(db: StoreDb, localId: string): PushCandidate | null {
  return (
    (db
      .prepare("select id as localId, title, kind, severity, disposition, impact, acceptance from issues where id = ?")
      .get(localId) as PushCandidate | undefined) ?? null
  );
}

/** note: '"<provider>:<project_id>"' → the store project id ('sync.invalid-input' otherwise). */
function projectIdOf(bindingId: string): string {
  const prefix = "linear:";
  if (typeof bindingId !== "string" || !bindingId.startsWith(prefix) || bindingId.length === prefix.length) {
    throw new Error('[sync.invalid-input] bindingId must be "linear:<project_id>"; push drives one Linear binding');
  }
  return bindingId.slice(prefix.length);
}

/**
 * The normalized payload's hash: the skip rule's storage. Content only — the
 * removal instruction is an ownership fact, not remote content, so it is not
 * part of what "the remote already says this" means.
 */
export function requestHash(payload: ProviderWritePayload): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        payload.title,
        payload.description,
        payload.priority,
        payload.state,
        payload.labels ?? [],
      ]),
    )
    .digest("hex");
}

/**
 * note: The send-right key for one create: binding, item and content hash.
 *
 * Deliberately NOT keyed on the ledger revision, which every refusal, failure
 * and apply advances. Revision keying existed only to discriminate attempts by
 * making a bypass mint a different key — and it could not cover the window where
 * the predecessor's own claim advanced it, which is the wedge three review rounds
 * found. The run lease is what separates RUNNING attempts now, so
 * the key is a stable per-residue identity: a re-plan of the same item can never
 * mint a new key mid-attempt, and 'claimItem' re-opens the cycle under this same
 * key when the previous attempt ended.
 */
function createClaimId(bindingId: string, localId: string, hash: string): string {
  return "linear-push:" + bindingId + ":" + localId + ":create:" + hash;
}

/** Markdown description: the two local sections that have no remote field, then the marker. */
function descriptionFor(candidate: PushCandidate, marker: string): string {
  return "## Impact\n\n" + candidate.impact + "\n\n## Acceptance\n\n" + candidate.acceptance + "\n\n" + marker;
}

/**
 * note: The payload, marker, hash and kind label of one candidate.
 *
 * An existing identity makes the update replace EXACTLY the labels this tool may
 * own: an unconfirmed earlier update can leave more than one of them on the
 * remote, so every recorded label except the desired one is removed (removing an
 * absent label is a no-op). Unknown ownership (none recorded) only adds.
 */
function planOf(
  context: PushContext,
  candidate: PushCandidate,
  ledger: SyncItem | null,
): { marker: string; payload: ProviderWritePayload; hash: string; kindLabel: string } {
  const marker = encodeMarker({
    repo: context.identity.repo,
    localId: candidate.localId,
    author: context.identity.author,
  });
  const fields = providerPayloadFields(candidate, context.mapping);
  const payload: ProviderWritePayload = {
    title: candidate.title,
    description: descriptionFor(candidate, marker),
    priority: fields.priority,
    state: fields.state,
    labels: [fields.label],
  };
  if (ledger?.externalId !== null && ledger?.externalId !== undefined) {
    const stale = ledger.lastKindLabels.filter((label) => label !== fields.label);
    if (stale.length > 0) payload.removeLabels = stale;
  }
  return { marker, payload, hash: requestHash(payload), kindLabel: fields.label };
}

/**
 * Plan one item: claim the create, build the payload, and apply the skip rule.
 * No external call — the caller performs the write with its own tools.
 *
 * By the row's state:
 * - 'pending' without an id → unresolved: reconcile first; without an adoption
 *   this run reports 'unresolved' and NEVER plans a create. This guard answers
 *   before anything else, because the row IS the only record that a remote issue
 *   may exist.
 * - 'applied' with an id and an equal hash → 'skipped', nothing due
 * - otherwise (an id exists) → update
 * - no row or a retryable 'failed' → claim the create, then plan it
 */
export function planItem(db: StoreDb, context: PushContext, candidate: PushCandidate): PlanOutcome {
  const localId = candidate.localId;
  requireRunLease(db, { bindingId: context.bindingId, direction: PUSH_DIRECTION, runId: context.runId });
  const ledger = readItem(db, { bindingId: context.bindingId, direction: PUSH_DIRECTION, localId });
  const externalId = ledger?.externalId ?? null;
  // why: A 'pending' row with no id is the residue of a create nobody confirmed. Its
  // state is the ONLY record that a remote issue may exist, so nothing in this
  // attempt may consume it.
  if (externalId === null && ledger?.itemState === "pending") {
    // why: An unresolved create. Adopting it is reconciliation's job; planning
    // another create could duplicate the remote issue, which is the one thing
    // this direction must never do. When the operator's own reconcile finds no
    // match, '--release <localId>' clears the row to the retryable 'failed' edge,
    // which is the one exit for proven absence.
    //
    // Nothing lifts this guard. The lease means no RUNNING create can be in
    // flight beside this one, so the row is a CRASHED attempt's residue — and a
    // tool call that crashed attempt already issued may still land, so no flag
    // can assert that no remote issue exists, which is the only thing that would
    // make a second create safe.
    return {
      localId,
      outcome: "unresolved",
      cause:
        "a previous create was never confirmed; the next reconcile adopts it by correlation marker, or name its remote issue with --adopt <localId>=<issueUrl|externalId>. When that listing finds no match, --release <localId> releases the residue so the next plan may create",
    };
  }
  const { marker, payload, hash } = planOf(context, candidate, ledger);

  // why: The skip rule comes FIRST. When the ledger already proves the remote says
  // exactly this, nothing is due.
  if (externalId !== null && ledger?.itemState === "applied" && ledger.lastRequestHash === hash) {
    return { outcome: "skipped", localId, externalId, reason: "unchanged" };
  }
  if (externalId !== null) {
    return { outcome: "planned", plan: { localId, operation: "update", externalId, payload, marker, requestHash: hash } };
  }

  // why: This is a create. Intent is recorded BEFORE the caller issues the call, so an
  // unconfirmed result leaves a durable residue to reconcile against.
  //
  // The claim is the intent record, not the concurrency arbiter: the run lease
  // means no RUNNING second run exists to race this create, so the key is a
  // stable per-residue identity — binding, item, content — and a re-plan of the
  // same item opens the cycle under that same key rather than minting a new one.
  // A 'pending' claim is still refused here (the residue guard above answers
  // first), so a crashed attempt's send right is never silently taken twice.
  const claim = claimItem(db, {
    bindingId: context.bindingId,
    direction: PUSH_DIRECTION,
    localId,
    operationId: createClaimId(context.bindingId, localId, hash),
    ...(context.runId === undefined ? {} : { runId: context.runId }),
  });
  if (!claim.claimed) {
    return {
      localId,
      outcome: "unresolved",
      cause:
        "this create could not take the send right because the ledger's row already decides it; nothing was sent for this item. " +
        "Run 'mstar issue-sync ingest' with a listing so an issue carrying this item's marker is associated with it, or record the identity with " +
        "'mstar issue-sync apply --adopt <localId>=<issueUrl|externalId>'",
    };
  }
  return { outcome: "planned", plan: { localId, operation: "create", externalId: null, payload, marker, requestHash: hash } };
}

/**
 * Record what the caller's tools reported, through the same ledger verbs the
 * write path always used: 'confirmed' → 'markApplied', 'refused' →
 * 'markFailed' (or 'recordRefusal' on a settled row), 'ambiguous' →
 * 'markUnconfirmed' for an update and NO write for a create, whose residue is
 * the ambiguity.
 *
 * Per-item failures are REPORTED, not thrown: an unknown local id or an
 * out-of-contract transition is that item's refusal, so one bad entry cannot
 * abort a whole run's report. Two failures are the exception and stop the whole
 * batch: a lease refusal (the run no longer owns the direction) and any error
 * that is not a ledger refusal at all. The second matters because a row and its
 * receipt share one transaction: a storage failure after the row update must roll
 * the batch back, never be reported as a committed per-item refusal.
 *
 * A `confirmed` result is refused as that item's failure when the row is a
 * `pending` create this run did not open (see `openedByThisRun`): recording an
 * identity there would silently adopt whatever the caller named, bypassing the
 * marker association and the operator's `--adopt`.
 *
 * shortcut: the payload hash is recomputed from the item's CURRENT content, so
 * an edit between plan and results records a hash for content the remote never
 * received. upgrade: record the planned hash with the claim when mid-run edits
 * become common.
 */
export function recordResults(db: StoreDb, context: PushContext, results: readonly PushResult[]): PushOutcome[] {
  requireRunLease(db, { bindingId: context.bindingId, direction: PUSH_DIRECTION, runId: context.runId });
  return results.map((result) => recordOne(db, context, result));
}

function recordOne(db: StoreDb, context: PushContext, result: PushResult): PushOutcome {
  const localId = typeof result.localId === "string" ? result.localId : "";
  try {
    const ledger = readItem(db, { bindingId: context.bindingId, direction: PUSH_DIRECTION, localId });
    if (ledger === null) {
      throw new SyncError(
        "sync.not-found",
        "no push ledger row for this item, so this run never planned it; re-run 'issue-sync pending' and apply the results it produced",
      );
    }
    const candidate = candidateOf(db, localId);
    if (candidate === null) {
      throw new SyncError(
        "sync.local-issue-missing",
        "this local id is not an issue in this store; nothing was recorded for it",
      );
    }
    const { hash, kindLabel } = planOf(context, candidate, ledger);
    const entryRevision = ledger.revision;
    const opId = (step: string): string =>
      "linear-push:" + context.bindingId + ":" + localId + ":" + step + ":" + hash + ":" + entryRevision;
    const lease = context.runId === undefined ? {} : { runId: context.runId };

    // why: A create cycle this run did not open is not this run's to record — neither a
    // confirmation NOR a refusal: `failed` is invisible to reconciliation, so
    // flipping the residue would hide the only record that a remote issue may
    // exist and let the next run create a duplicate. An ambiguous result writes
    // nothing, so it keeps its own answer below.
    if (
      (result.outcome === "confirmed" || result.outcome === "refused") &&
      ledger.itemState === "pending" &&
      ledger.externalId === null &&
      !openedByThisRun(db, context, ledger)
    ) {
      throw new SyncError(
        "sync.illegal-transition",
        "this create cycle was opened by an earlier run and never confirmed, so no result of this run can record it and nothing was written. " +
          "Associate the remote issue by its marker with 'mstar issue-sync ingest', record the identity you confirmed with " +
          "'mstar issue-sync apply --adopt <localId>=<issueUrl|externalId>', or - when the create never reached Linear - release the residue with " +
          "'mstar issue-sync apply --release <localId>'",
      );
    }
    if (result.outcome === "refused") {
      // why: The item is retryable and the report must say how: the cause alone leaves
      // the operator with a failure and no next step.
      const cause =
        (result.cause ?? "the remote refused the write") +
        " - nothing was applied; fix that cause in Linear, then run 'mstar issue-sync pending' again, which plans the same write";
      return failed(db, context, localId, "linear.write-refused", cause, true, hash);
    }
    if (result.outcome === "ambiguous") {
      if (ledger.externalId === null) {
        // why: Deliberately NO ledger write: the row keeps its (absent) identity as a
        // 'pending' residue, and the next reconcile decides by marker, never by
        // guesswork. That residue is also why the next plan cannot create at all
        // until reconciliation attributes it.
        return {
          localId,
          outcome: "unconfirmed",
          externalId: null,
          cause:
            (result.cause ?? "the remote did not confirm the create") +
            " - it stays unconfirmed: run 'mstar issue-sync ingest' with a listing so its marker associates the issue, or record the identity with 'mstar issue-sync apply --adopt <localId>=<issueUrl|externalId>'",
        };
      }
      // why: An update the remote did not confirm: the identity stands, but the
      // payload proof does not. Dropping the hash is what stops the next pass
      // from reporting 'skipped' off a fact that predates this write; the label
      // this write may have applied becomes ownership a corrective update
      // replaces.
      markUnconfirmed(db, {
        bindingId: context.bindingId,
        direction: PUSH_DIRECTION,
        localId,
        kindLabel,
        operationId: opId("unconfirmed"),
        ...lease,
      });
      return {
        localId,
        outcome: "unconfirmed",
        externalId: ledger.externalId,
        ...(result.cause == null ? {} : { cause: result.cause }),
      };
    }
    const externalId = typeof result.externalId === "string" && result.externalId.trim() !== "" ? result.externalId : null;
    if (externalId === null) {
      throw new SyncError(
        "sync.invalid-input",
        "a confirmed result must name the remote issue in 'externalId'; nothing was recorded for this item. Re-send the entry with the identifier the tool returned",
      );
    }
    // why: A confirmed identity that differs from the row's recorded one is an
    // identity replacement, not a receipt: the recorded id came from an ingest
    // association or a same-run --adopt, and moving it silently would leave the
    // old remote issue behind with no trace. The operator says so explicitly.
    if (ledger.externalId !== null && ledger.externalId !== externalId) {
      throw new SyncError(
        "sync.identity-conflict",
        "this item already points at " + JSON.stringify(ledger.externalId) + ", so " + JSON.stringify(externalId) +
          " cannot be recorded from a tool result and nothing was written. If " + JSON.stringify(externalId) +
          " really is the right issue, record it with 'mstar issue-sync apply --adopt <localId>=" + externalId +
          " --force-adopt <localId>'",
      );
    }

    markApplied(db, {
      bindingId: context.bindingId,
      direction: PUSH_DIRECTION,
      localId,
      externalId,
      remoteUpdatedAt: result.remoteUpdatedAt ?? null,
      requestHash: hash,
      kindLabel,
      operationId: opId("applied"),
      ...lease,
    });
    return { localId, outcome: "applied", externalId };
  } catch (error) {
    // why: A lease refusal is not this item's cause: the run no longer owns the
    // direction, so the whole run must stop instead of being reported per item.
    // Neither is a failure that is not a ledger refusal: it may have landed after
    // the row was written, so only a rollback keeps the row and its receipt together.
    if (!(error instanceof SyncError) || error.code === "sync.run-taken") throw error;
    return { localId, outcome: "refused", externalId: null, cause: error.message };
  }
}

/**
 * Did the run `apply` is recording for OPEN this create cycle?
 *
 * The claim is the only ledger write a `pending` create row ever receives, so the
 * row's `updatedAt` is the moment it was claimed. A run that started AFTER that
 * write is a different attempt: its results cannot describe this cycle's remote
 * issue, because the cycle belongs to the attempt that opened it.
 *
 * shortcut: evidence is time-based, so a residue of the SAME run this apply
 * continues still reads as planned, and a caller with no lease at all is taken as
 * having planned the cycle. upgrade: stamp the claiming run on the row when either
 * bound starts to matter.
 */
function openedByThisRun(db: StoreDb, context: PushContext, ledger: SyncItem): boolean {
  // A caller with no lease has no "this run" to compare against: its plan/record
  // pair is the whole evidence, so the cycle is taken as planned. The command
  // path always carries a lease, and that is where the reviewed adoption hole was.
  if (context.runId === undefined) return true;
  const run = readRun(db, { bindingId: context.bindingId, direction: PUSH_DIRECTION });
  if (run === null || run.runId !== context.runId) return false;
  return !isOlderInstant(ledger.updatedAt, run.startedAt);
}

/**
 * note: Record a refusal on the item.
 *
 * Best-effort by design: the run's report is the record of what happened, and a
 * ledger refusal here must not mask the cause that produced it. Only a genuine
 * ledger conflict reaches the catch now that every state takes a legal verb.
 *
 * A row that already holds an identity or a settled state ('applied', 'failed',
 * 'skipped') must NOT take the 'failed' edge: 'applied → failed' is not in the
 * contract, and the row's identity, hash and ownership are facts an earlier
 * confirmed write proved. A refused UPDATE therefore leaves the row 'applied'
 * WITH its cause recorded, and the changed hash still makes the next run retry
 * the write. 'recordRefusal' is that error-only verb.
 *
 * A 'pending' row with no id never reaches here: 'planItem''s residue guard
 * answers first, because 'failed' is invisible to reconciliation and downgrading
 * the residue would let a later run create a duplicate nobody can adopt.
 */
function failed(
  db: StoreDb,
  context: PushContext,
  localId: string,
  code: string,
  cause: string,
  planRow: boolean,
  hash?: string,
): PushOutcome {
  const message = "[" + code + "] " + cause;
  try {
    const ledger = readItem(db, { bindingId: context.bindingId, direction: PUSH_DIRECTION, localId });
    // why: An item that never reached the ledger still gets a row here, so the
    // operator can SEE why it is not pushed; 'failed → pending' is a legal retry
    // edge, so the next run tries again once the cause is addressed.
    if (ledger === null && planRow) {
      openLedgerCycle(db, {
        bindingId: context.bindingId,
        direction: PUSH_DIRECTION,
        localId,
        operationId: "linear-push:" + context.bindingId + ":" + localId + ":plan:preflight",
        ...(context.runId === undefined ? {} : { runId: context.runId }),
      });
    }
    const current = ledger ?? readItem(db, { bindingId: context.bindingId, direction: PUSH_DIRECTION, localId });
    if (current !== null) {
      // why: 'markFailed' is the retry edge and is legal only from 'pending'.
      const retryable = current.itemState === "pending";
      const step = retryable ? "failed" : "refused";
      const operationId =
        "linear-push:" + context.bindingId + ":" + localId + ":" + step + ":" + (hash ?? "preflight") + ":" + current.revision;
      const input = {
        bindingId: context.bindingId,
        direction: PUSH_DIRECTION,
        localId,
        operationId,
        ...(context.runId === undefined ? {} : { runId: context.runId }),
      };
      if (retryable) markFailed(db, { ...input, error: message });
      else recordRefusal(db, { ...input, error: message });
    }
  } catch (error) {
    // A lease refusal is not this item's cause: the run no longer owns the
    // direction, so the whole run must stop instead of being reported per item.
    // A non-ledger failure may have committed this row before the receipt failed,
    // so it aborts the batch rather than becoming this item's refusal.
    if (!(error instanceof SyncError) || error.code === "sync.run-taken") throw error;
    // The returned outcome still carries the cause.
  }
  return { localId, outcome: "refused", externalId: null, cause: message };
}

export type ReconcileReport = {
  /** Rows adopted this run, with the identity marker equality proved. */
  adopted: Array<{ localId: string; externalId: string }>;
  /** Rows that could not be attributed to exactly one remote issue. */
  unresolved: Array<{ localId: string; cause: string }>;
};

/**
 * The reason a release records: the operator's judgement in the one state the
 * ledger cannot decide, stated as such so it is never read as a failed attempt.
 */
const RELEASE_REASON =
  "released by the operator after reconciliation found no remote issue carrying this item's correlation marker; the next plan may create";

/**
 * note: A 'pending' row with no id can be released only by the operator, and only
 * from the listing that proved absence: 'failed' is the ledger's retryable edge,
 * so the next plan claims the create again. The revision joins the operation id
 * so a later ambiguity for the same item is a new release, not a replay.
 *
 * What the release CANNOT do is see a tool call another holder already issued:
 * this run holds the binding's only lease, so no RUNNING create for that residue
 * can be inside a remote call beside it — but a call issued by a holder that
 * died mid-flight may still land after this listing. That is why
 * reconcile-by-marker is the first recovery and why releasing over a listing
 * that found nothing is the operator's judgement, recorded as such. The write
 * carries this run's token, so a run a takeover replaced cannot release
 * anything at all.
 */
function releasePendingCreate(db: StoreDb, context: PushContext, localId: string): void {
  const current = readItem(db, { bindingId: context.bindingId, direction: PUSH_DIRECTION, localId });
  markFailed(db, {
    bindingId: context.bindingId,
    direction: PUSH_DIRECTION,
    localId,
    error: RELEASE_REASON,
    operationId: "linear-push:" + context.bindingId + ":" + localId + ":release:" + (current?.revision ?? 0),
    ...(context.runId === undefined ? {} : { runId: context.runId }),
  });
}

/**
 * Only the row shape a release exists for can be released. Anything else is an
 * operator error about the ledger, reported before the listing is read and any
 * write — and the command calls this before its own first write, so a bad
 * '--release' cannot land after an '--adopt' already did.
 */
export function assertReleaseTargets(db: StoreDb, bindingId: string, release: ReadonlySet<string>): void {
  for (const localId of release) {
    const item = readItem(db, { bindingId, direction: PUSH_DIRECTION, localId });
    if (item === null || item.itemState !== "pending" || item.externalId !== null) {
      throw new SyncError(
        "sync.illegal-transition",
        "--release " + localId + " names no unresolved create: " +
          (item === null
            ? "the item has no push ledger row"
            : "its row is '" + item.itemState + "'" + (item.externalId === null ? "" : " as " + item.externalId)) +
          "; release clears only a pending create with no remote id - name a known issue with --adopt, and let every other item plan normally",
      );
    }
  }
}

/**
 * Adopt ambiguous creates by correlation marker, over a listing the caller
 * fetched with its own tools.
 *
 * A row is adopted ONLY when exactly one remote record carries its exact marker
 * — the same `repo` and `local` this store would write. Zero or several matches
 * stay 'unresolved'; this function never creates, and prose equality is never
 * evidence. The author is not part of the match: another clone of the same
 * repository by the same author is the ingest's `foreign` case, and a residue
 * the operator can see the issue for is adopted explicitly with '--adopt'.
 * The listing's completeness is the caller's fact, not this function's: a
 * listing it did not read to its end proves neither absence nor uniqueness, and
 * the caller must not present one as complete.
 *
 * 'options.release' names 'pending'-without-id rows the operator has released
 * after this same listing found nothing: they drop to 'failed', the retryable
 * edge, so the next plan may create. A release is REFUSED when reconciliation
 * found a match — that row's recovery is adoption, or '--adopt' naming the
 * right issue — and the refusal is decided over the whole listing before the
 * first write.
 *
 * A run with no ambiguous residue short-circuits: it reads no record.
 */
export function reconcileWith(
  db: StoreDb,
  context: PushContext,
  records: readonly ProviderItem[],
  options: { release?: ReadonlySet<string> } = {},
): ReconcileReport {
  const release = options.release ?? new Set<string>();
  assertReleaseTargets(db, context.bindingId, release);
  const pending = db
    .prepare(
      "select local_id from issue_sync_state where binding_id = ? and direction = ? and item_state = 'pending' and external_id is null",
    )
    .all(context.bindingId, PUSH_DIRECTION) as Array<{ local_id: string }>;
  const report: ReconcileReport = { adopted: [], unresolved: [] };
  if (pending.length === 0) return report;

  // why: The association key is (repo, local): this repository's identity plus the
  // local issue id the marker names. A record pushed from another repository,
  // another store of a different repo, or by the deleted code's marker shape
  // decodes to nothing and is never a candidate.
  const wanted = new Set(pending.map(({ local_id: localId }) => localId));
  const matches = new Map<string, string[]>();
  for (const record of records) {
    const marker = decodeMarker(record.description);
    if (marker === null || marker.repo !== context.identity.repo) continue;
    if (!wanted.has(marker.localId)) continue;
    matches.set(marker.localId, [...(matches.get(marker.localId) ?? []), record.externalId]);
  }

  for (const localId of release) {
    const found = matches.get(localId) ?? [];
    if (found.length === 0) continue;
    throw new SyncError(
      "sync.illegal-transition",
      found.length === 1
        ? "--release " + localId + " would discard a proved identity: " + found[0] + " carries this item's correlation marker. This is adoption, not release - re-run without the flag and reconciliation adopts it"
        : "--release " + localId + " would risk a duplicate: " + found.length + " remote issues carry this item's correlation marker; name the right one with --adopt <localId>=<issueUrl|externalId>",
    );
  }

  for (const { local_id: localId } of pending) {
    if (release.has(localId)) {
      releasePendingCreate(db, context, localId);
      continue;
    }
    const found = matches.get(localId) ?? [];
    if (found.length !== 1) {
      report.unresolved.push({
        localId,
        cause:
          found.length === 0
            ? "no remote issue carries this item's correlation marker; the interrupted create is not confirmed either way - if you can confirm the issue is gone, release the residue with --release <localId>, or record the identity with --adopt <localId>=<issueUrl|externalId> when you can see it"
            : found.length + " remote issues carry this item's correlation marker; adopting any of them would be a guess",
      });
      continue;
    }
    const externalId = found[0]!;
    markApplied(db, {
      bindingId: context.bindingId,
      direction: PUSH_DIRECTION,
      localId,
      externalId,
      operationId: "linear-push:" + context.bindingId + ":" + localId + ":adopt:" + externalId,
      ...(context.runId === undefined ? {} : { runId: context.runId }),
    });
    report.adopted.push({ localId, externalId });
  }
  return report;
}

/**
 * Operator-confirmed adoption ('--adopt <localId>=<issueUrl|externalId>'): the
 * row takes the identity verbatim and FORGETS the proof that belonged to any
 * previous identity.
 *
 * An existing row's payload hash and label ownership describe the issue that row
 * pointed at. Carrying them onto a DIFFERENT issue makes the skip rule match
 * content the new remote never received (the run would report 'skipped' without
 * writing) and lets a later kind change remove a label recorded for the previous
 * issue. So a changed identity clears both, and content converges on the next
 * plan of the same run. Re-confirming the id already recorded is not a change:
 * that hash and that ownership still describe the same remote issue, so they
 * stay — clearing them would let the update add the new kind label while leaving
 * the recorded one behind, unowned and unremovable.
 *
 * Replacing an ESTABLISHED identity is refused unless the operator forces it
 * ('--force-adopt'): the recorded id is a fact an earlier confirmed write proved,
 * and a mistaken edit would silently leave that remote issue behind.
 *
 * The existing row decides the composition, because the ambiguous residue this
 * recovery exists for is a 'pending' row and the ledger has no edge from
 * 'pending':
 * - absent or retryable ('failed') → the ledger opens the cycle, then
 *   'markApplied' closes it;
 * - already 'pending' or 'applied' → the confirmed identity is applied directly.
 */
export function adoptItem(
  db: StoreDb,
  bindingId: string,
  localId: string,
  reference: string,
  options: { force?: boolean; runId?: string } = {},
): SyncItem {
  const externalId = externalIdOf(reference);
  const existing = readItem(db, { bindingId, direction: PUSH_DIRECTION, localId });
  const conflict = identityConflict(existing, localId, externalId);
  if (conflict !== null && options.force !== true) throw conflict;
  // why: The row's revision is the generation this adoption is applied OVER, and it
  // joins the operation id. Going back to an issue this row held earlier repeats
  // every other fact of the adoption that first recorded it (same binding, local
  // id, external id, 'clearProof'), so without it that receipt is replayed —
  // 'markApplied' never runs and the row stays on the id being replaced while the
  // caller reports the new one. The revision advances on every apply, so each
  // re-point is a distinct operation.
  const generation = existing?.revision ?? 0;
  if (existing === null || existing.itemState === "failed") {
    openLedgerCycle(db, {
      bindingId,
      direction: PUSH_DIRECTION,
      localId,
      externalId,
      operationId: "linear-push:" + bindingId + ":" + localId + ":adopt-plan:" + externalId + ":" + generation,
      ...(options.runId === undefined ? {} : { runId: options.runId }),
    });
  }
  // Re-confirming the recorded id is not an identity change: its hash and label
  // ownership still describe this same remote issue.
  const keepProof = existing?.externalId === externalId;
  return markApplied(db, {
    bindingId,
    direction: PUSH_DIRECTION,
    localId,
    externalId,
    // why: Cleared, not carried: see the docstring above. 'clearProof' is the only
    // way to say "this identity has no proof yet", because an omitted hash
    // means "keep the row's".
    ...(keepProof ? {} : { clearProof: true as const }),
    // A confirm and a re-point are different requests, so they cannot share one
    // receipt; re-reading the SAME receipt would refuse the second as a conflict.
    // Only a re-point needs the generation: going back to an issue this row held
    // earlier repeats every other fact of the adoption that first recorded it.
    operationId:
      "linear-push:" + bindingId + ":" + localId + ":" + (keepProof ? "adopt-confirm" : "adopt-apply") + ":" + externalId +
      (keepProof ? "" : ":" + generation),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
  });
}

/**
 * The '--adopt' replacement refusal, or null when this adoption is allowed
 * without '--force-adopt'. Shared by the write path and the pre-write preflight,
 * so a run never starts writing against an adoption it will refuse.
 */
export function identityConflict(
  existing: SyncItem | null,
  localId: string,
  externalId: string,
): SyncError | null {
  if (existing === null || existing.externalId === null || existing.externalId === externalId) return null;
  return new SyncError(
    "sync.identity-conflict",
    "this item is already adopted as " + JSON.stringify(existing.externalId) +
      ", and replacing an established remote identity is not an ordinary edit. Re-run with --force-adopt " + localId +
      " if " + JSON.stringify(externalId) + " is the right issue; nothing was written.",
  );
}

/**
 * A 'linear.app' issue URL's last path segment is the identifier; anything else
 * is taken verbatim. A URL from another host is refused rather than mined for a
 * guess.
 */
export function externalIdOf(reference: string): string {
  const raw = reference.trim();
  if (raw === "") {
    throw new Error("[sync.invalid-input] the adopted reference is empty; pass <localId>=<issueUrl|externalId>");
  }
  if (!/^https?:\/\//i.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("[sync.invalid-input] " + raw + " is not a parseable URL; pass a linear.app issue URL or the issue identifier");
  }
  if (url.hostname !== "linear.app" && !url.hostname.endsWith(".linear.app")) {
    throw new Error("[sync.invalid-input] " + url.hostname + " is not a Linear host; pass a linear.app issue URL or the issue identifier");
  }
  // why: A Linear issue URL is '/<workspace>/issue/<identifier>/<slug…>': the
  // identifier follows 'issue', and the trailing slug is not it.
  const segments = url.pathname.split("/").filter((part) => part !== "");
  const issueAt = segments.indexOf("issue");
  const identifier = issueAt === -1 ? undefined : segments[issueAt + 1];
  if (identifier === undefined) {
    throw new Error("[sync.invalid-input] " + raw + " is not a Linear issue URL (expected /<workspace>/issue/<identifier>/...); pass the issue identifier instead");
  }
  return identifier;
}
