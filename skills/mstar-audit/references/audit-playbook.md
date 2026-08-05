# Audit Playbook

What to look for, per category. Each subagent (or direct audit pass) gets the relevant section plus the **Finding format** at the bottom. Adapt depth to repo size — a 2K-line CLI gets a lighter pass than a 500K-line monorepo.

A finding is only a finding with evidence. "Probably has N+1 queries somewhere" is not a finding; `orders/api.ts:142 issues one query per order item inside a loop` is.

---

## 1. Correctness / Bugs

The highest-trust category — real bugs found by reading, not speculation.

- Error handling: swallowed exceptions, empty catch blocks, `catch (e) { console.log(e) }` on critical paths, missing error states in UI code.
- Async hazards: unawaited promises, race conditions on shared state, missing cancellation/cleanup (stale closures in React effects, listeners never removed).
- Null/undefined flows: non-null assertions (`!`) on values that can be null, optional chaining hiding a value that must exist, unchecked array indexing.
- Boundary conditions: off-by-one, empty-collection handling, timezone/locale assumptions, integer overflow in counters/IDs.
- State machines: impossible-state combinations representable in types, status enums with unhandled branches (look for `default:` that silently no-ops).
- Concurrency: check-then-act on shared resources, missing transactions around multi-write operations, idempotency of retried operations (webhooks, queues).
- Type escape hatches: `any` / `as` casts / `@ts-ignore` clusters — each one is a place the compiler was overruled.
- Resource leaks: unclosed handles, connections, subscriptions; missing `finally`.

## 2. Security

Review only what is directly supported by code evidence. Keep findings framed as defensive maintenance: identify the code pattern, explain the production impact, describe the remediation. Keep plans at the level of code changes, configuration changes, and tests.

**Handling rule:** never copy a secret value into a finding or plan — those files get committed. Reference the `file:line` and credential type only ("Stripe live key at `config.ts:12`"), and the fix sketch always includes rotation, not just removal.

**By-design is not a finding:** standard platform conventions are intentional behavior — honoring `https_proxy`/`NO_PROXY`, reading `~/.netrc`, an explicitly local dev tool shelling out to configured package managers. A tradeoff explicitly recorded in an ADR or decision doc is likewise settled. Flag these only when the *implementation* adds risk beyond the convention. Note: a **stale ADR is itself a finding** — if code has drifted from what the decision doc says, report the drift.

- Credential hygiene: hardcoded keys/tokens/passwords, credentials in committed `.env` files, credentials logged or persisted in event/history stores.
- Data crossing into interpreters or privileged APIs: SQL or shell operations assembled from request data (injection), HTML sinks fed by user-controlled content (XSS), dynamic execution APIs used with runtime input, filesystem paths derived from request data (path traversal).
- Access control: endpoints/server actions that lack server-side identity checks, authorization enforced only in the client, object access by ID without ownership or tenant checks (IDOR), missing request authenticity checks (CSRF) on state-changing routes.
- Input contracts: API boundaries that trust request bodies without schema validation, file upload handling without clear type/size/storage constraints, broad object assignment from request data into persistence models (mass assignment).
- Dependency posture: run the ecosystem's audit command (`npm audit`, `pip-audit`, `cargo audit`) in read-only mode. Report only critical/high advisories that affect reachable runtime code.
- Production configuration: overly broad CORS where credentials are allowed, missing response-hardening headers (e.g. CSP), cookies missing appropriate `HttpOnly`/`Secure`/`SameSite` attributes, debug/verbose behavior enabled in production.
- Data minimization: PII or sensitive operational data in logs, stack traces returned to clients, internal error details exposed through API responses.

## 3. Performance

Look for algorithmic and architectural wins, not micro-optimizations.

