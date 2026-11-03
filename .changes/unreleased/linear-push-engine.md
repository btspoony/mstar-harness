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
  `--force-create` decides that a remote issue is absent. It cannot decide that an attempt already in flight was
  never sent, so while a `pending` row carries no id the flag is REFUSED: the row may belong to a create still
  inside its provider call, and a second one beside it could never be reconciled. The refusal names the three
  recoveries — re-run push so reconcile adopts by marker, record an identity you can see with `--adopt`, or, when
  the scan proves nothing carries the marker and the issue is genuinely gone, `--release <localId>`. A release
  drops that `pending` create to the retryable `failed` edge with the operator's judgement as its reason, so the
  same run may create; a scan that found a match refuses it, because that item's recovery is adoption. Where no
  unresolved attempt stands, a create takes the send-right claim under one shared key — binding, item, content
  hash and the ledger revision — so two runs that read the same revision contend for exactly one create, while a
  sequential retry stays distinct because every refusal, failure and apply advances that revision.
- **Labels are resolved, never created.** Kind→label is resolved against the workspace's real label set
  discovered through `list_issue_labels`; a mapped name the workspace lacks refuses that item
  (`linear.label-unresolved`) and other items proceed. A changed kind adds the new label and removes every
  recorded candidate via `removeLabels` — a row with no recorded label only adds, the full-replace `labels`
  argument is never sent, and a host handshake whose schema does not advertise `removeLabels` refuses that
  update before any write. An update whose receipt is unconfirmed keeps BOTH the old and the attempted label as
  candidates, so the retry removes whichever one the remote actually kept.
- **Workflow states are resolved the same way.** Disposition→state is resolved against the bound team's real
  workflow states discovered through `list_issue_statuses`; a mapped name the team lacks refuses that item
  (`linear.state-unresolved`) before the call and names the `[linear.mapping] disposition.<state>` redirect, so a
  renamed workflow is diagnosed in the run instead of failing every item at the provider. The report carries the
  state set the run resolved against, beside the label set.
- **Writes need a write scope.** The run refuses with `linear.scope-insufficient` before any provider call when
  the stored credential's `scope` carries neither `issues:create` nor `write`, naming the explicit
  reauthorization (`mstar linear auth login` or the dsh Settings Authorize). A refresh never widens a read-only
  grant. Operator recovery beyond automatic reconcile: `--adopt <localId>=<issueUrl|externalId>` records an
  identity you confirmed, `--force-create <localId>` asserts remote absence — refused while an unresolved
  create attempt stands, so reconcile, adopt or release first — and `--release <localId>` clears that attempt
  once reconcile's own scan proves no remote issue carries the item's marker.
- **Adoption drops the proof of a REPLACED identity.** `--adopt` records the identity you confirmed and, when that
  is a different issue than the row already pointed at, CLEARS the payload hash and label ownership it held: both
  described the previous issue, so carrying them over would report `skipped` for content the newly adopted issue
  never received and let a later kind change remove a label recorded for the previous one. Content therefore
  converges onto the adopted issue in the same run. Re-confirming the id already recorded is not a replacement:
  its hash and ownership still describe that same remote issue, so they are kept and a later kind change removes
  the label it owns. Replacing an identity that is already recorded is refused as `sync.identity-conflict` unless
  `--force-adopt <localId>` names that item.
- **A refused update is visible on the row.** A push whose write the provider refuses reports `failed`; when the
  row already holds an identity, `applied → failed` is not a legal edge, so the cause is recorded through the
  error-only verb instead. The row keeps its state, identity and proof, the dashboard shows the cause, and the
  changed hash still makes the next run retry the write. A `pending` row with no id is untouched as before, so
  reconciliation can still find it.
- **A create lands in the bound project.** `save_issue` is called with the bound `project` as well as the
  `team`, so a created issue sits where the binding says and the marker-based recovery reads (which filter by
  that project) can find it. An update never sends `project`: the recorded identity already lives in the right
  project, and the argument would move it.
- **The state refusal names the key the resolver reads.** `linear.state-unresolved` points at
  `[linear.mapping] disposition.<key>`, where `<key>` is the DEFAULT target state the local disposition maps to
  (`Todo`/`Done`/`Canceled`), because that is the key `stateOfDisposition` looks up. `waived`, `duplicate` and
  `superseded` all collapse onto `Canceled`, and the message says so instead of printing a local disposition
  name no resolver reads.
- **The probe deadline aborts the call it timed out.** `LinearProbeDeps.rpc` now receives an `AbortSignal` that
  fires when the handshake deadline expires, so a transport stuck in flight is cancelled instead of being
  abandoned while it keeps holding its socket. The caller still observes the same single
  `unreachable: Linear MCP handshake timed out after <n>ms` cause; a transport that reports the abort as its own
  error cannot turn that into a transport failure.
