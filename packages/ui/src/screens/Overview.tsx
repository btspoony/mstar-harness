/**
 * `Overview` — the product's landing page (IA §2, §3.1).
 *
 * It answers three questions in the first viewport, in this order: **is work
 * running** (every active workflow with its plan progress), **is anything broken
 * and how bad** (five severity rows, zeros included, with a reconciling total),
 * and **where is delivery** (the latest iteration's five gate steps with the one
 * the store proves marked). Milestones follow, and the projection state closes
 * the page — the only survivor of the identity line D30 removed.
 *
 * Not here, by construction and by test: the issue-flow trend, the version,
 * `{HARNESS_DIR}`, any revision counter, and any history. The aggregate read
 * still carries `issueFlow`; `overviewModel` never reads it and this component
 * has no prop that could render it.
 *
 * Every absence goes through `state.ts` — the model already resolved each member
 * to one of the six arms, and `Absence` here only chooses the copy. A screen that
 * decided an arm itself would be a second authority.
 */
import { EmptyState, type AbsenceArm } from "../components/EmptyState.tsx";
import { Notice } from "../components/Notice.tsx";
import { Panel, PanelBody, PanelHead } from "../components/Panel.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { Row } from "../components/Row.tsx";
import { StatusDot } from "../components/StatusDot.tsx";
import { TruncatedText } from "../components/TruncatedText.tsx";
import type { OverviewModel, MilestoneRow, OverviewWorkflowRow } from "../view-model/overview.ts";
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

/** One active workflow: id, kind, phase, done/total, status dot. No board here. */
function WorkflowRowView(props: { row: OverviewWorkflowRow; copy: OverviewCopy }) {
  const row = props.row;
  return (
    <Row
      primary={<TruncatedText text={row.id} />}
      meta={
        <>
          <span>{row.type}</span>
          {row.phase === null ? null : <span> · {row.phase}</span>}
        </>
      }
      trailing={props.copy.plansProgress(row.plansDone, row.plansTotal)}
      leading={<StatusDot label={row.status} tone={row.statusTone} />}
    />
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

export function Overview(props: OverviewProps) {
  const { model, copy } = props;
  return (
    <article className={css.page} data-ms-screen="overview">
      <h1 className={css.title}>{copy.pageTitle}</h1>

      <div className={css.body}>
        {/* 1 — active work. Never dropped, at any height. */}
        <Panel labelledBy="ms-overview-workflows">
          <PanelHead id="ms-overview-workflows" title={copy.workflowsHeading} />
          <PanelBody>
          {model.workflows.kind === "populated" ? (
            <div className={css.rows} data-ms-workflows="">
              {model.workflows.value.map((row) => (
                <WorkflowRowView key={row.id} row={row} copy={copy} />
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

        {/* 2 — residuals, then 3 — delivery. Never dropped. */}
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
            <div className={css.residuals} data-ms-residuals="">
              {model.residuals.value.rows.map((row) => (
                <div
                  key={row.severity}
                  className={css.residualRow}
                  data-ms-severity={row.severity}
                  data-ms-count={row.count}
                >
                  <span className={css.residualSeverity}>
                    <StatusDot label={row.severity} tone={row.tone} mono />
                  </span>
                  <span className={row.emphasised ? css.countEmphasised : css.count}>{row.count}</span>
                </div>
              ))}
            </div>
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

      {/* 5 — the one page-validity fact. Never dropped. */}
      <p className={css.projection} data-ms-projection={model.projection.kind}>
        {copy.projection[model.projection.kind]}
      </p>
      {model.projection.kind === "current" ? null : (
        <Notice reason={model.projection.reasons.join(" · ")} tone="warning" />
      )}
    </article>
  );
}
