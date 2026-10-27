# Design system

The prototype, the fixture derived from it, and the script that derives it. Everything this
repository knows about how the product should look is in this directory, and `DESIGN.md` at the
repository root is the summary of it.

## What is here

| File | What it is | Who reads it |
| --- | --- | --- |
| `prototype.html` | The design prototype: one document, one `<style>` block, nine `<section data-screen>` screens | Humans; the diff scripts |
| `snapshot.ts` | Derives the fixture from `prototype.html` | `check:snapshot`, `snapshot:write` |
| `snapshot.json` | **Committed** fixture: screen frame values and reflow breakpoints | `src/styles/tokens.test.ts`, CI |

## Why the prototype is a tracked file

It used to live outside the repository, so CI could not read it and the comparators could not
fail: they warned and exited 0, **looking green while comparing nothing**.

Being tracked is what makes it a baseline. All four checks read it —
`check:snapshot`, `check:declarations`, `check:selectors`, `check:tones` — and all four exit 1
when the file cannot be read, naming the path they wanted. CI runs every one of them in the
`test-ui` job, so a comparator cannot pass without its baseline again.

The copy is redacted: real iteration ids become `iter-N`, harness paths become `{HARNESS_DIR}`.
The CSS is untouched — `check:snapshot` confirms the derived values did not move.

## The rule this directory exists for

**The prototype is the standard.** When the implementation and the prototype disagree, the
prototype wins — unless the prototype is silent on the question, in which case the decision goes
in `DESIGN.md` with its reason.

Three things must stay in step, and only one direction is allowed:

```
prototype.html   →   snapshot.json   →   DESIGN.md
   the source        the machine values     the human summary
```

1. **Change the prototype first.** It is the design.
2. **Run `bun run --cwd packages/ui snapshot:write`.** The fixture is derived, never typed.
3. **Bring `DESIGN.md` in line.** It summarizes; it does not decide.

`bun run --cwd packages/ui check:snapshot` fails when step 2 is skipped. Nothing fails when step
3 is skipped, which is why it is written down here: **a `DESIGN.md` that lags the prototype is the
one kind of drift this directory cannot catch for you.**

## What the fixture does not cover

The nine screens' structure — panel headings, column headings, each table's
`data-narrow-cols`. Extracting those from the HTML was attempted and abandoned: the section
boundary logic produced 0 panels for `workflows` and `iterations` and 16 for `project-detail`. A
fixture that is wrong is worse than none, because it looks authoritative.

If someone takes this on, the parser needs to key on `<section class="screen" data-screen="…">`
and stop at the next one, and the redaction above must survive it.
