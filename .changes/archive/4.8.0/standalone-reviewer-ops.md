---
category: Harness
packages: root, cli
---

- **`code-reviewer` and `ops-engineer` accept direct invocation**: a user or standalone Bot can call them without a PM Assignment (`leaf-executor-core.md` § Direct invocation); refusals route to the caller with the resolving input, a direct production deploy or destructive change is `high-risk` even when unmarked, a direct ops write needs a declared branch form (default-branch writes need `Branch policy: direct on …`), a direct audit fans out only under the caller's `Delegation: allowed`, coordinator authority stays with PM, and other leaf roles still take work only through PM dispatch.
- **Codex `code-reviewer` agent**: added `codex/agents/code-reviewer.toml`, installed by `mstar-harness init --target codex`.

<!-- CN -->
- **`code-reviewer` 与 `ops-engineer` 支持直接调用**：用户或独立 Bot 可不经 PM Assignment 直接调用（`leaf-executor-core.md` § Direct invocation）；拒绝回报给调用方并写明可解决的输入，直接调用的生产部署或破坏性变更即使未标记也按 `high-risk` 处理，直接调用的 ops 写入须声明分支形式（写默认分支须 `Branch policy: direct on …`），直接调用的审计仅在调用方写明 `Delegation: allowed` 时扇出，协调权仍归 PM，其余 leaf 角色仍只接受 PM 派发。
- **Codex `code-reviewer` agent**：新增 `codex/agents/code-reviewer.toml`，由 `mstar-harness init --target codex` 安装。
