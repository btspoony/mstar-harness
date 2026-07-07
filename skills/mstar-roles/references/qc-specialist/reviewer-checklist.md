# QC Reviewer Checklist

Extension of `references/qc-specialist-shared.md`. Use during step 5 of `reviewer-workflow.md`.

## Code quality

- [ ] Naming is clear and consistent.
- [ ] Responsibilities are not overly mixed.
- [ ] Error handling is explicit and actionable.
- [ ] Comments explain intent, not trivial implementation noise.

## Security and correctness

- [ ] Inputs are validated; boundary checks are explicit.
- [ ] No obvious injection, path traversal, or permission issues.
- [ ] Sensitive data is handled appropriately.
- [ ] Invariants and state transitions are coherent.
- [ ] LLM/Agent boundary: untrusted input does not drive privileged ops; prompt-injection surfaces identified.

## Performance and reliability

- [ ] Hot paths avoid avoidable overhead.
- [ ] Resource lifecycles are correct.
- [ ] Unbounded operations are addressed.
- [ ] Degradation and failure behavior is observable.

## Maintainability

- [ ] Contracts and interfaces remain understandable.
- [ ] New dependencies are justified.
- [ ] Breaking changes include migration guidance.
- [ ] Reuse preferred over duplicate logic.

## High-risk ops (when Assignment marks high-risk)

Applies to migrations, prod config, destructive data ops, cert rotation, shared-env scripts, etc.

- [ ] Impact scope and maintenance window (or user impact) documented.
- [ ] Rollback steps are executable and reviewed.
- [ ] Backup/snapshot or equivalent recovery confirmed (if applicable).
- [ ] Change and verification steps are auditable (commands, pipeline, runbook — not a black box).
- [ ] Application code changes still follow default dev gates — not skipped as “ops only.”
