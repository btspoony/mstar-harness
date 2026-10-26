/**
 * `Overview` — the product's landing page (IA §2, §3.1).
 *
 * Wide (≥ 900px of container) it is the prototype's two columns — `minmax(0, 1.85fr)
 * minmax(0, 1fr)`, `design-v1.html:317-318`: work and its trend on the left, residuals
 * and milestones on the right, the latest iteration across both. Narrow it is the
 * sidebar's single run, still in that reading order. One set of sections, two forms.
 *
 * The trend is drawn from `model.issueFlow`, which maps `overview.issueFlow` without
 * recomputing anything. An unavailable member renders the shared unavailable arm —
 * never an empty chart — and a store with fewer than two dated buckets is `empty`,
 * because a one-point line is a dot pretending to be a trend. The numbers the figure
 * encodes are text beside it: the legend's two open counts, the gap note, and the
 * dated-history table. The series' cumulative totals are NOT printed — the prototype's
 * legend does not state them, and its last table row already does.
 *
 * Not here, by construction and by test: the version, `{HARNESS_DIR}`, and any
 * revision counter.
 *
 * Every absence goes through `state.ts` — the model already resolved each member
 * to one of the six arms, and `Absence` here only chooses the copy. A screen that
 * decided an arm itself would be a second authority.
 */
import { Fragment, type KeyboardEvent } from "react";

import { DataTable, type DataTableColumn } from "../components/DataTable.tsx";
import { formatClock, progressText } from "../view-model/format.ts";
import { EmptyState, type AbsenceArm } from "../components/EmptyState.tsx";
import { IssueFlowChart } from "../components/IssueFlowChart.tsx";
import { Notice } from "../components/Notice.tsx";
import { Panel, PanelBody, PanelHead } from "../components/Panel.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { Row } from "../components/Row.tsx";
import { StatusDot } from "../components/StatusDot.tsx";
import { TruncatedText } from "../components/TruncatedText.tsx";
import type {
  IssueFlowSeries,
  MilestoneRow,
  OverviewModel,
  OverviewPlanRow,
  OverviewWorkflowRow,
} from "../view-model/overview.ts";
import type { GateStepPosition, Tone } from "../view-model/status.ts";

/** Every visible string this screen needs. Task 5 supplies them. */
export type OverviewCopy = {
  pageTitle: string;
  /** The line under the title: which projects, how many are open. */
  screenSubtitle: (scope: string, open: number) => string;
  /** The word this screen uses when the read covers every project. */
  screenScopeAll: string;
  /** `built 13:56:02` — when the projection was built, or the word for "never". */
  identityBuilt: (at: string) => string;
  identityBuiltUnknown: string;
  /** `read 13:58:04` — when this read happened. */
  identityRead: (at: string) => string;

  workflowsHeading: string;
  /** Names the running workflows the panel does not draw, so the list is never silently
   *  shortened. The prototype's panel is one active workflow. */
  workflowsMore?: (count: number) => string;
  workflowsEmpty: string;
  /** `showing N of M` — the workflows member is capped upstream. */
  workflowsTruncated: (shown: number, total: number) => string;
  /** One workflow row's plan progress. */
  plansProgress: (done: number, total: number) => string;
  /** The plan table's five columns (`design-v1.html:859-866`). */
  planColumns: { plan: string; title: string; status: string; progress: string; done: string };
  /** `7 plans · running` — the count line above the table. */
  workflowMeta: (plans: number, status: string) => string;
  /** The plan table's accessible name, since it has no visible caption. */
  planTableCaption: string;
  /** A plan whose status the store does not record. */
  planStatusAbsent: string;
  /** The workflow header line's type label (`design-v1.html:855`). */
  typeLabel: string;
  /** The link into the workflow's own screen. */
  openWorkflow: string;
  /** The four branch anchors, as the header line labels them. */
  branchBase: string;
  branchSource: string;
  branchIntegration: string;
  branchTarget: string;
  /** A plan whose progress note is empty. */
  planProgressAbsent: string;
  /** The cell's stand-in for a value the store does not carry. */
  dash: string;
  /** The trend card's title and the range its head states. */
  trendHeading: string;
  trendRange: (from: string, to: string) => string;
  /** The figure's accessible name: the two series and the range. */
  trendChartTitle: (from: string, to: string) => string;
  trendCaptured: string;
  trendRetired: string;
  /** `24 dated open · 26 recorded open` — the two counts, side by side. */
  trendLegend: (datedOpen: number, recordedOpen: number) => string;
  /** The one-line reason the two counts differ. */
  trendGap: (datedOpen: number, undated: number) => string;
  /** The disclosure that carries the same numbers as a table. */
  trendTableSummary: string;
  trendColumns: { date: string; captured: string; retired: string; open: string; origin: string };
  residualsHeading: string;
  residualsTotal: (open: number) => string;
  iterationHeading: string;
  iterationNoIteration: string;
  gateStep: (step: number, of: number) => string;
  milestonesHeading: string;
  /** The short-container summary: `n milestones · m open`. */
  milestonesSummary: (milestones: number, open: number) => string;
  milestoneProgress: (done: number, total: number) => string;
  milestoneOpen: (open: number) => string;
  projection: { current: string; stale: string; unavailable: string };
  /** The four absence arms' own words and copy families (IA §5). */
  absence: {
    "not-applicable": { labelWord: string; body: string };
    absent: { labelWord: string; body: string; pointer: string };
    empty: { labelWord: string; body: string; hint: string };
    unavailable: { labelWord: string; body: string };
  };
  severityLabels: Record<string, string>;
};

