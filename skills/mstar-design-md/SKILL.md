---
name: mstar-design-md
description: DESIGN.md design system specification for Morning Star projects. Create, audit, and maintain project-level design tokens (Colors, Typography, Spacing, Elevation, Motion, Shapes, Components, Voice & Content) using Vercel Geist as reference template. Three-level completeness checklist (MVP/Standard/Production) with built-in upgrade placeholders. Supports light/dark dual-theme via DESIGN.md + DESIGN.dark.md sharing same token names with different values. Prepare 阶段由 @architect 主责创建，@product-manager 提供设计需求；@frontend-dev / @fullstack-dev 实现 UI 时消费；@qc-specialist / @qa-engineer 审查 UI 对齐 DESIGN.md。Read when PM assigns DESIGN.md creation in Prepare, initiating a new UI project, @architect defining a design system, implementing styled components, auditing UI against design spec, adding dark theme, or user mentions "DESIGN.md" / "design tokens" / "design system". Phase gate → **mstar-phase-gates**; paths → **mstar-plan-conventions**.
---

## Load order

**Before first Read of this skill: Read `mstar-harness-core` (SKILL.md).** For Prepare phase integration and gate rules, read `mstar-phase-gates`. For plan directory paths (`{HARNESS_DIR}`, `{SPECS_DIR}`), read `mstar-plan-conventions`. On conflict, **`mstar-harness-core` wins**.

| 你还可能要 Read | 何时 |
|-----------------|------|
| `mstar-phase-gates` | Prepare 阶段判定 gate、何时 DESIGN.md 必须就绪 |
| `mstar-plan-conventions` | `{HARNESS_DIR}` / `{SPECS_DIR}` 路径解析 |
| `mstar-roles` | `@architect` / `@product-manager` / `@frontend-dev` / `@qc-specialist` / `@qa-engineer` 角色职责边界 |
| `mstar-coding-behavior` | 实现角色消费 DESIGN.md 前的通用编码约束 |

## Scope (DESIGN.md lifecycle)

| Topic | See |
|-------|-----|
| Normative spec: section definitions, token naming, light/dark rules, **YAML frontmatter structure** | `references/design-md-spec.md` |
| Three-level completeness checklist (MVP / Standard / Production) | `references/completeness-checklist.md` |
| Vercel Geist DESIGN.md as annotated reference | `references/vercel-example.md` |
| Full template with YAML frontmatter and Level 2/3 placeholders | `templates/DESIGN.md.template` |
| Dark theme template (same token names, different values) | `templates/DESIGN.dark.md.template` |

**YAML frontmatter is the SSOT for token values.** Colors, typography, spacing, rounded, and components live in the frontmatter as structured, machine-readable data. The Markdown body is supplementary documentation (rules, intent, usage guidance). When reading DESIGN.md, always parse the YAML frontmatter first; when writing, keep frontmatter and body in sync.

**Out of scope:** rendered UI artifacts (use Open Design MCP `user-open-design`); frontend implementation that consumes DESIGN.md tokens (use `@frontend-dev` / `@fullstack-dev`); QC review verdict rules (→ **`mstar-review-qc`**).

## Location

- **Primary**: project root `DESIGN.md` (human + agent visible, aligns with `AGENTS.md`)
- **Dark theme**: project root `DESIGN.dark.md` (same token names, different values)
- `DESIGN.md` is a **project-level design contract**, not a harness internal artifact. It lives beside `README.md` and `AGENTS.md`.

## Role lifecycle

### Creator: `@architect` (primary) + `@product-manager` (requirements)

`@architect` owns DESIGN.md content — token selection, naming, completeness level decisions. `@product-manager` provides design intent: brand identity, target audience, must-have UI patterns, accessibility requirements.

### Orchestrator: `@project-manager`

In Prepare phase, PM decides whether the project needs a DESIGN.md. If yes, dispatches to `@architect` with product requirements from `@product-manager`. PM checks DESIGN.md exists and meets the assigned completeness level before `plan(locked)`.

### Consumers

- `@frontend-dev` / `@fullstack-dev` — read DESIGN.md before implementing styled components; map tokens to CSS/theme variables
- `@qc-specialist` — verify UI implementation aligns with DESIGN.md tokens
- `@qa-engineer` — verify visual output matches design spec

## Phase gate integration

DESIGN.md is a **Prepare-stage artifact** (like spec). It must be created and reviewed before `plan(locked)` for any plan that includes UI work.

1. PM includes "DESIGN.md creation/audit" in Prepare tracking checklist when the plan involves UI
2. `@architect` creates or updates DESIGN.md; `@product-manager` reviews design intent alignment
3. PM gates on: DESIGN.md exists, meets completeness level declared in plan, `@product-manager` signed off

