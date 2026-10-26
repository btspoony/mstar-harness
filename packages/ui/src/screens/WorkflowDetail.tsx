/**
 * `WorkflowDetail` — one workflow, execution plus its plan table (IA §8.2).
 *
 * Renders: type, status · phase, started / ended / updated, the four branch
 * anchors (`base → source → integration → target`), the catalog identity, the
 * `execution-unavailable` reason where it applies, and the plan table (plan id,
 * title, status · phase, **recorded progress**, done date).
 *
 * Not rendered, and asserted negatively: plan leases (kind, holder, worktree,
 * expiry), the terminal-adoption audit rows (`lifecycle_adopted_at`, reason,
 * actor session, operation), and the catalog-pin badges. The first two are runtime
 * internals and an audit trail; the pin badges are join bookkeeping. The one
 * badge that stays is `execution-unavailable`, because it explains a degradation.
 *
 * The progress column is the plan's **recorded** progress — the coordinator's own
 * note. It is never a parsed checklist entry and the copy must never promise "the
 * first uncompleted step" (compass D26): the store carries no checklist and the
 * view contract forbids reading the plan file.
 */
import { Fragment } from "react";
import { DataTable, type DataTableColumn } from "../components/DataTable.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Field } from "../components/Field.tsx";
import { FieldGroup } from "../components/FieldGroup.tsx";
import { Notice } from "../components/Notice.tsx";
import { StatusDot } from "../components/StatusDot.tsx";
import { TruncatedText } from "../components/TruncatedText.tsx";
import type { WorkflowDetailModel, WorkflowPlanRow } from "../view-model/workflows.ts";
import type { Resolved } from "../view-model/state.ts";
import type { Tone } from "../view-model/status.ts";

/** Every visible string this screen needs. Task 5 supplies them. */
export type WorkflowDetailCopy = {
  breadcrumb: { label: string; current: string };
  executionHeading: string;
  planTableHeading: string;
  catalogHeading: string;
  fields: {
    id: string;
    type: string;
    status: string;
    phase: string;
    startedAt: string;
    endedAt: string;
    updatedAt: string;
    branchBase: string;
    branchSource: string;
    branchIntegration: string;
    branchTarget: string;
    root: string;
    title: string;
    lifecycle: string;
    documentKind: string;
    notStarted: string;
    noCatalog: string;
  };
  planColumns: { planId: string; title: string; status: string; progress: string; doneAt: string };
  /** The plan records no progress note — its own absent line. */
  planProgressAbsent: string;
  executionUnavailableLead: string;
  /** The four absence arms, each with its own copy family (IA §5). */
  absence: {
    "not-applicable": { labelWord: string; heading: string; body: string };
    absent: { labelWord: string; heading: string; body: string; pointer: string };
    empty: { labelWord: string; heading: string; body: string; hint: string };
    unavailable: { labelWord: string; heading: string; body: string };
  };
};

export type WorkflowDetailProps = {
  model: Resolved<WorkflowDetailModel>;
  copy: WorkflowDetailCopy;
  onBack?: () => void;
};

