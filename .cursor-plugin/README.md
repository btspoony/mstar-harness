# Morning Star Harness Cursor Plugin

This repository is packaged as a Cursor plugin via `.cursor-plugin/plugin.json`.

## Purpose

Provide Morning Star harness capabilities in Cursor with:

- Role agents from `agents/`
- Core and host skills from `skills/` (including unified `mstar-host`)
- Cursor rules from `rules/`

## Install / Use

Recommended:

1. `npx @mstar-harness/cli init --target cursor --scope global`
2. Restart Cursor or run `Developer: Reload Window`.
3. Start a new chat and invoke a Morning Star workflow (for example, PM routing or a role-specific task).

Manual install:

1. `git clone https://github.com/btspoony/mstar-harness.git ~/.mstar/harness`
2. `mkdir -p ~/.cursor/plugins/local`
3. `ln -s ~/.mstar/harness ~/.cursor/plugins/local/morning-star-harness`
4. Restart Cursor or run `Developer: Reload Window`.

After agent file changes, reload Cursor before smoke-testing Task `subagent_type` names.

## Component Coverage

- `agents`: `./agents/`
- `skills`: `./skills/`
- `rules`: `./rules/`

