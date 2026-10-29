/**
 * `IterationDetail` — one iteration (IA §8.2).
 *
 * Renders: catalog identity, execution (the linked workflow), the compass status
 * and its summary, the **gate step (1–4 of 5)**, the plan table, the **document
 * inventory** and the dates.
 *
 * The inventory is rendered because the prototype's detail screen has a Documents
 * card and the prototype is this interface's acceptance criterion. IA §8.1 had
 * excluded it ("documents say nothing about progress") — true, but that describes a
 * progress view, not this one.
 *
 * Not rendered, asserted negatively: the compass milestone-id list (the roadmap
 * feature owns milestones — repeating the ids here would be a second, weaker view of
 * the same thing), and every counter (`storeRevision`, `catalogRevision`, `builtAt`,
 * `checkedAt`).
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
import { UNKNOWN_DATE } from "../view-model/format.ts";
import { TruncatedText } from "../components/TruncatedText.tsx";
import type { IterationDetailModel, IterationPlanRow } from "../view-model/iterations.ts";
import type { Resolved } from "../view-model/state.ts";
import type { GateStepId, GateStepPosition, Tone } from "../view-model/status.ts";

/** Every visible string this screen needs. Task 5 supplies them. */
export type IterationDetailCopy = {
  breadcrumb: { label: string; root: string; current: string };
  compassHeading: string;
  /** The head's meta line: `started <time>`, beside the compass status. */
  compassStarted: (at: string) => string;
  planTableHeading: string;
  /** The Plans head's own count: `3 plans`. */
  plansCount: (n: number) => string;
  /** The head meta's last two segments: how much this iteration carries. */
  plansMeta: (n: number) => string;
  documentsMeta: (n: number) => string;
  catalogHeading: string;
  /** The Catalog head's chip: the store still counts this as a registration. */
  activeRegistration: string;
  executionHeading: string;
  /** The Compass panel's milestone mini table. */
  compassColumns: { milestone: string; target: string; status: string };
  /** The prototype's Documents card. */
  documentsHeading: string;
  documentsCount: (n: number) => string;
  documentsEmpty: string;
  documentColumns: { title: string; lifecycle: string; kind: string; location: string; revision: string };
  fields: {
    id: string;
    title: string;
    lifecycle: string;
    /** The catalog panel's six row labels, matching the prototype's. */
    kind: string;
    revision: string;
    registeredAt: string;
    location: string;
    catalogUpdatedAt: string;
    /** The execution panel's workflow state. */
    status: string;
    phase: string;
    /** The execution lifecycle beside the catalog's archive state (plan Task 5). */
    executionLifecycle: string;
    /** The projects the iteration belongs to (plan Task 5). */
    projects: string;
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
          <header className="detail-head">
            <div className="detail-head-main">
              <h1 className="detail-title">
                <TruncatedText text={value.title ?? value.iterationId} />
              </h1>
              {/* The prototype's meta line: the store id, the lifecycle, the compass,
                  and the two counts a reader scans for. */}
              <div className="detail-meta">
                <span className="mono">{value.iterationId}</span>
                <span aria-hidden="true">·</span>
                <span>{value.lifecycle ?? "—"}</span>
                {value.compassStatus === null ? null : (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className={`status tone-${value.compassTone} is-strong`}>
                      <span className="dot" aria-hidden="true" />
                      <span className="label mono">{value.compassStatus}</span>
                    </span>
                  </>
                )}
                {/* The prototype's last two segments: how much this iteration carries. */}
                <span aria-hidden="true">·</span>
                <span data-ms-meta-plans="">{copy.plansMeta(value.plans.length)}</span>
                <span aria-hidden="true">·</span>
                <span data-ms-meta-documents="">{copy.documentsMeta(value.documents.length)}</span>
              </div>
            </div>
            {value.gatePosition === null ? null : (
              <div className="detail-actions">
                <span className="chip" data-ms-gate-chip>
                  {copy.gateStep(value.gatePosition.step, value.gatePosition.of)}
                </span>
              </div>
            )}
          </header>

          <div className="detail-top">
          <section className="panel" aria-labelledby="ms-iteration-catalog">
            <div className="panel-head">
              <h2 className="panel-title" id="ms-iteration-catalog">{copy.catalogHeading}</h2>
              {/* The prototype's head states that the store still counts this as a
                  registration — the same fact the workflow detail shows. */}
              {value.activeRegistration ? (
                <span className="panel-meta">
                  <span className="chip">{copy.activeRegistration}</span>
                </span>
              ) : null}
            </div>
            <div className="panel-body">
              <dl className="fields">
            {/* The prototype's six rows, in its order, then the description beneath them. */}
            <Field label={copy.fields.kind} mono>
              {value.catalogKind ?? "—"}
            </Field>
            <Field label={copy.fields.lifecycle} mono>
              {value.lifecycle ?? "—"}
            </Field>
            <Field label={copy.fields.revision} mono>
              {value.revision ?? "—"}
            </Field>
            <Field label={copy.fields.registeredAt} mono>
              {value.registeredAt ?? "—"}
            </Field>
            <Field label={copy.fields.location} mono>
              {value.location ?? "—"}
            </Field>
            <Field label={copy.fields.catalogUpdatedAt} mono>
              {value.catalogUpdatedAt ?? "—"}
            </Field>
            {value.description === null ? null : (
              <p className={"prose t-12 secondary"} data-ms-catalog-description="">
                {value.description}
              </p>
            )}
              </dl>
            </div>
          </section>
          <section className="panel" aria-labelledby="ms-iteration-execution">
            <div className="panel-head">
              <h2 className="panel-title" id="ms-iteration-execution">{copy.executionHeading}</h2>
            </div>
            <div className="panel-body">
              <dl className="fields">
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
            <Field label={copy.fields.executionLifecycle} mono>
              {value.executionLifecycle}
            </Field>
            {value.workflowId === null ? null : (
              <>
                <Field label={copy.fields.status} mono>
                  {value.workflowStatus ?? "—"}
                </Field>
                <Field label={copy.fields.phase} mono>
                  {value.workflowPhase ?? "—"}
                </Field>
              </>
            )}
            <Field label={copy.fields.projects} mono>
              {value.projects.length === 0 ? "—" : value.projects.join(" · ")}
            </Field>
              </dl>
            </div>
          </section>
          </div>

          <section className="panel" aria-labelledby="ms-iteration-compass">
            <div className="panel-head">
              <h2 className="panel-title" id="ms-iteration-compass">{copy.compassHeading}</h2>
              {/* The prototype puts the status and the start time in the head, not the body. */}
              <span className="panel-meta">
                {value.compassStatus === null ? (
                  <span className={"muted"}>{copy.fields.noCompass}</span>
                ) : (
                  <StatusDot label={value.compassStatus} tone={value.compassTone} mono />
                )}
                {/* `Date unknown` beside `no compass` reads as a contradiction: when the
                    compass records no start time there is nothing to say, not an unknown one. */}
                {value.startedAt === null || value.startedAt === UNKNOWN_DATE ? null : (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className={"mono"}>{copy.compassStarted(value.startedAt)}</span>
                  </>
                )}
              </span>
            </div>
            <div className="panel-body compass-body">
              {value.summary === null ? (
                <p className={"prose muted"}>{copy.fields.noSummary}</p>
              ) : (
                <p className={"prose"} data-ms-compass-summary="">
                  {value.summary}
                </p>
              )}
              {/* The prototype's Compass panel ends with its milestones as a mini table:
                  name, target, status. */}
              {value.compassMilestones.length === 0 ? null : (
                <table className="mini-table" data-ms-compass-milestones="">
                  <thead>
                    <tr>
                      <th scope="col">{copy.compassColumns.milestone}</th>
                      <th scope="col">{copy.compassColumns.target}</th>
                      <th scope="col">{copy.compassColumns.status}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {value.compassMilestones.map((milestone) => (
                      <tr key={milestone.milestone}>
                        <td>{milestone.milestone}</td>
                        <td className="mono">{milestone.target}</td>
                        <td className="mono">{milestone.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>


          <section className="panel" aria-labelledby="ms-iteration-plans">
            <div className="panel-head">
              <h2 className="panel-title" id="ms-iteration-plans">
                {copy.planTableHeading}
              </h2>
              {/* The prototype's head counts the plans in this iteration. */}
              <span className="panel-meta">{copy.plansCount(value.plans.length)}</span>
            </div>
            <DataTable
              variant="detail"
              caption={copy.planTableHeading}
              columns={planColumns(copy)}
              rows={value.plans}
              rowKey={(plan) => plan.planId}
            />
          </section>

          {/* The prototype's Documents card: the catalog inventory under this
              iteration. It is a fact list, not a progress view — which is why the
              model carries it only now that the screen has a place for it. */}
          <section className="panel" aria-labelledby="ms-iteration-documents">
            <div className="panel-head">
              <h2 className="panel-title" id="ms-iteration-documents">
                {copy.documentsHeading}
              </h2>
              <span className="panel-meta">
                {copy.documentsCount(value.documents.length)}
              </span>
            </div>
            <div className="panel-body tight">
              {value.documents.length === 0 ? (
                <p className="muted t-12">{copy.documentsEmpty}</p>
              ) : (
                /* The prototype's document table: fixed pixel widths and a scroller, so a
                   narrow pane scrolls instead of squeezing the location
                   (`design-v1.html:1904-1909`). */
                <div className="table-wrap">
                  <table className="table" data-ms-documents="" data-narrow-cols="2">
                    <colgroup>
                      <col />
                      <col style={{ width: "110px" }} />
                      <col style={{ width: "140px" }} />
                      <col style={{ width: "520px" }} />
                      <col style={{ width: "80px" }} />
                    </colgroup>
                  <thead>
                    <tr>
                      <th scope="col">{copy.documentColumns.title}</th>
                      <th scope="col">{copy.documentColumns.lifecycle}</th>
                      <th scope="col">{copy.documentColumns.kind}</th>
                      <th scope="col">{copy.documentColumns.location}</th>
                      <th scope="col">{copy.documentColumns.revision}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {value.documents.map((doc) => (
                      <tr key={doc.location}>
                        <td className="t-title">{doc.title}</td>
                        <td className="mono">{doc.lifecycle}</td>
                        <td className="mono t-12">{doc.documentKind}</td>
                        <td className="mono t-11 secondary t-title">
                          <TruncatedText text={doc.location} />
                        </td>
                        <td className="mono t-12" data-ms-align="end">
                          {doc.revision}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </div>
          </section>
        </>
  );
}

export function IterationDetail(props: IterationDetailProps) {
  const { copy, model } = props;
  return (
    <article className={"screen"} data-ms-screen="iteration-detail">
      {/* `Iterations / <id>`, the same two-part crumb the workflow detail uses. */}
      <div className={"breadcrumb"} aria-label={copy.breadcrumb.label}>
        {props.onBack === undefined ? (
          <span>{copy.breadcrumb.root}</span>
        ) : (
          <button type="button" className={"link"} onClick={props.onBack}>
            {copy.breadcrumb.root}
          </button>
        )}
        <span aria-hidden="true">/</span>
        <span className={"mono"}>
          {props.model.kind === "populated" ? props.model.value.iterationId : copy.breadcrumb.current}
        </span>
      </div>

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
