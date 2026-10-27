# Baseline

The baseline is the artifact whose values are the authority for the round. This file covers choosing
one, making it readable by a machine, and closing the chain that turns "committed" into "checked".

## What counts as a baseline

A baseline has four properties or it is not one:

1. **Tracked** — it is in the repository, at a path a comparator can read without a checkout of a
   different branch or a private drive.
2. **Readable** — the units of comparison can be extracted from it mechanically, not by eye.
3. **Authoritative** — when the implementation and the baseline disagree, the baseline wins unless
   it is silent.
4. **Complete for its scope** — its silences are known and recorded, not discovered during triage.

## Baseline kinds

| Kind | Usually looks like | Unit of comparison | What makes it machine-readable |
|------|--------------------|--------------------|-------------------------------|
| **Prototype HTML** | one self-contained page, or a page per screen, with per-unit markers (`data-screen`, section ids) | the marked unit (screen, section, component) | a deriver that reads the tracked HTML and writes a fixture: selectors, declared tokens, breakpoints |
| **Design export** | JSON/XML/SVG from a design tool | the node or artboard | the export's own structure; keep the export file, not a re-typed table of it |
| **Existing product markup** | the current implementation of another surface, or a reference site's markup | the component or token set | extract the tokens and structure directly from the markup; treat the extraction as the fixture |
| **Written contract** | a document with structured token values plus prose rules (the shape `mstar-design-md` owns) | the token or rule | the structured block (frontmatter) is the fixture; the prose is the authority for judgement |
| **None** | — | — | stop: no baseline means this skill does not apply; the contract has to be created first |

Two more identifiers are worth recording per round, because they decide what "converged" means:
whether the baseline is **per-unit** (many screens) or **single** (one component), and whether it is
**visual only** or also **behavioural**.

## Making it machine-readable

- Derive, do not transcribe. If the value can be read from the tracked source by a program, it must
  be: a typed constant sitting beside a source that already contains the same information is a second
  truth, and the two drift with nothing failing.
- A hand-captured constant is a **hypothesis** — a table captured once from a prototype by eye, with
  no deriver and no consumer, is a fact nobody re-checks. Either derive it or delete it.
- The deriver and its check mode belong together (`write` regenerates, `check` fails on drift), and
  the command belongs in the repository's own instructions, not in a chat message.
- Never make the fixture the edit target. The fixture is regenerated; the source is edited.

## Redaction before committing

A baseline copied from a private source is usually not committable as-is. Strip, and record what was
stripped:

- credentials and tokens embedded in exported pages or captured markup;
- customer names, real content, internal hostnames and endpoints;
- license-restricted fonts and assets — substitute and say so;
- unreleased copy or product surfaces.

Record the removals in the baseline's own README or in the contract document. A redaction that also
removes a unit of comparison narrows the round: the coverage statement must name it, otherwise the
round silently stops covering part of its own scope.

## The three-link chain

Committing the baseline is link one of three. All three close before a check counts as live:

| # | Link | Fails when |
|---|------|------------|
| 1 | **Committed** — the baseline and the derived fixture are tracked | an untracked source or fixture — the tracked-vs-ignored test is `mstar-design-md` § Prototype vs document |
| 2 | **Every comparator points at it, and strict mode is the default** | a comparator still reads another path, or its default run does not fail — same rule, same place |
| 3 | **CI calls it** | no workflow job runs the command — the check exists and is never invoked |

The most expensive state is not "missing"; it is **green but idle**. A comparator that prints
`warn` and exits `0` when its baseline is absent looks healthy in every report, so nobody looks at
what it compared. When auditing a chain, run each comparator with its baseline removed and read the
exit code; a `0` there means the check is decorative.

The after-state of a closed chain is one sentence a reader can verify: *the tracked file is the
baseline, every comparator fails when it drifts, and CI runs them.*

## Unreadable source

When part of the baseline cannot be read — a broken export, a truncated page, an image instead of
markup — stop and report exactly what was read and what was not. Never infer the unreadable part,
and never round it into something plausible. The round continues on the readable units with the gap
named in the coverage statement; the unreadable part is a decision recorded with its reason.
