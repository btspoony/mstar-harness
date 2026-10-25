/**
 * `@mstar-harness/ui` — the host-agnostic presentation layer.
 *
 * Consumed as TypeScript source, shipped as type declarations only (plan
 * Technical decisions §1): a JS build would be a second artifact to keep in
 * step with the source both hosts already bundle, and a copied CSS file could
 * drift from the tokens beside it.
 *
 * Task 1 landed the design system (tokens, base layer, scheme contract);
 * Task 2 lands the view-model transforms. Components, screens and the
 * dictionary follow in Tasks 3–5 and are exported from here as they land.
 *
 * The stylesheets are side-effect imports; a host that wants only the tokens
 * may import `@mstar-harness/ui/styles/tokens.css` directly.
 */

import "./styles/tokens.css";
import "./styles/base.css";

export * from "./view-model/contracts.ts";
export * from "./view-model/format.ts";
export * from "./view-model/state.ts";
export * from "./view-model/status.ts";
export * from "./view-model/issues.ts";
export * from "./view-model/workflows.ts";
export * from "./view-model/iterations.ts";
export * from "./view-model/projects.ts";
export * from "./view-model/overview.ts";
export * from "./view-model/focus.ts";

/**
 * The primitives (Task 3). Each is exported by name, not by a namespace glob:
 * the API both hosts mount should be readable in one list, and a component that
 * later stops existing (a `Sparkline` with the trend it drew) disappears from
 * this file rather than lingering behind a wildcard.
 */
export { StatusDot } from "./components/StatusDot.tsx";
export { Badge } from "./components/Badge.tsx";
export { ProgressBar, progressPercent } from "./components/ProgressBar.tsx";
export { TruncatedText } from "./components/TruncatedText.tsx";
export { Notice } from "./components/Notice.tsx";
export { EmptyState, listEmptyFamily } from "./components/EmptyState.tsx";
export { LiveRegion } from "./components/LiveRegion.tsx";
export { Pager, hasNext, hasPrevious, pageRange } from "./components/Pager.tsx";
export { DataTable } from "./components/DataTable.tsx";
export { Field } from "./components/Field.tsx";
export { FieldGroup } from "./components/FieldGroup.tsx";
export { Row } from "./components/Row.tsx";
export { Collapsible } from "./components/Collapsible.tsx";
export { Nav } from "./components/Nav.tsx";
export { Breadcrumb } from "./components/Breadcrumb.tsx";
export { Tabs } from "./components/Tabs.tsx";
export { FilterBar } from "./components/FilterBar.tsx";

export type { StatusDotProps } from "./components/StatusDot.tsx";
export type { BadgeProps } from "./components/Badge.tsx";
export type { ProgressBarProps } from "./components/ProgressBar.tsx";
export type { TruncatedTextProps } from "./components/TruncatedText.tsx";
export type { NoticeProps } from "./components/Notice.tsx";
export type { AbsenceArm, EmptyStateProps } from "./components/EmptyState.tsx";
export type { LiveRegionProps } from "./components/LiveRegion.tsx";
export type { PagerProps } from "./components/Pager.tsx";
export type { DataTableColumn, DataTableProps } from "./components/DataTable.tsx";
export type { FieldProps } from "./components/Field.tsx";
export type { FieldGroupProps } from "./components/FieldGroup.tsx";
export type { RowProps } from "./components/Row.tsx";
export type { CollapsibleProps } from "./components/Collapsible.tsx";
export type { NavItem, NavProps } from "./components/Nav.tsx";
export type { BreadcrumbProps, Crumb } from "./components/Breadcrumb.tsx";
export type { TabItem, TabsProps } from "./components/Tabs.tsx";
export type { AppliedFilter, FilterBarProps, FilterField, FilterOption } from "./components/FilterBar.tsx";

/**
 * The business screens (Task 4), one batch at a time. Each takes its data, its
 * copy and its compact/locale decisions as props: fetching, routing and the host
 * shell stay with the adapter, and every absence arm it renders was resolved by
 * `state.ts` before it arrived.
 */
export { Overview } from "./screens/Overview.tsx";
export { Focus } from "./screens/Focus.tsx";

export { Issues } from "./screens/Issues.tsx";
export { IssueDetail } from "./screens/IssueDetail.tsx";

export type { OverviewCopy, OverviewProps } from "./screens/Overview.tsx";
export type { FocusCopy, FocusProps } from "./screens/Focus.tsx";
export { Workflows } from "./screens/Workflows.tsx";
export { WorkflowDetail } from "./screens/WorkflowDetail.tsx";

export type { IssuesCopy, IssuesProps } from "./screens/Issues.tsx";
export type { IssueDetailCopy, IssueDetailProps } from "./screens/IssueDetail.tsx";
export { Iterations } from "./screens/Iterations.tsx";
export { IterationDetail } from "./screens/IterationDetail.tsx";

export type { WorkflowsCopy, WorkflowsProps } from "./screens/Workflows.tsx";
export type { WorkflowDetailCopy, WorkflowDetailProps } from "./screens/WorkflowDetail.tsx";
export type { IterationsCopy, IterationsProps } from "./screens/Iterations.tsx";
export type { IterationDetailCopy, IterationDetailProps } from "./screens/IterationDetail.tsx";

import { TONES, type Tone } from "./view-model/status.ts";

/**
 * The attribute a host sets on the product wrapper to select the value set.
 *
 * There is deliberately no `"system"` arm: `prefers-color-scheme` is a host
 * concern. A host that offers "follow the OS" resolves it itself and sets
 * `"light"` or `"dark"` here (plan Technical decisions §4).
 */
export type MsScheme = "light" | "dark";

/** The attribute name both hosts set, exported so neither re-types the string. */
export const MS_THEME_ATTRIBUTE = "data-ms-theme" as const;

/**
 * The status tone vocabulary, in the order `DESIGN.md` § Status treatments
 * lists it. The values are owned by `view-model/status.ts` so the transform
 * layer and the components cannot disagree about them; re-exported here because
 * `StatusDot` (Task 3) takes one.
 */
export const MS_TONES = TONES;

/** One status tone. */
export type MsTone = Tone;

/**
 * The container name every reflow rule queries, and the layout hook that
 * declares it. Exported so a host adapter cannot invent a second container.
 */
export const MS_CONTAINER_NAME = "pane" as const;

/** The class that declares the named size container (see `base.css`). */
export const MS_CONTAINER_CLASS = "ms-container" as const;
