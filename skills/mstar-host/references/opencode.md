# OpenCode host reference

Load when **`mstar-host`** detection resolves **opencode** (`question` tool, **task tool** with **subagent** parameter, or OpenCode session).

Parallel PM dispatch: **`parallel-dispatch.md`** (read in dispatch rounds).

## Role loading

- **PM entry**: **`/pm`** or **`pm` skill** → `project-manager` for general orchestration; **`commands/`** (`iteration-start`, `iteration-drive`, `mstar-bootstrap`) for formal iteration only.
- **Role shell**: `agents/<id>.md` referenced by `opencode.json` `agent.<id>` (frontmatter + role binding only).
- **Role body**: `mstar-roles` `references/<id>.md` (or shared references + parameters).
- Implementation evidence and RCA behavior: `mstar-coding-behavior`.

## OpenCode-specific capabilities

- **Structured clarify**: prefer **`question`** tool (title, prompt, options, optional custom text). Requires `permission.question` in config (user-maintained; do not edit global config without consent).
- **Built-in subagents** (via **task tool**): **explore** (read-only), **general**; subject to `mstar-harness-core` explore boundaries.
- **Named role subagents**: Morning Star roles configured under `opencode.json` `agent.<id>` — PM must **call the task tool** with **`subagent`** set to that agent id. Assignment Markdown alone does not open subagent sessions.
- **Per-role models**: configurable per subagent in `opencode.json`.

## PM dispatch (task tool + subagent)

Harness **dispatch** on OpenCode = **one or more `task` tool calls**, each with **`subagent: <agent-id>`** (read the tool schema every session).

| Harness | OpenCode |
|---------|----------|
| `Execute as: <role-id>` | **`subagent`** on **task tool** = same agent id |
| 1 Assignment ⇒ 1 invoke | **1 task tool** call with matching **subagent** + prompt from Assignment |
| Parallel batch **N** | **N task tool** calls in **one assistant message** when the host allows (`parallel-dispatch.md`) |
| No task tool call | **Not dispatched** — paste-only / `dispatch incomplete` |

PM workflow: finalize Assignment → **call task tool** with **subagent** + generated prompt → wait for subagent Completion Report → update plan / status.

**SDD sticky implementer:** if the task tool exposes **resume** / agent id, follow **`mstar-sdd/references/sticky-implementer-session.md`** and the active host reference. If resume is **not** available, use **micro-batch** (2–3 tasks, one invoke) or **`SDD implementer session: fresh`** per task — do not assume sticky without host support.

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
