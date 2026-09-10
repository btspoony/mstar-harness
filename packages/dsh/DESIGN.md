---
version: 0.2.0
name: "MStar Panel Design System"
description: "Design contract for the Morning Star workflow panel of the @mstar-harness/dsh plugin — the right-Sidebar page tab's stacked-list layout / flow / emphasis / interaction tokens, consumed through host aliases (--dsw-alias-*), zero bare hex. This is the Light theme; the Dark theme shares the same token names with different values at /DESIGN.dark.md."

# ── Host alias tokens (name-level interface) ────────────────────────────────
# Values belong to the dsh web host theme (design-platform.css) and flip per
# theme. Declared here at NAME level only — this doc never copies host hex
# (drift rule; the `colors:` group pins only the panel semantic tokens the
# panel itself introduces).
dswAlias:
  bg-layer-1: --dsw-alias-bg-layer-1
  border-l1: --dsw-alias-border-l1
  border-l2: --dsw-alias-border-l2
  label-primary: --dsw-alias-label-primary
  label-secondary: --dsw-alias-label-secondary
  label-caption: --dsw-alias-label-caption
  state-business-primary: --dsw-alias-state-business-primary
  state-error-primary: --dsw-alias-state-error-primary
  state-success-primary: --dsw-alias-state-success-primary
  state-warn-label: --dsw-alias-state-warn-label

colors:
  # Panel semantic color tokens — pinned LIGHT values (host-alias provenance
  # in comments; runtime consumption stays alias-based, zero bare hex in CSS).
  # background-100: panel surface = --dsw-alias-bg-layer-1
  background-100: "#ffffff"
  # gray-1000: primary label = --dsw-alias-label-primary
  gray-1000: "#0f1115"
  # gray-900: secondary label = --dsw-alias-label-secondary
  gray-900: "#61666b"
  # gray-400: caption label = --dsw-alias-label-caption
  gray-400: "#adb2b8"
  # blue-700: business accent = --dsw-alias-state-business-primary
  blue-700: "#4176e6"
  # red-700: error = --dsw-alias-state-error-primary
  red-700: "#ec1313"
  # amber-700: warn = --dsw-alias-state-warn-label
  amber-700: "#dd8629"
  # green-700: success = --dsw-alias-state-success-primary
  green-700: "#22c55e"

typography:
  # Font ramp consumed via --dsw-font-xxxs-11 / xxs-12 / xs-13; family
  # inherits the host --dsw-font-family stack.
  heading-13:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"
    fontSize: 13px
    fontWeight: 600
    lineHeight: 20px
    letterSpacing: 0
  heading-11:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"
    fontSize: 11px
    fontWeight: 600
    lineHeight: 14px
    letterSpacing: 0
  copy-13:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 20px
    letterSpacing: 0
  copy-12:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 18px
    letterSpacing: 0
  copy-11:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"
    fontSize: 11px
    fontWeight: 400
    lineHeight: 14px
    letterSpacing: 0

spacing:
  base: 4px
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  5: 24px
  6: 32px

rounded:
  sm: 8px
  full: 999px

# ── List semantic tokens (design doc §1 / §2 / §3.5) ───────────────────────
# The `canvas:` group survives the sidebar re-layout PRUNED to what the
# stacked lists still consume: the three emphasis-* opacity tiers
# (theme-independent, §3.5) and the list's row metrics (theme-independent,
# ramp-equivalent — §Spacing & Layout). The deleted canvas's column /
# card-box / port / edge geometry tokens are gone with it.
canvas:
  row-gap: 4px        # entity-row gap = --mstar-space-1 (.cardList)
  group-gap: 16px     # group-grid gap = --mstar-space-4 (.groupGrid); 12px (--mstar-space-3) in the ≤480px container
  label-h: 14px       # group/stage/sub-bucket label row line box (--dsw-font-xxxs-11 = 11px/14px; line-height-driven, no fixed height)
  emphasis-current: 100%
  emphasis-next: 75%
  emphasis-off: 45%
---

<!-- COMPLETENESS_LEVEL: 1 — last audited 2026-09-11 -->

# MStar 面板设计系统（MStar Panel Design System）

> **Canonical package-level design contract** for the Morning Star workflow
> panel of `@mstar-harness/dsh`. The panel is a dsh **right-Sidebar page tab**
> (one tab, `kind: 'mstar-workflow'`, opened from the sidebar guide page's
> capsule) laid out for the narrow docked column. The former
> conversation-area view tab and its agent-execution canvas (absolute
> geometry, SVG edges, pointer pan) are superseded — this contract now
> describes the realized stacked-list surface. Consumers:
> `@frontend-dev` / `@fullstack-dev` implement styled panel UI;
> `@qc-specialist` verifies alignment; `@qa-engineer` verifies visual output.