- N+1 patterns: query/fetch per item inside loops or per list-row rendering; missing batching or dataloader.
- Wrong complexity: nested scans over the same collection, repeated `find`/`filter` inside hot loops where a Map keyed lookup belongs.
- Caching gaps: identical expensive computations or fetches repeated per request/render; missing memoization at clear function boundaries.
- Payload size: over-fetching (select *, full objects where IDs suffice), missing pagination on unbounded lists, large JSON shipped to clients.
- Frontend (if applicable): bundle composition, missing code-splitting on rarely-hit routes, unoptimized images/fonts, render waterfalls.
- Backend: synchronous work that belongs in a queue, missing indexes implied by query patterns (flag for verification — don't claim without schema evidence), connection-per-request patterns where pooling exists.
- Build/CI: slow CI from missing caching, redundant pipeline steps, test suites that could parallelize.

## 4. Test Coverage

The goal is not a percentage — it's *which untested code is dangerous*.

- Map the critical paths (money, auth, data mutation, the feature the repo exists for) and check which have zero or trivial coverage.
- Modules with high churn (git log) + no tests = top refactor risk; flag as "characterization-tests-first" candidates.
- Existing test quality: tests that assert nothing meaningful, heavy mocking that tests the mocks, snapshot tests nobody reads, flaky patterns (real timers, real network, order dependence).
- Missing test layers: unit-only suites with zero integration coverage on API boundaries, or the inverse.
- Verification infrastructure: is there a one-command way to know the codebase works? If not, that's finding #1 and a prerequisite plan for any risky change.

## 5. Tech Debt & Architecture

- Duplication: the same logic re-implemented in 3+ places; divergent copies that have drifted.
- Layering violations: UI importing from data layer internals, circular dependencies, "utils" modules that became a junk drawer with high fan-in.
- Dead code: unexported-and-unused modules, feature flags fully rolled out but still branching, commented-out blocks, deps in the manifest no longer imported.
- God objects/modules: files an order of magnitude larger than the repo median that everything touches; functions with double-digit parameters or deep conditional nesting.
- Inconsistent patterns: three ways of doing data fetching / error handling / styling — pick the winner (the one the team converged on most recently) and plan the consolidation.
- Abstraction mismatches: premature abstractions with a single implementation, or missing abstractions where the same change always requires touching N files in lockstep.

## 6. Dependencies & Migrations

- Major-version lag on core framework/runtime (the ones with real cost to staying behind: EOL, security-fix cutoffs, ecosystem incompatibility).
- Deprecated APIs in use that have announced removal timelines.
- Abandoned dependencies (no release in years, archived repos) on critical paths.
- Duplicate dependencies solving the same problem (two date libs, two HTTP clients).
- Lockfile/manifest drift, version pinning inconsistencies across a monorepo.
- For each migration candidate, estimate blast radius (files touched) — that drives effort and whether to recommend it at all.

## 7. DX & Tooling

- Missing or broken: typecheck script, lint config, formatter, pre-commit hooks, editorconfig.
- Slow feedback loops: dev-server or test startup measured in minutes, no watch mode, CI without caching.
- Onboarding friction: README setup steps that are wrong/incomplete, undocumented required env vars, no `.env.example`.
- Missing `AGENTS.md` / `CLAUDE.md` — for repos where agents will execute the plans, this is high-leverage.
- Error messages/logging: unstructured logs on services, missing request IDs/correlation, debugging requiring code changes.

## 8. Docs

Lowest default priority — only flag where absence has a concrete cost:

- Public API surface (published packages) without reference docs.
- Architectural decisions nobody can reconstruct (why X over Y) for actively contested areas.
- Stale docs that are actively wrong (worse than missing) — setup instructions, API examples that no longer compile.

## 9. Direction — features & where to take this next

Forward-looking: not what's broken, but what this codebase wants to become. **Grounding rule:** every suggestion must cite evidence from the repo itself — a suggestion that could apply to any project ("add dark mode", "add AI") is noise. Sources of grounded direction signal:

- **Unfinished intent**: TODO/FIXME clusters around one theme, feature flags never rolled out, stubbed or half-built modules, abandoned mid-feature work visible in git history.
- **Stated-but-undelivered**: README/docs/roadmap promises with no corresponding code, CLI flags or config options that are no-ops. A `STRATEGY.md` or `PRODUCT.md` that names users, use cases, or a direction the code hasn't caught up to is the strongest grounding signal — never propose something a decision doc already rejected (note the contradiction instead).
- **Surface asymmetries**: one-directional pairs (export without import, create without bulk-create), entities with CRUD minus one, a public API that internal code clearly needed and hand-rolled around.
- **The adjacent possible**: capabilities the existing architecture makes disproportionately cheap — a plugin system one interface away, a public API one route file from the existing service layer.
- **Friction worth productizing**: things users evidently do by hand around it (visible in docs, examples, issues).

Direction findings use the standard format with two adaptations: **Impact** is product/user value, and **Confidence** reflects how grounded the evidence is. Plans for selected direction findings are usually a *design/spike plan* (investigate, prototype, define the API, list open questions) rather than a build-everything plan.

---

## Finding format

Every finding, from every category and every subagent, comes back in this shape:

```markdown
### [CATEGORY-NN] Short imperative title

- **Evidence**: `path/file.ts:123` — one-sentence description. (2–5 strongest locations; note "and ~N similar sites" if widespread.)
- **Impact**: What goes wrong / what's being paid. Concrete: "every order-list render issues 1+N queries", not "suboptimal".
- **Effort**: XS | S | M | L | XL — for the *fix*, including tests. (Morning Star effort scale — see `mstar-plan-conventions`.)
- **Risk**: What the fix could break; LOW/MED/HIGH plus one line why.
- **Confidence**: HIGH (read the code, certain) / MED (strong signal, needs verification) / LOW (smell, needs investigation). LOW-confidence findings may be reported but get an "investigate" plan, not a "fix" plan.
- **Fix sketch**: 1–3 sentences. Not the plan — just enough to judge effort honestly.
```

## Prioritization rubric

Order findings by **leverage = impact ÷ effort, discounted by confidence and fix-risk**. Tiebreakers:

1. Anything that unblocks other findings (verification baseline, characterization tests) floats up.
2. Security findings with HIGH confidence float above equivalent-leverage non-security findings.
3. Prefer findings whose fix has a clean verification story.
4. "Not worth doing" is a valid verdict; record it with one line of reasoning.
