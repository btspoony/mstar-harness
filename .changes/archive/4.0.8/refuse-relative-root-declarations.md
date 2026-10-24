---
category: Changed
packages: cli, dsh
---

- **A relative control root is refused, never resolved against the launch directory.** `MSTAR_HARNESS_DIR` must now be an absolute path: a relative value refuses the MCP connection at startup with `mcp.control-root-unresolved`, naming the cause and the absolute-path recovery, because the server's launch directory is the host's and never anchors a caller's root. A per-call `harness` selector follows the same rule as `--harness`: a relative value is a named refusal instead of a launch-directory resolution, so a root selector can no longer double-join through the invocation workspace. The refusal recovery text no longer offers the relative form.
- The mcp `--harness` help and the dsh README document the absolute-only rule.

<!-- CN -->
- **相对控制根现在被拒绝，不再按启动目录解析。** `MSTAR_HARNESS_DIR` 必须是绝对路径：相对值会在启动时以 `mcp.control-root-unresolved` 拒绝整条 MCP 连接，并给出原因与绝对路径的恢复路径，因为服务器启动目录属于宿主，永远不能作为调用方根的锚点。按调用传入的 `harness` selector 与 `--harness` 遵循同一规则：相对值得到具名拒绝，而不是按启动目录解析，因此根 selector 不会再经调用工作区二次拼接。拒绝的 recovery 文案不再提供相对写法。
- mcp 的 `--harness` 帮助文本与 dsh README 同步说明仅接受绝对路径。
