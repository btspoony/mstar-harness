/**
 * `IssueDetail` — where the contraction cut deepest (IA §8.1, §8.2).
 *
 * The whole page is: one fact block (id, title, project, milestone, kind,
 * severity, disposition, owner, **the occurrence count**, registered date, closed
 * date), two long-text fields (impact, acceptance), and — only when the issue is
 * closed — its closure note.
 *
 * It does **not** render occurrence rows, disposition transitions, provenance,
 * relations, `externalUrl` / `externalId` / `provider` / `identityKey`, or
 * `revision` / `createdAt` / `updatedAt`. The DTO still carries every one of
 * them: §8.1 removes *drawing*, not data. The occurrence **count** stays, because
 * "this keeps coming back" is a property of the problem while when and from where
 * it came back is the log.
 *
 * The component cannot reach those facts by accident — `IssueDetailModel` does not
 * carry them — and the test asserts the absence anyway, so a future field added
 * to the model fails here instead of shipping.
 */
import { Collapsible } from "../components/Collapsible.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Field } from "../components/Field.tsx";
import { FieldGroup } from "../components/FieldGroup.tsx";
import { StatusDot } from "../components/StatusDot.tsx";
import { TruncatedText } from "../components/TruncatedText.tsx";
import { resolveRecord } from "../view-model/state.ts";
import type { IssueDetailModel } from "../view-model/issues.ts";
import type { Tone } from "../view-model/status.ts";
import type { ReadProjection } from "@mstar-harness/engine";

/** Every visible string this screen needs. Task 5 supplies them. */
export type IssueDetailCopy = {
  /** The trail back to the list. */
  breadcrumb: { label: string; current: string };
  identityHeading: string;
  fields: {
    id: string;
    project: string;
    milestone: string;
    kind: string;
    severity: string;
    disposition: string;
    owner: string;
    occurrences: string;
    registeredAt: string;
    closedAt: string;
    noMilestone: string;
    noOwner: string;
  };
  /** `Seen 2 times` — the count, never the rows. */
  occurrenceCount: (count: number) => string;
  impactHeading: string;
  acceptanceHeading: string;
  closureNoteHeading: string;
  /** The `Identity keys` panel's heading and its two row labels. */
  /** The `Source` panel's heading and its five row labels. */
  sourceHeading: string;
  sourceKindLabel: string;
  sourceIdentityLabel: string;
  sourceLocationLabel: string;
  sourceRootCauseLabel: string;
  sourceAcceptanceLabel: string;
  /** The `Relations` table's heading and its three column labels. */
  /** The `Provenance` table's heading and its five column labels. */
  /** The `Disposition history` table's heading, its five labels and its footer note. */
  /** The `Occurrences` panel's heading and its three row labels. */
  occurrencesHeading: string;
  occurrenceObservedAt: string;
  occurrenceLocation: string;
  occurrenceRecorded: string;
  historyHeading: string;
  historyColumns: { from: string; to: string; reason: string; actor: string; recorded: string };
  historyNote: string;
  provenanceHeading: string;
  provenanceColumns: {
    kind: string;
    target: string;
    sourceHash: string;
    origin: string;
    importedAt: string;
  };
  relationsHeading: string;
  relationsColumns: { relation: string; issue: string; title: string };
  identityKeysHeading: string;
  identityKeyLabel: string;
  providerLabel: string;
  absence: {
    unavailable: { labelWord: string; heading: string; body: string };
    absent: { labelWord: string; heading: string; body: string; pointer: string };
  };
};

export type IssueDetailProps = {
  /**
   * The record read. `null` means **absent** — the issue declares nothing here —
   * and a failed read arrives as a projection with no generation, which resolves
   * to `unavailable` (the package-wide ruling; README item 9).
   */
  read: { data: IssueDetailModel | null; projection: ReadProjection };
  copy: IssueDetailCopy;
  onBack?: () => void;
  phase?: "loading" | "loaded";
};

