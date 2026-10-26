/**
 * `IterationDetail` — one iteration (IA §8.2).
 *
 * Renders: catalog identity, execution (the linked workflow), the compass status
 * and its summary, the **gate step (1–4 of 5)**, the plan table, the dates.
 *
 * Not rendered, asserted negatively: the `documents` inventory and its count, the
 * compass milestone-id list (the roadmap feature owns milestones — repeating the
 * ids here would be a second, weaker view of the same thing), and every counter
 * (`storeRevision`, `catalogRevision`, `builtAt`, `checkedAt`).
 *
 * **The gate display is four labels plus a never-marked fifth** (compass D29).
 * Step 5 is merge, the merge happens outside the harness, and no store row records
 * it — so the fifth step renders as not-yet-reached forever, which is the truth.
 * No violation count is rendered either: it needs `evaluatePhaseGate` over
 * documents plus git-probed branch values, a dashboard view may not read files,
 * and the product authority does not ask for it.
 */
import { DataTable, type DataTableColumn } from "../components/DataTable.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Field } from "../components/Field.tsx";
import { FieldGroup } from "../components/FieldGroup.tsx";
import { StatusDot } from "../components/StatusDot.tsx";
import { TruncatedText } from "../components/TruncatedText.tsx";
import type { IterationDetailModel, IterationPlanRow } from "../view-model/iterations.ts";
import type { Resolved } from "../view-model/state.ts";
import type { GateStepId, GateStepPosition, Tone } from "../view-model/status.ts";

/** Every visible string this screen needs. Task 5 supplies them. */
export type IterationDetailCopy = {
  breadcrumb: { label: string; current: string };
  compassHeading: string;
  planTableHeading: string;
  catalogHeading: string;
  executionHeading: string;
  fields: {
    id: string;
    title: string;
    lifecycle: string;
    root: string;
    compassStatus: string;
    startedAt: string;
    endedAt: string;
    workflow: string;
    noWorkflow: string;
    noCompass: string;
    noSummary: string;
    notStarted: string;
  };
  /** `step N of 5` — the delivery position line. */
  gateStep: (step: number, of: number) => string;
  /** The label under each gate step; five entries, the fifth is never reached. */
  gateStepLabels: Record<GateStepId, string>;
  gateNoCompass: string;
  planColumns: { planId: string; title: string; status: string; progress: string; doneAt: string };
  planProgressAbsent: string;
  unavailable: { labelWord: string; heading: string; body: string };
  absent: { labelWord: string; heading: string; body: string; pointer: string };
};

export type IterationDetailProps = {
  model: Resolved<IterationDetailModel>;
  copy: IterationDetailCopy;
  onBack?: () => void;
  onOpenWorkflow?: (id: string) => void;
};

/** The plan table's columns. */
function planColumns(copy: IterationDetailCopy): DataTableColumn<IterationPlanRow>[] {
  return [
    { key: "planId", header: copy.planColumns.planId, render: (plan) => <span className={"mono"}>{plan.planId}</span> },
    {
      key: "title",
      header: copy.planColumns.title,
      secondary: true,
      render: (plan) =>
        plan.title === null ? <span className={"muted"}>{copy.fields.noWorkflow}</span> : <TruncatedText text={plan.title} />,
    },
    {
      key: "status",
      header: copy.planColumns.status,
      render: (plan) => (
        <span>
          {plan.status === null ? (
            <span className={"muted"}>{copy.fields.notStarted}</span>
          ) : (
            <StatusDot label={plan.status} tone={plan.statusTone} mono />
          )}
          {plan.phase === null ? null : <span className={"chip"}>{plan.phase}</span>}
        </span>
      ),
    },
    {
      key: "progress",
      header: copy.planColumns.progress,
      secondary: true,
      render: (plan) =>
        plan.progress === null ? (
          <span className={"muted"} data-ms-plan-progress-absent="">
            {copy.planProgressAbsent}
          </span>
        ) : (
          <span className={"milestone-counts"}>
            <TruncatedText text={plan.progress} />
          </span>
        ),
    },
    {
      key: "doneAt",
      header: copy.planColumns.doneAt,
      secondary: true,
      align: "end",
      render: (plan) => <span className={"mono"}>{plan.doneAt ?? "—"}</span>,
    },
  ];
}

/** The populated page. A separate component so the record is a value, not a
 * union member the JSX has to re-narrow inside every callback. */
