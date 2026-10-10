# ACTIVE execution state, migration sources, and project registers

> **Load order (same as other `mstar-*` skills):** Before changing SSOT / residual fields using this reference, Read **`mstar-harness-core`** (SKILL.md; same-repo branches and worktrees → **`mstar-branch-worktree`**). On conflict, **`mstar-harness-core` wins**; skill index in that SKILL.md.

Execution authority is the ACTIVE DB domain in `{HARNESS_DIR}/store.db`. There is no file execution route. Root `status.json` and `{WORKFLOW_DIR}/<id>/snapshot.json` are **migration sources / retained history**, not authority.

v1 的单文件 `status.json`（根 `plans[]` + 根级 `residual_findings` + `metadata`）由 `mstar migrate` 一次性迁到 v2 文件；v2 文件再由 `mstar store upgrade` 作为 byte-witness 来源导入 store。v1 字段形状/历史全文 → **`mstar-engine-legacy`** `references/status-field-history.md`（档案，不是执行路由）。本文件保留迁移源形状、ACTIVE 字段与 issue/residual 语义。

> **Authority:** ACTIVE execution state is the DB domain. Ordinary coordinator operations are store transactions with CAS receipts. Surviving `status.json` / snapshot files are migration sources / retained history, not live state. A harness with no ACTIVE store has no execution authority.

- **ACTIVE root register** — `{HARNESS_DIR}/store.db` (`execution_registry` + `execution_meta.root_updated_at`), read through `mstar status validate` (no path). PM close caller: `mstar status workflow-close --workflow <id>` — one store transaction writes the terminal workflow state and unregisters the workflow (procedure → `mstar-iteration/references/phase-6-post-merge-close.md` §6.1–§6.2; route → lifecycle contract amendment **File-route retirement**).
- **ACTIVE workflow / plan state** — store `execution_*` tables, read through `mstar plan show` / `mstar status validate`. Rows hold source metadata, configuration, progress and completion. Workflow-wide integration merge exclusion is `execution_integration_leases`. Per-row execution leases are removed. `<id>` is the plan or iteration workflow id.
- **Persist surface** — user-facing `mstar persist` accepts `review` and `json` only. Engine `ArtifactKind` retains `status` and `snapshot` as migration-scoped internal kinds written by the kept migration tooling (`mstar migrate` staging, then `mstar store upgrade`). The engine type is not two-member. `mstar harness scaffold` does not write `status.json`.
- **`{PROJECT_DIR}/<id>/roadmap.md` + `residuals.json`** — 项目层 legacy 文件：Markdown 是 reviewed import/export 的 transport/history，roadmap 内容权威在 `{HARNESS_DIR}/store.db` 的 `project_roadmaps`（读写规则 → `mstar-project-governance`）；residual **register**（`entries[<plan-id>]` 数组；severity 枚举与 lifecycle 语义逐字保留）是迁移历史，open item 的 SSOT 是 store issue。无归属的流程落到 `_default` 项目。

**Migration sources:** root `status.json` and the workflow snapshot are retained history. The DB execution domain is the SSOT. **open item 的 SSOT 是 `{HARNESS_DIR}/store.db` 的 issue**（→ § Issue capture below）；project register 是**迁移历史**。
Canonical vs legacy residual definitions → **`mstar-artifacts` SKILL.md**（"Execution authority, migration sources, and open residual (summary)"）；本文件 covers **ACTIVE fields, migration-source shapes, severity, lifecycle, and engine-check commands**.
Register 文档的关闭形态（迁移读入形态）：closed entry 带 `lifecycle` / `closed_at` / `closure_note`；v1 的 `archived/residuals/<plan-id>.json` 归档路径与 `archive-residuals` 已移除（`mstar status archive-residuals` 报错并指向 issue 动词：`mstar plan issue-close` 或 `mstar issue close|waive|duplicate|supersede`）。

**Why this matters:** Within a working copy, the **local session SSOT** for risk and decisions is the issue store. Non-blocking conclusions that stay only in chat or a gitignored review bundle **without local SSOT update** cannot be inherited reliably in that session; `Done` drifts from visible known debt. **`@project-manager`** should capture trackable open items as issues soon after review closure; close after verification per **`QA gate`** (`qa-engineer` when `mandatory`, else PM acceptance checklist) — capture and closure per **`mstar-project-governance`「Issue capture」**.

**Cross-clone handoff** (default git policy): tracked `{HARNESS_DIR}/AGENTS.md`, `{KNOWLEDGE_DIR}/**`, `{SPECS_DIR}/**`, and root `CONCEPTS.md` / `STRATEGY.md` when used. Residuals that must survive clone must be **promoted** (compound) or written into those tracked results — do not treat `status.json` / `workflows/` / `projects/` / `plans/` as the default clone handoff surface.

## Issue capture and open items（capture duty pointer）

**Canonical capture duty（唯一权威，逐字文本）→ `mstar-project-governance`「Issue capture」（issue-store contract §6）。** 本文件不复述该契约；下面是 artifacts 侧的**落点应用**。

