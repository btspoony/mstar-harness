/**
 * `ProjectDetail` — identity head plus the project's three features (IA §4).
 *
 * The feature set is **fixed**: Roadmap, Issues, Iterations, in that order, with
 * **Roadmap permanently the default**. It does not grow, it is not configurable,
 * and it never opens "the first feature that has content": a fixed default keeps
 * every project page the same shape so a reader's memory of the layout transfers
 * between projects, and auto-selection would quietly hide an absence — which is
 * itself a fact (§4, "Why Roadmap is the default even when it is absent").
 *
 * Each feature is scoped to this project. A feature whose attribution is missing
 * renders the not-applicable / absent arm; it must never fall back to the
 * store-wide list, which would be a wrong answer presented as a right one.
 *
 * Not rendered anywhere here: `storeRevision`, `catalogRevision`, `builtAt`,
 * `checkedAt`, the catalog `revision`, `sourceHash`.
 */
import { EmptyState, type AbsenceArm } from "../components/EmptyState.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { StatusDot } from "../components/StatusDot.tsx";
import { Tabs, type TabItem } from "../components/Tabs.tsx";
import { TruncatedText } from "../components/TruncatedText.tsx";
import {
  DEFAULT_PROJECT_FEATURE,
  PROJECT_FEATURES,
  type ProjectFeature,
  type ProjectIdentity,
  type RoadmapModel,
} from "../view-model/projects.ts";
import type { Resolved } from "../view-model/state.ts";
import type { Tone } from "../view-model/status.ts";