function IterationDetailBody(props: {
  value: IterationDetailModel;
  copy: IterationDetailCopy;
  onOpenWorkflow?: (id: string) => void;
}) {
  const { value, copy } = props;

  return (
    <>
          <header className={"screen-head"}>
            <h1>
              <TruncatedText text={value.iterationId} />
            </h1>
          </header>

          <FieldGroup title={copy.catalogHeading}>
            <Field label={copy.fields.title}>{value.title ?? copy.fields.noWorkflow}</Field>
            <Field label={copy.fields.lifecycle} mono>
              {value.lifecycle ?? "—"}
            </Field>
            <Field label={copy.fields.startedAt} mono>
              {value.startedAt}
            </Field>
            <Field label={copy.fields.endedAt} mono>
              {value.endedAt ?? "—"}
            </Field>
          </FieldGroup>

          <FieldGroup title={copy.executionHeading}>
            <Field label={copy.fields.workflow} mono>
              {value.workflowId === null ? (
                copy.fields.noWorkflow
              ) : props.onOpenWorkflow === undefined ? (
                value.workflowId
              ) : (
                <button
                  type="button"
                  className={"breadcrumb"}
                  onClick={() => {
                    if (value.workflowId !== null) props.onOpenWorkflow?.(value.workflowId);
                  }}
                >
                  {value.workflowId}
                </button>
              )}
            </Field>
          </FieldGroup>

          <FieldGroup title={copy.compassHeading} columns={1}>
            <Field label={copy.fields.compassStatus} mono>
              {value.compassStatus === null ? (
                <span className={"muted"}>{copy.fields.noCompass}</span>
              ) : (
                <StatusDot label={value.compassStatus} tone={value.compassTone} mono />
              )}
            </Field>
            <Field label={copy.fields.title}>
              {value.summary === null ? (
                <span className={"muted"}>{copy.fields.noSummary}</span>
              ) : (
                <span data-ms-compass-summary="">{value.summary}</span>
              )}
            </Field>
          </FieldGroup>

          {/* The delivery position: four labels, plus a fifth that is never
              marked. The position rides on an attribute too, so the state does
              not depend on the colour. */}
          <section className={"gate"} aria-labelledby="ms-iteration-gate">
            <h2 id="ms-iteration-gate">
              {value.gatePosition === null
                ? copy.gateNoCompass
                : copy.gateStep(value.gatePosition.step, value.gatePosition.of)}
            </h2>
            <ol className={"gate-track"} data-ms-gate-steps="">
              {value.steps.map((step) => (
                <li
                  key={step.id}
                  className={"gate-step"}
                  data-ms-step={step.id}
                  data-ms-step-position={step.position satisfies GateStepPosition}
                >
                  <span className={"gate-step-mark"} aria-hidden="true" />
                  <span className={"gate-step-label"}>{copy.gateStepLabels[step.id]}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className={"table"} aria-labelledby="ms-iteration-plans">
            <h2 id="ms-iteration-plans">
              {copy.planTableHeading}
            </h2>
            <DataTable
              variant="detail"
              caption={copy.planTableHeading}
              columns={planColumns(copy)}
              rows={value.plans}
              rowKey={(plan) => plan.planId}
            />
          </section>
        </>
  );
}

export function IterationDetail(props: IterationDetailProps) {
  const { copy, model } = props;
  return (
    <article className={"screen"} data-ms-screen="iteration-detail">
      <nav className={"breadcrumb"} aria-label={copy.breadcrumb.label}>
        {props.onBack === undefined ? null : (
          <button type="button" className={"breadcrumb"} onClick={props.onBack}>
            {copy.breadcrumb.current}
          </button>
        )}
      </nav>

      {model.kind === "populated" ? (
        <IterationDetailBody value={model.value} copy={copy} onOpenWorkflow={props.onOpenWorkflow} />
      ) : model.kind === "loading" ? null : (
        <EmptyState
          arm={model.kind}
          labelWord={model.kind === "absent" ? copy.absent.labelWord : copy.unavailable.labelWord}
          heading={model.kind === "absent" ? copy.absent.heading : copy.unavailable.heading}
          body={model.kind === "absent" ? copy.absent.body : copy.unavailable.body}
          pointer={model.kind === "absent" ? copy.absent.pointer : undefined}
          reason={model.kind === "unavailable" ? model.reason : undefined}
        />
      )}
    </article>
  );
}
