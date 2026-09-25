# OpenCode host reference

Load when **`mstar-host`** detection resolves **opencode** (`question` tool, **task tool** with **subagent** parameter, or OpenCode session).

Parallel PM dispatch: **`parallel-dispatch.md`** (read in dispatch rounds).

## Role loading

- Skill root: load by skill **name** from `@mstar-harness/opencode` (`harness-skills/<name>/` inside the package). Never `process.cwd()/skills/` — see `mstar-host` § Resolve loaded skill root.
- **PM entry**: **`/pm`** or **`pm` skill** → `project-manager` for general orchestration; host **`commands/`** for formal iteration Phase 1–5 (semantics → **`mstar-iteration`**).
- **Role shell**: `agents/<id>.md` referenced by `opencode.json` `agent.<id>` (frontmatter + role binding only).
- **Role body**: `mstar-roles` `references/<id>.md` (or shared references + parameters).
- Implementation evidence and RCA behavior: `mstar-coding-behavior`.

## OpenCode-specific capabilities

- **Structured clarify**: prefer **`question`** tool (title, prompt, options, optional custom text). Requires `permission.question` in config (user-maintained; do not edit global config without consent).
- **Built-in subagents** (via **task tool**): **explore** (read-only), **general**; subject to `mstar-harness-core` explore boundaries.
- **Named role subagents**: Morning Star roles configured under `opencode.json` `agent.<id>` — PM must **call the task tool** with **`subagent`** set to that agent id. Assignment Markdown alone does not open subagent sessions.
- **Per-role models**: configurable per subagent in `opencode.json`.

## Native execution association (decision-only)

This host's write hook cannot refuse a call (`tool.execute.before` returns `Promise<void>` with no refusal channel), so nothing here is a fence. What it does have is a **native session fact** and a **decision record**:

- **Identity is native + independently acquired, never tool-declared.** The hook's own `sessionID` is the authoritative session fact and overwrites whatever the ambient identity carried; the scope (workflow / role / plan) can only come from an independently acquired `MSTAR_EXECUTION_IDENTITY` scope — never from tool arguments, a tool parameter or a spawn target. The channel is overwritten for the child and **both legacy keys are removed** (`MSTAR_HOST_SESSION_ID`, `MSTAR_HARNESS_DIR`), so the harness root is only the explicit `--harness` flag or the child's own cwd.
- **A missing, blank, malformed, copied or stale association is an explicit operational exclusion** (`operationallyExcluded: true`), never a success-shaped warning and never a guess: no native `sessionID`, no independently acquired scope, or a scope that fails the engine's own validation all land there.
- **The shared CLI is the writer; this plugin only consults it.** A bound association runs the real shared CLI invocation under the native identity and **reports exactly what that call proved** — the session-authorized read (`plan show --session-ref`, which revalidates caller/root/store/epoch/row) when the session's own reference is known, otherwise the authority read (`plan show --workflow/--plan`, which does not verify caller currency), otherwise the argument-less `status validate` register read. A refusal keeps the CLI's own code; a missing or stale context is never upgraded into a claim, and nothing here claims a stopped writer or a cached success.
- **The session's own reference is learned from its CLI traffic**, not from a tool argument: a `bash`/dispatch invocation this session issued carrying `--session-ref` / `--resume-ref` names a reference the session was already issued, and that is what a later consultation reuses. A reference is a lookup — it grants nothing by itself, and the engine compares the independently acquired caller.
- **Capability is reported honestly**: the package advertises `decision-only` for the write hook regardless of how well the CLI path works. A writer association that cannot be established means this consumer must be **excluded operationally**; log output is never upgraded into a fence, and this host never claims installed-adoption parity.

## Runtime and upgrade

- **Runtime**: the published plugin is a `--target node` bundle that runs inside OpenCode's own Node process — floor **Node >=24.18.0** with in-process native `node:sqlite`. The store API is loaded lazily, so a plugin on an engine without the store surface still mounts (load), while a store-backed check refuses with upgrade guidance rather than dropping the gate. Below-floor or missing-capability refuses actionably; there is no transport or JSON fallback.
- **Upgrade / reload**: change the plugin specifier in `opencode.json` (or re-run the installer CLI), then restart OpenCode. A harness **source** edit is not an install: the running plugin keeps serving its installed build until that restart.
- **Readiness, not an action**: refreshing an *installed* copy is a bounded, authorized ops act — an authority flip first quiesces, then reloads/upgrades (or explicitly excludes) every installed reader/writer and attests the versions it saw. Editing harness docs or source performs none of it. If this host cannot reload safely, stop at the exact manual-restart step, have the user restart, then re-verify entrypoint/runtime/version/session identity read-only before the flip.
- **Authority protection is warn-only for authority bytes (known limitation)**: the OpenCode plugin API (`@opencode-ai/plugin` 1.4.8) types `tool.execute.before` as `Promise<void>` — there is no abort or refusal return channel — so this plugin cannot stop a write. An authority decision (a direct `store.db` write, a retired register, an unreadable authority) is still made unconditionally and surfaced as an error log with `hardBlocked: true` set in-process, **but the write still executes**: on this host the authority bytes are warn-only, not enforced. Hosts with a real block channel (dsh, omp, the ZCode hook) refuse the same decisions; do not rely on OpenCode to stop a hand write of the authority. When OpenCode exposes a refusal channel, the existing `hardBlocked` result is what gets wired to abort.

