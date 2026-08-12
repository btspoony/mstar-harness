---
version: 0.1.0
name: "Agent Canvas Design System"
description: "Design contract for the agent execution canvas (AgentCanvasPage) in the @mstar-harness/dsh panel — layout / line / emphasis / interaction tokens consumed through host aliases (--dsw-alias-*), zero bare hex. This is the Light theme; the Dark theme shares the same token names with different values at /DESIGN.dark.md."

# ── Host alias tokens (name-level interface, design doc §0.2) ──────────────
# Values belong to the dsh web host theme (design-platform.css) and flip per
# theme. Declared here at NAME level only — this doc never copies host hex
# (drift rule; the `colors:` group pins only the CANVAS semantic tokens the
# plan itself introduces).
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
  # Canvas semantic color tokens — pinned LIGHT values (host-alias provenance
  # in comments; runtime consumption stays alias-based, zero bare hex in CSS).
  # background-100: canvas surface = --dsw-alias-bg-layer-1
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
  # Canvas line colors (design doc §2.2/§2.8 — the two semantic line classes):
  # line-business: actual handoff + supervise lit (business)
  line-business: "#4176e6"
  # line-caption: supervise dim (caption)
  line-caption: "#adb2b8"

typography:
  # Font ramp consumed via --dsw-font-xxxs-11 / xxs-12 / xs-13; family
  # inherits the host --dsw-font-family stack (design doc §0.2).
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

# ── Canvas semantic tokens (design doc §1.6 / §2.5 / §3.5) ────────────────
# Theme-independent: geometry px and emphasis opacity tiers are light/dark
# identical (design doc §0.2 — 深浅同值).
canvas:
  col-w: 200px
  col-gap: 56px
  card-w: 176px
  card-h: 72px
  row-gap: 12px
  pad-x: 24px
  pad-y: 24px
  col-pad: 12px
  label-h: 18px
  sub-label-h: 14px
  sub-gap: 4px
  port-size: 3px
  standoff: 10px
  side-gap: 18px
  emphasis-current: 100%
  emphasis-next: 75%
  emphasis-off: 45%
---

<!-- COMPLETENESS_LEVEL: 1 — last audited 2026-08-12 -->

# 代理画布设计系统（Agent Canvas Design System）

> **Canonical package-level design contract** — promoted from the iteration
> spec `agent-canvas-design-system.md` (iter-20260812-sync-v211-panel-f5,
> plan `20260812-panel-f5-design-system` Task 1; user-reviewed v3, finalized
> 2026-08-12) to `packages/dsh/DESIGN.md` by plan Task 7 (2026-08-12). The
> iteration snapshot remains in the iteration specs/ — this file is the single
> canonical source (single-source principle, AGENTS.md). Consumers:
> `@frontend-dev` / `@fullstack-dev` implement styled panel UI; `@qc-specialist`
> verifies alignment; `@qa-engineer` verifies visual output.

## Overview

Agent Canvas Design System is a **minimal, evidence-driven design contract**
for the agent execution canvas of the Morning Star dsh panel
(`AgentCanvasPage`). It prioritizes readability and signal clarity over
decoration: layout is deterministic geometry, lines are semantic and sparse,
emphasis is time-driven, and every color is a verified host alias token.

- **Audience**: the dsh panel's agent-canvas view (plus the panel surfaces
  that share its token discipline).
- **Aesthetic principles**: zero bare hex; geometry over decoration; line
  minimalism (2 semantic classes, ≤ 4 rendered lines); status always
  full-opacity; dark mode is the host alias flip — no theme branch.
- **Theme**: this file is the **Light** theme. The **Dark** theme uses the
  same token names with different values and lives at
  [`DESIGN.dark.md`](DESIGN.dark.md) (host alias flip; canvas geometry and
  emphasis tiers are theme-independent, so only the `colors:` values change).

All concrete token values live in the **YAML frontmatter above** (colors,
typography, spacing, rounded, plus the `dswAlias` name-level host interface
and the `canvas` semantic group). The body below explains rules, intent, and
agent guidance. Host alias tokens are declared **by name only** — the dsh web
host theme owns their values (`design-platform.css`), so this contract never
copies host hex (drift rule, design doc §0.2).

## Colors

Token values are defined in the frontmatter `colors:` map. The canvas
consumes **zero bare hex**: every rendered color is either a `--dsw-alias-*`
host alias (listed by name in the `dswAlias:` group; values flip per theme)
or one of the canvas semantic tokens pinned below (the plan's own tokens,
with concrete values per the design contract).

| Canvas role | Token | Light value | Host alias (provenance) |
|-------------|-------|-------------|--------------------------|
| Surface (viewport / card) | `background-100` | `#ffffff` | `--dsw-alias-bg-layer-1` |
| Primary label (titles) | `gray-1000` | `#0f1115` | `--dsw-alias-label-primary` |
| Secondary label | `gray-900` | `#61666b` | `--dsw-alias-label-secondary` |
| Caption (record rows, dim) | `gray-400` | `#adb2b8` | `--dsw-alias-label-caption` |
| Business (running, actual line) | `blue-700` | `#4176e6` | `--dsw-alias-state-business-primary` |
| Error / denied | `red-700` | `#ec1313` | `--dsw-alias-state-error-primary` |
| Success (settled ✓) | `green-700` | `#22c55e` | `--dsw-alias-state-success-primary` |
| Warn (advisory) | `amber-700` | `#dd8629` | `--dsw-alias-state-warn-label` |
| **Line — business** (actual + supervise lit) | `line-business` | `#4176e6` | `--dsw-alias-state-business-primary` |
| **Line — caption** (supervise dim) | `line-caption` | `#adb2b8` | `--dsw-alias-label-caption` |

