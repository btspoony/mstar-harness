# Deep Module Vocabulary

## Scope

Role-owned reference of **mstar-roles** → `references/qc-specialist/deep-module-vocabulary.md`, discovered through `references/qc-specialist/deep-review-lenses.md`; never preset-gated. It supplies the shared words and the four tests behind **Depth Lens**, so two seats argue about the same object instead of trading adjectives.

## The seven fixed terms

Use only these seven words. The substitutes in the last column are forbidden because they move the conversation from design to deployment topology, where "is this deep" has no answer.

| Term | What it means | Forbidden substitutes |
|---|---|---|
| **module** | anything with an interface and an implementation — a function, class, file, package or whole service | component, service, API, boundary |
| **interface** | everything a caller must know to use the module correctly: types, call ordering, error behaviour, invariants, required context — not just the type signature | — |
| **depth** | behaviour reachable per unit of interface learned; a deep module hides much behind a small interface, a shallow one exposes as much as it does | — |
| **seam** | a place where behaviour can be substituted without editing the caller; it exists only where something actually varies | boundary, extension point |
| **adapter** | the concrete implementation bound at a seam | driver, provider, integration |
| **leverage** | how many call sites and future changes one interface decision pays for | — |
| **locality** | how much a reader must hold in mind to predict a module's behaviour; low locality means the answer is scattered across callers | — |

## The four tests

Each test is answerable from the diff, one read, or one grep — never from taste, and never by running tests or builds.

**Deletion test.** Delete the module and follow its complexity. If the complexity vanishes, the module was a pass-through — a shallow wrapper earning nothing; if it reappears across N callers, it earns its keep. Report N, because N is the leverage measurement.

**Interface is the test surface.** A test that reaches past the interface (constructing internals, stubbing private collaborators, asserting on state the interface does not expose) means the module is the wrong shape, not that the test is too strict. Fix the shape, or move the assertion to the interface.

**One adapter means a hypothetical seam.** A seam with exactly one adapter and no stated varying axis is speculation, not design. Two adapters, or a named varying axis plus a caller that differs, makes the seam real.

**Depth is leverage, not a line ratio.** Never measure depth as implementation lines over interface lines, nor as interface size alone. Ask what the abstraction buys at call sites: a shared invariant enforced once is depth; a function extracted only to shorten another function is not.

## Label rule

Label every Depth Lens recommendation `Strong`, `Worth exploring`, or `Speculative`. `Strong` — a test above decides it and the diff carries the evidence; `Worth exploring` — the tests point one way but the fix shape is still open; `Speculative` — the module or seam is proposed for a future with no caller in the repo. A `Speculative` candidate is never a blocking finding: report it as an advisory candidate, never as Critical and never as an approval gate.

## When both lenses apply

When Depth and Modularity both apply to one diff, they stay complementary: Depth judges abstraction value (the deletion test and the leverage count) while dependency direction, layering, responsibility boundaries and cycles remain Modularity checks. Report a shared root cause once, under the lens whose question it actually answers.
