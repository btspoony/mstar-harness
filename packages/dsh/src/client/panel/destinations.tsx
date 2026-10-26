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
  /** Open one record from the list (the shell owns the open record). */
  readonly onOpen?: (id: string) => void
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

export function IssuesDestination({ state, locale, query, onQueryChange, onOpen }: DestinationProps): React.ReactElement {
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
        {...(onOpen === undefined ? {} : { onOpen })}
      />
    </div>
  )
}

export function WorkflowsDestination({ state, locale, onOpen }: DestinationProps): React.ReactElement {
  const copy = copyFor(locale)
  const screenCopy = {
    ...copy.workflows,
    // The pane keeps the prototype's filter row: the table's own status and type, plus
    // a search over the id and the catalog title.
    filters: {
      ...copy.workflows.filters,
    },
    empty: { ...copy.state.empty, heading: copy.workflows.pageTitle },
    unavailable: { ...copy.state.unavailable, heading: copy.workflows.pageTitle },
    absent: { ...copy.state.absent, heading: copy.workflows.pageTitle },
  }
  if (state.kind !== 'ok') return <ReadState state={state} copy={copy} />
  const data = state.envelope.data
  if (data === null) return <ReadState state={{ kind: 'unavailable', reason: 'no workflow list' }} copy={copy} />
  return (
    <div data-ms-destination-body="workflows">
      <Workflows
        model={workflowListModel({ data: data as WorkflowListDTO, projection: state.envelope.projection })}
        copy={screenCopy}
        {...(onOpen === undefined ? {} : { onOpen })}
      />
    </div>
  )
}

export function IterationsDestination({ state, locale, onOpen }: DestinationProps): React.ReactElement {
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
      <>
        <Iterations
          model={iterationListModel({ data: data as IterationListDTO, projection: state.envelope.projection })}
          copy={screenCopy}
          {...(onOpen === undefined ? {} : { onOpen })}
        />
        {/* Same disclosure shape as the Workflows list and the Overview members:
            the reader keeps an explicit page and the screen says how much of the
            store it is showing, so a cap is never silent. */}
        {(data as IterationListDTO).total > (data as IterationListDTO).items.length ? (
          <p className={css.truncated} data-ms-truncated={(data as IterationListDTO).total}>
            {copy.workflows.truncated((data as IterationListDTO).items.length, (data as IterationListDTO).total)}
          </p>
        ) : null}
      </>
    </div>
  )
}

export function ProjectsDestination({ state, locale, onOpen }: DestinationProps): React.ReactElement {
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
      <Projects
        model={projectListModel({ data: data as ProjectListDTO, projection: state.envelope.projection })}
        copy={screenCopy}
        {...(onOpen === undefined ? {} : { onOpen })}
      />
    </div>
  )
}

/* ------------------------------- detail routes ------------------------------- */

import {
  EmptyState,
  roadmapFeatureArm,
  IssueDetail,
  WorkflowDetail,
  IterationDetail,
  ProjectDetail,
  Iterations as IterationsScreen,
  iterationListModel as iterationListModelFor,
  roadmapBody,
  projectIdentity,
  resolveRead,
  issueDetailModel,
  workflowDetailModel,
  iterationDetailModel,
  type ProjectFeature,
} from '@mstar-harness/ui'
import type { IssueDetail as IssueDetailDTO, WorkflowDTO, IterationDTO } from '@mstar-harness/engine'

/** The four detail views a destination can open. */
export type DetailView = 'issue-detail' | 'workflow-detail' | 'iteration-detail' | 'project-detail'

export type DetailProps = {
  readonly view: DetailView
  readonly id: string
  readonly state: MstarDashboardViewState
  readonly locale: Locale
  readonly onBack: () => void
  readonly onOpenWorkflow?: (id: string) => void
  /** A project detail's scoped Iterations read (`project` enforced on the request). */
  readonly projectIterations?: MstarDashboardViewState
  /** A project detail's scoped Issues read (`project` enforced on the request). */
  readonly projectIssues?: MstarDashboardViewState
}

/**
 * One detail route. A record read's `null` is ABSENT (the record declares
 * nothing here); a projection with no generation is UNAVAILABLE (the read could
 * not be made) — the shared resolvers own that split, this adapter only passes
 * the envelope through.
 */