export type OverviewProps = {
  model: OverviewModel;
  copy: OverviewCopy;
  /**
   * The product's identity, for the tail's `.identity-line`. The host supplies it because
   * only a host knows which package built it and at which version — the shared package has
   * no manifest of its own, and the prototype's line prints both.
   */
  identity?: { packageName: string; version: string; harnessDir?: string };
  /**
   * The host's own height budget. When it is short, IA §3.1 fixes the drop
   * order: milestones become one summary line first, then the plan table pages.
   * Height is host knowledge, so it arrives as a prop rather than as a viewport
   * media query the product layout must not use.
   */
  compact?: boolean;
  /**
   * Open one workflow's own screen. Absent when the host has no such destination
   * (the dsh seat mounts the pane without one), so the header line simply omits
   * the link rather than rendering a dead control.
   */
  onOpenWorkflow?: (id: string) => void;
  /**
   * Open the issue list filtered to one severity. The prototype's residual rows are
   * links to exactly that (`design-v1.html:1109-1111`); without it they read as dead
   * text. Absent when the host has no issues destination.
   */
  onOpenIssues?: (severity: string) => void;
};

/** Render one absence arm from the arm the model already resolved. */
function Absence(props: {
  /** The arm the model resolved, which may still be `loading`. */
  arm: AbsenceArm | "loading";
  copy: OverviewCopy;
  heading: string;
  /** The read's own message — `unavailable`. Never a re-worded copy string. */
  reason?: string;
  /** The subject the read could not scope — `not-applicable`. */
  detail?: string;
}) {
  const { arm, copy } = props;
  // A pending read has no subject state yet. Rendering an absence arm for it
  // would claim a state the transport has not reached — and crash, because the
  // subset type below has no `loading` key.
  if (arm === "loading") return null;
  return (
    <EmptyState
      arm={arm}
      labelWord={copy.absence[arm as AbsenceArm].labelWord}
      heading={props.heading}
      body={copy.absence[arm as AbsenceArm].body}
      reason={arm === "unavailable" ? props.reason : undefined}
      detail={arm === "not-applicable" ? props.detail : undefined}
      pointer={arm === "absent" ? copy.absence.absent.pointer : undefined}
      hint={arm === "empty" ? copy.absence.empty.hint : undefined}
    />
  );
}

