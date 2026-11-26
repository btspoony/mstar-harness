/**
 * `ProjectDetail` — identity head, the milestone rollup, and the project's two
 * list features (IA §4).
 *
 * The milestone timeline and its write forms are the screen's default body,
 * read from the project-scoped milestone rollup. The list feature set is
 * **fixed**: Issues, Iterations, in that order, with **Issues the default**.
 * It does not grow, it is not configurable, and it never opens "the first
 * feature that has content": a fixed default keeps every project page the same
 * shape so a reader's memory of the layout transfers between projects, and
 * auto-selection would quietly hide an absence — which is itself a fact (§4).
 *
 * Each feature is scoped to this project. A feature whose attribution is missing
 * renders the not-applicable / absent arm; it must never fall back to the
 * store-wide list, which would be a wrong answer presented as a right one.
 *
 * Not rendered anywhere here: `storeRevision`, `catalogRevision`, `builtAt`,
 * `checkedAt`, the catalog `revision`, `sourceHash`.
 */
import { useEffect, useState } from "react";
import { EmptyState } from "../components/EmptyState.tsx";
import { StatusDot } from "../components/StatusDot.tsx";
import { Tabs, type TabItem } from "../components/Tabs.tsx";
import { TruncatedText } from "../components/TruncatedText.tsx";
import {
  PROJECT_FEATURES,
  type Milestone,
  type MilestonesModel,
  type ProjectFeature,
  type ProjectIdentity,
} from "../view-model/projects.ts";
import type { Resolved } from "../view-model/state.ts";
import { milestoneStatusTone } from "../view-model/status.ts";

/** The closed status set the engine accepts for a milestone patch. */
const MILESTONE_STATUSES = ["planned", "active", "delivered", "dropped"] as const;

/** One open, unassigned issue the assign picker can offer. */
export type AssignableIssue = { id: string; title: string; severity: string; revision: number };

/**
 * The picker's read state. A list is the answered set; the two other arms say
 * why there is no set yet — a read that cannot answer must never look like a
 * project with nothing to assign, and it must not disappear or spin forever.
 */
export type AssignableIssuesRead =
  | readonly AssignableIssue[]
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly reason: string };

/** Whether the picker's read answered with a list (`Array.isArray` cannot narrow a readonly union arm). */
export function isAssignableList(read: AssignableIssuesRead): read is readonly AssignableIssue[] {
  return Array.isArray(read);
}

/**
 * How many assignable issues the host hands the picker. The host applies the
 * same limit to its read, so the picker states the cap instead of truncating
 * silently.
 */
export const ASSIGNABLE_ISSUE_LIMIT = 50;

/**
 * An effort field's text, screened BEFORE any write: empty means unestimated
 * (`null`), a whole number is sent as that number — the engine stays the
 * authority for the range — and anything else is refused locally. A browser
 * `type="number"` input sanitises bad text to an empty value, which would turn
 * garbage into `{ effortSessions: null }` and silently clear the stored
 * estimate, so the raw text is kept in a plain input and screened here.
 */
export function effortInput(value: string): { kind: "empty" } | { kind: "count"; sessions: number } | { kind: "invalid" } {
  const trimmed = value.trim();
  if (trimmed === "") return { kind: "empty" };
  if (!/^[+-]?\d+$/.test(trimmed)) return { kind: "invalid" };
  const sessions = Number(trimmed);
  // safety: a digit string beyond the safe range loses precision to Number() and the
  // browser JSON encoding then sends null, which the engine reads as a
  // legitimate clear — so it must be refused before any write.
  return Number.isSafeInteger(sessions) ? { kind: "count", sessions } : { kind: "invalid" };
}

function effortPatch(milestone: Milestone, value: string): { effortSessions?: number | null } {
  const effort = effortInput(value);
  if (effort.kind === "invalid") return {};
  if (effort.kind === "empty") return milestone.effortSessions === null ? {} : { effortSessions: null };
  return effort.sessions === milestone.effortSessions ? {} : { effortSessions: effort.sessions };
}

/** The draft's touched set with one more field, so a handler records the edit it makes. */
export function withTouched(
  touched: ReadonlySet<MilestoneDraftField>,
  field: MilestoneDraftField,
): ReadonlySet<MilestoneDraftField> {
  const next = new Set(touched);
  next.add(field);
  return next;
}

/** The draft fields an operator can edit; only these travel in a patch. */
export type MilestoneDraftField = "name" | "effort" | "status";

/**
 * One milestone editor's text, as the operator typed it, plus the fields they actually
 * changed. The draft is seeded from the milestone on open, so it holds fields nobody
 * touched: after a conflict refresh those values are stale, and comparing them against
 * the fresh milestone would send a revert of another writer's change.
 */
export type MilestoneDraft = {
  name: string;
  effort: string;
  status: string;
  touched: ReadonlySet<MilestoneDraftField>;
};

/**
 * The draft the editor opens with: seeded from the milestone on EVERY open, so a
 * cancelled edit cannot survive into the next one and emit a stale delta.
 */
export function milestoneDraft(milestone: Milestone): MilestoneDraft {
  return {
    name: milestone.name,
    effort: milestone.effortSessions === null ? "" : String(milestone.effortSessions),
    status: milestone.status ?? "planned",
    touched: new Set(),
  };
}

/** One target's draft text. The editor carries its status too; the create form never sets it. */
export type CreateDraft = {
  name: string;
  effort: string;
  status?: string;
  /** note: the fields the operator edited, so a kept draft can re-open with its intent. */
  touched?: readonly MilestoneDraftField[];
};