## Overview

MStar Panel Design System is a **minimal, evidence-driven design contract**
for the panel surfaces: readability and signal clarity in a 300–500px
docked column over decoration. One DOM, one structure — width changes the
grid, never the tree; the flow is carried by fixed group order + headings,
not by lines; emphasis is time-driven; and every color is a verified host
alias token.

- **Audience**: the panel's three sections (任务迭代 / 代理执行 / 事件记录),
  the workspace-state digest, and the shared iteration info section.
- **Aesthetic principles**: zero bare hex; flow content over absolute
  geometry (the rows grow the panel's single scroll body); heading-carried
  flow (no edge layer, no ports, no pan); status always full-opacity;
  dark mode is the host alias flip — no theme branch.
- **Seat**: one right-Sidebar page tab with a guide-page capsule entry
  (`order: 20`); the body and its chip title register as keyed seats under
  the definition id. No auto-open, no duplicate surface; a second capsule
  pick focuses the existing tab (host dedup rule). While the column is
  collapsed or another tab is active (`tab.visible === false`) the body
  renders nothing.
- **Theme**: this file is the **Light** theme. The **Dark** theme uses the
  same token names with different values and lives at
  [`DESIGN.dark.md`](DESIGN.dark.md) (host alias flip; the list row metrics
  and emphasis tiers are theme-independent, so only the `colors:` values
  change).

### 0.4 Shared surfaces（迭代信息 Section 共用）

- The **iteration info section** (iterationId / verdict / status note +
  the vertical 5-step stepper + the branches panel) is a SINGLE component —
  `IterationInfoSection` — rendered by BOTH the tasks page (任务迭代) and
  the agents page (代理执行) from the SAME `view.iteration` data. One
  implementation, two mounts — no per-section drift; the `data-iteration-*`
  anchor family is unchanged.

All concrete token values live in the **YAML frontmatter above** (colors,
typography, spacing, rounded, plus the `dswAlias` name-level host interface
and the pruned `canvas` semantic group). The body below explains rules,
intent, and agent guidance. Host alias tokens are declared **by name only**
— the dsh web host theme owns their values (`design-platform.css`), so this
contract never copies host hex (drift rule).

## Colors

Token values are defined in the frontmatter `colors:` map. The panel
consumes **zero bare hex**: every rendered color is a `--dsw-alias-*` host
alias (listed by name in the `dswAlias:` group; values flip per theme),
pinned below with concrete light values.

| Panel role | Token | Light value | Host alias (provenance) |
|-------------|-------|-------------|--------------------------|
| Surface (shell / rows / group frames) | `background-100` | `#ffffff` | `--dsw-alias-bg-layer-1` |
| Primary label (titles) | `gray-1000` | `#0f1115` | `--dsw-alias-label-primary` |
| Secondary label | `gray-900` | `#61666b` | `--dsw-alias-label-secondary` |
| Caption (record rows, dim) | `gray-400` | `#adb2b8` | `--dsw-alias-label-caption` |
| Business (running, active nav) | `blue-700` | `#4176e6` | `--dsw-alias-state-business-primary` |
| Error / denied | `red-700` | `#ec1313` | `--dsw-alias-state-error-primary` |
| Success (done frame + ✓) | `green-700` | `#22c55e` | `--dsw-alias-state-success-primary` |
| Warn (advisory) | `amber-700` | `#dd8629` | `--dsw-alias-state-warn-label` |

- Border colors ride `--dsw-alias-border-l1` (rest) / `--dsw-alias-border-l2`
  (hover) — host alias, name-level.
- **Done frame**: a settled entity with `emphasis ≠ 'off'` gets a
  **standalone green frame** — success border + 1px ring on the ROUNDED row
  body (§1.4) + the green ✓ in the status point — full-strength
  `--dsw-alias-state-success-primary` (an EVIDENCE state, never
  chrome-mixed / never faded by the emphasis tier, §3.4). `emphasis ===
  'off'` (already-passed / stage-less on-demand + general roles) renders
  **neither** — the completed state never appears on an off-tier role.
- **Emphasis chrome** (§3.4): row chrome colors are mixed toward the layer
  background by the emphasis tier alpha
  (`color-mix(in srgb, <chrome> var(--mstar-chrome-alpha), var(--dsw-alias-bg-layer-1))`)
  — never a whole-row `opacity` (status point + running glow stay
  full-opacity, the highest-priority rule).
- **Hover feedback** is a 150ms border step `border-l1 → border-l2` (120–150ms
  window); running rows keep the business border.

## Typography

Token values are defined in the frontmatter `typography:` map. The panel
rides the host font ramp `--dsw-font-xxxs-11 / xxs-12 / xs-13` (family
inherits the host `--dsw-font-family` stack); sizes and weights are the
design contract.

| Role | Token | Size / weight | Usage |
|------|-------|---------------|-------|
| Page title | `heading-13` | 13px / 600 | section page titles (代理执行 list title) |
| Row title / group label | `heading-11` | 11px / 600 | entity name (idle rows use displayName) |
| Body / summary | `copy-13` | 13px / 400 | general panel text |
| Note / muted line | `copy-12` | 12px / 400 | muted degradation note |
| Record rows / caption | `copy-11` | 11px / 400 (tabular-nums) | session id · task tag, legend, counts |

## Spacing & Layout

Token values are defined in the frontmatter `spacing:` / `rounded:` maps and
the pruned `canvas:` group.

### Spacing ramp (`--mstar-space-1..6`, panel root)

| token | value |
|-------|-------|
| `--mstar-space-1` | 4px |
| `--mstar-space-2` | 8px |
| `--mstar-space-3` | 12px |
| `--mstar-space-4` | 16px |
| `--mstar-space-5` | 24px |
| `--mstar-space-6` | 32px |

Application rule: small inside-row gaps (1–2) → between groups (2–3) →
between page sections (3–4). All vertical rhythm comes from the ramp — the
panel declares no out-of-ramp spacing.

### Radius (unified 8px/999px pair)

| token | value | usage |
|-------|-------|-------|
| `rounded.sm` | 8px | entity rows, group frames, iteration head |
| `rounded.full` | 999px | status dots, count/role/badge capsules, step badges |

**Row single-outline rule (carried over from the card contract)**: an entity
row has exactly **one** visible outline — the `border-radius: 8px` row body.
Running / done ring and glow must be applied to the rounded element itself
(box-shadow on the rounded body); never stack `box-shadow`/`outline` on a
`border-radius: 0` outer container (no square-over-rounded layering).

### List row metrics (`canvas:` group survivors — theme-independent)

The stacked lists consume three vertical metrics. They are ramp-equivalent
(documented against the realized CSS, not free values):

| token | value | realization |
|-------|-------|-------------|
| `canvas.row-gap` | 4px | the entity-row gap inside a card list (`--mstar-space-1`) |
| `canvas.group-gap` | 16px | the shared group-grid gap between groups (`--mstar-space-4`; 12px `--mstar-space-3` in the ≤480px container) |
| `canvas.label-h` | 14px | the group/stage/sub-bucket label row line box (`--dsw-font-xxxs-11` = 11px/14px — line-height-driven, no fixed height) |

### Breakpoints (container queries — the ONLY width signal)

The panel's width is a fraction of the sidebar column, never the viewport,
so the shell carries `container-type: inline-size` and the width rules are
**`@container` rules**. Viewport media queries are never used for panel
layout (the root's own `prefers-reduced-motion` media rule is a motion
concern, not a width signal).

| Container width | Rule | Structural effect |
|-----------------|------|-------------------|
| base (always) | `.groupGrid { grid-template-columns: minmax(0, 1fr); gap: var(--mstar-space-4) }` | one column of groups |
| `@container (max-width: 480px)` | shell padding + group gap tighten to `--mstar-space-3` | compact rhythm at the 300px floor — no structural change |
| `@container (min-width: 720px)` | `.groupGrid { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)) }` | the group grid spreads to two columns — the ONLY structural change any width makes |

The same `.groupGrid` class is shared by the plan-status groups (任务迭代)
and the agent groups (代理执行), so the wide behaviour is one rule, not a
second layout. One DOM, one structure: the anchor tree is identical at
every width.

## Panel Structure & Flow

### 1. Layout & structure（布局与结构 — 堆叠分组列表）

#### 1.1 面板壳层（三区单列）

The shell is a single flex column with exactly three zones:

```
[data-mstar-panel]                     flex column · height 100% · overflow hidden · container-type: inline-size
├── [data-mstar-tab-nav]               flex: none  — the 3 internal sections (任务迭代 / 代理执行 / 事件记录)
├── [data-mstar-scroll]                flex: 1 1 auto · min-height: 0 · overflow-y: auto · overflow-x: hidden
│   ├── active section content          [data-mstar-page="tasks|agents|events"]
│   ├── [data-mstar-section="state"]   the workspace-state digest, in flow
│   └── [data-mstar-legend]            agents section only; in flow below the list
└── [data-mstar-meta]                  flex: none — version + harness dir (pinned, never scrolls)
```

- **Scroll ownership is singular**: the root never overflows its host
  (`scrollWidth === clientWidth`, `scrollHeight === clientHeight`);
  `[data-mstar-scroll]` is the ONLY element in the panel that declares
  `overflow-y: auto`; no element declares `overflow-x: auto|scroll`. The
  per-page scrollers of the pre-sidebar layout are retired — pages are flow
  content.
- **No JS layout measurement**: the panel performs no `ResizeObserver` /
  `IntersectionObserver` / `getBoundingClientRect` / `offsetWidth` /
  `clientWidth` reads — the width signal is the container query alone.
- **Section state** lives in the entry's slot store keyed by tab record, so
  the selected section survives the body's unmount while another pane tab
  is active. `tab.visible === false` renders nothing (no projection, no
  digest, no DOM).

#### 1.2 代理执行页的分组结构（group / stage / sub-bucket）

The agents page is a **vertical grouped list**. Two grouping levels, both
driven by the **projection** (never a render guess); the outer group is the
phase of the entity's `stage` (or `entity.zone` when `stage === null`), the
inner group is the stage with the implementor stage split by the projected
`entity.bucket`:

| # | Group (anchor) | Members |
|---|----------------|---------|
| 1 | `data-agent-group="iteration-start"` (Phase 1 label) | stage `review-edit-chain`: product-manager, architect, writing-specialist |
| 2 | `data-agent-group="autonomous-execute"` (Phase 2 label + the current-plan chip: `data-agent-group-plan`, `+N more` via `data-agent-group-plan-more`, muted「无进行中 plan」via `data-agent-group-no-plan`) | stages `sdd-implement`, `qc-tri`, `qa-gate` |
| 2a | `data-agent-stage="…:sdd-implement"` → `data-sub-bucket="implementor"` | fullstack-dev, fullstack-dev-2, frontend-dev (flow order) then ops-engineer, prompt-engineer (on-demand, `data-agent-on-demand`) |
| 2b | same stage → `data-sub-bucket="reviewer"` | code-reviewer (idle included) |
| 2c | `data-agent-stage="…:qc-tri"` | qc-specialist, qc-specialist-2, qc-specialist-3 |
| 2d | `data-agent-stage="…:qa-gate"` → `data-sub-bucket="unknown"` last | the `general` bucket (`zone: 'general'`), rendered only when it has cards |

Every stage group always renders (the projection always yields the full
14-role roster as cards, idle at minimum); only `unknown` is conditional on
having members. Phase groups ride the shell's shared `.groupGrid`
(`grid-template-columns` per the container-query table above).

#### 1.3 行规格（entity row anatomy）

The entity row is a **full-width flow row**: no `left/top/width/height`
inline style, no `position: absolute`, no ports, no `<svg>`.

| 属性 | 值（token） | 说明 |
|------|------------|------|
| 圆角 | 8px（统一半径对） | `rounded.sm` |
| 边框 | 1px `--dsw-alias-border-l1` | hover → `--dsw-alias-border-l2`（150ms） |
| 背景 | `--dsw-alias-bg-layer-1` | 与壳层同层 |
| 内距 | `--mstar-space-2`（8px） | 行内 gap `--mstar-space-1`（4px） |
| 标题 | `copy-11` weight 600，色 `--dsw-alias-label-primary` | 实体名（idle 行用 displayName） |
| 状态点 | 8px 圆点（settled 为 12px ✓） | §4.3 |
| 记录行 | `copy-11` 等宽，色 `--dsw-alias-label-caption` | session id · task tag（辅助字段，非标题） |
| 角色 chip / ×N / 徽标 | `copy-11`，胶囊 `rounded.full` | on-demand 徽标 = 虚线 business 边框胶囊 |
| **完成态** | 绿框 = success 边框 + 1px ring（圆角行体）+ 状态点绿 ✓ | **仅 `settled && emphasis ≠ 'off'`**（`data-agent-done="true"`）；off 档角色**不显示**绿框与 ✓ |

#### 1.4 任务迭代与事件记录的结构

- **任务迭代**: the iteration head (collapsed summary when inactive) → the
  **vertical** 5-step stepper (one row per step: badge · phase · chip ·
  reserved verdict seat — every `data-step-*` anchor and the four-state
  `current`/`next`/`done`/`idle` machine preserved) → the plan board as
  **five stacked groups** in constant order (each: flow glyph +
  `data-kanban-arrow`, localized state name + `data-kanban-count`, plan
  rows `data-plan-id`/`data-plan-status`, and the 「更多」/「收起」 toggle
  `data-kanban-more`) → project rollup → the digest, all in flow.
- **事件记录**: two partitions (Agent 流转事件 / 违规记录) as flow content —
  every row an expandable native `<details>` carrying the full catalog
  fields (a missing field renders 「—」, never a guessed value); no
  partition-owned scroller (the rows grow `[data-mstar-scroll]`).

### 2. Flow semantics（流转语义 — 列表的流规则）

Status: **supersedes the deleted line semantics**. The agent-execution
canvas's SVG edge layer (bezier curves, card ports, markers, supervise
lighting, the H1/H2 geometry rules) and the pointer-pan subsystem died with
the canvas. The list carries the flow with **zero lines**:

