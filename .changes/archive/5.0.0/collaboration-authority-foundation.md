---
category: Breaking
packages: root
---

- **Collaboration state moved out of the execution store.** Issues, findings, occurrences, relations, provenance, projects, roadmaps, milestones, mirror ledgers, and portable catalog identity now live in one user-level SQLite database per canonical repository (`<user home>/.mstar/repos/<host>/<owner>/<repo>/collaboration.db`); `{HARNESS_DIR}/store.db` keeps execution state, projections, host state, and the cross-domain bookkeeping only.
- **A collaboration mode is declared only to leave the local default.** An absent `[collaboration]` section or an absent `mode` selects `local`; a section declaring `mode=mirror` or `mode=remote` (the header alone on its line, the mode on the next line) selects another authority:
  ```ini
  ; optional — an absent section selects `local`
  [collaboration]
  mode=remote
  ```
  An origin-less repository additionally declares `repo_id` on its own line in that same section, because no origin can supply the identity. Writing the section and the mode on one line leaves the mode undeclared. An empty `mode=` refuses repository-scoped store verbs as `collaboration.mode-required`, an unknown one as `collaboration.mode-invalid`, and a declared mode that disagrees with the published selector as `collaboration.stale-binding`.
- **Operator upgrade path.** Stop every old writer first, then run `mstar store collaboration plan --harness <abs> --out <abs-manifest>`, review the manifest, run `mstar store collaboration apply --harness <abs> --manifest <abs-manifest>`, and publish it with `mstar store collaboration activate --harness <abs> --manifest <abs-manifest> --operator <name> --attestation <abs-attestation>`. A fresh checkout uses `mstar store init`; a checkout that must bind an already published authority uses `mstar store collaboration adopt --harness <abs> --expect-store <store-id>`, because `store init` never adopts an active authority.
- **Reads and gates disclose incompleteness instead of guessing.** Views and host gates carry a scoped collaboration observation with `asOf`, authority stamp, revisions, and completeness; a missing, staged, stale, or unreadable source refuses with a `collaboration.*` code rather than rendering zero or an empty success.
- **Backups are a verified pair, restores are create-only.** `mstar store backup --out <abs-manifest>` now publishes and verifies an execution image plus a collaboration image; `mstar store collaboration restore --harness <abs> --backup <abs-manifest> --operator <name> --attestation <abs>` restores only into an absent canonical target, and `mstar store execution export|restore-preview|restore` remains explicitly execution-only.

<!-- CN -->
- **协作状态移出执行库。** 议题与 finding、occurrence、关系、provenance、项目、路线图、里程碑、镜像账本与可移植目录身份，现由每个规范仓库一个用户级 SQLite 数据库承载（`<用户主目录>/.mstar/repos/<host>/<owner>/<repo>/collaboration.db`）；`{HARNESS_DIR}/store.db` 只保留执行状态、投影、宿主状态与跨域记账。
- **协作模式只在离开本地默认时才声明。** 缺少 `[collaboration]` 段或缺少 `mode` 时选择 `local`；声明 `mode=mirror` 或 `mode=remote` 的段（段头独占一行，模式写在下一行）才会选择其他权威：
  ```ini
  ; optional — an absent section selects `local`
  [collaboration]
  mode=remote
  ```
  无 origin 的仓库还需在同一段内单独一行声明 `repo_id`（没有 origin 可提供身份）。把段头与模式写在同一行会留下未声明的模式。空的 `mode=` 使仓库级 store 动词以 `collaboration.mode-required` 拒绝，取值未知为 `collaboration.mode-invalid`，声明值与已发布 selector 不一致为 `collaboration.stale-binding`。
- **操作者升级路径。** 先停止所有旧写入方，再执行 `mstar store collaboration plan --harness <abs> --out <abs-manifest>`，审阅 manifest 后执行 `mstar store collaboration apply --harness <abs> --manifest <abs-manifest>`，最后用 `mstar store collaboration activate --harness <abs> --manifest <abs-manifest> --operator <name> --attestation <abs-attestation>` 发布。全新检出使用 `mstar store init`；需要绑定已发布权威的检出使用 `mstar store collaboration adopt --harness <abs> --expect-store <store-id>`，因为 `store init` 从不接管已激活权威。
- **读取与门禁披露不完整，而不是猜测。** 视图与宿主门禁携带带作用域的协作观测（`asOf`、权威标识、修订号与完整性）；缺失、暂存、过期或不可读的数据源以 `collaboration.*` 代码拒绝，而不是渲染成零或空成功。
- **备份是经验证的一对镜像，恢复只做 create-only。** `mstar store backup --out <abs-manifest>` 现发布并校验执行镜像与协作镜像；`mstar store collaboration restore --harness <abs> --backup <abs-manifest> --operator <name> --attestation <abs>` 只恢复到不存在的规范目标，`mstar store execution export|restore-preview|restore` 仍明确只作用于执行域。