export function DetailBody({ view, id, state, locale, onBack, onOpenWorkflow, projectIterations, projectIssues }: DetailProps): React.ReactElement {
  const copy = copyFor(locale)
  if (state.kind !== 'ok') return <ReadState state={state} copy={copy} />
  const envelope = state.envelope
  const data = envelope.data
  switch (view) {
    case 'issue-detail': {
      const issueCopy = {
        ...copy.issueDetail,
        absence: {
          unavailable: { ...copy.state.unavailable, heading: copy.issueDetail.identityHeading },
          absent: { ...copy.state.absent, heading: copy.issueDetail.identityHeading },
        },
      }
      return (
        <IssueDetail
          read={{
            data: data === null ? null : issueDetailModel(data as IssueDetailDTO),
            projection: envelope.projection,
          }}
          copy={issueCopy}
          onBack={onBack}
        />
      )
    }
    case 'workflow-detail': {
      // `data: null` has two causes: the record does not exist (absent) and the
      // workflow could not be read (a projection with no generation →
      // unavailable). `resolveRead` owns that split; bypassing it collapsed the
      // two arms.
      // `null` has two causes and the projection tells them apart: no published
      // generation means the read could not be made (`unavailable`), a published
      // one means the record does not exist (`absent`).
      // One absence authority: the shared model resolves a null record by the
      // projection generation (no generation → `unavailable` with its own cause).
      const model = workflowDetailModel({ data: data as WorkflowDTO | null, projection: envelope.projection })
      return <WorkflowDetail model={model} copy={{ ...copy.workflowDetail, absence: {
        'not-applicable': { ...copy.state['not-applicable'], heading: copy.workflowDetail.catalogHeading },
        absent: { ...copy.state.absent, heading: copy.workflowDetail.catalogHeading },
        empty: { ...copy.state.empty, heading: copy.workflowDetail.catalogHeading },
        unavailable: { ...copy.state.unavailable, heading: copy.workflowDetail.catalogHeading },
      } }} onBack={onBack} />
    }
    case 'iteration-detail': {
      // Same for the iteration: a null record is NOT `absent` when the execution
      // projection has no generation — the shared model answers `unavailable`.
      const model = iterationDetailModel({ data: data as IterationDTO | null, projection: envelope.projection })
      return (
        <IterationDetail
          model={model}
          copy={{
            ...copy.iterationDetail,
            unavailable: { ...copy.state.unavailable, heading: copy.iterationDetail.catalogHeading },
            absent: { ...copy.state.absent, heading: copy.iterationDetail.catalogHeading },
          }}
          onBack={onBack}
          {...(onOpenWorkflow === undefined ? {} : { onOpenWorkflow })}
        />
      )
    }
    case 'project-detail': {
      return (
        <ProjectDetailDestination
          key={id}
          id={id}
          state={state}
          locale={locale}
          onBack={onBack}
          {...(projectIterations === undefined ? {} : { iterations: projectIterations })}
          {...(projectIssues === undefined ? {} : { issues: projectIssues })}
        />
      )
    }
  }
}

/**
 * The project's identity, from wherever the envelope actually carries a catalog
 * row. An `absent` roadmap authority is NOT permission to invent identity: the
 * project exists (its catalog row is in the same envelope) even when it declares
 * no roadmap, so the title/path/lifecycle come from that row. Only a genuinely
 * missing catalog row falls back — and the fallback claims less, not more.
 */
export function projectIdentityOf(
  id: string,
  data: unknown,
): { projectId: string; title: string; description: string | null; lifecycle: string; lifecycleTone: 'neutral'; path: string } {
  const catalog = (data as { catalog?: Parameters<typeof projectIdentity>[0] | null } | null | undefined)?.catalog
  if (catalog !== null && catalog !== undefined) return projectIdentity(catalog) as never
  // Nothing is known: no guessed path, no guessed lifecycle.
  return { projectId: id, title: id, description: null, lifecycle: 'unknown', lifecycleTone: 'neutral', path: '' }
}

/**
 * `project-detail` — the only place the product expresses its hierarchy.
 *
 * The adapter owns the FEATURE state: the fixed three tabs, with `Roadmap`
 * permanently the default (a constant, never "first non-empty"). Each tab's body
 * comes from its own project-scoped read: `roadmap` (the project's authority),
 * `issues?project=<id>` and `iterations?project=<id>`.
 */