| # | Rule | Realization |
|---|------|-------------|
| F1 | Flow order is carried by **fixed group order + headings** | group order = `EXPECTED_ROLE_FLOW` constant order (§1.2); stage / sub-bucket headings carry the pipeline context — no edge, arrow, or port is drawn |
| F2 | **Zero geometry-bearing elements** | `[data-mstar-page="agents"]` contains zero `<svg>` elements, zero `data-agent-port` attributes, zero `data-canvas-*` attributes, and no pan transform |
| F3 | Rows are flow content | no absolute positioning, no inline box style; the rows grow the panel's single scroll body — the page owns no scroller |
| F4 | "Current position" is carried by state, not lines | the running row's business ring + glow pulse and the status point (§4.3) mark execution; the emphasized tiers (§3) mark expectation |

**Removed-line-semantics record (SUPERSEDED)**: the former two semantic
line classes (`actual` handoff / `supervise` sub-bucket edge), the 4-port
card anchor system, the standoff retreat, and the H1 (arrow along the local
tangent) / H2 (line never crosses text) hard rules described decision
points D1–D3 / D8–D15 (§6) — those decisions are **superseded** by this
section (F1–F4), kept in the review record for provenance rather than
silently deleted.

### 3. Emphasis tiers（透明度分级，用户复核定稿）

