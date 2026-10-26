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
import { FilterBar } from "../components/FilterBar.tsx";
import { Panel, PanelBody, PanelFoot, PanelHead } from "../components/Panel.tsx";
import { EmptyState, type AbsenceArm } from "../components/EmptyState.tsx";
import { StatusDot } from "../components/StatusDot.tsx";
import { TruncatedText } from "../components/TruncatedText.tsx";
import { DEFAULT_ITERATION_FILTERS, type IterationFilters, type IterationListModel, type IterationRow } from "../view-model/iterations.ts";
import type { Tone } from "../view-model/status.ts";

/** Every visible string this screen needs. Task 5 supplies them. */
export type IterationsCopy = {
  pageTitle: string;
  tableCaption: string;
  /** The filter card's own head. */
  /** The prototype's footer: where "active" and the execution column come from. */
  membershipNote: string;
  filters: {
    lifecycle: string;
    search: string;
    clear: string;
    any: string;
    results: (shown: number, total: number) => string;
  };
  columns: {
    id: string;
    title: string;
    lifecycle: string;
    execution: string;
    delivery: string;
    plans: string;
    /** The prototype's `Documents` column. */
    documents: string;
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
  /** The current filter state; absent means unfiltered (a host without filters). */
  filters?: IterationFilters;
  onFiltersChange?: (filters: IterationFilters) => void;
};

/** The filter panel's accessible name; the head carries the id. */
const FILTERS_HEAD_ID = "ms-iterations-filters";

export function Iterations(props: IterationsProps) {
  const { model, copy } = props;
  const filters = props.filters ?? DEFAULT_ITERATION_FILTERS;

  const columns: DataTableColumn<IterationRow>[] = [
    { key: "id", header: copy.columns.id, width: "18%", render: (row) => <span className={"mono t-12"}>{row.iterationId}</span> },
    {
      key: "title",
      header: copy.columns.title,
      render: (row) =>
        row.title === null ? <span className={"muted"}>{copy.notStarted}</span> : <TruncatedText text={row.title} />,
    },
    {
      key: "lifecycle",
      header: copy.columns.lifecycle,
      width: "13%",
      secondary: true,
      render: (row) => <span className={"mono t-12"}>{row.lifecycle ?? "—"}</span>,
    },
    {
      key: "execution",
      header: copy.columns.execution,
      width: "8%",
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
      width: "9%",
      render: (row) => (
        <span className={"mono t-12"} data-ms-iteration-step={row.gateStep ?? "none"}>
          {row.gatePosition === null ? copy.noCompass : copy.gateStep(row.gatePosition.step, row.gatePosition.of)}
        </span>
      ),
    },
    {
      key: "plans",
      header: copy.columns.plans,
      width: "8%",
      secondary: true,
      align: "end",
      // The prototype's numeric columns carry `.t-num` on both cells: right-aligned,
      // tabular figures, mono, secondary tone.
      cellClass: "t-num",
      headerClass: "t-num",
      render: (row) => <span>{copy.plansProgress(row.plansDone, row.plansTotal)}</span>,
    },
    {
      // The prototype's list states the document count after the plan count; both are
      // numbers, so both wear `.t-num` on the header and the cell.
      key: "documents",
      header: copy.columns.documents,
      width: "8%",
      secondary: true,
      align: "end",
      cellClass: "t-num",
      headerClass: "t-num",
      render: (row) => <span>{row.documents}</span>,
    },
    {
      key: "started",
      header: copy.columns.started,
      width: "7%",
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
      {/* The prototype heads every screen with `.screen-head`; `.screen-head h1`
          carries the 16/24/600 title rule, and a bare h1 falls back to the
          document heading instead. */}
      <div className="screen-head">
        <h1>{copy.pageTitle}</h1>
      </div>

      {model.rows.kind === "populated" ? (
        <>
          <Panel labelledBy={FILTERS_HEAD_ID}>
            <PanelHead id={FILTERS_HEAD_ID}>
            <FilterBar
              fields={[
                {
                  key: "lifecycle",
                  label: copy.filters.lifecycle,
                  value: filters.lifecycle,
                  options: [
                    { value: "", label: copy.filters.any },
                    ...model.lifecycles.map((value) => ({ value, label: value })),
                  ],
                },
              ]}
              onFieldChange={(key, value) => props.onFiltersChange?.({ ...filters, [key]: value })}
              search={{
                value: filters.q,
                placeholder: copy.filters.search,
                onChange: (value) => props.onFiltersChange?.({ ...filters, q: value }),
              }}
              applied={[
                ...(filters.lifecycle === ""
                  ? []
                  : [{ key: "lifecycle", text: `${copy.filters.lifecycle}: ${filters.lifecycle}` }]),
                ...(filters.q.trim() === "" ? [] : [{ key: "q", text: filters.q }]),
              ]}
              onClearFilter={(key) => props.onFiltersChange?.({ ...filters, [key]: "" } as IterationFilters)}
              onClearAll={() => props.onFiltersChange?.({ ...DEFAULT_ITERATION_FILTERS })}
              clearLabel={copy.filters.clear}
              resultSummary={copy.filters.results(model.filtered, model.total)}
            />
            </PanelHead>
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
            <PanelFoot>
              {/* The prototype's footer explains where the two facts come from, so a
                  reader knows "active" is catalog membership and the execution column
                  is a projection over it. */}
              <span className="muted t-11" data-ms-iteration-note="">
                {copy.membershipNote}
              </span>
            </PanelFoot>
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
