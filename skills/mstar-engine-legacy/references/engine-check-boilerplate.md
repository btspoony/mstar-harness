# Engine-check boilerplate explanation (archived)

> Engine-absent fallback: explains what the `Engine check (when available)` blockquotes in runtime skills mean, and how the fallback rule works when the engine is absent.

## What the boilerplate says

Runtime skills carry short contract pointers shaped as blockquote runs that open with a bold marker reading `Engine check (when available)` followed by a colon, then give a runnable verification form, then a fail clause, then the standalone guarantee sentence:

1. **Marker + command form.** The blockquote states a `mstar` CLI command or an engine-import form that validates the contract in that section. The import form references the engine package inside a host hook; the CLI form is `mstar <subcommand> <args>`. Illustrative shape (engine-present hosts only):

```text
// Engine check (when available) — import form example
import { validateStatus } from "@mstar-harness/engine";
```
2. **Fail clause.** `On fail -> do not proceed; fix and re-run.` A failed engine check means the contract is violated: the operator must fix the underlying state (not paper over the violation) and re-run the check before continuing.
3. **Standalone guarantee.** The blockquote closes with "Skill text below remains authoritative when the runtime is absent." — i.e. when the engine is not available in the host (no CLI, no import), the skill text itself (including this archive's full prose) is the contract; when the engine is available, the engine check is the authoritative enforcer and the prose is the fallback reference.

## Why the archive exists

When engine validators enforce a contract (status schema, lease fields, QC seat N, role binding, anti-recursion gates, path resolution, …), the runtime skills no longer need to carry the full contract prose — they keep the short pointer + the engine check. `mstar-engine-legacy` is the **single conditional archive** of that displaced full prose: engine-absent hosts read it here; engine-present hosts never load it (`mstar-harness-core` load condition).

## Reading the boilerplate when the engine is absent

- See the marker → read the surrounding runtime-skill text for the short contract, and open this skill's matching reference for the full prose (status fields → `status-field-history.md`; leases → `lease-protocol.md`; QC seats → `qc-seat-n-restatements.md`; anti-recursion → `anti-recursion-checklists.md`).
- The fail clause means the same discipline applies manually: verify the artifact satisfies the contract before proceeding.
- The standalone guarantee is why this archive is authoritative for you — the runtime skills deliberately defer the full text here.