- **谁捕获**：确认该结论的席位 —— PM 席位（dispatch/consolidation、QC tri、iteration close）与 PR-review 轮次 Stage 3 的 main agent。Leaf audit/QC/QA 席位**只回证据，不写 store**。
- **open 侧映射**：residual **open** 登记 → issue capture（计划内 `mstar plan issue-add`，计划外 `mstar issue add`）；同一 finding 再次出现 → `mstar issue occurrence` 追加 occurrence，**不**新开第二个 issue。本文 § Residual findings 的 `severity` 枚举就是 issue 的 `severity` 枚举。
- **close 侧映射**：residual 关闭（`resolved` / `waived` / `duplicate` / `superseded`）→ issue 终态处置，由契约 §4 的关闭权威执行；`findings cleanup` 的 open 项是该 plan 的 **linked open issues**（`mstar status findings-cleanup <plan-id>`）。
- **激活边界**：store 接受普通捕获/查询、并作为唯一权威，以 issue-store contract §7 的 activation 完成为准（staged 时 `store.not-active`）；live 切换归 cutover plan 的授权 ops 任务。register 是迁移历史，不再作为写入目标。

## Basic structure

**Root `{HARNESS_DIR}/status.json` (v2)** — migration source / retained history, not the active register:

```json
{
  "version": 2,
  "updated_at": "YYYY-MM-DD",
  "workflows": [
    {
      "id": "<plan-id-or-iteration-id>",
      "type": "plan | iteration",
      "started_at": "YYYY-MM-DD",
      "dir": "workflows/<id>"
    }
  ]
}
```

- `dir` is **harness-relative** (`workflows/<id>`), never absolute.
- This shape is what `mstar migrate` stages and `mstar store upgrade` reads. Live registration and close do not write it.

**`workflows/<id>/snapshot.json`** — migration source / retained history (`schema_version: 1`). Migration tooling validates it with `validateWorkflowSnapshot`. `writeWorkflowSnapshot`, where retained, is a migration-scoped internal writer, not a public execution route:

```json
{
  "schema_version": 1,
  "id": "iter-demo",
  "type": "iteration",
  "status": "running",
  "started_at": "2026-08-30",
  "updated_at": "2026-08-30",
  "phase": "phase-2-execute",
  "plans": [
    {
      "id": "plan-id",
      "title": "Plan title",
      "file": "{PLAN_DIR}/plan-id-feature-name.md",
      "status": "InProgress",
      "owner": "@project-manager",
      "agents": ["@fullstack-dev"],
      "progress": 0,
      "tags": [],
      "created_at": "2026-08-29",
      "updated_at": "2026-08-30",
      "done_at": null,
      "notes": [],
      "metadata": {
        "worktree_path": "/abs/parent/repo.worktrees/demo-plan",
        "working_branch": "feature/demo-plan"
      }
    }
  ],
  "execution_policy": {
    "plan_parallelism": "serial",
    "worktree_mode": "",
    "push_policy": ""
  },
  "integration_merge_lease": {
    "holder": "omp:demo-session",
    "claimed_at": "2026-08-30T03:00:00Z",
    "plan_id": "plan-id",
    "source_branch": "feature/demo-plan",
    "target_branch": "iteration/iter-demo"
  },
  "branch": { "base": "main", "integration": "iteration/iter-demo", "target": "main" },
  "integration_worktree_path": "/abs/parent/repo.worktrees/iter-demo-integration",
  "legacy_metadata": {},
  "compass_ref": "iterations/iter-demo/delivery-compass.md"
}
```

