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
import { Collapsible } from "../components/Collapsible.tsx";
import { EmptyState, type AbsenceArm } from "../components/EmptyState.tsx";
import { Field } from "../components/Field.tsx";
import { FieldGroup } from "../components/FieldGroup.tsx";
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
  fields: { title: string; id: string; lifecycle: string; path: string; description: string; noDescription: string };
  /** The two identity panels the prototype puts side by side. */
  catalogHeading: string;
  /** The roadmap's presence, said beside the title (`roadmap present`). */
  roadmapState: string;
  authorityHeading: string;
  authorityColumns: { state: string; revision: string; contentHash: string; frontmatter: string };
  /** Said when the project declares no roadmap authority row. */
  authorityAbsent: string;
  tabLabel: string;
  /** The three fixed features, in order. `PROJECT_FEATURES` is the id list. */
  features: Record<ProjectFeature, string>;
  roadmap: {
    directionHeading: string;
    goalsHeading: string;
    milestonesHeading: string;
    /** The board head's two nouns, which the prototype prints after each count. */
    milestonesUnit: string;
    unassignedUnit: string;
    markdownHeading: string;
    noDirection: string;
    goalChecked: string;
    goalUnchecked: string;
    milestoneProgress: (done: number, total: number) => string;
    milestoneOpen: (open: number) => string;
    noTarget: string;
    unassigned: (count: number) => string;
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
        <span className={"milestone-block-name"}>
          <TruncatedText text={milestone.name} />
        </span>
        {milestone.status === null ? null : <StatusDot label={milestone.status} tone={milestoneStatusTone(milestone.status)} mono />}
        <span className={"detail-meta"}>{milestone.target ?? copy.roadmap.noTarget}</span>
        {milestone.progress === null ? null : (
          <span className={"milestone-counts"}>
            <ProgressBar done={milestone.progress.done} total={milestone.progress.total} />
            <span className={"detail-meta"}>{copy.roadmap.milestoneProgress(milestone.progress.done, milestone.progress.total)}</span>
          </span>
        )}
        <span className={"detail-meta"}>{copy.roadmap.milestoneOpen(milestone.openIssues)}</span>
      </div>
      {milestone.issues.length === 0 ? null : (
        <ul className="goal-list">
          {milestone.issues.map((issue) => (
            <li key={issue.id} className={"row"}>
              <span className={"mono"}>{issue.id}</span>
              <TruncatedText text={issue.title} />
              <span className={"detail-meta"}>{issue.disposition}</span>
            </li>
          ))}
        </ul>
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

/** The Roadmap feature body: direction (collapsed), goals, board, markdown. */
function RoadmapFeature(props: { model: RoadmapModel; copy: ProjectDetailCopy }) {
  const { model, copy } = props;
  return (
    <div className={"feature-body"} data-ms-feature="roadmap">
      {model.direction === null ? null : (
        <Collapsible summary={copy.roadmap.directionHeading}>
          <p className={"detail-text"} data-ms-direction="">
            {model.direction}
          </p>
        </Collapsible>
      )}
      {model.goals.length === 0 ? null : (
        <section className={"panel"} data-ms-goals="">
          <h3>{copy.roadmap.goalsHeading}</h3>
          <ul className="goal-list">
            {model.goals.map((goal) => (
              <li key={goal.ordinal} className={"milestone-row"} data-ms-goal-depth={goal.depth} data-ms-goal-checked={goal.checked}>
                {/* The check state is text plus a mark, never colour alone. */}
                <span className={"dot"} aria-hidden="true">
                  {goal.checked ? "✓" : "·"}
                </span>
                <span className={"milestone-name"}>{goal.title}</span>
                <span className={"visually-hidden"}>{goal.checked ? copy.roadmap.goalChecked : copy.roadmap.goalUnchecked}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {model.milestones.length === 0 ? null : (
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
      {model.markdown === null ? null : (
        <Collapsible summary={copy.roadmap.markdownHeading}>
          <pre data-ms-roadmap-markdown="">{model.markdown}</pre>
        </Collapsible>
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
  /** The roadmap's authority row, or `null` when the record declares none. */
  const authority = props.roadmap.kind === "populated" ? props.roadmap.value.authority : null;
  // The prototype's strip carries a count per feature. Only the roadmap's is derivable
  // here: the issues and iterations panels arrive as rendered nodes from the host, so
  // their counts are the host's facts to pass in.
  const milestones = props.roadmap.kind === "populated" ? props.roadmap.value.milestones.length : undefined;
  const tabs: TabItem[] = PROJECT_FEATURES.map((id) => ({
    id,
    label: copy.features[id],
    ...(id === DEFAULT_PROJECT_FEATURE && milestones !== undefined ? { count: milestones } : {}),
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
          <div className="detail-meta">
            <span className="mono">{identity.projectId}</span>
            <span aria-hidden="true">·</span>
            <span className="mono">{identity.lifecycle}</span>
          </div>
          {identity.description === null ? null : (
            <p className="prose t-12 secondary">{identity.description}</p>
          )}
        </div>
        <div className="detail-actions">
          {/* The prototype states the roadmap's presence as a dot + word, then the
              catalog location beside it. */}
          <span className={`status tone-${identity.lifecycleTone}`}>
            <span className="dot" aria-hidden="true" />
            <span className="label mono">{copy.roadmapState}</span>
          </span>
          <span className="mono t-11 muted">{identity.path}</span>
        </div>
      </header>

      {/* The prototype puts the catalog identity and the roadmap's authority side by
          side: what the record is, and what backs its roadmap. */}
      <div className="detail-top">
        <section className="panel" aria-labelledby="ms-project-catalog">
          <div className="panel-head">
            <h2 className="panel-title" id="ms-project-catalog">
              {copy.catalogHeading}
            </h2>
          </div>
          <div className="panel-body">
            <dl className="fields">
              <div className="field">
                <dt>{copy.fields.id}</dt>
                <dd className="mono">{identity.projectId}</dd>
              </div>
              <div className="field">
                <dt>{copy.fields.lifecycle}</dt>
                <dd className="mono">{identity.lifecycle}</dd>
              </div>
              <div className="field">
                <dt>{copy.fields.path}</dt>
                <dd className="mono wrap">{identity.path}</dd>
              </div>
            </dl>
          </div>
        </section>
        <section className="panel" aria-labelledby="ms-project-authority">
          <div className="panel-head">
            <h2 className="panel-title" id="ms-project-authority">
              {copy.authorityHeading}
            </h2>
          </div>
          <div className="panel-body">
            {authority === null ? (
              <p className="muted t-12">{copy.authorityAbsent}</p>
            ) : (
              <dl className="fields">
                <div className="field">
                  <dt>{copy.authorityColumns.state}</dt>
                  <dd className="mono">{authority.state}</dd>
                </div>
                <div className="field">
                  <dt>{copy.authorityColumns.revision}</dt>
                  <dd className="mono">{authority.revision}</dd>
                </div>
                <div className="field">
                  <dt>{copy.authorityColumns.contentHash}</dt>
                  <dd className="mono trunc" title={authority.contentHash}>
                    <TruncatedText text={authority.contentHash} />
                  </dd>
                </div>
                <div className="field">
                  <dt>{copy.authorityColumns.frontmatter}</dt>
                  <dd className="mono trunc">
                    <TruncatedText text={authority.frontmatter} />
                  </dd>
                </div>
              </dl>
            )}
          </div>
        </section>
      </div>

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
