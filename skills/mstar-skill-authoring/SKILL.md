---
name: mstar-skill-authoring
description: "Use when creating/rewriting a skill (`SKILL.md`), narrowing a description trigger, compressing a body, reviewing skill structure, or editing model-visible non-body text (schemas, CLI help, refusals, Assignment fields). Not for app features."
---

# Skill Authoring

本 skill 约束如何编写、审查与验证 **任意** agent skill（`SKILL.md`），以及 skill body 之外的模型可见文本（见「Progressive Disclosure」）。面向 **skill 工作**，不是普通应用功能实现。它判 skill 是否成型——名称、`description` 触发契约、5 问 body、渐进披露；body 内的文字是否在 HEAD 可解析归 **`mstar-prose`**，本 skill 不复述其判断。

## Load Order

在本 harness 仓库内工作时：先 Read **`mstar-harness-core`**（加载 / 冲突裁决），仓库维护另遵根目录 `AGENTS.md`；在其它仓库 / 宿主上按当地入口文档加载，本文件的原则与门控仍然适用。

改现有 skill 时：读完被改 skill 及其 SSOT 引用；禁止仅为文风重写相邻 skill。

## Workflow

1. 定触发契约：按「Frontmatter Contract」写 `description`（原则 3），再按「Body 必须回答的 5 问」写紧凑 body（原则 2）。
2. 铺开变体：变体细节进 `references/` / `templates/` / `scripts/`，按需加载（「Progressive Disclosure」）。
3. 取证与收尾：行为塑形改动按「验证门控」留 paired 证据（原则 4 + 6），再按「Review Template」自审并回答「完成时主动说明」三问。

## 6 条作者原则（Decision Rules，必须遵守）

来源：SkillsBench 大规模实验。违反任一都会降低 agent 性能。

| # | 原则 | 强制动作 |
|---|------|----------|
| 1 | **专家流程优先** | 先提取真实操作步骤、决策标准、约束、API 坑与失败恢复；模型只做编辑器。禁止把一键生成稿当最终版。 |
| 2 | **紧凑程序性** | body 只答 5 问（见下）；详例 / 长文档按「Progressive Disclosure」下沉。体量上限见「Skill 语料门禁」。 |
| 3 | **路由最小化** | 任务真正需要时才加载；目标 **1–3** 个 skill。description 必须具体到可精准匹配，避免无关激活。 |
| 4 | **按 model+harness 实测** | 文件可移植 ≠ 行为可移植。在实际使用的模型与宿主（omp / Cursor / Codex / Claude Code 等）分别验证触发、执行、token、回归。 |
| 5 | **只补模型缺口** | 编码内部约定、受监管流程、脆弱 API、专业判断、反复失败模式。不写模型已会的通用知识。 |
| 6 | **每次改动=受控实验** | 必须有 paired 证据（with vs without，或 before/after + 可观察标准）。held-out / 压力场景未提升则拒绝合入。禁止“感觉更好”。 |

## Skill 语料门禁（Guard 9–11）

- `bun run validation:drift` 对 `skills/**` 施加三条门禁；逐文件行数上限存放在 `scripts/skill-budgets.manifest.json`，Guard 9 在超出上限、上限条目过期、或随包文件没有条目时失败。
- 上限是护栏而非缩减目标：处于或低于上限的文件永不要求缩短；触碰上限的唯一合法顺序是 **迁移 → 压缩 → 提高上限** —— 先搬进 `references/`，再压缩，最后才在同一 PR 内提高该条目并说明新增文字的理由。
- Guard 10（跨文件重复 HARD 规则）失败即退出非零：同一句 HARD 规则只写在一处，第二个文件改写成指针 → `<skill>` § 小节，例外只进 `scripts/rule-duplication.allowlist.json` 并注明规则 owner（另一个 `skills/` 路径，或本文件加 `owner` 一词）。
- Guard 11（段落锚定）今天只报告、不失败，但新增与修改的段落立即受其约束：一个段落必须是一个物理行（宽度不限），存量折行段落在其文件下次被编辑时顺势合并，不做整仓重排。

## Body 必须回答的 5 问

合格 `SKILL.md` **只**清晰回答：

1. **何时加载？**（触发 / 排除）
2. **按什么顺序与关键决策点执行？**
3. **哪些约束 / 不变量绝不可违反？**
4. **正确结果长什么样？**（成功标准 / 证据）
5. **主路径不够时打开哪些额外资源？**

答不进这 5 问的内容 → 删或移到 `references/`。

已发布的 `mstar-*` 专题 skill 的运行时别名表由引擎的 `lintFiveQuestion(body, "runtime")` 拥有（`packages/engine/src/skill-authoring.ts`），本文件不复制别名；改表须同步引擎回归测试与 corpus。新写 / greenfield skill 走 `authoring` 模式，仍要求 canonical 标题；别名只豁免已发布专题 skill 的机械 lint，**不豁免语义**——别名标题必须真实回答对应问题，正文不得因别名而缩水。