- The example illustrates a held workflow integration exclusion, not a per-row holder. Release means key absence, never null/empty object; lifecycle and row status fields are scalar enums.
- Row configuration/progress/completion and workflow coordinator use the direct operation contract below. Unknown ordinary row fields survive domain updates; retired per-row session/transfer/seal metadata grants no admission.
- Terminal statuses (`completed` / `failed` / `stopped`) require `ended_at` and no dangling leases.
- **Completed close (Phase 6)** runs `mstar status workflow-close --workflow <id> [--session-ref <wire>] [--expect <full-execution-token>] [--operation <id>] [--reason <text>] [--harness <absolute-path>] [--json]`. It is one ACTIVE store transaction: terminal workflow state and root unregister together. It refuses a dangling integration exclusion or a non-`Done` row (fail-loud, store unchanged). An already-terminal `failed` / `stopped` workflow keeps its actual status (close never fabricates `completed`). The caller does not supply a terminal timestamp or a session path.
- Active callers with an unambiguous acquired coordinator identity may omit `--session-ref`, `--expect`, and `--operation`; the current workflow token and a fresh operation id are resolved for that invocation. Any supplied reference/token remains a checked constraint, and the caller's own `coordinator` role is still required.
- **Delivery-evidence consultation before the close (seam S3):** the registered delivery kind is consulted before a `completed` close (`failed`/`stopped` closes are never demanded delivery evidence, §5). An incomplete `development` delivery (no compound disposition / PR identity / PM-recorded verified-merge evidence, or a PR whose `head`/`target` are not the registered `branch.source`/`branch.target`), or an unfulfilled `verification/report-only` completion policy, refuses with the `PHASE6_DELIVERY_*` codes and leaves the workflow registered and resumable. Record the missing evidence with `mstar workflow evidence --workflow <id> --file <absolute-json>` under an acquired coordinator identity (`--session-ref` / `--expect` / `--operation` are optional checked constraints when identity is unambiguous). It is the same authority gate as the close, idempotent (identical evidence rewrites nothing) and stage-by-stage mergeable; the PR identity (§4d) is recorded **once** (a different pair is refused), the compound disposition and the merge record stay updatable. It refuses an already-terminal lifecycle. The read-only `mstar iteration gate --phase 6` shares this consultation, so gate and close never disagree.
- **Delivery kind is declared at registration by every producer** (§1/§4a): `mstar workflow register`, `mstar audit promote --delivery-kind <kind>` (required flag) and `mstar migrate --delivery-kind <kind>` (a lift that would create an ACTIVE kind-less plan workflow is refused as usage, exit 2; the declaration is ONE delivery identity, so a tree whose lift creates 2+ ACTIVE standalone plans is refused the same way with the plan ids — migrate in batches of one declared plan) all declare it explicitly — never inferred, never defaulted — and one shared rule pairs `development` with `--branch-source`/`--branch-target` and `verification/report-only` with `--completion-policy`.
- **Physical cleanup:** separate guarded worktree cleanup, after verified row integration or terminal merged delivery. Cleanup/close never clear merge exclusion to force eligibility; direct complete releases applicable exclusion in its verified transaction. Ownership comes from retained source metadata and actual merge evidence.
- `execution_policy` keys are copied from v1 root `metadata` at migrate; values are accepted-but-opaque this iteration (no semantic gate).
- `notes`: a plan row's `notes` array is the **legacy verbatim copy** preserved at migrate; the **runtime ledger is `notes.jsonl`** in the workflow dir (see `workflows/<id>/notes.jsonl` below). New notes append to the ledger only — never dual-write the row `notes`.

**`projects/<id>/residuals.json`** — project register (**migration history**; entries keyed by plan id, each an ARRAY):

```json
{
  "entries": {
    "plan-id": [
      {
        "id": "R1",
        "title": "Finding title",
        "severity": "critical | high | medium | low | nit",
        "source": "QC-#1 qc1.md F-001 @ <review-range>, QA qa.md, review, …",
        "scope": "Affected file or component",
        "decision": "defer | accept | risk-accepted",
        "owner": "@fullstack-dev",
        "target": "Before plan 02 / YYYY-MM-DD / milestone",
        "tracking": "Issue URL or null",
        "detail_doc": "{PLAN_DIR}/residuals/plan-id/R1-short-label.md",
        "source_plan": "plan-id",
        "registered_at": "YYYY-MM-DD",
        "lifecycle_id": "<workflow id when owned by an iteration>"
      }
    ]
  }
}
```

- `entries[<plan-id>]` values are **arrays** — v1 `residual_findings[plan-id]` multi-finding semantics preserved verbatim (a plan may hold 2+ open residuals).
- Register entries = the v1 residual entry **verbatim** + provenance: `source_plan` (must equal its entries key), `registered_at` (`YYYY-MM-DD`), optional `lifecycle_id` (owning workflow id when an iteration owns the plan).
- Project-less flows use the fallback **`_default`** project (`projects/_default/`).
- Register document validation delegates verbatim to `validateResidual` (severity enum + lifecycle states preserved at the new address).

**`projects/<id>/roadmap.md`（legacy Markdown transport）** — frontmatter、`milestones` 与 body 的内容校验以及 store-authoritative 读写规则只见 **`mstar-project-governance`**「Roadmap 内容权威与编写约定」。本文件不另立文件读写/schema 家。


**Closed entries** add: `lifecycle`, `closed_at`, `closure_note`; optional `closure_evidence`, `superseded_by`. See “Residual findings lifecycle”.

**Open `detail_doc` (optional):** repo-relative path under **`{PLAN_DIR}/residuals/<plan-id>/`** matching **`id`** (e.g. `R1`); omit if prose layer unused (`knowledge-and-designs.md`).

## Fail-loud handoff contract

Findings must pass engine validation **before** they are captured: the capture path (`mstar issue add` / `mstar plan issue-add`) validates the capture input at the domain boundary and refuses a malformed submission (exit 1, nothing written) — a capture never degrades into a silent partial write.

The **migrated register documents** keep their document validators: `validateResidual(entry)` per entry, `validateProjectRegister(doc)` for the whole register. Migration-source snapshots and the v2 root are validated by `validateWorkflowSnapshot` / `validateStatus` inside the migration tooling, not by a path argument to `mstar status validate` (a path is refused; the command reads the ACTIVE authority only). Malformed register entries — **non-object**, missing any of the nine required fields (`id`, `title`, `severity`, `source`, `scope`, `decision`, `owner`, `target`, `tracking` — mirroring engine `RESIDUAL_REQUIRED_FIELDS` in `packages/engine/src/status.ts`), or **`severity`** / **`decision`** outside their enums (`status.residual.invalid-severity` / `status.residual.invalid-decision`) — are **rejected** (`ok:false` + violation): fix and rewrite — never silent pass-through, downgrade-write, or "write then patch". A *lifecycle* value such as `"resolved"` in `decision` leaves the **whole register unwritable** — `validateProjectRegister(doc)` then fails the document, so the engine refuses every subsequent write to that register, not just that entry. The register itself is **replacement-retired** as a writer target (engine refuses it with `coordination.store`, naming `store.db` as the only findings authority).

