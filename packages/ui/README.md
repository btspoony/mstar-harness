# `@mstar-harness/ui`

The unified product's presentation layer: one design system, one set of screens, one bilingual
dictionary, mounted by two hosts.

The standalone dashboard (`mstar dashboard`) and the DeepSeek Harness panel render the **same
components** — the destinations, the screens, the status treatments and the copy are shared, not
reimplemented per host. The plan's Technical decisions §1 explains why this ships as TypeScript
source with declarations only rather than a JS bundle.

## What this package refuses to know

Every refusal below is a host obligation, not an omission. A component that started guessing at one
of them would be wrong in one of the two hosts.

| It never… | Because | Who owns it |
| --- | --- | --- |
| imports a host SDK (`@deepseek-ai/*`) | one shared layer cannot depend on one host | each adapter |
| reads `window`, `location`, or `localStorage` | routing and persistence are host concerns | each adapter |
| fetches anything | the screens take resolved data; there is no CDN, no remote font, no network call | each adapter |
| decides the viewport height | the pane declares `inline-size` only, so height is host knowledge (see `compact`) | each adapter |
| derives an absence state | `state.ts`'s resolvers own that decision, so one fact has one answer | this package |
| picks a locale or a colour scheme | both are host settings, passed in as values | each adapter |
| value-imports `@mstar-harness/engine` | the engine pulls SQLite; only `import type` is allowed | enforced by `purity.test.ts` |

## Build order

The package type-imports the engine, so `tsc` reads the engine's **declarations**, not its source.
On a clean checkout those do not exist yet:

```sh
bun run --cwd packages/engine build   # 1. engine declarations (packages/engine/dist)
bun run --cwd packages/ui build       # 2. this package's declarations (packages/ui/dist)
bun run --cwd packages/dsh build      # 3. a consumer's tsc reads dist/index.d.ts
```

`bun run typecheck` at the repository root performs steps 1 and 2 in `typecheck:prepare` before any
consumer's `tsc` runs. Skipping step 1 fails with `Cannot find module '@mstar-harness/engine'`; the
error names the engine, not this package, which is why the order is written down here.

