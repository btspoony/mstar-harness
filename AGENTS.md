# Morning Star Harness Maintenance

This policy governs maintenance of the mstar-harness repository itself and does not apply when the working repository is a different project.

The repository contains the Morning Star runtime skills, workflow engine, CLI, command implementations, host plugins, judgment runtime, and shared UI. This file defines repository maintenance policy; runtime behavior belongs in `skills/mstar-*`.

## Working rules

- Read the affected source and its direct contracts before editing. Fix the demonstrated problem or requested outcome with the smallest complete change; avoid speculative features, compatibility layers, and unrelated refactors.
- Keep each rule in its authoritative topic. Runtime semantics → [harness core](skills/mstar-harness-core/SKILL.md); role selection → [roles](skills/mstar-roles/SKILL.md). Do not duplicate their load matrices, gates, or procedures here.
- Use tools actually available in the session. Continue authorized work through verification; ask only when a material decision or required authorization remains unresolved. Do not add a separate human approval gate for every diff.
- Respect existing assignments and write ownership. Preserve other contributors' changes; do not reset or clean their work.
- Do not edit user secrets or credential files. Changes to global host configuration or security-sensitive defaults require explicit user authorization.
- **No hard block without a way out.** Every refusal a user-facing entry can emit must name the actual cause and the exact recovery the operator can perform through a supported, documented interface — never a hidden escape (hand-editing state, undocumented flags, or steps the tooling does not expose). A gate with no paired recovery is a defect. Never add a hard limit without shipping its recovery in the same change, covered by a test.
- **Fault tolerance and discoverability first for agent-facing operations.** All document and content mutations are agent-authored, so mistakes are expected. Mutations stay revisable through ordinary public operations (no one-way doors), parameters stay optional except a minimal `required` set with safe defaults, and commands, parameters, and recovery paths are discoverable from `--help` and refusal text — an undiscoverable capability does not exist. Anchor: #365.
- **Test layout.** Module-unit suites colocate as `src/<module>.test.ts` (one module's unit mirror); cross-module behavior suites live in `test/`. Test-support helpers live with the package that owns them. The engine build compiles `src/**`, so colocated suites are typechecked and their declarations land in `dist/`.
- **Tests derive volatile facts, never pin them.** A test asserting a repository fact — release version, package/role/skill inventory or count, checkout path — MUST read it from the source that owns it (manifest, directory listing, CLI). A literal is fine only as a synthetic fixture input that nothing compares against reality: `"4.0.0"` as input is fine, `version === "4.0.0"` is not. A pinned version reddens release branches while `main` stays green, so ordinary PR CI cannot surface it.
- **严禁任何形式的字节快照、hash 对比或硬编码内容对比作为测试断言。** This is a hard prohibition: comparing a directory's file bytes or a base64/hex dump; asserting a digest equals `createHash(...)` of the same input or a literal digest constant; asserting a file equals a hard-coded full text, even via a named constant; asserting a release or module version equals a hard-coded literal. A version or hash may be **passed in as an input** but never be the expected side of an assertion. Assert the observable semantic instead: the rows a write created, the field a caller reads, the refusal a command emits. A test needing a byte-level, digest-level or pinned-version comparison MUST NOT be added or kept; record the requirement as an issue and get the approach confirmed first.
- **Durable decision rationale has one home: `docs/adr/`.** A decision that must outlive its plan or PR is a record there, following `skills/mstar-doc-corpus/references/adr.md` ([this repository's tree and gate](docs/adr/README.md)); plan, PR, and knowledge docs keep a pointer, never the reason.

## Git and local artifacts

- Develop in a task worktree under the sibling root `<parent-of-repo-root>/{repo-basename}.worktrees/`, where repo root is the realpath of the Git top-level. Keep the primary checkout on `main`: skills and commands may be symlinked to it. Changes reach `main` through PRs; never make direct feature commits there.
- Reuse the assigned worktree when continuing a task. For new maintenance work without an assigned branch, create a worktree from `main` using the host's branch naming convention. Keep commits scoped to one concern.
- Remove a worktree and prune its metadata after merge only when it contains no unmerged or uncommitted work that must be retained.
- Use `.tmp/` for disposable probes and logs; clean up your own scratch files when no longer needed. Keep resumable work until its task is complete.
- Keep local plans, status, reports, and knowledge under the gitignored `.mstar/` harness root. Runtime path conventions belong in [mstar-conventions](skills/mstar-conventions/SKILL.md).
- Run this repository's CLI from its own build, not from a global install: `bun run --cwd packages/cli build`, then invoke `packages/cli/dist/mstar-harness.js` (see `packages/cli/AGENTS.md`). A globally installed `mstar`/`mstar-harness` is the released package for other projects; linking this checkout globally makes other projects run unreleased code, and invoking the global copy here runs a released CLI against unreleased engine behavior.
- Tracked code and docs must not depend on local harness artifacts or disclose their provenance (real plan/iteration IDs, QC finding IDs, local merge SHAs, or acceptance labels). Describe the behavior; use synthetic IDs in fixtures and `{HARNESS_DIR}` or a `.mstarc` declaration for layout examples. This section documents the local layout and is the exception to that path-reference restriction.

## Pull request review and merge

Merge authorization is not restated here — it is owned by the policy in force:

- **Inside an iteration**, the compass `pr_merge_policy` decides, by the three-branch predicate in [pr-delivery.md § Merge authorization](skills/mstar-roles/references/project-manager/pr-delivery.md) (`reviewed-auto` / `reviewed-bot` / `owner-gated`). A missing `pr_merge_policy` is a STOP; it is never inferred. Head reconciliation is owned by [pr-delivery.md § Head reconciliation before merge](skills/mstar-roles/references/project-manager/pr-delivery.md).
- **A maintenance PR with no iteration policy** merges only when all hold: required CI green (advisory may be yellow); every attached review bot has concluded on the current head (`mstar-inspector review` = `success`, a scored bot meets its own gate, no blocking finding, and the review is posted for that head — an earlier review qualifies while the increment is empty, per [pr-delivery.md § Review paths and surfaces](skills/mstar-roles/references/project-manager/pr-delivery.md)); unresolved review threads are resolved, or each is waived in writing by name (thread id, or `path:line` + author) after the owner was shown the list, with `mstar pr merge-gate --pr <n>` passing on that head for a clean scan, or `--confirm <file>` passing for the waived set; and the human owner (operator/user, not the coordinator/PM seat) states the merge for that head.

"CI green and mergeable" alone is not authorization, and a bot stuck in `pending` is not a pass.

A change to an allowlist (`scripts/*.allowlist.json`), `scripts/skill-budgets.manifest.json`, or any other lint exemption is part of the change it exempts: a standalone widening is a defect. Drift-lint Guard 14 covers those two path shapes only, comparing JSON semantics: an added manifest entry or raised `maxLines`, and an added allowlist entry or raised `expectedCount`, require the exempted artifact to be in the same change set; removals and lowered ceilings stand alone; a present but unparseable gate file fails closed. Every other lint exemption is covered by this rule under human review.

A merge that landed without authorization is fixed forward in a follow-up PR — the direction may be right even when the process was not — and the PR says so. Revert only when the merged change itself is wrong.

## Where to edit

| Concern | Source |
| --- | --- |
| Runtime rules | `skills/mstar-*/`; find the owning topic through the [core index](skills/mstar-harness-core/SKILL.md) |
| Role behavior | `skills/mstar-roles/references/`; keep `agents/*.md` and `codex/agents/*.toml` shells thin |
| Commands and host behavior | `commands/` (entries), `packages/commands/` (implementations), `skills/mstar-host/` |
| Workflow engine | `packages/engine/` |
| CLI and install/link adapters | `packages/cli/`; follow its local `AGENTS.md` |
| Host plugins | `packages/opencode/`, `packages/opencode-v2/`, `packages/dsh/`, `packages/omp/`; follow their local `AGENTS.md` files |
| Judgment runtime | `packages/judgment/` |
| UI and design system | `packages/ui/`; the design is `design-system/prototype.html`, and root `DESIGN.md` summarizes it |
| Host hooks and rules | `hooks/` (runtime hooks), `rules/` (Cursor entry rules) |
| Plugin metadata | Host plugin/marketplace manifests; release surfaces are listed in `scripts/release-surfaces.ts` |
| Decision rationale that outlives the plan | `docs/adr/`; the contract is `skills/mstar-doc-corpus/references/adr.md`, while [its README](docs/adr/README.md) holds this repo's tree and gate |

Edit canonical sources, never the generated `harness-skills/` or `harness-agents/` mirrors that host packages emit through `bundle-assets` (they are gitignored build products and edits there are lost on regeneration); installed plugins resolve bundled assets from their package, not the consumer's working directory. OpenCode's primary `project-manager` shell lives in `packages/opencode/agents/`; shared `agents/` contains subagent shells.

## Skills and host consistency

- Change shared semantics first, then only the affected host adapters and docs. Keep supported hosts consistent; document necessary host differences at their owning adapter.
- Keep `SKILL.md` focused on the execution path and trigger contract; move detailed variants to `references/`. Do not embed repository maintenance manuals in runtime skills.
- For new skills or major rewrites, follow [mstar-skill-authoring](skills/mstar-skill-authoring/SKILL.md). Do not hard-code a maintainer's home-directory paths or require another host's tools, and preserve the [standalone contract](skills/mstar-harness-core/SKILL.md): external authoring tools are maintenance aids, not runtime load-order dependencies.
- Verify behavior-shaping changes with affected regressions, evaluations, or concrete before/after evidence. Explain the expected outcome improvement; wording preference alone is insufficient. Use `.cursor/skills/mstar-routing-eval/` for affected Cursor routing/gate regressions, and check changed references for stale paths.

## Documentation

- Keep `README.md` and `README_CN.md` short and executable: Install → Use (without/with iteration) → Workflow → Roles/skills. Prefer commands, tables, and links; put detailed installation and host explanations in `INSTALL.md`, `docs/`, or the owning skill.
- When changing paired docs, make the same minimal semantic update in each language, including the dsh README triplet. Update existing pairing hashes with `git hash-object` where recorded; do not retranslate whole documents for a small change. Update docs only where behavior or onboarding changes affect them, and verify changed commands, configuration examples, and links against their source.
- **`DESIGN.md` is a summary of `packages/ui/design-system/`, not a second source.** The prototype (`prototype.html`) is the design; `snapshot.json` is the machine-readable fixture derived from it; `DESIGN.md` states in prose what they establish. Keep them in step, in that order: change the prototype, run `bun run --cwd packages/ui snapshot:write`, then bring `DESIGN.md` in line. `check:snapshot` fails when the fixture lags the prototype; nothing fails when `DESIGN.md` lags both, so that direction is a review obligation. When a claim and the prototype disagree, the prototype wins — unless it is silent, in which case the decision and its reason belong in `DESIGN.md`.

## Verification and delivery

- **Run the CI lint gates before pushing** — they are cheap, and otherwise surface only as a red `lint-scripts-hooks`/`validate` job: `bun run lint:ascii-literals`, `bun run lint:hash-gates`, `bun run lint:refusal-quality`, `bun run lint:help-reachability`, plus `bun run validation:drift` and `bun run lint:dsh-contract` when the change touches skills, host surfaces or contracts. For every touched file under `packages/` or `scripts/`, also run the changed-line comment ratchet: `bun run cli:build`, then `node packages/cli/dist/mstar-harness.js lint <file> --diff-base "$(git merge-base <pr-base> HEAD)"`; new or edited comments must take a [comments.md](skills/mstar-coding-behavior/references/comments.md) §MUST shape. Changes to `scripts/` or `hooks/` also run their own `bun test scripts/...` / `bun test hooks/...` suites.
- Before repeating a fix, inspect relevant history for duplicate or rejected attempts. Keep changes appropriate to the harness; project-specific behavior belongs in a separate extension.
- Follow [core verification boundaries](skills/mstar-harness-core/SKILL.md#定向执行与验证边界): run checks mapped to the changed behavior and reuse still-valid evidence. Full local suites require explicit user authorization; CI owns routine full-suite coverage. For executable changes, run affected unit tests and scoped lint/type checks; for docs/policy changes, use targeted static checks and before/after evidence without manufacturing tests or claiming they prove model compliance.
- For `skills/**` changes, `bun run validation:drift` is the enforcement surface: per-file line ceilings live in `scripts/skill-budgets.manifest.json`, and the corpus rules it applies are stated in [mstar-skill-authoring](skills/mstar-skill-authoring/SKILL.md).
- Before delivery, review the diff for scope, accidental generated edits, local-artifact disclosures, and the required changelog fragment. Fix failures caused by the change; report unresolved failures or missing evidence precisely, and report what changed, why, actual verification results, and material limitations.

## Release Process

- Add one bilingual `.changes/unreleased/<slug>.md` fragment per logical change, following [the fragment format](.changes/README.md). Do not hand-edit assembled `CHANGELOG*` files or version surfaces.
- Prepare releases with `bun run release:prepare -- <version>` (or `-- --patch` / `-- --minor`) or the [Release prep workflow](.github/workflows/release-prep.yml). Validate with `bun run release:validate -- v<version>` and open a `release v<version>` PR.
- The [Release workflow](.github/workflows/release.yml) publishes, tags, and creates the GitHub Release after merge. Prereleases use the `alpha` dist-tag. Do not invent skipped tags or manually push tags as a publishing substitute. The workflow has no manual entry point — a publish job holding `id-token: write` must be reachable only through a merged release PR. A release that fails after some packages published is recovered by preparing the next patch release, which publishes the full package set at the new version (including the packages that already succeeded at the failed version).
- Version surfaces are authoritative in [scripts/release-surfaces.ts](scripts/release-surfaces.ts); release mechanics live in the scripts and workflows, not duplicated counts or historical recovery recipes here.