Status: **用户复核定稿** — 分级驱动源与映射规则为用户决策（不可改）；档位
数值、粒度、on-demand 归属按推荐定稿。投影驱动，迁移未改动语义，仅从卡片
chrome 应用点移到流行（flow row）。

#### 3.1 分级模型

`AgentEntityView` 透明度分级字段（投影层）：

```
emphasis: 'current' | 'next' | 'off' | null
```

| 值 | 语义 | 呈现 |
|----|------|------|
| `'current'` | 当前迭代阶段角色（预期正参与） | 不透明高亮（chrome 全强度） |
| `'next'` | 后续阶段角色（预期但未轮到） | 中透明度 |
| `'off'` | 已过阶段角色 / 无阶段角色（on-demand、general 桶） | 低透明度 |
| `null` | 无迭代 / plan（`currentStep` null） | **不应用透明度覆盖**，保持现状 idle 处理 |

> **正交性**：`emphasis` 是**时间维**（阶段推进），与 `bucket`（空间维，
> 同组分区分区）和 `zone`（组归属）**独立叠加**。

#### 3.2 角色 → 阶段映射表（`KNOWN_AGENTS` 14 roster）

| 角色 | `entity.stage` | 阶段（`PHASE_IDS` rank） | zone | bucket |
|------|---------------|-------------------------|------|--------|
| product-manager | review-edit-chain | iteration-start（1） | flow | null |
| architect | review-edit-chain | iteration-start（1） | flow | null |
| writing-specialist | review-edit-chain | iteration-start（1） | flow | null |
| fullstack-dev | sdd-implement | autonomous-execute（2） | flow | implementor |
| fullstack-dev-2 | sdd-implement | autonomous-execute（2） | flow | implementor |
| frontend-dev | sdd-implement | autonomous-execute（2） | flow | implementor |
| code-reviewer | sdd-implement | autonomous-execute（2） | flow | reviewer |
| qc-specialist | qc-tri | autonomous-execute（2） | flow | null |
| qc-specialist-2 | qc-tri | autonomous-execute（2） | flow | null |
| qc-specialist-3 | qc-tri | autonomous-execute（2） | flow | null |
| qa-engineer | qa-gate | autonomous-execute（2） | flow | null |
| ops-engineer | null | —（on-demand） | on-demand | implementor |
| prompt-engineer | null | —（on-demand） | on-demand | implementor |
| general | null | —（general 桶） | general | null |

