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
import { Fragment } from "react";

import { DataTable, type DataTableColumn } from "../components/DataTable.tsx";
import { progressText } from "../view-model/format.ts";
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
import css from "./Overview.module.css";

/** Every visible string this screen needs. Task 5 supplies them. */
export type OverviewCopy = {
  pageTitle: string;
  workflowsHeading: string;
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
      width: 176,
      render: (plan) => <span className={css.mono}>{plan.planId}</span>,
    },
    {
      key: "title",
      header: copy.planColumns.title,
      render: (plan) =>
        plan.title === null ? <span className={css.muted}>{copy.dash}</span> : <TruncatedText text={plan.title} />,
    },
    {
      key: "status",
      header: copy.planColumns.status,
      width: 132,
      render: (plan) =>
        plan.status === null ? (
          <span className={css.muted}>{copy.planStatusAbsent}</span>
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
          <span className={plan.progressNote === null ? css.muted : css.progressNote}>
            {plan.progressNote ?? copy.planProgressAbsent}
          </span>
        ) : (
          <span className={css.planProgress}>
            <span className={css.mono}>{progressText(plan.progress)}</span>
            <ProgressBar done={plan.progress.done} total={plan.progress.total} />
          </span>
        ),
    },
    {
      key: "done",
      header: copy.planColumns.done,
      width: 72,
      align: "end",
      render: (plan) => <span className={css.doneCell}>{plan.doneAt ?? copy.dash}</span>,
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
  return (
    <section className={css.workflow} data-ms-overview-workflow="">
      <div className={css.wfSummary}>
        <span className={css.wfId}>{row.id}</span>
        <span className={css.muted}>{copy.typeLabel}</span>
        <span className={css.chip}>{row.type}</span>
        {row.phase === null ? null : <StatusDot label={row.phase} tone="neutral" mono />}
        {props.onOpenWorkflow === undefined ? null : (
          <button type="button" className={css.link} onClick={() => props.onOpenWorkflow?.(row.id)}>
            {copy.openWorkflow}
          </button>
        )}
      </div>
      <p className={css.wfMeta} data-ms-workflow-meta={row.plansTotal}>
        {copy.workflowMeta(row.plansTotal, row.status)}
      </p>
      {drawn.length === 0 ? null : (
        <p className={css.branchLine} data-ms-branch="">
          {drawn.map(([label, value], index) => (
            <Fragment key={label}>
              {index === 0 ? null : <span className={css.branchArrow} aria-hidden="true">→</span>}
              <span className={css.branchAnchor}>
                <span className={css.muted}>{label}</span> <b>{value}</b>
              </span>
            </Fragment>
          ))}
        </p>
      )}
      <DataTable
        variant="detail"
        caption={copy.planTableCaption}
        columns={planColumns(copy)}
        rows={row.plans}
        rowKey={(plan) => plan.planId}
      />
    </section>
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
          <span className={css.milestoneProgress}>
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
      <PanelBody>
        <div className={css.trend} data-ms-flow="">
          <IssueFlowChart
            points={series.points}
            label={copy.trendChartTitle(series.firstDate, series.lastDate)}
          />
          <div className={css.axis}>
            <span>{series.firstDate}</span>
            {/* Two buckets have no distinct middle: labelling the first one twice would
                read as a third date. */}
            {series.middleDate === null ? null : <span>{series.middleDate}</span>}
            <span>{series.lastDate}</span>
          </div>
          <div className={css.legend}>
            <span className={css.legendItem}>
              <span className={css.swatch} aria-hidden="true" />
              {copy.trendCaptured}
            </span>
            <span className={css.legendItem}>
              <span className={`${css.swatch} ${css.swatchDashed}`} aria-hidden="true" />
              {copy.trendRetired}
            </span>
            <span className={css.legendSpacer} />
            <span className={css.legendMeta}>{copy.trendLegend(series.datedOpen, series.recordedOpen)}</span>
          </div>
          <p className={css.note}>{copy.trendGap(series.datedOpen, series.undatedEvents)}</p>
          <details className={css.disclosure}>
            <summary className={css.disclosureSummary}>{copy.trendTableSummary}</summary>
            <table className={css.flowTable}>
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
      </PanelBody>
    </Panel>
  );
}