- Border colors ride `--dsw-alias-border-l1` (rest) / `--dsw-alias-border-l2`
  (hover) — host alias, name-level.
- **Emphasis chrome** (design doc §3.4): card chrome colors are mixed toward
  the layer background by the emphasis tier alpha
  (`color-mix(in srgb, <chrome> var(--mstar-chrome-alpha), var(--dsw-alias-bg-layer-1))`)
  — never a whole-card `opacity` (status point + running glow stay
  full-opacity, the highest-priority rule).
- **Hover feedback** is a 150ms border step `border-l1 → border-l2` (120–150ms
  window); running cards keep the business border.

## Typography

Token values are defined in the frontmatter `typography:` map. The canvas
rides the host font ramp `--dsw-font-xxxs-11 / xxs-12 / xs-13` (family
inherits the host `--dsw-font-family` stack); sizes and weights are the
design contract.

| Role | Token | Size / weight | Usage |
|------|-------|---------------|-------|
| Page title | `heading-13` | 13px / 600 | canvas header title |
| Card title / sub-bucket title | `heading-11` | 11px / 600 | entity name, idle cards use displayName |
| Body / summary | `copy-13` | 13px / 400 | general canvas text |
| Note / muted line | `copy-12` | 12px / 400 | muted degradation note |
| Record rows / caption | `copy-11` | 11px / 400 (tabular-nums) | session id · task tag, legend |

## Spacing & Layout

Token values are defined in the frontmatter `spacing:` / `rounded:` maps and
the `canvas:` group.

### Spacing ramp (`--mstar-space-1..6`, panel root)

| token | value |
|-------|-------|
| `--mstar-space-1` | 4px |
| `--mstar-space-2` | 8px |
| `--mstar-space-3` | 12px |
| `--mstar-space-4` | 16px |
| `--mstar-space-5` | 24px |
| `--mstar-space-6` | 32px |

Application rule: small inside-card gaps (1–2) → between groups (2–3) →
between page sections (3–4). Large canvas-internal spacing is carried by the
geometry constants (below), never by out-of-ramp values.

### Radius (unified 8px/999px pair)

| token | value | usage |
|-------|-------|-------|
| `rounded.sm` | 8px | cards, viewport, sub-bucket frames |
| `rounded.full` | 999px | status dots, port dots, on-demand badge capsule |

**Card single-radius-element rule (design doc §1.4, user-finalized)**: a card
has exactly **one** visible outline — the `border-radius: 8px` `.card-body`.
Running / highlight ring and glow must be applied to the rounded element
itself (`.card-body` box-shadow); never stack `box-shadow`/`outline` on a
`border-radius: 0` outer container (no square-over-rounded layering).

### Canvas geometry (design doc §1.6 — `canvas:` group, theme-independent)

| token | value | constant |
|-------|-------|----------|
| `canvas.col-w` | 200px | `COL_W` |
| `canvas.col-gap` | 56px | `COL_GAP` |
| `canvas.card-w` | 176px | `CARD_W` |
| `canvas.card-h` | 72px | `CARD_H` |
| `canvas.row-gap` | 12px | `ROW_GAP` |
| `canvas.pad-x` | 24px | `PAD_X` |
| `canvas.pad-y` | 24px | `PAD_Y` |
| `canvas.col-pad` | 12px | `COL_PAD` |
| `canvas.label-h` | 18px | `LABEL_H` |
| `canvas.sub-label-h` | 14px | `SUB_LABEL_H` |
| `canvas.sub-gap` | 4px | `SUB_GAP` |
| `canvas.port-size` | 3px | port dot diameter |
| `canvas.standoff` | 10px | arrow-tip retreat (`STANDOFF`) |
| `canvas.side-gap` | 18px | supervise side-gap anchor offset |

> `simplify:` — geometry currently lives as `layoutAgents` constants
> (`AgentCanvasPage.tsx`); if a future plan needs theming/scaling, map them to
> CSS variables per this table. No current requirement.

### Breakpoints

The agent canvas is a **fixed-geometry pan surface** (translate-only, no
zoom, no reflow); the panel page itself never scrolls. Responsive breakpoints
are therefore **not applicable** to this design system — layout tokens are
absolute canvas-space px, not viewport-relative.

## Canvas Semantics

### 1. Layout & structure tokens（布局与结构 token，已定稿）

Status: **已定稿** — P2 implemented and user/QC/QA confirmed (2026-08-12);
this section codifies the deterministic layout contract.

#### 1.1 画布坐标系

- Canvas is a **pan-only** content layer: `data-canvas-pan` carries
  `transform: translate(xpx, ypx)`; no zoom, no boundary; grid background
  moves with the content.
- Coordinate space: **canvas space** (CSS px), origin at content-layer
  top-left; all layout geometry (columns / cards / sub-buckets / line
  anchors) is computed deterministically by `layoutAgents(view)`
  (`CanvasBox {x, y, w, h}`).
- Viewport (`data-canvas-viewport`) clips the content layer
  (`overflow: hidden`); the page itself never scrolls.
- Key geometry constants (design tokens in §Spacing & Layout / `canvas:`
  group): `PAD_X` 24, `PAD_Y` 24, `COL_W` 200, `COL_GAP` 56, `CARD_W` 176,
  `CARD_H` 72, `ROW_GAP` 12, `LABEL_H` 18, `COL_PAD` 12, `SUB_LABEL_H` 14,
  `SUB_GAP` 4.

#### 1.2 列序（阶段主线）

