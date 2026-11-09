---
module: dsh-private
date: 2026-08-08
last_updated: 2026-11-09
problem_type: convention
category: conventions
severity: medium
plan_id: "20260808-dsh-package-core, 20260808-dsh-host-adapter, 20260808-dsh-seams-bundle"
tags:
  - dsh
  - cordis
  - plugin
  - peer-dependencies
  - bundle
---

# dsh plugin authoring conventions (external consumer view)

## Context

Conventions verified against dsh-private (read-only) while building `@mstar-harness/dsh` — what a plugin package MUST look like to fit the dsh ecosystem.

## Guidance

**Plugin shape**: function plugin with named exports `name` / `inject` / `Config` (schemastery `z.object`) / `apply(ctx, config)` — NO default export (service packages default-export a `Service` subclass). Registrations via `ctx.effect()` (exact disposer) / `ctx.on()` / `ctx.waterfall()`; `inject` names required services for declarative load order. `@deepseek-ai/cordis` is ALWAYS peer + dev (currently `~4.1.0`).

**Dependency model**: dsh seams only in `peerDependencies` (currently the `^0.2.2-rc.1` train — one shared caret range across the whole set, re-pin every peer together on a train move); devDependencies carry workspace/file copies for tests; never dsh packages in `dependencies`.

**Key seam contracts** (verified at dsh-private source):
- `fs/write-intent` + `fs/edit-intent`: single-decision-slot `@mode` waterfalls; payload = (target, actor, next) — content-blind; veto = **throw**, allow = `next()`; `fs/observed` is emit-only.
- `tools/pre-execute`: `PreToolDecision {kind:'allow'|'deny'; reason} | {kind:'ask'}`; deny without `next()`.
- `agent/pre-step`: waterfall returning `PreStepDecision`; advisory listeners MUST call `next()`.
- `subagent/start`: `@mode` emit (observation only) — not a gate.
- `MessageSourceMap`: merge-extensible via `declare module '@deepseek-ai/dsh-llm'`; catalog-form sources are durable (model-visible ⟺ logged).
- `defineTool`: `DefineToolOptions<S,O>` with `ParameterSchemaSpec`/`ValueSchemaSpec`; `presentCall` card generic; `isConcurrencySafe` explicit.
- skill-local Config: `customSkillDirs?: string[]`; `bundledSkillDir` default `$DSH_BUNDLED_SKILL_DIR`; REQUIRED frontmatter name (kebab) + description.

**Docs contract**: every package ships `README.md` + `README.zh.md` + `README.i18n.yaml` (blob hashes; re-record on ANY EN edit — `git hash-object`), Model Experience + Known Limitations sections, EN/ZH heading parity. One commit must sync both languages + hashes together.

**Bundle distribution**: profile bundle = nested manifest `dsh.bundle.patch` + `cordis.patch.yml` (insert op; whole-row config replacement, no deep merge); layer over dsh-base; install `dsh plugin --profile <name> add <package>` (local path works pre-publish; registry after publish; reconcile joins `dsh.profile.bundles` — **direct deps only**; plugin→plugin dependency/activation/probing → `architecture-patterns/dsh-plugin-dependency-activation.md`). Relative paths in shipped config are cwd-anchored — use absolute overrides for production.

**Bundled asset mirrors**: `bundle-harness-assets.ts` syncs repo-root `skills/` → `harness-skills/`, `commands/` → `harness-commands/`, and `agents/` → `harness-agents/` (gitignored build output; wired into `build`/`prepublishOnly` — there is NO postinstall). The package `files` whitelist must list every shipped mirror (harness-skills, harness-commands, harness-agents) or the published tarball silently drops it. Downstream consumers read mirror content package-relative (`import.meta.url`), never cwd-anchored. Assignment-derived ids (e.g. `Execute as` role ids) are UNTRUSTED input at any filesystem join over mirror paths — validate format (`^[a-z0-9-]{1,32}$`-style) + containment before `join()` (iter-20260815 F-001).

## Why This Matters

Convention violations (default export, deps-in-dependencies, EN-only doc edits, deep-merge patches) silently break load order, runtime resolution, or the pairing contract. The peer model is what keeps a plugin installable into any dsh app without private-registry access.

## When to Apply

Any new dsh plugin/consumer package; any upstream PR touching dsh-side distribution.
