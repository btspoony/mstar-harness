# Morning Star Harness Maintenance

This repository contains the Morning Star runtime skills, workflow engine, CLI, and host plugins. This file defines repository maintenance policy; runtime behavior belongs in `skills/mstar-*`.

## Working rules

- Read the affected source and direct contracts before editing. Fix the demonstrated problem or requested outcome with the smallest complete change; avoid speculative features, compatibility layers, and unrelated refactors.
- Keep each rule in its authoritative topic. Follow [harness core](skills/mstar-harness-core/SKILL.md) for runtime semantics and [roles](skills/mstar-roles/SKILL.md) for skill selection; do not duplicate their load matrices, gates, or role procedures here.
- Use tools actually available in the session. Continue authorized work through verification; ask only when a material decision or required authorization remains unresolved. Do not add a separate human approval gate for every diff.
- Respect existing assignments and write ownership. Preserve other contributors' changes; do not reset or clean their work.
- Do not edit user secrets or credential files. Changes to global host configuration or security-sensitive defaults require explicit user authorization.

## Git and local artifacts

- Develop in a task worktree under `.worktrees/`. Keep the primary checkout on `main`: skills and commands may be symlinked to it. Changes reach `main` through PRs; never make direct feature commits there.
- Reuse the assigned worktree when continuing a task. For new maintenance work without an assigned branch, create a worktree from `main` using the host's branch naming convention. Keep commits scoped to one concern.
- Remove a worktree and prune its metadata after merge only when it contains no unmerged or uncommitted work that must be retained.
- Use `.tmp/` for disposable probes and logs; clean up your own scratch files when no longer needed. Keep resumable work until its task is complete.
- Keep local plans, status, reports, and knowledge under the gitignored `.mstar/` harness root. Runtime path conventions belong in [mstar-conventions](skills/mstar-conventions/SKILL.md).
- Tracked code and docs must not depend on local harness artifacts or disclose their provenance (real plan/iteration IDs, QC finding IDs, local merge SHAs, or acceptance labels). Describe the behavior; use synthetic IDs in fixtures and `{HARNESS_DIR}` or a `.mstarc` declaration for layout examples. This section documents the local layout and is the exception to that path-reference restriction.

## Where to edit

| Concern | Source |
| --- | --- |
| Runtime rules | `skills/mstar-*/`; find the owning topic through the [core index](skills/mstar-harness-core/SKILL.md) |
| Role behavior | `skills/mstar-roles/references/`; keep `agents/` and `codex/agents/` shells thin |
| Commands and host behavior | `commands/`, `skills/mstar-host/` |
| Workflow engine | `packages/engine/` |
| Install/link adapters | `packages/cli/`; follow its local `AGENTS.md` |
| Host plugin implementation and packaging | `packages/opencode/`, `packages/dsh/`, `packages/omp/`; follow applicable local `AGENTS.md` files |
| Plugin metadata | Host plugin/marketplace manifests; release surfaces are listed in `scripts/release-surfaces.ts` |

Edit canonical sources, not generated `harness-skills/` or `harness-agents/` copies. Use the affected package's bundle command when validating packaged assets. OpenCode's primary `project-manager` shell lives in `packages/opencode/agents/`; shared `agents/` contains subagent shells. Installed plugins must resolve bundled assets from their package, not the consumer's working directory.

## Skills and host consistency

- Change shared semantics first, then only the affected host adapters and docs. Keep supported hosts consistent; document necessary host differences at their owning adapter.
- Keep `SKILL.md` focused on the execution path and trigger contract; move detailed variants to `references/`. Do not embed repository maintenance manuals in runtime skills.
- For new skills or major rewrites, follow [mstar-skill-authoring](skills/mstar-skill-authoring/SKILL.md) and use available `skill-creator` guidance from the session's skill catalog. Do not hard-code a maintainer's home-directory paths or require another host's tools.
- Preserve the [standalone contract](skills/mstar-harness-core/SKILL.md): external authoring tools are maintenance aids, not runtime load-order dependencies.
- Verify behavior-shaping changes with affected regressions, evaluations, or concrete before/after evidence. Explain the expected outcome improvement; wording preference alone is insufficient.
- Use `.cursor/skills/mstar-routing-eval/` for affected Cursor routing/gate regressions, not as a runtime dependency or a universal host check. Check changed references for stale paths.

## Documentation

- Keep `README.md` and `README_CN.md` short and executable: Install → Use (without/with iteration) → Workflow → Roles/skills. Prefer commands, tables, and links; put detailed installation and host explanations in `INSTALL.md`, `docs/`, or the owning skill.
- When changing paired docs, make the same minimal semantic update in each language, including the dsh README triplet. Update existing pairing hashes with `git hash-object` where recorded; do not retranslate whole documents for a small change.
- Update docs only where behavior or onboarding changes affect them. Verify changed commands, configuration examples, and links against their source.

## Verification and delivery

- Before repeating a fix, inspect relevant history for duplicate or rejected attempts. Keep changes appropriate to the harness; project-specific behavior belongs in a separate extension.
- Follow [core verification boundaries](skills/mstar-harness-core/SKILL.md#定向执行与验证边界): run checks mapped to the changed behavior and reuse still-valid evidence. Full local suites require explicit user authorization; CI owns routine full-suite coverage.
- For executable changes, run affected unit tests and relevant scoped lint/type checks. For docs/policy changes, use targeted static checks and before/after evidence; do not manufacture tests or claim static checks prove model compliance.
- Fix failures caused by the change. Report unresolved failures or missing evidence precisely; do not claim completion while required verification remains outstanding.
- Before delivery, review the diff for scope, accidental generated edits, local-artifact disclosures, and the required changelog fragment. Report what changed, why, actual verification results, and material limitations.

## Release Process

- Add one bilingual `.changes/unreleased/<slug>.md` fragment per logical change, following [the fragment format](.changes/README.md). Do not hand-edit assembled `CHANGELOG*` files or version surfaces.
- Prepare releases with `bun run release:prepare -- <version>` (or `-- --patch` / `-- --minor`) or the [Release prep workflow](.github/workflows/release-prep.yml). Validate with `bun run release:validate -- v<version>` and open a `release v<version>` PR.
- The [Release workflow](.github/workflows/release.yml) publishes, tags, and creates the GitHub Release after merge. Prereleases use the `alpha` dist-tag. Do not invent skipped tags or manually push tags as a publishing substitute.
- Version surfaces are authoritative in [scripts/release-surfaces.ts](scripts/release-surfaces.ts); release mechanics live in the scripts and workflows, not duplicated counts or historical recovery recipes here.
