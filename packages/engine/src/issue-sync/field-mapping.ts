/**
 * field-mapping.ts — THE correspondence between local issue fields and Linear's,
 * shared by both directions.
 *
 * Two directional function sets over one table, never an inverse: D7 collapses
 * local `low` and `nit` onto Linear priority 4, so priority 4 cannot name one
 * local severity and a `fromPriority`-style converter would have to invent the
 * answer. The directions are therefore written out separately.
 *
 * `[linear.mapping]` keys are "the value the default mapping produced on that
 * side", so one table entry never means two things:
 * - import: `severity.high`, `kind.bug` — keys are LOCAL values;
 * - push: `severity.2`, `disposition.Todo` — keys are the Linear value the
 *   default produced (mirroring the import-side override test, which proves an
 *   override reaches the captured row).
 *
 * Kind maps onto a Linear LABEL only (D7 maps severity and disposition to
 * fields); whether that label exists is resolved at push time against the
 * discovered workspace label set — this module never creates one.
 */
import type { Disposition, IssueKind, Severity } from "../issue.js";
import type { LinearFacetMapping } from "../mstarc.js";
import { SyncError } from "../issue-sync.js";
import type { ProviderItem } from "./provider.js";

const KIND_VALUES: readonly IssueKind[] = ["bug", "risk", "improvement", "request", "decision", "review-obligation"];
const SEVERITY_VALUES: readonly Severity[] = ["critical", "high", "medium", "low", "nit"];

/** Linear priority bands per D7 (0 "No priority" is never written). */
const PRIORITY_BANDS = [1, 2, 3, 4] as const;

/**
 * Apply one `[linear.mapping]` facet: a blank or absent entry passes the
 * default through; a target the receiving enum does not have is refused by
 * name, so the message still points at the `.mstarc` line that caused it.
 */
function facet<T extends string>(overrides: Record<string, string> | undefined, value: T, allowed: readonly T[]): T {
  const mapped = overrides?.[value];
  if (mapped === undefined || mapped.trim() === "") return value;
  if (!allowed.includes(mapped as T)) {
    throw new SyncError(
      "sync.invalid-input",
      `[linear.mapping] maps ${JSON.stringify(value)} to ${JSON.stringify(mapped)}, which is not a recognised value`,
    );
  }
  return mapped as T;
}

// ---------------------------------------------------------------- import side

/**
 * A label naming a local kind selects it, otherwise the lossy fallback
 * `request`: a remote item carries no local kind of its own.
 */
export function kindOfItem(item: ProviderItem, mapping?: LinearFacetMapping): IssueKind {
  const matched = (item.labels ?? [])
    .map((label) => label.trim().toLowerCase())
    .find((label): label is IssueKind => (KIND_VALUES as readonly string[]).includes(label));
  return facet(mapping?.kind, matched ?? "request", KIND_VALUES);
}

/**
 * Linear `priority` → local `severity`. The local enum has no "unset", so a
 * missing or unrecognised priority lands on the neutral `medium`.
 */
export function severityOfPriority(priority: string | null, mapping?: LinearFacetMapping): Severity {
  let severity: Severity;
  switch ((priority ?? "").trim().toLowerCase()) {
    case "urgent":
    case "1":
      severity = "critical";
      break;
    case "high":
    case "2":
      severity = "high";
      break;
    case "low":
    case "4":
      severity = "low";
      break;
    default:
      severity = "medium";
  }
  return facet(mapping?.severity, severity, SEVERITY_VALUES);
}

// ------------------------------------------------------------------ push side

const STATE_OF_DISPOSITION: Record<Disposition, string> = {
  open: "Todo",
  resolved: "Done",
  // Retired is not completed: it must never read as Done.
  waived: "Canceled",
  duplicate: "Canceled",
  superseded: "Canceled",
};

const PRIORITY_OF_SEVERITY: Record<Severity, number> = {
  critical: 1,
  high: 2,
  medium: 3,
  low: 4,
  nit: 4,
};

/** Local `severity` → Linear priority band; an unknown severity is refused. */
export function priorityOfSeverity(severity: Severity, mapping?: LinearFacetMapping): number {
  if (!Object.hasOwn(PRIORITY_OF_SEVERITY, severity)) {
    throw new SyncError("sync.invalid-input", `severity ${JSON.stringify(severity)} is not a recognised local severity`);
  }
  const band = String(PRIORITY_OF_SEVERITY[severity]);
  const mapped = facet(
    mapping?.severity,
    band,
    PRIORITY_BANDS.map((value) => String(value)) as readonly string[],
  );
  return Number(mapped);
}

/**
 * The DEFAULT remote state a disposition maps to — the key a
 * `[linear.mapping] disposition.<key>` override must name. `waived`,
 * `duplicate` and `superseded` all collapse onto `Canceled`, so one key
 * redirects all three; per-disposition redirection is not expressible.
 */
export function defaultStateOfDisposition(disposition: Disposition): string {
  if (!Object.hasOwn(STATE_OF_DISPOSITION, disposition)) {
    throw new SyncError("sync.invalid-input", `disposition ${JSON.stringify(disposition)} is not a recognised local disposition`);
  }
  return STATE_OF_DISPOSITION[disposition];
}

/** Local `disposition` → Linear workflow state name; an unknown one is refused. */
export function stateOfDisposition(disposition: Disposition, mapping?: LinearFacetMapping): string {
  const state = defaultStateOfDisposition(disposition);
  const mapped = mapping?.disposition[state];
  // A state name is whatever the team's workflow calls it; only the default's
  // own target is validated, so a renamed workflow passes straight through.
  return mapped === undefined || mapped.trim() === "" ? state : mapped;
}

/** The label a local `kind` is written as; identity by default. */
export function labelOfKind(kind: IssueKind, mapping?: LinearFacetMapping): string {
  if (!(KIND_VALUES as readonly string[]).includes(kind)) {
    throw new SyncError("sync.invalid-input", `kind ${JSON.stringify(kind)} is not a recognised local kind`);
  }
  const mapped = mapping?.kind[kind];
  return mapped === undefined || mapped.trim() === "" ? kind : mapped;
}

/** The three mapped fields a push payload needs from one local issue. */
export type ProviderPayloadFields = {
  priority: number;
  state: string;
  /** The kind label's name; the adapter resolves it against the discovered workspace set. */
  label: string;
};

/** The three mapped fields a push payload needs from one local issue. */
export function providerPayloadFields(
  issue: { kind: IssueKind; severity: Severity; disposition: Disposition },
  mapping?: LinearFacetMapping,
): ProviderPayloadFields {
  return {
    priority: priorityOfSeverity(issue.severity, mapping),
    state: stateOfDisposition(issue.disposition, mapping),
    label: labelOfKind(issue.kind, mapping),
  };
}
