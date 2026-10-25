/**
 * `Focus` — the dsh Sidebar's session view (IA §2, §3.2).
 *
 * It answers "what is this session doing", in five facts and this order: the
 * binding line, the bound workflow's plan board, the recorded progress (or the
 * blocked reason) of the plans that are moving, the session's delivery line, and
 * the enforcement flag.
 *
 * Not here, by construction and by test: every project-scoped panel (residuals,
 * milestones, the trend), the knowledge rollup (D30), and any page-validity fact.
 * Each of those is answered by a second session differently or belongs one
 * destination away, and IA §2 states the rule the screen must not break.
 *
 * Every absence goes through `state.ts`: the model resolved each member, and this
 * component only chooses the copy for the arm it was handed.
 */
import { EmptyState, type AbsenceArm } from "../components/EmptyState.tsx";
import { StatusDot } from "../components/StatusDot.tsx";
import { TruncatedText } from "../components/TruncatedText.tsx";
import type { FocusGroup, FocusModel, FocusPlan, FocusBinding } from "../view-model/focus.ts";
import type { Tone } from "../view-model/status.ts";
import css from "./Focus.module.css";

/** Every visible string this screen needs. Task 5 supplies them. */
export type FocusCopy = {
  pageTitle: string;
  /** The binding header: `bound to this session`. */
  bindingBound: (workflowId: string) => string;
  bindingTerminal: (workflowId: string) => string;
  bindingUnbound: string;
  pickerLabel: string;
  boardHeading: string;
  boardEmpty: string;
  /** A group's heading, e.g. `In progress · 2`. */
  groupHeading: (status: string, count: number) => string;
  plansProgress: (done: number, total: number) => string;
  /** The recorded next move for an in-progress plan. */
  progressLabel: string;
  /** The recorded blocked reason. The copy must NOT promise a checklist step. */
  blockedLabel: string;
  /** The plan records neither progress nor a blocked reason. */
  progressAbsent: string;
  deliveryHeading: string;
  deliveryLine: (iterationId: string, step: number, of: number) => string;
  deliveryNoIteration: string;
  enforcementLabel: (flag: string) => string;
  absence: {
    "not-applicable": { labelWord: string; body: string };
    absent: { labelWord: string; body: string; pointer: string };
    empty: { labelWord: string; body: string; hint: string };
    unavailable: { labelWord: string; body: string };
  };
};

export type FocusProps = {
  model: FocusModel;
  copy: FocusCopy;
  /** Re-bind through the host. The picker is the only write surface left. */
  onPick?: (workflowId: string) => void;
};

/** The binding line, or the picker when it is not bound. */
function Binding(props: { binding: FocusBinding; copy: FocusCopy; onPick?: (id: string) => void }) {
  const { binding, copy } = props;
  switch (binding.kind) {
    case "bound":
      return (
        <p className={css.binding} data-ms-binding="bound">
          <TruncatedText text={copy.bindingBound(binding.workflowId)} />
        </p>
      );
    case "terminal":
      return (
        <p className={css.binding} data-ms-binding="terminal">
          <TruncatedText text={copy.bindingTerminal(binding.workflowId)} />
        </p>
      );
    case "unbound":
      return (
        <div className={css.binding} data-ms-binding="unbound">
          <p className={css.bindingText}>{copy.bindingUnbound}</p>
          {props.onPick === undefined ? null : (
            <div className={css.picker} role="group" aria-label={copy.pickerLabel} data-ms-picker="">
              {binding.picker.map((id) => (
                <button key={id} type="button" className={css.pick} onClick={() => props.onPick?.(id)}>
                  {id}
                </button>
              ))}
            </div>
          )}
        </div>
      );
    case "error":
      return (
        <div className={css.binding} data-ms-binding="error">
          <p className={css.bindingText}>{binding.message}</p>
          {binding.candidates.length === 0 ? null : (
            <div className={css.picker} role="group" aria-label={copy.pickerLabel} data-ms-picker="">
              {binding.candidates.map((id) => (
                <button key={id} type="button" className={css.pick} onClick={() => props.onPick?.(id)}>
                  {id}
                </button>
              ))}
            </div>
          )}
        </div>
      );
  }
}

