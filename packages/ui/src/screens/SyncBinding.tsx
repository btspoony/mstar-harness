/**
 * `SyncBinding` — the read-only binding view (`DESIGN.md` § The sync-binding panel).
 *
 * Three answers and no fourth column: which `.mstarc` connection this repo
 * declares, which local project is which remote project, and whether a sync
 * would work now. Every fact is the read's own — the readiness cause is the
 * sentence the probe supplied, and the screen never composes one.
 *
 * A null binding is the reader's refusal, rendered verbatim in the identity
 * block's place; it is not `not-probed`, and the two stay distinct. Nothing here
 * carries an issue row, a failure count or a credential field: the credential
 * belongs to the host and never reaches this view.
 */
import type { SyncBindingProject } from "@mstar-harness/engine";

import { DataTable, type DataTableColumn } from "../components/DataTable.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Field } from "../components/Field.tsx";
import { Panel, PanelBody, PanelFoot, PanelHead } from "../components/Panel.tsx";
import { StatusDot } from "../components/StatusDot.tsx";
import type { SyncBindingModel } from "../view-model/sync-binding.ts";

/** Every visible string this screen needs. The dictionary supplies them. */
export type SyncBindingCopy = {
  pageTitle: string;
  subtitle: string;
  identityHeading: string;
  /** The declaration this block reads, as the prototype prints it. */
  identitySource: string;
  fields: { enabled: string; mode: string; workspace: string; team: string };
  identityNote: string;
  readinessHeading: string;
  stateLabel: string;
  causeLabel: string;
  readinessNote: string;
  correspondenceHeading: string;
  /** `2 bindings`, beside the correspondence head. */
  bindingsCount: (n: number) => string;
  correspondenceNote: string;
  /** The field label for the reader's refusal when the binding is null. */
  bindingErrorLabel: string;
  /** The sentence rendered when that refusal arrived without the reader's message. */
  bindingAbsent: string;
  /** The shared absence families, for a correspondence the resolver could not populate. */
  state: {
    "not-applicable": { labelWord: string; body: string };
    absent: { labelWord: string; body: string; pointer: string };
    empty: { labelWord: string; body: string; hint: string };
    unavailable: { labelWord: string; body: string };
  };
};

export type SyncBindingProps = {
  model: SyncBindingModel;
  copy: SyncBindingCopy;
};

const IDENTITY_HEAD_ID = "ms-sync-binding-identity";
const READINESS_HEAD_ID = "ms-sync-binding-readiness";
const CORRESPONDENCE_HEAD_ID = "ms-sync-binding-correspondence";

/**
 * The correspondence's absence arm. `EmptyState` keeps the four states apart by
 * structure and label word, so the screen hands it the arm the model resolved:
 * a failed or undecided read is never dressed as "nothing is stored here".
 */
function CorrespondenceAbsence(props: { correspondence: SyncBindingModel["correspondence"]; copy: SyncBindingCopy }) {
  const { correspondence, copy } = props;
  // `loading` is a transport phase, not a subject state: it claims no arm.
  if (correspondence.kind === "loading" || correspondence.kind === "populated") return null;
  return (
    <Panel>
      <PanelBody>
        <EmptyState
          arm={correspondence.kind}
          labelWord={copy.state[correspondence.kind].labelWord}
          heading={copy.correspondenceHeading}
          body={copy.state[correspondence.kind].body}
          reason={"reason" in correspondence ? correspondence.reason : undefined}
          pointer={correspondence.kind === "absent" ? copy.state.absent.pointer : undefined}
          hint={correspondence.kind === "empty" ? copy.state.empty.hint : undefined}
        />
      </PanelBody>
    </Panel>
  );
}

export function SyncBinding(props: SyncBindingProps) {
  const { model, copy } = props;

  // `projectId` and `remoteProject` are `project_bindings`' own column names:
  // identifiers render verbatim in both locales, so they are not copy.
  const columns: DataTableColumn<SyncBindingProject>[] = [
    {
      key: "projectId",
      header: "projectId",
      width: "280px",
      render: (row) => <span className={"mono t-12"}>{row.projectId}</span>,
    },
    {
      key: "remoteProject",
      header: "remoteProject",
      render: (row) => <span className={"mono t-12"}>{row.remoteProject}</span>,
    },
  ];

  const { identity, readiness, correspondence } = model;

  return (
    <article className={"screen"} data-ms-screen="sync-binding">
      <div className="screen-head">
        <h1>{copy.pageTitle}</h1>
        <div className="screen-meta">
          <span>{copy.subtitle}</span>
        </div>
      </div>

      <div className="detail-top">
        <Panel labelledBy={IDENTITY_HEAD_ID}>
          <PanelHead
            id={IDENTITY_HEAD_ID}
            title={copy.identityHeading}
            meta={<span className={"mono"}>{copy.identitySource}</span>}
          />
          <PanelBody>
            <dl className={"fields one"}>
              {identity.kind === "bound" ? (
                <>
                  <Field label={copy.fields.enabled} mono={true}>
                    {String(identity.enabled)}
                  </Field>
                  <Field label={copy.fields.mode} mono={true}>
                    {identity.mode}
                  </Field>
                  <Field label={copy.fields.workspace} mono={true}>
                    {identity.workspace}
                  </Field>
                  <Field label={copy.fields.team} mono={true}>
                    {identity.team}
                  </Field>
                </>
              ) : (
                /* The reader's refusal, in the identity block's place. A refusal
                   that arrived without a message renders the dictionary's own
                   sentence, so no locale's wording lives in the transform. */
                <Field label={copy.bindingErrorLabel} mono={true}>
                  {identity.message ?? copy.bindingAbsent}
                </Field>
              )}
            </dl>
            {identity.kind === "bound" ? <p className={"sec-note"}>{copy.identityNote}</p> : null}
          </PanelBody>
        </Panel>

        <Panel labelledBy={READINESS_HEAD_ID}>
          <PanelHead
            id={READINESS_HEAD_ID}
            title={copy.readinessHeading}
            meta={
              readiness.kind === "probed" ? <StatusDot label={readiness.state} tone={readiness.tone} mono={true} /> : undefined
            }
          />
          <PanelBody>
            {readiness.kind === "probed" ? (
              <dl className={"fields one"}>
                <Field label={copy.stateLabel} mono={true}>
                  {readiness.state}
                </Field>
                <Field label={copy.causeLabel} mono={true}>
                  {readiness.cause}
                </Field>
              </dl>
            ) : (
              /* A refused pair renders no dot and no state label: the state arrived
                 without its cause, so neither half is shown as a fact. */
              <p className={"mono wrap"}>{readiness.reason}</p>
            )}
            <p className={"sec-note"}>{copy.readinessNote}</p>
          </PanelBody>
        </Panel>
      </div>

      {correspondence.kind === "populated" ? (
        <Panel labelledBy={CORRESPONDENCE_HEAD_ID}>
          <PanelHead
            id={CORRESPONDENCE_HEAD_ID}
            title={copy.correspondenceHeading}
            meta={copy.bindingsCount(correspondence.value.length)}
          />
          {/* No PanelBody: the prototype's `.table-wrap` is a direct child of `.panel`. */}
          <DataTable
            caption={copy.correspondenceHeading}
            columns={columns}
            rows={correspondence.value}
            rowKey={(row) => row.projectId}
          />
          <PanelFoot>
            <span className={"muted t-11"}>{copy.correspondenceNote}</span>
          </PanelFoot>
        </Panel>
      ) : (
        <CorrespondenceAbsence correspondence={correspondence} copy={copy} />
      )}
    </article>
  );
}