dsh-derived findings map their keys per the engine-residual validation verification spec §5; dsh keys never enter the schema.

---

## Residual findings: `severity` (SSOT, machine field)

Each captured issue's — and each migrated register entry's — **`severity`** must be from this enum. QC report Markdown **Critical / Warning / Suggestion** are **section titles** — **do not** copy them verbatim into JSON `severity`.

### 1. Allowed values

Only these five, **lowercase English**:

`critical`, `high`, `medium`, `low`, `nit`

### 2. Total order (heavy → light)

`critical` > `high` > `medium` > `low` > `nit`

- **`nit` is always lighter than `low`** — never invert or equate.
- **Forbidden** in JSON: `warning`, `Major`, non-English, or any value not listed.

### 3. Meaning and gate relationship

| `severity` | Meaning |
| ---------- | ------- |
| `critical` | **Unsafe to ship, reachable on this merge** — correctness bug, security hole, data loss, or broken public contract whose unsafe outcome can be triggered here; merge-blocking. Maps to QC **Critical** findings. |
| `high` | Not blocking — the same unsafe-to-ship classes whose unsafe outcome is **not reachable on this merge** (narrow reach, unreachable path, or already mitigated), **or significant tech debt**; fix, escalate, or open a residual with PM follow-up. |
| `medium` | Should address this or next milestone; may be open residual. |
| `low` | Small impact, cheap fix; may be open residual. |
| `nit` | Style, naming, wording, non-behavior doc nits; **lighter than `low`**. PM may omit from the register if no tracking needed. |

Summary vs `mstar-review-qc`: unresolved **`critical`** → usually `Request Changes`; **`high`** often “fix or explicit decision before merge”; **`medium` / `low` / `nit`** may ship with residual tracking (final **Verdict** = PM consolidation).

### 4. QC report section → JSON `severity`

Grade by **what would happen if the finding is true**, never by how uncertain you are. Whether a finding blocks turns on whether its unsafe outcome is **reachable on this merge** — the axis defined in §3 — and not on the report section (Critical / Warning / Suggestion) it was filed under; the filing is a routing hint, not a severity decision. Two classes reach `high` or above: (a) **unsafe to ship** — correctness, security, data loss, broken public contract → `critical` / `high` even at low confidence; (b) **significant tech debt** → `high`. Everything else stays below: documentation accuracy, citations/line numbers, naming, wording, and test polish are `low` / `nit` — including inside a normative document — **unless the defect would itself drive an unsafe outcome** (a normative instruction that leads an executor into a correctness, security, or data failure), in which case it grades by that consequence. Evidence confidence belongs in the report (`Confidence`), not encoded by inflating `severity`. When the uncertainty is about **scope** (reachability) rather than severity class, record the worst-case class among the plausible ones and state the open question in the entry's `scope`.

When registering into the project register (template in `mstar-review-qc`):

| Report Findings section | JSON `severity` |
| ----------------------- | --------------- |
| **Critical** | Default `critical`. PM may record `high` only when the §3 axis puts the unsafe outcome outside reachability on this merge, with the reasoning stated in `title`/`scope`. |
| **Warning** | `medium` for ordinary substantive non-blocking items. A security/correctness/data finding follows the same §3 reachability axis as the **Critical** row: `high` when the unsafe outcome is not reachable on this merge, `critical` when it is — note the Warning filing in `title`/`scope`. |
| **Suggestion** | `low` or `nit`: substantive improvement → `low`; pure style/optional → `nit`. |

**Common mistake:** report **Warning** is not a valid `severity` string; there is no `warning` in the enum (see legacy below).

### 5. Cross-chain vocabulary (one axis, four labels)

The blocking judgement is decided **once**, on the §3 axis. Each chain's label set is a different projection of that one decision — map by **axis band**, never by label shape:

| Blocking judgement (§3 axis) | register `severity` | audit Merge class | plan-QC report section | L2 task review |
| ---------------------------- | ------------------- | ----------------- | ---------------------- | -------------- |
| **Blocking** — unsafe outcome reachable on this change/merge | `critical` | `must-fix` | **Critical** | `Critical` |
| High impact, non-blocking — unsafe but not reachable here, or significant tech debt | `high` | `should-fix` | **Warning** | `Important` |
| Substantive, non-blocking — below the above | `medium` | `should-fix` | **Warning** | `Important` |
| Small and cheap | `low` | `nit` | **Suggestion** | `Minor` |
| Style / naming / wording | `nit` | `nit` | **Suggestion** | `Minor` |

**A cross-chain translation never changes the judgement** — a label is a projection of the axis, so moving a finding between chains must not promote or demote it.