### Completion criterion

每一个 step 都以 completion criterion 收口，它有两个属性：**clarity**——执行者能否分辨 done 与 not-done，因为模糊的界正是 **premature completion** 在 post-completion pull 下的入口；以及 **demand**——界要求多少工作量，“每一个被改动的 model 都已交代”迫使 legwork，“产出一份 change list”则不。防御顺序：先 sharpen the bound；只有界不可再锐化 **且** 已观察到 rush 时才拆分序列，而拆分只在真实 context boundary（handoff 或 subagent）上有效，绝不 inline——inline 拆分把同一份 context 留在同一份压力之下。

### No-op and negation

**no-op**：模型默认就已遵守的指令付出 load 却什么也没说，判据是这句话相对默认行为是否改变行为，失败时删掉整句而不是修剪措辞。**Negation**：以禁止方式转向会把被禁行为拽进 context 并使其更可得，应陈述 positive target，仅在无法正面表述时保留 prohibition，并始终与 positive target 成对出现。两者判断的是句子是否赚回它的 load；句子是否在 HEAD 可解析归 **`mstar-prose`**，本 skill 不复述该测试。

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

标题顺序 `# 标题` → `Load Order` → `Scope`（可省）→ `Workflow` → `Decision Rules` → `Evidence` → `References`，每个 heading 就是对应 5 问的答案位置。

## Skill-relative script and asset paths

When a skill ships executables or assets under `scripts/` / `templates/` / `references/`, name them as **skill → relative path**：

- Good: skill **`my-skill`** → `scripts/do-thing`
- Good: `<my-skill>/scripts/do-thing`（已加载 skill 根的占位写法）
- Bad：把 `skills/my-skill/scripts/do-thing` 写成消费仓库 cwd 下的字面路径

Agents 按 **skill 名** 发现 skill；文档若给出完整仓内相对路径，agent 常在应用仓库 cwd 下按字面搜索而找不到。先解析已加载 skill 根目录，再拼 `scripts/…` / `references/…`。

在本 harness：解析方式见 **`mstar-host`** § Resolve loaded skill root（omp `skill://`、各宿主插件挂载等）。其它环境按当地 skill 安装约定解析。

## Progressive Disclosure

三层分工：frontmatter 只写触发，`SKILL.md` 只写主执行路径，`references/` / `templates/` / `scripts/` 放变体细节、长示例与 schema 并按需加载；每份额外资源都要在 body 写明「何时打开哪一份」。

写 / 评审 skill body **以外**的模型可见文本——tool 与参数定义、Assignment 字段、拒绝与诊断字符串、CLI 帮助——时加载 `references/context-economy.md`（六条原则、三条 tool 定义规则、测量规则）。

skill body 自身的经济性归本 skill 判断；其散文是否在 HEAD 可解析归 **`mstar-prose`**。

## Engine checks

> **Engine check:** run `mstar skill lint <skill-dir>` to lint the frontmatter contract and the five-question body contract; engine `lintFrontmatter`, `lintFiveQuestion`, `resolveAssetPath` resolves the same contracts plus the skill-relative asset paths above. On `fail`, do not proceed — fix and re-run. Contract → **`mstar-use-cli`** `references/checks-and-lints.md` § Engine check callouts.

## 验证门控（Evidence，原则 4 + 6）

行为塑形改动必须留下证据，任选可观测形式：

- 2–3 个压力 prompt（无 skill 易失败；有 skill 应通过）
- before/after 期望 + 触发短语 + 一次具体校验（检索、链接、dry-run）
- 记录失败原因、token / 延迟回归；未提升则回滚文案

压力场景的 eval JSON 骨架 → `references/skillsbench-authoring.md` § Pressure / paired check。

## 完成时主动说明

写完 / 大改 skill 后必须交代：

1. **删了 / 压了什么**，以及如何满足原则 2 与 5  
2. **如何验证原则 6**（paired 证据或压力场景）  
3. **触发契约**是否仍足够窄（原则 3）

## Review Template

逐项一行：trigger contract（原则 3）、5 问覆盖（原则 2）、模型缺口（原则 5）、SSOT 对齐、progressive disclosure、paired 证据（原则 6）、stale references、completion criterion（clarity + demand）与 no-op / negation（任一失败 → `Request Changes`）。

Verdict：`Approve` | `Request Changes` | `Needs Discussion` | `Unconfirmed`——`Unconfirmed` 表示 paired 证据（原则 6）无法建立或核验。

## References

| 何时 | 打开 |
|------|------|
| 需要完整 skill-writer 循环（writer workflow、authoring devices、压力场景骨架、anti-patterns） | `references/skillsbench-authoring.md` |
| 需要把「真实产物」固化为可重跑断言（P6 重武器选项） | `references/regression-fixation.md` |
| 写 / 评审 tool 定义、Assignment 字段、拒绝与诊断字符串等非 skill body 的模型可见文本 | `references/context-economy.md` |
