# mstar-harness CLI Guide

This guide documents the standalone `@mstar-harness/cli` package (command: `mstar-harness`) for OpenCode, Cursor, Codex, ZCode, omp, and dsh bootstrap. Kimi Code uses Kimi TUI `/plugins install` — see [INSTALL.md](../INSTALL.md#kimi).

The package installs two interchangeable binaries: `mstar-harness` (canonical) and the `mstar` short alias — both invoke the same CLI.

> **Caution**: `mstar` is a short alias and a **shared bin namespace** — an unrelated third-party npm package named `mstar` claims the same command name. The alias exists only where `@mstar-harness/cli` is installed: bare `npx mstar …` in an environment without the package resolves via the registry to that other tool, and globally co-installing both packages silently overwrites the `mstar` shim (last install wins). The canonical invocation name stays `mstar-harness` — prefer it in scripts and use the long name whenever a collision is possible.

## Fast Path

Use this sequence for the quickest user flow.

### OpenCode

1) Preview what will change (schema + plugin only; uses OpenCode default models):

- `npx @mstar-harness/cli init --target opencode --dry-run --yes`

2) Apply the setup:

- `npx @mstar-harness/cli init --target opencode --yes`

3) Verify the final config:

- `npx @mstar-harness/cli doctor --target opencode`

Optional advanced: pass `--pm-model` / `--*-models` flags to write explicit `agent.<role>.model` overrides (does **not** call `opencode models`).

### Cursor

1) Install plugin to project (default scope). The CLI maintains `~/.mstar/harness` and clones a **real directory** at `.cursor/plugins/morning-star-harness` (not a symlink — Cursor cannot load symlinked plugin roots):

- `npx @mstar-harness/cli init --target cursor`

2) Verify project install:

- `npx @mstar-harness/cli doctor --target cursor`

### Codex

The harness repo ships its own marketplace catalog at `.agents/plugins/marketplace.json` (name `mstar-repo`). The CLI registers the repo as a Codex git marketplace and copies Codex custom agent TOMLs as regular files from the maintained `~/.mstar/harness` checkout:

1) Register the repo marketplace + install agent files:

- `npx @mstar-harness/cli init --target codex --scope global`

2) Install from that marketplace:

- `codex plugin add morning-star-harness@mstar-repo`

3) Verify the marketplace registration and regular agent files:

- `npx @mstar-harness/cli doctor --target codex`

### Kimi

Kimi is **not** a CLI `--target`. Install via Kimi TUI:

```text
/plugins install https://github.com/btspoony/mstar-harness
/plugins reload
```

See [INSTALL.md](../INSTALL.md#kimi) and **`mstar-host`** → `references/kimi.md` for host behavior (`sessionStart.skill: pm`, `/morning-star-harness:iteration-*`, C5/C5b role-in-prompt).


### omp

1) Link the local harness checkout into omp plugins (user scope):

- `npx @mstar-harness/cli init --target omp --scope global`

2) Verify:

- `npx @mstar-harness/cli doctor --target omp`

Alternate without the CLI:

- `omp plugin install @mstar-harness/omp`
- or `omp plugin link ~/.mstar/harness`

