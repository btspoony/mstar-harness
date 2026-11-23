---
module: CI comment gate (.github/workflows/ci.yml) and its lint consumers
date: 2026-11-18
last_updated: 2026-11-23
problem_type: testing_pattern
category: testing-patterns
severity: medium
applies_when:
  - "A workflow lints changed lines and also runs under merge_group"
  - "A detector's behaviour is asserted by a corpus count instead of its own tests"
  - "A gate step redirects or filters a linter's stderr"
  - "A second literal copy of a file-extension list exists in a test or a workflow"
tags:
  - ci-gates
  - merge-queue
  - corpus-floor-retired
  - extension-source
  - stderr-capture
---

# Merge-queue bases and detector tests for a single-ratchet comment gate

## Context

The CI comment gate runs one step over `packages` and `scripts`: a changed-lines ratchet that fails an unclassified comment the change added or modified. It once ran two — a whole-tree bound gate that failed on a broken bounded-shortcut marker (`simplify:` / `shortcut:` without an `upgrade:` clause or removal reference) beside the ratchet — and three defects followed from that split: a merge-queue run that silently linted every PR in the group, an advisory baseline whose recorded count drifted with the corpus, and a gate step whose failure diagnostics could vanish. The whole-tree step and its per-root count floor are retired, because a lower bound cannot tell a detector regression from a genuine cleanup ([retirement record](../../adr/implemented/process/2026-11-23-comment-corpus-floor-retired.md)); what remains is one gate, whose detector behaviour its own CLI tests assert. The rules below keep that gate honest, and they apply to any CI lint that judges a change's own increment.

## Guidance

1. **A changed-lines gate has to name every base it runs under.** Under `merge_group`, both `pull_request.base.sha` and `push.before` are empty, so the common fallback — `git merge-base origin/<default> HEAD` — computes the whole merge group's diff against the default branch and makes the ratchet lint every PR in the queue. Resolve the base in one explicit order and say which event uses which base: `PR_BASE` → `MERGE_GROUP_BASE` (`github.event.merge_group.base_sha`) → `PUSH_BEFORE` → `origin/<default>`. Keep the last rung as the branch-point fallback for a first push, never as the merge-queue answer.

2. **Assert the detector, not a corpus count.** The shipped gate is the ratchet (`mstar lint <file> --diff-base <ref>`): it resolves the merge base, keeps only the findings whose comment lines the diff touches, and fails those, so a change answers for its own increment and never for the corpus. Detector behaviour is pinned by `packages/cli/test/lint-cli.test.ts` instead of by a number — unclassified detection and its stderr count line, `why:` acceptance, doc-block handling, and the `--diff-base` ratchet over added, untouched and interior-moved lines — so a detector or collector regression fails at the rule it broke while the corpus stays free to move. A whole-tree run (`mstar lint <dir> --type code`) remains a local and review tool; CI asserts no corpus count anywhere.

   > **Retired (2026-11-23):** the earlier forms — equality against a copied count, then a lower bound recorded beside its re-measure command — both failed this test, because a cleanup and a detector regression produce the same drop. The floor's reasoning and its rejected alternatives are in the [retirement record](../../adr/implemented/process/2026-11-23-comment-corpus-floor-retired.md).

3. **One record for one number.** The cleanup pass reports the measured `unclassified-comment net change` per root, quoted with the command and the commit it was taken on; no step restates that figure and no gate asserts it. A second copy in a comment or a summary drifts the moment the corpus moves — the "~15k across 823 files" note that outlived its measurement is the failure mode, not the exception.

4. **Capture stderr before the pipeline can swallow it.** A gate step that pipes or redirects a linter's output loses the new diagnostics the moment the exit status is what the step checks. Let the linter write to a file or a command-substitution buffer, replay it on failure, and only then exit non-zero — otherwise the first failing run after a detector change reports nothing actionable.

5. **One extension source for the collector and every consumer.** A second literal list of file extensions in a test or a workflow `grep` drifts silently, and the drift is invisible in the direction that matters: an extension added to the consumer but not the collector lints nothing. Derive the consumer list from the exported definition, or add a test that asserts the two agree.

## Why This Matters

Each defect is cheap to fix but expensive to diagnose after the fact. A merge-queue ratchet that lints the whole group produces a red check on PRs whose diff never touched the flagged line, which reads as a flaky gate and trains reviewers to ignore it. A corpus count turns every unrelated comment into a cross-cutting failure, and the floor that replaced the equality hides the one thing it was meant to catch: a broken detector reads as a cleanup. A single drifted number or extension list is invisible until someone debugs a gate that reported success over an unscanned file. The cost of the rules is one explicit base order, one tested detector and one shared list; the cost of skipping them is a gate whose failures do not name their cause.

## When to Apply

- A workflow uses `--diff-base` (or an equivalent changed-lines filter) and the repository may run it under a merge queue.
- A detector such as the comment scanner needs a behaviour proof, and the available signal is a corpus count rather than the rules' own tests.
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

Before — the retired step asserted equality against a number copied into the workflow:

```bash
count="$(mstar lint packages scripts --type code | ... )"
[ "$count" -eq 12790 ] || exit 1
```

Retired — a floor below a recorded measurement replaced equality and still moved with every genuine cleanup; the reasoning and the rejected alternatives are in the [retirement record](../../adr/implemented/process/2026-11-23-comment-corpus-floor-retired.md).

After — CI asserts no corpus count. The ratchet is the only comment gate:

```bash
# selects the changed code files, then ratchets each against the merge base
bash scripts/comment-gate-select.sh "$merge" > "$RUNNER_TEMP/comment-changed.bin"
export MSTAR_COMMENT_BASE="$merge"
xargs -0 -r -n 1 sh -c 'mstar lint "$1" --diff-base "$MSTAR_COMMENT_BASE"' sh \
  < "$RUNNER_TEMP/comment-changed.bin"
```

and the detector's behaviour is asserted where it lives:

```ts
// packages/cli/test/lint-cli.test.ts
test("--diff-base fails the comment on an added line and not the one above it", ...);
test("a documentation block above an export is not reported, one above a local is", ...);
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
