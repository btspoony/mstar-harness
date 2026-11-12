/**
 * issue-sync/push.ts — the one-way push direction over the sync ledger.
 *
 * What this module owns, and what it deliberately refuses to claim:
 *
 * - CANDIDATES are the bound project's local issues (`provider = 'local'`).
 *   Each is normalized through the shared field mapping into one provider
 *   payload and hashed. The hash is the SKIP RULE — equal hash means the remote
 *   content is already what local says, so nothing is written. It is NOT an
 *   exactly-once proof: the hash is computed from local content, and only a
 *   confirmed receipt (or an operator `--adopt`) ever records an external id.
 * - A CONFIRMED create/update is the only thing that writes `external_id`.
 *   `ambiguous` leaves the row `pending` with no id: the caller must reconcile.
 * - AMBIGUOUS CREATE RECOVERY is marker equality, never prose. Every pushed
 *   description ends with `<!-- mstar-sync: <workspace>/<team>/<storeId>/<localId> -->`;
 *   the store id is the pushing store's random `store_meta.store_id`, so two
 *   harness stores mirroring one team never adopt each other's rows. A unique
 *   title+description match proves nothing about ownership and is never adopted.
 * - The listing is used ONLY for reconciliation. A run with no ambiguous
 *   residue issues zero listing calls.
 *
 * THE RUN LEASE IS NOT CONCURRENCY. `mstar issue-sync push` holds one lease per
 * binding (`sync_runs`), and every ledger write this module performs carries the
 * run token, so a run that a `--take-run` predecessor replaced has its later
 * writes refused (`sync.run-taken`) instead of applied. What that buys is
 * bounded, and the bound is the honest claim:
 * - No RUNNING `push`'s create can be in flight beside this one's, because only
 *   one run holds the direction.
 * - A request already SENT by a holder that died mid-call may still land at the
 *   provider after the successor has scanned. Nothing here can recall it, which
 *   is why reconcile-by-correlation-marker remains the FIRST recovery and why a
 *   `pending` residue is never created over.
 * - Taking the run over from a LIVE holder is unsafe: the takeover cannot stop
 *   the predecessor's in-flight write, only its later ones. `--take-run` is for a
 *   holder the operator confirmed is dead.
 *
 * Credential-free by construction: the provider is injected and carries its own
 * transport; nothing here reads a token.
 */
import { createHash } from "node:crypto";
import type { StoreDb } from "../store-db.js";
import type { Disposition, IssueKind, Severity } from "../issue.js";
import type { LinearFacetMapping } from "../mstarc.js";
import { SyncError, claimItem, markApplied, markFailed, markUnconfirmed, planItem, readItem, recordRefusal, requireRunLease, type SyncItem } from "../issue-sync.js";
import { defaultStateOfDisposition, providerPayloadFields } from "./field-mapping.js";
import type { IssueProvider, ProviderWrite, ProviderWritePayload } from "./provider.js";

/** The only direction this module drives. */
export const PUSH_DIRECTION = "push" as const;

/**
 * The `.mstarc` connection facts the marker is composed from, plus the store
 * identity. `workspace` is omitted from the marker when unset.
 */
export type PushBinding = { workspace: string; team: string };

/** Everything one item push needs that is not local content. */
export type PushContext = {
  /** `"linear:<project_id>"`, the ledger's binding key. */
  bindingId: string;
  binding: PushBinding;
  /** The pushing store's stable identity (`store_meta.store_id`). */
  storeId: string;
  mapping?: LinearFacetMapping;
  /**
   * The label names the workspace really has, discovered once per run. Only a
   * name in this set is ever sent; a mapped name outside it refuses the ITEM.
   */
  labels: ReadonlySet<string>;
  /**
   * The workflow state names the bound team really has, discovered once per
   * run alongside the labels. Push never creates or renames a state, so a
   * mapped name outside it refuses the ITEM here instead of every item failing
   * at the provider.
   */
  states: ReadonlySet<string>;
  /**
   * The run lease this push holds (`RunLease.runId`). Every ledger write this
   * run performs carries it, so a run that `--take-run` replaced mid-flight has
   * its later writes REFUSED (`sync.run-taken`) instead of applied — the lease
   * check at acquisition cannot cover a write the predecessor had not made yet.
   * Omitted by a caller with no lease, which is the same path import takes.
   */
  runId?: string;
};

