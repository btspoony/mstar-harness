# Cursor Plugin Pre-Release Checklist (Maintainers)

Use before publishing or sharing the Morning Star Cursor plugin from this repo.

## 1) Manifest sanity

- `name`, `version`, `description`, `license` are present in `.cursor-plugin/plugin.json`.
- `agents`, `skills`, `rules` use relative paths.
- `homepage` and `repository` point to valid URLs.

## 2) Component discovery

- Agent files are discoverable from `./agents/`.
- Morning Star skills are discoverable from `./skills/mstar-*/SKILL.md`.
- Cursor host skills are discoverable from `./skills-cursor/mstar-host/SKILL.md`.
- Plugin rules are discoverable from `./rules/*.mdc` (registered as `"rules": ["rules/"]` in `plugin.json`).
- Routing eval (maint only, not plugin runtime): `./.cursor/skills/mstar-routing-eval/`.

## 3) Smoke-test flow in Cursor

- Open a new chat with the local plugin loaded.
- Trigger a role-routed task (for example, PM-style routing).
- Confirm one `mstar-*` skill and host skill from `skills-cursor/` can load.
- Confirm one `./rules/*.mdc` rule is applied during execution.

## 4) Packaging guardrails

- Do not use absolute paths in `plugin.json`.
- Do not reference files outside this repository root.
- Ensure all referenced directories exist in the current branch.