/**
 * The draft store the host owns OUTSIDE the read's subtree. The forms live under the
 * milestone read, so a refresh (an accepted write, a revision conflict) unmounts and
 * re-mounts them — a draft held in component state dies with the form, and the
 * operator's typed text is lost exactly when they need it back (the conflict retry).
 * The host holds one entry per target instead: the create form under `create`, each
 * milestone editor under its milestone id. A form seeds its state from the entry on
 * mount and writes every keystroke back, so a re-mounted form opens over the typed
 * values; an ACCEPTED write clears the entry, because the stored milestone is then
 * the truth the editor re-seeds from.
 */
export type MilestoneDraftStore = {
  // note: the stored draft for one target, or undefined when none was typed.
  read(target: string): CreateDraft | undefined;
  // note: merges one field change into the target's draft.
  write(target: string, patch: Partial<CreateDraft>): void;
  // note: drops the target's draft (an accepted write, a cancelled edit).
  clear(target: string): void;
};

/**
 * The draft-store key one form targets: the identity the form was opened over
 * (its project, when the host supplies one) plus its own target — the create
 * slot, or a milestone id. The project belongs IN the key because milestones
 * are globally unique but the create draft is not: a bare `create` re-seeds
 * every project's create form with what was typed in one of them. The key is
 * computed once on the render that receives the identity, never re-derived from
 * the host's CURRENT selection — a late re-read of the selection would relabel
 * an existing draft under a different project and lose the typed text.
 */
export function milestoneDraftTargetKey(projectId: string | undefined, target: string): string {
  return projectId === undefined ? target : `${projectId}:${target}`;
}

/** The store's plain implementation: one record keyed per target. */
export function createMilestoneDraftStore(): MilestoneDraftStore {
  const entries = new Map<string, CreateDraft>();
  return {
    read: (target) => entries.get(target),
    write: (target, patch) => entries.set(target, { ...entries.get(target), ...patch } as CreateDraft),
    clear: (target) => {
      entries.delete(target);
    },
  };
}

/** What Save sends: only the fields whose text differs from the stored milestone. */
export function milestonePatch(
  milestone: Milestone,
  draft: MilestoneDraft,
): { name?: string; effortSessions?: number | null; status?: string } {
  // invariant: only a field the operator touched can travel, and only while its typed value
  // still differs from the milestone the refresh just read — an untouched field is never
  // sent, whatever another writer changed it to.
  const touched = draft.touched;
  return {
    ...(touched.has("name") && draft.name.trim() !== milestone.name ? { name: draft.name.trim() } : {}),
    ...(touched.has("effort") ? effortPatch(milestone, draft.effort) : {}),
    ...(touched.has("status") && draft.status !== milestone.status ? { status: draft.status } : {}),
  };
}

/**
 * The create form's input, screened the same way: a count reaches the channel
 * as that number, an empty field as `null`, and an invalid text refuses the
 * submit instead of being coerced. `0` and negatives ARE whole numbers, so
 * they travel to the engine and ITS range validator refuses them.
 */
export function milestoneCreateInput(
  name: string,
  effort: string,
  nextOrdinal: number,
): { kind: "invalid" } | { kind: "input"; input: { name: string; effortSessions: number | null; ordinal: number } } {
  if (name.trim() === "") return { kind: "invalid" };
  const parsed = effortInput(effort);
  if (parsed.kind === "invalid") return { kind: "invalid" };
  return {
    kind: "input",
    input: { name: name.trim(), effortSessions: parsed.kind === "empty" ? null : parsed.sessions, ordinal: nextOrdinal },
  };
}

/**
 * The ordinal a NEW milestone takes: one past the highest ordinal on the board,
 * and 0 for an empty one. The count is not the answer — deletions leave gaps
 * (ordinals 0, 2), where the count would sort the new milestone alongside or
 * ahead of existing work instead of after it.
 */
export function nextMilestoneOrdinal(milestones: readonly { ordinal: number }[]): number {
  let highest = -1;
  for (const milestone of milestones) if (milestone.ordinal > highest) highest = milestone.ordinal;
  return highest + 1;
}

/**
 * What a settled write does to the operator's draft.
 *
 * The surface's `keepDraft` is the verdict when the host states it: an accepted
 * write clears the draft, a revision conflict keeps it (so the retry carries the
 * typed text), and an input refusal keeps it too. A host that states nothing
 * falls back to the refusal string — `null` means accepted — so an omitted field
 * cannot silently change an existing host's behaviour.
 */
export function draftAfterWrite<T>(
  draft: T,
  write: { readonly refusal: string | null; readonly keepDraft?: boolean },
): T | null {
  return (write.keepDraft ?? write.refusal !== null) ? draft : null;
}

/**
 * The milestone write surface, declared structurally so this screen stays
 * transport-agnostic (the dashboard alignment change, Task 4). Every action
 * is one engine verb — add, update, assign/unassign and remove — and the
 * surface owns the busy/refusal state and the read reload; the screen owns
 * only its control state. Removal is always offered: a milestone that still
 * holds issues is ATTEMPTED and the store's own `milestone.not-empty` refusal
 * surfaces verbatim, rather than being pre-empted by a disabled control.
 */