For **hotfix** or plans with no UI changes, DESIGN.md check may be skipped.

## Completeness levels

DESIGN.md supports three levels, each with built-in upgrade path:

1. **Level 1 — MVP** (minimal, prevents guesswork): palette, base typography, spacing scale
2. **Level 2 — Standard** (consistent components): full token scales, breakpoints, component tokens (Button, Input)
3. **Level 3 — Production** (complete design system): dual theme, elevation, motion, shapes, component library, voice

The template includes all levels; Level 2 and 3 sections are commented out with `<!-- LEVEL2_PLACEHOLDER: ... -->` markers that explain when to activate them. The audit workflow detects these placeholders and can recommend upgrade.

Full checklist → `references/completeness-checklist.md`.

## Workflows

### Workflow 1: Create DESIGN.md (Prepare phase)

1. Read `references/design-md-spec.md` for section definitions and YAML frontmatter structure
2. Copy `templates/DESIGN.md.template` to `{PROJECT_ROOT}/DESIGN.md` — the template includes the full YAML frontmatter skeleton
3. Interview `@product-manager` for brand colors, typography preferences, must-have patterns
4. Fill Level 1 frontmatter tokens (uncomment and replace `"[placeholder]"` values with concrete hex/px values)
5. If plan requires Level 2+ out of the gate, uncomment and fill those sections too
6. Update the body prose to match the frontmatter values (target audience, aesthetic principles, rhythm rules)
7. Run the completeness audit workflow below to confirm level
8. Report to PM: path created, level achieved, what's needed for next level

### Workflow 2: Audit DESIGN.md completeness

1. Read `DESIGN.md` and `DESIGN.dark.md` (if exists) — **parse the YAML frontmatter** for structured token values
2. Load `references/completeness-checklist.md`
3. Check each checklist item; note gaps in both frontmatter (missing/uncommented keys, placeholder values) and body (missing rules/documentation)
4. Report:
   - Current completeness level
   - Gaps preventing next level (frontmatter gaps vs. body gaps, tagged separately)
   - Presence of upgrade placeholders (`LEVEL2_PLACEHOLDER`, `LEVEL3_PLACEHOLDER` in both frontmatter comments and body HTML comments)
   - Recommendation: whether to upgrade now or defer
5. Update DESIGN.md level tag (e.g., `<!-- COMPLETENESS_LEVEL: 1 — last audited YYYY-MM-DD -->`) if changed

### Workflow 3: Add dark theme

1. Read existing `DESIGN.md` to extract token names
2. Copy `templates/DESIGN.dark.md.template` to `{PROJECT_ROOT}/DESIGN.dark.md`
3. For each token in DESIGN.md, define the dark-theme equivalent value
4. Preserve same token names; only values change (see `references/design-md-spec.md` § Light/Dark rules)
5. Audit with Workflow 2 to confirm Level 3 completeness

### Workflow 4: Consume DESIGN.md (implementation roles)

Before writing styled UI code:
1. Read `DESIGN.md` (and `DESIGN.dark.md` if exists)
2. **Parse the YAML frontmatter** for token values — this is the SSOT for colors, typography, spacing, rounded, and components
3. Resolve component `{colors.X}`, `{typography.X}`, `{rounded.X}` references by tracing back to the corresponding frontmatter keys
4. Extract tokens into implementation layer (CSS custom properties, Tailwind config, theme object, etc.)
5. Follow DESIGN.md body Voice & Content rules for copy text
6. If DESIGN.md is missing, has no frontmatter, or is incomplete, report to PM — do not guess tokens

## Light/Dark dual-theme rules

Dual theme uses **same token names, different values** across two files:

```
DESIGN.md         DESIGN.dark.md
-----------       --------------
gray-100: #fff    gray-100: #111
gray-1000: #000   gray-1000: #eee
```

- Token names are the **SSOT interface** — consumers reference tokens by name, not raw values
- `references/design-md-spec.md` § Light/Dark rules defines the contract

## Open Design integration

If `user-open-design` MCP is available:
- DESIGN.md is the **design intent** (tokens + rules)
- Open Design manages **rendered artifacts** (HTML/CSS/JSX previews)
- When DESIGN.md is updated, recommend syncing the Open Design project to reflect new tokens
- DESIGN.md does not replace Open Design; they are complementary

## References

- `references/design-md-spec.md` — normative spec: section definitions, token naming conventions, light/dark contract
- `references/completeness-checklist.md` — three-level audit checklist with detailed criteria per level
- `references/vercel-example.md` — Vercel Geist DESIGN.md as annotated reference (read when creating from scratch or needing design inspiration)

**Templates (this skill):**
- `templates/DESIGN.md.template` — full template including all Level 1-3 sections with placeholder comments
- `templates/DESIGN.dark.md.template` — dark theme template with same token names, different values
