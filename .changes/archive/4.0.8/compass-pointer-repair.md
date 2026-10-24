---
category: Changed
packages: engine, commands, omp, root
---

- **A registered delivery-compass pointer is now admitted at registration and repairable afterwards (I-000863).** `mstar iteration register --compass-ref` and the new `mstar workflow compass-ref` resolve the named document against the harness root and store only its canonical harness-relative form; a repository-relative `.mstar/...` spelling, a pointer naming no document, an empty or unparseable compass, an invalid frontmatter field set, and a compass declaring another `iteration_id` are refused before the registration transaction opens, so no workflow row, plan row or catalog entity is published. `workflow compass-ref --workflow <id> --compass <ref> --reason <why>` repairs a pointer a wrong writer already stored: it preserves the workflow/session/plan identities, their rows and their history, replays an identical operation id and conflicts on a different reason.
- **The `phase-1-lock` readiness checkpoint names the pointer it refuses.** A row storing no pointer, a pointer resolving to another document (including the `.mstar/.mstar/...` double-join), and each authored anchor mirror that disagrees with the registered workflow now report their own diagnostic with the `mstar workflow compass-ref` repair, instead of one silent `binding-invalid`. The extension renders every distinct diagnostic and every distinct next step, not only the first.

<!-- CN -->
- **已注册的 delivery compass 指针现在在注册时即被接纳校验，且事后可修复（I-000863）。** `mstar iteration register --compass-ref` 与新增的 `mstar workflow compass-ref` 都会把所命名的文档按 harness 根解析，并且只存储其规范的 harness 相对形式；仓库相对写法 `.mstar/...`、不指向任何文档的指针、空文档或无法解析的 compass、非法的 frontmatter 字段集合，以及声明了其它 `iteration_id` 的 compass，都会在注册事务开启之前被拒绝，因此不会发布任何 workflow 行、plan 行或 catalog 实体。`workflow compass-ref --workflow <id> --compass <ref> --reason <why>` 用于修复此前被错误写入者存下的指针：它保留 workflow/session/plan 身份、其行记录与历史，相同 operation id 会重放，reason 不同则冲突。
- **`phase-1-lock` 就绪检查会指名它所拒绝的指针。** 未存指针的行、解析到另一份文档的指针（包括 `.mstar/.mstar/...` 双重拼接），以及与已注册 workflow 不一致的各个已编写锚点镜像，现在各自报告自己的诊断并给出 `mstar workflow compass-ref` 修复路径，而不再是单个静默的 `binding-invalid`。扩展会渲染每一条不同的诊断与每一个不同的下一步，而不仅是第一条。
