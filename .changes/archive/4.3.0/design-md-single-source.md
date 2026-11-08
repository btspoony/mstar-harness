---
category: Harness
packages: root
---

- Deleted `skills/mstar-design-md/references/vercel-example.md`: the annotated Geist `DESIGN.md` restated the skeleton the template already carries, and the external project it models stays linkable. Its two `SKILL.md` citations and its Guard 9 budget entry went with it.
- Compressed `references/design-md-spec.md` from 508 to 176 lines to normative rules only. Every rule the engine enforces survives: the required frontmatter groups and their map shape, the color value formats, the five-property typography object with non-empty `fontFamily`/`fontSize`, `spacing.base` plus numeric multiplier keys in px, px `rounded` values, `{path}` references that must resolve within `colors`/`typography`/`rounded`, the `"[...]"` placeholder rule, and both light/dark parity requirements. The ten-step scale intent, the per-section conventions and the implementation mapping table also stay. Dropped are the example blocks the template already ships and the per-section level reminders.
- The completeness levels now have one home: a new `design-md-spec.md` §7 defines Level 1–3, the cumulative pass rule, the `BELOW_MVP`/`MVP`/`Standard`/`Production` verdict vocabulary, the body-confirmation cap that stops a frontmatter-only audit at Standard, and the placeholder upgrade path. `references/completeness-checklist.md` keeps its checkable items and cites §7 instead of restating each level's purpose, verdict and capability list; `SKILL.md`'s Evidence section collapses to the same pointers.
- `SKILL.md` states which artefact wins when the skill's own files disagree: the spec on rules, the template on shape. A template that contradicts a stated rule is the defect.

<!-- CN -->
- 删除 `skills/mstar-design-md/references/vercel-example.md`：那份带注释的 Geist `DESIGN.md` 复述了模板已经承载的骨架，而它所参照的外部项目本身可链接。`SKILL.md` 的两处引用与其 Guard 9 预算条目一并移除。
- 将 `references/design-md-spec.md` 从 508 行压缩到 176 行，只保留规范条款。引擎强制的每条规则都保留：必需的 frontmatter 分组及其 map 形态、颜色取值格式、五属性 typography 对象（`fontFamily`/`fontSize` 非空）、`spacing.base` 加数字倍数键与 px 值、px 的 `rounded` 值、必须能在 `colors`/`typography`/`rounded` 内解析的 `{path}` 引用、`"[...]"` 占位规则，以及 light/dark 双向 parity 要求；十步色阶语义、各节约定与实现映射表同样保留。删除的是模板已提供的示例块与各节的层级提示。
- 完整性层级现在只有一个家：`design-md-spec.md` 新增 §7，定义 Level 1–3、逐级累计的通过规则、`BELOW_MVP`/`MVP`/`Standard`/`Production` 判定词表、仅凭 frontmatter 的审计最高只到 Standard 的正文确认上限，以及占位标记的升级路径。`references/completeness-checklist.md` 保留其可勾选项，改为引用 §7，不再复述各层级的目的、判定与能力清单；`SKILL.md` 的 Evidence 节同样收敛为指针。
- `SKILL.md` 明确本 skill 内部文件冲突时的裁决：规则以 spec 为准，形态以 template 为准；与已述规则冲突的模板即缺陷。
