# ADR: Milestone planned effort is a count of standard sessions

Status: implemented — the store, the command contract and every surface changed together, and only that change makes the decision real.

Date: 2026-11-24

Scope: project milestones on the combined store and the collaboration lane; the compass table's own date column is another record and is out of scope.

## Problem

The stored unit and the effort convention disagreed. `project_milestones.target` carried a calendar date while the effort convention bans person-days and calendar time and asks for agent session bands. An agent planning a milestone therefore had to translate a session estimate into a date that no lane works against, and every surface — the read model, the CLI and MCP flags, the roadmap export, the dashboard and the remote project document — carried that date further.

## Decision

A milestone's planned effort is a count of standard sessions. A standard session is one agent run that closes one task's Files and verification gates; it is a capacity unit and is never converted to minutes or hours. The column `project_milestones.effort_sessions` is null ("unestimated") or an integer of at least 1. The count compares milestones within one project; it does not promise a date.

## Alternatives considered

- Keep `target` beside the count. A kept date keeps inviting dates; the convention would still be contradicted by the schema it lives in.
- Store a wall-clock length per session. Throughput varies with concurrency and model, so a length turns the count back into a calendar.
- Store an XS–XL band instead of a count. Two milestones in one band cannot be compared, and a plan cannot sum bands.
- Convert each old date to a count. A date is not a measure of work, so no conversion exists.

## Consequences

Existing targets become unestimated on upgrade and are not recoverable from the new column; migration keeps no conversion. The milestone timeline orders by `ordinal`. No surface can state a calendar target for a project milestone. A later change can set the count beside measured sessions; this one does not attempt that.
