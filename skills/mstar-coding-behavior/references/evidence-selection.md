# Evidence selection

Choose the check that proves this change, not the check that proves the tree. The diff decides what must be exercised: the behavior a change can reach selects its check, and the same selection answers whether the result is enough to call the work done.

## Selection rule

There is no universal local baseline. Start from the change type, name the smallest check whose failure would mean this change is wrong, and add a broader check only for a surface the diff actually reaches. A full suite stays the remote CI owner's job unless the change genuinely spans the repository or a reported failure is being diagnosed.

A check that cannot fail for this regression is not evidence. Green from a check that never exercises the changed path says nothing about the change, and naming it as proof reports an unearned conclusion.

## Change type to smallest sufficient evidence

| Change type | Smallest sufficient evidence | Trap |
|---|---|---|
| Executable behavior | the owning test file and the named case; a changed shared contract also takes the adjacent tests that assert the same contract | a file-wide filter whose selected case count nobody checked — confirm the run selected the intended case |
| Bug | the reported reproduction, failing before the change and passing after | a nearby green test that never reproduced the report |
| Package, script entry, manifest or build configuration | build the affected artifact and run the owning smoke against the built output | reading source-level checks as evidence for a surface whose generated declarations are missing, stale or partial |
| Public export or build configuration change | rebuild, plus the freshness or hygiene check for any committed artifact that inlines that code | output from an earlier build accepted as this change's evidence |
| Model-, CLI-, UI- or terminal-visible text | the owning snapshot or runnable scenario, qualified only when it asserts parsed fields, exit status or rendered state a caller observes | a unit assertion about the source that produced the text; it does not show what a caller reads, and a snapshot comparing the literal transcript or a whole-file text is not that evidence |
| Documentation or agent-instruction text | a scoped static check over exactly that text — presence or absence search, line budget, or the skill lint that reads it — reported as before/after counts | manufacturing a test to satisfy a template; static checks still do not establish runtime compliance |
| Measurement or performance claim | before/after numbers from the same machine, dataset and command, with both conditions stated | an after-only number, or two runs whose differing conditions go unstated |
| Test, fixture or helper change | the tests that consume it, plus the reliability judgement below when the change owns a resource | treating a green consumer as proof that the fixture is isolated |

## Focus and coverage are separate decisions

A test filter chooses which tests run; a coverage scope chooses which source those tests must prove. Where coverage is the evidence, name both — the owning tests and the affected source scope — and do not lower a threshold or narrow the scope to hide a file the change reaches.

## Scope discipline

Verify the owning surface, not a neighbouring one. Map the change to the code that owns the behavior, run that, and state the mapping; an adjacent suite earns its run only when the change alters a contract it shares.

Name the artifacts the change produces, and treat any committed artifact that inlines the changed code as part of the changed surface: regenerating and checking it belongs to this change's evidence, not to a discovery in CI one round later.

Batch local fixes and validate once the batch is coherent. Re-running the same check for each intermediate state yields partial results that are hard to attribute and adds no evidence.

## Where the rest is owned

- Concurrency, process, port, clock, temporary-root, global-state or teardown risk → `references/test-reliability.md` in this skill.
