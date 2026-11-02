---
category: Harness
packages: engine, commands
---

- **One-way push to Linear.** `mstar issue-sync push --project <id>` sends this project's local issues to the
  bound Linear team: create when no remote identity is known, update the confirmed id when a field changed,
  skip with zero write calls when the normalized payload hash is unchanged. Migration 17 adds the ledger's two
  nullable push facts, `last_request_hash` (the skip rule) and `last_kind_label` (the labels mstar may have
  written, kept as a candidate set because an unconfirmed update leaves more than one possible); the import
  direction leaves both null. Only a confirmed receipt or an explicit `--adopt` ever records an
  `external_id`, so a hash is never treated as proof the remote issue exists.
- **An unconfirmed write can never duplicate a create.** The write adapter classifies every outcome as
  `confirmed` / `refused` / `ambiguous`; `refused` is provably not delivered and records `failed` for a safe
  retry, while `ambiguous` leaves the row `pending` with no id. The next run reconciles such rows by the
  application-owned correlation marker `<!-- mstar-sync: <workspace>/<team>/<storeId>/<localId> -->`: exactly
  one match adopts that id, zero or several report `unresolved` and write nothing, and a run with no ambiguous
  residue issues zero listing calls. Title+description equality is never adoption evidence, and the marker
  carries the store's own identity so two harnesses mirroring one team never adopt each other's rows.
- **Labels are resolved, never created.** Kind→label is resolved against the workspace's real label set
  discovered through `list_issue_labels`; a mapped name the workspace lacks refuses that item
  (`linear.label-unresolved`) and other items proceed. A changed kind adds the new label and removes every
  recorded candidate via `removeLabels` — a row with no recorded label only adds, the full-replace `labels`
  argument is never sent, and a host handshake whose schema does not advertise `removeLabels` refuses that
  update before any write. An update whose receipt is unconfirmed keeps BOTH the old and the attempted label as
  candidates, so the retry removes whichever one the remote actually kept.
- **Writes need a write scope.** The run refuses with `linear.scope-insufficient` before any provider call when
  the stored credential's `scope` carries neither `issues:create` nor `write`, naming the explicit
  reauthorization (`mstar linear auth login` or the dsh Settings Authorize). A refresh never widens a read-only
  grant. Operator recovery beyond automatic reconcile: `--adopt <localId>=<issueUrl|externalId>` and
  `--force-create <localId>`.
- **The probe deadline aborts the call it timed out.** `LinearProbeDeps.rpc` now receives an `AbortSignal` that
  fires when the handshake deadline expires, so a transport stuck in flight is cancelled instead of being
  abandoned while it keeps holding its socket. The caller still observes the same single
  `unreachable: Linear MCP handshake timed out after <n>ms` cause; a transport that reports the abort as its own
  error cannot turn that into a transport failure.

<!-- CN -->
- **单向推送到 Linear。** `mstar issue-sync push --project <id>` 把本项目本地 issue 推送至绑定的 Linear 团队：
  未知远端身份时创建，字段变化时更新已确认的 id，规范化载荷 hash 未变时跳过且零写入。迁移 17 为账本新增两个可空
  列：`last_request_hash`（跳过规则的存储）与 `last_kind_label`（mstar 可能写入的标签候选集——未确认的更新会
  留下多个候选）；导入方向两者保持为空。
  只有已确认的回执或显式 `--adopt` 才会记录 `external_id`，hash 从不被当作远端 issue 已存在的证明。
- **未确认的写入绝不会重复创建。** 写适配器把每次结果归为 `confirmed` / `refused` / `ambiguous`：`refused` 可证明
  未送达，记为 `failed` 供安全重试；`ambiguous` 则让该行保持 `pending` 且不带 id。下一次运行按应用自有的关联标记
  `<!-- mstar-sync: <workspace>/<team>/<storeId>/<localId> -->` 对账：恰好一个匹配时采纳该 id，零个或多个则报告
  `unresolved` 且不写入任何内容；没有含糊残留时一次列表调用都不发生。title+description 相同从不构成采纳证据，标记
  携带本 store 自身身份，因此两个镜像同一团队的 harness 永不互相采纳对方行。
- **标签只解析、绝不创建。** kind→label 会针对通过 `list_issue_labels` 发现的真实工作区标签集解析；工作区没有该
  名称时仅拒绝该项（`linear.label-unresolved`），其余项继续。kind 变化时新增新标签，并通过 `removeLabels` 移除
  全部已记录的候选标签；没有记录标签的行只做新增，全量替换的 `labels` 参数永不发送，握手 schema 未声明
  `removeLabels` 的宿主会在任何写入之前拒绝该次更新。未确认的更新会把旧标签与被尝试的新标签都保留为候选，
  因此重试会移除远端实际保留的那一个。
- **写入需要写权限。** 当存储凭据的 `scope` 既无 `issues:create` 也无 `write` 时，运行在任何 provider 调用之前即以
  `linear.scope-insufficient` 拒绝，并指明显式重新授权（`mstar linear auth login` 或 dsh Settings Authorize）。
  刷新永远不会扩大只读授权。自动对账之外的操作者恢复手段：`--adopt <localId>=<issueUrl|externalId>` 与
  `--force-create <localId>`。
- **探测超时会中止它自己超时的那次调用。** `LinearProbeDeps.rpc` 现在会收到一个在握手超时到期时触发的
  `AbortSignal`：卡在飞行中的传输会被真正取消，而不是被丢下继续占用 socket。调用方观察到的仍是同一条
  `unreachable: Linear MCP handshake timed out after <n>ms` 原因；传输把中止当成自己的错误上报也无法把它
  变成 transport 失败。
