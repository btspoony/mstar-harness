---
category: Harness
packages: root, cli, dsh, engine, opencode
---
- Tracked `*.ts` / `*.md` files no longer cite gitignored harness artifacts (paths under `.mstar/` — status.json, plans/, sdd/, iterations/, knowledge/, references/, archived/, docs/): engine/host/test comments and docs now reference `{HARNESS_DIR}` / the consumer default or drop the local path; the drift-lint `.mstar/`-citation exemption is removed (the guard now enforces the rule), and AGENTS.md codifies it.

<!-- CN -->
- tracked 的 `*.ts` / `*.md` 文件不再引用 gitignored 的 harness 产物（`.mstar/` 下的 status.json、plans/、sdd/、iterations/、knowledge/、references/、archived/、docs/ 等路径）：engine/host/测试注释与文档改用 `{HARNESS_DIR}` / 消费者默认值或直接去掉本地路径；drift-lint 的 `.mstar/` 引用豁免已移除（该守卫现在直接强制此规则），规则已写入 AGENTS.md。