export type PushOutcomeKind = "created" | "updated" | "skipped" | "unresolved" | "failed";

export type PushOutcome = {
  localId: string;
  outcome: PushOutcomeKind;
  externalId: string | null;
  /** Credential-free cause for `unresolved` / `failed`. */
  cause?: string;
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
 * The bound project's pushable issues: local captures, never imported mirrors.
 * An imported row's `provider` is `linear`, so the import direction can never
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

/** `"<provider>:<project_id>"` → the store project id (`sync.invalid-input` otherwise). */
function projectIdOf(bindingId: string): string {
  const prefix = "linear:";
  if (typeof bindingId !== "string" || !bindingId.startsWith(prefix) || bindingId.length === prefix.length) {
    throw new Error(`[sync.invalid-input] bindingId must be "linear:<project_id>"; push drives one Linear binding`);
  }
  return bindingId.slice(prefix.length);
}

/**
 * The mstar-owned correlation marker. Application identity only: no token, no
 * path, nothing that exists solely on this machine.
 */
export function correlationMarker(binding: PushBinding, storeId: string, localId: string): string {
  const parts = [binding.workspace, binding.team, storeId, localId].filter((part) => part.trim() !== "");
  return `<!-- mstar-sync: ${parts.join("/")} -->`;
}

/**
 * The marker one description carries, or null when it carries none. The LAST
 * match wins: a description that quotes a marker in operator text must not let
 * the quoted occurrence decide the identity.
 */
function markerIn(description: string): string | null {
  let last: string | null = null;
  for (const match of description.matchAll(/<!--\s*mstar-sync:\s*([^\n]*?)\s*-->/g)) {
    last = `<!-- mstar-sync: ${match[1]!.trim()} -->`;
  }
  return last;
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
 * The send-right key for one create: binding, item and content hash.
 *
 * Deliberately NOT keyed on the ledger revision, which every refusal, failure
 * and apply advances. Revision keying existed only to discriminate attempts by
 * making a bypass mint a different key — and it could not cover the window where
 * the predecessor's own claim advanced it, which is the wedge three review rounds
 * found. The run lease is what separates RUNNING attempts now, so
 * the key is a stable per-residue identity: a re-run of the same item can never
 * mint a new key mid-attempt, and `claimItem` re-opens the cycle under this same
 * key when the previous attempt ended.
 */
function createClaimId(bindingId: string, localId: string, hash: string): string {
  return `linear-push:${bindingId}:${localId}:create:${hash}`;
}

/** Markdown description: the two local sections that have no remote field, then the marker. */
function descriptionFor(candidate: PushCandidate, marker: string): string {
  return `## Impact\n\n${candidate.impact}\n\n## Acceptance\n\n${candidate.acceptance}\n\n${marker}`;
}

/**
 * Push one item and record exactly what the receipt proved.
 *
 * Ledger protocol (contract §"Ledger protocol"), by the row's state:
 * - no row → `claimItem` (pending, send right) → create
 * - `failed` without an id → claim the retry, then create (only a refusal or a
 *   pre-send refusal writes `failed`, so delivery was never confirmed)
 * - `pending` without an id → unresolved: reconcile first; without an adoption
 *   this run reports `unresolved` and NEVER creates. This guard runs BEFORE any
 *   current-attempt preflight: a label failure now says nothing about whether
 *   the earlier request was delivered.
 * - `applied` with an id and an equal hash → `skipped`, zero write calls
 * - otherwise (an id exists) → update
 */
export async function pushItem(db: StoreDb, provider: IssueProvider, context: PushContext, candidate: PushCandidate): Promise<PushOutcome> {
  const ledger = readItem(db, { bindingId: context.bindingId, direction: PUSH_DIRECTION, localId: candidate.localId });
  const externalId = ledger?.externalId ?? null;
  // A `pending` row with no id is the residue of a create nobody confirmed. Its
  // state is the ONLY record that a remote issue may exist, so a refusal later
  // in this attempt must not consume it (see `failed`).
  const ambiguousResidue = externalId === null && ledger?.itemState === "pending";
  if (ambiguousResidue) {
    // An unresolved create. Adopting it is reconcile's job; creating again
    // could duplicate the remote issue, which is the one thing this direction
    // must never do. Checked before the label preflight so a preflight failure
    // for THIS attempt cannot erase a historical ambiguity. When the operator's
    // own reconcile scan finds no match, `--release <localId>` clears the row to
    // the retryable `failed` edge, which is the one exit for proven absence.
    //
    // Nothing lifts this guard. The lease means no RUNNING create can be in
    // flight beside this one, so the row is a CRASHED attempt's residue — and a
    // request that crashed attempt already sent may still land, so no flag can
    // assert that no remote issue exists, which is the only thing that would
    // make a second create safe.
    return {
      localId: candidate.localId,
      outcome: "unresolved",
      externalId: null,
      cause:
        "a previous create was never confirmed; the next run reconciles it by correlation marker, or name its remote issue with --adopt <localId>=<issueUrl|externalId>. When that scan finds no match, --release <localId> releases the residue so the next push may create",
    };
  }
  const marker = correlationMarker(context.binding, context.storeId, candidate.localId);
  const fields = providerPayloadFields(candidate, context.mapping);
  const payload: ProviderWritePayload = {
    title: candidate.title,
    description: descriptionFor(candidate, marker),
    priority: fields.priority,
    state: fields.state,
    labels: [fields.label],
  };
  const hash = requestHash(payload);

  // The skip rule comes FIRST. When the ledger already proves the remote says
  // exactly this, nothing will be written — so a label or state that has since
  // left the workspace must not turn that into a `failed` row, which would
  // overwrite the applied row with an error it never earned.
  if (externalId !== null && ledger?.itemState === "applied" && ledger.lastRequestHash === hash) {
    return { localId: candidate.localId, outcome: "skipped", externalId };
  }
  // Both mapped names are resolved against what the workspace HAS, before the
  // call. Push never creates a provider label or state, so an absent name
  // refuses this item only — and a renamed workflow state is diagnosed here
  // instead of failing every item at the provider.
  if (!context.states.has(fields.state)) {
    // The mapping key is the DEFAULT REMOTE name (`Canceled`), not the local
    // disposition: that is the key `stateOfDisposition` reads. `waived`,
    // `duplicate` and `superseded` all collapse onto it, so the message says so
    // instead of naming a key nobody reads.
    const mappingKey = defaultStateOfDisposition(candidate.disposition);
    return failed(
      db,
      context,
      candidate.localId,
      "linear.state-unresolved",
      `the team has no workflow state named ${JSON.stringify(fields.state)}; push never creates states. Create or rename it in Linear's workflow settings, or redirect it through [linear.mapping] disposition.${mappingKey}=<name>${mappingKey === candidate.disposition ? "" : ` (keyed by the default target, which ${candidate.disposition} maps to)`}.`,
      ledger,
      undefined,
    );
  }
  if (!context.labels.has(fields.label)) {
    return failed(
      db,
      context,
      candidate.localId,
      "linear.label-unresolved",
      `the workspace has no label named ${JSON.stringify(fields.label)}; push never creates labels. Create it in Linear's UI, or redirect it through [linear.mapping] kind.${candidate.kind}=<name>.`,
      ledger,
      undefined,
    );
  }
  if (externalId !== null) {
    // A changed kind replaces EXACTLY the labels this tool may own. An
    // unconfirmed earlier update can leave more than one of them on the remote,
    // so every recorded label except the desired one is removed (removing an
    // absent label is a no-op). Unknown ownership (none recorded) only adds.
    const recorded = ledger?.lastKindLabels ?? [];
    const stale = recorded.filter((label) => label !== fields.label);
    if (stale.length > 0) payload.removeLabels = stale;
    return apply(db, provider, context, candidate.localId, { kind: "update", externalId, payload }, hash, fields.label, ledger);
  }

  // No row or a retryable failure: this is a create. Intent is recorded BEFORE
  // the write so an ambiguous result leaves a durable residue to reconcile
  // against.
  //
  // The claim is the intent record, not the concurrency arbiter: the run lease
  // means no RUNNING second run exists to race this create, so the key is a
  // stable per-residue identity — binding, item, content — and a re-run of the
  // same item opens the cycle under that same key rather than minting a new one.
  // A `pending` claim is still refused here (the residue guard above answers
  // first), so a crashed attempt's send right is never
  // silently taken twice.
  const claim = claimItem(db, {
    bindingId: context.bindingId,
    direction: PUSH_DIRECTION,
    localId: candidate.localId,
    operationId: createClaimId(context.bindingId, candidate.localId, hash),
    ...(context.runId === undefined ? {} : { runId: context.runId }),
  });
  if (!claim.claimed) {
    return {
      localId: candidate.localId,
      outcome: "unresolved",
      externalId: claim.item.externalId,
      cause: "this create could not take the send right; the ledger's row decides the outcome and reconciliation resolves it",
    };
  }
  return apply(db, provider, context, candidate.localId, { kind: "create", payload }, hash, fields.label, ledger);
}

/** Send one write and record its classification; the row's identity comes only from `confirmed`. */
async function apply(
  db: StoreDb,
  provider: IssueProvider,
  context: PushContext,
  localId: string,
  write: ProviderWrite,
  hash: string,
  kindLabel: string,
  ledger: SyncItem | null,
): Promise<PushOutcome> {
  const entryRevision = ledger?.revision ?? 0;
  const opId = (step: string): string => `linear-push:${context.bindingId}:${localId}:${step}:${hash}:${entryRevision}`;
  // Checked BEFORE the request leaves as well as inside each ledger write below:
  // a run that `--take-run` has already replaced sends nothing further, so only a
  // request that was already in flight when the takeover landed can still arrive
  // at the provider. Nothing is compared for a caller with no lease.
  requireRunLease(db, { bindingId: context.bindingId, direction: PUSH_DIRECTION, runId: context.runId });
  const receipt = await provider.applyWrite(write);

  if (receipt.kind === "refused") {
    // Provably not delivered: safe to retry, so it is written as `failed`. The
    // row is re-read because a create's intent was just planned above.
    const current = readItem(db, { bindingId: context.bindingId, direction: PUSH_DIRECTION, localId }) ?? ledger;
    return failed(db, context, localId, receipt.code, receipt.cause, current, hash);
  }
  if (receipt.kind === "ambiguous") {
    if (write.kind === "create") {
      // Deliberately NO ledger write: the row keeps its (absent) identity as
      // `pending` residue, and the next run decides by marker, never by guesswork.
      // That residue is also why the next run cannot create at all until
      // reconcile attributes it (see `pushItem`'s guard).
      return { localId, outcome: "unresolved", externalId: null, cause: receipt.cause };
    }
    // An update the remote did not confirm: the identity stands, but the payload
    // proof does not. Dropping the hash is what stops the next pass from
    // reporting `skipped` off a fact that predates this write; the label this
    // write may have applied becomes the ownership a corrective update replaces.
    markUnconfirmed(db, {
      bindingId: context.bindingId,
      direction: PUSH_DIRECTION,
      localId,
      kindLabel,
      operationId: opId("unconfirmed"),
      ...(context.runId === undefined ? {} : { runId: context.runId }),
    });
    return { localId, outcome: "unresolved", externalId: ledger?.externalId ?? null, cause: receipt.cause };
  }
  markApplied(db, {
    bindingId: context.bindingId,
    direction: PUSH_DIRECTION,
    localId,
    externalId: receipt.externalId,
    remoteUpdatedAt: receipt.updatedAt,
    requestHash: hash,
    kindLabel,
    operationId: opId("applied"),
    ...(context.runId === undefined ? {} : { runId: context.runId }),
  });
  return { localId, outcome: write.kind === "create" ? "created" : "updated", externalId: receipt.externalId };
}

/**
 * Record a refusal (or a pre-send refusal) on the item.
 *
 * Best-effort by design: the run's report is the record of what happened, and a
 * ledger refusal here must not mask the cause that produced it. Only a genuine
 * ledger conflict reaches the catch now that every state takes a legal verb.
 *
 * A row that already holds an identity or a settled state (`applied`, `failed`,
 * `skipped`) must NOT take the `failed` edge: `applied → failed` is not in the
 * contract, and the row's identity, hash and ownership are facts an earlier
 * confirmed write proved. A refused UPDATE therefore leaves the row `applied`
 * WITH its cause recorded, and the changed hash still makes the next run retry
 * the write. `recordRefusal` is that error-only verb.
 *
 * A `pending` row with no id never reaches here: `pushItem`'s residue guard
 * answers first, because `failed` is invisible to `reconcilePendingCreate` and
 * downgrading the residue would let a later run create a duplicate nobody can
 * adopt.
 */
function failed(
  db: StoreDb,
  context: PushContext,
  localId: string,
  code: string,
  cause: string,
  ledger: SyncItem | null,
  hash?: string,
): PushOutcome {
  const message = `[${code}] ${cause}`;
  try {
    // An item that never reached the ledger still gets a row here, so the
    // operator can SEE why it is not pushed; `failed → pending` is a legal retry
    // edge, so the next run tries again once the cause is addressed.
    if (ledger === null) {
      planItem(db, {
        bindingId: context.bindingId,
        direction: PUSH_DIRECTION,
        localId,
        operationId: `linear-push:${context.bindingId}:${localId}:plan:preflight`,
        ...(context.runId === undefined ? {} : { runId: context.runId }),
      });
    }
    const current = ledger ?? readItem(db, { bindingId: context.bindingId, direction: PUSH_DIRECTION, localId });
    if (current !== null) {
      // `markFailed` is the retry edge and is legal only from `pending`.
      const retryable = current.itemState === "pending";
      const step = retryable ? "failed" : "refused";
      const operationId = `linear-push:${context.bindingId}:${localId}:${step}:${hash ?? "preflight"}:${current.revision}`;
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
    if (error instanceof SyncError && error.code === "sync.run-taken") throw error;
    // The returned outcome still carries the cause.
  }
  return { localId, outcome: "failed", externalId: ledger?.externalId ?? null, cause: message };
}

export type ReconcileReport = {
  /** Rows adopted this run, with the identity marker equality proved. */
  adopted: Array<{ localId: string; externalId: string }>;
  /** Rows that could not be attributed to exactly one remote issue. */
  unresolved: Array<{ localId: string; cause: string }>;
  /**
   * The page bound the scan stopped at, set only when it stopped with a cursor
   * still advertised. Present means the listing was NOT read to its end.
   */
  stoppedAtPageBound?: number;
};

/**
 * The reason a release records: the operator's judgement in the one state the
 * ledger cannot decide, stated as such so it is never read as a failed attempt.
 */
const RELEASE_REASON =
  "released by the operator after reconciliation's full listing scan found no remote issue carrying this item's correlation marker; the next push may create";

/**
 * A `pending` row with no id can be released only by the operator, and only
 * from the scan that proved absence: `failed` is the ledger's retryable edge, so
 * the next push claims the create again. The revision joins the operation id so
 * a later ambiguity for the same item is a new release, not a replay.
 *
 * What the release CANNOT do is see a request another holder already sent: this
 * run holds the binding's only lease, so no RUNNING create for that residue can
 * be inside a provider call beside it — but a create sent by a holder that died
 * mid-call may still land after this scan. That is why reconcile-by-marker is
 * the first recovery and why releasing over a scan that found nothing is the
 * operator's judgement, recorded as such. The write carries this run's token, so
 * a run a takeover replaced cannot release anything at all.
 */
function releasePendingCreate(db: StoreDb, context: PushContext, localId: string): void {
  const current = readItem(db, { bindingId: context.bindingId, direction: PUSH_DIRECTION, localId });
  markFailed(db, {
    bindingId: context.bindingId,
    direction: PUSH_DIRECTION,
    localId,
    error: RELEASE_REASON,
    operationId: `linear-push:${context.bindingId}:${localId}:release:${current?.revision ?? 0}`,
    ...(context.runId === undefined ? {} : { runId: context.runId }),
  });
}

/**
 * Only the row shape a release exists for can be released. Anything else is an
 * operator error about the ledger, reported before the scan and any write — and
 * the command calls this before its own first write, so a bad `--release` cannot
 * land after an `--adopt` already did.
 */
export function assertReleaseTargets(db: StoreDb, bindingId: string, release: ReadonlySet<string>): void {
  for (const localId of release) {
    const item = readItem(db, { bindingId, direction: PUSH_DIRECTION, localId });
    if (item === null || item.itemState !== "pending" || item.externalId !== null) {
      throw new SyncError(
        "sync.illegal-transition",
        `--release ${localId} names no unresolved create: ` +
          (item === null
            ? "the item has no push ledger row"
            : `its row is '${item.itemState}'${item.externalId === null ? "" : ` as ${item.externalId}`}`) +
          "; release clears only a pending create with no remote id - name a known issue with --adopt, and let every other item push normally",
      );
    }
  }
}

/**
 * Adopt ambiguous creates by correlation marker.
 *
 * Runs a listing scan and adopts a row ONLY when exactly one remote issue
 * carries its exact marker. Zero or several matches stay `unresolved`; this
 * function never creates, and prose equality is never evidence.
 *
 * `options.maxPages` bounds the scan, and the caller passes the SAME number the
 * import direction stops at: engine does not own that default, so the two cannot
 * drift. A scan still holding a cursor at that bound is NOT a full listing, so
 * `stoppedAtPageBound` names it, an unmatched row's cause says the listing was
 * truncated instead of claiming absence, and a release is refused — "the scan
 * found nothing" is the one thing a truncated scan has not proved.
 *
 * `options.release` names `pending`-without-id rows the operator has released
 * after this same scan found nothing: they drop to `failed`, the retryable edge,
 * so the next push may create. A release is REFUSED when reconciliation found a
 * match — that row's recovery is adoption, or `--adopt` naming the right issue —
 * and the refusal is decided over the whole scan before the first write.
 *
 * A run with no ambiguous residue short-circuits: zero listing calls.
 */
export async function reconcilePendingCreate(
  db: StoreDb,
  provider: IssueProvider,
  context: PushContext,
  options: { release?: ReadonlySet<string>; maxPages: number },
): Promise<ReconcileReport> {
  const maxPages = options.maxPages;
  const release = options.release ?? new Set<string>();
  assertReleaseTargets(db, context.bindingId, release);
  const pending = db
    .prepare(
      "select local_id from issue_sync_state where binding_id = ? and direction = ? and item_state = 'pending' and external_id is null",
    )
    .all(context.bindingId, PUSH_DIRECTION) as Array<{ local_id: string }>;
  const report: ReconcileReport = { adopted: [], unresolved: [] };
  if (pending.length === 0) return report;

  const wanted = new Map<string, string>();
  for (const { local_id: localId } of pending) {
    wanted.set(correlationMarker(context.binding, context.storeId, localId), localId);
  }
  const matches = new Map<string, string[]>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await provider.listIssues(cursor);
    pages += 1;
    for (const item of page.items) {
      const marker = markerIn(item.description);
      if (marker === null) continue;
      const localId = wanted.get(marker);
      if (localId === undefined) continue;
      matches.set(localId, [...(matches.get(localId) ?? []), item.externalId]);
    }
    cursor = page.nextCursor;
  } while (cursor !== null && pages < maxPages);
  if (cursor !== null) report.stoppedAtPageBound = maxPages;
  const truncated = cursor !== null;

  // A match is evidence of an identity, so releasing over it would discard what
  // the scan just proved. Decided over the whole scan, before any adoption write.
  for (const localId of release) {
    const found = matches.get(localId) ?? [];
    if (found.length === 0) {
      if (!truncated) continue;
      throw new SyncError(
        "sync.illegal-transition",
        `--release ${localId} needs a listing scan that was read to its end, and this one stopped at ${maxPages} pages with more advertised; the marker may sit on a page never read, so absence is not proved and nothing was written - re-run push when the listing fits the bound`,
      );
    }
    throw new SyncError(
      "sync.illegal-transition",
      found.length === 1
        ? `--release ${localId} would discard a proved identity: ${found[0]} carries this item's correlation marker. This is adoption, not release - re-run push without the flag and reconcile adopts it`
        : `--release ${localId} would risk a duplicate: ${found.length} remote issues carry this item's correlation marker; name the right one with --adopt <localId>=<issueUrl|externalId>`,
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
          found.length > 0
            ? `${found.length} remote issues carry this item's correlation marker; adopting any of them would be a guess`
            : truncated
              ? `the reconcile listing stopped at its ${maxPages}-page bound with more pages advertised, so this item's marker was never ruled out - re-run push to scan again; --release is refused while the scan is truncated`
              : "no remote issue carries this item's correlation marker; the interrupted create is not confirmed either way - if you can establish the remote absence yourself, re-run push with --release <localId>",
      });
      continue;
    }
    const externalId = found[0]!;
    markApplied(db, {
      bindingId: context.bindingId,
      direction: PUSH_DIRECTION,
      localId,
      externalId,
      operationId: `linear-push:${context.bindingId}:${localId}:adopt:${externalId}`,
      ...(context.runId === undefined ? {} : { runId: context.runId }),
    });
    report.adopted.push({ localId, externalId });
  }
  return report;
}