export function ProjectDetailDestination(props: {
  id: string
  state: MstarDashboardViewState
  locale: Locale
  onBack: () => void
  iterations?: MstarDashboardViewState
  issues?: MstarDashboardViewState
  /** Test seam: the tab the page opens on. Production always starts at Roadmap. */
  initialFeature?: ProjectFeature
}): React.ReactElement {
  const copy = copyFor(props.locale)
  const [feature, setFeature] = React.useState<ProjectFeature>(props.initialFeature ?? 'roadmap')
  if (props.state.kind !== 'ok') return <ReadState state={props.state} copy={copy} />
  const data = props.state.envelope.data
  const envelope = props.state.envelope
  // The shared arm owns the decision (unknown project → `absent`, no generation →
  // `unavailable`), so both hosts answer a project the same way.
  const featureArm = roadmapFeatureArm({ data: data as never, projection: envelope.projection })
  const roadmap = roadmapBody(featureArm)
  const iterationsCopy = {
    ...copy.iterations,
    notStarted: copy.workflowDetail.fields.notStarted,
    empty: { ...copy.state.empty, heading: copy.iterations.pageTitle },
    absent: { ...copy.state.absent, heading: copy.iterations.pageTitle },
    unavailable: { ...copy.state.unavailable, heading: copy.iterations.pageTitle },
  }
  const issuesCopyForProject = {
    ...copy.issues,
    pager: { previous: copy.common.previous, next: copy.common.next, range: copy.issues.range },
    anyOption: copy.common.anyOption,
    filteredEmpty: { ...copy.state['empty-filtered'], heading: copy.issues.pageTitle },
    storeEmpty: { ...copy.state.empty, heading: copy.issues.pageTitle },
    absent: { ...copy.state.absent, heading: copy.issues.pageTitle },
    unavailable: { ...copy.state.unavailable, heading: copy.issues.pageTitle },
  }
  const iterationsState = props.iterations ?? ({ kind: 'waiting' } as const)
  const issuesState = props.issues ?? ({ kind: 'waiting' } as const)
  return (
    <ProjectDetail
      identity={projectIdentityOf(props.id, data)}
      feature={feature}
      onFeatureChange={(next: ProjectFeature) => setFeature(next)}
      roadmap={roadmap as never}
      issues={
        issuesState.kind === 'ok' && issuesState.envelope.data !== null
          ? (
            <Issues
              model={issueListModel({ data: issuesState.envelope.data as IssuePage, projection: issuesState.envelope.projection }, parseIssueQuery(''))}
              query={parseIssueQuery('')}
              copy={issuesCopyForProject}
              options={ISSUE_OPTIONS}
              onQueryChange={() => {}}
            />
          )
          : issuesState.kind === 'ok'
            ? (
              <EmptyState
                arm="empty"
                labelWord={copy.state.empty.labelWord}
                heading={copy.issues.pageTitle}
                body={copy.state.empty.body}
              />
            )
            : <ReadState state={issuesState} copy={copy} />
      }
      iterations={
        iterationsState.kind === 'ok' && iterationsState.envelope.data !== null
          ? (
            <IterationsScreen
              model={iterationListModelFor({
                data: iterationsState.envelope.data as IterationListDTO,
                projection: iterationsState.envelope.projection,
              })}
              copy={iterationsCopy}
            />
          )
          : iterationsState.kind === 'ok'
            ? (
              <EmptyState
                arm="empty"
                labelWord={copy.state.empty.labelWord}
                heading={copy.iterations.pageTitle}
                body={copy.state.empty.body}
              />
            )
            : <ReadState state={iterationsState} copy={copy} />
      }
      copy={{
        ...copy.projectDetail,
        absence: {
          absent: { ...copy.state.absent, heading: copy.projectDetail.features.roadmap },
          empty: { ...copy.state.empty, heading: copy.projectDetail.features.roadmap },
          unavailable: { ...copy.state.unavailable, heading: copy.projectDetail.features.roadmap },
          'not-applicable': { ...copy.state['not-applicable'], heading: copy.projectDetail.features.roadmap },
        },
      }}
      onBack={props.onBack}
    />
  )
}
