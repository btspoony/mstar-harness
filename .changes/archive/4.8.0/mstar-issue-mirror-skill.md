---
category: Harness
packages: root
---

- Added the on-demand **`mstar-issue-mirror`** skill: it drives the host-owned Linear mirror loop — `issue-sync pending` → create/update through the host's Linear MCP tools (payload + marker verbatim) → `issue-sync apply --results -` → `issue-sync ingest --records -` — and states the lease, bucket, recovery and refusal rules. It asks the host to expose Linear MCP tools (`mcp__linear__*`, discovered at runtime); mstar itself makes no Linear call. Details of the Linear MCP server and the dsh `linear-mcp` row live in its `references/linear-mcp.md`.

<!-- CN -->
- 新增按需加载的 **`mstar-issue-mirror`** skill：驱动 host 拥有的 Linear 镜像循环——`issue-sync pending` → 用宿主 Linear MCP 工具按 payload + marker 原样创建/更新 → `issue-sync apply --results -` → `issue-sync ingest --records -`——并写明 lease、bucket、恢复与拒绝规则。它要求宿主暴露 Linear MCP 工具（`mcp__linear__*`，运行时发现）；mstar 自身不发起任何 Linear 调用。Linear MCP 服务器与 dsh `linear-mcp` 行的细节见其 `references/linear-mcp.md`。
