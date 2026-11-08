# Context Economy

For model-facing text — tool and parameter definitions, Assignment fields, refusal and diagnostic strings, CLI help, template scaffolding. Each principle names a failure it removes; judge the text, do not score it.

## Six principles

1. **Start minimal, load on demand.** Expose purpose, available actions and constraints first; deferred detail is read only when the task reaches it. Front-loading every variant charges the reader on every turn and buys nothing.
2. **Make discovery explicit.** A deferred resource needs a description precise enough to be recognized and a reliable retrieval path — a skill reference, a path, a subcommand. A reference nobody can reach from the text that needs it is dead weight.
3. **Keep critical constraints visible.** Permission, destructive-effect and required-validation rules belong before the action they govern, never one layer down. A constraint discovered after the irreversible step is not a constraint.
4. **Prefer bounded outputs.** Return identifiers, paths or counts plus a way to fetch the rest; a whole log or document spends context on bytes the reader will not use. Cap the shape, not only the size.
5. **Use locality.** Deliver a bounded amount of adjacent context with a result — the surrounding thread, the neighbouring lines, the failing case — and mark every omission and truncation, with the handle that retrieves more. Silent truncation reads as completeness.
6. **Evaluate total work.** Saving context pays only if it does not cause extra searches, repeated reads or wrong guesses. A shorter text that forces two more lookups is a loss; measure the path, not the paragraph.

## Tool definitions

- **Delete obvious constraints.** Drop the rules the call result already teaches — a missing file failing to read, a send that did not deliver. Spend the words on the failure the result hides.
- **Describe behavior, not implementation.** State what the call does and returns; omit internal mechanisms, enforcement detail and the output markers the reader already sees in results.
- **Put parameter rules on the parameter, and say each fact once.** Defaults, ranges, pairing and when-to-set rules belong in that parameter's schema; the same fact repeated in the tool description, the system prompt or a second tool is one home too many.

## Measurement rule

Compare first-turn prompt cost before and after a wording change in the same host: a change that does not reduce what the model must read to act is editing, not economy.