### 6. Legacy `"severity": "warning"`

In old JSON, **`"severity": "warning"`** is read and rolled up as **`low`**. **Forbidden** on new entries.

---

## Findings cleanup modes

Plan-level policy for whether non-blocking QC/QA findings may remain as **open issues linked to the plan** or must be cleared in the current plan session.

### Effective coordinator configuration

Ordinary prepare records cleanup `zero-residual | allow-residual`; absent configuration defaults to allow-residual. This remains revisable during active execution and requires no ceremonial prepare record. Leaf Assignments mirror the selected policy for review/evidence duties, not a sealed authority. The issue store remains the sole findings store.

**Defaults**

| Context | Default |
| ------- | ------- |
| Formal iteration Phase 2 | `allow-residual`; explicit coordinator/user policy may select zero-residual through ordinary prepare |
| Standalone `/pm`, hotfix, `Execution mode: inline` | `allow-residual` |

### `zero-residual` (clean-session)

Intent: clear findings in the current plan session whenever possible. Open items only for **true blocker-defers**.

1. After QC: default path is **fix-now + targeted re-review**, not `Approve with residuals`.
2. Do **not** capture an open issue for items that can be fixed in this session.
3. **`nit`**: fix in-session **or** drop with no capture (existing “no tracking needed”); **never** capture style-only nits.
4. **`Approve with residuals`** only when every remaining open item is a true blocker-defer (Durable Roadmap Gate written) — **except `critical`** (unsafe outcome reachable on this merge, §3): a `critical` is fixed now, or the risk is explicitly accepted and the issue is **closed** per item 6, never left open as the approval's remaining item.
5. **True defer** only: external dependency; product/scope decision for a later iteration; or explicit **current-turn** user defer — plus Durable Roadmap Gate.
6. **`waived` / `risk-accepted`**: still require PM + user/architect alignment; **close the issue** (do not leave it open). Prefer a cheap fix over waive-as-shortcut.
7. Plan **Done**: prefer **no open issue linked to the plan**. If any open issues remain, **every** one must be blocker-defer + roadmap and none may be `critical` (item 4); otherwise keep `InReview` / `Blocked`.

### `allow-residual`

Non-blocking open issues — `severity` below `critical` on the §3 axis — may ship with open items and `Approve with residuals` when no unresolved `critical` remains. This is the default mode (see Defaults above; `zero-residual` is the explicit opt-in). Capture and disclosure are hard duties under `allow-residual` — they replace the speed-vs-discipline tradeoff, not the audit trail:

1. **Capture before InReview exit**: every remaining open finding is captured as an issue **linked to this plan** with machine-enum `severity` before the plan leaves InReview (→ § Issue capture above).
2. **Disclose on every decision surface**: every consolidated QC decision, Completion Report, and Status Update states the open-item situation — the list, each issue's `severity`, and its tracking location (issue id). Silence about open findings is a gate violation, not a style issue; when nothing is open, say `N/A — none open`.
3. **Critical still blocks**: an unresolved `critical` blocks `Approve`; `medium` / `low` / `nit` may be captured and carried (fix-now remains preferred when cheap).
4. **Close-time disclosure**: close-time artifacts carry the same open-item list with `id` + `severity` + tracking location + blocker-defer flag — each plan's durable `## Review Gate Summary` (main plan), the iteration compass `## Quality Gate Summary`, and the PR delivery body (`N/A — none open` when empty). A close without these disclosures is not a close. Disclosure does not override critical-blocking, explicit `zero-residual` requirements, or the §4 closure authority: terminalizing a workflow never silently closes its open findings. `mstar status tech-debt` remains the cross-iteration visibility rollup.

> **Engine check (when available):** run `mstar status findings-cleanup <plan-id> [--mode zero-residual|allow-residual]` (or import `findingsCleanupGate` from `@mstar-harness/engine` in a host hook) to enforce the mode above against the **open issues linked to the plan** in `{HARNESS_DIR}/store.db`. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

---

## Execution plan-row fields

ACTIVE plan 行与冻结执行输入在 store `execution_*` 表；读取经 `mstar plan show`，变更经公共 plan/workflow 动词。迁移源 snapshot 里的 plan 行形状是 retained history；完整 v1 字段表 → **`mstar-engine-legacy`** `references/status-field-history.md`，不在此重复。

`id/title/file` 与规格/迭代 metadata 是 prepare 冻结输入，不是 catalog 编辑面；catalog 变更不静默刷新在途执行。知识关联载体是 catalog relations（`mstar catalog link`）；`plans[].metadata.knowledge_refs` 仅为 legacy 只读字段，不再写入 snapshot。SDD review bundle 与 durable gate summary 仍是文件产物（→ `references/plan-files-and-reports.md`）。

### Source scope and concurrent-write exclusion

Row `metadata.worktree_path` and `metadata.working_branch` record the source checkout/branch. Ordinary prepare supplies missing facts or revises a mistaken configuration; dispatch and direct completion validate the actual checkout. No per-plan identity or holder qualification is required.

