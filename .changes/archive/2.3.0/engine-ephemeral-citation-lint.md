---
category: Harness
packages: root, cli, engine
---

- **Ephemeral-citation lint (engine)**: new `findEphemeralCitations` scans skill text for short-lived citations — concrete task artifacts (`task-<digits>-(brief|report|fix-report|diff)`, incl. dot form `task-N.diff`) and SDD deeplinks (`.mstar/sdd/` / `.agents/sdd/` + concrete first segment) — while discriminating placeholder forms (`task-N-report`, `<plan-id>`, `{SDD_DIR}/…`, `.mstar/sdd/**` path globs): zero false positives on the current `skills/` corpus.
- **CLI `skill lint`**: third checklist `skill lint (ephemeral citations)` wired into `mstar skill lint` after the five-question checklist; each citation reports as a `skill.ephemeral.<kind>` violation (line + match + placeholder rewrite fix) and sets exit 1.
- **drift-lint guards**: docs audit-enum set-equality (docs/cli.md `<category>` row and README category-focus lists vs the engine `AUDIT_CATEGORIES` — catches fabricated tokens like `deps` and omissions like `bug` / `direction`), README.md / README_CN.md same-commit bilingual pairing over the push range, and a skills-corpus ephemeral guard reusing `findEphemeralCitations`; plus a `citesKnowledgeConventions` exemption for harness-local knowledge citations.

<!-- CN -->
- **短命引用 lint（engine）**：新增 `findEphemeralCitations` 扫描 skill 文本中的短命引用——具体 task 工件（`task-<digits>-(brief|report|fix-report|diff)`，含点号形式 `task-N.diff`）与 SDD 深链（`.mstar/sdd/` / `.agents/sdd/` + 具体首段）——同时判别占位符形式（`task-N-report`、`<plan-id>`、`{SDD_DIR}/…`、`.mstar/sdd/**` 路径 glob）：当前 `skills/` corpus 零误报。
- **CLI `skill lint`**：`mstar skill lint` 五问 checklist 后接入第三项 `skill lint (ephemeral citations)`；每条引用报为 `skill.ephemeral.<kind>` 违规（行号 + 匹配 + 占位符改写建议）并置 exit 1。
- **drift-lint 守卫**：docs 审计枚举集合相等（docs/cli.md `<category>` 行与 README 类别聚焦列表对 engine `AUDIT_CATEGORIES`——捕获 `deps` 这类杜撰 token 与 `bug` / `direction` 这类遗漏）、push 范围内 README.md / README_CN.md 同 commit 双语配对、以及复用 `findEphemeralCitations` 的 skills corpus 短命引用守卫；另加 `citesKnowledgeConventions` 豁免 harness 本地 knowledge 引用。
