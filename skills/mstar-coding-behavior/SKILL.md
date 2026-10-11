---
name: mstar-coding-behavior
description: Use for non-trivial implementation, debugging, refactoring, or code review in any project, especially requirement drift, speculative complexity, or agent-facing interfaces. Not for workflow orchestration, role selection, or purely editorial changes.
---

# Coding Behavior

Start from the user's original outcome, not from the machinery already built.

## Workflow

1. **Plan from the need.** Identify the requested outcome, current acceptance criteria, non-goals, and actual constraints. Use first principles to separate what must be true from inherited implementation choices. State material assumptions; resolve questions from available evidence before asking for missing decisions.
2. **Read the affected flow.** Inspect the changed code, direct contracts, nearby behavior tests, and relevant project guidance. Before editing, map affected callers, tests, fixtures, configuration, and exports; identify data that could be destroyed or exposed and consumers that could break. Check API signatures against source or documentation. Existing artifacts are evidence, not additional requirements.
3. **Do the smallest complete change.** Choose the first fully working option in the reuse ladder below. Fix the root cause at the narrowest responsible point; finish affected consumers, tests, fixtures, configuration, exports, and documentation, removing paths made obsolete by the change. Preserve unrelated work and avoid opportunistic cleanup.
4. **Check the outcome.** Within the authorized verification scope, exercise the affected consumer behavior and meaningful boundaries. For a bug, use the reported failure or a minimal reproduction to guide diagnosis; change one causal factor at a time. Reuse unaffected evidence rather than rerunning unrelated checks.
5. **Act on evidence.** Compare results with acceptance criteria, diagnose any remaining failure, and refine only what is necessary. Assess review feedback against actual contracts and behavior; apply justified fixes or explain disagreement with evidence. Stop when the requested outcome is evidenced.

## Decision Rules

### Requirement-first simplicity

- Apply **Occam's razor and YAGNI**: prefer fewer concepts, moving parts, and assumptions that fully satisfy current requirements. Small does not mean incomplete, temporary, symptom-only, or cleverly compressed; a one-liner that needs decoding is not simpler. Between equally simple options, choose the one correct at the affected boundaries.
- Do not grow a design from existing layers just because they exist. Keep useful patterns, but replace a bad abstraction when the requested outcome requires it; do not preserve it solely for consistency.
- Never add imagined future features, extension frameworks, configuration knobs, compatibility wrappers, or speculative error handling. Each addition must answer a current requirement or a demonstrated risk in a supported workflow. Keep values in their existing form unless the contract requires conversion; do not add layers or wrappers merely to reshape them.
- Do not add validation, confirmation, or preflight gates for unsupported or hypothetical conditions. Retain trust-boundary validation, required authorization, security, data-loss prevention, accessibility, necessary hardware calibration, and requested behavior. Moving or merging code preserves its validation and error handling.
- Take the **first option that fully works**, not the shortest incomplete diff:
  1. Reuse a valid project helper, component, service, or pattern as surrounding code does; a suitable house component takes precedence over a native replacement.
  2. Use a standard-library or platform feature when no suitable house solution exists.
  3. Use an installed dependency; check its documentation and types before assuming it lacks the capability.
  4. Otherwise write the minimum readable direct solution. Add an established, well-maintained library only when it reduces overall complexity or improves reliability; check maintenance and size, and state the need in one sentence, not a new package for a few lines.
- Centralize and reuse sources of truth for prompts, contracts, and data instead of copying them; do not invent an abstraction framework to do so.
- Mark a deliberate bounded shortcut with `simplify:` and its ceiling/upgrade path. For an unavoidable workaround, explain why, label it `simplify:` or `temporary`, and record its removal path in the existing plan/status artifact before claiming completion. Temporary markers must cite that artifact.

### Agent-facing products

Treat ordinary agent mistakes as expected usage. Prioritize **discoverability, fault tolerance, and information fidelity**:

- Make commands, parameters, payload shapes, and recovery paths discoverable from help and errors. Verify what callers actually see: concrete invocations, parameters, and payload fields, not internal type names or generic capability claims. An undocumented capability is not a usable interface. Do not invent input modes unsupported by current requirements.
- Require only genuinely necessary input. Derive available facts and use safe defaults; ask for explicit target or authority when it cannot safely be inferred.
- Keep agent-authored content and mutations revisable through supported public operations. Avoid one-way restrictions or hidden manual repair; protect truly irreversible actions without making routine edits irreversible.
- Refusals must name the actual cause and exact supported recovery, not a generic block or an undocumented escape. When authority or an external prerequisite is missing, identify it honestly rather than inventing a bypass.
- Preserve real errors, distinctions, and partial outcomes. Never swallow or normalize away failures, fabricate success, or silently substitute a fallback that changes the meaning of the result.

### Surgical diagnosis and review

- Trace each changed region to the request, acceptance criteria, or a necessary integration fix. Follow callers only far enough to resolve the concrete affected behavior; do not restart repository-wide investigation.
- Read complete errors and relevant traces. Use observations to form a falsifiable cause, not a guessed patch. If reproduction is unavailable, disclose that limit and obtain the smallest missing evidence.
- Do not suppress an exception or special-case the failing input to make symptoms disappear. Correct the responsible invariant or flow and cover the demonstrated regression.
- Review suggestions are technical input, not automatic authorization. Prioritize correctness, security, and data loss; reject unrelated feature requests and ungrounded style changes rather than expanding scope.

## Evidence

Completion means the requested behavior meets its acceptance criteria, supported by the checks actually performed:

- For executable changes, retain the smallest relevant runnable check protecting consumer-visible behavior or a meaningful invariant. For bugs, demonstrate the regression and its correction when the available evidence and authorized checks permit.
- Test behavior, not source shape, prompt wording, forwarding echoes, or duplicated producer checks. Do not manufacture tests to satisfy a template.
- For non-executable policy changes, use scoped static or before/after evidence with observable criteria. Static lint does not establish model compliance or runtime behavior.
- Report the changed outcome and actual check commands/results concisely, including failures; never imply an unrun check passed. In the required report, use one or two closing lines for intentionally skipped work, material unverified behavior, and its user-facing risk. Separate observation from inference; a missing prerequisite is not a successful result.

## References

Standalone use requires no other Morning Star skill.

Only when working under Morning Star lifecycle or assignments, follow the existing authorities:

- `mstar-harness-core` — lifecycle, safeguards, gates, and Done ownership.
- `mstar-roles` — identity and Assignment skill-preset selection.
- `mstar-branch-worktree` / `mstar-dispatch-gates` — assigned checkout and delegation authority when applicable.

This skill does not waive those contracts, grant dispatch permission, or authorize Done.
