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
import { Fragment } from "react";
import { EmptyState, type AbsenceArm } from "../components/EmptyState.tsx";
import { StatusDot } from "../components/StatusDot.tsx";
import { TruncatedText } from "../components/TruncatedText.tsx";
import type { FocusGroup, FocusModel, FocusPlan, FocusBinding } from "../view-model/focus.ts";
import type { GateStepId, Tone } from "../view-model/status.ts";

/** Every visible string this screen needs. Task 5 supplies them. */
export type FocusCopy = {
  pageTitle: string;
  /** The four branch anchors' labels, shared with the workflow screens. */
  branchBase: string;
  branchSource: string;
  branchIntegration: string;
  branchTarget: string;
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
  /** The store has not recorded a status for this plan. */
  planStatusAbsent: string;
  deliveryHeading: string;
  /** The fourth panel's step names, shared with the overview's track. */
  gateStepLabels: Record<GateStepId, string>;
  deliveryLine: (iterationId: string, step: number, of: number) => string;
  deliveryNoIteration: string;
  /** The iteration records no compass, so no step is proven — never `step 0 of 5`. */
  deliveryUnknownStep: string;
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
        <div className="screen-meta" data-ms-binding="bound">
          <span>
            <TruncatedText text={copy.bindingBound(binding.workflowId)} />
          </span>
        </div>
      );
    case "terminal":
      return (
        <div className="screen-meta" data-ms-binding="terminal">
          <span>
            <TruncatedText text={copy.bindingTerminal(binding.workflowId)} />
          </span>
        </div>
      );
    case "unbound":
      return (
        <div className={"wf-summary"} data-ms-binding="unbound">
          <p className={"wf-id"}>{copy.bindingUnbound}</p>
          {props.onPick === undefined ? null : (
            <div className={"chips"} role="group" aria-label={copy.pickerLabel} data-ms-picker="">
              {binding.picker.map((id) => (
                <button key={id} type="button" className={"chip"} onClick={() => props.onPick?.(id)}>
                  {id}
                </button>
              ))}
            </div>
          )}
        </div>
      );
    case "error":
      return (
        <div className={"wf-summary"} data-ms-binding="error">
          <p className={"wf-id"}>{binding.message}</p>
          {binding.candidates.length === 0 ? null : (
            <div className={"chips"} role="group" aria-label={copy.pickerLabel} data-ms-picker="">
              {binding.candidates.map((id) => (
                <button key={id} type="button" className={"chip"} onClick={() => props.onPick?.(id)}>
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
    <div className="planboard-plan" data-ms-plan={plan.planId}>
      {/* The prototype's plan line (`.planboard-plan`): a tone dot, the id, then the
          recorded note or the status word at the right edge. A plan the store has not
          given a status yet says so in words — never a colour-only dot. */}
      <span className={`dot tone-${plan.statusTone}`} aria-hidden="true" />
      <span className="p-id">
        <TruncatedText text={plan.planId} />
      </span>
      <span className="p-prog" data-ms-progress={plan.note === null ? "absent" : "recorded"}
        data-ms-progress-note={plan.note === null ? undefined : ""}
        data-ms-progress-absent={plan.note === null ? "" : undefined}>
        {/* A plan that records nothing says so; it never renders a 0 or a step the store
            did not give it. The prototype's own cell is just the note. */}
        {plan.note ?? copy.progressAbsent}
      </span>
      {plan.blockedReason === null ? null : (
        <span className="p-prog" data-ms-blocked-reason="">
          {copy.blockedLabel}: <TruncatedText text={plan.blockedReason} />
        </span>
      )}
    </div>
  );
}

/** One status column of the prototype's `.planboard`: its head carries the count. */
function Group(props: { group: FocusGroup; copy: FocusCopy }) {
  return (
    <div className="planboard-col" data-ms-group={props.group.status}>
      <div className="planboard-head">
        <span>{props.group.status}</span>
        <span className="num">{props.group.count}</span>
      </div>
      {props.group.plans.map((plan) => (
        <Plan key={plan.planId} plan={plan} copy={props.copy} />
      ))}
    </div>
  );
}

export function Focus(props: FocusProps) {
  const { model, copy } = props;
  const workflow = model.workflow;
  return (
    <article className={"screen"} data-ms-screen="focus">
      {/* The prototype's session-focus head: the title, then a chip that names the
          session and the line that says what it is bound to. */}
      <div className="screen-head">
        <h1>{copy.pageTitle}</h1>
        {/* 1 — the binding line lives in the head: the prototype's `screen-meta`
            names the session and what it is bound to, on the line under the title. */}
        <Binding binding={model.binding} copy={copy} onPick={props.onPick} />
      </div>

      {/* 2 + 3 — the bound workflow and its plan board, with each plan's
          recorded progress or blocked reason. */}
      <section className="panel" aria-labelledby="ms-focus-board">
        <div className="panel-head">
          <h2 className="panel-title" id="ms-focus-board">
            {copy.boardHeading}
          </h2>
        </div>
        <div className="panel-body">
        {workflow.kind === "populated" && workflow.value !== null ? (
          <>
            <div className="wf-summary" data-ms-workflow="">
              <span className="wf-id">
                <TruncatedText text={workflow.value.id} />
              </span>
              <span className="muted">{workflow.value.type}</span>
              {workflow.value.phase === null ? null : (
                <StatusDot label={workflow.value.phase} tone="neutral" mono />
              )}
            </div>
            {/* The prototype draws the chain as one `.branch-line` holding an anchor per
                label; a single joined string gives the line one item and no arrows. */}
            <div className="branch-line" data-ms-branch-chain="">
              {[
                [copy.branchBase, workflow.value.branch.base] as const,
                [copy.branchSource, workflow.value.branch.source] as const,
                [copy.branchIntegration, workflow.value.branch.integration] as const,
                [copy.branchTarget, workflow.value.branch.target] as const,
              ].map(([label, value], index) => (
                <Fragment key={label}>
                  {index === 0 ? null : <span className="branch-arrow" aria-hidden="true">→</span>}
                  <span className="branch-anchor">
                    <span>{label}</span> <b>{value ?? "—"}</b>
                  </span>
                </Fragment>
              ))}
            </div>
            <div className="planboard" role="group" aria-label={copy.boardHeading}>
              {model.groups.map((group) => (
                <Group key={group.status} group={group} copy={copy} />
              ))}
            </div>
          </>
        ) : workflow.kind === "populated" ? (
          <EmptyState
            arm="absent"
            labelWord={copy.absence.absent.labelWord}
            heading={copy.boardEmpty}
            body={copy.absence.absent.body}
            pointer={copy.absence.absent.pointer}
          />
        ) : workflow.kind === "loading" ? null /* A pending read has no subject
              state yet: rendering an arm would claim one the transport has not
              reached, and `copy.absence` has no `loading` key to read. */ : (
          <EmptyState
            arm={workflow.kind}
            labelWord={copy.absence[workflow.kind].labelWord}
            heading={copy.boardEmpty}
            body={copy.absence[workflow.kind].body}
            reason={workflow.kind === "unavailable" ? workflow.reason : undefined}
            detail={workflow.kind === "not-applicable" ? workflow.reason : undefined}
          />
        )}
        </div>
      </section>

      {/* 4 — the session's delivery line. A standalone delivery is sayable. */}
      <section className={"panel"} aria-labelledby="ms-focus-delivery">
        <h2 className={"panel-title"} id="ms-focus-delivery">
          {copy.deliveryHeading}
        </h2>
        {model.delivery.kind === "no-iteration" ? (
          <p className={"milestone-block"} data-ms-delivery={model.delivery.kind}>
            {copy.deliveryNoIteration}
          </p>
        ) : (
          <div className={"milestone-block"} data-ms-delivery={model.delivery.kind}>
            <p className={"milestone-block-name"}>{model.delivery.iterationId}</p>
            {/* The five-step track, as the prototype's fourth panel carries it. The model
                has held `steps` since this screen was written and nothing rendered it. */}
            <div className="gate-track" role="list" data-ms-focus-steps="">
              {model.delivery.steps.map((step) => (
                <div
                  key={step.id}
                  role="listitem"
                  className={
                    step.position === "reached"
                      ? "gate-step is-done"
                      : step.position === "current"
                        ? "gate-step is-current"
                        : "gate-step"
                  }
                  data-ms-step={step.id}
                  data-ms-step-position={step.position}
                  {...(step.position === "current" ? { "aria-current": "step" as const } : {})}
                >
                  <span className="glyph" aria-hidden="true">
                    {step.position === "reached" ? "✓" : step.position === "current" ? "●" : String(step.step)}
                  </span>
                  <span className="gate-label">{copy.gateStepLabels[step.id]}</span>
                </div>
              ))}
            </div>
            <span className={"gate-meta"} data-ms-position={model.delivery.position === null ? "unknown" : "known"}>
              {model.delivery.position === null
                ? copy.deliveryUnknownStep
                : copy.deliveryLine(model.delivery.iterationId, model.delivery.position.step, model.delivery.position.of)}
            </span>
          </div>
        )}
      </section>

      {/* 5 — the enforcement flag. One line, last. */}
      <p className={"muted"} data-ms-enforcement={model.enforcement}>
        {copy.enforcementLabel(model.enforcement)}
      </p>
    </article>
  );
}