> `EXPECTED_ROLE_FLOW` 阶段仅覆盖 Phase 1–2；Phase 3–5 无期望阶段 → 这些阶段
> 下所有 pipeline 角色归 `'off'`。

#### 3.3 分级派生公式（复用既有投影字段，零新 catalog 读取）

```
currentPhase = PHASE_IDS[currentStep - 1]        // currentStep: 1-based; null → 无覆盖
phaseRank(p) = PHASE_IDS.indexOf(p)              // 0..4

emphasis(entity) =
  currentStep === null                          → null          // 无迭代/plan：不覆盖（idle 现状）
  entity.stage === null                         → 'off'         // 无阶段角色（on-demand / general 桶）
  phaseRank(entity.stage.phase) < phaseRank(currentPhase)  → 'off'   // 已过阶段
  phaseRank(entity.stage.phase) === phaseRank(currentPhase) → 'current'
  otherwise                                     → 'next'        // 后续阶段
```

**预期参与者集合**：从 `EXPECTED_ROLE_FLOW` 的 `stage.phase` 派生——当前 phase
对应 stage 角色并集 = `'current'`；后续 phase = `'next'`；其余 = `'off'`。

#### 3.4 与 running/settled 状态点的叠加规则

- **状态点最高优先级**：`opacity` 只作用于**行 chrome**（背景、边框、行内
  文字、角色 chip、记录行、徽标）；**状态点（dot / ✓ / running ring + glow）
  保持全不透明**。