- **A refresh commit honours a newer sign-out or grant.** Every writer decides inside `commitLinearCredential`,
  whose lineage check re-reads the file and declines when a `mstar linear logout` or a re-authorization landed
  during the refresh's network round trip — the long window that used to be overwritten. The remaining
  microsecond window between that final read and the rename is accepted: a sign-out landing exactly there can be
  overwritten by the refresh it raced, and the operator clears the stale grant by signing out again. The dsh
  refresh and the CLI `issue-sync` refresh both commit through that seam.

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
  `--force-create` 判定的是远端 issue 不存在。它无法判定一次仍在飞行中的尝试从未发送，因此当存在不带 id 的
  `pending` 行时该标志会被拒绝：该行可能属于仍在 provider 调用中的创建，而在它旁边再建一个永远无法对账。
  拒绝文本会点名三条恢复路径——重跑 push 让对账按标记采纳，用 `--adopt` 记录你已看到的身份，或在扫描证明
  没有任何 issue 携带该标记、且该 issue 确实已不存在时用 `--release <localId>`。释放会把这条 `pending`
  创建落到可重试的 `failed` 边上，并以操作者的判断作为原因，因此同一次运行即可创建；若扫描找到了匹配则会
  拒绝释放，因为那一项的恢复手段是采纳。在不存在未解决尝试的情况下，创建同样需要取得发送权，且共用同一个键：
  绑定、条目、内容 hash 与账本 revision——读过同一 revision 的两次运行只会争到一次创建，而顺序重试仍能区分，
  因为每次拒绝、失败与应用都会推进该 revision。
- **标签只解析、绝不创建。** kind→label 会针对通过 `list_issue_labels` 发现的真实工作区标签集解析；工作区没有该
  名称时仅拒绝该项（`linear.label-unresolved`），其余项继续。kind 变化时新增新标签，并通过 `removeLabels` 移除
  全部已记录的候选标签；没有记录标签的行只做新增，全量替换的 `labels` 参数永不发送，握手 schema 未声明
  `removeLabels` 的宿主会在任何写入之前拒绝该次更新。未确认的更新会把旧标签与被尝试的新标签都保留为候选，
  因此重试会移除远端实际保留的那一个。
- **工作流状态同样只解析、绝不创建。** disposition→state 会针对绑定的团队通过 `list_issue_statuses` 发现的真实工作流
  状态解析；团队缺少该名称时仅拒绝该项（`linear.state-unresolved`），并在调用之前指名字段重定向
  `[linear.mapping] disposition.<state>`，因此重命名过的流程会在本次运行里被诊断出来，而不是让每一项都在 provider
  处失败。报告会同时带上本次运行解析所用的状态集与标签集。
- **写入需要写权限。** 当存储凭据的 `scope` 既无 `issues:create` 也无 `write` 时，运行在任何 provider 调用之前即以
  `linear.scope-insufficient` 拒绝，并指明显式重新授权（`mstar linear auth login` 或 dsh Settings Authorize）。
  刷新永远不会扩大只读授权。自动对账之外的操作者恢复手段：`--adopt <localId>=<issueUrl|externalId>` 记录你已确认的
  身份；`--force-create <localId>` 断言远端不存在，但在存在未解决的创建尝试时会被拒绝，因此先对账、采纳或释放；
  `--release <localId>` 在对账自身的扫描证明没有任何远端 issue 携带该项标记后，清除该次创建尝试。
- **采纳会丢弃上一身份的证明。** `--adopt` 记录操作者确认的身份，并**清除**该行原有的载荷 hash 与标签归属：
  两者描述的是它此前指向的那个 issue，沿用会让本次运行对新采纳的远端从未收到的内容报告 `skipped`，
  也会让之后的 kind 变更移除属于上一个 issue 的标签。因此内容会在同一次运行内收敛到被采纳的 issue 上。
  替换一个已记录的身份会被拒绝为 `sync.identity-conflict`，除非用 `--force-adopt <localId>` 指名该项。
- **被拒绝的更新在行上可见。** provider 拒绝写入时推送报告 `failed`；当该行已持有身份时，`applied → failed`
  不是合法边，因此改用只写错误的那条动词。行保留自己的状态、身份与证明，面板能看到原因，而变化的 hash
  仍会让下一次运行重试写入。没有 id 的 `pending` 行一如既往不受影响，对账依然能找到它。
- **创建落在绑定的项目里。** `save_issue` 在 `team` 之外还会带上绑定的 `project`，使新建 issue 落在绑定所指的
  项目内，按标记对账的恢复读取（以该项目过滤）也才找得到它。更新从不发送 `project`：已记录的身份本来就在
  正确的项目里，带上该参数等于移动它。
- **状态拒绝会点名解析器真正读取的键。** `linear.state-unresolved` 指向
  `[linear.mapping] disposition.<key>`，其中 `<key>` 是本地 disposition 映射到的**默认**目标状态
  （`Todo`/`Done`/`Canceled`），这正是 `stateOfDisposition` 查找的键。`waived`、`duplicate`、`superseded`
  都收敛到 `Canceled`，消息会说明这一点，而不再打印任何解析器都不读的本地 disposition 名。
- **探测超时会中止它自己超时的那次调用。** `LinearProbeDeps.rpc` 现在会收到一个在握手超时到期时触发的
  `AbortSignal`：卡在飞行中的传输会被真正取消，而不是被丢下继续占用 socket。调用方观察到的仍是同一条
  `unreachable: Linear MCP handshake timed out after <n>ms` 原因；传输把中止当成自己的错误上报也无法把它
  变成 transport 失败。
- **刷新提交会尊重更晚的登出或新授权。** 每个写入方都在 `commitLinearCredential` 内做判断：它的血缘检查会重新读取
  文件，并在刷新等待网络的往返期间发生了 `mstar linear logout` 或重新授权时拒绝本次写入——这正是过去会被覆盖的
  长窗口。最后一次读取与 rename 之间剩下的微秒级窗口为已接受限制：恰好落在此处的登出可能被与之竞争的刷新覆盖，
  操作者再次登出即可清除这条陈旧授权。dsh 的刷新与 CLI `issue-sync` 的刷新都经此接缝提交。