/** One plan line: its id, its status, and its recorded progress or blocked reason. */
function Plan(props: { plan: FocusPlan; copy: FocusCopy }) {
  const { plan, copy } = props;
  return (
    <div className={css.plan} data-ms-plan={plan.planId}>
      <p className={css.planHead}>
        <TruncatedText text={plan.planId} />
        <StatusDot label={plan.status ?? ""} tone={plan.statusTone as Tone} mono />
      </p>
      {plan.blockedReason === null ? null : (
        <p className={css.blocked} data-ms-blocked-reason="">
          <span className={css.lineLabel}>{copy.blockedLabel}</span>
          <TruncatedText text={plan.blockedReason} block />
        </p>
      )}
      {plan.note === null ? null : (
        <p className={css.note} data-ms-progress-note="">
          <span className={css.lineLabel}>{copy.progressLabel}</span>
          <TruncatedText text={plan.note} block />
        </p>
      )}
      {plan.note === null && plan.blockedReason === null ? (
        <p className={css.noteAbsent} data-ms-progress-absent="">
          {copy.progressAbsent}
        </p>
      ) : null}
    </div>
  );
}

/** One status group; a group with no plans is still a group (a count, not a gap). */
function Group(props: { group: FocusGroup; copy: FocusCopy }) {
  return (
    <section className={css.group} data-ms-group={props.group.status}>
      <h3 className={css.groupHead}>{props.copy.groupHeading(props.group.status, props.group.count)}</h3>
      {props.group.plans.map((plan) => (
        <Plan key={plan.planId} plan={plan} copy={props.copy} />
      ))}
    </section>
  );
}

export function Focus(props: FocusProps) {
  const { model, copy } = props;
  const workflow = model.workflow;
  return (
    <article className={css.page} data-ms-screen="focus">
      <h1 className={css.title}>{copy.pageTitle}</h1>

      {/* 1 — the binding line. Always present. */}
      <Binding binding={model.binding} copy={copy} onPick={props.onPick} />

      {/* 2 + 3 — the bound workflow and its plan board, with each plan's
          recorded progress or blocked reason. */}
      <section className={css.panel} aria-labelledby="ms-focus-board">
        <h2 className={css.heading} id="ms-focus-board">
          {copy.boardHeading}
        </h2>
        {workflow.kind === "populated" && workflow.value !== null ? (
          <>
            <p className={css.workflowLine} data-ms-workflow="">
              <TruncatedText text={workflow.value.id} />
              <span className={css.workflowMeta}>
                {workflow.value.type}
                {workflow.value.phase === null ? "" : ` · ${workflow.value.phase}`}
              </span>
              <span className={css.branch} data-ms-branch-chain="">
                {[workflow.value.branch.base, workflow.value.branch.source, workflow.value.branch.integration, workflow.value.branch.target]
                  .map((anchor) => anchor ?? "—")
                  .join(" → ")}
              </span>
            </p>
            {model.groups.map((group) => (
              <Group key={group.status} group={group} copy={copy} />
            ))}
          </>
        ) : workflow.kind === "populated" ? (
          <EmptyState
            arm="absent"
            labelWord={copy.absence.absent.labelWord}
            heading={copy.boardEmpty}
            body={copy.absence.absent.body}
            pointer={copy.absence.absent.pointer}
          />
        ) : (
          <EmptyState
            arm={workflow.kind as AbsenceArm}
            labelWord={copy.absence[workflow.kind as AbsenceArm].labelWord}
            heading={copy.boardEmpty}
            body={copy.absence[workflow.kind as AbsenceArm].body}
            reason={workflow.kind === "unavailable" ? workflow.reason : undefined}
            detail={workflow.kind === "not-applicable" ? workflow.reason : undefined}
          />
        )}
      </section>

      {/* 4 — the session's delivery line. A standalone delivery is sayable. */}
      <section className={css.panel} aria-labelledby="ms-focus-delivery">
        <h2 className={css.heading} id="ms-focus-delivery">
          {copy.deliveryHeading}
        </h2>
        <p className={css.delivery} data-ms-delivery={model.delivery.kind}>
          {model.delivery.kind === "no-iteration"
            ? copy.deliveryNoIteration
            : copy.deliveryLine(
                model.delivery.iterationId,
                model.delivery.position?.step ?? 0,
                model.delivery.position?.of ?? 5,
              )}
        </p>
      </section>

      {/* 5 — the enforcement flag. One line, last. */}
      <p className={css.enforcement} data-ms-enforcement={model.enforcement}>
        {copy.enforcementLabel(model.enforcement)}
      </p>
    </article>
  );
}