- **实现机制**：**禁止整行 `opacity` 属性**（父级 opacity 会连带状态点变淡）；
  采用 chrome 色值按档位 alpha 混合（`color-mix`，混合基 =
  `--dsw-alias-bg-layer-1`）——行级 `--mstar-chrome-alpha` 变量按
  `data-agent-emphasis` 档位切换。
- 叠加规则：`emphasis`（时间维）与 `entity.status`（证据维）独立叠加——
  running 辉光与状态点永远全不透明；idle 行虚线 muted（border-style）与
  emphasis（opacity）作用于不同属性面，互不冲突。
- **settled 完成态排除规则（硬约束）**：`settled` 的绿 ✓ + 绿框**只在
  `emphasis !== 'off'` 时显示**（`data-agent-done="true"`）；`emphasis ===
  'off'`（已过阶段 / 无阶段 on-demand + general 角色）的 settled 实体显示
  **灰字圆点**——**已完成状态不能在无阶段角色上出现**。
  `emphasis === null`（无迭代）时 settled 维持原 ✓ 语义。
- 无迭代（`emphasis === null`）时：不套用任何档位，行维持现状。

#### 3.5 透明度 token（`canvas:` 语义 token，深浅同值）

| token | 值（定稿档位） | 语义 |
|-------|----------------|------|
| `--mstar-canvas-emphasis-current` | 1（100%，不透明） | chrome 全强度 |
| `--mstar-canvas-emphasis-next` | 0.75（75%） | 中透明度（预期但未轮到） |
| `--mstar-canvas-emphasis-off` | 0.45（45%） | 低透明度（无关 / 已过 / 无阶段） |
| `--mstar-canvas-emphasis-none` | 不应用 | `currentStep === null` 时不覆盖 |

> Token **names** keep the `--mstar-canvas-emphasis-*` prefix after the
> canvas migration — they are pinned contract names consumed by the list
> rules (`agent-list.module.css`); renaming them would churn every tier rule
> for zero semantic gain. 定稿档位 0.75/0.45：三档在深浅主题下对比度均成立
> （chrome alpha 混合基为层背景，主题翻转不影响相对关系）。

### 4. Interaction & theme（交互态 + 主题）

#### 4.1 hover

| 元素 | 规则 | 时长 |
|------|------|------|
| 普通行 | 边框 `--dsw-alias-border-l1` → `--dsw-alias-border-l2` | 150ms（120–150ms 窗口） |
| running 行 | 边框保持 business；ring / 辉光施加于**圆角行体**（§1.3） | 150ms |
| idle 行 | 边框 → `--dsw-alias-label-caption` | 150ms |
| 分区 / 列表组标题 | 无 hover 反馈（纯标注） | — |
| 组框（group frame） | 边框 `border-l1` → `border-l2` | 150ms |

#### 4.2 卡片状态点

| 状态 | 呈现 | token |
|------|------|-------|
| running | business 圆点 + 1px ring + 辉光脉冲（1.6s） | `--dsw-alias-state-business-primary` |
| settled（`emphasis ≠ 'off'`） | **独立绿框 + 12px 绿 ✓**（绿框见 §1.3 / Colors） | `--dsw-alias-state-success-primary` |
| settled（`emphasis === 'off'`） | **灰字圆点，无 ✓、无绿框**（已完成状态不在无阶段角色上出现） | `--dsw-alias-label-caption` |
| error / denied | error 色圆点 | `--dsw-alias-state-error-primary` |
| advisory | warn 色圆点 | `--dsw-alias-state-warn-label` |
| idle | caption 色圆点（muted） | `--dsw-alias-label-caption` |

状态点 + running 辉光 = **最高优先级**（§3.4：不随透明度档位变淡）；绿 ✓ 与
绿框同属 evidence 态（全强度，不随 chrome alpha 变淡），仅 off 档角色整体不
显示完成标记。

> **SUPERSEDED（§4.2 旧版）**：本节曾描述画布的 pointer pan 拖拽（translate-only、
> `setPointerCapture`、`touch-action: none`、`cursor: grab|grabbing`）。画布与
> pan 子系统已随 sidebar 迁移删除——列宽内容滚动即可，无 pan。

