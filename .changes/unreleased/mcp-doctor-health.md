---
category: Harness
packages: root
---

- **Doctor**: inspect packaged MCP build metadata and server files for six bundled host targets and report alignment/mismatch/unavailable states. DSH reports MCP as unavailable until its Cordis launch configuration exists; it has no native MCP bundle. Refuse runtimes below each packaged target's native floor.

<!-- CN -->
- **Doctor**：检查六种已打包宿主目标的 MCP 元数据与服务文件，并报告对齐、失配或不可用状态。DSH 尚无原生 MCP bundle，Cordis 启动配置建立前报告 MCP 不可用。拒绝低于各打包目标原生最低版本的运行时。
