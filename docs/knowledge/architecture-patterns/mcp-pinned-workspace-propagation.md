---
module: MCP pinned harness root and invocation workspace propagation (mstar mcp --harness, persist/scaffold/audit root selection)
date: 2026-10-19
problem_type: architecture_pattern
category: architecture-patterns
severity: high
plan_id: <plan-id>
applies_when:
  - "adding a connection-level pin (--harness, --identity-env) to a host adapter"
  - "a command family resolves its own root from cwd, an input field, or a discovery helper"
  - "fixing a review finding where a pinned server mutates the launch checkout"
---

# MCP pinned workspace: propagate the pin, do not re-derive it

Hard-won rules from the dsh identity batch (PRs #531/#536): a server launched with an explicit harness pin (`mstar mcp --harness <absolute path>`) must treat that pin as a connection-level invariant. Five review rounds found five different ways the pin leaked back to the launch checkout; each fix narrowed the general lesson.

## One injection point is never enough

The first implementation injected the pin only into tools whose published input schema declared a `harness` field. That misses two whole classes: commands with **implicit root-derived paths** (`audit.scaffold` → `resolveReviewDir(context.cwd)`) and command handlers that default an executed path from `process.cwd()` (`harness.scaffold` before the fix). Anchor the pin at the invocation context (`cwd` = the pinned workspace, `controlRoot` = the harness dir) so every existing derivation follows it; only then add field-level defaults on top.

## A client-selectable root is a new capability, not a convenience

Adding a per-call `harness` input to a family that previously took its root from the environment moved a **security boundary**: protected-document classification compares a `json` target against the selected root, so a client-chosen root makes `status.json` / `snapshot.json` of another harness match nothing and skips the direct-write refusal. Prefer the server-owned root (`context.controlRoot`) for families that do not already publish `harness`; when a per-call override must exist, keep the protected-target classification independent of the chosen root.

## Distinguish "explicit override" from "blank"

A blank or whitespace value must be treated exactly like an absent one. Two separate defects came from the opposite assumption: `harness: ""` bypassed the pinned default at injection time, and a `min(1)` schema rejected the blank before the default could be substituted. Normalize blanks to the default **before** admission when a tool declares the field, and keep explicit non-blank values untouched.

## Scaffold targets must be passed verbatim, not re-resolved

Root-discovery helpers (`resolveScaffoldDirs`) legitimately consult `MSTAR_HARNESS_DIR`, `.mstarc`, then `<root>/.mstar`. That is correct for a CLI invocation and wrong for a pinned server: a custom root name (`/repo/control`) got scaffolded into `/repo/.mstar`, and an inherited `MSTAR_HARNESS_DIR` could redirect the write further — while the call reported success. Give the discovery helper an explicit `harnessDir` option (used verbatim, skipping every rung) and have the pinned handler pass the pin. Test with a **non-default root basename** and with a **conflicting environment variable**; the canonical `<workspace>/.mstar` case alone hides both defects.

## Test the production assembly, and mutate to prove the regression

The defects survived earlier waves because tests called `registerMcpCommands`/helpers directly. Drive `createMcpServer(createContextResolver({ harnessRoot }))` (the real wrapper chain), use two roots that each own a `.mstar`, and assert product results plus untouched bytes in the non-target root. For each regression, temporarily restore the old behavior (mutation) and confirm exactly the new cases fail; a regression that has never been red proves nothing.

## Release archives are immutable history

Editing a changelog fragment that a release already consumed is a trap: `release:prepare` moves fragments into `.changes/archive/<version>/`, and a later edit on an unmerged branch is carried into the archive by the merge (rename detection), so the release record starts describing work that shipped later. When a fix lands after a release, add a **new** unreleased fragment; revert any archive-side edit to the released commit.