Column order is fixed to the `EXPECTED_ROLE_FLOW` constant order
(**4 columns**, user feedback round 2 #3 — no standalone 5th column):

```
review-edit-chain → sdd-implement → qc-tri → qa-gate（+ unknown 下沉分区）
```

- Column label = stage id (`${phase}:${stage}` → text after `:`).
- **unknown sink partition (v3, user feedback #3)**: `zone: 'general'`
  entities (unmatched / anonymous dispatches) no longer own a 5th column;
  they render in a sub-partition at the **bottom of the qa-gate column**
  (title「unknown / 未匹配角色」, `data-sub-bucket="unknown"`), after the
  qa-gate cards. No standalone on-demand column either (P2 merged on-demand
  into the implementor sub-bucket).
- Geometry: unknown partition title row = `SUB_LABEL_H` (14px), placed
  `ROW_GAP` below the qa-gate last card; general cards follow (`SUB_GAP` 4px);
  column height = stacked card total (incl. sink partition).
- Projection `zone` semantics unchanged (`'general'` still marks unmatched);
  only the **render position** changed (render layer does zero semantic
  guessing — position is a layout rule, the projection data model is untouched).

#### 1.3 桶内分区（sdd-implement 子桶）

The `autonomous-execute:sdd-implement` column splits into two partitions by
the projected `entity.bucket` (render layer never guesses):

| 分区 | bucket | 角色 | 说明 |
|------|--------|------|------|
| **implementor**（上） | `'implementor'` | fullstack-dev、fullstack-dev-2、frontend-dev（flow 序）+ ops-engineer、prompt-engineer（on-demand，带按需徽标，flow 角色之后） | 实现侧；on-demand 角色无独立列 |
| **sdd-reviewer**（下） | `'reviewer'` | code-reviewer | SDD L2 task reviewer (v2.1.1) |

- Partition boundary = projected `bucket`; sub-bucket title rows
  (`data-sub-bucket`) + card bands live in `layoutAgents` `subBuckets`
  geometry (supervise-line anchors read them, §2.5).
- Deterministic card order per partition: implementor = stage roles original
  order → on-demand roster order; reviewer = insertion order (only
  code-reviewer today).
- Column height = stacked card total (min `CARD_H + LABEL_H + COL_PAD*2`).

#### 1.4 卡片规格

| 属性 | 值（token） | 说明 |
|------|------------|------|
| 尺寸 | `canvas.card-w` 176px / `canvas.card-h` 72px | 固定，不随内容伸缩 |
| 圆角 | 8px（统一半径对，与面板一致） | `rounded.sm` |
| 边框 | 1px `--dsw-alias-border-l1` | hover → `--dsw-alias-border-l2`（150ms） |
| 背景 | `--dsw-alias-bg-layer-1` | 与视口同层 |
| 内距 | `--mstar-space-2`（8px） | 卡片内 gap `--mstar-space-1`（4px） |
| 标题 | `copy-11` weight 600，色 `--dsw-alias-label-primary` | 实体名（idle 卡用 displayName） |
| 状态点 | 8px 圆点（settled 为 12px ✓） | §4.3 |
| 记录行 | `copy-11` 等宽，色 `--dsw-alias-label-caption` | session id · task tag（辅助字段，非标题） |
| 角色 chip / 徽标 | `copy-11`，边框 `--dsw-alias-border-l2` | on-demand 徽标 = 虚线 business 边框 `rounded.full` 胶囊 |

> **卡片唯一元素规则（v3 硬规则，用户反馈 #2 已定）**：一张卡片的可视轮廓
> **只有一个**——带 8px 圆角的 `.card-body`。**running / 高亮态的外发光 ring /
> glow 必须施加在圆角元素本身**（`.card-body` 的 `box-shadow`），**禁止**在无
> 圆角的外层容器（`.card`）上叠加 `box-shadow` / `outline` 形成「圆角卡 + 方形
> 轮廓」双层叠（v2 缺陷：running ring 落在 `border-radius: 0` 的 `.card` 上产生
> 方形）。高亮态 = 圆角 ring + glow，与常态同圆角。

### 2. Line semantics（线型语义，用户反馈修订稿 v3）

Status: **用户反馈已定 + 待复核** — user's 2026-08-12 **two** feedback rounds
both hit this section (round 1: remove inter-group dashed lines / curves /
card ports / simplify; round 2: **arrow along line / group lines avoid text /
lines never overlap text**), applied; **only two semantic line classes
remain** (`actual` handoff + `supervise`), `expected` skeleton and `next`
animated edge **removed**. This is the decision input (settled) for the edge
rework.

#### 2.0 线总则（硬规则 —— 用户第二轮反馈 #5 定稿）

用户 2026-08-12 第二轮反馈：「所有绘图对于线的最主要要求：① 箭头要顺着线 ②
线中间不要叠到任何文字」。以下两条为**所有保留线（actual + supervise）的硬规
则**，违反即回归缺陷：

| # | 硬规则 | 落地机制 |
|---|--------|----------|
| **H1 箭头沿线方向** | 箭头轴线必须与线在锚点处的**局部切线方向**共线；**禁止**固定角度垂直贴卡 / 垂直压边 | SVG marker `orient="auto"` / `orient="auto-start-reverse"` 自动对齐路径锚点切线（§2.6）；路径形状须保证**端点切线 = 线段主导方向**；箭头尖端落在 **standoff 退让点**（端口外 10px，§2.5），不嵌入卡片边框 |
| **H2 线不叠任何文字** | 任何线的**渲染区域**（stroke + 箭头）不得与任何文字元素（列标签 / 子桶标题 / 卡片标题 / 记录行 / 徽标 / 计数）的包围盒相交 | 端点退让（standoff）+ **侧隙路由**（组级线挂卡片右缘外侧列间隙，§2.5）+ 同列垂直流（south↔north 端口）；跨列 `actual` 只走列间空带（列间隙 ≥ 56px） |

**绕行 / 偏移策略（按优先级）**：① 端点退让（standoff 10px）——线与卡片只以
「尖端在外」的方式接近；② 侧隙路由——组级 / 同列关系线移到卡片列外侧的间隙
带；③ 垂直切线——垂直走向的线两端切线取垂直（箭头自然沿线）；④ 列间空带——
跨列线只经过无卡片 / 无标签的列间隙。**任何情况下不做「压文字绕行」的妥协**：
发现冲突即调整锚点 / 端口 / 路由，而不是让线穿过文字。

#### 2.1 用户反馈 → 落地决策（2026-08-12，不可曲解）

| # | 反馈要点（原文摘引） | 落地决策 |
|---|----------------------|----------|
| 1 | 「组之间无意义的虚线不要了，画面容易乱」（expected 骨架虚线） | **移除 `expected` 骨架虚线**（全部 3 条前向线）；流转顺序由**固定列序 + 列标签**暗示（§2.2） |
| 2 | 「连接线不要用直线，用曲线」 | 所有保留连线改为 **bezier 曲线**（SVG path `C` 命令；水平为主、小弧度，§2.6） |
| 3 | 「连线连在 card 周围的几个固定出入点…不要穿到 card 里面去」 | **卡片端口锚点系统**：每卡 **4 个固定端口**（上/下/左/右四边中点）；连线只连端口，**禁止穿过卡片内部**（§2.5） |
| 4 | 「SDD-IMPLEMENT 里是分 implementor 和 reviewer 组」 | 子桶分组语义**保持**（P2 已实现：implementor 上 / sdd-reviewer 下，§1.3） |
| 5 | 「图式做简洁一点」 | 线数量最小化（8 → ≤ 4）、颜色层次 2 类、图例精简、去动画（§2.4 / §2.8） |

> 用户反馈原文「每条边外可以设置 3~4 个点」按 Task brief 解释为**每张卡 3–4
> 个固定端口**；本修订稿定稿为 **4 端口（四边中点）**（§2.5，决策点 D10）。

**第二轮反馈（2026-08-12 复评，不可曲解）→ 落地决策：**

| # | 反馈要点（原文摘引） | 落地决策（v3） |
|---|----------------------|----------------|
| 1 | 「连接线上的箭头是歪的，没有顺着线」 | **箭头沿锚点切线方向**（H1）：SVG `orient="auto"` 对齐路径端点切线；垂直监督线端点切线改**垂直**；箭头尖端落 **standoff 退让点**（端口外 10px，§2.5），不贴卡 / 不垂直压边（D12） |
| 2 | 「卡片外边…高亮情况下的正方形…不要出现外面那个不带圆角的方形」 | **卡片唯一圆角元素**（§1.4）：running 高亮 ring / glow 移到圆角 `.card-body`（D13） |
| 3 | 「把 unknown general 那块放到 QA gate 那组下面。就四列就行了」 | **四列布局 + unknown 下沉**（§1.2）：移除独立第五列，`general` 渲染于 **qa-gate 列底部 unknown 子分区**（D14） |
| 4 | 「Reviewer 和 Implementer 连接的连线…组连接也要放在旁边，因为…叠到文字上了」 | **监督线移到侧隙**（§2.5/§2.7）：implementor ↔ sdd-reviewer 组级线挂**卡片右缘外侧列间隙**（`x = 卡片右缘 + 18px`，垂直走向），不再横穿「sdd-reviewer」子桶标题（D15） |
| 5 | 「① 箭头要顺着线 ② 线中间不要叠到任何文字。其他按你的推荐」 | **线总则硬规则 H1 + H2**（§2.0）；其余（颜色层次、图例、档位）维持 v2 推荐 |

#### 2.2 线型决策表（修订后）

| 线型 | 数据源（投影字段） | 何时亮起 | 决策（2026-08-12） | 呈现 | anchor 契约 |
|------|--------------------|----------|-------------------|------|-------------|
| **`expected`**（阶段骨架） | `EXPECTED_ROLE_FLOW` 常量序 → `stages[]` | 恒在（旧） | **REMOVE**——组间无意义虚线；流转顺序由列序 + 列标签暗示 | — | — |
| **`actual`**（同 plan 交接） | dispatch 行按 `planId` 分组、`ts` 升序相邻**实体键**对 | 有 ≥2 条同 plan dispatch 且相邻实体键不同；**过滤 general 端点**；**同对实体键至多 1 条**（取最新方向） | **KEEP（精简亮起 + 端口锚定）** | 1.5px `line-business` 实线 + 单箭头；**bezier 曲线**；只连卡片端口 | **端口 standoff → 端口 standoff**（路径终点 = 端口沿线切线内退 10px；H1 箭头沿切线） |
| **`next`**（最新 running 动画） | 最新 running 实体的 `stage` → 下一常量序列 | 至多 1 条（旧） | **REMOVE**——「当前位置」由 running 卡片辉光 + 状态点承担（§3.4 / §4.3） | — | — |
| **`supervise`**（子桶监督） | `superviseEdges`：`sdd-implement` 列 + dispatch 行角色 ∈ `SDD_BUCKET_ROLES` → `evidenced` | 恒在（静态设计知识）；`evidenced===true` → business 亮起，否则 dim | **KEEP**（子桶分组语义确认；监督关系保留，§2.7 微调） | 双向双箭头；**bezier 曲线**（垂直流，端点切线垂直）；evidenced → 1.5px `line-business` **实线** / 未 evidenced → 1px `line-caption` 虚线 | **侧隙垂直锚点**（`x = sdd-implement 卡片右缘 + 18px`，implementor band 底边 ↔ reviewer band 顶边；组级关系线，非卡片端口；H2 不叠子桶标题/文字） |

#### 2.3 「乱」的主因分析与反馈映射（用户反馈：「连线特别乱完全不知道在指什么」）

1. **四类边同时渲染且视觉层级缺失**：`expected`（dim 虚线 caption）与
   `next`（business 动画）走**同一条轨道**（列边缘中点），同轨道双层线 + 动画
   抢眼 → **反馈 #1/#5 解决**：两类线整体移除。
2. **`actual` 边无差别连通**：同一 plan 内所有 ts 相邻派发对都画线（含 general
   桶参与、跨角色往复）→ **反馈 #5 解决**：过滤 general 端点 + 同对实体键至多
   1 条 + 端口锚定（线不再穿卡）。
3. **`next` 动画边信息量低**：700ms dash-flow 每 1.4s 循环；「当前位置」已被
   running 卡片辉光 + 状态点表达 → **反馈 #1/#5 解决**：移除。
4. **`supervise` 是唯一锚点错开的线**（v2：子桶 gap 内且横穿「sdd-reviewer」
   标题；v3 起移到**卡片右缘外侧列间隙**，垂直走向，§2.5/§2.7）；其语义经反馈
   #4 确认保留。

#### 2.4 修订后呈现方案：两层语义 + 一态高亮

用户核心诉求「看得到**正确的代理流转关系**」+「简洁」。收敛为 **两层语义 + 一
态高亮**（线数上限：`actual` ≤ 过滤后同 plan 相邻对 + `supervise` 1）：

1. **交接线（`actual`，证据驱动）**：真实派发流转；端口锚定 bezier 曲线，过滤
   后只保留「有意义的交接」。
2. **监督线（`supervise`，关系语义）**：implementor ↔ sdd-reviewer 双向监督
   （mstar-sdd 契约），`evidenced` 亮起；组级关系线，锚点 = **卡片右缘外侧列间
   隙**（垂直走向），与卡片端口 / 子桶标题文字错开（H2）。
3. **运行态（状态点 + running 辉光）**：当前执行位置由卡片状态点（§3.4 最高优
   先级）+ running business 环表达（替代 `next` 动画边）。

**移除的线不做替代呈现**：`expected`（列序暗示）与 `next`（状态点表达）的语义
已被既有元素承担——「简洁优先」。

#### 2.5 卡片端口锚点系统

- **几何**：每张 card 定义 **4 个固定端口** = 四边中点（派生自 `CARD_W` /
  `CARD_H`，无新 token）：

  | 端口 | 坐标 |
  |------|------|
  | `north` | `(card.x + w/2, card.y)` |
  | `south` | `(card.x + w/2, card.y + h)` |
  | `west`  | `(card.x, card.y + h/2)` |
  | `east`  | `(card.x + w, card.y + h/2)` |

- **端口选择规则**（连线只连端口，**禁止穿过卡片内部**）：
  - 前向流转（源列 < 目标列）：源卡 **east** → 目标卡 **west**
  - 反向流转（源列 > 目标列）：源卡 **west** → 目标卡 **east**
  - 同列流转：源卡 **south** → 目标卡 **north**
- **可见性**：端口**静止不可见**（纯几何锚点，不渲染点）；**卡片 hover / 选中
  时显示**（4 个 3px 圆点，caption 色；running 卡 hover 时 business 色）。线本
  身非交互（`pointer-events: none`，§4.1）。
- **standoff 退让点（v3 新增，H1 落地）**：`actual` 线的**路径终点** = 端口坐标
  沿线切线方向**内退 `STANDOFF = 10px`**（`end = port − 10px × 切线单位向量`）；
  箭头 marker 尖端（`refX`）落在该退让点 → **箭头尖端在卡片边框外侧，不贴卡 /
  不垂直压边**。同列垂直流（south↔north）同样适用。
- **supervise 例外（v3 修订）**：监督线为**组级关系线**（非卡片连线），锚点 =
  **侧隙垂直锚点**：`x = sdd-implement 卡片右缘 + 18px`（列间隙内），从
  implementor band 底边（`y = implementor 末卡底`）垂直到 reviewer band 顶边
  （`y = reviewer 子桶标题行下缘`）——**不横穿子桶标题 / 卡片文字**（H2）。
  端点切线取**垂直** → 双箭头沿线方向（H1）。

#### 2.6 曲线规范

- 所有保留连线用 **SVG path 三次 bezier（`C` 命令）**，不再用 `<line>`。
- **H1 箭头切线硬规则**：箭头 marker `orient="auto"`（起点用
  `orient="auto-start-reverse"`）**自动对齐路径锚点处的切线**——箭头轴线恒与线
  共线。为此**路径形状必须保证端点切线 = 线段主导方向**：
  - 水平流（east↔west）：端点切线水平（控制点与端点同 y）；
  - 垂直流（south↔north、监督线）：端点切线垂直（控制点与端点同 x）；
  - **禁止**「走向垂直、端点切线水平」的形态（v2 监督线 `M 380 480 C 356 480,
    356 510, 380 510` 即此缺陷：垂直走向但两端切线水平，箭头横置 ~90°）。
  - 端点 = **standoff 退让点**（§2.5，端口外 10px 沿线切线），箭头尖端不贴卡。
- **水平流**（east ↔ west 端口 standoff，跨列）：
  ```
  M sx sy  C (sx + off) sy, (tx − off) ty, tx ty      // off = max(|tx − sx| / 2, 24px)
  ```
  控制点水平偏移 = 水平距离一半（下限 24px）→ 自然 S 形小弧度；`(tx, ty)` =
  目标端口 standoff 点。
- **垂直流**（south ↔ north 端口 standoff，同列；及**监督线**）：同一公式但控制
  点偏移作用于 y（`off = max(|ty − sy| / 2, 24px)`）——控制点与端点同 x → 端点
  切线垂直 → 箭头沿线（H1）。
- 示例（architect → frontend-dev，源 east 端口 (212,174) → 目标 west 端口
  (292,276)，standoff 终点 (282,276)）：`M 212 174 C 247 174, 247 276, 282 276`
  （`off = max(|282−212|/2, 24) = 35`）。
- 曲线保持水平 / 垂直为主（不引入斜向大弧）；**线不叠任何文字**（H2）。

#### 2.7 supervise 微调

- 分组语义**不变**（§1.3）；呈现微调：`evidenced` 时由 1.5px 虚线改为
  **1.5px `line-business` 实线**（降低虚线噪音，突出「已发生监督」）；未
  evidenced 保持 1px `line-caption` 虚线。
- **锚点（v3 修订）**：侧隙垂直锚点（§2.5）——`x = sdd-implement 卡片右缘 +
  18px`，从 implementor band 底边垂直到 reviewer band 顶边；曲线 = 垂直流
  （§2.6，端点切线垂直 → 双箭头沿线方向）；**不横穿子桶标题 / 卡片文字**（H2）。

#### 2.8 简洁化清单

| 维度 | 现状（初稿） | 修订后（v3） |
|------|-------------|--------|
| 线数量 | 8（expected 3 + actual 2 + next 1 + supervise 1 + noise 1） | **≤ 4**（actual ≤ 3 过滤后 + supervise 1） |
| 颜色层次 | 3（caption + business + 动画叠加） | **2**（business = actual + supervise lit；caption = supervise dim） |
| 动画 | 2（running 脉冲 + next dash-flow） | **1**（仅 running 脉冲） |
| 图例项 | 10 | **8**（移除 expected / next，新增端口 1 项） |
| 列数 | 5（4 阶段列 + 独立 unknown 列） | **4**（unknown 下沉 qa-gate 列底部） |
| 卡片内线 | actual 穿卡（卡片中心锚点） | **零穿卡**（端口锚定 + standoff 退让） |
| 线叠文字 | 监督线横穿「sdd-reviewer」标题 | **零叠字**（H2：监督线移侧隙，箭头尖端 standoff 不贴卡） |

#### 2.9 边界：动态证据线（non-goal，扩展点）

- **本设计系统不做动态证据线**（根据真实 dispatch/settle 证据动态生成连线）——
  compass Non-Goals 与 Roadmap Position 已记录，为**下一迭代候选**。
- 扩展点预留：§2.2 决策表 + 端口/曲线契约即动态证据线的**语义基座**——未来动
  态线复用同样的语义分类（交接 / 监督），仅把「亮起」从静态设计知识升级为**证
  据强度驱动**。触发条件：P3 静态语义线用户确认 OK 或提出动态需求；owner：
  project-manager。
- 边界承诺：不引入新第三方渲染依赖、不改变事件日志分类语义、不改
  `PHASE_IDS` / `PLAN_STATE_IDS`。

### 3. Emphasis tiers（透明度分级，用户复核定稿）

Status: **用户复核定稿** — 分级驱动源与映射规则为用户决策（不可改）；档位数
值、粒度、on-demand 归属按推荐定稿（D4–D7 用户确认，2026-08-12）。

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

> **正交性**：`emphasis` 是**时间维**（阶段推进），与 P2 的 `bucket`（空间维，
> 同列分区）和 `zone`（列归属）**独立叠加**。

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
> 下所有 pipeline 角色归 `'off'`（D7 定稿）。

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
对应 stage 角色并集 = `'current'`；后续 phase = `'next'`；其余 = `'off'`。与 P2
的 bucket/zone 语义正交（§3.1）。

**示例（三态样例）：**

| 场景 | currentStep | currentPhase | current | next | off |
|------|-------------|--------------|---------|------|-----|
| Phase 1 进行中 | 1 | iteration-start | product-manager / architect / writing-specialist | 全部 autonomous-execute 阶段角色（8） | ops-engineer / prompt-engineer / general |
| Phase 2 执行中（locked） | 2 | autonomous-execute | 全部 autonomous-execute 阶段角色（8） | 无（Phase 3–5 无期望阶段） | review-edit-chain 3 + on-demand 2 + general 1 |
| Phase 3–4 | 3–4 | iteration-close / pr-delivery | 无 | 无 | 全部 14 roster |
| 无迭代 / transition 不可解析 | null | — | — | — | **不覆盖**（保持 idle 现状） |

#### 3.4 与 running/settled 状态点的叠加规则

- **状态点最高优先级**：`opacity` 只作用于**卡片 chrome**（背景、边框、卡片内
  文字、角色 chip、记录行）；**状态点（dot / ✓ / running ring + glow）保持全不
  透明**。
- **实现机制**：**禁止整卡 `opacity` 属性**（父级 opacity 会连带状态点变淡）；
  采用 chrome 色值按档位 alpha 混合（`color-mix` / rgba 变体，混合基 = 视口
  `--dsw-alias-bg-layer-1`）或对 chrome 子元素分组应用 opacity。
- 叠加规则：`emphasis`（时间维）与 `entity.status`（证据维）独立叠加——running
  辉光与状态点永远全不透明；idle 卡片虚线 muted（border-style）与 emphasis
  （opacity）作用于不同属性面，互不冲突。
- 无迭代（`emphasis === null`）时：不套用任何档位，卡片维持现状。

#### 3.5 透明度 token（canvas 语义 token，深浅同值）

| token | 值（定稿档位） | 语义 |
|-------|----------------|------|
| `--mstar-canvas-emphasis-current` | 1（100%，不透明） | chrome 全强度 |
| `--mstar-canvas-emphasis-next` | 0.75（75%） | 中透明度（预期但未轮到） |
| `--mstar-canvas-emphasis-off` | 0.45（45%） | 低透明度（无关 / 已过 / 无阶段） |
| `--mstar-canvas-emphasis-none` | 不应用 | `currentStep === null` 时不覆盖 |

> 定稿档位 0.75/0.45：与面板 existing opacity 惯例（unknown 列 0.7、图例弱化）
> 同量级，且三档在深浅主题下对比度均成立（chrome alpha 混合基为层背景，主题翻
> 转不影响相对关系）。

### 4. Interaction & theme（交互态 + 主题，已定稿）

#### 4.1 hover

| 元素 | 规则 | 时长 |
|------|------|------|
| 普通卡片 | 边框 `--dsw-alias-border-l1` → `--dsw-alias-border-l2` | 150ms（120–150ms 窗口） |
| running 卡片 | 边框保持 business；高亮 ring / 辉光施加于**圆角 `.card-body`**（§1.4） | 150ms |
| idle 卡片 | 边框 → `--dsw-alias-label-caption` | 150ms |
| 边（SVG） | **非交互**（`pointer-events: none`，`data-agent-edge-*` 仅供测试锚点） | — |
| 子桶标题 / 列标签 | 无 hover 反馈（纯标注） | — |

#### 4.2 拖拽（pan）

- **仅平移**（translate，无缩放 / 旋转 / pinch）；原生 pointer 事件
  （pointerdown/move/up + `setPointerCapture`）；`touch-action: none` +
  pointerdown `preventDefault` 阻断原生滚动 / 文本选择。
- 捕获期间卡片不收指针（无穿透点击）；无 pan 边界（自由平移）；
  `cursor: grab` / `:active` → `grabbing`。
- 强制捕获丢失（window blur / alt-tab / 元素移除）经 `lostpointercapture` 走同
  一 end 处理器，`dragRef` 永不过期。
- 平移即时（无动画）；`prefers-reduced-motion` 无需 pan 专属处理。

#### 4.3 卡片状态点

| 状态 | 呈现 | token |
|------|------|-------|
| running | business 圆点 + 1px ring + 辉光脉冲（1.6s） | `--dsw-alias-state-business-primary` |
| settled | 12px ✓（success 色） | `--dsw-alias-state-success-primary` |
| error / denied | error 色圆点 | `--dsw-alias-state-error-primary` |
| advisory | warn 色圆点 | `--dsw-alias-state-warn-label` |
| idle | caption 色圆点（muted） | `--dsw-alias-label-caption` |

状态点 + running 辉光 = **最高优先级**（§3.4：不随透明度档位变淡）。

#### 4.4 深浅主题

- 面板携带 **零裸 hex**：所有颜色 = `--dsw-alias-*`（宿主主题翻转）+
  `--mstar-space-*` + `--dsw-font-*`；暗色模式 = 宿主 alias token 值翻转，面板
  无需主题分支。
- canvas 语义 token：几何与透明度档位主题无关（§Spacing / §3.5 深浅同值）；线
  型色映射到宿主 alias（§2.2，值归宿主）。
- 深浅一致性检查：三档透明度在浅色（`bg-layer-1` 亮）与深色（`bg-layer-1` 暗）
  下 chrome alpha 混合相对关系一致；监督线 dim/lit、状态点颜色在双主题下均保持
  对比度（宿主 alias 保证）。

#### 4.5 reduced-motion

- 面板根 `prefers-reduced-motion: reduce` → `* { transition: none !important;
  animation: none !important }`（`panel.module.css`）。
- 受影响动画：running 卡片脉冲（`next` 边 dash-flow 已随 D1 移除，无动画线残
  留）。无需模块内重复声明。

## Do's and Don'ts

**Do:**

- Use `--dsw-alias-*` for every color; **zero bare hex** in implementation
  (dark mode = the host alias flip, no theme branch).
- Use `--mstar-space-1..6` for spacing and `--dsw-font-*` for fonts; no
  out-of-ramp values.
- Respect H1 + H2 on every retained line: arrow along the local tangent;
  line render area never intersects text boxes.
- Keep the two semantic line classes only (`actual` business / `supervise`
  lit-dim); port-anchor every card edge; arrow tips land on the standoff
  retreat point (10px outside the port).
- Keep the status point + running glow **full-opacity** (highest priority) —
  apply emphasis via chrome alpha mixing, never whole-card `opacity`.
- Give every card exactly one visible outline on the rounded `.card-body`
  (ring/glow on the rounded element itself).
- Keep hover feedback within the 120–150ms window; honor
  `prefers-reduced-motion` (panel root kills transition/animation).

**Don't:**

- Don't copy host hex into this contract — alias tokens stay name-level
  (`dswAlias:` group); re-pin `colors:` only when the canvas semantic tokens
  legitimately change.
- Don't render `expected` / `next` edges, dashed inter-group skeletons, or
  animated dash-flow lines.
- Don't route lines through card interiors, sub-bucket titles, or any text —
  reroute anchors/ports instead (H2).
- Don't stack a square outline on a rounded card (single rounded element
  rule).
- Don't add a standalone 5th column; `general` sinks into the qa-gate
  partition.
- Don't signal state with color alone — pair with the status point / icon /
  label.

## Decision points & review record

### 5. 完整性自检（已定稿）

**覆盖清单：** 布局与结构 token → §Spacing & Layout / §1（已定稿）；线型语义 →
§2（修订稿，两轮 2026-08-12 反馈已落实：expected/next 移除、曲线、端口、简洁
化、**线总则 H1/H2、箭头切线、standoff、侧隙锚点**）；透明度分级 → §3（用户复
核定稿）；交互态 + 主题 → §4（已定稿）。

**边界与非目标：** 不做动态证据线（§2.9 扩展点）；不改事件日志分类语义；不动
sidebar / kanban / `PHASE_IDS` / `PLAN_STATE_IDS`；不引入新第三方渲染依赖（画
布零依赖，原生 pointer + SVG）；不改 P2 投影数据模型；无 placeholder——所有开放
项以「推荐 + 待用户定」显式标注（§6），无 TBD / TODO / 空段。

### 6. 决策点清单（用户审阅 gate 记录，2026-08-12 两轮反馈共 10 项）

| # | 决策点 | 状态 | 定稿 / 推荐 |
|---|--------|------|------------|
| D1 | `next` 动画边去留 | **用户反馈已定** | **移除**（running 状态点 + 辉光承担「当前位置」） |
| D2 | `actual` 交接线呈现 | **用户反馈已定** | **保留**：端口锚定 + bezier 曲线 + 过滤 general 端点 + 同对实体键至多 1 条 |
| D3 | `expected` 骨架线 | **用户反馈已定** | **移除**（组间无意义虚线；列序 + 列标签承担流转顺序暗示） |
| D4 | 透明度档位数值 | **用户复核定稿** | next 0.75 / off 0.45（current 1） |
| D5 | 透明度粒度 | **用户复核定稿** | 阶段粒度（按 `entity.stage.phase` 比对） |
| D6 | on-demand 角色归属 | **用户复核定稿** | `'off'`（按公式：无 stage → off） |
| D7 | Phase 3–5 全部 pipeline 角色 | **用户复核定稿** | 接受全 `'off'`（这些阶段无期望代理参与） |
| D8 | 线型颜色层次 | **用户反馈已定（简化）** | **2 类**：business（actual + supervise lit）/ caption（supervise dim） |
| D9 | 「监督」语义线整体保留 | **用户反馈已定** | **keep**；evidenced → 1.5px business 实线 / 未 → 1px caption 虚线；曲线化 |
| D10 | 卡片端口锚点系统 | **用户反馈已定** | **4 端口**（四边中点）；静止不可见，hover / 选中可见；连线只连端口、禁止穿卡 |
| D11 | 连线曲线规范 | **用户反馈已定** | **bezier `C` 命令**；水平为主小弧度；控制点偏移 = `max(|d|/2, 24px)`；箭头沿切线 |
| D12 | 箭头顺线方向（第二轮 #1） | **用户反馈已定** | **箭头沿锚点局部切线**（`orient="auto"`）；路径端点切线 = 线段主导方向；箭头尖端落 **standoff 退让点**（端口外 10px） |
| D13 | 卡片无方形层叠（第二轮 #2） | **用户反馈已定** | **卡片唯一圆角元素**：高亮 ring / glow 施加于圆角 `.card-body` |
| D14 | 四列布局（第二轮 #3） | **用户反馈已定** | **4 列**；unknown / general **下沉 qa-gate 列底部**子分区，不设独立第五列 |
| D15 | 组线避开文字（第二轮 #4） | **用户反馈已定** | 监督线移**侧隙垂直锚点**（`x = 卡片右缘 + 18px`），不横穿子桶标题 / 卡片文字 |

### 7. 审阅记录

| 日期 | 结论 | 修订要点 |
|------|------|---------|
| 2026-08-12（初稿） | 用户反馈 5 项 → **修订稿 v2** | ① 移除 `expected` 骨架虚线 ② 连线改 bezier 曲线 ③ 卡片 4 端口锚点系统 ④ 确认 sdd-implement 子桶分组 ⑤ 简洁化（线 8→≤4、颜色 2 类、图例 10→8、去动画）。D1–D3 / D8–D11 已定 |
| 2026-08-12（第二轮反馈） | 用户反馈 5 项 → **修订稿 v3** | ① 箭头顺线（切线对齐 + standoff 退让）② 卡片无方形层叠（圆角 `.card-body`）③ 四列布局 + unknown 下沉 ④ 组线避文字（侧隙垂直锚点）⑤ 线不叠字总则 H1/H2。D12–D15 已定 |
| 2026-08-12（复核定稿） | 用户确认定稿；D4–D7 确认 | 透明度档位 0.75/0.45、阶段粒度、on-demand `'off'`、Phase 3–5 全 `'off'` 确认；本 doc 提升为 `packages/dsh/DESIGN.md`（canonical，plan Task 7） |

## Upgrade path (placeholders)

<!-- LEVEL2_PLACEHOLDER: this design system deliberately does NOT adopt the
generic 10-step color scales / alpha scales / 7-accent scales / button+input
component tokens of the Geist-style Level 2 checklist — its palette is
host-alias-owned (name-level, drift-safe) and its component surface is the
canvas primitives (agent card, ports, edges, sub-buckets, legend, status
points), not a generic UI kit. If the panel grows generic components, map them
into the frontmatter `components:` group and re-audit. -->

<!-- LEVEL3_PLACEHOLDER: dark theme IS provided (DESIGN.dark.md, same token
names / different values) and motion + reduced-motion rules are declared in
the body — but the full Level 3 checklist (elevation shadow system, generic
component library incl. modal/tooltip/menu, voice & content rules) is not
applicable to this canvas contract. Re-audit when the panel adds those
surfaces. -->
