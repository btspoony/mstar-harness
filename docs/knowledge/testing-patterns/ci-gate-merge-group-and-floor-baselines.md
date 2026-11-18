---
module: CI comment gate (.github/workflows/ci.yml) and its lint consumers
date: 2026-11-18
problem_type: testing_pattern
category: testing-patterns
severity: medium
applies_when:
  - "A workflow lints changed lines and also runs under merge_group"
  - "An advisory corpus (unclassified comments, ownerless TODOs) gets a recorded size"
  - "A gate step redirects or filters a linter's stderr"
  - "A second literal copy of a file-extension list exists in a test or a workflow"
tags:
  - ci-gates
  - merge-queue
  - baseline-floor
  - extension-source
  - stderr-capture
---

# Merge-queue bases and floor baselines for a two-step comment gate

## Context

The CI comment gate runs two steps over `packages` and `scripts`: a whole-tree bound gate that fails on a broken bounded-shortcut marker (`simplify:` / `shortcut:` without an `upgrade:` clause or removal reference), and a changed-lines ratchet that fails on an unclassified comment the change added or modified. The split is deliberate — the whole-tree corpus of unclassified comments is far larger than one change should answer for — but three defects followed from it: a merge-queue run that silently linted every PR in the group, an advisory baseline recorded nowhere, and a gate step whose failure diagnostics could vanish. The rules below keep a two-step gate honest; they apply to any CI lint that mixes a whole-tree check with a changed-lines check.

## Guidance

1. **A changed-lines gate has to name every base it runs under.** Under `merge_group`, both `pull_request.base.sha` and `push.before` are empty, so the common fallback — `git merge-base origin/<default> HEAD` — computes the whole merge group's diff against the default branch and makes the ratchet lint every PR in the queue. Resolve the base in one explicit order and say which event uses which base: `PR_BASE` → `MERGE_GROUP_BASE` (`github.event.merge_group.base_sha`) → `PUSH_BEFORE` → `origin/<default>`. Keep the last rung as the branch-point fallback for a first push, never as the merge-queue answer.

2. **Record an advisory corpus as a floor, not a value.** Measure the corpus with the shipped command while the gate is green, record the measured count plus the exact re-measure command, and assert a floor below it rather than equality. New comments in unrelated files must not fail an unrelated change, while a collapse tells you the detector or the collector stopped seeing files. Treat the floor as a regression tripwire, not a target: raising it is a deliberate act with the fresh measurement in the change.

3. **One record for one number.** The workflow step cites the contract's single record for the measured baseline; it does not restate the figure. A second copy in a comment or a summary drifts the moment the corpus moves — the "~15k across 823 files" note that outlived its measurement is the failure mode, not the exception.

4. **Capture stderr before the pipeline can swallow it.** A gate step that pipes or redirects a linter's output loses the new diagnostics the moment the exit status is what the step checks. Let the linter write to a file or a command-substitution buffer, replay it on failure, and only then exit non-zero — otherwise the first failing run after a detector change reports nothing actionable.

5. **One extension source for the collector and every consumer.** A second literal list of file extensions in a test or a workflow `grep` drifts silently, and the drift is invisible in the direction that matters: an extension added to the consumer but not the collector lints nothing. Derive the consumer list from the exported definition, or add a test that asserts the two agree.

## Why This Matters

Each defect is cheap to fix but expensive to diagnose after the fact. A merge-queue ratchet that lints the whole group produces a red check on PRs whose diff never touched the flagged line, which reads as a flaky gate and trains reviewers to ignore it. An advisory count recorded as an equality turns every unrelated comment into a cross-cutting failure, so the gate gets bypassed instead of fixed. A single drifted number or extension list is invisible until someone debugs a gate that reported success over an unscanned file. The cost of the rules is one explicit base order, one measured floor and one shared list; the cost of skipping them is a gate whose failures do not name their cause.

## When to Apply

- A workflow uses `--diff-base` (or an equivalent changed-lines filter) and the repository may run it under a merge queue.
- An advisory check has a corpus larger than a single change should answer for (unclassified comments, TODOs, style findings) and needs to stay green while the corpus moves.
- A gate step filters or redirects its linter's stderr before checking the exit code.
- A consumer of a repository-defined list (file extensions, roots, allowlist paths) keeps its own literal copy.

## Examples

### Merge-queue base resolution

Before — only the pull-request and push events are read:

```yaml
- run: |
    base="${PR_BASE:-${PUSH_BEFORE:-}}"
    if [ -n "$base" ]; then merge="$(git merge-base "$base" HEAD)";
    else merge="$(git merge-base "origin/$DEFAULT_BRANCH" HEAD)"; fi
```

After — the merge-queue base is explicit, and the default-branch fallback is only the branch point:

```yaml
env:
  PR_BASE: ${{ github.event.pull_request.base.sha }}
  MERGE_GROUP_BASE: ${{ github.event.merge_group.base_sha }}
  PUSH_BEFORE: ${{ github.event.before }}
- run: |
    base="${PR_BASE:-${MERGE_GROUP_BASE:-${PUSH_BEFORE:-}}}"
    if [ -n "$base" ] && git merge-base "$base" HEAD >/dev/null 2>&1; then
      merge="$(git merge-base "$base" HEAD)"
    else
      merge="$(git merge-base "origin/$DEFAULT_BRANCH" HEAD)"
    fi
```

### Advisory baseline

Before — equality against a number copied into the step:

```bash
count="$(mstar lint packages scripts --type code | ... )"
[ "$count" -eq 14845 ] || exit 1
```

After — a floor recorded beside its measurement command, with the step pointing at the contract:

```bash
# The contract records the measurement and its command; this step only enforces the floor.
[ "$count" -ge 14000 ] || { echo "unclassified floor collapsed: $count < 14000"; exit 1; }
```

### Extension list

Before — the test carries its own literal list:

```ts
const SUPPORTED = new Set([".ts", ".tsx", ".js"]);   // second copy: drifts from the collector
```

After — the consumer derives the list it validates:

```ts
import { CODE_EXTENSIONS } from "../src/lint.js";
for (const ext of CODE_EXTENSIONS) expect(collector.extensions.has(ext)).toBe(true);
```
