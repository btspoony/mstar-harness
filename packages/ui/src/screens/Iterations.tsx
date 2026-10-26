/**
 * `Iterations` — the list (IA §8.2).
 *
 * Facts: iteration id, catalog title, catalog lifecycle, the projected execution
 * (its workflow status), the delivery position (gate step of five), plan
 * `done/total`, started / ended. **No document inventory, no counters.**
 *
 * The `attribution` arm is the reason this list is not a plain table: a
 * project-scoped read must be able to say two different things about zero rows —
 * *this project has no iteration* (`empty`, the store attributes iterations but
 * none belong here) versus *this store attributes no iteration to any project*
 * (`absent`, the question cannot be answered). Both arrive resolved from
 * `iterationListModel`; the screen only chooses the copy.
 */
import { DataTable, type DataTableColumn } from "../components/DataTable.tsx";
import { Panel, PanelBody } from "../components/Panel.tsx";
import { EmptyState, type AbsenceArm } from "../components/EmptyState.tsx";
import { StatusDot } from "../components/StatusDot.tsx";
import { TruncatedText } from "../components/TruncatedText.tsx";
import type { IterationListModel, IterationRow } from "../view-model/iterations.ts";
import type { Tone } from "../view-model/status.ts";

/** Every visible string this screen needs. Task 5 supplies them. */
export type IterationsCopy = {
  pageTitle: string;
  tableCaption: string;
  columns: {
    id: string;
    title: string;
    lifecycle: string;
    execution: string;
    delivery: string;
    plans: string;
    started: string;
  };
  /** `step N of 5`, or the copy for an iteration that records no compass. */
  gateStep: (step: number, of: number) => string;
  noCompass: string;
  notStarted: string;
  plansProgress: (done: number, total: number) => string;
  /** The termination of a project-scoped read that has no rows to show. */
  empty: { labelWord: string; heading: string; body: string; hint: string };
  absent: { labelWord: string; heading: string; body: string; pointer: string };
  unavailable: { labelWord: string; heading: string; body: string };
  /** `attributed` / `not attributed` — the read's own scope statement. */
  attribution: (arm: "present" | "absent") => string;
};

export type IterationsProps = {
  model: IterationListModel;
  copy: IterationsCopy;
  onOpen?: (iterationId: string) => void;
};

export function Iterations(props: IterationsProps) {
  const { model, copy } = props;

  const columns: DataTableColumn<IterationRow>[] = [
    { key: "id", header: copy.columns.id, width: 250, render: (row) => <span className={"mono t-12"}>{row.iterationId}</span> },
    {
      key: "title",
      header: copy.columns.title,
      render: (row) =>
        row.title === null ? <span className={"muted"}>{copy.notStarted}</span> : <TruncatedText text={row.title} />,
    },
    {
      key: "lifecycle",
      header: copy.columns.lifecycle,
      width: 190,
      secondary: true,
      render: (row) => <span className={"mono t-12"}>{row.lifecycle ?? "—"}</span>,
    },
    {
      key: "execution",
      header: copy.columns.execution,
      width: 96,
      secondary: true,
      render: (row) => (
        <span>
          <StatusDot label={row.compassStatus ?? copy.noCompass} tone={row.compassTone} mono />
        </span>
      ),
    },
    {
      key: "delivery",
      header: copy.columns.delivery,
      width: 130,
      render: (row) => (
        <span className={"mono t-12"} data-ms-iteration-step={row.gateStep ?? "none"}>
          {row.gatePosition === null ? copy.noCompass : copy.gateStep(row.gatePosition.step, row.gatePosition.of)}
        </span>
      ),
    },
    {
      key: "plans",
      header: copy.columns.plans,
      width: 92,
      secondary: true,
      align: "end",
      render: (row) => <span className={"mono t-12"}>{copy.plansProgress(row.plansDone, row.plansTotal)}</span>,
    },
    {
      key: "started",
      header: copy.columns.started,
      width: 64,
      secondary: true,
      align: "end",
      render: (row) => <span className={"mono t-12"}>{row.startedAt}</span>,
    },
  ];

  const meta = (row: IterationRow) =>
    [
      row.lifecycle,
      row.compassStatus ?? copy.noCompass,
      row.gatePosition === null ? copy.noCompass : copy.gateStep(row.gatePosition.step, row.gatePosition.of),
      copy.plansProgress(row.plansDone, row.plansTotal),
      row.startedAt,
    ]
      .filter((part): part is string => part !== null && part !== "")
      .join(" · ");

  return (
    <article className={"screen"} data-ms-screen="iterations">
      <h1>{copy.pageTitle}</h1>

      {model.rows.kind === "populated" ? (
        <>
          <Panel>
            <PanelBody tight={true}>
              <DataTable
                caption={copy.tableCaption}
                columns={columns}
                rows={model.rows.value}
                rowKey={(row) => row.iterationId}
                meta={meta}
                onRowActivate={props.onOpen === undefined ? undefined : (row) => props.onOpen?.(row.iterationId)}
              />
            </PanelBody>
          </Panel>
          {/* The scope statement: whether this store attributes iterations to a
              project at all. It rides beside the rows, never as a counter. */}
          <p className={"attribution"} data-ms-attribution={model.attribution}>
            {copy.attribution(model.attribution)}
          </p>
        </>
      ) : (
        <Panel>
          <PanelBody>
            {model.rows.kind === "unavailable" ? (
              <EmptyState
                arm="unavailable"
                labelWord={copy.unavailable.labelWord}
                heading={copy.unavailable.heading}
                body={copy.unavailable.body}
                reason={model.rows.reason}
              />
            ) : model.rows.kind === "not-applicable" ? (
              <EmptyState
                arm="not-applicable"
                labelWord={copy.absent.labelWord}
                heading={copy.absent.heading}
                body={copy.absent.body}
                detail={model.rows.reason}
              />
            ) : (
              <EmptyState
                arm={model.rows.kind as AbsenceArm}
                labelWord={model.rows.kind === "absent" ? copy.absent.labelWord : copy.empty.labelWord}
                heading={model.rows.kind === "absent" ? copy.absent.heading : copy.empty.heading}
                body={model.rows.kind === "absent" ? copy.absent.body : copy.empty.body}
                pointer={model.rows.kind === "absent" ? copy.absent.pointer : undefined}
                hint={model.rows.kind === "empty" ? copy.empty.hint : undefined}
              />
            )}
          </PanelBody>
        </Panel>
      )}
    </article>
  );
}
