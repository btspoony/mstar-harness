# Parity

Parity is measured per layer. A difference that is real in one layer is noise in another, and mixing
them is what turns a round into opinions.

## Three layers

| Layer | Question | What differs when this layer is wrong | Typical cause |
|-------|----------|---------------------------------------|---------------|
| **Structure** | which units exist, in what order and nesting | a unit is missing, extra, in the wrong place, or contains the wrong children | a component was rebuilt from a screenshot; a wrapper was collapsed |
| **Appearance** | which values the units carry | colour, type scale, spacing, radius, elevation, declared breakpoints | a token was approximated, rounded to a grid, or re-typed |
| **Behaviour** | how units respond | states, reflow, focus order, motion | the visual was matched without the state matrix |

Order matters: compare structure first. Appearance differences on the wrong structure are wasted
work — a fix that restyles a component that should not be there has to be undone.

## Measuring each layer

**Structure.** Extract the unit list from both sides mechanically (markers, selectors, node paths)
and compare the sets: present, missing, extra, and order. Report four counts, not one verdict.
Nesting is a second comparison; a flat set can match while the tree does not.

**Appearance.** Compare values that both sides expose as data — the fixture's declared values against
the implementation's computed or declared values. Compare values, not renders: a screenshot diff
answers "did anything change", not "which token is wrong", and cannot name the unit it fired on. A
tolerance is acceptable only when it is declared and bounded (sub-pixel rounding, a one-pixel border);
an undeclared tolerance is a silent rounding rule.

**Behaviour.** Enumerate the state matrix and reflow points before comparing: default, hover, focus,
active, disabled, empty, loading, error, plus the declared breakpoints. Each cell is a unit. A layer
with no enumerated states is not measured — say so instead of inheriting "unchanged".

## The `@media` vs `@container` trap

A rule written against viewport width does not fire when the unit reflows inside a container: a panel
placed in a wide dashboard keeps its viewport-level width while its own box has already collapsed.
A probe that renders the page wide therefore never reaches the component-scoped breakpoint, reports
zero differences, and reads as a pass.

First establish whether the baseline requires reflow at the viewport's width or the container's
width. If the implementation queries the wrong width, fix the implementation. If the probe varies the
wrong width, fix the probe. Measure component-level reflow at the container's own width, or name it as
unmeasured in the coverage statement. The same trap exists in reverse for `@container` rules probed
only on narrow viewports.

## Counts, including on failure

Every comparator prints what it compared — `compared N units / M tokens / K breakpoints` — and prints
it on the failure path too. A missing baseline that produces `0 differences` and exits `0` is a
failed check wearing a pass; the failure line has to state how much was owed.

Coverage is per layer. A round that compared every token and no state is not "parity"; it is token
parity plus unmeasured behaviour, and the coverage statement says exactly that.

## No hand-captured constants

Fixtures are derived from the baseline, never typed. A structural table captured once by hand — panel
composition, breakpoint list, class inventory — has no deriver and no consumer, so it stops matching
the moment the source changes and nothing fails. Derive it, or delete it; see `references/baseline.md`
for the derivation rules and the three-link chain.