/** The plan table's five columns, in the prototype's order and treatments. */
function planColumns(copy: OverviewCopy): DataTableColumn<OverviewPlanRow>[] {
  return [
    {
      key: "plan",
      header: copy.planColumns.plan,
      // The prototype gives this column 35% of the table (`.planboard` grid) and the
      // title absorbs the rest, so the proportion holds at every container width.
      width: "35%",
      render: (plan) => <span className="mono">{plan.planId}</span>,
    },
    {
      key: "title",
      header: copy.planColumns.title,
      render: (plan) =>
        plan.title === null ? (
          <span className="muted">{copy.dash}</span>
        ) : (
          // The prototype sets the title in the secondary tone, not the primary one:
          // the plan id is the row's identifier, the title is its description.
          <span className="muted">
            <TruncatedText text={plan.title} />
          </span>
        ),
    },
    {
      key: "status",
      header: copy.planColumns.status,
      width: 132,
      render: (plan) =>
        plan.status === null ? (
          <span className="muted">{copy.planStatusAbsent}</span>
        ) : (
          <StatusDot label={plan.status} tone={plan.statusTone} mono />
        ),
    },
    {
      key: "progress",
      header: copy.planColumns.progress,
      width: 116,
      render: (plan) =>
        plan.progress === null ? (
          // The store's note is free text, so it is shown as the fact it is — never
          // turned into a bar, and never replaced by one.
          <span className={plan.progressNote === null ? "muted" : "muted t-12"}>
            {plan.progressNote ?? copy.planProgressAbsent}
          </span>
        ) : (
          <span className="milestone-counts">
            <span className="mono">{progressText(plan.progress)}</span>
            <ProgressBar done={plan.progress.done} total={plan.progress.total} />
          </span>
        ),
    },
    {
      key: "done",
      header: copy.planColumns.done,
      width: 72,
      align: "end",
      render: (plan) => <span className="t-num">{plan.doneAt ?? copy.dash}</span>,
    },
  ];
}

/**
 * One active workflow: the header line, the branch chain, and the plan table
 * (`design-v1.html:845-925`). Several workflows stack, each with its own table.
 */
function WorkflowRowView(props: {
  row: OverviewWorkflowRow;
  copy: OverviewCopy;
  onOpenWorkflow?: (id: string) => void;
}) {
  const { row, copy } = props;
  const branch = row.branch;
  const anchors: Array<[string, string | null]> = [
    [copy.branchBase, branch.base],
    [copy.branchSource, branch.source],
    [copy.branchIntegration, branch.integration],
    [copy.branchTarget, branch.target],
  ];
  const drawn = anchors.filter(([, value]) => value !== null);
  // The prototype's panel body holds `.wf-summary` and `.branch-line` as siblings; the plan
  // table follows them. An earlier version wrapped all three inside `.wf-summary`, which
  // made one row where the prototype has three.
  return (
    <>
      <div className="wf-summary" data-ms-overview-workflow="">
        <span className="wf-id">{row.id}</span>
        <span className="muted">{copy.typeLabel}</span>
        <span className="chip">{row.type}</span>
        {row.phase === null ? null : <StatusDot label={row.phase} tone="neutral" mono />}
        {props.onOpenWorkflow === undefined ? null : (
          <button type="button" className="link" onClick={() => props.onOpenWorkflow?.(row.id)}>
            {copy.openWorkflow}
          </button>
        )}
      </div>
      {drawn.length === 0 ? null : (
        <div className="branch-line" data-ms-branch="">
          {drawn.map(([label, value], index) => (
            <Fragment key={label}>
              {index === 0 ? null : <span className="branch-arrow" aria-hidden="true">→</span>}
              <span className="branch-anchor">
                <span>{label}</span> <b>{value}</b>
              </span>
            </Fragment>
          ))}
        </div>
      )}
    </>
  );
}

/** One milestone row: status, target, progress, open count. */
function MilestoneRowView(props: { row: MilestoneRow; copy: OverviewCopy }) {
  const row = props.row;
  return (
    <Row
      tall
      primary={<TruncatedText text={row.name} />}
      meta={
        <>
          {row.status === null ? null : <span>{row.status}</span>}
          {row.target === null ? null : <span> · {row.target}</span>}
        </>
      }
      trailing={
        row.progress === null ? null : (
          <span className="milestone-counts">
            <ProgressBar done={row.progress.done} total={row.progress.total} />
            <span>{props.copy.milestoneProgress(row.progress.done, row.progress.total)}</span>
          </span>
        )
      }
    />
  );
}

/**
 * The trend card: two cumulative lines, the axis labels, the legend with both
 * totals, the gap note, and the table that carries the same numbers for a reader
 * who cannot use the figure (`design-v1.html:929-945`).
 */