export type MilestoneWriteSurface = {
  /** True while one write is in flight; every control is disabled. */
  busy: boolean;
  /** The store's own refusal message, verbatim, or `null`. */
  refusal: string | null;
  /**
   * Whether the operator's typed draft survives the write that just settled.
   *
   * The HOST decides this (its conflict policy), not the refusal string: an
   * accepted write clears the draft, while a revision conflict — whose refusal
   * text is present too — keeps it, so the retry still carries the typed text.
   * Omitted, the surface falls back to `refusal === null`, which is the
   * pre-conflict behaviour for a host that cannot distinguish the two.
   */
  keepDraft?: boolean;
  create: (input: { name: string; effortSessions: number | null; ordinal: number }) => void;
  update: (milestoneId: string, patch: { name?: string; effortSessions?: number | null; status?: string }) => void;
  /** `milestoneId: null` is the unassign. */
  assign: (issueId: string, issueRevision: number, milestoneId: string | null) => void;
  /** Remove one milestone; the engine refuses a non-empty one in place. */
  remove: (milestoneId: string) => void;
};

/** Every visible string this screen needs. Task 5 supplies them. */
export type ProjectDetailCopy = {
  breadcrumb: { label: string; trail: string };
  /** The noun after the project's open-issue count. */
  openIssuesUnit: string;
  tabLabel: string;
  /** The fixed list features, in order. `PROJECT_FEATURES` is the id list. */
  features: Record<ProjectFeature, string>;
  milestones: {
    milestonesHeading: string;
    /** The board head's two nouns, which the prototype prints after each count. */
    milestonesUnit: string;
    unassignedUnit: string;
    milestoneOpen: (open: number) => string;
    effort: (sessions: number) => string;
    unestimated: string;
    /** The four tallies of the prototype's board row. */
    countLabels: { open: string; resolved: string; retired: string; total: string };
    unassigned: (count: number) => string;
    /** The trailing timeline node's name for issues with no milestone. */
    timelineUnassigned: string;
    timelineUnassignedIssues: (count: number) => string;
    /** The milestone write controls (plan Task 4). */
    writes: {
      create: string;
      nameLabel: string;
      effortLabel: string;
      effortInvalid: string;
      statusLabel: string;
      edit: string;
      save: string;
      cancel: string;
      assign: string;
      unassign: string;
      /** Said when the picker hit the cap, so the truncation is never silent. */
      assignCap: string;
      /** The picker's read is pending. */
      assignLoading: string;
      /** The picker's read failed; the store's own reason follows. */
      assignFailed: string;
      /** The retry control's word, beside the failure reason. */
      assignRetry: string;
      remove: string;
      removeConfirm: string;
      refusalLead: string;
    };
  };
  /** The scope chip a scoped feature list carries. */
  scope: { label: (projectId: string) => string; clear: string };
  absence: {
    empty: { labelWord: string; heading: string; body: string; hint: string };
    unavailable: { labelWord: string; heading: string; body: string };
    "not-applicable": { labelWord: string; heading: string; body: string };
  };
};

export type ProjectDetailProps = {
  identity: ProjectIdentity;
  /** The selected feature; the host owns the address bar (compass D27). */
  feature: ProjectFeature;
  onFeatureChange: (feature: ProjectFeature) => void;
  /** The milestone body's arm, resolved by `state.ts`/`milestonesArm`. */
  milestones: Resolved<MilestonesModel>;
  /**
   * The two scoped lists, rendered by their own screens. Passing the element keeps
   * this screen out of their state machines and out of a second table.
   */
  issues: React.ReactNode;
  iterations: React.ReactNode;
  /**
   * How many rows each scoped list holds, for the tabs' own counts. The elements above
   * cannot answer this — a rendered node has no length — so the host states it, and an
   * absent count renders no number rather than a wrong one.
   */
  issuesCount?: number;
  iterationsCount?: number;
  copy: ProjectDetailCopy;
  /** The milestone write channel, when the host can write (plan Task 4). */
  writes?: MilestoneWriteSurface;
  /** note: the host-owned draft store; absent, drafts live in component state as before. */
  drafts?: MilestoneDraftStore;
  /** The assign picker's read: the offer list, or the loading/failed arm. */
  assignableIssues?: AssignableIssuesRead;
  /** Re-issue the picker's read after a failure; absent means the host cannot retry. */
  onRetryAssignable?: () => void;
  onBack?: () => void;
  /** Leaving the project's scope — the chip's own affordance. Omitted, there is no chip button. */
  onClearScope?: () => void;
};

/**
 * The assignment picker for one milestone: a native `<details>` whose summary is
 * the control (natively focusable, toggles on Enter/Space and pointer), with one
 * chip per offered issue and the stated cap.
 */
function AssignPicker(props: {
  milestone: Milestone;
  writes: MilestoneWriteSurface;
  assignable: readonly AssignableIssue[];
  copy: ProjectDetailCopy;
}) {
  const { milestone, writes, assignable, copy } = props;
  return (
    <details data-ms-milestone-assign="">
      <summary className={"link"} data-ms-milestone-assign-toggle={milestone.milestoneId}>
        {copy.milestones.writes.assign}
      </summary>
      {assignable.length >= ASSIGNABLE_ISSUE_LIMIT ? (
        <span className="muted t-11" data-ms-assign-cap={ASSIGNABLE_ISSUE_LIMIT}>
          {copy.milestones.writes.assignCap}
        </span>
      ) : null}
      {assignable.map((issue) => (
        <button
          key={issue.id}
          type="button"
          className={"chip"}
          disabled={writes.busy}
          title={issue.title}
          data-ms-assign-issue={issue.id}
          onClick={() => writes.assign(issue.id, issue.revision, milestone.milestoneId)}
        >
          {issue.id}
          <span className="muted"> · {issue.severity}</span>
        </button>
      ))}
    </details>
  );
}

