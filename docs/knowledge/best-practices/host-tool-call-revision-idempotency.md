---
title: Make host tool-call input revisions idempotent; carry identity in the command prefix
module: omp host adapter / model-handoff extension
date: 2026-09-26
last_updated: 2026-11-10
problem_type: best_practice
category: best-practices
severity: high
source: plan <plan-id> (fix for the unbounded `export MSTAR_HOST_SESSION_ID` prefix stacking)
status: active
tags:
  - host-adapter
  - tool-call-revision
  - idempotency
  - session-identity
  - omp-compat
  - fail-closed
  - shell-prefix-recognition
related:
  - architecture-patterns/host-engine-identity-association.md
---

# Make host tool-call input revisions idempotent; carry identity in the command prefix

## Context

The omp `model-handoff` extension revises every shell tool call of its session so
a child `mstar plan bind` (plan/assignment form) inherits the host session id
via `MSTAR_HOST_SESSION_ID` (see
[host-engine-identity-association](../architecture-patterns/host-engine-identity-association.md)
for why the channel exists), and a leaf (task/subagent) session also exports
`MSTAR_LEAF_SEAT=1` so the CLI attests `leafSeat` and the engine's
`coordination.leaf-seat` refusal fires on coordinator registration verbs. Two
properties of the host shape the mechanism:

- **Its input schema is validated.** omp 18.3.0 refuses any bash call whose
  input carries `env` without a service `name`
  (`ready and env require a service name.`).
- **It may re-fire the revision.** Retry and replay paths deliver the same tool
  call to the `tool_call` hook again, carrying the already-revised input, so a
  non-re-entrant prefix accumulates on the persisted command.

## Guidance

1. **Carry the value on a surface the host does not re-validate.** A validated
   field is closed to ad-hoc revision; transport the value in the command string
   itself, ahead of the caller's text, so the child process environment receives
   it without tripping host checks.
2. **Recognise only the region the producer writes.** A re-entrancy guard scans
   the contiguous chain of leading exports and stops at the first statement that
   is not one of them; a re-fire of an already-revised command then returns the
   input unchanged. The producer is `LEADING_EXPORT_RE` plus `alreadyInjected` in
   `packages/omp/src/extensions/model-handoff.ts`: one statement at a time, a
   name outside the chain ends the scan, and a fixed-value marker additionally
   requires the expected value. Accepted tradeoff: a caller-written export of the
   session id is respected instead of overwritten — convenience channels must
   not be trust boundaries.
3. **Never recognise a marker by bare substring.** `command.includes(marker)`
   also matches command text that merely *mentions* the marker (`echo
   'export MSTAR_LEAF_SEAT='`, a `grep MSTAR_LEAF_SEAT=` argument), and the leaf
   marker is fail-closed: dropping it lets a subagent register as the
   coordinator. Idempotency must be bought positionally, never by mention.
4. **Scan value text across shell quoting boundaries.** The value alternation
   stops at an unquoted `"`, backtick, `$` or `(` — characters this hook never
   emits outside its single-quote helper. Inside such a word a `; ` is literal,
   so a scan that ignored the boundary reads a second, caller-authored statement
   out of a quoted or substituted value and mistakes it for its own prefix.
5. **Gate revisions on the same tool-name set as every other shell classifier.**
   The extension classifies coordinator shell calls against
   `SHELL_TOOL_NAMES = ["bash", "functions.bash"]`; an injection gate that
   checks only `=== "bash"` silently skips namespaced shells
   (`functions.bash`) and diverges from the classifier's notion of a shell call.
   Derive both gates from one list.
6. **Pin each guard path with a regression**
   (`packages/omp/test/model-handoff-extension.test.ts`): replaying the revised
   output three times leaves exactly one export per marker; a command that only
   mentions a marker still receives the prefix; a quoted and a substituted value
   are not read as statements; `functions.bash` injects once; a caller-supplied
   export keeps its value.

## Consequences

- The identity channel survives host re-fires and omp 18.x validation without
  touching coordinator authority (`mstar_coordinator` derives coordinator
  identity from host facts and never relies on this channel).
- Revision cost stays bounded: one classifier call, one leading-chain scan of at
  most the hook's two statements, one shallow copy per call; no accumulation.
