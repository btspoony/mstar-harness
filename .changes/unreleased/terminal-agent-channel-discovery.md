---
category: Harness
packages: root
---

- **The review-seat channel covers both terminal-agent carriers and discovers commands from the loaded one.** `mstar-pr-loop` → `references/terminal-agent-channel.md` replaces the product-specific `references/herdr.md`: `herdr-core` (CLI `hc`) and `herdr` (CLI `herdr`) are interchangeable carriers for the same channel, and the loaded skill is the sole authority for commands and lifecycle. The file records only the channel shape; carrier entry points (`hc --skill`, `herdr --skill`, per-command help) are discovered, not copied, and the two command models are never mixed.
- **Gates, dispatch and recovery follow the loaded carrier.** The three legs use that carrier's own environment check, a template/kind-first agent target choice with a host-to-target fallback table, first-round prompt in the launch task where the carrier supports it, and carrier-specific wait semantics: `hc send --wait --timeout` is a check-in while `herdr agent prompt --wait --timeout` is the wait's total bound.

<!-- CN -->
- **审查席位通道覆盖两种 terminal-agent 载体，并只从已加载的载体发现命令。** `mstar-pr-loop` → `references/terminal-agent-channel.md` 取代产品专用的 `references/herdr.md`：`herdr-core`（CLI `hc`）与 `herdr`（CLI `herdr`）是同一通道可互换的载体，已加载的 skill 是命令与生命周期的唯一权威。文件只记录通道形状；载体入口（`hc --skill`、`herdr --skill`、逐命令帮助）通过发现获得而非复制，两种命令模型不得混用。
- **门禁、派发与恢复按已加载载体执行。** 三道门禁使用该载体自身的环境检查；agent 目标优先取模板/kind，并有 host→目标回退表；载体支持时首轮 prompt 放入启动任务；等待语义按载体区分：`hc send --wait --timeout` 是 check-in，而 `herdr agent prompt --wait --timeout` 是本次等待的总上限。
