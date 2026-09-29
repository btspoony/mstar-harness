---
category: Harness
packages: root, cli, engine, dsh
---

- **Project roadmap authority** now lives in the project store record, not a live `roadmap.md`: CLI, dashboard and dsh read the same content; a known project with no roadmap is reported explicitly.
- **Roadmap authoring** uses read-only import preview and reviewed apply, revision-guarded replacement, and Markdown/JSON transport export. Harness scaffold registers `_default` without writing roadmap Markdown; legacy files remain import candidates or history.
- **Iteration close** reads the stored roadmap, exports an independent candidate and replaces it against observed revisions instead of editing a live project roadmap file. Runtime guidance now points to one governance rule home.
- Fixed roadmap CLI discovery, import-preview round-tripping, dashboard absence handling, and legacy roadmap migration disclosure without creating a second authority.
- Refused worktree cleanup when ignored files would be lost; refreshed the committed hook bundle and migration/scaffold expectations.
- Corrected roadmap dashboard and project-rollup absence messages, and updated migration-6 test expectations.

<!-- CN -->
- **项目路线图权威**现为项目存储记录，而非实时 `roadmap.md`：CLI、仪表盘和 dsh 读取同一正文；已知项目无路线图时明确报告缺失。
- **路线图编写**采用只读导入预览与审核后应用、受版本保护的整份替换，以及 Markdown/JSON 传输导出。初始化仅登记 `_default`，不写路线图 Markdown；遗留文件仅作导入候选或历史。
- **迭代收口**读取存储中的路线图，导出独立候选并按已观察版本替换，不再编辑实时项目路线图文件。运行时指引统一指向项目治理规则。
- 修复路线图 CLI 发现、导入预览往返、仪表板缺失状态处理及旧版路线图迁移披露，且未创建第二内容权威。
- 当忽略文件可能丢失时拒绝清理 worktree；刷新已提交的 hook bundle 及迁移/脚手架预期。
- 修正路线图仪表板与项目汇总的缺失提示，并更新迁移 6 的测试预期。