/** The plan table's columns: identity, status · phase, recorded progress, done. */
function planColumns(copy: WorkflowDetailCopy): DataTableColumn<WorkflowPlanRow>[] {
  return [
    { key: "planId", header: copy.planColumns.planId, render: (plan) => <span className={"mono"}>{plan.planId}</span> },
    {
      key: "title",
      header: copy.planColumns.title,
      secondary: true,
      render: (plan) =>
        plan.title === null ? <span className={"muted"}>{copy.fields.noCatalog}</span> : <TruncatedText text={plan.title} />,
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
          <span className={"milestone-counts"} data-ms-plan-progress="">
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

export function WorkflowDetail(props: WorkflowDetailProps) {
  const { copy } = props;

  return (
    <article className={"screen"} data-ms-screen="workflow-detail">
      <nav className={"breadcrumb"} aria-label={copy.breadcrumb.label}>
        {props.onBack === undefined ? null : (
          <button type="button" className={"breadcrumb"} onClick={props.onBack}>
            {copy.breadcrumb.current}
          </button>
        )}
      </nav>

      {props.model.kind === "populated" ? (
        <>
          <header className="detail-head">
            <h1 className="detail-title">
              <TruncatedText text={props.model.value.workflow.id} />
            </h1>
          </header>

          {/* The degradation reason, stated where it applies and nowhere else. */}
          {props.model.value.executionUnavailableReason === null ? null : (
            <Notice reason={props.model.value.executionUnavailableReason} lead={copy.executionUnavailableLead} tone="warning" />
          )}

          <FieldGroup title={copy.executionHeading}>
            <Field label={copy.fields.id} mono>
              {props.model.value.workflow.id}
            </Field>
            <Field label={copy.fields.type} mono>
              {props.model.value.workflow.type}
            </Field>
            <Field label={copy.fields.status} mono>
              {props.model.value.workflow.status}
            </Field>
            <Field label={copy.fields.phase} mono>
              {props.model.value.workflow.phase ?? "—"}
            </Field>
            <Field label={copy.fields.startedAt} mono>
              {props.model.value.startedAt}
            </Field>
            <Field label={copy.fields.endedAt} mono>
              {props.model.value.endedAt ?? "—"}
            </Field>
            <Field label={copy.fields.updatedAt} mono>
              {props.model.value.updatedAt}
            </Field>
          </FieldGroup>

          {/* The four anchors, in delivery order, as one chain and as fields. */}
          <FieldGroup title={copy.fields.branchBase}>
            <Field label={copy.fields.branchBase} mono>
              {props.model.value.workflow.branch.base ?? "—"}
            </Field>
            <Field label={copy.fields.branchSource} mono>
              {props.model.value.workflow.branch.source ?? "—"}
            </Field>
            <Field label={copy.fields.branchIntegration} mono>
              {props.model.value.workflow.branch.integration ?? "—"}
            </Field>
            <Field label={copy.fields.branchTarget} mono>
              {props.model.value.workflow.branch.target ?? "—"}
            </Field>
          </FieldGroup>

          {/* The prototype's chain: one anchor per label with an arrow between them. A
              joined string gives the line a single item and no arrows to style. */}
          <div className={"branch-line"} data-ms-branch-chain="">
            {[
              // Labels come from copy, like every other string on this screen: the
              // fields block below already uses them, and a hardcoded English label
              // would mix languages in a localized build.
              [copy.fields.branchBase, props.model.value.workflow.branch.base] as const,
              [copy.fields.branchSource, props.model.value.workflow.branch.source] as const,
              [copy.fields.branchIntegration, props.model.value.workflow.branch.integration] as const,
              [copy.fields.branchTarget, props.model.value.workflow.branch.target] as const,
            ].map(([label, value], index) => (
              <Fragment key={label}>
                {index === 0 ? null : <span className="branch-arrow" aria-hidden="true">→</span>}
                <span className="branch-anchor">
                  <span>{label}</span> <b>{value ?? "—"}</b>
                </span>
              </Fragment>
            ))}
          </div>

          <FieldGroup title={copy.catalogHeading}>
            {props.model.value.catalog === null ? (
              <Field label={copy.fields.title}>{copy.fields.noCatalog}</Field>
            ) : (
              <>
                <Field label={copy.fields.title}>{props.model.value.catalog.title}</Field>
                <Field label={copy.fields.root} mono>
                  {props.model.value.catalog.root}
                </Field>
                <Field label={copy.fields.lifecycle} mono>
                  {props.model.value.catalog.lifecycle}
                </Field>
                <Field label={copy.fields.documentKind} mono>
                  {props.model.value.catalog.documentKind ?? "—"}
                </Field>
              </>
            )}
          </FieldGroup>

          <section className="panel" aria-labelledby="ms-workflow-plans">
            <div className="panel-head">
              <h2 className="panel-title" id="ms-workflow-plans">
                {copy.planTableHeading}
              </h2>
            </div>
            <DataTable
              variant="detail"
              caption={copy.planTableHeading}
              columns={planColumns(copy)}
              rows={props.model.value.plans}
              rowKey={(plan) => plan.planId}
            />
          </section>
        </>
      ) : props.model.kind === "loading" ? null : props.model.kind === "absent" ? (
        <EmptyState
          arm="absent"
          labelWord={copy.absence.absent.labelWord}
          heading={copy.absence.absent.heading}
          body={copy.absence.absent.body}
          pointer={copy.absence.absent.pointer}
        />
      ) : props.model.kind === "empty" ? (
        <EmptyState
          arm="empty"
          labelWord={copy.absence.empty.labelWord}
          heading={copy.absence.empty.heading}
          body={copy.absence.empty.body}
          hint={copy.absence.empty.hint}
        />
      ) : props.model.kind === "not-applicable" ? (
        <EmptyState
          arm="not-applicable"
          labelWord={copy.absence["not-applicable"].labelWord}
          heading={copy.absence["not-applicable"].heading}
          body={copy.absence["not-applicable"].body}
          detail={props.model.reason}
        />
      ) : (
        <EmptyState
          arm="unavailable"
          labelWord={copy.absence.unavailable.labelWord}
          heading={copy.absence.unavailable.heading}
          body={copy.absence.unavailable.body}
          reason={props.model.reason}
        />
      )}
    </article>
  );
}