Any retained execution exclusion is engine-managed bookkeeping inside ordinary coordinator actions, not a manual claim/release/transfer API. Completion releases applicable exclusion in its own transaction and retains source metadata/track Assignments for guarded cleanup. CAS, atomic transactions and operation receipts remain authoritative; age, labels and TTL never grant takeover.


### Migration-source snapshot top-level fields

| Field | Type | Semantics |
| --- | --- | --- |
| `integration_merge_lease` | object | While one integration merge is owned; **absent** = unclaimed. Writers **delete** the key on release — never `null` or tombstones |
| `execution_policy` | object | `plan_parallelism` / `worktree_mode` / `push_policy` — first-class (copied from v1 root `metadata` at migrate; values accepted-but-opaque this iteration) |
| `branch` | object | Iteration branch anchors: `base` (from `iteration_base_branch`), `integration` (the `spec_integration_branch`), `target` (final PR target) |
| `integration_worktree_path` | absolute path string | Migration-source record of the dedicated integration checkout (repository root, not `{HARNESS_DIR}`), on `branch.integration`, distinct from the main worktree. The main worktree is derived from Git (`readMainWorktree`), not stored as a snapshot field. Live integration-checkout registration is `mstar workflow integration-worktree`. |
| `compass_ref` | string | Relative pointer to the iteration delivery compass |
| `legacy_metadata` | object | Catch-all for unmapped v1 root-`metadata` keys at migrate |

### Snapshot `notes` vs `{WORKFLOW_DIR}/<id>/notes.jsonl`

- `plans[].notes`: per-plan timeline — **legacy verbatim copy** (read-only; preserved at migrate; never a dual-write target).
- `{WORKFLOW_DIR}/<id>/notes.jsonl`: **runtime notes ledger** — append-only; new notes go here only (`kind` + `ts` + `text` JSON lines; `mstar migrate` seeds it from v1 arrays).

---

## Iteration concurrent-write safety (Phase 2)

ACTIVE DB serializes domain writes with engine transactions, CAS and operation receipts. Feature checkouts never bootstrap another process store. Root `status.json` and workflow snapshots are not a second writer.

Actual writable tasks require L1/L2 isolation and recorded source facts, while integration merges remain serial in the recorded integration checkout. Read-only validators check facts, never replace coordinator operations. Runtime procedure → `mstar-iteration/references/phase-2-worktree-lease.md`; source/cleanup ownership → `mstar-branch-worktree`.


### Integration merge exclusion (ACTIVE `execution_integration_leases`)

One workflow-wide exclusion authorizing one plan feature branch integration into `branch.integration` (the `spec_integration_branch`). The migration-source snapshot spelled this object `integration_merge_lease`; absence means unclaimed. Live state is the store row. `mstar worktree check` reports the lease fact; it does not claim or release it.

| Field | Type | Required | Semantics |
| --- | --- | --- | --- |
| `holder` | non-empty string | Yes | Workflow-wide cooperative writer identity; not a per-plan PM seat. |
| `claimed_at` | RFC 3339 UTC (`Z`) | Yes | Acquisition time (audit only). |
| `plan_id` | non-empty string | Yes | `plans[].id` of the feature being integrated. |
| `source_branch` | non-empty string | Yes | Plan feature branch to integrate. |
| `target_branch` | non-empty string | Yes | Resolved `spec_integration_branch` — no other target is valid. |
| `session_label` | string | No | Display only. |

## Direct coordinator operations — sole runtime field home

The selected workflow has one primary coordinator. Every row operation explicitly addresses workflow and plan; coordinator references carry no per-plan scope. The ACTIVE store is the only execution route. Never clone process state into a feature checkout.

### Authority, CAS and receipts

| Item | Meaning |
|---|---|
| Root execution token | ACTIVE CAS for root creation/registration |
| Workflow execution token | ACTIVE CAS for coordinator binding, workflow transitions/evidence/close/recovery |
| Plan execution token | ACTIVE CAS for the selected row's ordinary mutations |
| Coordinator session reference | `exec-session-v1:<base64url>` names store/epoch/workflow/coordinator session; lookup, never bearer authorization |
| Operation id | Exact same request replays the recorded receipt; different semantics under the same id refuse |
| Plan coordination revision | Store row `coordination.revision`; not the execution token, a schema version, a date, a byte digest or mtime |

ACTIVE actions acquire caller identity independently and revalidate identity/root/store/epoch/row in their transaction. Session/token/operation defaults may be derived for unambiguous own scope; explicit values remain checked constraints. Resume is a read-only context lookup, never recovery or permission to replace an owner. CLI transport → `mstar-use-cli/references/plan-and-workflow.md`; iteration procedure → `mstar-iteration/references/phase-2-worktree-lease.md`.

### Stored coordination