function TrendPanel(props: { series: IssueFlowSeries; copy: OverviewCopy }) {
  const { series, copy } = props;
  return (
    <Panel labelledBy="ms-overview-trend">
      <PanelHead
        id="ms-overview-trend"
        title={copy.trendHeading}
        meta={copy.trendRange(series.firstDate, series.lastDate)}
      />
      <div className="chart-wrap" data-ms-flow="">
        <IssueFlowChart
          points={series.points}
          label={copy.trendChartTitle(series.firstDate, series.lastDate)}
        />
        <div className="chart-note">
          <span>{series.firstDate}</span>
          {/* Two buckets have no distinct middle: labelling the first one twice would
              read as a third date. */}
          {series.middleDate === null ? null : <span>{series.middleDate}</span>}
          <span>{series.lastDate}</span>
        </div>
        <div className="chart-legend">
          <span className="legend-item">
            <span className="legend-swatch" aria-hidden="true" />
            {copy.trendCaptured}
          </span>
          <span className="legend-item">
            <span className="legend-swatch dashed" aria-hidden="true" />
            {copy.trendRetired}
          </span>
          <span className="legend-spacer" />
          <span className="chart-note">{copy.trendLegend(series.datedOpen, series.recordedOpen)}</span>
        </div>
        <p className="chart-note">{copy.trendGap(series.datedOpen, series.undatedEvents)}</p>
        {/* A disclosure, not a chart label: `.chart-note` is the flex row above, and
            reusing it here made this table's summary and body flex items. */}
        <details className="disc">
          <summary>{copy.trendTableSummary}</summary>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{copy.trendColumns.date}</th>
                <th scope="col">{copy.trendColumns.captured}</th>
                <th scope="col">{copy.trendColumns.retired}</th>
                <th scope="col">{copy.trendColumns.open}</th>
                <th scope="col">{copy.trendColumns.origin}</th>
              </tr>
            </thead>
            <tbody>
              {series.points.map((point) => (
                <tr key={point.date}>
                  <td>{point.date}</td>
                  <td>{point.captured}</td>
                  <td>{point.retired}</td>
                  <td>{point.open}</td>
                  <td>{point.origin}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>
    </Panel>
  );
}

export function Overview(props: OverviewProps) {
  const { model, copy } = props;
  return (
    <article className="screen" data-ms-screen="overview">
      {/* The prototype heads every screen with `.screen-head`; a bare h1 falls back to
          the document heading rule and loses the screen-head padding. */}
      <div className="screen-head">
        <h1>{copy.pageTitle}</h1>
        {/* The prototype states the read's scope under the title: which projects, how many
            issues are open. Only when the read carries that count — "0 open issues" on a
            pending or failed read would be a claim about the store, not a summary of it. */}
        {model.issueFlow.kind === "populated" ? (
          <p className="screen-sub" data-ms-screen-sub="">
            {copy.screenSubtitle(copy.screenScopeAll, model.issueFlow.value.recordedOpen)}
          </p>
        ) : null}
      </div>

      <div className="overview-grid">
        {/* The prototype's wide form is two columns (`design-v1.html:317-318`): work and
            its trend left, residuals and milestones right, the iteration across both.
            Below the 900px floor the same sections stack in that reading order. */}
        <div className="ov-col" data-ms-ov-column="">
        {/* 1 — active work. Never dropped, at any height. */}
        <Panel labelledBy="ms-overview-workflows">
                      <PanelHead
              id="ms-overview-workflows"
              title={copy.workflowsHeading}
              meta={
                model.workflows.kind === "populated" && model.workflows.value.length > 0
                  ? copy.workflowMeta(model.workflows.value[0].plansTotal, model.workflows.value[0].status)
                  : undefined
              }
            />
          <PanelBody>
          {model.workflows.kind === "populated" ? (
            <>
              {/* The prototype's panel is one active workflow with its plans beneath it
                  ("Active workflow", singular). Rendering every workflow put the same
                  five-column header on the page once per record; the rest are named in
                  the count line below instead of being dropped silently. */}
              {model.workflows.value.slice(0, 1).map((row) => (
                <WorkflowRowView key={row.id} row={row} copy={copy} onOpenWorkflow={props.onOpenWorkflow} />
              ))}
              {model.workflows.value.length > 1 ? (
                // A span: `t-11` sets only type, so a `<p>` would add the document's
                // paragraph margin under the last workflow.
                <span className="muted t-11" data-ms-workflows-more={model.workflows.value.length - 1}>
                  {copy.workflowsMore?.(model.workflows.value.length - 1) ??
                    `+${model.workflows.value.length - 1}`}
                </span>
              ) : null}
              {/* The member is capped by the engine, so a truncated set has to say so:
                  rows that stop at 50 look like all of them. */}
              {model.workflows.truncated ? (
                <p data-ms-truncated={model.workflows.total}>
                  {copy.workflowsTruncated(model.workflows.shown, model.workflows.total)}
                </p>
              ) : null}
            </>
          ) : (
            <Absence
              arm={model.workflows.kind as AbsenceArm}
              copy={copy}
              heading={copy.workflowsEmpty}
              reason={model.workflows.kind === "unavailable" ? model.workflows.reason : undefined}
              detail={model.workflows.kind === "not-applicable" ? model.workflows.reason : undefined}
            />
          )}
          </PanelBody>
          {/* The prototype's plan table is the PANEL's third child, after the body
              (`panel-head|panel-body|table`), not part of the body's rhythm. */}
          {model.workflows.kind === "populated" && model.workflows.value.length > 0 ? (
            <DataTable
              variant="detail"
              caption={copy.planTableCaption}
              columns={planColumns(copy)}
              rows={model.workflows.value[0].plans}
              rowKey={(plan) => plan.planId}
            />
          ) : null}
        </Panel>

        {/* 2 — the dated history of that work. */}
        {model.issueFlow.kind === "populated" ? (
          <TrendPanel series={model.issueFlow.value} copy={copy} />
        ) : (
          <Panel labelledBy="ms-overview-trend">
            <PanelHead id="ms-overview-trend" title={copy.trendHeading} />
            <PanelBody>
              <div data-ms-flow="">
              <Absence
                arm={model.issueFlow.kind as AbsenceArm}
                copy={copy}
                heading={copy.trendHeading}
                reason={model.issueFlow.kind === "unavailable" ? model.issueFlow.reason : undefined}
                detail={model.issueFlow.kind === "not-applicable" ? model.issueFlow.reason : undefined}
              />
              </div>
            </PanelBody>
          </Panel>
        )}
        </div>

        <div className="ov-col" data-ms-ov-column="">
        {/* 3 — residuals, then 4 — milestones. Never dropped. */}
        <Panel labelledBy="ms-overview-residuals">
          <PanelHead
            id="ms-overview-residuals"
            title={copy.residualsHeading}
            meta={
              model.residuals.kind === "populated"
                ? copy.residualsTotal(model.residuals.value.total)
                : undefined
            }
          />
          <PanelBody>
          {/* The prototype's compact tally (`design-v1.html:2424-2434`): five severity
              rows in a two-column grid — critical/high, medium/low, nit — severity on the
              left with its dot, count right-aligned. The row label is the literal enum:
              contract values stay English and untranslated so they can be copied into the
              CLI. `data-ms-severity` is the hook for anything presentational. */}
          {model.residuals.kind === "populated" ? (
            <dl className="res-grid" data-ms-residuals="">
              {model.residuals.value.rows.map((row) => (
                <div
                  key={row.severity}
                  className="res-row"
                  data-ms-severity={row.severity}
                  data-ms-count={row.count}
                  // The prototype makes this row a link to the severity-filtered issue
                  // list. A `dl` may only hold `dt`/`dd`/`div`, so the click target is the
                  // wrapper with a link role rather than an `<a>`.
                  {...(props.onOpenIssues === undefined
                    ? {}
                    : {
                        role: "link",
                        tabIndex: 0,
                        onClick: () => props.onOpenIssues?.(row.severity),
                        onKeyDown: (event: KeyboardEvent) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            props.onOpenIssues?.(row.severity);
                          }
                        },
                      })}
                >
                  <dt className="sev">
                    <StatusDot label={row.severity} tone={row.tone} mono />
                  </dt>
                  <dd className={row.emphasised ? "num is-strong" : "num"}>{row.count}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <Absence
              arm={model.residuals.kind as AbsenceArm}
              copy={copy}
              heading={copy.residualsHeading}
              reason={model.residuals.kind === "unavailable" ? model.residuals.reason : undefined}
              detail={model.residuals.kind === "not-applicable" ? model.residuals.reason : undefined}
            />
          )}
          </PanelBody>
        </Panel>

        {/* 3 — milestones, before the iteration: the prototype's sidebar order. */}
        <Panel labelledBy="ms-overview-milestones">
          <PanelHead id="ms-overview-milestones" title={copy.milestonesHeading} />
          <PanelBody>
          {model.milestones.kind === "populated" ? (
            props.compact === true ? (
              <div className="screen-meta" data-ms-milestone-summary="">
                {copy.milestonesSummary(
                  model.milestones.value.length,
                  model.milestones.value.reduce((open, row) => open + row.openIssues, 0),
                )}
              </div>
            ) : (
              <div data-ms-milestones="">
                {model.milestones.value.map((row) => (
                  <MilestoneRowView key={row.milestoneId} row={row} copy={copy} />
                ))}
              </div>
            )
          ) : (
            <Absence
              arm={model.milestones.kind as AbsenceArm}
              copy={copy}
              heading={copy.milestonesHeading}
              reason={model.milestones.kind === "unavailable" ? model.milestones.reason : undefined}
              detail={model.milestones.kind === "not-applicable" ? model.milestones.reason : undefined}
            />
          )}
          </PanelBody>
        </Panel>

        </div>

        <div className="ov-iteration" data-ms-ov-spanning="">
        <Panel labelledBy="ms-overview-iteration">
          <PanelHead id="ms-overview-iteration" title={copy.iterationHeading} />
          <PanelBody>
          {model.latestIteration.kind === "populated" ? (
            model.latestIteration.value === null ? (
              <Absence arm="empty" copy={copy} heading={copy.iterationNoIteration} />
            ) : (
              <div className="milestone-block" data-ms-iteration="">
                <div className="milestone-block-id">
                  <TruncatedText text={model.latestIteration.value.iterationId} />
                </div>
                <ol className="gate-track" data-ms-gate-steps="">
                  {model.latestIteration.value.steps.map((step) => (
                    <li
                      key={step.id}
                      className="gate-step"
                      data-ms-step={step.id}
                      data-ms-step-position={step.position satisfies GateStepPosition}
                    >
                      {copy.gateStep(step.step, 5)}
                    </li>
                  ))}
                </ol>
                {model.latestIteration.value.gatePosition === null ? null : (
                  // A span, as the prototype has it: `.gate-meta` is inline-flex and does
                  // not reset margin, so a `<p>` would carry the document's paragraph
                  // margin into the track.
                  <span className="gate-meta">
                    {copy.gateStep(
                      model.latestIteration.value.gatePosition.step,
                      model.latestIteration.value.gatePosition.of,
                    )}
                  </span>
                )}
              </div>
            )
          ) : (
            <Absence
              arm={model.latestIteration.kind as AbsenceArm}
              copy={copy}
              heading={copy.iterationHeading}
              reason={model.latestIteration.kind === "unavailable" ? model.latestIteration.reason : undefined}
              detail={model.latestIteration.kind === "not-applicable" ? model.latestIteration.reason : undefined}
            />
          )}
          </PanelBody>
        </Panel>
        </div>
      </div>

      {/* 6 — the one page-validity fact. Never dropped, and stated in the prototype's
          own line: `.identity-line` is a hairline-topped mono row, not a muted sentence
          under the grid. */}
      <div className="identity-line" data-ms-projection={model.projection.kind}>
        {props.identity === undefined ? null : (
          <>
            <span>{props.identity.packageName}</span>
            <b className="id-strong">v{props.identity.version}</b>
            <span className="sep" aria-hidden="true">
              ·
            </span>
            {props.identity.harnessDir === undefined ? null : (
              <>
                <span className="id-strong">{props.identity.harnessDir}</span>
                <span className="sep" aria-hidden="true">
                  ·
                </span>
              </>
            )}
          </>
        )}
        <span>{copy.projection[model.projection.kind]}</span>
        {/* The prototype ends the line with when the projection was built and when this
            read happened. Both are facts about the read, not counters. */}
        <span className="sep" aria-hidden="true">
          ·
        </span>
        <span data-ms-projection-built={model.projection.builtAt ?? undefined}>
          {model.projection.builtAt === null
            ? copy.identityBuiltUnknown
            : copy.identityBuilt(formatClock(model.projection.builtAt))}
        </span>
        <span className="sep" aria-hidden="true">
          ·
        </span>
        <span data-ms-projection-read="">
          {copy.identityRead(formatClock(model.projection.checkedAt))}
        </span>
      </div>
      {model.projection.kind === "current" ? null : (
        <Notice reason={model.projection.reasons.join(" · ")} tone="warning" />
      )}
    </article>
  );
}
