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
import { ProgressBar } from "../components/ProgressBar.tsx";
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
  /** The idle line: no active lifecycle is the ordinary state between lifecycles. */
  bindingIdle: string;
  /** One muted line in the workflow panel while the session is idle. */
  idleHint: string;
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
  /** The overview read's plan count for the delivery iteration. */
  iterationPlans: (count: number) => string;
  enforcementLabel: (flag: string) => string;
  /** The three project-scoped panels, shared with the Overview screen's copy. */
  residualsHeading: string;
  residualsTotal: () => string;
  /** The residuals panel's scope, so its counts cannot be read as a project's. */
  residualsScope: string;
  /** The milestones panel's prefix for the store's unattributed bucket. */
  milestoneProjectUnattributed: string;
  milestonesHeading: string;
  milestoneProgress: (done: number, total: number) => string;
  milestoneOpenCount: (open: number) => string;
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
    case "idle":
      // One compact status line: the session is between lifecycles, which is a
      // state, not a failure to explain at length.
      return (
        <div className="screen-meta" data-ms-binding="idle">
          <span className="status tone-neutral">
            <span className="dot" aria-hidden="true" />
            <span>{copy.bindingIdle}</span>
          </span>
        </div>
      );
    case "error":
      return (
        <div className={"wf-summary"} data-ms-binding="error">
          {/* A gate message is a diagnostic: one secondary line, truncated, with the
              full text on the title — never the mono workflow-id slot. */}
          <span className="secondary t-12 trunc" data-ms-binding-message="" title={binding.message}>
            <TruncatedText text={binding.message} />
          </span>
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
      {/* `bucketPlans` files an unrecorded status under Todo, so the group heading cannot
          say that the store never recorded one. The word is what keeps a colour (or a
          missing colour) from being the only channel. */}
      {plan.status === null ? (
        <span className="t-11 muted" data-ms-plan-status-absent="">
          {copy.planStatusAbsent}
        </span>
      ) : null}
      {plan.note === null ? (
        plan.blockedReason === null ? (
          <span className="p-prog" data-ms-progress="absent" data-ms-progress-absent="">
            {copy.progressAbsent}
          </span>
        ) : null
      ) : (
        <span className="p-prog" data-ms-progress="recorded" data-ms-progress-note="">
          <TruncatedText text={plan.note} />
        </span>
      )}
      {plan.blockedReason === null ? null : (
        <span className="p-prog" data-ms-blocked-reason="">
          {copy.blockedLabel}:{" "}
          <TruncatedText text={plan.blockedReason} />
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

/** One project-scoped panel's arm, chosen from the model's own resolution. */
function ProjectArm(props: {
  arm: AbsenceArm;
  copy: FocusCopy;
  heading: string;
  reason?: string;
}) {
  return (
    <EmptyState
      arm={props.arm}
      labelWord={props.copy.absence[props.arm].labelWord}
      heading={props.heading}
      body={props.copy.absence[props.arm].body}
      reason={props.arm === "unavailable" ? props.reason : undefined}
      detail={props.arm === "not-applicable" ? props.reason : undefined}
      pointer={props.arm === "absent" ? props.copy.absence.absent.pointer : undefined}
      hint={props.arm === "empty" ? props.copy.absence.empty.hint : undefined}
    />
  );
}

/** Panel 2 — open residual issues by severity, from the shared overview read. */
function ResidualsPanel(props: { overview: NonNullable<FocusModel["overview"]>; copy: FocusCopy }) {
  const { overview, copy } = props;
  const residuals = overview.residuals;
  return (
    <section className="panel" aria-labelledby="ms-focus-residuals">
      <div className="panel-head">
        <h2 className="panel-title" id="ms-focus-residuals">
          {copy.residualsHeading}
        </h2>
        {/* The scope, stated: these counts are store-wide while the milestones beside
            them are project-scoped, and the two must not be read as one another's. */}
        {residuals.kind === "populated" ? (
          <span className="panel-meta" data-ms-residuals-scope="">
            {copy.residualsScope}
          </span>
        ) : null}
      </div>
      <div className="panel-body">
        {residuals.kind === "populated" ? (
          <dl className="res-grid" data-ms-focus-residuals="">
            {residuals.value.rows.map((row) => (
              <div key={row.severity} className="res-row" data-ms-severity={row.severity} data-ms-count={row.count}>
                <dt className="sev">
                  <StatusDot label={row.severity} tone={row.tone} mono />
                </dt>
                <dd className={row.emphasised ? "num is-strong" : "num"}>{row.count}</dd>
              </div>
            ))}
          </dl>
        ) : residuals.kind === "loading" ? null : (
          <ProjectArm
            arm={residuals.kind}
            copy={copy}
            heading={copy.residualsHeading}
            reason={residuals.kind === "unavailable" || residuals.kind === "not-applicable" ? residuals.reason : undefined}
          />
        )}
      </div>
    </section>
  );
}

/** Panel 3 — the project's milestones, up to the overview's own cap. */
function MilestonesPanel(props: { overview: NonNullable<FocusModel["overview"]>; copy: FocusCopy }) {
  const { overview, copy } = props;
  const milestones = overview.milestones;
  return (
    <section className="panel" aria-labelledby="ms-focus-milestones">
      <div className="panel-head">
        <h2 className="panel-title" id="ms-focus-milestones">
          {copy.milestonesHeading}
        </h2>
        {overview.milestoneProject === null ? null : (
          <span className="panel-meta mono" data-ms-milestone-scope="">
            {overview.milestoneProject === "_default" ? `${copy.milestoneProjectUnattributed} ` : null}
            {overview.milestoneProject}
          </span>
        )}
      </div>
      <div className="panel-body">
        {milestones.kind === "populated" ? (
          <div data-ms-focus-milestones="">
            {milestones.value.map((row) => (
              <div key={row.milestoneId} className="milestone-row" data-ms-milestone-row="">
                <div className="milestone-top">
                  {row.status === null ? null : (
                    <span className={`status tone-${row.statusTone}`} aria-label={row.status}>
                      <span className="dot" aria-hidden="true" />
                    </span>
                  )}
                  <span className="milestone-name">
                    <TruncatedText text={row.name} />
                  </span>
                  {row.target === null ? null : <span className="milestone-target">{row.target}</span>}
                </div>
                {row.progress === null ? null : (
                  <div className="milestone-foot">
                    <ProgressBar done={row.progress.retired} total={row.progress.total} />
                    <span className="milestone-counts">
                      <span className="num">{copy.milestoneProgress(row.progress.retired, row.progress.total)}</span>
                      <span>{copy.milestoneOpenCount(row.openIssues)}</span>
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : milestones.kind === "loading" ? null : (
          <ProjectArm
            arm={milestones.kind}
            copy={copy}
            heading={copy.milestonesHeading}
            reason={milestones.kind === "unavailable" || milestones.kind === "not-applicable" ? milestones.reason : undefined}
          />
        )}
      </div>
    </section>
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
        {(model.binding.kind === "idle" || model.binding.kind === "unbound") &&
        workflow.kind !== "unavailable" ? (
          // No active lifecycle is the ordinary state between lifecycles: one muted
          // hint, no board, and none of the absence stack's prose. But only while the
          // read is merely absent — an UNAVAILABLE read is a fact the reader still
          // gets, in its own arm with the transport's reason.
          <p className="muted t-12" data-ms-workflow-idle="">
            {copy.idleHint}
          </p>
        ) : workflow.kind === "populated" && workflow.value !== null ? (
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

      {/* 2 + 3 — the project-scoped panels from ONE shared overview read (plan
          Task 1, contract C3). No overview read wired, nothing renders for them:
          an arm no transport answered must not be claimed. */}
      {model.overview === undefined ? null : (
        <>
          <ResidualsPanel overview={model.overview} copy={copy} />
          <MilestonesPanel overview={model.overview} copy={copy} />
        </>
      )}

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
            {/* The overview read's compass facts for THIS iteration: the session's own
                delivery line stays authoritative, the project read only adds what it
                states about the same iteration. */}
            {model.overview?.latestIteration.kind === "populated" &&
            model.overview.latestIteration.value?.iterationId === model.delivery.iterationId ? (
              <div className="wf-summary" data-ms-iteration-compass="">
                {model.overview.latestIteration.value.compassStatus === null ? null : (
                  <StatusDot label={model.overview.latestIteration.value.compassStatus} tone={model.overview.latestIteration.value.compassTone} mono />
                )}
                <span className="muted t-11">
                  {copy.iterationPlans(model.overview.latestIteration.value.planCount)}
                </span>
              </div>
            ) : null}
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
