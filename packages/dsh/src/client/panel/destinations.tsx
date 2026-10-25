/**
 * The five product destinations, mounted by this host (plan dsh-panel-unification
 * Task 8).
 *
 * Each one is a THIN adapter: the shared screen renders, the host only
 * (1) resolves the screen's own copy object from the shared dictionary, (2) maps
 * the engine `ReadEnvelope` through the shared view-model builder, and (3) passes
 * the one interactive seat the screen owns (`Issues`' filter query). No product
 * markup, no local state beyond what the screen's props need.
 *
 * The per-view read happens in the seat (`panel-shell.tsx`): one
 * `mstar/dashboardView` per ACTIVE destination, so mounting a destination costs
 * one request and nothing polls.
 */

import * as React from 'react'
import {
  Issues,
  Iterations,
  Notice,
  Overview,
  Projects,
  Workflows,
  copyFor,
  issueListModel,
  iterationListModel,
  overviewModel,
  parseIssueQuery,
  projectListModel,
  workflowListModel,
  type Copy,
  type IssueQuery,
  type Locale,
} from '@mstar-harness/ui'
import type { IssuePage, IterationListDTO, ProjectListDTO, WorkflowListDTO } from '@mstar-harness/engine'
import type { MstarDashboardViewState } from './use-mstar-dashboard-view.ts'
import css from './panel.module.css'

/** A destination whose read has no answer yet (or failed) says so, never blank. */
function ReadState({ state, copy }: { state: MstarDashboardViewState; copy: Copy }): React.ReactElement | null {
  if (state.kind === 'ok') return null
  if (state.kind === 'no-harness') return <Notice reason={copy.state.absent.body} />
  if (state.kind === 'loading' || state.kind === 'waiting') return <p className={css.destinationState} data-ms-destination-state="loading" />
  return <Notice reason={state.reason} lead={copy.state.unavailable.body} />
}

/** `Issues`' copy object (the screen's own absence families). */
function issuesCopy(copy: Copy) {
  return {
    ...copy.issues,
    pager: { previous: copy.common.previous, next: copy.common.next, range: copy.issues.range },
    anyOption: copy.common.anyOption,
    filteredEmpty: { ...copy.state['empty-filtered'], heading: copy.issues.pageTitle },
    storeEmpty: { ...copy.state.empty, heading: copy.issues.pageTitle },
    absent: { ...copy.state.absent, heading: copy.issues.pageTitle },
    unavailable: { ...copy.state.unavailable, heading: copy.issues.pageTitle },
  }
}

/** The vocabularies the issue filter offers (the engine's closed sets). */
const ISSUE_OPTIONS = {
  disposition: ['open', 'resolved', 'waived', 'duplicate', 'superseded'],
  project: [] as string[],
  kind: ['bug', 'risk', 'improvement', 'request', 'decision', 'review-obligation'],
  severity: ['critical', 'high', 'medium', 'low', 'nit'],
}

/** One destination's props: its read state, the locale and its interactive seat. */
export type DestinationProps = {
  readonly state: MstarDashboardViewState
  readonly locale: Locale
  readonly query?: IssueQuery
  readonly onQueryChange?: (query: IssueQuery) => void
}

export function OverviewDestination({ state, locale }: DestinationProps): React.ReactElement {
  const copy = copyFor(locale)
  const screenCopy = {
    ...copy.overview,
    workflowsEmpty: copy.overview.workflowsHeading,
    absence: {
      'not-applicable': copy.state['not-applicable'],
      absent: copy.state.absent,
      empty: copy.state.empty,
      unavailable: copy.state.unavailable,
    },
  }
  if (state.kind !== 'ok') return <ReadState state={state} copy={copy} />
  const data = state.envelope.data
  if (data === null) return <ReadState state={{ kind: 'unavailable', reason: 'no overview payload' }} copy={copy} />
  return (
    <div data-ms-destination-body="overview">
      <Overview model={overviewModel(data as never, { projection: state.envelope.projection })} copy={screenCopy} />
    </div>
  )
}

export function IssuesDestination({ state, locale, query, onQueryChange }: DestinationProps): React.ReactElement {
  const copy = copyFor(locale)
  const activeQuery = query ?? parseIssueQuery('')
  if (state.kind !== 'ok') return <ReadState state={state} copy={copy} />
  const data = state.envelope.data
  if (data === null) return <ReadState state={{ kind: 'unavailable', reason: 'no issue page' }} copy={copy} />
  return (
    <div data-ms-destination-body="issues">
      <Issues
        model={issueListModel({ data: data as IssuePage, projection: state.envelope.projection }, activeQuery)}
        query={activeQuery}
        copy={issuesCopy(copy)}
        options={ISSUE_OPTIONS}
        onQueryChange={(next) => onQueryChange?.(next)}
      />
    </div>
  )
}

export function WorkflowsDestination({ state, locale }: DestinationProps): React.ReactElement {
  const copy = copyFor(locale)
  const screenCopy = {
    ...copy.workflows,
    empty: { ...copy.state.empty, heading: copy.workflows.pageTitle },
    unavailable: { ...copy.state.unavailable, heading: copy.workflows.pageTitle },
    absent: { ...copy.state.absent, heading: copy.workflows.pageTitle },
  }
  if (state.kind !== 'ok') return <ReadState state={state} copy={copy} />
  const data = state.envelope.data
  if (data === null) return <ReadState state={{ kind: 'unavailable', reason: 'no workflow list' }} copy={copy} />
  return (
    <div data-ms-destination-body="workflows">
      <Workflows model={workflowListModel({ data: data as WorkflowListDTO, projection: state.envelope.projection })} copy={screenCopy} />
    </div>
  )
}

export function IterationsDestination({ state, locale }: DestinationProps): React.ReactElement {
  const copy = copyFor(locale)
  const screenCopy = {
    ...copy.iterations,
    notStarted: copy.workflowDetail.fields.notStarted,
    empty: { ...copy.state.empty, heading: copy.iterations.pageTitle },
    absent: { ...copy.state.absent, heading: copy.iterations.pageTitle },
    unavailable: { ...copy.state.unavailable, heading: copy.iterations.pageTitle },
  }
  if (state.kind !== 'ok') return <ReadState state={state} copy={copy} />
  const data = state.envelope.data
  if (data === null) return <ReadState state={{ kind: 'unavailable', reason: 'no iteration list' }} copy={copy} />
  return (
    <div data-ms-destination-body="iterations">
      <Iterations model={iterationListModel({ data: data as IterationListDTO, projection: state.envelope.projection })} copy={screenCopy} />
    </div>
  )
}

export function ProjectsDestination({ state, locale }: DestinationProps): React.ReactElement {
  const copy = copyFor(locale)
  const screenCopy = {
    ...copy.projects,
    empty: { ...copy.state.empty, heading: copy.projects.pageTitle },
    unavailable: { ...copy.state.unavailable, heading: copy.projects.pageTitle },
    absent: { ...copy.state.absent, heading: copy.projects.pageTitle },
  }
  if (state.kind !== 'ok') return <ReadState state={state} copy={copy} />
  const data = state.envelope.data
  if (data === null) return <ReadState state={{ kind: 'unavailable', reason: 'no project list' }} copy={copy} />
  return (
    <div data-ms-destination-body="projects">
      <Projects model={projectListModel({ data: data as ProjectListDTO, projection: state.envelope.projection })} copy={screenCopy} />
    </div>
  )
}
