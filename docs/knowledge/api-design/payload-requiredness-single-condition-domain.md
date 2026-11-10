---
title: Payload requiredness must share one condition domain across registry, decode, and static descriptors
module: commands payload schemas / engine issue registry / cli help rendering
date: 2026-10-09
last_updated: 2026-11-10
problem_type: api_design
category: api-design
severity: high
plan_id: <plan-id>
status: active
tags:
  - payload-schemas
  - conditional-requiredness
  - disposition
  - descriptor-vs-runtime
  - single-vocabulary
---

# Payload requiredness must share one condition domain across registry, decode, and static descriptors

Source: plan <plan-id> (#420); QC finding F-001; QA AC2.

## Context

A command payload whose fields are conditionally required (e.g. `ClosureEvidence`, whose condition domain is the five terminal dispositions `resolved|waived|duplicate|superseded|obsolete`: `references` required for `resolved` and `obsolete`, `scope` only for `waived`, `canonicalIssueId` only for `duplicate`/`superseded` and refused for `obsolete`) is validated in **three layers**: the engine's runtime authority (`assertClosureAuthority`, conditions on the **disposition**), the commands package's decode-time zod schema (`payloadSchema`, built per verb), and the static transport descriptors (help text, `mstar schema` output, MCP composed admission). The CLI verb and the engine disposition are linked by a fixed map (`close→resolved`, `waive→waived`, `duplicate→duplicate`, `supersede→superseded`, with `obsolete` reachable only through `close --disposition obsolete`), which makes the two vocabularies *look* interchangeable.

## Guidance

1. **Pick one condition domain and use it everywhere.** For disposition-gated payloads the domain is the terminal disposition vocabulary (`resolved|waived|duplicate|superseded|obsolete`), never the CLI verb — `issue close` accepts `--disposition` over all five, so a verb-named condition (`requiredWhen: ["close"]`) is wrong for every disposition but the verb's own default. Registry (`ISSUE_PAYLOAD_SCHEMAS.requiredWhen`), decode selection (`input.disposition ?? terminalDisposition[verb]`), and help rendering must all speak it.
2. **Static descriptors must not condition on runtime-only inputs.** A static schema is composed before execution and cannot know `--disposition`; conditioning its requiredness on the verb over-constrains non-default overrides (MCP rejected valid `issue.duplicate` payloads without `canonicalIssueId`). Keep static conditional fields optional and let the execution-time authority enforce them.
3. **Help is a projection, not a second source.** Render help from the registry (field, type, `required` / `requiredWhen` list). If help needs a word the registry does not use, fix the registry — never introduce a parallel vocabulary in the renderer.
4. **A test pinning the wrong vocabulary is a defect, not a guard.** The original tests asserted `requiredWhen: ["close"]`; replacing those pins *was* the fix. When a condition domain is corrected, search tests for pins of the old domain before treating the suite as green.
5. **A stricter transport type hides the domain's own refusal.** Declaring a field as an optional string (`z.string().optional()`) makes `null` fail at decode with `issue.invalid-payload` before the engine can emit the actionable `issue.invalid-disposition` recovery that names the removal-evidence requirement. Both paths refuse with zero mutation, so the bug is diagnostic fidelity, not safety: when the domain contract rejects a *value shape* (a supplied `canonicalIssueId` on a disposition that must not carry one), the transport should let that shape reach the domain check — declare the field `nullable` in the registry (`.nullable()` comes from the `nullable` flag, the null spelling from `type: "string | null"`) — or mirror the domain refusal text.
6. **Adding a disposition is a vocabulary migration, not a branch.** A new terminal state must be added once to the authoritative tuple and derived everywhere — type union, validation map, SQL CHECK (append-only migration), dashboard filter, aggregates, history SQL, outbound provider mapping, and the browser-side projection generated at build time. A second handwritten list is the defect this pattern exists to prevent; adding the state only to the server and to a hand-maintained client list produces the same three-layer drift described above.

## Why This Matters

Three layers drifted silently: help told `close` users `references` was always required, the decode layer enforced that mistake against `--disposition duplicate`, and MCP composed admission rejected payloads the engine would have accepted. Each layer passed its own tests; only the engine disagreed. The mismatch surfaced only because help text was being rewired — any one layer changing alone would have deepened it.

## When To Apply

Any payload with conditional requiredness; any static descriptor (help, schema export, MCP composed admission) describing runtime-validated input; any registry that feeds both documentation and validation.

## Examples

- #420 fix series: `requiredWhen` reworded to dispositions; `payloadSchema` selects by effective disposition; static descriptor keeps conditional fields optional (`4290f6b7`); composed-admission regressions for resolved and waived overrides; `disposition: open` refusal asserted at execution.