| Level | Field | Meaning |
|---|---|---|
| Workflow | coordinator session | One workflow-wide ACTIVE binding (`execution_sessions`): `storeId`, `epoch`, `workflowId`, `role: coordinator`, `sessionId`. A session reference is a lookup, not a file path and not a bearer credential |
| Workflow | `coordination.identity_recoveries` | Migration-source recovery history only. Live coordinator recovery is `mstar session recover` |
| Row | `coordination.revision` | Row CAS revision |
| Row | `coordination.prepared` | `{qa_gate, findings_cleanup, prepared_by, prepared_at}`; ordinary configuration, no Assignment seal |
| Row | `coordination.progress` | `{status, summary, evidence_paths[], track_branches?}`; source/track ownership and plan-area evidence checks remain |
| Row | `coordination.completion` | Source branch/SHA/worktree, review base/head, hashed QC/QA evidence, optional verified integration result, completed_by/completed_at |

Source facts live in `metadata.working_branch`/`metadata.worktree_path`, not a prepared Assignment. QA defaults to `mandatory`, findings cleanup to `allow-residual`. Prepare may revise valid configuration while the row is active and never resets progress/status or locks plan prose. No ceremonial prepare record is required when ordinary defaults and metadata suffice.

Session references, tokens and operation IDs never travel to leaf implementers/reviewers. Public recovery output includes workflow/public session ids, receipt/replay and token/version facts; never credential material.

### Operations and evidence

| Operation | Effect/admission |
|---|---|
| `show` | Read the explicitly selected row and applicable operations |
| `prepare` | Revise source metadata and QA/cleanup configuration while row ≠ Done; validate actual checkout, not equality with an old config |
| `progress` | Todo → InProgress or Blocked; InProgress/InReview/Blocked transitions retain their ordinary meaning, never Done |
| `issue-add` / `issue-close` | Composed issue-store writes with existing closure authority and issue CAS; row ≠ Done |
| `complete` | From InReview, or entailed InProgress → InReview in the same transaction; accept QC `Approve | Approve with residuals`, QA `pass` matching effective gate and findings-cleanup requirements; write Done/completion and retain source metadata |

Completion takes `source_sha`, `review_base`, `review_head`, `qc {decision,reports,consolidated}`, `qa {gate,decision,report}` and optional `integration {base_sha,result_sha}`. Evidence paths are absolute existing files, recorded with informational digests. Exact replay never reruns Git or rewrites completed_at. No ownership-transfer state exists.

1. **Iteration/non-standalone:** integration pair required; prove the already-performed serial two-parent merge in the recorded target checkout, source/review ancestry, result reachability and clean target branch. Re-witness Git at commit. Row Done creates no child PR; parent retains compound/PR/merge/close.
2. **Standalone development:** source checkout/ref/clean HEAD must match registered source and evidence. Integration input refuses. Row Done precedes its own compound/PR/verified-merge/close tail.
3. **Standalone report-only:** integration input refuses; use already-recorded fulfilment matching registered completion_policy, plus QC/QA. QA pass is not policy fulfilment. Git fields are provenance only; no Git/integration proof or PR is invented. Evidence-backed terminal close remains.

Route selection uses workflow type, declared kind and cardinality, never missing anchors as an exemption. Source facts that cannot be safely derived are supplied by prepare. Refusals name missing facts/current operation; real Git conflicts require resolving/aborting Git, never raw state repair. Lost output after a successful merge means retry complete with the actual SHAs, not another merge.

Register files are migration history and have no live replacement writer; issue store is findings SSOT. Read-only validators remain checks. Workflow/root/lifecycle writes remain coordinator workflow operations, not row mutations.


### Prepare configuration and coordinator recovery

Prepare configuration revisions use `mstar plan prepare` on the ACTIVE route. Integration checkout and execution policy use `mstar workflow integration-worktree` and `mstar workflow execution-policy`. Coordinator recovery uses `mstar session recover`. There is no file-envelope writer and no snapshot structural-amendment writer.

---

## General constraints

- ACTIVE plan 行可含 optional **`metadata`**（prepare 冻结输入）。迁移源 snapshot 的 `plans[]` 不是第二份可编辑 catalog。
- root register 仅登记 active（`running` | `paused`）；ACTIVE close 在同一 store 事务里写终态并 unregister。
- plan id 与 `execution_plans`、linked issues、`{SDD_DIR}` plan-id segment 对齐；register `entries` key 对齐仅为迁移历史。不要存 `residual_findings_plan_id`。
- register 的 empty-key / `residual_summary` 规则仅描述迁移读入形状，不产生删除、更新或其它写入义务。

---

## Residual findings lifecycle (close, archive, remove)

### `lifecycle` (optional; default open)

| `lifecycle` | Meaning | `closure_note` should explain |
| ----------- | ------- | ----------------------------- |
| `open` | Not closed (omit field = open) | — |
| `resolved` | Fixed in code/config/docs and **verified** | What changed; how verified |
| `waived` | Explicit decision not to fix | Who decided; why; optional `tracking` Issue |
| `superseded` | Replaced by new finding/spec/refactor | `superseded_by` |
| `duplicate` | Duplicate of another R# | Canonical `id` or mistake note |

**On close:** set **`closed_at`** (`YYYY-MM-DD`) and **`closure_note`**; recommend **`closure_evidence`** (PR, commit, test, doc anchor).

### Who updates when

