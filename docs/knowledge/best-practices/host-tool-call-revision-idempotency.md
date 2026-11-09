---
title: Make host tool-call input revisions idempotent; carry identity in the command prefix
module: omp host adapter / model-handoff extension
date: 2026-09-26
problem_type: best_practice
category: best-practices
severity: high
source: plan 20260925-omp-session-id-prefix-stack (fix for the unbounded `export MSTAR_HOST_SESSION_ID` prefix stacking)
status: active
tags:
  - host-adapter
  - tool-call-revision
  - idempotency
  - session-identity
  - omp-compat
related:
  - architecture-patterns/host-engine-identity-association.md
---

# Make host tool-call input revisions idempotent; carry identity in the command prefix

## Context

The omp `model-handoff` extension revises every `bash` tool call of its session so
a child `mstar plan bind` (plan/assignment form) inherits the host session id
via `MSTAR_HOST_SESSION_ID` (see
[host-engine-identity-association](../architecture-patterns/host-engine-identity-association.md)
for why the channel exists). Two failures appeared in sequence:

1. **`env` field revision (v3.11.1–3.11.2)**: writing the identity into the
   call's `env` input field broke on omp 18.3.0, which refuses any bash call
   whose input carries `env` without a service `name`
   (`ready and env require a service name.`) — every shell call of the session
   failed before execution.
2. **Command-prefix revision without a guard (#289 prototype)**: prepending
   `export MSTAR_HOST_SESSION_ID='<id>'; ` to `input.command` works on 18.3.0,
   but the host can re-fire the `tool_call` revision for the same call
   (retry/replay paths). Each re-fire prepended the prefix again, producing
   unbounded stacking — dozens of identical `export` statements before one
   command.

## Guidance

1. **Treat every input revision as re-entrant.** A host may deliver the same
   tool call to your revision hook more than once, and later deliveries can
   carry the already-revised input. Guard on a stable marker of your own
   revision (here: the command already contains `export MSTAR_HOST_SESSION_ID=`)
   and return the input unchanged when it matches. Accepted tradeoff: a
   caller-written export of the same variable is respected instead of
   overwritten — convenience channels must not be trust boundaries.
2. **Do not touch validated parameter surfaces.** Fields the host validates
   against its own schema (omp 18.3.0's `env` requires a service `name`) are
   closed to ad-hoc revisions. Carry the value through a surface the host does
   not re-validate — the command string itself — so the child process
   environment receives it without tripping host checks.
3. **Gate revisions on the same tool-name set as every other shell
   classifier.** The extension classifies coordinator shell calls against
   `SHELL_TOOL_NAMES = ["bash", "functions.bash"]`; an injection gate that
   checks only `=== "bash"` silently skips namespaced shells
   (`functions.bash`) and diverges from the classifier's notion of a shell
   call. Derive both gates from one list.
4. **Pin every named guard path with a regression.** The multi-fire stacking
   case (feed each revision output back in N times, assert exactly one
   prefix), the caller-supplied-export skip, and the `functions.bash` variant
   each caught or would have caught a real defect; behavior named in the plan
   constraints but untested stayed unpinned until review forced it (F-001).

## Consequences

- The identity channel survives host re-fires and omp 18.x validation without
  touching coordinator authority (`mstar_coordinator` derives coordinator
  identity from host facts and never relies on this channel).
- Revision cost stays bounded: one classifier call, one substring scan, one
  shallow copy per call; no accumulation.
