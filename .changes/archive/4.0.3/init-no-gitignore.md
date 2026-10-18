---
category: Changed
packages: root, cli, commands
---

- **`init` is now a pure install:** it never reads, creates or appends the project `.gitignore`, so the host-specific install paths (`.cursor/plugins/morning-star-harness`, `.codex/agents/*.toml`, `.agents/skills/<name>`, `.zcode/plugin-checkout`) simply stay untracked.
- Removed the `doctor` findings that demanded those ignore entries — the `cursor`, `codex` and `zcode` project checks plus the now-unreachable omp gitignore list.
- `mstar-harness harness scaffold` is unchanged and still emits the canonical `.gitignore` snippet; run it (or add entries yourself) when you want the harness artifacts ignored.

<!-- CN -->
- **`init` 现为纯安装**：不再读取、创建或追加项目 `.gitignore`，各宿主安装路径（`.cursor/plugins/morning-star-harness`、`.codex/agents/*.toml`、`.agents/skills/<name>`、`.zcode/plugin-checkout`）保持未跟踪即可。
- 移除随之失效的 `doctor` 检查：`cursor`、`codex`、`zcode` 的项目级忽略项检查，以及 omp 侧已不可达的忽略清单。
- `mstar-harness harness scaffold` 行为不变，仍输出规范 `.gitignore` 片段；需要忽略 harness 产物时运行它或自行添加条目。
