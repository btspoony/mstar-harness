# mstar-harness CLI Package Guide

This `packages/cli` directory hosts the standalone `@mstar-harness/cli` package (binary: `mstar-harness`).

## Scope

- Implement and maintain CLI-only behavior for installer/setup workflows.
- Keep root package focused on OpenCode plugin runtime entry.
- Avoid mixing plugin runtime logic into this package.

## Tech Stack

- Use Bun as the default development/runtime toolchain for this package.
- CLI source lives in `src/`.
- Built artifact for distribution is `dist/mstar-harness.js`.

## Commands

- `bun run dev` -> run CLI from source.
- `bun run build` -> build distributable CLI entry.
- `bun run check` -> quick help command smoke check.

## Safety

- Do not modify user secrets or credential files.
- For config writes, only touch target `opencode.json` chosen by user input.
