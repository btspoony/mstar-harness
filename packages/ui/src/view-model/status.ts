/**
 * The status vocabulary every screen shares: enum orders, tone assignment, plan
 * bucketing and the five gate steps.
 *
 * Two rules from `DESIGN.md` are implemented here rather than in components, so
 * no component can invent its own mapping:
 *
 *  - the tone is a **secondary cue**; the label is the signal (so every helper
 *    returns a tone *and* keeps the literal enum value as its input, untouched);
 *  - a fact the read could not determine is never rendered as `0` — the gate
 *    step is `null`-able and the plan bucket keeps `Blocked` separate.
 */

/** The five status tones of `DESIGN.md` § Status treatments. */
export const TONES = ["danger", "warning", "success", "neutral", "purple"] as const;

/** One status tone. `StatusDot` takes this plus the literal enum label. */
export type Tone = (typeof TONES)[number];

/** Issue severity, most severe first — also the residual panel's row order. */
export const SEVERITIES = ["critical", "high", "medium", "low", "nit"] as const;
export type SeverityLiteral = (typeof SEVERITIES)[number];

/** Issue disposition vocabulary; everything but `open` is terminal. */
export const DISPOSITIONS = ["open", "resolved", "waived", "duplicate", "superseded"] as const;
export type DispositionLiteral = (typeof DISPOSITIONS)[number];

/** Issue kinds, in the order the filter offers them. */
export const ISSUE_KINDS = ["bug", "risk", "improvement", "request", "decision", "review-obligation"] as const;
export type IssueKindLiteral = (typeof ISSUE_KINDS)[number];

/**
 * Plan status buckets, in board order. `Blocked` is its own bucket, never folded
 * into `InProgress`: the product has to be able to say a plan is stuck.
 */
export const PLAN_STATUSES = ["Todo", "InProgress", "InReview", "Blocked", "Done"] as const;
export type PlanStatusLiteral = (typeof PLAN_STATUSES)[number];

/**
 * Catalog lifecycles. Deliberately a separate vocabulary from plan status and
 * from issue disposition: `DESIGN.md` forbids one unlabelled "status" word, and
 * the three answer different questions.
 */
export const LIFECYCLES = ["active", "archived", "superseded"] as const;
export type LifecycleLiteral = (typeof LIFECYCLES)[number];

/** Milestone statuses (roadmap feature). */
export const MILESTONE_STATUSES = ["planned", "active", "delivered", "dropped"] as const;
export type MilestoneStatusLiteral = (typeof MILESTONE_STATUSES)[number];

/**
 * The five delivery gate steps, in order. The read can only ever *mark* one of
 * the first four (`IterationGateStep`), so step 5 renders as not-yet-reached
 * forever — which is the truth, not an omission (`DESIGN.md` § Delivery steps,
 * compass D29).
 */
export const GATE_STEPS = [
  { step: 1, id: "start" },
  { step: 2, id: "execute" },
  { step: 3, id: "close" },
  { step: 4, id: "pr-delivery" },
  { step: 5, id: "merge-ready" },
] as const;

export type GateStepId = (typeof GATE_STEPS)[number]["id"];

/** How one gate step reads against the step the store proves. */
export type GateStepPosition = "reached" | "current" | "ahead";

/**
 * Severity → tone. `critical` and `high` are danger; the rest were neutral in the
 * confirmed design, and the label carries the rank.
 */
export function severityTone(severity: string): Tone {
  return severity === "critical" || severity === "high" ? "danger" : "neutral";
}

/** Whether a severity carries the emphasis weight (`DESIGN.md` § Status). */
export function severityIsEmphasised(severity: string): boolean {
  return severity === "critical" || severity === "high";
}

/**
 * Disposition → tone. Green means *resolved only*: `waived`, `duplicate` and
 * `superseded` are terminal but they are not successes, so they get the terminal
 * tone and stay visually distinct.
 */
export function dispositionTone(disposition: string): Tone {
  if (disposition === "resolved") return "success";
  if (disposition === "open") return "neutral";
  return "purple";
}

