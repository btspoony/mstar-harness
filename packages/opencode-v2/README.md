# @mstar-harness/opencode-v2

Morning Star harness plugin for [OpenCode](https://opencode.ai) 2.x, authored on the OpenCode V2 plugin SDK (`@opencode/plugin`, pinned to the exact `2.0.26` release).

This is the harness's second, independent host package. It projects the same canonical assets — `mstar-*` skills, role agents, iteration commands — and the same engine-backed runtime gates as [`@mstar-harness/opencode`](../opencode/README.md), which stays the entry for OpenCode 1.x hosts on the V1 plugin API (`@opencode-ai/plugin` 1.4.8). The two packages share no runtime entry: install the one that matches your host generation.

Development and asset bundling use **Bun >=1.4.0**. The published plugin is a `--target node` bundle for the OpenCode 2.x host process — a Node entry with a **Node >=24.18.0** floor (`node:sqlite`), not a second demand to install Bun on every OpenCode user machine. CLI shebang launch and this plugin entry are two entrypoints with two floors: this plugin is the Node one, the installer CLI below is the Bun-shebang one.

## Install

Add to `opencode.json` (global or project):

```json
{
  "plugins": ["@mstar-harness/opencode-v2@latest"]
}
```

Restart OpenCode.

Or use the generation-aware installer CLI:

```bash
npx @mstar-harness/cli init --target opencode --opencode-generation v2
```

That command executes the CLI's Bun-shebang bin, so it needs **Bun >=1.4.0** on PATH — `npx` fetches the package but does not supply the runtime. On a Node-only machine run the installed bundle under Node instead: `node node_modules/@mstar-harness/cli/dist/mstar-harness.js init --target opencode --opencode-generation v2`.

See [`INSTALL.md`](./INSTALL.md) for the full setup flow and the installer's write set.

## Generation selection

`mstar-harness init --target opencode` writes config only after resolving the generation, and `doctor --target opencode` resolves it before validating:

- **`--opencode-generation <v1|v2>` always wins.** `v2` selects this package; `v1` selects [`@mstar-harness/opencode`](../opencode/README.md).
- Without the flag, a real install probes the host binary (`opencode --version`, bounded timeout) and maps the parsed major: **≥ 2 → v2**, 1.x → v1.
- Probe failure — binary missing, timeout, or output not in the `opencode vMAJOR.MINOR.PATCH` form — **refuses the real install** (and the doctor run) with the failure mode and the `--opencode-generation` recovery. There is no silent v1 fallback.
- Under `--dry-run` no probe runs: the preview uses the explicit flag or the config markers, else it stays non-refusing with an explicit `generation: unresolved` annotation.
- Config markers are a **consistency guard only**: an array-valued plural `plugins` key (any entries, including an empty array) marks V2, while a singular `plugin` array holding an owned V1 slot marks V1. A disagreement with the resolved generation warns; it never selects.

## What you get

| Path in package | Contents |
|-----------------|----------|
| `harness-skills/` | `mstar-harness-core`, `mstar-iteration`, `mstar-sdd`, roles, phase/dispatch gates, … |
| `harness-agents/` | Role shells (`project-manager`, `fullstack-dev`, `qc-specialist`, …); the OpenCode-only primary-seat `project-manager` overlay is merged in at build |
| `harness-commands/` | `/iteration-start`, `/iteration-drive`, `/iteration-loop` |

The plugin resolves **only paths inside this package** — never `process.cwd()/skills` — so your app repo root does not affect harness loading. On the first user message it prepends the harness bootstrap to the outgoing model call (guarded by the `<IMPORTANT_FOR_HARNESS>` marker, deduplicated across continuations); `system` content is never touched and persisted session history is unchanged.

## Config surface (what `init` writes)

For the V2 generation, one `init` pass writes:

- **`plugins`** — the canonical `@mstar-harness/opencode-v2@latest` entry, appended after owned-slot dedupe. Owned slots are the V2 npm entries (string and `{package}` object forms), the V1 npm entries, and the legacy `morning-star@git+…` entries; every other entry keeps its position and shape.
- **`agents.<role>.model`** — only for model overrides you supplied (`--pm-model`, `--dev-models`, …): the plural `agents` key, other keys preserved.
- **`mcp.servers["morning-star"]`** — merged non-destructively with `{"type":"local","command":["npx","@mstar-harness/cli","mcp"]}`; an existing morning-star entry is never rewritten, and other servers and `mcp` keys survive.
- **`$schema`** — preserved when present, never invented: the pinned `2.0.26` schema tag publishes no V2 `$schema` id, so the installer writes none. The V1 `$schema` pin is untouched and V1-only.

Preservation guarantees: repeat initialization is idempotent; the other generation's key (`plugin` vs `plugins`) is never deleted or rewritten; unrelated plugin entries — **including V2 `{package, options}` objects, not just strings** — keep their positions and shapes.

## MCP server entry

[`mcp.json`](./mcp.json) ships the matching reference row for OpenCode's `mcp.servers` config. The installer merges that row into `opencode.json` as described above — this package has no runtime config hook, so the installer write set is the delivery path. `mstar-harness doctor --target opencode` reports the result (`aligned`, `mismatch`, or `unavailable`).

## Runtime gates: coverage and refusal

The V2 SDK types `execute.before` as a hook that **may fail with a typed `Tool.Error`**, so this package's gates refuse for real: the V1 package's warn-only limitation (no refusal channel) does not apply to the V2 entry.

Claimed coverage is exactly:

- **`write`** `{path, content}` and **`edit`** `{path, oldString, newString, replaceAll}` — authority-route classification first (direct `store.db`/WAL/SHM writes, retired registers, unreadable authority), then coordination-document validation. The `edit` branch validates the synthesized post-state when the literal replacement composes (a single hit, or `replaceAll`), falling back to the on-disk document otherwise (a non-existent target has nothing to validate).
- **`subagent`** dispatch — Assignment validation on `input.prompt`. The caller is the host-provided `event.agent` (readonly) and the spawn target is `input.agent`; neither is inferred from the other. Because V2 exposes the caller, the anti-recursion leg is **active** on this host (the V1 package skips it), and an empty/absent caller binding fails closed.
- **Authority-class refusals** (`store.direct-write-refused`, `project.register.retired`, `store.authority-unavailable`, `execution.direct-write-refused`) refuse unconditionally in both enforcement modes; document-validity violations follow the repo's enforcement axis (hard → typed refusal, soft → logged warning). A missing or malformed required input on a claimed seam is a typed refusal naming the field and the recovery, never a silent skip.

Explicit **non-claims**: **`patch`** (its `2.0.26` input shape is not contract-verified, so no interception or enforcement claim is made), and **`shell`** / Code Mode's `execute` / `opencode` / `browser` namespaces (arbitrary-execution surfaces outside structured-write interception — there is no arbitrary shell-write protection claim). The coverage statement is “any call that reaches `execute.before` with tool name `write`/`edit`/`subagent`”, and nothing broader.

## Runtime floors

- **Node >=24.18.0** — the OpenCode 2.x process runs the bundle; the engine store API uses in-process `node:sqlite` and is loaded lazily, so an engine without that surface still mounts the plugin while a store-backed check refuses with upgrade guidance.
- **Bun >=1.4.0** — monorepo `bundle-assets` / `bun build`, and the installer CLI's Bun shebang.

## Verification status

These claims are declaration- and source-grounded at the pinned SDK tag `2.0.26`, and the packaged artifact is exercised by a reproducible smoke (`npm pack` → temp-prefix install → a real Node child imports the installed entry and asserts the plugin id, the Effect lifecycle, the bundled agent/command/skill assets, a nested skill reference, and the engine metadata). **Installed-host behavior is not verified**: no OpenCode 2.x host run is claimed here.

## Docs

- [INSTALL.md](./INSTALL.md) — setup, generation selection, config example, upgrade/reload, V1 coexistence, troubleshooting
- [../opencode/README.md](../opencode/README.md) — the V1 package for OpenCode 1.x hosts
- [Monorepo README](https://github.com/btspoony/mstar-harness#readme) — cross-host overview
- [CHANGELOG.md](./CHANGELOG.md) — package release notes

## Development (this monorepo)

From the repository root:

```bash
bun install
bun run opencode-v2:bundle-assets   # syncs harness-skills/ + harness-agents/ + harness-commands/
bun run opencode-v2:build           # bundle-assets + bun build --target node → dist/mstar.js
```

Plugin entry: `packages/opencode-v2/src/entry.ts` → `dist/mstar.js`.

## License

MIT — see [LICENSE](https://github.com/btspoony/mstar-harness/blob/main/LICENSE).
