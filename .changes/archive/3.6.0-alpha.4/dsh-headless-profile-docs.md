---
packages: dsh
---
- Documented **headless profile support**: the plugin mounts unchanged in the dsh headless profile (`dsh plugin --profile headless add @mstar-harness/dsh`) — all gates, the skill mount, the engine-status catalog, the harness-rules injection, and the 7 `mstar_*` tools ride `dsh-base` seams that headless inherits; verified on dsh 0.1.0-rc.6 (catalog row, harness-dir probe from the session cwd, dispatch-gate hard deny/pass, child dispatch).

<!-- CN -->
- 文档化 **headless profile 支持**：插件零改动即可挂载进 dsh headless profile（`dsh plugin --profile headless add @mstar-harness/dsh`）——全部闸门、技能挂载、engine-status catalog、harness-rules 注入与 7 个 `mstar_*` 工具都落在 headless 继承的 `dsh-base` seam 上；已在 dsh 0.1.0-rc.6 上验证（catalog 行、按会话 cwd 的 harness 目录探测、派发闸门 hard 拒绝/放行、子会话派发）。