export function Overview(props: OverviewProps) {
  const { model, copy } = props;
  return (
    <article className={css.page} data-ms-screen="overview">
      <h1 className={css.title}>{copy.pageTitle}</h1>

      <div className={css.body}>
        {/* The prototype's wide form is two columns (`design-v1.html:317-318`): work and
            its trend left, residuals and milestones right, the iteration across both.
            Below the 900px floor the same sections stack in that reading order. */}
        <div className={css.column} data-ms-ov-column="">
        {/* 1 — active work. Never dropped, at any height. */}
        <Panel labelledBy="ms-overview-workflows">
          <PanelHead id="ms-overview-workflows" title={copy.workflowsHeading} />
          <PanelBody>
          {model.workflows.kind === "populated" ? (
            <div className={css.rows} data-ms-workflows="">
              {model.workflows.value.map((row) => (
                <WorkflowRowView key={row.id} row={row} copy={copy} onOpenWorkflow={props.onOpenWorkflow} />
              ))}
              {/* The member is capped by the engine, so a truncated set has to say so:
                  rows that stop at 50 look like all of them. */}
              {model.workflows.truncated ? (
                <p className={css.truncated} data-ms-truncated={model.workflows.total}>
                  {copy.workflowsTruncated(model.workflows.shown, model.workflows.total)}
                </p>
              ) : null}
            </div>
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

        <div className={css.column} data-ms-ov-column="">
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
            <dl className={css.residuals} data-ms-residuals="">
              {model.residuals.value.rows.map((row) => (
                <div
                  key={row.severity}
                  className={css.residualRow}
                  data-ms-severity={row.severity}
                  data-ms-count={row.count}
                >
                  <dt className={css.residualSeverity}>
                    <StatusDot label={row.severity} tone={row.tone} mono />
                  </dt>
                  <dd className={row.emphasised ? css.countEmphasised : css.count}>{row.count}</dd>
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
              <p className={css.summary} data-ms-milestone-summary="">
                {copy.milestonesSummary(
                  model.milestones.value.length,
                  model.milestones.value.reduce((open, row) => open + row.openIssues, 0),
                )}
              </p>
            ) : (
              <div className={css.rows} data-ms-milestones="">
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

        <div className={css.spanning} data-ms-ov-spanning="">
        <Panel labelledBy="ms-overview-iteration">
          <PanelHead id="ms-overview-iteration" title={copy.iterationHeading} />
          <PanelBody>
          {model.latestIteration.kind === "populated" ? (
            model.latestIteration.value === null ? (
              <Absence arm="empty" copy={copy} heading={copy.iterationNoIteration} />
            ) : (
              <div className={css.iteration} data-ms-iteration="">
                <p className={css.iterationId}>
                  <TruncatedText text={model.latestIteration.value.iterationId} />
                </p>
                <ol className={css.steps} data-ms-gate-steps="">
                  {model.latestIteration.value.steps.map((step) => (
                    <li
                      key={step.id}
                      className={css.step}
                      data-ms-step={step.id}
                      data-ms-step-position={step.position satisfies GateStepPosition}
                    >
                      {copy.gateStep(step.step, 5)}
                    </li>
                  ))}
                </ol>
                {model.latestIteration.value.gatePosition === null ? null : (
                  <p className={css.gateLine}>
                    {copy.gateStep(
                      model.latestIteration.value.gatePosition.step,
                      model.latestIteration.value.gatePosition.of,
                    )}
                  </p>
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

      {/* 6 — the one page-validity fact. Never dropped. */}
      <p className={css.projection} data-ms-projection={model.projection.kind}>
        {copy.projection[model.projection.kind]}
      </p>
      {model.projection.kind === "current" ? null : (
        <Notice reason={model.projection.reasons.join(" · ")} tone="warning" />
      )}
    </article>
  );
}