#### 4.3 深浅主题

- 面板携带 **零裸 hex**：所有颜色 = `--dsw-alias-*`（宿主主题翻转）+
  `--mstar-space-*` + `--dsw-font-*`；暗色模式 = 宿主 alias token 值翻转，面板
  无需主题分支。
- `canvas:` 语义 token：行 metrics 与透明度档位主题无关（§Spacing / §3.5
  深浅同值）。
- 深浅一致性检查：三档透明度在浅色（`bg-layer-1` 亮）与深色（`bg-layer-1`
  暗）下 chrome alpha 混合相对关系一致；状态点颜色在双主题下均保持对比度
  （宿主 alias 保证）。

#### 4.4 reduced-motion

- 面板根 `prefers-reduced-motion: reduce` → `* { transition: none !important;
  animation: none !important }`（`panel.module.css`）。
- 受影响动画：running 行辉光脉冲（唯一的面板动画）。无需模块内重复声明。

## Do's and Don'ts

**Do:**

- Use `--dsw-alias-*` for every color; **zero bare hex** in implementation
  (dark mode = the host alias flip, no theme branch).
- Use `--mstar-space-1..6` for spacing and `--dsw-font-*` for fonts; no
  out-of-ramp values.
- Keep `[data-mstar-scroll]` the panel's ONLY scroller; add pages as flow
  content that grows it.
- Signal width with **container queries** on the shell
  (`container-type: inline-size`); keep the DOM tree identical at every
  width (width changes the grid, never the tree).
- Carry flow with group order + headings; keep the status point + running
  glow **full-opacity** (highest priority) — apply emphasis via chrome
  alpha mixing, never whole-row `opacity`.
- Give every row exactly one visible outline on the rounded row body
  (ring/glow on the rounded element itself).
- Keep hover feedback within the 120–150ms window; honor
  `prefers-reduced-motion` (panel root kills transition/animation).

**Don't:**

- Don't copy host hex into this contract — alias tokens stay name-level
  (`dswAlias:` group); re-pin `colors:` only when the panel semantic tokens
  legitimately change.
- Don't reintroduce an edge/port/pan layer: no `<svg>` inside the agents
  page, no `data-canvas-*` / `data-agent-port` anchors, no pan transform.
- Don't add a second `overflow-y` scroller or any `overflow-x` scroller
  inside the panel; don't read layout from JS (`ResizeObserver`,
  `getBoundingClientRect`, `offsetWidth`, …) — the width signal is the
  container query alone.
- Don't use viewport media queries for panel layout — the panel's width is
  a fraction of the sidebar column, not the viewport.
- Don't stack a square outline on a rounded row (single rounded element
  rule).
- Don't signal state with color alone — pair with the status point / icon /
  label.

## Decision points & review record

### 5. 完整性自检（sidebar 迁移后）

**覆盖清单：** 布局与结构 → §Spacing & Layout / §1（堆叠分组结构：壳层三区
+ group/stage/sub-bucket）；流转语义 → §2（F1–F4 流规则，取代已删除的线型
语义）；透明度分级 → §3（用户复核定稿，语义不变，应用点移至流行）；交互态
+ 主题 → §4（hover / 状态点 / 深浅 / reduced-motion；pan 节已废除并标注）。

**边界与非目标：** 不做动态证据线（线层已删除，F1 由组序承担）；不改事件日
志分类语义；不动 `PHASE_IDS` / `PLAN_STATE_IDS` / kanban 状态组；不引入新第
三方渲染依赖（列表零依赖，纯 HTML/CSS）；投影数据模型不变。

### 6. 决策点清单（审阅 gate 记录）

> 2026-09-11 sidebar 迁移标注：D1–D3 / D8–D15 描述的**线型语义已随画布删除**
> ——下列各行**标记 SUPERSEDED**，仅作历史决策记录保留（不可作为实现依据）；
> D4–D7（透明度档位）与 D16–D19（完成态 / 分组 / 共用 Section）语义仍有效，
> 其中 D17 的「两 band 左右布局」已被堆叠分组列表取代。