/** The milestone board's inline write controls for one milestone (plan Task 4). */
function MilestoneActions(props: {
  milestone: Milestone;
  writes: MilestoneWriteSurface;
  /** The picker's read; absent means this host offers no picker here. */
  assignable: AssignableIssuesRead | undefined;
  /** Re-issue the picker's read; absent means this host cannot retry. */
  onRetryAssignable?: () => void;
  copy: ProjectDetailCopy;
  /** note: the host-owned draft store (absent: drafts live in component state, as before). */
  drafts?: MilestoneDraftStore;
  /** note: the identity the host opened this page over — it scopes every draft key. */
  draftsProject?: string;
}) {
  const { milestone, writes, assignable, copy } = props;
  // why: the key the host scoped to this page's identity — milestone ids are globally
  // unique, but the key still comes from the identity the form was opened over, never the
  // host's current selection at read time.
  const targetKey = milestoneDraftTargetKey(props.draftsProject, milestone.milestoneId);
  // invariant: one state, the OPEN draft — `null` is the closed editor. Seeded from the
  // host's store when it holds one for this milestone (a re-mount after a refresh), else
  // closed; a cancelled edit clears the entry, so the next open re-seeds from the milestone.
  const [draft, setDraftState] = useState<MilestoneDraft | null>(() => {
    const kept = props.drafts?.read(targetKey);
    // invariant: a re-mounted editor shows the FRESH milestone for every field the operator did
    // not touch — a stale displayed value would silently win over a status another writer changed —
    // and keeps only the fields they did touch, so a retry still sends exactly their edits.
    if (kept === undefined) return null;
    const touched = new Set(kept.touched ?? []);
    const fresh = milestoneDraft(milestone);
    return {
      name: touched.has("name") ? kept.name : fresh.name,
      effort: touched.has("effort") ? kept.effort : fresh.effort,
      status: touched.has("status") ? (kept.status ?? fresh.status) : fresh.status,
      touched,
    };
  });
  // why: the host store shadows the component state — a refresh unmounts this editor and
  // the re-mounted one seeds from the store, so the typed text survives. The sync is an
  // effect (not the state setter), because a state updater must stay pure.
  useEffect(() => {
    if (props.drafts === undefined) return;
    if (draft === null) props.drafts.clear(targetKey);
    else
      props.drafts.write(targetKey, {
        name: draft.name,
        effort: draft.effort,
        status: draft.status,
        touched: [...draft.touched],
      });
  }, [draft, props.drafts, targetKey]);
  const setDraft = setDraftState;
  const [removing, setRemoving] = useState(false);
  const [effortError, setEffortError] = useState(false);
  // why: the surface's keepDraft verdict (its host's conflict policy), not the submit itself,
  // decides whether the draft closes — an accepted write clears it, a revision conflict keeps it.
  const [writeInFlight, setWriteInFlight] = useState(false);
  useEffect(() => {
    if (!writeInFlight || writes.busy) return;
    setWriteInFlight(false);
    setDraft((current) => (current === null ? null : draftAfterWrite(current, writes)));
  });
  if (draft === null) {
    return (
      <span className={"ms-actions"}>
        <button
          type="button"
          className={"link"}
          disabled={writes.busy}
          data-ms-milestone-edit=""
          onClick={() => {
            // why: a reopened editor never shows a verdict about a value it no longer holds
            setEffortError(false);
            setDraft(milestoneDraft(milestone));
          }}
        >
          {copy.milestones.writes.edit}
        </button>
        {removing ? (
          // A two-step inline confirm: the attempt is real, so a non-empty
          // milestone's refusal surfaces verbatim after it (plan Task 4 round 2).
          <span data-ms-milestone-remove-confirm={milestone.milestoneId}>
            <span className="muted t-11">{copy.milestones.writes.removeConfirm}</span>
            <button
              type="button"
              className={"link"}
              disabled={writes.busy}
              data-ms-milestone-remove={milestone.milestoneId}
              onClick={() => {
                setRemoving(false);
                writes.remove(milestone.milestoneId);
              }}
            >
              {copy.milestones.writes.remove}
            </button>
            <button type="button" className={"link"} disabled={writes.busy} onClick={() => setRemoving(false)}>
              {copy.milestones.writes.cancel}
            </button>
          </span>
        ) : (
          <button type="button" className={"link"} disabled={writes.busy} data-ms-milestone-remove="" onClick={() => setRemoving(true)}>
            {copy.milestones.writes.remove}
          </button>
        )}
        {assignable === undefined ? null : isAssignableList(assignable) ? (
          assignable.length === 0 ? null : (
            <AssignPicker milestone={milestone} writes={writes} assignable={assignable} copy={copy} />
          )
        ) : assignable.kind === "failed" ? (
          // A failed read is stated IN PLACE: the picker must not vanish (an entry the
          // operator cannot find reads as "nothing to assign") and a retry must exist.
          <span className={"inline-write-error"} role="alert" data-ms-assign-error="">
            <span className="muted t-11">
              {copy.milestones.writes.assignFailed} {assignable.reason}
            </span>
            {props.onRetryAssignable === undefined ? null : (
              <button type="button" className={"link"} disabled={writes.busy} data-ms-assign-retry="" onClick={props.onRetryAssignable}>
                {copy.milestones.writes.assignRetry}
              </button>
            )}
          </span>
        ) : (
          // A pending read says so instead of pretending the set is empty.
          <span className="muted t-11" data-ms-assign-loading="">
            {copy.milestones.writes.assignLoading}
          </span>
        )}
      </span>
    );
  }
  return (
    <form
      className={"ms-edit"}
      data-ms-milestone-edit-form={milestone.milestoneId}
      onSubmit={(event) => {
        event.preventDefault();
        if (effortInput(draft.effort).kind === "invalid") {
          setEffortError(true);
          return;
        }
        setEffortError(false);
        const patch = milestonePatch(milestone, draft);
        // why: nothing the operator edited still differs from the milestone a refresh just read, so
        // there is nothing to write — submitting an empty patch would be refused and look like a
        // failure to the operator who only retried an edit another writer already applied.
        if (Object.keys(patch).length === 0) {
          setDraft(null);
          return;
        }
        writes.update(milestone.milestoneId, patch);
        setWriteInFlight(true);
      }}
    >
      <label>
        {copy.milestones.writes.nameLabel}
        <input value={draft.name} disabled={writes.busy} onChange={(event) => setDraft({ ...draft, name: event.target.value, touched: withTouched(draft.touched, "name") })} />
      </label>
      <label>
        {copy.milestones.writes.effortLabel}
        {/* why: plain text keeps the raw keystrokes — a number input sanitises bad text
            to "", which would coerce garbage into a null (a cleared estimate). */}
        <input
          type="text"
          inputMode="numeric"
          value={draft.effort}
          disabled={writes.busy}
          onChange={(event) => setDraft({ ...draft, effort: event.target.value, touched: withTouched(draft.touched, "effort") })}
        />
        {effortError ? (
          <span className="muted t-11" role="alert" data-ms-effort-invalid="">
            {copy.milestones.writes.effortInvalid}
          </span>
        ) : null}
      </label>
      <label>
        {copy.milestones.writes.statusLabel}
        <select value={draft.status} disabled={writes.busy} onChange={(event) => setDraft({ ...draft, status: event.target.value, touched: withTouched(draft.touched, "status") })}>
          {MILESTONE_STATUSES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className={"link"} disabled={writes.busy}>
        {copy.milestones.writes.save}
      </button>
      <button
        type="button"
        className={"link"}
        disabled={writes.busy}
        onClick={() => {
          setEffortError(false);
          setDraft(null);
        }}
      >
        {copy.milestones.writes.cancel}
      </button>
    </form>
  );
}

function MilestoneBlock(props: {
  milestone: Milestone;
  copy: ProjectDetailCopy;
  writes?: MilestoneWriteSurface;
  assignable?: AssignableIssuesRead;
  onRetryAssignable?: () => void;
  drafts?: MilestoneDraftStore;
  draftsProject?: string;
}) {
  const { milestone, copy } = props;
  const writes = props.writes;
  const unassign = writes === undefined ? undefined : (issueId: string, issueRevision: number) => writes.assign(issueId, issueRevision, null);
  return (
    <section className={"milestone-block"} data-ms-milestone={milestone.milestoneId}>
      <div className={"milestone-block-head"}>
        {/* The name truncates on the flex item itself. Wrapping it in an inline-block
            `.trunc` cost 2px of alignment against the sibling status and date, because an
            inline-block's baseline is its content's bottom edge and this line aligns on
            baselines. A block-level flex child ellipses with no such trade-off. */}
        <span className={"milestone-block-name"} title={milestone.name} tabIndex={0}>
          {milestone.name}
        </span>
        {milestone.status === null ? null : <StatusDot label={milestone.status} tone={milestoneStatusTone(milestone.status)} mono />}
        <span className={"detail-meta"} data-ms-effort={milestone.effortSessions ?? ""}>
          {milestone.effortSessions === null ? copy.milestones.unestimated : copy.milestones.effort(milestone.effortSessions)}
        </span>
        {/* The prototype prints four tallies, each a number over its label. */}
        <span className={"milestone-block-counts"}>
          {[
            ["open", milestone.counts.open, copy.milestones.countLabels.open],
            ["resolved", milestone.counts.resolved, copy.milestones.countLabels.resolved],
            ["retired", milestone.counts.retired, copy.milestones.countLabels.retired],
            ["total", milestone.counts.total, copy.milestones.countLabels.total],
          ].map(([key, count, label]) => (
            <span key={String(key)} data-ms-count={key} data-ms-count-value={count}>
              <span className="num">{count}</span>
              <span className="milestone-count-label">{label}</span>
            </span>
          ))}
        </span>
      </div>
      {milestone.issues.length === 0 ? null : (
        // The prototype's assignment row: one compact id chip per issue, toned by its
        // disposition, and the rest folded into `+N <disposition>`. The title stays on
        // the issue's own screen — this row answers "which issues", not "what are they".
        <div className="assigned">
          {assignedChips(milestone.issues).shown.map((issue) => {
            const chip = (
              <>
                <span className="dot" aria-hidden="true" />
                <span className="assigned-id" title={issue.title}>
                  {issue.id}
                </span>
              </>
            );
            if (writes === undefined || unassign === undefined) {
              return (
                <span key={issue.id} className={`status tone-${dispositionTone(issue.disposition)}`}>
                  {chip}
                </span>
              );
            }
            return (
              <button
                key={issue.id}
                type="button"
                className={`status tone-${dispositionTone(issue.disposition)}`}
                disabled={writes.busy}
                aria-label={`${copy.milestones.writes.unassign} ${issue.id}`}
                data-ms-unassign-issue={issue.id}
                onClick={() => unassign(issue.id, issue.revision)}
              >
                {chip}
                <span aria-hidden="true"> ×</span>
              </button>
            );
          })}
          {assignedChips(milestone.issues).folded.map((fold) => (
            <span key={fold.disposition} className="assigned-id muted" data-ms-folded={fold.disposition}>
              +{fold.count} {fold.disposition}
            </span>
          ))}
        </div>
      )}
      {writes === undefined ? null : (
        <MilestoneActions
          milestone={milestone}
          writes={writes}
          assignable={props.assignable}
          {...(props.onRetryAssignable === undefined ? {} : { onRetryAssignable: props.onRetryAssignable })}
          copy={copy}
          {...(props.drafts === undefined ? {} : { drafts: props.drafts })}
          {...(props.draftsProject === undefined ? {} : { draftsProject: props.draftsProject })}
        />
      )}
    </section>
  );
}

function MilestoneCreateForm(props: { writes: MilestoneWriteSurface; nextOrdinal: number; copy: ProjectDetailCopy; drafts?: MilestoneDraftStore; draftsProject?: string }) {
  const { writes, copy } = props;
  // why: the create draft is keyed by the identity the form was opened over — a bare
  // `create` would re-seed every project's create form from the one draft that exists.
  const targetKey = milestoneDraftTargetKey(props.draftsProject, "create");
  // why: seeded from the host store — a refresh re-mounts the form over the typed values.
  const [name, setName] = useState(() => props.drafts?.read(targetKey)?.name ?? "");
  const [effort, setEffort] = useState(() => props.drafts?.read(targetKey)?.effort ?? "");
  const [effortError, setEffortError] = useState(false);
  // why: every keystroke reaches the host store, so the draft is the host's, not the
  // unmounted subtree's.
  useEffect(() => {
    if (name === "" && effort === "") props.drafts?.clear(targetKey);
    else props.drafts?.write(targetKey, { name, effort });
  }, [name, effort, props.drafts, targetKey]);
  // why: same rule as the editor — the surface's keepDraft verdict clears the form only on an
  // accepted write, so a conflict (whose refusal text is present) keeps the typed values.
  const [writeInFlight, setWriteInFlight] = useState(false);
  useEffect(() => {
    if (!writeInFlight || writes.busy) return;
    setWriteInFlight(false);
    if (draftAfterWrite({ name, effort }, writes) !== null) return;
    setName("");
    setEffort("");
  });
  return (
    <form
      className={"ms-create"}
      data-ms-milestone-create=""
      onSubmit={(event) => {
        event.preventDefault();
        const created = milestoneCreateInput(name, effort, props.nextOrdinal);
        if (created.kind === "invalid") {
          if (name.trim() !== "") setEffortError(true);
          return;
        }
        setEffortError(false);
        writes.create(created.input);
        setWriteInFlight(true);
      }}
    >
      <label>
        {copy.milestones.writes.nameLabel}
        <input value={name} disabled={writes.busy} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        {copy.milestones.writes.effortLabel}
        <input
          type="text"
          inputMode="numeric"
          value={effort}
          disabled={writes.busy}
          onChange={(event) => setEffort(event.target.value)}
        />
        {effortError ? (
          <span className="muted t-11" role="alert" data-ms-effort-invalid="">
            {copy.milestones.writes.effortInvalid}
          </span>
        ) : null}
      </label>
      <button type="submit" className={"link"} disabled={writes.busy || name.trim() === ""}>
        {copy.milestones.writes.create}
      </button>
    </form>
  );
}

/**
 * Split a milestone's issues into the chips it shows and the per-disposition folds it
 * states instead. The prototype's row lists the issues that are still **open** and
 * counts every other disposition (`+5 retired`, `+2 resolved`); the fold is a summary of
 * settled work, never an overflow indicator. A milestone whose open set is long lists all
 * of it — the row wraps, which is what the prototype's own CSS does.
 */
function assignedChips(issues: readonly { id: string; title: string; disposition: string; revision: number }[]): {
  shown: readonly { id: string; title: string; disposition: string; revision: number }[];
  folded: Array<{ disposition: string; count: number }>;
} {
  const byDisposition = new Map<string, number>();
  for (const issue of issues) {
    if (issue.disposition === "open") continue;
    byDisposition.set(issue.disposition, (byDisposition.get(issue.disposition) ?? 0) + 1);
  }
  return {
    shown: issues.filter((issue) => issue.disposition === "open"),
    folded: [...byDisposition].map(([disposition, count]) => ({ disposition, count })),
  };
}

/**
 * An issue's disposition → the dot tone the prototype's assignment row uses. The tone
 * names come from the prototype's own CSS (`.tone-open`, `.tone-resolved`), so the class
 * is the disposition word itself when the sheet knows it. `Tone` has no `open`/`resolved`
 * members, which is why this returns a bare string the row interpolates.
 */
function dispositionTone(disposition: string): string {
  return disposition === "resolved" || disposition === "open" ? disposition : "neutral";
}

// invariant: the timeline is one node per milestone in the read's order (ordinal,
// then id — the comparator `readMilestonesOn` sorts with) plus one trailing node for
// the unassigned issues; every number is the read's own — the effort line, the
// retired-over-total pair and the open count.
function MilestoneTimeline(props: { model: MilestonesModel; copy: ProjectDetailCopy }) {
  const { model, copy } = props;
  const ordered = [...model.milestones].sort(
    (a, b) => a.ordinal - b.ordinal || (a.milestoneId < b.milestoneId ? -1 : a.milestoneId > b.milestoneId ? 1 : 0),
  );
  return (
    <div className="timeline" data-ms-milestone-timeline="" role="list">
      {ordered.map((milestone) => (
        <div
          key={milestone.milestoneId}
          role="listitem"
          className={
            milestone.status === "delivered"
              ? "tl-node done"
              : milestone.status === "active"
                ? "tl-node run"
                : "tl-node"
          }
          data-ms-timeline-node={milestone.milestoneId}
        >
          <div className="tl-name">{milestone.name}</div>
          <div className="tl-date">
            {milestone.effortSessions === null ? copy.milestones.unestimated : copy.milestones.effort(milestone.effortSessions)}
            {milestone.status === null ? "" : ` · ${milestone.status}`}
          </div>
          <div className="tl-counts" data-ms-timeline-counts="">
            {milestone.counts.total - milestone.counts.open}/{milestone.counts.total} ·{" "}
            {copy.milestones.milestoneOpen(milestone.counts.open)}
          </div>
        </div>
      ))}
      <div className="tl-node" role="listitem" data-ms-timeline-node="unassigned">
        <div className="tl-name muted">{copy.milestones.timelineUnassigned}</div>
        <div className="tl-counts">{copy.milestones.timelineUnassignedIssues(model.unassignedIssues)}</div>
      </div>
    </div>
  );
}

/**
 * The milestone body: the timeline, then the board.
 */
function MilestoneBoard(props: {
  model: MilestonesModel;
  copy: ProjectDetailCopy;
  writes?: MilestoneWriteSurface;
  assignable?: AssignableIssuesRead;
  onRetryAssignable?: () => void;
  drafts?: MilestoneDraftStore;
  draftsProject?: string;
}) {
  const { model, copy } = props;
  return (
    <div className={"feature-body"}>
      {model.milestones.length === 0 && model.unassignedIssues === 0 ? null : (
        <section className={"panel"} data-ms-milestones="">
          <div className="panel-head">
            <h2 className={"panel-title"}>{copy.milestones.milestonesHeading}</h2>
            <span className="panel-meta">
              <span className="num mono">{model.milestones.length}</span>{" "}
              {copy.milestones.milestonesUnit}
              {model.unassignedIssues === 0 ? null : (
                <>
                  <span aria-hidden="true" className="sep">
                    ·
                  </span>
                  <span className="num mono">{model.unassignedIssues}</span>{" "}
                  {copy.milestones.unassignedUnit}
                </>
              )}
            </span>
          </div>
          <MilestoneTimeline model={model} copy={copy} />
          {model.milestones.map((milestone) => (
            <MilestoneBlock
              key={milestone.milestoneId}
              milestone={milestone}
              copy={copy}
              {...(props.writes === undefined ? {} : { writes: props.writes })}
              {...(props.assignable === undefined ? {} : { assignable: props.assignable })}
          {...(props.onRetryAssignable === undefined ? {} : { onRetryAssignable: props.onRetryAssignable })}
              {...(props.drafts === undefined ? {} : { drafts: props.drafts })}
          {...(props.draftsProject === undefined ? {} : { draftsProject: props.draftsProject })}
            />
          ))}
          {model.unassignedIssues === 0 ? null : (
            <div className={"panel-foot"}>
              <span data-ms-unassigned={model.unassignedIssues}>
                {copy.milestones.unassigned(model.unassignedIssues)}
              </span>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * The write controls, outside the populated arm: a project whose milestone set
 * is empty still needs a way to create the FIRST one. The store is the
 * authority on whether the write lands, so the form is offered and a refusal
 * is surfaced.
 */
function MilestoneWrites(props: { writes?: MilestoneWriteSurface; nextOrdinal: number; copy: ProjectDetailCopy; drafts?: MilestoneDraftStore; draftsProject?: string }) {
  if (props.writes === undefined) return null;
  const writes = props.writes;
  return (
    <>
      {/* The store's own refusal, verbatim, until the next write or reload
          replaces it (contract C1: the client rewords nothing). */}
      {writes.refusal === null ? null : (
        <p className="muted t-12" role="alert" data-ms-write-refusal="">
          {props.copy.milestones.writes.refusalLead} {writes.refusal}
        </p>
      )}
      <MilestoneCreateForm
        writes={writes}
        nextOrdinal={props.nextOrdinal}
        copy={props.copy}
        {...(props.drafts === undefined ? {} : { drafts: props.drafts })}
          {...(props.draftsProject === undefined ? {} : { draftsProject: props.draftsProject })}
      />
    </>
  );
}

/**
 * The milestone body's arms.
 *
 * `empty` is a project whose milestone set holds nothing yet — no board, no
 * zero-width bar — while the create form stays offered, so the first milestone
 * is always creatable. `not-applicable` means no project resolved for the
 * read; `unavailable` carries the store's own reason.
 */
function MilestonesArm(props: {
  milestones: Resolved<MilestonesModel>;
  copy: ProjectDetailCopy;
  writes?: MilestoneWriteSurface;
  assignable?: AssignableIssuesRead;
  onRetryAssignable?: () => void;
  drafts?: MilestoneDraftStore;
  draftsProject?: string;
}) {
  const { milestones, copy } = props;
  // The write controls sit OUTSIDE the arm: a project with no milestone still
  // needs a way to create the first one, so the form renders for every state
  // where the read answered and the host can write.
  const writes =
    props.writes === undefined ? null : (
      <MilestoneWrites
        writes={props.writes}
        nextOrdinal={milestones.kind === "populated" ? nextMilestoneOrdinal(milestones.value.milestones) : 0}
        copy={copy}
        {...(props.drafts === undefined ? {} : { drafts: props.drafts })}
          {...(props.draftsProject === undefined ? {} : { draftsProject: props.draftsProject })}
      />
    );
  switch (milestones.kind) {
    case "populated":
      return (
        <div className={"feature-body-arm"} data-ms-milestones-arm="populated">
          {writes}
          <MilestoneBoard
            model={milestones.value}
            copy={copy}
            {...(props.writes === undefined ? {} : { writes: props.writes })}
            {...(props.assignable === undefined ? {} : { assignable: props.assignable })}
          {...(props.onRetryAssignable === undefined ? {} : { onRetryAssignable: props.onRetryAssignable })}
            {...(props.drafts === undefined ? {} : { drafts: props.drafts })}
          {...(props.draftsProject === undefined ? {} : { draftsProject: props.draftsProject })}
          />
        </div>
      );
    case "not-applicable":
      return (
        <EmptyState
          arm="not-applicable"
          labelWord={copy.absence["not-applicable"].labelWord}
          heading={copy.absence["not-applicable"].heading}
          body={copy.absence["not-applicable"].body}
          detail={milestones.reason}
        />
      );
    case "empty":
      return (
        <div className={"feature-body-arm"} data-ms-milestones-arm="empty">
          {writes}
          <EmptyState
            arm="empty"
            labelWord={copy.absence.empty.labelWord}
            heading={copy.absence.empty.heading}
            body={copy.absence.empty.body}
            hint={copy.absence.empty.hint}
          />
        </div>
      );
    case "unavailable":
      return (
        <EmptyState
          arm="unavailable"
          labelWord={copy.absence.unavailable.labelWord}
          heading={copy.absence.unavailable.heading}
          body={copy.absence.unavailable.body}
          reason={milestones.reason}
        />
      );
    // A pending read has no subject state yet: rendering no arm is the honest
    // answer, because an arm would claim a state the transport has not reached.
    case "loading":
      return null;
  }
}

export function ProjectDetail(props: ProjectDetailProps) {
  const { identity, copy, feature } = props;
  // The header line is the project's own description — the only thing the list
  // read says about what the project is. None renders nothing, not a dash.
  const direction = identity.description;
  // The head's `N open issues` is the project's open-issue total, which the scoped Issues
  // read already answers under its default `open` disposition. The milestone
  // tallies cannot answer it: `unassignedIssues` counts every unassigned issue, retired
  // ones included (`MilestoneRead` documents the row that way).
  const openIssues = props.issuesCount ?? null;
  // The prototype's tabs each carry their own count: the scoped lists' lengths,
  // which only the host knows.
  const counts: Record<ProjectFeature, number | undefined> = {
    issues: props.issuesCount,
    iterations: props.iterationsCount,
  };
  const tabs: TabItem[] = PROJECT_FEATURES.map((id) => ({
    id,
    label: copy.features[id],
    ...(counts[id] === undefined ? {} : { count: counts[id] }),
  }));

  return (
    <article className={"screen"} data-ms-screen="project-detail">
      <nav className={"breadcrumb"} aria-label={copy.breadcrumb.label}>
        {props.onBack === undefined ? null : (
          <button type="button" className={"link"} onClick={props.onBack}>
            {copy.breadcrumb.trail}
          </button>
        )}
        <span className={""} aria-hidden="true">
          /
        </span>
        <span className={""} aria-current="page">
          {identity.projectId}
        </span>
      </nav>

      <header className="detail-head">
        <div className="detail-head-main">
          <h1 className="detail-title">
            <TruncatedText text={identity.title} />
          </h1>
          {/* The description above the identity meta line, as the confirmed baseline has it. */}
          {direction === null ? null : (
            <p className="prose t-12 secondary" data-ms-direction="">
              {direction}
            </p>
          )}
          <div className="detail-meta">
            <span className="mono">{identity.projectId}</span>
            <span aria-hidden="true">·</span>
            <span className="mono">{identity.lifecycle}</span>
            {openIssues === null ? null : (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  <span className="num">{openIssues}</span> {copy.openIssuesUnit}
                </span>
              </>
            )}
          </div>
        </div>
      </header>

      {/* The screen's default body: the milestone rollup, then its write forms. */}
      <MilestonesArm
        milestones={props.milestones}
        copy={copy}
        {...(props.writes === undefined ? {} : { writes: props.writes })}
        {...(props.assignableIssues === undefined ? {} : { assignable: props.assignableIssues })}
        {...(props.onRetryAssignable === undefined ? {} : { onRetryAssignable: props.onRetryAssignable })}
        {...(props.drafts === undefined ? {} : { drafts: props.drafts })}
        draftsProject={identity.projectId}
      />

      {/* The fixed list-feature set. `Issues` is always the default. */}
      <Tabs
        tabs={tabs}
        activeId={feature}
        onSelect={(id) => props.onFeatureChange(id as ProjectFeature)}
        label={copy.tabLabel}
      />

      <div className={"feature-body"} data-ms-feature={feature}>
        {/* The scope chip: this list is this project's, and the scope is
            removable so the reader can say what they are looking at. */}
        <div className={"chips"}>
          <span className={"chip"} data-ms-scope-chip={identity.projectId}>
            {copy.scope.label(identity.projectId)}
            {/* No callback, no button: a control that looks removable and is not is
                worse than a chip that simply states the scope. */}
            {props.onClearScope === undefined ? null : (
              <button
                type="button"
                className={"chip-x"}
                aria-label={copy.scope.clear}
                data-ms-scope-clear={identity.projectId}
                onClick={props.onClearScope}
              >
                ×
              </button>
            )}
          </span>
        </div>
        {feature === "issues" ? props.issues : props.iterations}
      </div>
    </article>
  );
}