/** Plan status → tone: working is the accent's neutral sibling, done is success. */
export function planStatusTone(status: string): Tone {
  switch (status) {
    case "Done":
      return "success";
    case "Blocked":
      return "warning";
    case "InProgress":
    case "InReview":
      return "neutral";
    default:
      return "neutral";
  }
}

/** Catalog lifecycle → tone. An archived record is not a success and not an error. */
export function lifecycleTone(lifecycle: string): Tone {
  switch (lifecycle) {
    case "archived":
      return "neutral";
    case "superseded":
      return "purple";
    default:
      return "neutral";
  }
}

/** Milestone status → tone: delivered is success, dropped is terminal. */
export function milestoneStatusTone(status: string | null): Tone {
  switch (status) {
    case "delivered":
      return "success";
    case "active":
      return "neutral";
    case "dropped":
      return "purple";
    default:
      return "neutral";
  }
}

/**
 * Compass status → tone. A compass that is `active` is in flight; `locked` means
 * Phase 1 is settled (the delivery is moving), `completed` the close wrote it.
 */
export function compassStatusTone(status: string | null): Tone {
  switch (status) {
    case "active":
      return "neutral";
    case "locked":
      return "neutral";
    case "completed":
      return "success";
    default:
      return "neutral";
  }
}

/**
 * The position of each gate step against the step the store proves.
 *
 * `proven === null` (no compass row) marks nothing: the iteration records no
 * delivery position, and claiming step 1 would be a guess. The proven step is
 * `current`; anything before it is `reached`; anything after is `ahead` — and
 * because `proven` can never be 5, the fifth step is `ahead` by construction.
 */
export function gateSteps(proven: number | null): Array<{ step: number; id: GateStepId; position: GateStepPosition }> {
  return GATE_STEPS.map((entry) => ({
    ...entry,
    position:
      proven === null || proven === undefined
        ? "ahead"
        : entry.step < proven
          ? "reached"
          : entry.step === proven
            ? "current"
            : "ahead",
  }));
}

/**
 * The one-line delivery position: "step N of 5", or `null` when the store proves
 * no step. Never `0 of 5` — that would read as a measured position.
 */
export function gateStepPosition(proven: number | null): { step: number; of: 5 } | null {
  return proven === null ? null : { step: proven, of: 5 };
}

/** One plan as the board groups it. */
export type PlanLike = { planId: string; status: string | null };

/**
 * Bucket plans by status for a board. Every bucket is always present, in
 * `PLAN_STATUSES` order, with its count — a board that omits an empty bucket
 * makes "no InReview plans" indistinguishable from "the read failed".
 *
 * A status the vocabulary does not know (`null`, or a future word) lands in
 * `Todo`'s neighbour bucket rather than being dropped: an unknown status is
 * still a plan, and hiding it would misreport the total.
 */
export function bucketPlans<T extends PlanLike>(
  plans: readonly T[],
): Array<{ status: PlanStatusLiteral; count: number; plans: T[] }> {
  const known = new Map<string, T[]>(PLAN_STATUSES.map((status) => [status, []]));
  const unknown: T[] = [];
  for (const plan of plans) {
    const bucket = plan.status === null ? undefined : known.get(plan.status);
    if (bucket === undefined) unknown.push(plan);
    else bucket.push(plan);
  }
  const buckets = PLAN_STATUSES.map((status) => {
    const items = known.get(status) ?? [];
    return { status, count: items.length, plans: items };
  });
  if (unknown.length > 0) {
    // Unknown statuses are appended to the bucket they are nearest to in the
    // lifecycle, never invented as a sixth bucket the board must style.
    const todo = buckets[0];
    if (todo !== undefined) {
      todo.plans = [...todo.plans, ...unknown];
      todo.count = todo.plans.length;
    }
  }
  return buckets;
}

/** A plan's `done/total` progress, or `null` when the store records none. */
export function planProgress(done: number | null, total: number | null): { done: number; total: number } | null {
  if (done === null || total === null || total <= 0) return null;
  return { done, total };
}