| # | 决策点 | 状态 | 定稿 / 推荐 |
|---|--------|------|------------|
| D1 | `next` 动画边去留 | **SUPERSEDED**（线层已删除） | 曾定：移除；现整层线语义由 §2 F1–F4 取代 |
| D2 | `actual` 交接线呈现 | **SUPERSEDED**（线层已删除） | 曾定：端口锚定 + bezier；现无任何连线 |
| D3 | `expected` 骨架线 | **SUPERSEDED**（线层已删除） | 曾定：移除；流转顺序现由 §1.2 组序 + 标签承担 |
| D4 | 透明度档位数值 | **用户复核定稿（有效）** | next 0.75 / off 0.45（current 1） |
| D5 | 透明度粒度 | **用户复核定稿（有效）** | 阶段粒度（按 `entity.stage.phase` 比对） |
| D6 | on-demand 角色归属 | **用户复核定稿（有效）** | `'off'`（按公式：无 stage → off） |
| D7 | Phase 3–5 全部 pipeline 角色 | **用户复核定稿（有效）** | 接受全 `'off'`（这些阶段无期望代理参与） |
| D8 | 线型颜色层次 | **SUPERSEDED**（线层已删除） | 曾定：2 类；`line-business` / `line-caption` token 已随本契约 0.2.0 移除 |
| D9 | 「监督」语义线整体保留 | **SUPERSEDED**（线层已删除） | 曾定：evidenced 亮起；implementor ↔ reviewer 关系现由 §1.2 子桶分组表达 |
| D10 | 卡片端口锚点系统 | **SUPERSEDED**（线层已删除） | 曾定：4 端口；现行无端口、无穿行问题 |
| D11 | 连线曲线规范 | **SUPERSEDED**（线层已删除） | 曾定：bezier `C` 命令；现无 SVG |
| D12 | 箭头顺线方向 | **SUPERSEDED**（线层已删除） | 曾定：切线对齐 + standoff；现无箭头 |
| D13 | 卡片无方形层叠 | **有效（应用于行）** | 高亮 ring / glow 施加于圆角行体（§1.3 单一轮廓规则） |
| D14 | 四列布局 | **SUPERSEDED**（布局已堆叠化） | 曾定：4 列 + unknown 下沉；现列概念删除，unknown 子桶保留为 §1.2 2d |
| D15 | 组线避开文字 | **SUPERSEDED**（线层已删除） | 曾定：侧隙垂直锚点；现无组级线 |
| D16 | 已完成 Agent 变绿 + ✓ | **用户反馈已定（有效）** | settled 实体**独立绿框 + 绿 ✓**（全强度 success token，圆角行体 ring） |
| D17 | Phase 1/2 分组 | **部分有效** | 分组语义有效（§1.2 两 Phase 组）；「左右两 band」呈现被**竖直堆叠**取代；Phase 2 组标注**当前 plan**（`data-agent-group-plan` + `+N more`） |
| D18 | 透明度与完成态交互 | **用户反馈已定（有效）** | off 低透明不显示绿✓；off 档 settled → 灰字圆点 |
| D19 | 迭代信息 Section 共用 | **用户反馈已定（有效）** | 任务迭代页与代理执行页**共用同一迭代信息块**（一个 `IterationInfoSection` 组件，两页同一 `view.iteration` 数据） |

### 7. 审阅记录

| 日期 | 结论 | 修订要点 |
|------|------|---------|
| 2026-08-12（初稿 → 第 4 轮） | 画布契约定稿（v2→v4） | 线型语义三轮修订（expected/next 移除、bezier、4 端口、H1/H2、standoff、侧隙锚点）、透明度档位 0.75/0.45、完成态绿框 ✓ off 排除、Phase 1/2 分组 + 当前 plan 标注、迭代信息 Section 两 tab 共用；本 doc 提升为 `packages/dsh/DESIGN.md` |
| 2026-09-11（sidebar 迁移） | **重写（v0.2.0）** | 面板迁移为 dsh 右 Sidebar 页签（guide 入口 + keyed seats），画布删除、代理执行页改为竖直分组列表：§1 重写为堆叠分组结构，§2 线型语义由流规则 F1–F4 取代，§3 档位语义不变（应用点移至流行），§4 移除 pan；`canvas:` token 组剪枝至 6 项存活（3 档 + row-gap/group-gap/label-h），`line-*` 色token 移除；断点改为容器查询（L4.3 表）；描述线型语义的决策点（D1–D3/D8–D12/D14–D15）标记 SUPERSEDED 而非静默删除 |

## Upgrade path (placeholders)

<!-- LEVEL2_PLACEHOLDER: this design system deliberately does NOT adopt the
generic 10-step color scales / alpha scales / 7-accent scales / button+input
component tokens of the Geist-style Level 2 checklist — its palette is
host-alias-owned (name-level, drift-safe) and its component surface is the
panel primitives (entity rows, group frames, stepper, legend, status
points), not a generic UI kit. If the panel grows generic components, map
them into the frontmatter `components:` group and re-audit. -->

<!-- LEVEL3_PLACEHOLDER: dark theme IS provided (DESIGN.dark.md, same token
names / different values) and motion + reduced-motion rules are declared in
the body — but the full Level 3 checklist (elevation shadow system, generic
component library incl. modal/tooltip/menu, voice & content rules) is not
applicable to this panel contract. Re-audit when the panel adds those
surfaces. -->