See [INSTALL.md](../INSTALL.md#omp) and **`mstar-host`** → `references/omp.md` for host behavior (`/skill:pm`, filename `/iteration-*` commands, live-schema role `task.agent` preference + C5b skill load).


## Install

Use one of the following:

- `npx @mstar-harness/cli --help`
- `bunx @mstar-harness/cli --help`

Tip: If your network/npm mirror is slow, you can run the same commands with `bunx`.

## User Commands

### `mstar-harness init`

Interactive bootstrap:

- `npx @mstar-harness/cli init`
- `bunx @mstar-harness/cli init`

`--scope` defaults to `project` when omitted.

OpenCode non-interactive bootstrap (fast path — no model prompts):

- `npx @mstar-harness/cli init --yes --target opencode --scope project`

Dry-run preview (no file write):

- `npx @mstar-harness/cli init --dry-run --scope project --output .tmp/opencode.json --yes`

Optional role-model overrides (advanced; skips live model discovery):

- `npx @mstar-harness/cli init --yes --target opencode --pm-model openai/gpt-5.5 --strategic-models openai/gpt-5.5 --dev-models openai/gpt-5.3-codex --qc-models openai/gpt-5.5,openai/gpt-5.4,openai/gpt-5.3-codex --other-models openai/gpt-5.5`

After a successful init, the CLI auto-installs the **matching-version** `@mstar-harness/cli` globally (`npm i -g @mstar-harness/cli@<same version>`) so the `mstar-harness` binary lands on PATH for engine-check commands. The install is skipped when the version on PATH already matches, and it is fail-soft: if npm cannot write the global prefix, init still succeeds and prints a doctor hint. Pass `--no-global-cli` to skip the global install; `--dry-run` prints the would-run `npm i -g` command without executing it.

Cursor install:

- Global install (git checkout at `~/.cursor/plugins/local/morning-star-harness`; shared Codex/OpenCode checkout at `~/.mstar/harness`):
  - `npx @mstar-harness/cli init --target cursor --scope global`
- Project install (git checkout at `.cursor/plugins/morning-star-harness`; the CLI adds it to `.gitignore`):
  - `npx @mstar-harness/cli init --target cursor --scope project`

Codex install:

- Repo-bundled marketplace (`.agents/plugins/marketplace.json`, name `mstar-repo`) — `init` registers it once via `codex plugin marketplace add https://github.com/btspoony/mstar-harness.git --ref main` (idempotent; refresh snapshots with `codex plugin marketplace upgrade`):
  - Global: `npx @mstar-harness/cli init --target codex --scope global`
  - Project: `npx @mstar-harness/cli init --target codex --scope project`
- Then install the plugin:
  - `codex plugin add morning-star-harness@mstar-repo`
- A pre-existing legacy `personal` marketplace entry is surfaced as a `doctor` note with migration steps (remove the entry, install from `mstar-repo`).
- Runtime host behavior after install:
  - `/pm` enters the shared PM flow.
  - Codex custom agents are copied from `~/.mstar/harness/codex/agents/*.toml` as regular files; see [refresh and migration](#codex-agent-files).
  - **Project scope only:** `iteration-start`, `iteration-drive`, and `iteration-loop` are installed as project-local skills under `.agents/skills/<name>/SKILL.md` (symlinked to `~/.mstar/harness/commands/<name>.md`); the CLI gitignores those paths.
  - **Global scope:** iteration skills are **not** installed (avoids polluting other projects); `init` prints a warning — re-run with `--scope project` to enable them.
  - Codex-specific clarify, dispatch, sandbox, and tool-discovery rules live in **`mstar-host`** → `references/codex.md`.

Kimi: not a CLI target — use `/plugins install` in Kimi TUI (see [INSTALL.md](../INSTALL.md#kimi)).

### dsh (DeepSeek Harness)

`init --target dsh` installs the full dsh capability in one command — the `@mstar-harness/dsh` plugin **plus** the optional `dsh-llm-fallbacks` role-configuration plugin:

- `npx @mstar-harness/cli init --target dsh`
- `npx @mstar-harness/cli doctor --target dsh`

The CLI runs **two independent** `dsh plugin --profile web add` calls (mstar first, then `dsh-llm-fallbacks`) — the two-command install contract, never folded into a patch file. Re-running is idempotent (already-installed rows are skipped, exit 0), with one version-aware exception: a `dsh-llm-fallbacks` row installed at a version other than the pin is re-added at the pinned spec (registry install + profile write; a failed re-add exits non-zero, and a local `link:`/`file:` fallbacks checkout is replaced — `--no-fallbacks` leaves it untouched); `--dry-run` previews the would-run commands without probing installed state or executing anything.

Skip the `dsh-llm-fallbacks` row (`--no-fallbacks` is a dsh-target-only flag — ignored for other targets):

- `npx @mstar-harness/cli init --target dsh --no-fallbacks`

Or run the two plugin-manager commands directly (the same contract the CLI executes):

```sh
dsh plugin --profile web add @mstar-harness/dsh
dsh plugin --profile web add dsh-llm-fallbacks
# or, from a local checkout:
cd <repo>/packages/dsh && dsh plugin --profile web add .
```
`dsh web` then boots the harness: in-process engine gates (status/dispatch/lease/worktree/seams), the bundled `mstar-*` skills mount, and the bundled slash commands (`/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/codebase-audit`, `/amazing-pr-review`). Host behavior (tools, gates, enforcement, PM dispatch) → **`mstar-host`** → `references/dsh.md`; package docs → [`packages/dsh/README.md`](../packages/dsh/README.md).

#### Headless profile usage

The dsh target also works with the **headless** profile — the one-shot, no-GUI/no-port mode (`dsh --profile headless "<task>"`): one task, the final assistant message on stdout, exit 0 on completion / 1 on failure. The plugin install is the same command pointed at the headless profile:

```sh
dsh plugin --profile headless add @mstar-harness/dsh
dsh --profile headless --dump-config   # verify the mstar row joined the layer stack
```

Every harness capability rides a `dsh-base` seam that headless inherits (gates, skill mount, catalog, system-prompt injection, the 7 `mstar_*` tools), so mstar runs fully in a one-shot run. Always launch from the repo working directory — the runner writes `meta.cwd = process.cwd()` and the harness-dir probe starts there.

**Caveats when using handles (background children) in headless** — the one-shot runner's completion contract is `whenIdle()` on the foreground agent, and background subagent handles do NOT hold the process open:

- `run_in_background: true` dispatches return a task id immediately and the runner treats the agent as idle once the foreground turn ends — the process exits while the children are still running (verified on dsh 0.1.0-rc.6: a background child's settlement notice lands in a turn that never executes). Exit 0 does not imply background children finished.
- Foreground subagent dispatch works end to end and is the reliable one-shot pattern; parallelism is still available inside a turn by dispatching N children in one message and collecting all of them via `tool-subagent-control` (list/`send`) BEFORE the final message.
- If you need fire-and-forget children, make the prompt require the agent to wait for every settlement and fold all results into the final message; otherwise run separate headless invocations per job and orchestrate from your script/cron.
- Leaf subagents must return their completion report in the closing message (not the `report` tool) — the report tool routes into the parent's next-step queue, which strands when the parent's turn has ended (the dsh leaf-delivery discipline, `mstar-host` → `references/dsh.md`).

### `mstar-harness doctor`

Check an existing config:

- `npx @mstar-harness/cli doctor --target opencode --scope project`
- `npx @mstar-harness/cli doctor --output ./opencode.json`
- `npx @mstar-harness/cli doctor --target cursor --scope global`
- `npx @mstar-harness/cli doctor --target cursor --scope project`
- `npx @mstar-harness/cli doctor --target codex`
- `npx @mstar-harness/cli doctor --target dsh`

If validation fails, `doctor` exits with a non-zero status code. For the dsh target, each plugin row is reported as `uninstalled` / `disabled` / `mounted` / `drifted`; rows that are uninstalled or disabled are issues (exit 1), and so is a `drifted` fallbacks row (profile install ≠ the pinned version — re-run `init --target dsh` to repair), `mounted` is healthy.

`doctor` also prints a non-fatal CLI-on-PATH note for every target — `mstar-harness` missing, present with a different version, or present and matching — without affecting the exit code.

### `mstar-harness plugin validate`

Validate a plugin package against the [Agent Plugins v1.0.0](https://agent-plugins.org/specification) portable format. The root `plugin.json` is checked against the closed manifest schema (required `$schema` and `name`, metadata types, plugin name rules, `extensions`), `mcp.json` per §7.2.1 if present (closed `$schema` + `mcpServers`, stdio/streamable-http/sse server variants, `env`/`cwd`/`url`/`headers` rules), and `skills/` discovery per §6.1 (immediate child directories with `SKILL.md`; frontmatter `name` must equal the directory name and `description` must be non-empty). No schemas are fetched at runtime. Without `--root`, the command starts at the project root and walks up to the nearest ancestor containing `plugin.json`; use `--root` for an unambiguous target.

- `npx @mstar-harness/cli plugin validate`
- `npx @mstar-harness/cli plugin validate --root /path/to/plugin`

Exit codes:

- `0` — conformant: prints `OK <root>: Agent Plugins v1.0.0 conformant`
- `1` — non-conformant: prints one error line per finding, prefixed with `plugin.json:` / `mcp.json:` / `skills:`

Non-fatal findings are reported separately: an unknown top-level field, a non-object `extensions` field, or a non-object `extensions.<namespace>` entry is reported and ignored (validation continues), and a `skills/` child directory without `SKILL.md` prints a yellow warning without failing validation. Non-conforming skills are skipped the same way (§7.1): a `SKILL.md` with missing or invalid frontmatter, a `name` that does not match its directory or violates Agent Skills name rules, or a missing `description` prints a `skills:` warning and that skill is skipped while validation of the remaining components continues.

### `mstar-harness roles validate`

Maintainer/dev check for the mstar-roles skill layout (the engine check cited in the `mstar-roles` skill): validates the role mapping / parameter tables in `skills/mstar-roles/SKILL.md` against the on-disk `references/*.md` files, and lints the load-order declarations across every sibling `mstar-*` skill. A thin mirror of the engine `validateRoleMapping` + `lintLoadOrder` checks (unreadable sibling `SKILL.md` files are skipped best-effort).

- `npx @mstar-harness/cli roles validate`
- `npx @mstar-harness/cli roles validate --roles-dir skills/mstar-roles --skills-dir skills`

Without flags, `--roles-dir` defaults to `skills/mstar-roles` and `--skills-dir` to its parent (`skills`), both resolved against the project root.

Exit codes:

- `0` — OK: prints `roles validate (mapping): OK` and `roles validate (load order): OK`, then the summary `roles validate: OK` with the violation, sibling-skill-scanned, and load-order-checked counts (the load-order count excludes `mstar-harness-core`, exempt by design)
- `1` — violations: prints a FAIL header plus one violation row per mapping / load-order violation on stderr (same stream split as the other `printChecklist` commands); the `roles validate: FAIL (N violations, …)` summary line stays on stdout

### `mstar-harness persist`

Persist one JSON coordination doc through the pluggable **ArtifactStore** (engine `@mstar-harness/engine` — `ArtifactStore` / `ArtifactKind` / `createFsStore` / `setArtifactStore` / `getArtifactStore` / `loadStoreModule`). The default `FsStore` maps kinds to the existing `{HARNESS_DIR}` paths and keeps the atomic temp+rename write semantics; integrations can mount their own store in-process (`setArtifactStore`) or per-command via `--store` / `MSTAR_STORE_MODULE`.

- `mstar-harness persist <kind> --key <key> [--file <path>|--stdin] [--store <module>] [--schema <id>]`
- `mstar-harness persist status|snapshot|residuals --key <key> --expect-version <absent|sha256:<hex>> [--file <path>|--stdin] [--session <absolute-coordinator-envelope>] [--store <module>]`
- `mstar-harness persist get <kind> --key <key> [--validate] [--versioned] [--store <module>]`
- `mstar-harness persist list <kind> [--store <module>]`
- `mstar-harness persist delete <kind> --key <key> [--store <module>]`

`<kind>` is one of `status` | `snapshot` | `residuals` | `review` | `json` (an unknown kind is a usage error, exit 2).

Payload source: `--file <path>` reads a JSON file; `--stdin` (or no flag) reads stdin; the two flags are mutually exclusive. `--key` is required: `status` always uses the key `root`; `json` takes an absolute file path (relative or `..`-containing keys are rejected); the other kinds take a stable id (workflow id, project id, or review id). `--schema <id>` optionally records a schema id (e.g. `mstar.review/v1`) on the artifact doc — stored only by store modules that persist it; the default `FsStore` rejects it (exit 1, nothing written).

Validators run before put: `status` / `snapshot` / `residuals` payloads are checked with the existing `validateStatusV2` / `validateWorkflowSnapshot` / `validateProjectRegister` and an invalid document is refused (exit 1, nothing written). `review` payloads must be a valid `mstar.review/v1` envelope (`validateMstarReviewV1` — harness verdicts `ship it` / `needs fixes` / `blocked` and merge classes `must-fix` / `should-fix` / `nit`; inspector M1 vocab such as `approve` / `critical` is rejected with `review.inspector-vocab`); `json` is an escape hatch.

Store selection: `--store <module>` wins over `MSTAR_STORE_MODULE`; with neither, the default `FsStore` resolves the harness dir from the cwd / `MSTAR_HARNESS_DIR`. The module is a filesystem path to an ESM/CJS file exporting `createArtifactStore()`, a default factory, or a default store object with `put()` + `get()` functions — **filesystem paths only**: empty values and any URI scheme (`http:`, `https:`, `file:`, `data:`, `node:`, …) are rejected before `import()` (no remote loader).

Default `FsStore` path table:

| kind | path |
|------|------|
| `status` | `{HARNESS_DIR}/status.json` (key must be `root`) |
| `snapshot` | `{WORKFLOW_DIR}/<key>/snapshot.json` |
| `residuals` | `{PROJECT_DIR}/<key>/residuals.json` |
| `review` | plan-shaped key (`^[0-9]{8}-[a-z0-9-]+$`) → `{HARNESS_DIR}/sdd/<key>/review/report.json`; other keys → `{HARNESS_DIR}/sdd/_reviews/<key>.json` |
| `json` | the absolute `key` path itself |

`persist get` prints the stored payload JSON (pretty-printed) on stdout and exits 0; a missing document exits 1 (`persist get <kind>/<key>: no stored document` on stderr). Stdout is payload JSON only — notes and violations never mix into it, so agents can pipe the output. With `--validate`, the same per-kind validator as the put gate runs on the fetched payload (no second validator): a valid document exits 0 with the payload on stdout and `validation: ok` on stderr; `json` accepts `--validate` as a parse-only no-op (`json: parse-only` on stderr); an invalid document exits 1 with stdout empty and the same violations list as put on stderr. FsStore persists payloads verbatim; integrity checks live at the write gate and at `persist get --validate`.

`persist get --versioned` reads through the engine's **coordinated artifact port** and prints `{payload,version}` instead of the bare payload: `version` is the `sha256:<64 lowercase hex>` digest of the exact bytes read, or the literal `"absent"` when the document does not exist (payload `null` there) — the precondition token a first coordinated write needs. It requires the active local `FsStore`; an injected `--store` / `MSTAR_STORE_MODULE` module is refused (`coordination.local-store-required`, exit 1) because no same-host CAS is promised on a pluggable module.

**Protected-writer boundary.** `status`, `snapshot` and `residuals` are coordination documents: their bytes are written by the engine's locked coordination writers, so the `FsStore` refuses a bare `put`/`delete` on them (and on any `json` alias whose canonical target is one of those files) with `coordination.direct-write-refused` (exit 1, nothing written). This applies to `persist <kind>` and `persist delete`; `mstar status workflow-close` is the lifecycle route for a finished workflow, not `persist delete`.

`persist list` prints the stored keys only — one per line, ascending, with **no header** (the kind is already the argv; pipe-friendly). An empty kind prints nothing and exits 0. Enumeration reports what exists: a missing backing file or directory yields an empty list, and every listed key round-trips through `persist get` — `status` lists `root` iff `{HARNESS_DIR}/status.json` exists; `review` is the union of `{HARNESS_DIR}/sdd/_reviews/*.json` keys and plan-shaped `{HARNESS_DIR}/sdd/<key>/review/report.json` directories. `json` keys are absolute paths and cannot be listed — a usage error (exit 2) raised before enumeration.

`persist delete` removes the stored document and prints `deleted <kind>/<key>`. Deleting an absent document is an idempotent no-op (same output, exit 0) and there is no confirmation prompt. It keeps that contract for the unprotected kinds (`review`, unrelated `json`); the protected kinds above refuse instead (`coordination.direct-write-refused`), so an accidental `persist delete status` can never drop the root register.

**Coordinated replacement.** The versioned face for those kinds is `persist <kind> --expect-version <version>`, where `<version>` is exactly the token `persist get --versioned` returned — `absent` for a document that does not exist yet, else its `sha256:<64 hex>` digest. `--expect-version` is **required** for a protected kind (a bare `persist status` is refused, exit 2) and never replaces the bare `put` path silently; the engine's locked writer owns the bytes, so the CLI never calls `put` on those targets. A missing token refuses `coordination.expected-version-required`, a token that no longer matches refuses `coordination.version-conflict` (someone wrote in between — the write is lost, not merged), and an injected `--store` / `MSTAR_STORE_MODULE` module refuses `coordination.local-store-required` (no same-host CAS); every refusal leaves the authoritative bytes untouched. A coordinated `snapshot` replacement additionally requires `--session <absolute-coordinator-envelope>`: replacing the workflow snapshot is a coordinator write (`coordination.session-role` for a plan session, `--session must be an absolute path` for a relative one).

All three faces go through the same `--store` / `MSTAR_STORE_MODULE` injection path as put/get. An injected store without the optional `list` or `delete` member is a usage error (exit 2, probed before the call) — never a TypeError.

Exit codes (binding):

| Code | When |
|------|------|
| `0` | put OK (`persist <kind>/<key>: OK`); get printed the payload (with or without `--validate`); get `--versioned` printed `{payload,version}` (a missing document is `version: "absent"`, payload `null`); delete succeeded or no-op; list printed keys (including none) |
| `1` | get miss; get `--validate` invalid; put invalid payload; put payload file missing / not valid JSON; stored file unparseable JSON on get; FsStore `doc.schema` rejection; store-module load failure; harness dir not found; protected-write refusal on a `put`/`delete` of a coordination document (`status` / `snapshot` / `residuals` or a `json` alias of one) — `coordination.direct-write-refused`; `--versioned` on an injected store module — `coordination.local-store-required`; coordinated replacement refusals — `coordination.expected-version-required` (no `--expect-version`), `coordination.version-conflict` (stale token), `coordination.session-role` / a snapshot replacement without `--session`, `coordination.local-store-required` (injected store) |
| `2` | usage: unknown kind; missing `--key`; missing `--expect-version` on a protected kind; `--expect-version` on `review` / `json`; `--session` that is not an absolute path; `--file` + `--stdin` together; `persist list json`; injected store missing `list` / `delete` |

#### Persist a review envelope

`kind: review` stores a validated `mstar.review/v1` envelope — the machine-readable review document that `pr-deep-review` / `amazing-pr-review` Stage 3 must persist after synthesis (the Markdown report is the optional human copy, not a substitute). Plan-shaped keys (`^[0-9]{8}-[a-z0-9-]+$`) land at `{HARNESS_DIR}/sdd/<key>/review/report.json`; other keys (PR ids, review ids) at `{HARNESS_DIR}/sdd/_reviews/<key>.json`.

```sh
mstar-harness persist review --key 20991231-example-review-json --stdin <<'JSON'
{
  "schema": "mstar.review/v1",
  "verdict": "needs fixes",
  "summary_md": "## Verdict: needs fixes · 85%\n\nmust-fix=0 should-fix=1 nit=0 unverified=0\n\n- should-fix: Retry loop swallows the last error",
  "tally": {
    "verdict": "needs fixes",
    "scorePct": 85,
    "tally": { "mustFix": 0, "shouldFix": 1, "nit": 0, "unverified": 0 },
    "chatHeader": "needs fixes · 85%\nmust-fix=0 should-fix=1 nit=0 unverified=0"
  },
  "findings": [
    {
      "mergeClass": "should-fix",
      "category": "correctness",
      "file_path": "src/retry.ts",
      "line_start": 12,
      "line_end": 18,
      "title": "Retry loop swallows the last error",
      "body": "The final attempt's error is discarded before the fallback path."
    }
  ],
  "target": { "owner": "acme", "repo": "widget", "pr": 134, "head_sha": "abc1234" }
}
JSON
```

`persist review/<key>: OK` on success; `persist get review --key <key>` prints the stored envelope. An invalid envelope is refused before any write — e.g. inspector M1 vocab `"verdict": "approve"` fails with `refusing to persist invalid review document: [high] review.inspector-vocab: ...` (exit 1), a `tally.verdict` that disagrees with the top-level `verdict` fails with `review.verdict-tally-mismatch`, and a provided `tally` that is not the full `computePrTally` shape (missing `scorePct`, counts, or `chatHeader`; wrong types; unknown verdict) fails with `review.tally-malformed`.

### `mstar-harness plan`

Scoped plan coordination: one workflow snapshot stays the process authority, the engine owns every scope / ownership / revision / transition / Git verdict under the same-host write lock, and this verb family is the thin transport for it. In: `/iteration-drive --assignment <path>` / `--workflow <id> --plan <id>`; the optional resume form is below.

Session identity is never a flag: `--session <absolute-json>` names an engine-generated envelope, and the engine re-checks it against the snapshot inside the lock. There is no `--force`, no holder/role input, no takeover and no lease-release verb.

```text
mstar plan bind --coordinator --workflow <id> [--harness <absolute-path>] [--json]
mstar plan bind --assignment <absolute-md-path> [--json]
mstar plan bind --workflow <id> --plan <id> [--harness <absolute-path>] [--json]
mstar plan bind --resume <absolute-session-json-path> [--json]
mstar plan show --session <absolute-session-json-path> [--plan <id>] [--json]
mstar plan prepare --session <coordinator-session> --plan <id> --assignment <absolute-md-path> --expect <revision> [--json]
mstar plan progress --session <plan-session> --file <absolute-json-path> --expect <revision> [--json]
mstar plan residual-add --session <plan-session> --file <absolute-json-path> --expect <revision> --expect-register <version> [--json]
mstar plan residual-close --session <plan-session> --entry <id> --note <text> --expect <revision> --expect-register <version> [--json]
mstar plan handoff --session <plan-session> --file <absolute-json-path> --expect <revision> [--json]
mstar plan accept --session <coordinator-session> --plan <id> --handoff <id> --expect <revision> [--json]
mstar plan return --session <coordinator-session> --plan <id> --handoff <id> --reason <text> --expect <revision> [--json]
mstar plan integration-start --session <coordinator-session> --plan <id> --handoff <id> --expect <revision> [--json]
mstar plan integration-accept --session <coordinator-session> --plan <id> --handoff <id> --expect <revision> [--json]
mstar plan complete --session <coordinator-session> --plan <id> --handoff <id> --expect <revision> [--json]
mstar plan reconcile --session <coordinator-session> --plan <id> --handoff <id> --expect <revision> [--json]
```

`--expect` is the row's `coordination.revision` from `show` (`0` while a row is not yet coordinated), never the snapshot schema version or a date; `--expect-register` is the `register_version` from `show` — the literal `absent` for a register that does not exist yet, else the exact `sha256:<64 lowercase hex>` token. `bind` is the only verb without `--expect`: it reads, checks and claims atomically against current ownership.

Two address forms reach the same prepared row: the pinned Assignment (`--assignment`) and the `--workflow/--plan` pair (which reads the row's registered Assignment path). A second fresh claim of the same row fails with `coordination.duplicate-holder` naming the live session; `bind --resume <session>` reports the current context read-only and never reacquires a released lease. `prepare` (coordinator) registers the reviewed Assignment and releases that plan's dependencies.

`--handoff <id>` is mandatory on the six coordinator transitions and must be the row's **live** handoff id — the one `plan handoff` minted and `plan show --json` reports. The CLI checks the flag against the row before calling the engine and refuses a *different* live id with `coordination.handoff-mismatch` (exit 1, nothing written); the engine re-checks the handoff inside the lock, so the row stays the authority and the flag can never invent one.

JSON success is `{ok:true, operation, workflow_id, plan_id?, revision?, snapshot_version?, session_file, session_id, role, handoff_id?, state?, outcome?}`; `show` additionally returns `register_version`, `scope`, `row`, `allowed_operations` and, once a handoff exists, the row's live `handoff_id` with its `state` and `attempt`. JSON failure is `{ok:false, operation, code, message, workflow_id?, plan_id?, holder?, path?, expected?, actual?}`. JSON goes to stdout with no color or banner; in human mode stdout stays empty and the summary goes to stderr.

Exit codes (binding):

| Code | When |
|------|------|
| `0` | operation succeeded (including an idempotent no-op and a read-only resume) |
| `1` | engine refusal: scope / path / identity / session mismatch, duplicate holder, stale revision or register version, invalid transition, missing or stale evidence, Git proof, lock, store — always with a stable `coordination.*` `code` and no change to authoritative bytes |
| `2` | usage: missing or mixed address forms, unknown flag, non-numeric `--expect`, an `--expect-register` that is neither `absent` nor a version token, a relative path where an absolute one is required, or an unreadable/unparseable payload file |

Worked example (synthetic ids; a plan session drives its own row, the coordinator drives the lifecycle):

```sh
# 1. Coordinator bootstrap: main worktree (or the recorded integration worktree) only.
mstar plan bind --coordinator --workflow wf-demo --json
# → {"ok":true,"operation":"bind","workflow_id":"wf-demo","role":"coordinator",...,"session_file":"…/sessions/<uuid>.json","outcome":"bound"}

# 2. Register the reviewed Assignment for one plan (revision 0 = not yet coordinated).
mstar plan prepare --session …/sessions/<coordinator>.json --plan plan-a \
  --assignment /control/.mstar/sdd/plan-a/assignment.md --expect 0 --json
# → {"ok":true,"operation":"prepare","revision":1,…,"outcome":"prepared"}

# 3. Bind the plan session and report its scope + allowed operations.
mstar plan bind --workflow wf-demo --plan plan-a --json
mstar plan show --session …/sessions/<plan>.json --json
# → {"ok":true,"operation":"show","plan_id":"plan-a","revision":1,"snapshot_version":"sha256:…",
#    "register_version":"absent","scope":{…},"allowed_operations":[…,"progress","handoff"]}

# 4. Mutate only this row (progress + this plan's register bucket).
mstar plan progress --session …/sessions/<plan>.json --file ./progress.json --expect 1 --json
mstar plan residual-add --session …/sessions/<plan>.json --file ./entries.json --expect 2 --expect-register absent --json
```

The coordinator half of the lifecycle — `handoff` (plan side, leaves the row `InReview`), then `accept` (ownership transfer, not integration acceptance) → `integration-start` (reads the clean recorded integration checkout, refuses any foreign merge lease, and records the current integration HEAD as `base_sha` plus the immutable source pin) → the coordinator's own explicit pinned `git merge --no-ff --no-edit <source-sha>` in that recorded integration worktree → `integration-accept` → `complete`, with `reconcile` as the explicit crash path and `return` for a failed attempt — transports the same A2 shape. The attempt is recorded and pinned **before** Git runs — that is what makes a crash mid-merge reconcilable, and why a retried `integration-start` never moves `base_sha`. State verbs never run the merge themselves.

### `mstar-harness workflow`

The **guarded Prepare amendment** transport: one coordinator envelope, one engine call, and the same argument/failure protocol as `plan` (success exit 0, refusal exit 1 with the JSON failure object, usage exit 2). It is the only lawful way to register an approved scope expansion on an already-created workflow — not a scheduler, not a general snapshot replacement. When it is admissible, what it may change and the byte-version contract → **`mstar-artifacts`** `references/status-and-residuals.md`「Prepare workflow amendment」.

Session identity is never a flag: `--session <absolute-json>` names the **coordinator** envelope created by `mstar plan bind --coordinator --workflow <id>`, and it is the only address — the workflow id and harness root are read from the envelope, and no caller-supplied root or id retargets them.

```text
mstar workflow show-prepare --session <absolute-coordinator-json-path> [--json]
mstar workflow amend-prepare --session <absolute-coordinator-json-path> \
  --expect-snapshot <sha256> --expect-compass <sha256> --input <absolute-patch-json-path> [--json]
```

`show-prepare` is read-only (no lock, no write) and returns the two CAS tokens plus the admission verdict: an inadmissible *lifecycle state* is reported as `allowed:false` with one `<reason>: <message>` line per blocker, not as an error, so a workflow can be inspected before deciding to amend it. `amend-prepare` requires **both** tokens — the raw-byte versions of the snapshot and of the workflow's reviewed compass Markdown — even on the first amendment. Each is `sha256:<64 lowercase hex>` (the bare 64-hex form is also accepted) and is a **byte version**, never a `plan` row `coordination.revision`.

Patch payload (`--input`; `{PLAN_DIR}` / `{HARNESS_DIR}` / `{ITERATION_DIR}` stand for the resolved absolute paths):

```json
{
  "mainWorktreeBranch": "<the main worktree's branch>",
  "appendPlans": [
    {
      "id": "<new-plan-id>",
      "title": "<title>",
      "file": "{PLAN_DIR}/<new-plan-id>.md",
      "metadata": {
        "primary_spec": "{HARNESS_DIR}/specs/<spec>.md",
        "spec_refs": ["{HARNESS_DIR}/specs/<spec>.md"],
        "iteration_compass": "{ITERATION_DIR}/<workflow-id>/delivery-compass.md",
        "iteration_refs": ["{ITERATION_DIR}/<workflow-id>/delivery-compass.md"],
        "working_branch": "<feature branch>",
        "spec_integration_branch": "<snapshot branch.integration>",
        "merge_target": "<snapshot branch.integration>"
      }
    }
  ],
  "integrationWorktreePath": "<absolute integration checkout>",
  "planParallelism": "serial"
}
```

- `mainWorktreeBranch` and `appendPlans` are required; `integrationWorktreePath` and `planParallelism` (`serial` | `parallel`) are optional. Any other key refuses, and a patch that appends nothing and changes neither the recorded checkout nor the parallelism refuses as a no-op.
- Each appended row is constructed by the engine — `Todo`, progress 0, `project-manager`, current creation timestamp — so no runtime row field travels in the patch. Its plan markdown must declare `plan_id`, `Main worktree branch` and `Working branch` headers agreeing with the patch metadata and the branch this call declares.
- Effect: the approved rows are appended and the reviewed integration checkout / `plan_parallelism` are recorded. Every existing row and unknown field survives **by value**; only the appended rows, those two requested projections and the snapshot `updated_at` change — with the single engine-owned exception that the `mstar-artifacts` `references/status-and-residuals.md`「Prepare workflow amendment」section names. No branch or worktree is created, switched, fetched or cleaned.

Refusals (exit 1, mutation-free — the protected snapshot, root register, other workflows and the compass stay byte-identical):

| `code` | When |
|--------|------|
| `coordination.prepare-amendment.stale` | either byte version no longer matches the bytes inspected inside the lock (also: the compass changed while the amendment was being applied) |
| `coordination.prepare-amendment.not-prepare` | the workflow is not `running` in `phase-1-prepare`, or its root register entry is not `running` — `paused` is active in the root register but is not admissible here, and the refusal carries the entry's observed status |
| `coordination.prepare-amendment.execution-started` | execution ownership exists: a non-`Todo` row, row progress ≠ 0, a row `execution_lease`, a row `coordination` block, or a top-level `integration_merge_lease` |
| `coordination.prepare-amendment.duplicate-plan` | an appended id is already a row of this workflow, or appears twice in one patch |
| `coordination.prepare-amendment.invalid-patch` | unknown or missing patch keys, an unknown `planParallelism` value, or a patch that changes nothing |
| `coordination.prepare-amendment.invalid-plan` | an append's own shape/id/metadata, a `file` that is not `{PLAN_DIR}/<id>.md`, a missing or mismatched plan header, a missing/escaping reference, or a `working_branch` equal to one of the workflow's branch anchors |
| `coordination.prepare-amendment.compass-mismatch` | an unusable, malformed or foreign compass, or a plan set / `spec_integration_branch` the reviewed compass does not declare — plus, **only when the compass declares its own `integration_worktree_path`**, the checkout this call would leave recorded |
| `coordination.prepare-amendment.invalid-worktree` | **only when the patch supplies `integrationWorktreePath`** and that path fails validation: absent, the main/control checkout, not a distinct checkout of the repository owning the control harness root (which must also be the repository the caller runs from), not on the recorded `branch.integration`, or a workflow recording no `branch.integration` to verify it against (omitting the field never triggers this) |

Existing auth/scope refusals keep their own codes: `coordination.session-role` (not a coordinator envelope), `coordination.not-prepared` (the workflow has no coordinator binding), `coordination.session-mismatch`, `coordination.scope-mismatch`, `coordination.workflow-not-found`, `coordination.invalid-transition` (the proposed snapshot fails validation), `coordination.git-unavailable`, and the shared lock failure.

JSON success is `{ok:true, operation, workflow_id, session_file, session_id, role, snapshot_version, compass_version, plan_ids, allowed, blockers}` — plus `outcome: "amended"` on `amend-prepare`. JSON failure is the shared A2 shape `{ok:false, operation, code, message, workflow_id?, holder?, path?, expected?, actual?}`. JSON goes to stdout with no color or banner; in human mode stdout stays empty and the summary goes to stderr.

Exit codes (binding):

| Code | When |
|------|------|
| `0` | the read succeeded, or the amendment committed (returning fresh versions) |
| `1` | engine refusal — any `code` above, always with no change to authoritative bytes |
| `2` | usage: a missing `--session` / `--expect-snapshot` / `--expect-compass` / `--input`, an unknown flag, a relative path where an absolute one is required, a malformed version token, or an unreadable/unparseable payload file |

**Stop conditions — a stale token is recovered by re-reading, never by forcing.** Re-run `show-prepare`, review the new bytes, then call `amend-prepare` with the fresh tokens. There is no `--force`, no `--replace`, no `--init` and no fallback flag, and no replacement-snapshot path: a workflow that already owns execution, has left Prepare, or is not bound to this coordinator session cannot be amended at all.

Worked example (synthetic ids):

```sh
# 1. Coordinator bootstrap: main worktree (or the recorded integration worktree) only.
mstar plan bind --coordinator --workflow wf-demo --json

# 2. Read both byte versions and the admission view of this Prepare workflow.
mstar workflow show-prepare --session …/sessions/<coordinator>.json --json
# → {"ok":true,"operation":"show-prepare","workflow_id":"wf-demo","snapshot_version":"sha256:…",
#    "compass_version":"sha256:…","plan_ids":["plan-a"],"allowed":true,"blockers":[]}

# 3. Apply the approved delta with exactly those tokens.
mstar workflow amend-prepare --session …/sessions/<coordinator>.json \
  --expect-snapshot sha256:… --expect-compass sha256:… --input /control/.mstar/plans/patch.json --json
# → {"ok":true,"operation":"amend-prepare","outcome":"amended","plan_ids":["plan-a","plan-b"],…}
```

## Maintainer Commands

Engine-backed harness checks for maintainers (thin wrappers — business logic lives in `@mstar-harness/engine`). Each command mirrors an engine validator that skill engine-check callouts cite; exit codes follow the CLI convention (0 = OK, 1 = violations/data errors, 2 = usage).

### `mstar-harness status workflow-close`

Close one workflow lifecycle after its delivery PR merged: `closeWorkflow` writes the terminal snapshot under the snapshot lock, then `unregisterWorkflow` removes the root `status.json` entry idempotently. Dangling leases and unfinished plan rows refuse before any write, a fully closed retry rewrites nothing, and a failed unregister reports a partial close a re-run finishes.

```text
mstar-harness status workflow-close --workflow <id> [--harness <path>] [--ended-at <date>] [--session <path>]
```

`--session <absolute-json>` is the coordinator envelope that authorizes closing a **coordinated** workflow: the engine's close gate runs before the unfinished-row check, so a coordinated workflow refuses a session-less close with `snapshot <path> is coordinated — close requires --session <coordinator envelope>` (exit 1, nothing written) instead of reporting the plan rows. A plan envelope is not sufficient — only the workflow's coordinator may close it. An uncoordinated workflow closes with or without the flag, exactly as before; `--session` with a relative path is a usage error (exit 2).

### `mstar-harness status tech-debt`

Print the residual tech-debt rollup (`total_open` / `by_severity` / `by_target` / `by_plan`) aggregated over every `{PROJECT_DIR}/<id>/residuals.json` project register — a thin mirror of the engine `techDebtRollup` check cited in `mstar-artifacts` (`references/status-and-residuals.md`). v3 hard cutover: the project register is the source of truth — there is no stored-summary drift check, the output is informational (exit 0).

- `npx @mstar-harness/cli status tech-debt`
- `npx @mstar-harness/cli status tech-debt path/to/projects`

Without a path argument the command uses the resolved `{PROJECT_DIR}`.

Exit codes:

- `0` — prints the computed rollup + the informational note (registers empty → zero rollup)
- `1` — project dir not found or resolution failed

### `mstar-harness status findings-cleanup`

Enforce a plan's `Findings cleanup` mode on its project-register residuals — a thin mirror of the engine `findingsCleanupGate` check cited in `mstar-artifacts`. The register (`projects/<id>/residuals.json`) entries are keyed by plan id — the snapshot plan linkage. Mode resolution: explicit `--mode zero-residual|allow-residual`, else the `allow-residual` default (plans without register entries pass trivially).

- `npx @mstar-harness/cli status findings-cleanup <plan-id> --harness <path>`
- `npx @mstar-harness/cli status findings-cleanup <plan-id> --project acme --mode zero-residual`

`--harness` defaults to the resolved `{HARNESS_DIR}`; `--project` defaults to `_default`.

Exit codes:

- `0` — OK: no open-residual violations under the resolved mode
- `1` — violations: prints one `findings.*` row per violating open residual on stderr

### `mstar-harness migrate`

Migrate a v1 `{HARNESS_DIR}` status.json tree to the v2 schema — a thin wrapper over the engine `migrateHarnessTree` / `applyMigratePlan` (P1 Task 6). One-shot hard cutover: v1 root is **archived** to `archived/status.v1.json` (never deleted without that copy), each lifecycle (iteration compass + standalone plan row) becomes `workflows/<id>/snapshot.json` (+ `notes.jsonl` ledgers), residuals become the `projects/<id>/residuals.json` register, `metadata.program_roadmap` seeds `projects/<id>/roadmap.md`, and the root `status.json` is replaced by the v2 root (the commit point, last step). Re-run on a v2 tree is an idempotent no-op.

- `npx @mstar-harness/cli migrate`
- `npx @mstar-harness/cli migrate --dry-run [--path <root>] [--json]`

`--path` is the **harness root** (the dir containing `status.json`); it defaults to the resolved `{HARNESS_DIR}` (auto-discovery from the cwd, like every other command; falls back to the cwd for a bare harness-root directory without a `.mstar/` marker). `--dry-run` prints the ordered step plan (source → destination), runs the apply-time validators (`validateWorkflowSnapshot` / `validateProjectRegister`) **read-only** on the planned documents and surfaces any violations as `warning:` lines — an apply-time rejection is visible before any write — and writes nothing. `--json` emits the machine-readable shape on stdout.

Exit codes:

- `0` — OK, or idempotent no-op (`status.json` already at schema version 2)
- `1` — plan-invalid: no/unrecognized v1 `status.json`, unliftable or duplicate `plans[]` rows, unsafe ids
- `2` — apply-failure: the executor threw mid-apply; the v1 root stays intact for a re-run (fix the blocker and re-run — the deterministic plan converges)

### `mstar-harness lease verify-integration`

Verify the workflow snapshot's top-level `integration_merge_lease` object when present — a thin mirror of the engine `validateIntegrationMergeLease` check cited in `mstar-artifacts` / `mstar-iteration`. Distinct from `mstar-harness lease verify` (the plan-level `execution_lease` on a snapshot plan row): this is the serial integration-merge lease.

- `npx @mstar-harness/cli lease verify-integration --workflow <id> --harness <path>`

`--harness` defaults to the resolved `{HARNESS_DIR}`.

Exit codes:

- `0` — OK: no `integration_merge_lease` (unclaimed) or a valid lease (prints the holder)
- `1` — invalid lease: missing/invalid `holder` / `claimed_at` / `plan_id` / `source_branch` / `target_branch`, or a `null`/tombstone object
- `2` — usage: missing `--workflow`

### `mstar-harness worktree qc-alignment`

Assert the QC/QA alignment fields (`plan_id` / `Review range` / `Diff basis`) are byte-identical across the given Assignment files — a thin mirror of the engine `assertQcAlignment` check cited in `mstar-branch-worktree`.

- `npx @mstar-harness/cli worktree qc-alignment qc1.md qc2.md qc3.md qa.md`

Each file is parsed for the three header fields (bold or plain forms; `Review range` and `Diff basis` accepted either as separate labels or via the canonical combined `**Review range / Diff basis**:` label, whose value fills both fields). Exit codes:

- `0` — OK: all three fields byte-identical across every file
- `1` — mismatch: prints `qc.alignment.mismatch` per differing field, or `qc.alignment.field.missing` when a file lacks a required field
- `2` — usage: no assignment files given

### `mstar-harness host skill-root`

Resolve the loaded skill root for a host — a thin mirror of the engine `resolveSkillRoot` check cited in `mstar-host` (table at "Resolve loaded skill root").

- `npx @mstar-harness/cli host skill-root --host opencode --skill mstar-roles`
- `npx @mstar-harness/cli host skill-root --host cursor --skill mstar-roles --rel references/opencode.md`

Exit codes:

- `0` — prints the canonical skill-root string (e.g. `harness-skills/mstar-roles`); `pi` prints the deferred-resolution notice in yellow
- `1` — missing required `--host` / `--skill` option (commander default)
- `2` — usage: unknown `--host` id, or an empty `--skill` value

### `mstar-harness lint`

Lint harness artifacts by content type (engine-backed): plan files → quality bar, `SKILL.md` → frontmatter, `STRATEGY.md` → required sections, `task-N-report.md` → SDD TDD triple, code files → `simplify:`/`temporary` markers. The content type is inferred from the target's basename/location; directory targets collect lintable files recursively (build/vendor trees skipped). Violations print as per-file FAIL rows plus one row per finding on stderr; `simplify:` markers are advisory stdout notes.

- `npx @mstar-harness/cli lint <file-or-dir>`
- `npx @mstar-harness/cli lint <file-or-dir> --type provenance`

`--type` forces one content type: `plan | skill | strategy | report | code | finding | provenance`. `finding` (finding-doc contract, `--pr-variant` adds the PR-only Merge class) and `provenance` are explicit-only — inference never selects them. `--type provenance` is a content-agnostic scan applied to every collected target: over a directory the walk collects the calibrated repo text face (`.md` / `.ts` files — ordinary-named docs like `README.md` are scanned, not just classifier-classifiable targets). It reports provenance citations (dated plan/iteration id tokens and dated local-harness deeplinks that tracked content must not carry) as `lint.provenance.plan-id` / `lint.provenance.harness-path` rows with 1-based line numbers. Placeholder forms (`task-N-report`, `<plan-id>`), synthetic example slugs (any `-example-` segment), plain dates, version tokens, undated layout lines, and sdd deeplinks (`.mstar/sdd/…` / `.agents/sdd/…` — attributed to the `skill lint` ephemeral-citation check, not this scan) pass.

Exit codes:

- `0` — OK (an empty directory walk prints a "no lintable files" note)
- `1` — violations or file errors
- `2` — usage: missing target, unknown `--type` value, or an unclassifiable file without `--type`

## Harness Slash Commands (not CLI subcommands)

`/codebase-audit`, `/amazing-pr-review`, and the `/iteration-*` commands ship with the harness plugin (`commands/*.md`), not the `mstar-harness` CLI binary. Host availability: dsh / omp / OpenCode / Cursor load them from the plugin; Kimi / ZCode expose `/morning-star-harness:<name>`; Codex installs them as project-local skills (`--scope project`). See the command-loading table in [README.md](../README.md#audit-review--verification).

All six commands — purpose, argument forms, host notes, and the scoped `/iteration-drive` route — are indexed in [`commands.md`](commands.md); the sections below keep the CLI-side detail.

### `/amazing-pr-review`

Deep, evidence-first review of a pull request / branch / diff before merge → one verdict (`ship it` / `needs fixes` / `blocked`). Worktree-isolated and read-only; findings that can fix become self-contained plans (`{PLAN_DIR}/audit-<YYYY-MM-DD>/`) for the normal Prepare → Execute flow. When a PR number exists, the command's main agent posts a mandatory GitHub Review (`COMMENT` event) with line comments on findings at Stage 3 synthesis — SSOT → `mstar-audit` `pr` variant → `references/pr-review.md`. Runs at one of three strengths — `quick` / `default` / `deep` — chosen by an explicit keyword or inferred from the change shape (`references/pr-review.md` § Review depth (tiers)): `quick` = 1 seat, collect + review in one pass (tiny-mechanical diffs); `default` = 2 domain seats, collection folded in — the no-flag landing tier for small code PRs; `deep` = the full three-stage pipeline (collect → domain review → main-agent synthesis), 4–7 seats. Multi-PR input reviews only the first PR at its resolved tier; remaining PRs are queued as audit todos for the next session — one session = one PR (§ Batch sibling PRs).

The verdict is computed from the finding tally; `score_pct` is display-only feedback and never overrides it (→ `references/pr-review.md` § Tally and derived score).

### `/codebase-audit`

```text
/codebase-audit [simplify]
```

| Token | Meaning | Default |
|---|---|---|
| `quick` / `deep` | Effort level: `quick` = hotspot-only (0–1 subagents, top ~6 HIGH-confidence findings); `deep` = whole repo, every package (≤8 subagents, one per category) | `standard` (hotspot-weighted, key packages, ≤4 subagents) |
| `<category>` | Category focus — recon, then that category only: `bug`, `security`, `perf`, `tests`, `tech-debt`, `migration`, `dx`, `docs`, `direction` (plan `Category` field values) | all nine |
| `branch` | Current-branch changes only (since merge-base with the default branch); findings tagged `introduced` / `pre-existing` | full codebase |
| `next` / `roadmap` | Direction category only, in depth — 4–6 grounded suggestions → design/spike plans | — |
| `simplify` | DEBT-focused deep pass: dead / duplicated / speculative / over-built / added-then-removed / hand-rolled-where-a-dependency-exists surfaces, proved or rejected via consumer classification; findings use category `tech-debt` (finding code `DEBT`); tiny-real items land in "considered and rejected", never inline TODOs | — |

Examples: `/codebase-audit`, `/codebase-audit deep security`, `/codebase-audit branch`, `/codebase-audit simplify`. Full workflow SSOT → **`mstar-audit`** skill.

## What `init` Ensures

OpenCode `init` enforces these baseline requirements in `opencode.json`:

- `"$schema": "https://opencode.ai/config.json"`
- `plugin` contains `@mstar-harness/opencode@latest` (legacy `morning-star@git+…` lines for `btspoony/mstar-harness` are stripped on init, including URLs without `.git`, `ssh://`, or `#tag`)
- Role models are **not** required — OpenCode defaults apply unless you pass optional `--*-model` flags

Cursor and Codex `init` ensure a maintained local checkout exists at `~/.mstar/harness`. Codex then copies regular agent TOML files from that checkout. Cursor clones a **separate real git checkout** at the plugin path (see [Install path layout](#install-path-layout)).

Cursor `init`:

- global: `git clone` / `git pull` at `~/.cursor/plugins/local/morning-star-harness`
- project: `git clone` / `git pull` at `.cursor/plugins/morning-star-harness`, `.gitignore` entry for the plugin directory, and harness **process** gitignore entries for `.mstar/` and legacy `.agents/` (`archived/`, `iterations/`, `plans/`, `sdd/`, `notes.json`, `status.json`). Harness **results** (`knowledge/`, `specs/`, `AGENTS.md`) are not added automatically.

Codex `init` registers the repo-bundled Codex marketplace (probed on codex-cli 0.144.1; requires the `codex` CLI on PATH):

- `codex plugin marketplace add https://github.com/btspoony/mstar-harness.git --ref main` — idempotent (an already-registered marketplace is skipped)
- the marketplace catalog is the repo's own `.agents/plugins/marketplace.json` (name `mstar-repo`, plugin root = repo root, `source.path: "./"`)

Codex `init` also copies all `codex/agents/*.toml` files as regular files into `~/.codex/agents/` for global scope or `.codex/agents/` for project scope. Project scope appends the same harness **process** gitignore set as Cursor project `init` (see above) and symlinks `iteration-start` / `iteration-drive` / `iteration-loop` into `.agents/skills/<name>/SKILL.md` from `~/.mstar/harness/commands/<name>.md` (also gitignored). Global scope skips iteration skills and prints a pollution-avoidance warning.

dsh `init` runs the two `dsh plugin --profile web add` calls (`@mstar-harness/dsh` then `dsh-llm-fallbacks`) in the fixed `web` profile — idempotent (already-installed rows skipped; a fallbacks row installed at a version other than the pin is re-added at the pin instead), fail-loud when the `dsh` binary is missing, and `--no-fallbacks` skips the fallbacks row.

### Codex agent files

Re-run `init --target codex --scope global` (or `project`) to install from the current `~/.mstar/harness/codex/agents/` source. Identical bytes are left untouched. A differing regular file is backed up as `<role>.toml.<uuid>.bak` before atomic replacement; a legacy symlink to the expected harness source is replaced without writing through it. Unrelated symlinks, non-file destinations, and a symlinked agent directory are refused.

`init` does not pull an existing source checkout: refresh that checkout first when upgrading agent definitions, then re-run `init`. Project iteration skill symlinks are unchanged. After `doctor --target codex --scope <global|project>` passes, have Codex invoke a named role (for example, `fullstack-dev` on a short read-only task) and confirm that it starts; role discovery alone is insufficient.

## What `doctor` Checks

- Same schema and presence of **either** `@mstar-harness/opencode…` **or** a recognized legacy `morning-star@git+…` line (so existing git-based configs still pass).
- Missing per-role `agent.<role>.model` is a **yellow recommendation** only (OpenCode defaults are OK).
- If only legacy git is present, or legacy and npm are both listed, `doctor` prints **yellow recommendations** and still exits 0; run `init` to normalize to `@mstar-harness/opencode@latest`.
- For Cursor, `doctor` checks the maintained `~/.mstar/harness` checkout, that the Cursor plugin path is a **real git directory** (not a symlink), that `agents/*.md` files use Cursor-first frontmatter, and (project scope) all harness **process** `.gitignore` entries listed under Cursor `init`.
- For Codex, `doctor` checks that the `mstar-repo` marketplace is registered (via `codex plugin marketplace list`), the maintained `~/.mstar/harness` checkout, and regular custom-agent files whose bytes match the maintained source. Symlinks, missing files, and stale or customized bytes are issues; configuration checks do not prove successful subagent invocation. A legacy personal-marketplace entry for this plugin in `~/.agents/plugins/marketplace.json` is reported as a migration note. Project scope also validates iteration skill symlinks under `.agents/skills/` and harness **process** `.gitignore` entries.

## Install path layout

Cursor **does not discover symlinked plugin directories**. Use real directories at the plugin paths below.

| Path | Host | Layout | Notes |
| --- | --- | --- | --- |
| `~/.mstar/harness` | Codex (agent `.toml` source), OpenCode dev bundle | git checkout | Codex agent `.toml` files are **copied as regular files** from here into `~/.codex/agents/`; the Codex marketplace itself is git-sourced (`btspoony/mstar-harness`) |
| `~/.cursor/plugins/local/morning-star-harness` | Cursor global plugin | **git checkout (real dir)** | **Not** a symlink to `~/.mstar/harness`; `init` clones or `git pull`s here |
| `.cursor/plugins/morning-star-harness` | Cursor project plugin | **git checkout (real dir)** | gitignored; same clone/pull behavior as global |

`init --target cursor` maintains **two** checkouts: `~/.mstar/harness` (shared with Codex) and the Cursor plugin path (independent clone, kept in sync via `git pull` on each init).

**Maintainers** editing this repository in a separate workspace should refresh the Cursor plugin checkout after merging:

```bash
cd ~/.cursor/plugins/local/morning-star-harness && git pull --ff-only
```

Or re-run `npx @mstar-harness/cli init --target cursor --scope global`.

## Options Reference

### Shared

- `--output <path>`: explicit config path (absolute or relative to project root)

### `init` options

- `--yes`: non-interactive mode
- `--target <opencode|cursor|codex|zcode|omp|dsh>`
- `--scope <global|project>` (default: `project`)
- `--dry-run`
- `--no-fallbacks`: skip installing the `dsh-llm-fallbacks` plugin row (dsh target only; ignored for other targets)
- `--no-global-cli`: skip installing the matching-version `@mstar-harness/cli` globally after init
- `--pm-model <model>` (optional advanced override)
- `--strategic-models <a,b,c>` (optional)
- `--dev-models <a,b,c>` (optional)
- `--qc-models <a,b,c>` (optional)
- `--other-models <a,b,c>` (optional)

### `doctor` options

- `--target <agent>`
- `--scope <global|project>`
- `--output <path>`

### `plugin validate` options

- `--root <path>`: plugin root directory to validate (default: nearest ancestor of the project root that contains `plugin.json`)

## Development (Repository)

These are for contributors developing this repository:

- `bun run cli:dev -- --help`
- `bun run cli:build`

### Target Adapter Architecture

The CLI uses a target adapter layer so new code agents can be added without rewriting `init`/`doctor`.

- Adapter registry: `packages/cli/src/adapters/index.ts`
- OpenCode adapter: `packages/cli/src/adapters/opencode.ts`
- Cursor adapter: `packages/cli/src/adapters/cursor.ts`
- Codex adapter: `packages/cli/src/adapters/codex.ts`
- Shared contracts: `packages/cli/src/types.ts`

To add a new agent target, implement a new adapter with:

- config path resolution (`resolveConfigPath`) **or** install flow (`runInstallInit` / `runInstallDoctor`)
- init mutation (`mutateConfigForInit`) for config-mode targets
- doctor validation (`validateConfig`)
- optional model discovery (`getAvailableModels`) — OpenCode default init does **not** use this (avoids hanging on `opencode models`)
