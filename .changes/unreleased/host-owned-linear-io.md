---
category: Changed
packages: engine,commands,cli
---

- **Breaking:** removed `mstar linear auth` and the mstar-owned Linear transport entirely — no OAuth flow, no credential file, no REST/GraphQL client remains in the engine, commands or CLI.
- **Breaking:** replaced `issue-sync push` and `issue-sync import` with three local verbs: `issue-sync pending` (plan payloads + correlation marker, no network), `issue-sync apply --results` (record the agent's Linear tool results), `issue-sync ingest --records` (associate a listing by the `repo/local/author` marker; five buckets, never creates/updates/closes a local issue).
- Correlation is now a git-identity marker (`repo` from the origin remote or the `[linear] repo=` override, `local` issue id, `author` from git config); the ledger keeps the same run-lease protocol, and `--adopt` / `--force-adopt` / `--release` / `--take-run` stay on `apply`.
- Migration: delete the old mstar Linear credential file (`$XDG_CONFIG_HOME/mstar/linear/credential.json`, or `~/.config/mstar/linear/credential.json` when `XDG_CONFIG_HOME` is unset — the old reader honoured `XDG_CONFIG_HOME`) — nothing reads it; Linear issues pushed by the previous code carry the retired marker and read as `unmanaged` — run `issue-sync ingest` to see them, then record identities with `issue-sync apply --adopt <localId>=<issueUrl|externalId>`.

<!-- CN -->
- **Breaking：** 移除 `mstar linear auth` 与 mstar 自有的 Linear 传输层——engine/commands/CLI 中不再有 OAuth 流程、凭据文件或 REST/GraphQL 客户端。
- **Breaking：** `issue-sync push` 与 `issue-sync import` 由三个本地动词取代：`issue-sync pending`（规划 payload + 关联 marker，无网络）、`issue-sync apply --results`（记录 agent Linear 工具的结果）、`issue-sync ingest --records`（按 `repo/local/author` marker 关联列表；五个 bucket，绝不创建/更新/关闭本地 issue）。
- 关联改为 git 身份 marker（`repo` 取 origin remote 或 `[linear] repo=` 覆写、`local` issue id、`author` 取 git config）；ledger 沿用原 run-lease 协议，`--adopt` / `--force-adopt` / `--release` / `--take-run` 仍在 `apply` 上。
- 迁移：删除旧的 mstar Linear 凭据文件（`$XDG_CONFIG_HOME/mstar/linear/credential.json`，未设置 `XDG_CONFIG_HOME` 时为 `~/.config/mstar/linear/credential.json`——旧读取器遵循 `XDG_CONFIG_HOME`）——已无代码读取它；旧代码推送的 Linear issue 带退役 marker，会读作 `unmanaged`——先跑 `issue-sync ingest` 查看，再用 `issue-sync apply --adopt <localId>=<issueUrl|externalId>` 记录身份。
