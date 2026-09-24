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

## Command contract (hard requirement)

The CLI is the agent-facing contract; agents drive it from `--help` alone. Treat every point below as a **hard requirement** for any command addition or change, not a style preference:

- **Self-describing payloads.** A command taking `--file <path>` must let a caller construct the payload from the CLI alone: list the required and optional fields with their types in `--help`, or expose a machine-readable schema/example for that payload type. Naming only a TypeScript type (`Absolute CaptureInput JSON path`) is **not** sufficient.
- **Aggregated validation.** A refusal must report **every** missing or invalid field in one response. Failing one field per attempt is a defect: it turns a routine call into a guessing loop.
- **Help/implementation parity.** Every documented option must match what the implementation accepts, and every required option must be documented. Review a command's help text and its parser together, in the same change.
- **Regression coverage.** Add or update a check that fails when a payload-taking command stops being self-describing, or when validation stops aggregating.

Background: P0 issue `I-000198` (GitHub #284). An agent capturing three findings could not build a valid payload from the CLI and needed **six** refused invocations for one capture, learning exactly one required field per attempt.

## Safety

- Do not modify user secrets or credential files.
- For config writes, only touch the target-specific install/config file chosen by user input
  (`opencode.json`, Cursor plugin paths, Codex personal marketplace metadata, or Kimi plugin install notes).
- **Cursor plugin paths must be real git checkouts** — not symlinks. Cursor does not load symlinked plugin roots; see `INSTALL.md` § Install path layout.
