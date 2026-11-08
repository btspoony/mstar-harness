---
category: Harness
packages: root
---

- Added **`mstar-prose`**, the prose-resolvability skill: one test (could a reader at HEAD, with no session transcript, PR thread or uncommitted draft, resolve every reference and verify every claim?), the eight leakage classes, nine keep rules, and the routing rule that sends surviving rationale to `docs/adr/` and surviving work to an issue instead of leaving prose about the session. Its scope is every surface — Markdown, comments, JSDoc, prompts, descriptions, diagnostics, CLI and UI strings, agent instructions — because the two places that already carried the judgment bind only knowledge, plan and README prose, which left `skills/**` unguarded.
- Registration is **on demand only**: a topic-index row in `mstar-harness-core`, an on-demand membership row in `mstar-roles` for `writing-specialist` and for the PM round that judges prose. No default load path selects it, the same way `mstar-design-system` stays opt-in.
- `scripts/skill-budgets.manifest.json` gains the new file's ceiling (100 lines; the file ships at 94), so Guard 9 covers it from its first commit.

<!-- CN -->
- 新增 **`mstar-prose`**（散文可解性 skill）：一条测试（HEAD 上的读者，在没有会话记录、PR 讨论串与未提交草稿的前提下，能否解析每个引用并验证每个声明？）、八类泄漏、九条 keep 规则，以及把存活理由送去 `docs/adr/`、把存活待办送去 issue 的路由规则——而不是把它们留成关于会话的散文。适用范围是**任意表面**——Markdown、代码注释、JSDoc、prompt、描述、诊断、CLI 与 UI 文案、agent 指令——因为此前承载该判断的两处只约束 knowledge / plan / README 正文，`skills/**` 因此无人看管。
- 注册方式**仅按需**：`mstar-harness-core` 增加一行专题索引，`mstar-roles` 为 `writing-specialist` 与「判断散文的 PM 轮次」各加一处按需成员。任何默认加载路径都不选它，与 `mstar-design-system` 的 opt-in 形态一致。
- `scripts/skill-budgets.manifest.json` 增加该文件上限（100 行；文件实际 94 行），因此 Guard 9 从第一次提交起即覆盖。
