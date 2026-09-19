---
category: Harness
packages: root, cli
---

- Added the read-only local dashboard: `mstar dashboard` serves the issue list/detail with recorded history, the workflow / iteration / roadmap views and one cumulative captured-vs-retired issue-flow chart on `127.0.0.1` (loopback only, no bind option), from the issue store and the lazy execution/roadmap projections. The dashboard never mutates; unknown historical dates are disclosed and counted separately, pre-store buckets are labelled register history, and the issue-flow chart is paired with an accessible data table.

<!-- CN -->
- 新增只读本地看板：`mstar dashboard` 仅在 `127.0.0.1` 上（仅回环绑定，无 bind 选项）提供 issue 列表/详情（含真实记录历史）、workflow / iteration / roadmap 视图，以及一张累计捕获 vs 退役的 issue-flow 图表；数据源为 issue store 与惰性刷新的执行/roadmap 投影。看板不做任何变更；未知历史日期会被披露并单独计数，store 之前的桶标记为 register history，issue-flow 图表附带可访问的数据表格。