| Action | Owner | When |
| ------ | ----- | ---- |
| Implement fix | `@fullstack-dev` / assignee | Completion Report cites the issue id + evidence |
| Verify | `@qa-engineer` when **`QA gate: mandatory`**; else PM per acceptance checklist | Regression / acceptance; an open item is closed only after verify |
| Capture / close | **`@project-manager`** or **`@qa-engineer`** | Capture after the confirmed outcome, close after verification; waivers after PM + user/architect alignment. Live items go through the issue verbs (`mstar plan issue-add` / `issue-close`, or the unscoped `mstar issue …`), never a hand edit — the register is migration history |

Do not claim an issue “fixed” in chat/plan only without the store update.

PM should capture open items as issues after **`Approve with residuals`**; QA should state each related issue id (open / resolved this round / needs waiver).

### In-place closure shape of migrated register records

Live items close through the issue verbs and the §4 closure authority (`mstar issue close | waive | duplicate | supersede`; plan-scoped `mstar plan issue-close`); the mechanics below describe the **migrated register record** shape.

迁移历史中的 closed record 带 `lifecycle` / `closed_at` / 非空 `closure_note`，原记录与 durable plan summaries 可用于回溯。register 在任何 authority 状态下都已 replacement-retired（`coordination.store`）；不得据此 close/delete 条目或更新 root。活项只走上述 issue domain call，笔记经公共动词 append `notes.jsonl`。

### Historical transition / deletion semantics

旧 register 的 in-place close、empty-key removal 与 delete 规则仅供迁移解释，不是运行写路径。活项修正与关闭使用 issue disposition（重复项用 `duplicate`），不手改或删除迁移记录。

### Query open and closed (examples)

```bash
# Engine-check (read-only): open items in the store, migrated register docs, cleanup gate
mstar issue list                              # open issues in {HARNESS_DIR}/store.db
mstar status validate                         # ACTIVE authority + CAS tokens; a path argument is refused
mstar status tech-debt                        # open-issue rollup
mstar status findings-cleanup <plan-id>       # mode gate over the plan's linked open issues
```

- The v1 read paths (root `residual_findings` / `metadata.residual_findings` / `archived/residuals/<plan-id>.json`) are **legacy read-only** — `mstar migrate` moved open entries into the register; old files may remain for history. Register entries themselves are now superseded by store issues (`mstar issue list` / `mstar issue show`).

---

## `{WORKFLOW_DIR}/<id>/notes.jsonl` (per-workflow notes ledger)

Append-only JSON-lines log for merge closure, batch close, register refreshes, etc. Does not compete with store plan-row status (`execution_plans`) or the issue store's open-item SSOT.

```jsonl
{"kind": "note", "ts": "2026-04-08", "text": "Short milestone"}
```

- **`@project-manager`** maintains; do not rewrite past lines — add a correction as a new line.
- **`plans[].notes`**: per-plan legacy verbatim array; **`notes.jsonl`**: runtime ledger — new notes append here only (no dual-write).

---

## `mstar status tech-debt` (open-issue rollup)

**Role:** Cross-iteration aggregate over the **open issues** in `{HARNESS_DIR}/store.db`. Does **not** replace the store as the per-item SSOT. A missing, corrupt or staged store **refuses** (exit 1) — never an empty rollup.

**Compute (canonical):** CLI / engine (do **not** hand-count):

```bash
# Engine-check (when available): the CLI prints total_open / by_severity / by_project (informational exit 0)
mstar status tech-debt
```

- The legacy register-walking rollup (`techDebtRollup` over `{PROJECT_DIR}/<id>/residuals.json`, with the register-era `by_target` / `by_plan` aggregates) is **removed** (issue-governance cutover) — the engine no longer exports it. The rollup is computed from the **issue store** via the CLI (`readIssueRollup`): `total_open` / `by_severity` / `by_project`. The migrated register documents are mapping history only. The v1 stored-summary drift check (`metadata.tech_debt_summary`) is a **v1 dead path**.
- The rollup **does not write** anything.

---

## Pre-merge: plan state and the store should match reality

Before merge/PR, **`@project-manager`** (or delegate) should verify: plan status and gates on the store's execution rows, the plan's linked open issues in the store (no accidental leftovers), vs review/CI.

**Common gaps:**

- An issue was opened/closed but the review surfaces still show the old state.
- Finding only in `plans[].notes` or chat, not captured as an issue.
- Major milestone with no `notes.jsonl` entry when team uses the workflow ledger.

## Compatibility: plan key names

- Read: accept `id` or `plan_id` (v1 rows / entries read compatibility).
- Write: one canonical key (prefer `id`).
- Document the canonical key in `{HARNESS_DIR}/AGENTS.md` if migrating.

## Common queries

```bash
# Engine-check (recommended): read the ACTIVE authority / the store rollup
mstar status validate                                     # ACTIVE authority + CAS tokens
mstar plan show <plan-id>                                 # ACTIVE plan row; scope/options from help
mstar status tech-debt                                    # open-issue rollup
```
v1 trees (root `plans[]` / `residual_findings`) are migrated first: `mstar migrate [--dry-run] [--path <root>]`.
