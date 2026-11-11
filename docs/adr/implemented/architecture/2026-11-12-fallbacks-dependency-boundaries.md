# ADR: The `dsh-llm-fallbacks` pin is two hand-written literals moved in one change, not a compared pair

Status: implemented — both literals already move together in one change set and nothing compares them; this record states that obligation and the accepted dev-only peer cost instead of adding a gate.
Date: 2026-11-12

Scope: the fallbacks pin in `packages/dsh/package.json` (`devDependencies["dsh-llm-fallbacks"]`) and `packages/cli/package.json` (`mstar.dshLlmFallbacks`), its runtime reader in `packages/commands/src/host-health/dsh.ts`, and the fallbacks test suite under `packages/dsh/tests/`.

## Problem

One fallbacks version is consumed twice, for two different jobs, through two hand-written literals in two packages. `packages/dsh` pins it as a devDependency because bun needs a real spec and the workspace test suite boots the installed package; `packages/cli` pins it a second time as `mstar.dshLlmFallbacks`, which `init --target dsh` turns into the install spec and `doctor --target dsh` compares against a mounted profile row.

A bump that edits one side only splits the pin: the suite exercises one release while installs get another, and the installed release's `@deepseek-ai/dsh-*` peer cohort stops matching the repository's line — mismatched rc lines break boot of the installed artifact. This is not hypothetical: the pin once sat at a release whose peers were `^0.1.2-rc.1` while the repository was on `^0.1.5-rc.2`.

A drift test used to compare the two values, but it compared an `@mstar-harness/engine` constant against the manifest field. That constant is gone: the published CLI bundle cannot import JSON at build time (`resolveJsonModule` off), so `dshFallbacksVersion()` now reads `mstar.dshLlmFallbacks` from the manifest that ships beside the bundle. No test, script or release surface compares the remaining pair, so what replaces the removed gate is a decision among real options — and the wrong option leaves a permanent maintenance surface behind a two-string invariant.

## Decision

Both values stay hand-written literals and are moved together in one change set: a pin bump edits the `packages/dsh` devDependency and the CLI's `mstar.dshLlmFallbacks` in the same commit, and the change fragment records the resulting peer cohort. The runtime reader stays a manifest read — `dshFallbacksVersion()` / `dshPluginSpecs()` / `fallbacksVersionDrifted()` consume the CLI's own `package.json` beside the published bundle — while workspace tests import the installed package directly.

No test, validator, drift script or release surface compares the two literals. The limit is documented here rather than enforced; the same-commit pairing is a review obligation, and this record is what a reader is pointed at when they ask why there is no gate.

The dev-only nested `react` 18 is accepted as part of the same boundary. The package declares `react ^18` as a peer, so the `packages/dsh` install carries a nested React 18 tree while the workspace runs React 19. It cannot reach shipped behavior: `packages/dsh/src` holds zero runtime and zero type references to the package (local structural mirrors stand in), only the test suite imports it, and the package's `./client` surface is not mounted into the mstar dashboard's React tree.

## Alternatives considered

- **Restore a test that compares the two manifests.** Lost: it asserts that two copies of one string are equal and exercises no consumer, which is the copy/wiring assertion the test policy forbids; on top of that, the failure it would catch is a same-commit release action a reviewer already reads in the fragment, so it would buy a second place to update every bump and catch nothing the real install/doctor path does not show first.
- **Make the CLI read the devDependency instead of keeping a second literal.** Lost: the published CLI cannot import JSON at build time, its devDependencies are not part of the published package, and a published binary cannot rely on reaching another package's manifest at runtime. The second literal is the only surface the runtime can actually read.
- **Derive both values from a shared JSON or bun catalog.** Lost: it needs codegen or a build step for a two-string invariant and still leaves the published bundle carrying the value; the manifest-carried literal is already the shape the runtime needs.
- **Add a drift script or validator.** Lost: a new permanent surface and CI wiring maintained for one pair, when the only drift it detects is a half-bump a human is already making in a release change.

## Consequences

- A reader may assume these are the only two version sources: a bump edits both, in one change, and workspace tests and installs then land on the same fallbacks release.
- A reader may not assume CI fails on a split pin, that any surface compares the pair, or that the nested `react` 18 is a production dependency; it is dev-only and unmounted.
- The cost is that a half-bump is caught in review, not by a red test. If the pin splits again through an unattended upgrade path, or a bump lands with one side only, the review obligation has failed and a gate becomes justified — that is the trigger for superseding this record.
- This is a live statement about where the two literals live and who reads them: the change that moves those paths, the reader or the tests updates this record in the same change.
