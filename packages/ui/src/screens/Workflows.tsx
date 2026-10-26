/**
 * `Workflows` — the list (IA §8.2).
 *
 * Facts: id, catalog title, projected status · phase, the root-register fact
 * (`rootKind:relativePath`), the projected updated time, plan `done/total`, and
 * `execution-unavailable` **as a reason** where it applies.
 *
 * Not rendered, and asserted negatively: plan leases, terminal-adoption audit
 * rows and the catalog-pin badges (`catalog-missing`, `catalog-pin-missing`,
 * `catalog-pin-conflict`). §8.1 removes them as join bookkeeping — a plan's status
 * already says whether it is being worked, and the only badge that survives is
 * the one that explains a degradation.
 *
 * **Truncation is disclosed from `total`**, never from the page length: the store
 * reports an unpaged count, and a page that reported its own length as the total
 * would claim a truncated page is the whole store.
 */
import { DataTable, type DataTableColumn } from "../components/DataTable.tsx";
import { Panel, PanelBody } from "../components/Panel.tsx";
import { EmptyState, type AbsenceArm } from "../components/EmptyState.tsx";
import { Notice } from "../components/Notice.tsx";
import { StatusDot } from "../components/StatusDot.tsx";
import { TruncatedText } from "../components/TruncatedText.tsx";
import type { WorkflowListModel, WorkflowRow } from "../view-model/workflows.ts";
import type { Tone } from "../view-model/status.ts";

/** Every visible string this screen needs. Task 5 supplies them. */
export type WorkflowsCopy = {
  pageTitle: string;
  tableCaption: string;
  columns: {
    id: string;
    title: string;
    status: string;
    root: string;
    updated: string;
    plans: string;
  };
  plansProgress: (done: number, total: number) => string;
  /** The disclosure when `total` exceeds the rows shown. */
  truncated: (shown: number, total: number) => string;
  noCatalogTitle: string;
  noRoot: string;
  /** `execution-unavailable` rendered as a reason, not as a chip. */
  executionUnavailable: string;
  empty: { labelWord: string; heading: string; body: string; hint: string };
  unavailable: { labelWord: string; heading: string; body: string };
  /** Used both for the `not-applicable` arm (with `detail`) and for `absent`. */
  absent: { labelWord: string; heading: string; body: string; pointer: string };
};

export type WorkflowsProps = {
  model: WorkflowListModel;
  copy: WorkflowsCopy;
  onOpen?: (id: string) => void;
};

export function Workflows(props: WorkflowsProps) {
  const { model, copy } = props;

  const columns: DataTableColumn<WorkflowRow>[] = [
    { key: "id", header: copy.columns.id, width: 282, render: (row) => <span className={"mono t-12"}>{row.id}</span> },
    {
      key: "title",
      header: copy.columns.title,
      render: (row) => <TruncatedText text={row.title ?? copy.noCatalogTitle} />,
    },
    {
      key: "status",
      header: copy.columns.status,
      width: 200,
      render: (row) => (
        <span>
          <StatusDot label={row.status} tone={row.statusTone} mono />
          {row.phase === null ? null : <span className={"chip"}>{row.phase}</span>}
        </span>
      ),
    },
    {
      key: "root",
      header: copy.columns.root,
      width: 150,
      secondary: true,
      render: (row) =>
        row.root === null ? <span className={"muted"}>{copy.noRoot}</span> : <span className={"mono t-12"}>{row.root}</span>,
    },
    {
      key: "updated",
      header: copy.columns.updated,
      width: 140,
      secondary: true,
      align: "end",
      render: (row) => <span className={"mono t-12"}>{row.updatedAt}</span>,
    },
    {
      key: "plans",
      header: copy.columns.plans,
      width: 190,
      secondary: true,
      align: "end",
      render: (row) => <span className={"mono t-12"}>{copy.plansProgress(row.plansDone, row.plansTotal)}</span>,
    },
  ];

  const meta = (row: WorkflowRow) =>
    [row.phase, row.root ?? copy.noRoot, row.updatedAt, copy.plansProgress(row.plansDone, row.plansTotal)]
      .filter((part): part is string => part !== null)
      .join(" · ");

  return (
    <article className={"screen"} data-ms-screen="workflows">
      <h1>{copy.pageTitle}</h1>

      {model.rows.kind === "populated" ? (
        <>
          <Panel>
            <PanelBody tight={true}>
              <DataTable
                caption={copy.tableCaption}
                columns={columns}
                rows={model.rows.value}
                rowKey={(row) => row.id}
                meta={meta}
                onRowActivate={props.onOpen === undefined ? undefined : (row) => props.onOpen?.(row.id)}
              />
            </PanelBody>
          </Panel>
          {model.truncated ? (
            <p data-ms-truncated={model.total}>
              {copy.truncated(model.shown, model.total)}
            </p>
          ) : null}
          {/* A degradation reason, stated once per row that carries it. */}
          {/* `flatMap`, not `filter().map()`: the narrowing survives inside the
              callback, so the reason is a string here rather than a cast. */}
          {model.rows.value.flatMap((row) =>
            row.executionUnavailableReason === null
              ? []
              : [<Notice key={row.id} reason={row.executionUnavailableReason} lead={row.id} />],
          )}
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
                labelWord={copy.empty.labelWord}
                heading={copy.empty.heading}
                body={copy.empty.body}
                hint={model.rows.kind === "empty" ? copy.empty.hint : undefined}
                pointer={model.rows.kind === "absent" ? copy.absent.pointer : undefined}
              />
            )}
          </PanelBody>
        </Panel>
      )}
    </article>
  );
}