The declaration build **excludes test sources** (`tsconfig.json`'s `exclude`), so `dist` carries no
`*.test.d.ts`. A consumer's `tsc` therefore never typechecks this package's fixtures.

## Consuming it

### Import paths

```ts
import {
  // the scheme contract
  MS_THEME_ATTRIBUTE, MS_CONTAINER_NAME, MS_CONTAINER_CLASS, MS_TONES,
  // the dictionary and its provider
  LocaleProvider, useCopy, copyFor, en, zh,
  // the ten screens
  Overview, Focus, Issues, IssueDetail, Workflows, WorkflowDetail,
  Iterations, IterationDetail, Projects, ProjectDetail,
  // the transforms, the resolvers and the address-bar pair
  overviewModel, focusModel, issueListModel, workflowListModel,
  iterationListModel, projectListModel,
  resolveMember, resolveRecord, resolveSubjectMember,
  parseIssueQuery, issueQuery,
} from "@mstar-harness/ui";
```

Importing the entry point also pulls the two global stylesheets (`styles/tokens.css`,
`styles/base.css`) as side effects. A host that wants only the tokens may import
`@mstar-harness/ui/styles/tokens.css` directly.

### The two global sheets, and the `*.module.css` convention

`tokens.css` declares every `--ms-*` custom property once, under `:root` (light) and
`[data-ms-theme="dark"]` (dark) — **one name set, two value sets**. `base.css` is the element layer:
reset, typography, the focus ring, the `@media (forced-colors: active)` treatment, and the named
size container.

Every component carries a sibling `*.module.css` and **nothing else in the package declares a class
rule** — the single exception is `.ms-container` in `base.css`, which is the layout hook the
container queries need, not a component style. `DESIGN.md` at the repository root is the token
authority; a token that exists in one place and not the other is a defect, and `tokens.test.ts`
fails on it.

### The `data-ms-theme` contract

Set `data-ms-theme="light"` or `"dark"` on the product wrapper. There is deliberately **no
`"system"` arm**: `prefers-color-scheme` is a host concern, and a host offering "follow the OS"
resolves it itself. The package never selects a scheme from a media query — `tokens.test.ts` fails
if any stylesheet does.

Put `ms-container` (or the exported `MS_CONTAINER_CLASS`) on the same wrapper or an ancestor: every
reflow rule is `@container pane (…)`, so the layout responds to the **pane's** width. A viewport
media query in this package would be a defect: the dashboard and the dsh sidebar share these screens
at very different widths.

## The adapter contract

Every obligation this iteration recorded. A host adapter that skips one produces a page that looks
right and is wrong.

1. **Height-based shortening is yours to trigger.** `Overview` takes `compact?: boolean`. IA §3.1's
   "when the window is short, fold milestones to one summary line first" needs `container-type:
   size`, which the pane does not declare; the shared layer must never read the viewport. Decide the
   threshold against your own chrome, and pass `compact` when it is crossed. (The second shortening
   step — paging the plan table — has no surface yet: `Overview` shows plan **counts**.)

2. **The project list for issue filters is data you supply.** `Issues` takes
   `options: { disposition, project, kind, severity }`. The enum vocabularies live in `status.ts`;
   the **project list** is whatever your store read returned. Do not hard-code it.

3. **Keep `parseIssueQuery` / `issueQuery` for the address bar.** The dashboard's filters are
   addressable: the URL is the state, and the round-trip must survive a reload and a deep link. The
   screens report a whole query change (`onQueryChange`) and never see a URL — the adapter converts
   between the two, and it must use these two functions so an unknown enum value still falls back to
   the default instead of being forwarded to a read that would refuse it.

4. **A project-scoped surface never falls back to the store-wide list.** `ProjectDetail`'s Issues and
   Iterations features receive their content as `ReactNode` props, so nothing in the type system
   stops a host from passing an unfiltered list under a project chip. That is the caller's
   obligation: inside a project page, a list is that project's records or an absence arm — never the
   store-wide list, which would be a wrong answer presented as a right one (IA §4).

5. **The project scope chip's clear affordance means "navigate away from the project".** The chip is
   labelled and carries `data-ms-scope-clear="<projectId>"`; `ProjectDetail` has no handler for it,
   because the honest meaning is leaving the project page rather than un-scoping it in place. Wire it
   to that navigation.

6. **`ProjectDetail` takes its two scoped lists as `ReactNode`.** Compose them yourself (they are
   `Issues` and `Iterations`, scoped), and keep obligation 4.

7. **`ProjectDetail` fixes its feature tabs.** Roadmap, Issues, Iterations, in that order, with
   Roadmap permanently the default — the constants are `PROJECT_FEATURES` and
   `DEFAULT_PROJECT_FEATURE`. Do not auto-select the first non-empty feature: the page must have the
   same shape for every project, and an absent roadmap must stay visible as an absence.

8. **The locale is yours to choose and persist.** Wrap the tree in `<LocaleProvider locale={…}>`. The
   dictionary is imported, not fetched, so there is no loading state; an unrecognised locale string
   falls back to `en`. `useCopy()` returns the whole tree — hand each screen its own section
   (`copy.overview`, `copy.focus`, …) through that screen's `*Copy` prop.

9. **Derive the models once per read, not once per render.** Every `*Model` function walks the
   whole DTO (`issueListModel` maps every row, `overviewModel` maps every workflow). Call them when a
   read lands, and memoise against that read — a host that re-derives inside a render pays O(rows) on
   every keystroke, and a search box that re-reads per character pays it twice. Debounce the search
   before it reaches a read; derive after the read, never during typing.

10. **A single-record read's `null` means absent.** If your transport can fail a read, it must answer
   the `unavailable` arm with the store's reason rather than a `null` payload — the resolvers treat
   `null` as "the subject declares nothing here", and collapsing the two would make one fact have two
   answers again.

## The directory layout

```
src/
  index.ts            the public surface (this file's export list)
  styles/             tokens.css, base.css, and their guard
  view-model/         pure transforms: state (the absence resolver), status, format,
                      overview, focus, issues, workflows, iterations, projects, session
  components/         the sixteen primitives, each with its *.module.css
  screens/            the ten screens, each with its *.module.css
  locale/             en, zh, the provider, and the parity guard
```

## Verifying it

```sh
cd packages/ui && bun test                                  # the whole suite
cd packages/ui && bun run build                             # declarations only
cd packages/ui && bunx tsc --noEmit                         # typecheck, tests included
```

`src/purity.test.ts` is the one to read first: it bundles the public surface for a browser target and
fails if a Node builtin, a host SDK, `@mstar-harness/commands` or a *value* import from the engine
ever reaches the graph.