## PM dispatch (task tool + subagent)

Harness **dispatch** on OpenCode = **one or more `task` tool calls**, each with **`subagent: <agent-id>`** (read the tool schema every session). N-parallel / 1-Assignment-1-invoke / paste-only mechanics → **`parallel-dispatch.md`**.

| Harness | OpenCode |
|---------|----------|
| `Execute as: <role-id>` | **`subagent`** on **task tool** = same agent id |
| Parallel batch **N** | **N task tool** calls in **one assistant message** when the host allows (`parallel-dispatch.md`) |

**Role-binding field:** **`subagent`** on the **task tool** (singular — there is no batch array here); it must equal the Assignment `Execute as`.
**Engine scope (#156):** OpenCode exposes no dispatcher identity, so the caller-scoped `antiRecursionPrecheck` leg is **skipped** on this host — the binding field carries the **spawn target**, and target == `Execute as` is the compliant C5 pattern — and the red line stays **prompt-level** (`mstar-dispatch-gates` § 承接方反递归红线). Caller-side hard enforcement exists only where the host declares a dispatcher binding (`dsh.md`).

PM workflow: finalize Assignment → **call task tool** with **subagent** + generated prompt → wait for subagent Completion Report → update plan / status.

**SDD sticky implementer:** if the task tool exposes **resume** / agent id, follow **`mstar-sdd/references/sticky-implementer-session.md`** and the active host reference. If resume is **not** available, use **micro-batch** (2–3 tasks, one invoke) or **`SDD implementer session: fresh`** per task — do not assume sticky without host support.

**SDD task reviewer:** each task review is a **new** task tool call with `subagent: "code-reviewer"` (OpenCode L2 review; not qc-specialist*) when that agent is configured, else generic built-in fallback + C5b — no sticky resume for reviewers (fresh per task).

## Role-mention hygiene (OpenCode)

OpenCode may **auto-append** system lines when prompt text stacks multiple agent-id **prefix mentions**. Typical boilerplate (host-generated — **not** harness Assignment):

```text
Use the above message and context to generate a prompt and call the task tool with subagent: <agent-id>
```

(Same sentence repeated with different **subagent** values — mechanical template, not user prose.)

| Do | Don't |
|----|-------|
| Use **plain role ids** (`product-manager`) in skill / command / Assignment prose | Stack prefix-style role mentions that trigger multi-**subagent** boilerplate |
| Sequential chains: **one task tool / one subagent per dispatch turn** | Treat auto-appended **task tool + subagent** lines as authorized parallel batch |
| Real dispatch: PM **calls task tool** with explicit Assignment + **`Delegation`** rules | Confuse boilerplate with **`Delegation: allowed`** |

When documenting this in harness text, avoid embedding prefix-style role examples in the warning — that can re-trigger the host.

## Prepare phase — serial roles still require invoke

`mstar-roles` **project-manager** may route `explore → product-manager → architect` **sequentially**. Each handoff still needs a real **task tool** call with the matching **subagent** and Assignment (**`N = 1`** per dispatch turn). Writing PRD / architecture only in the PM chat is **not** a substitute.

## Gotchas

- `question` availability is config-dependent; if unavailable, structured Markdown clarify.
- **explore** subagent (via task tool) is orientation only — not role-owned implementation or review deliverables.
- More MCPs do not replace phase gates or evidence rules.

## Session noise control

- Large unrelated platform injections (e.g. long ecosystem prompts): prefer on-demand / `alwaysApply: false` when not stack-relevant.
- One default channel per capability class (search, docs).

## Standalone harness note

Bundled **`mstar-*` skills** are self-contained in this repository. User-installed host MCPs, external skills, or CLIs are **outside harness SSOT** — do not add them to `mstar-*` load order or treat them as required for gates.

## Maintenance boundary

Runtime only — do not modify `opencode.json`, `secrets.env`, or `.secrets/*` without explicit user consent.
