---
category: Harness
packages: root
---

- **Slash-command entries are thin launchers again.** `commands/` shrank from 418 lines / 46.9 kB to 169 lines / 13.6 kB (−71%) by deleting text its owning skills already carry: Phase flow and gate restatements, the Phase 1 pre-integration checklists, tier/verdict/re-review summaries, dsh-only fan-out instructions, executor routing tables and per-step recon/discover/judge/vet prose. Each entry keeps its trigger description, argument parsing, mount order, the entry-specific supplements only it can own (the bundled `grill-me` pointer and its autonomous opposite in `/iteration-loop`, Phase 5 helper discovery, the host-native fan-out pointer) and its report shape; every procedure contract points at its owner (`mstar-iteration`, `mstar-audit/references/*`, `mstar-host`).
- **One home for the Phase 1 completion checklist.** The duplicated block in `/iteration-start` and `/iteration-loop` moved to `mstar-iteration/references/phase-1-prepare.md` §1.6, so phase-gate edits no longer require touching two command files.
- Aligned `docs/commands.md` with the entries (codebase-audit scope/effort args, the test-audit fan-out owner) and removed the stale `iteration-start` §6 cross-reference.

<!-- CN -->
- **斜杠命令入口重新变成瘦启动器。** `commands/` 从 418 行 / 46.9 kB 压到 169 行 / 13.6 kB（−71%），删掉的是所属 skill 已经承载的文字：Phase 流程与门禁复述、Phase 1 预集成清单、tier/verdict/re-review 摘要、仅 dsh 用的扇出说明、执行者路由表，以及逐步骤的 recon/discover/judge/vet 叙述。每个入口只保留触发描述、参数解析、挂载顺序、只有它自己才能承载的补充（`/iteration-loop` 的 bundled `grill-me` 不加载规则、Phase 5 helper 发现、宿主原生扇出指针）与报告形状；所有流程契约指向其 owner（`mstar-iteration`、`mstar-audit/references/*`、`mstar-host`）。
- **Phase 1 完成清单只留一处。** `/iteration-start` 与 `/iteration-loop` 里重复的清单移入 `mstar-iteration/references/phase-1-prepare.md` §1.6，之后改门禁不再需要同时改两个命令文件。
- 同步 `docs/commands.md`（codebase-audit 的 scope/effort 参数、test-audit 的扇出 owner），并清掉过时的 `iteration-start` §6 交叉引用。
