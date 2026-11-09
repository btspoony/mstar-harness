# ADR: The dashboard project list is one complete, unpaged engine read

Status: implemented — the roadmap entry offers a project chooser backed by complete catalog data, and unsupported parameters refuse instead of shrinking the list.

Date: 2026-10-06

Scope: the `projects` dashboard view in `packages/engine/src/store-read.ts`, its `/api/projects` route in `packages/commands/src/dashboard/store-read.ts`, and the roadmap entry that consumes it.

## Problem

Opening the roadmap destination without a project selected rendered an empty state that told the reviewer to hand-edit the URL. No dashboard API listed projects, and the engine view union had no `projects` member, so the entry could not offer a chooser from honest data. Scraping an existing endpoint such as the issues list would couple the chooser to issue data and silently miss projects that have no issues.

## Decision

- `DashboardView` includes `projects`; `DashboardViewData.projects` is `ProjectListDTO = { items: ProjectListItem[]; total: number }`, where each item carries the catalog identity and an `openIssues` count.
- The read is one SQL query over `catalog_entities` with `kind = 'project'`, left-joined to open issues and grouped by the catalog primary key. Order is `title asc, id asc`. A project with no issues reports `openIssues: 0`.
- The answer is **unpaged and complete**: every project row is returned in one response, `total === items.length`, with no paging call and no `limit`/`offset` consumption. `needsProjection` is false because catalog rows are base store data, not a published projection.
- `/api/projects` is a param-free list route. Every query parameter, whether known elsewhere (`limit`, `offset`, `project`) or unknown, is a usage refusal with the transport's standard parameter shape. There is no detail route.
- The no-project branch loads the list and renders a chooser whose rows link to `/?project=<id>#roadmap`. Loading, empty catalog, refusal and load failure are distinct honest states; a refused read is never flattened into `{ items: [], total: 0 }` or rendered as the empty-catalog sentence.
- No generic catalog-kind query view, paging parameters, pager or truncation hint is added, and no project selector is added to the issues, workflow or iteration views.

## Alternatives considered

- **Scrape the issues endpoint.** Rejected: it couples the chooser to issue data and hides projects with no issues.
- **A generic catalog-kind list view.** Rejected as speculative generality: only the project kind has a consumer today.
- **Page the project list like issues/workflows/iterations.** Rejected: those grow without bound with use; the registered-project set is deliberately bounded, and a chooser that hides rows behind a page boundary defeats its only job.
- **Keep the hand-edit-URL empty state.** Rejected: it asks the reviewer to operate the transport instead of the product.
- **Collapse a refused read into an empty list.** Rejected: it turns a broken authority into a false "no projects" fact.

## Consequences

- The complete list is the contract. If a catalog ever outgrows one complete read, adding paging is a deliberate contract change made in a direction lock — never a silent truncation.
- The engine read is pinned by a test that seeds more projects than the shared default page and asserts every one returns.
- The route's param-free shape follows from the engine read; accepting a page parameter would create two sources of truth for completeness.
- Engine and transport refusals keep their shape through the server and web view, so the three states (zero projects, zero issues on one project, refused read) stay distinguishable.
