---
packages: root, engine
---
- omp plugin: in-process engine binding — model-callable mstar_* validator tools + blocking tool_call gate hook (Enforcement: hard only; commands shell-out stays as fallback).
- engine: `iteration.parseCompassFrontmatter` moved from CLI (shared single parser; CLI re-imports from engine).

<!-- CN -->
- omp 插件：进程内 engine 绑定 —— 模型可调用的 mstar_* 校验工具 + 阻断型 tool_call gate hook（仅 Enforcement: hard 生效；命令层 shell-out 保留为 fallback）。
- engine：`iteration.parseCompassFrontmatter` 从 CLI 移入 engine（单一共享解析器；CLI 改从 engine 重新导入）。
