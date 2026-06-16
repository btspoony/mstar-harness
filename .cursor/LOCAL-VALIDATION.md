# Cursor Plugin Pre-Release Checklist (Maintainers)

Use before publishing or sharing the Morning Star Cursor plugin from this repo.

## 1) Manifest sanity

- `name`, `version`, `description`, `license` are present in `.cursor-plugin/plugin.json`.
- `agents`, `skills`, `rules` use relative paths.
- `homepage` and `repository` point to valid URLs.

## 2) Component discovery

- Agent files are discoverable from `./agents/`.
- Morning Star skills are discoverable from `./skills/mstar-*/SKILL.md`.
- Host skill is discoverable from `./skills/mstar-host/SKILL.md`.
- Plugin rules are discoverable from `./rules/*.mdc` (registered as `"rules": ["rules/"]` in `plugin.json`).
- Routing eval (maint only, not plugin runtime): `./.cursor/skills/mstar-routing-eval/`.

## 3) Smoke-test flow in Cursor

- Open a new chat with the local plugin loaded.
- Trigger a role-routed task (for example, PM-style routing).
- Confirm one `mstar-*` skill and `mstar-host` from `skills/` can load.
- Confirm one `./rules/*.mdc` rule is applied during execution.
- In Plan mode, create a Morning Star plan, click Build, and confirm the first Agent-mode step resumes PM/harness context before any product-code edit.

## 3b) Subagent registration smoke test

- After `mstar-harness init --target cursor`, run `Developer: Reload Window`.
- Open a new **Agent-mode** chat with the local plugin loaded.
- Confirm Task `subagent_type` includes Morning Star roles such as `fullstack-dev` and `qc-specialist`.
- If missing: verify `agents/*.md` use Cursor-first frontmatter; run `mstar-harness doctor --target cursor --scope global`; reload Cursor.

## 4) Packaging guardrails

- Do not use absolute paths in `plugin.json`.
- Do not reference files outside this repository root.
- Ensure all referenced directories exist in the current branch.
