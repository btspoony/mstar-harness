---
name: mstar-skill-authoring
description: Agent skill 撰写 / 重写 / 优化规范（SkillsBench 实验门控）。在新建任意 skill、大改 SKILL.md、改写 description 触发契约、压缩过长 body、评审 skill 结构、或判断某段行为塑形文案是否值得保留时读取。适用于任何领域的 skill，不限于本仓库专题；不用于普通应用实现。
---

# Skill Authoring

本 skill 约束如何编写、审查与验证 **任意** agent skill（`SKILL.md`）。面向 **skill 工作**，不是普通应用实现。

## Load Order

在本 harness 仓库内工作时：先 Read **`mstar-harness-core`**（加载 / 冲突裁决）；仓库维护另遵根目录 `AGENTS.md`。

在其它仓库 / 宿主上使用本 skill 时：按当地入口文档加载；本文件的原则与门控仍然适用。

改现有 skill 时：读完被改 skill 及其 SSOT 引用；禁止仅为文风重写相邻 skill。

详细 writer 流程与输出模板 → `references/skillsbench-authoring.md`（需要完整循环时再读）。

## 6 条作者原则（必须遵守）

来源：SkillsBench 大规模实验。违反任一都会降低 agent 性能。

| # | 原则 | 强制动作 |
|---|------|----------|
| 1 | **专家流程优先** | 先提取真实操作步骤、决策标准、约束、API 坑与失败恢复；模型只做编辑器。禁止把一键生成稿当最终版。 |
| 2 | **紧凑程序性** | body 只答 5 问（见下）；详例 / 长文档进 `references/`，按需加载。过长 body 几乎无提升甚至负提升。 |
| 3 | **路由最小化** | 任务真正需要时才加载；目标 **1–3** 个 skill。description 必须具体到可精准匹配，避免无关激活。 |
| 4 | **按 model+harness 实测** | 文件可移植 ≠ 行为可移植。在实际使用的模型与宿主（omp / Cursor / Codex / Claude Code 等）分别验证触发、执行、token、回归。 |
| 5 | **只补模型缺口** | 编码内部约定、受监管流程、脆弱 API、专业判断、反复失败模式。不写模型已会的通用知识。 |
| 6 | **每次改动=受控实验** | 必须有 paired 证据（with vs without，或 before/after + 可观察标准）。held-out / 压力场景未提升则拒绝合入。禁止“感觉更好”。 |

## Body 必须回答的 5 问

合格 `SKILL.md` **只**清晰回答：

1. **何时加载？**（触发 / 排除）
2. **按什么顺序与关键决策点执行？**
3. **哪些约束 / 不变量绝不可违反？**
4. **正确结果长什么样？**（成功标准 / 证据）
5. **主路径不够时打开哪些额外资源？**

答不进这 5 问的内容 → 删或移到 `references/`。

## Skill Purpose Test

仅当全部成立才新建 / 扩写 skill：

1. 行为应跨多项目、角色或任务复用。
2. 需要判断或排序，且不宜用代码强制。
3. 现有 skill 树尚未拥有同一规则（避免副本）。
4. 触发条件可写清，agent 知道何时读取。

不要为这些建 skill：一次性项目约定（放项目 `AGENTS.md` / 等价处）、可 lint/脚本化的机械规则、无复用手法的事故叙述、已有 skill 规则的副本。

## Frontmatter Contract

```yaml
---
name: example-skill
description: Use when...
---
```

- `name`：稳定、小写、连字符。
- `description`：**触发契约**，不是流程摘要。写清症状、上下文、角色、产物与排除条件。
- 第三人称；足够具体以避免无关加载（原则 3）。
- 禁止在 description 里总结整条 workflow（否则 agent 可能只跟摘要、跳过 body）。

Bad：`Explains how to write plans with steps, tests, commits, and review gates.`  
Better：`Use when a non-trivial task has a spec or requirements and needs a written implementation plan before code changes.`

## 默认 Body 结构

```markdown
# Skill Title

## Load Order
## Scope
## Workflow
## Decision Rules
## Evidence
## References
```

Keep `SKILL.md` focused on the main execution path. Move long examples, templates, schemas, and detailed variants into `references/`, `templates/`, or `scripts/`.

## Skill-relative script and asset paths

When a skill ships executables or assets under `scripts/` / `templates/` / `references/`, name them as **skill → relative path**：

- Good: skill **`my-skill`** → `scripts/do-thing`
- Good: `<my-skill>/scripts/do-thing`（已加载 skill 根的占位写法）
- Bad：把 `skills/my-skill/scripts/do-thing` 写成消费仓库 cwd 下的字面路径

Agents 按 **skill 名** 发现 skill；文档若给出完整仓内相对路径，agent 常在应用仓库 cwd 下按字面搜索而找不到。先解析已加载 skill 根目录，再拼 `scripts/…` / `references/…`。

在本 harness：解析方式见 **`mstar-host`** § Resolve loaded skill root（omp `skill://`、各宿主插件挂载等）。其它环境按当地 skill 安装约定解析。

## Progressive Disclosure

1. Frontmatter：仅触发  
2. `SKILL.md`：主执行路径  
3. `references/` / `templates/` / `scripts/`：变体细节，按需加载  

多宿主 / 多域细节按文件拆分，并在 body 写明「何时打开哪份」。

## 验证门控（原则 4 + 6）

行为塑形改动必须留下证据，任选可观测形式：

- 2–3 个压力 prompt（无 skill 易失败；有 skill 应通过）
- before/after 期望 + 触发短语 + 一次具体校验（检索、链接、dry-run）
- 记录失败原因、token / 延迟回归；未提升则回滚文案

压力场景骨架：

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "会诱使 agent 违反目标规则的真实任务",
      "expected_output": "合规行为长什么样",
      "files": []
    }
  ]
}
```

## 完成时主动说明

写完 / 大改 skill 后必须交代：

1. **删了 / 压了什么**，以及如何满足原则 2 与 5  
2. **如何验证原则 6**（paired 证据或压力场景）  
3. **触发契约**是否仍足够窄（原则 3）

## Review Template

```markdown
## Skill Review
- Trigger contract:
- 5 questions covered:
- Principles 2/5 compactness:
- SSOT alignment:
- Progressive disclosure:
- Evidence for behavior change (P6):
- Stale references checked:
- Verdict: Approve | Request Changes | Needs Discussion
```

## References

| 何时 | 打开 |
|------|------|
| 需要完整 skill-writer 流程、原则细则、输出模板 | `references/skillsbench-authoring.md` |