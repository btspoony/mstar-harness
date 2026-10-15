---
category: Fix
packages: root
---

- Removed the OpenCode-style `tools:` mapping (`write`/`edit`/`bash: true`) from the shared role-agent shells: omp reads an agent's `tools` as a tool-name list, so the mapping form is invalid there and broke agent loading on current omp. `mode:` and `permission:` are unchanged, so no host loses a seat restriction and each falls back to its default tool surface.

<!-- CN -->
- 从共享角色 agent 壳中移除 OpenCode 风格的 `tools:` 映射（`write`/`edit`/`bash: true`）：omp 将 agent 的 `tools` 解析为工具名列表，映射形态在 omp 上无效并导致当前 omp 加载 agents 失败。`mode:` 与 `permission:` 未变，因此没有任何宿主丧失席位限制，各宿主回退到自身默认工具面。
