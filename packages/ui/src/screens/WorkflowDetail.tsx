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
  /** The chain's short labels (`Base`), distinct from the fields block's longer ones. */
  breadcrumb: { label: string; root: string; current: string };
  executionHeading: string;
  planTableHeading: string;
  catalogHeading: string;
  /** `updated <when>` — the head's last meta fact. */
  updatedMeta: (when: string) => string;
  /** The chip beside the title: the store still counts this as a registration. */
  activeRegistration: string;
  /** The prototype's Leases card. */
  leasesHeading: string;
  leasesCount: (n: number) => string;
  leasesEmpty: string;
  leaseColumns: { plan: string; kind: string; holder: string; worktree: string; expires: string };
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
    /** The catalog's revision counter and the two dates it records. */
    revision: string;
    registeredAt: string;
    catalogUpdatedAt: string;
    description: string;
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
      {/* The prototype's breadcrumb is `Workflows / <id>`: the section as a link back, the
          record itself as mono text. A `div`, not a `nav` — it has one link and a label. */}
      <div className={"breadcrumb"} aria-label={copy.breadcrumb.label}>
        {/* Always shown: the prototype's crumb is `Workflows / <id>` on every render. A
            host that passes no `onBack` gets the section as text, not a missing crumb. */}
        {props.onBack === undefined ? (
          <span>{copy.breadcrumb.root}</span>
        ) : (
          <button type="button" className={"link"} onClick={props.onBack}>
            {copy.breadcrumb.root}
          </button>
        )}
        <span aria-hidden="true">/</span>
        <span className={"mono"}>{props.model.kind === "populated" ? props.model.value.workflow.id : copy.breadcrumb.current}</span>
      </div>

      {props.model.kind === "populated" ? (
        <>
          <header className="detail-head">
            <div className="detail-head-main">
              <h1 className="detail-title mono">
                <TruncatedText text={props.model.value.workflow.id} />
              </h1>
              {/* The prototype's meta line: what it is, how it is doing, which phase,
                  and when the projection last touched it. */}
              <div className="detail-meta">
                <span className="mono">{props.model.value.workflow.type}</span>
                <span aria-hidden="true">·</span>
                <span className={`status tone-${props.model.value.workflow.statusTone} is-strong`}>
                  <span className="dot" aria-hidden="true" />
                  <span className="label mono">{props.model.value.workflow.status}</span>
                </span>
                {props.model.value.workflow.phase === null ? null : (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="mono">{props.model.value.workflow.phase}</span>
                  </>
                )}
                <span aria-hidden="true">·</span>
                <span>{copy.updatedMeta(props.model.value.workflow.updatedAt)}</span>
              </div>
            </div>
            <div className="detail-actions">
              {/* The prototype's chip asserts the store still counts this workflow as an
                  active registration. That is a fact about the record, so it renders only
                  when the store says so — an unregistered workflow must not claim it. */}
              {props.model.value.workflow.activeRegistration ? (
                <span className="chip" data-ms-registration>
                  {copy.activeRegistration}
                </span>
              ) : null}
            </div>
          </header>

          {/* The degradation reason, stated where it applies and nowhere else. */}
          {props.model.value.executionUnavailableReason === null ? null : (
            <Notice reason={props.model.value.executionUnavailableReason} lead={copy.executionUnavailableLead} tone="warning" />
          )}

          <div className="detail-top">
          <section className="panel" aria-labelledby="ms-workflow-execution">
            <div className="panel-head">
              <h2 className="panel-title" id="ms-workflow-execution">
                {copy.executionHeading}
              </h2>
            </div>
            <div className="panel-body">
              <dl className="fields">
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
              </dl>
            </div>
          </section>


          <section className="panel" aria-labelledby="ms-workflow-catalog">
            <div className="panel-head">
              <h2 className="panel-title" id="ms-workflow-catalog">
                {copy.catalogHeading}
              </h2>
            </div>
            <div className="panel-body">
              <dl className="fields">
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
                <Field label={copy.fields.revision} mono>
                  {props.model.value.catalog.revision}
                </Field>
                <Field label={copy.fields.registeredAt} mono>
                  {props.model.value.catalog.registeredAt}
                </Field>
                <Field label={copy.fields.catalogUpdatedAt} mono>
                  {props.model.value.catalog.updatedAt}
                </Field>
                {props.model.value.catalog.description === null ? null : (
                  <Field label={copy.fields.description}>{props.model.value.catalog.description}</Field>
                )}
              </>
            )}
              </dl>
            </div>
          </section>
          </div>


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
          {/* The prototype's Leases card: one row per lease the projection holds. */}
          <section className="panel" aria-labelledby="ms-workflow-leases">
            <div className="panel-head">
              <h2 className="panel-title" id="ms-workflow-leases">
                {copy.leasesHeading}
              </h2>
              <span className="panel-meta">{copy.leasesCount(props.model.value.leases.length)}</span>
            </div>
            <div className="panel-body tight">
              {props.model.value.leases.length === 0 ? (
                <p className="muted t-12">{copy.leasesEmpty}</p>
              ) : (
                <table className="table" data-ms-leases="">
                  <colgroup>
                    <col />
                    <col style={{ width: "16%" }} />
                    <col style={{ width: "16%" }} />
                    <col style={{ width: "34%" }} />
                    <col style={{ width: "14%" }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th scope="col">{copy.leaseColumns.plan}</th>
                      <th scope="col">{copy.leaseColumns.kind}</th>
                      <th scope="col">{copy.leaseColumns.holder}</th>
                      <th scope="col">{copy.leaseColumns.worktree}</th>
                      <th scope="col">{copy.leaseColumns.expires}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {props.model.value.leases.map((lease) => (
                      <tr key={`${lease.planId}:${lease.kind}`}>
                        <td className="mono t-12">{lease.planId}</td>
                        <td>
                          <span className="chip">{lease.kind}</span>
                        </td>
                        <td>{lease.holder}</td>
                        <td className="mono t-12">
                          <TruncatedText text={lease.worktreePath} />
                        </td>
                        <td className="mono t-12">{lease.expiresAt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
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