/** Every visible string this screen needs. Task 5 supplies them. */
export type ProjectDetailCopy = {
  breadcrumb: { label: string; trail: string };
  /** The word before the catalog revision in the head's meta line. */
  revisionLabel: string;
  /** The noun after the project's open-issue count. */
  openIssuesUnit: string;
  /** The roadmap's presence, said beside the title (`roadmap present`). */
  roadmapState: string;
  tabLabel: string;
  /** The three fixed features, in order. `PROJECT_FEATURES` is the id list. */
  features: Record<ProjectFeature, string>;
  roadmap: {
    milestonesHeading: string;
    /** The board head's two nouns, which the prototype prints after each count. */
    milestonesUnit: string;
    unassignedUnit: string;
    milestoneProgress: (done: number, total: number) => string;
    milestoneOpen: (open: number) => string;
    /** The four tallies of the prototype's board row. */
    countLabels: { open: string; resolved: string; retired: string; total: string };
    noTarget: string;
    unassigned: (count: number) => string;
    /** The trailing timeline node's name for issues with no milestone. */
    timelineUnassigned: string;
    timelineUnassignedIssues: (count: number) => string;
    /** The next step offered when the roadmap is absent (§4). */
    absentNextStep: (features: string) => string;
  };
  /** The scope chip a scoped feature list carries. */
  scope: { label: (projectId: string) => string; clear: string };
  absence: {
    absent: { labelWord: string; heading: string; body: string; pointer: string };
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
  /** The Roadmap feature's arm, resolved by `state.ts`/`roadmapBody`. */
  roadmap: Resolved<RoadmapModel>;
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
  onBack?: () => void;
  /** Leaving the project's scope — the chip's own affordance. Omitted, there is no chip button. */
  onClearScope?: () => void;
};

/** One milestone of the roadmap board: status, target, progress, open, issues. */
function Milestone(props: { milestone: RoadmapModel["milestones"][number]; copy: ProjectDetailCopy }) {
  const { milestone, copy } = props;
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
        <span className={"detail-meta"}>{milestone.target ?? copy.roadmap.noTarget}</span>
        {/* The prototype prints four tallies, each a number over its label. */}
        <span className={"milestone-block-counts"}>
          {[
            ["open", milestone.counts.open, copy.roadmap.countLabels.open],
            ["resolved", milestone.counts.resolved, copy.roadmap.countLabels.resolved],
            ["retired", milestone.counts.retired, copy.roadmap.countLabels.retired],
            ["total", milestone.counts.total, copy.roadmap.countLabels.total],
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
          {assignedChips(milestone.issues).shown.map((issue) => (
            <span key={issue.id} className={`status tone-${dispositionTone(issue.disposition)}`}>
              <span className="dot" aria-hidden="true" />
              <span className="assigned-id" title={issue.title}>
                {issue.id}
              </span>
            </span>
          ))}
          {assignedChips(milestone.issues).folded.map((fold) => (
            <span key={fold.disposition} className="assigned-id muted" data-ms-folded={fold.disposition}>
              +{fold.count} {fold.disposition}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

/** Milestone status → tone. Local because the board is the only caller. */
function milestoneStatusTone(status: string): Tone {
  if (status === "delivered") return "success";
  if (status === "dropped") return "purple";
  return "neutral";
}

/**
 * Split a milestone's issues into the chips it shows and the per-disposition folds it
 * states instead. The prototype's row lists the issues that are still **open** and
 * counts every other disposition (`+5 retired`, `+2 resolved`); the fold is a summary of
 * settled work, never an overflow indicator. A milestone whose open set is long lists all
 * of it — the row wraps, which is what the prototype's own CSS does.
 */
function assignedChips(issues: readonly { id: string; title: string; disposition: string }[]): {
  shown: typeof issues;
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

/**
 * The Roadmap feature's timeline: one node per milestone, ordered by target with
 * missing targets last, and one trailing node for the unassigned issues (plan
 * 20261029-dashboard-alignment Task 3). Every number is the read's own: the
 * retired-over-total pair and the open count.
 */
function MilestoneTimeline(props: { model: RoadmapModel; copy: ProjectDetailCopy }) {
  const { model, copy } = props;
  const ordered = [...model.milestones].sort(
    (a, b) => (a.target ?? "9999-12-31").localeCompare(b.target ?? "9999-12-31"),
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
            {milestone.target ?? copy.roadmap.noTarget}
            {milestone.status === null ? "" : ` · ${milestone.status}`}
          </div>
          <div className="tl-counts" data-ms-timeline-counts="">
            {milestone.counts.total - milestone.counts.open}/{milestone.counts.total} ·{" "}
            {copy.roadmap.milestoneOpen(milestone.counts.open)}
          </div>
        </div>
      ))}
      <div className="tl-node" role="listitem" data-ms-timeline-node="unassigned">
        <div className="tl-name muted">{copy.roadmap.timelineUnassigned}</div>
        <div className="tl-date">{copy.roadmap.noTarget}</div>
        <div className="tl-counts">{copy.roadmap.timelineUnassignedIssues(model.unassignedIssues)}</div>
      </div>
    </div>
  );
}

/**
 * The Roadmap feature body: the milestone timeline, then the board.
 *
 * The document blocks (direction disclosure, stored markdown, stored facts) are
 * gone (plan Task 3): the direction moved to the page header, and the rest were
 * removed with the user's decision.
 */
function RoadmapFeature(props: { model: RoadmapModel; copy: ProjectDetailCopy }) {
  const { model, copy } = props;
  return (
    <div className={"feature-body"} data-ms-feature="roadmap">
      {model.milestones.length === 0 && model.unassignedIssues === 0 ? null : (
        <section className={"panel"} data-ms-milestones="">
          <div className="panel-head">
            <h2 className={"panel-title"}>{copy.roadmap.milestonesHeading}</h2>
            <span className="panel-meta">
              <span className="num mono">{model.milestones.length}</span>{" "}
              {copy.roadmap.milestonesUnit}
              {model.unassignedIssues === 0 ? null : (
                <>
                  <span aria-hidden="true" className="sep">
                    ·
                  </span>
                  <span className="num mono">{model.unassignedIssues}</span>{" "}
                  {copy.roadmap.unassignedUnit}
                </>
              )}
            </span>
          </div>
          <MilestoneTimeline model={model} copy={copy} />
          {model.milestones.map((milestone) => (
            <Milestone key={milestone.milestoneId} milestone={milestone} copy={copy} />
          ))}
          {model.unassignedIssues === 0 ? null : (
            <div className={"panel-foot"}>
              <span data-ms-unassigned={model.unassignedIssues}>
                {copy.roadmap.unassigned(model.unassignedIssues)}
              </span>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * The Roadmap feature's four arms.
 *
 * `absent` is the case IA §4 exists for: a project with no roadmap row (`_default`
 * is the real one) says it declares no roadmap — no direction body, no empty
 * board, no zero-width bar — and offers the two features that *do* have content as
 * the continuation. `empty` is a different fact: the roadmap exists, its milestone
 * set is empty. The two never share a string.
 */
function RoadmapArm(props: { roadmap: Resolved<RoadmapModel>; copy: ProjectDetailCopy }) {
  const { roadmap, copy } = props;
  switch (roadmap.kind) {
    case "populated":
      return <RoadmapFeature model={roadmap.value} copy={copy} />;
    case "absent":
      return (
        <EmptyState
          arm="absent"
          labelWord={copy.absence.absent.labelWord}
          heading={copy.absence.absent.heading}
          body={copy.absence.absent.body}
          pointer={copy.roadmap.absentNextStep(`${copy.features.issues} · ${copy.features.iterations}`)}
        />
      );
    case "not-applicable":
      return (
        <EmptyState
          arm="not-applicable"
          labelWord={copy.absence["not-applicable"].labelWord}
          heading={copy.absence["not-applicable"].heading}
          body={copy.absence["not-applicable"].body}
          detail={roadmap.reason}
        />
      );
    case "empty":
      return (
        <EmptyState
          arm="empty"
          labelWord={copy.absence.empty.labelWord}
          heading={copy.absence.empty.heading}
          body={copy.absence.empty.body}
          hint={copy.absence.empty.hint}
        />
      );
    case "unavailable":
      return (
        <EmptyState
          arm="unavailable"
          labelWord={copy.absence.unavailable.labelWord}
          heading={copy.absence.unavailable.heading}
          body={copy.absence.unavailable.body}
          reason={roadmap.reason}
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
  // The header direction (plan Task 3): the roadmap's declared direction, falling
  // back to the catalog description. Both absent renders nothing, not a dash.
  const direction =
    props.roadmap.kind === "populated"
      ? (props.roadmap.value.direction ?? identity.description)
      : null;
  // The head's `N open issues` is the project's open-issue total, which the scoped Issues
  // read already answers under its default `open` disposition. The roadmap's milestone
  // tallies cannot answer it: `unassignedIssues` counts every unassigned issue, retired
  // ones included (`MilestoneRead` documents the row that way).
  const openIssues = props.issuesCount ?? null;
  // The prototype's strip carries a count per feature. Only the roadmap's is derivable
  // here: the issues and iterations panels arrive as rendered nodes from the host, so
  // their counts are the host's facts to pass in.
  const milestones = props.roadmap.kind === "populated" ? props.roadmap.value.milestones.length : undefined;
  // The prototype's three tabs each carry their own count. The roadmap's comes from the read
  // here; the other two are the scoped lists' lengths, which only the host knows.
  const counts: Record<ProjectFeature, number | undefined> = {
    roadmap: milestones,
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
          {/* Direction above the identity meta line, as the confirmed baseline has it. */}
          {direction === null ? null : (
            <p className="prose t-12 secondary" data-ms-direction="">
              {direction}
            </p>
          )}
          <div className="detail-meta">
            <span className="mono">{identity.projectId}</span>
            <span aria-hidden="true">·</span>
            <span className="mono">{identity.lifecycle}</span>
            {/* No revision is a fact to omit, not a dash to print: `Revision —` claims
                the store recorded one and it was empty. */}
            {identity.revision === "" ? null : (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {copy.revisionLabel} <span className="mono">{identity.revision}</span>
                </span>
              </>
            )}
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
        <div className="detail-actions">
          {/* The prototype states the roadmap's presence as a dot + word, then the
              catalog location beside it. The word is only sayable when the read
              produced a roadmap; a loading, absent or unreadable one gets no chip
              rather than a false "present". */}
          {props.roadmap.kind === "populated" ? (
            <span className={`status tone-${identity.lifecycleTone}`}>
              <span className="dot" aria-hidden="true" />
              <span className="label mono">{copy.roadmapState}</span>
            </span>
          ) : null}
          <span className="mono t-11 muted">{identity.path}</span>
        </div>
      </header>


      {/* The fixed three-feature set. `Roadmap` is always the default. */}
      <Tabs
        tabs={tabs}
        activeId={feature}
        onSelect={(id) => props.onFeatureChange(id as ProjectFeature)}
        label={copy.tabLabel}
      />

      {feature === DEFAULT_PROJECT_FEATURE ? (
        <RoadmapArm roadmap={props.roadmap} copy={copy} />
      ) : (
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
      )}
    </article>
  );
}
