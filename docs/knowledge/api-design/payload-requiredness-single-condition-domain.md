---
title: Payload requiredness must share one condition domain across registry, decode, and static descriptors
module: commands payload schemas / engine issue registry / cli help rendering
date: 2026-10-09
problem_type: api_design
category: api-design
severity: high
plan_id: 20261009-issue420-payload-help-fields
status: active
tags:
  - payload-schemas
  - conditional-requiredness
  - disposition
  - descriptor-vs-runtime
  - single-vocabulary
---

# Payload requiredness must share one condition domain across registry, decode, and static descriptors

Source: plan 20261009-issue420-payload-help-fields (#420); QC finding F-001; QA AC2.

## Context

A command payload whose fields are conditionally required (e.g. `ClosureEvidence`: `references` required only for `resolved`, `scope` only for `waived`, `canonicalIssueId` only for `duplicate`/`superseded`) is validated in **three layers**: the engine's runtime authority (`assertClosureAuthority`, conditions on the **disposition**), the commands package's decode-time zod schema (`payloadSchema`, built per verb), and the static transport descriptors (help text, `mstar schema` output, MCP composed admission). The CLI verb and the engine disposition are linked by a fixed map (`close→resolved`, `waive→waived`), which makes the two vocabularies *look* interchangeable.

## Guidance

1. **Pick one condition domain and use it everywhere.** For disposition-gated payloads the domain is the disposition (`resolved|waived|duplicate|superseded`), never the CLI verb — `issue close` accepts `--disposition`, so a verb-named condition (`requiredWhen: ["close"]`) is wrong for three of the four close dispositions. Registry (`ISSUE_PAYLOAD_SCHEMAS.requiredWhen`), decode selection (`input.disposition ?? terminalDisposition[verb]`), and help rendering must all speak it.
2. **Static descriptors must not condition on runtime-only inputs.** A static schema is composed before execution and cannot know `--disposition`; conditioning its requiredness on the verb over-constrains non-default overrides (MCP rejected valid `issue.duplicate` payloads without `canonicalIssueId`). Keep static conditional fields optional and let the execution-time authority enforce them.
3. **Help is a projection, not a second source.** Render help from the registry (field, type, `required` / `requiredWhen` list). If help needs a word the registry does not use, fix the registry — never introduce a parallel vocabulary in the renderer.
4. **A test pinning the wrong vocabulary is a defect, not a guard.** The original tests asserted `requiredWhen: ["close"]`; replacing those pins *was* the fix. When a condition domain is corrected, search tests for pins of the old domain before treating the suite as green.

## Why This Matters

Three layers drifted silently: help told `close` users `references` was always required, the decode layer enforced that mistake against `--disposition duplicate`, and MCP composed admission rejected payloads the engine would have accepted. Each layer passed its own tests; only the engine disagreed. The mismatch surfaced only because help text was being rewired — any one layer changing alone would have deepened it.

## When To Apply

Any payload with conditional requiredness; any static descriptor (help, schema export, MCP composed admission) describing runtime-validated input; any registry that feeds both documentation and validation.

## Examples

- #420 fix series: `requiredWhen` reworded to dispositions; `payloadSchema` selects by effective disposition; static descriptor keeps conditional fields optional (`4290f6b7`); composed-admission regressions for resolved and waived overrides; `disposition: open` refusal asserted at execution.