/**
 * Operator-confirmed adoption (`--adopt <localId>=<issueUrl|externalId>`): the
 * row takes the identity verbatim and FORGETS the proof that belonged to any
 * previous identity.
 *
 * An existing row's payload hash and label ownership describe the issue that row
 * pointed at. Carrying them onto a DIFFERENT issue makes the skip rule match
 * content the new remote never received (the run would report `skipped` without
 * writing) and lets a later kind change remove a label recorded for the previous
 * issue. So a changed identity clears both, and content converges on the next
 * push of the same run. Re-confirming the id already recorded is not a change:
 * that hash and that ownership still describe the same remote issue, so they
 * stay — clearing them would let the update add the new kind label while leaving
 * the recorded one behind, unowned and unremovable.
 *
 * Replacing an ESTABLISHED identity is refused unless the operator forces it
 * (`--force-adopt`): the recorded id is a fact an earlier confirmed write proved,
 * and a mistaken edit would silently leave that remote issue behind.
 *
 * The existing row decides the composition, because the ambiguous residue this
 * recovery exists for is a `pending` row and `planItem` has no edge from
 * `pending`:
 * - absent or retryable (`failed`) → `planItem` opens the cycle, then `markApplied`
 *   closes it;
 * - already `pending` or `applied` → the confirmed identity is applied directly.
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
  // The row's revision is the generation this adoption is applied OVER, and it
  // joins the operation id. Going back to an issue this row held earlier repeats
  // every other fact of the adoption that first recorded it (same binding, local
  // id, external id, `clearProof`), so without it that receipt is replayed —
  // `markApplied` never runs and the row stays on the id being replaced while the
  // caller reports the new one. The revision advances on every apply, so each
  // re-point is a distinct operation.
  const generation = existing?.revision ?? 0;
  if (existing === null || existing.itemState === "failed") {
    planItem(db, {
      bindingId,
      direction: PUSH_DIRECTION,
      localId,
      externalId,
      operationId: `linear-push:${bindingId}:${localId}:adopt-plan:${externalId}:${generation}`,
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
    // Cleared, not carried: see the docstring above. `clearProof` is the only
    // way to say "this identity has no proof yet", because an omitted hash
    // means "keep the row's".
    ...(keepProof ? {} : { clearProof: true as const }),
    // A confirm and a re-point are different requests, so they cannot share one
    // receipt; re-reading the SAME receipt would refuse the second as a conflict.
    // Only a re-point needs the generation: going back to an issue this row held
    // earlier repeats every other fact of the adoption that first recorded it.
    operationId: `linear-push:${bindingId}:${localId}:${keepProof ? "adopt-confirm" : "adopt-apply"}:${externalId}${keepProof ? "" : `:${generation}`}`,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
  });
}

/**
 * The `--adopt` replacement refusal, or null when this adoption is allowed
 * without `--force-adopt`. Shared by the write path and the pre-write preflight,
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
    `this item is already adopted as ${JSON.stringify(existing.externalId)}, and replacing an established remote identity is not an ordinary edit. Re-run with --force-adopt ${localId} if ${JSON.stringify(externalId)} is the right issue; nothing was written.`,
  );
}

/**
 * A `linear.app` issue URL's last path segment is the identifier; anything else
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
    throw new Error(`[sync.invalid-input] ${raw} is not a parseable URL; pass a linear.app issue URL or the issue identifier`);
  }
  if (url.hostname !== "linear.app" && !url.hostname.endsWith(".linear.app")) {
    throw new Error(`[sync.invalid-input] ${url.hostname} is not a Linear host; pass a linear.app issue URL or the issue identifier`);
  }
  // A Linear issue URL is `/<workspace>/issue/<identifier>/<slug…>`: the
  // identifier follows `issue`, and the trailing slug is not it.
  const segments = url.pathname.split("/").filter((part) => part !== "");
  const issueAt = segments.indexOf("issue");
  const identifier = issueAt === -1 ? undefined : segments[issueAt + 1];
  if (identifier === undefined) {
    throw new Error(`[sync.invalid-input] ${raw} is not a Linear issue URL (expected /<workspace>/issue/<identifier>/...); pass the issue identifier instead`);
  }
  return identifier;
}