export function IssueDetail(props: IssueDetailProps) {
  const { copy } = props;
  // A record read has a different `null` meaning from a list, and the resolver
  // owns that decision (IA §5); the screen only chooses copy for the arm.
  const record = resolveRecord(props.read, {
    phase: props.phase,
    unavailableReason: "this issue could not be read",
  });

  return (
    <article className={"screen"} data-ms-screen="issue-detail">
      <nav className={"breadcrumb"} aria-label={copy.breadcrumb.label}>
        {props.onBack === undefined ? null : (
          <button type="button" className={"link"} onClick={props.onBack}>
            {copy.breadcrumb.current}
          </button>
        )}
      </nav>

      {record.kind === "populated" ? (
        <>
          <header className="detail-head">
            <h1 className="detail-title">
              <TruncatedText text={record.value.title} />
            </h1>
            <div className={"detail-meta"}>
              {/* Dot + literal enum + weight: never colour alone. */}
              <StatusDot
                label={record.value.severity}
                tone={record.value.severityTone}
                emphasis={record.value.severityEmphasised}
                mono
              />
              <StatusDot label={record.value.disposition} tone={record.value.dispositionTone} mono />
            </div>
          </header>
        <div className="detail-grid">
          <div className="detail-col">

          <FieldGroup title={copy.identityHeading}>
            <Field label={copy.fields.id} mono>
              {record.value.id}
            </Field>
            <Field label={copy.fields.project} mono>
              {record.value.projectId}
            </Field>
            <Field label={copy.fields.milestone} mono>
              {record.value.milestoneId ?? copy.fields.noMilestone}
            </Field>
            <Field label={copy.fields.kind} mono>
              {record.value.kind}
            </Field>
            <Field label={copy.fields.severity} mono>
              {record.value.severity}
            </Field>
            <Field label={copy.fields.disposition} mono>
              {record.value.disposition}
            </Field>
            <Field label={copy.fields.owner} mono>
              {record.value.owner ?? copy.fields.noOwner}
            </Field>
            {/* The count is the surviving fact: one integer, no rows. */}
            <Field label={copy.fields.occurrences} mono>
              <span data-ms-occurrence-count={record.value.occurrenceCount}>
                {copy.occurrenceCount(record.value.occurrenceCount)}
              </span>
            </Field>
            <Field label={copy.fields.registeredAt} mono>
              {record.value.registeredAt}
            </Field>
            <Field label={copy.fields.closedAt} mono>
              {record.value.closedAt ?? "—"}
            </Field>
          </FieldGroup>

          {record.value.impact === null ? null : (
            <section className={"panel"} data-ms-impact="">
              <h2>{copy.impactHeading}</h2>
              <p className={"detail-text"}>{record.value.impact}</p>
            </section>
          )}

          {record.value.acceptance === null ? null : (
            <section className={"panel"} data-ms-acceptance="">
              <h2>{copy.acceptanceHeading}</h2>
              <p className={"detail-text"}>{record.value.acceptance}</p>
            </section>
          )}

          {/* The prototype's `Source` panel: where this issue came from. */}
          {record.value.source === null ? null : (
            <section className={"sec"} data-ms-issue-source="" aria-labelledby="ms-issue-source">
              <h2 id="ms-issue-source">{copy.sourceHeading}</h2>
              <dl className={"fields"}>
                <div className="field">
                  <dt>{copy.sourceKindLabel}</dt>
                  <dd className="mono">{record.value.source.kind}</dd>
                </div>
                <div className="field">
                  <dt>{copy.sourceIdentityLabel}</dt>
                  <dd className="mono">{record.value.source.identity}</dd>
                </div>
                {record.value.source.location === null ? null : (
                  <div className="field">
                    <dt>{copy.sourceLocationLabel}</dt>
                    <dd className="mono wrap">{record.value.source.location}</dd>
                  </div>
                )}
                {record.value.source.rootCauseKey === null ? null : (
                  <div className="field">
                    <dt>{copy.sourceRootCauseLabel}</dt>
                    <dd className="mono">{record.value.source.rootCauseKey}</dd>
                  </div>
                )}
                {record.value.source.acceptanceKey === null ? null : (
                  <div className="field">
                    <dt>{copy.sourceAcceptanceLabel}</dt>
                    <dd className="mono">{record.value.source.acceptanceKey}</dd>
                  </div>
                )}
              </dl>
            </section>
          )}

          {/* The prototype's `Occurrences`: one block per event, each with its own quote,
              location and citations. This is the log §8.1 removed; the prototype keeps it. */}
          {record.value.occurrences.length === 0 ? null : (
            <section className={"sec"} data-ms-issue-occurrences="" aria-labelledby="ms-issue-occurrences">
              <h2 id="ms-issue-occurrences">{copy.occurrencesHeading}</h2>
              {record.value.occurrences.map((occurrence) => (
                <article className={"occurrence"} key={occurrence.id} data-ms-occurrence-row={occurrence.id}>
                  <div className={"occurrence-head"}>
                    <span className={"mono"}>{occurrence.sourceIdentity}</span>
                    <span className={"chip"}>{occurrence.sourceKind}</span>
                    <span className={"spacer"} />
                    <span className={"muted t-11"}>
                      {copy.occurrenceObservedAt} <span className={"mono"}>{occurrence.recordedAt}</span>
                    </span>
                  </div>
                  <p className={"detail-text"}>{occurrence.observedBehavior}</p>
                  <dl className={"fields"}>
                    {occurrence.location === null ? null : (
                      <div className="field">
                        <dt>{copy.occurrenceLocation}</dt>
                        <dd className="mono wrap">{occurrence.location}</dd>
                      </div>
                    )}
                    <div className="field">
                      <dt>{copy.occurrenceRecorded}</dt>
                      <dd className="mono">{occurrence.recordedAt}</dd>
                    </div>
                  </dl>
                  {occurrence.evidence.length === 0 ? null : (
                    <ul className={"occurrence-evidence"}>
                      {occurrence.evidence.map((citation) => (
                        <li className={"mono t-11"} key={citation}>
                          {citation}
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              ))}
            </section>
          )}
            </div>
            <div className="detail-col">

          {/* The prototype's `Disposition history`: only recorded transitions appear. */}
          {record.value.transitions.length === 0 ? null : (
            <section className={"sec"} data-ms-issue-history="" aria-labelledby="ms-issue-history">
              <h2 id="ms-issue-history">{copy.historyHeading}</h2>
              <table className={"mini-table"}>
                <thead>
                  <tr>
                    <th scope="col">{copy.historyColumns.from}</th>
                    <th scope="col">{copy.historyColumns.to}</th>
                    <th scope="col">{copy.historyColumns.reason}</th>
                    <th scope="col">{copy.historyColumns.actor}</th>
                    <th scope="col">{copy.historyColumns.recorded}</th>
                  </tr>
                </thead>
                <tbody>
                  {record.value.transitions.map((row, index) => (
                    <tr key={`${row.to}-${row.recordedAt}-${index}`}>
                      <td className="mono">{row.from ?? "—"}</td>
                      <td className="mono">{row.to}</td>
                      <td>{row.reason ?? "—"}</td>
                      <td className="mono">{row.actor ?? "—"}</td>
                      <td className="mono">{row.recordedAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className={"muted t-11"}>{copy.historyNote}</p>
            </section>
          )}

          {/* The prototype's `Provenance` table. */}
          {record.value.provenance.length === 0 ? null : (
            <section className={"sec"} data-ms-issue-provenance="" aria-labelledby="ms-issue-provenance">
              <h2 id="ms-issue-provenance">{copy.provenanceHeading}</h2>
              <table className={"mini-table"}>
                <thead>
                  <tr>
                    <th scope="col">{copy.provenanceColumns.kind}</th>
                    <th scope="col">{copy.provenanceColumns.target}</th>
                    <th scope="col">{copy.provenanceColumns.sourceHash}</th>
                    <th scope="col">{copy.provenanceColumns.origin}</th>
                    <th scope="col">{copy.provenanceColumns.importedAt}</th>
                  </tr>
                </thead>
                <tbody>
                  {record.value.provenance.map((row, index) => (
                    <tr key={`${row.kind}-${row.target}-${index}`}>
                      <td>{row.kind}</td>
                      <td className="mono">{row.target}</td>
                      <td className="mono">{row.sourceHash === null ? "—" : `${row.sourceHash.slice(0, 16)}…`}</td>
                      <td>{row.origin}</td>
                      <td className="mono">{row.importedAt ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* The prototype's `Relations` table. */}
          {record.value.relations.length === 0 ? null : (
            <section className={"sec"} data-ms-issue-relations="" aria-labelledby="ms-issue-relations">
              <h2 id="ms-issue-relations">{copy.relationsHeading}</h2>
              <table className={"mini-table"}>
                <thead>
                  <tr>
                    <th scope="col">{copy.relationsColumns.relation}</th>
                    <th scope="col">{copy.relationsColumns.issue}</th>
                    <th scope="col">{copy.relationsColumns.title}</th>
                  </tr>
                </thead>
                <tbody>
                  {record.value.relations.map((relation) => (
                    <tr key={`${relation.relation}-${relation.issue}`}>
                      <td>{relation.relation}</td>
                      <td className="mono">{relation.issue}</td>
                      <td>{relation.title ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* The prototype's `Identity keys`: the tracker identity, when the store has one. */}
          {record.value.identityKey === null && record.value.provider === null ? null : (
            <section className={"sec"} aria-labelledby="ms-issue-identity-keys">
              <h2 id="ms-issue-identity-keys">{copy.identityKeysHeading}</h2>
              <dl className={"fields"}>
                {record.value.identityKey === null ? null : (
                  <div className="field">
                    <dt>{copy.identityKeyLabel}</dt>
                    <dd className="mono">{record.value.identityKey}</dd>
                  </div>
                )}
                {record.value.provider === null ? null : (
                  <div className="field">
                    <dt>{copy.providerLabel}</dt>
                    <dd className="mono">{record.value.provider}</dd>
                  </div>
                )}
              </dl>
            </section>
          )}
          </div>
        </div>

          {/* The closure note is a closed issue's fact; an open one has none. */}
          {record.value.closureNote === null ? null : (
            <Collapsible summary={copy.closureNoteHeading} defaultOpen>
              <p className={"detail-text"} data-ms-closure-note="">
                {record.value.closureNote}
              </p>
            </Collapsible>
          )}
        </>
      ) : record.kind === "unavailable" ? (
        <EmptyState
          arm="unavailable"
          labelWord={copy.absence.unavailable.labelWord}
          heading={copy.absence.unavailable.heading}
          body={copy.absence.unavailable.body}
          reason={record.reason}
        />
      ) : (
        <EmptyState
          arm="absent"
          labelWord={copy.absence.absent.labelWord}
          heading={copy.absence.absent.heading}
          body={copy.absence.absent.body}
          pointer={copy.absence.absent.pointer}
        />
      )}
    </article>
  );
}
