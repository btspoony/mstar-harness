---
packages: dsh
---

- **The workflow panel reads the store directly.** The right-sidebar panel now polls one store-backed `mstar/panelSnapshot` read while its tab is visible and renders that snapshot, instead of an emission relayed through the agent's own state. The agents tab and its projection surface are retired: the tabs are 任务迭代 / 项目路线图 / 事件记录, the roadmap page renders direction, goals and milestones with their open issues, and the event log is a single time-descending flow carrying dispatch, settle and violation rows. Every degraded read keeps its own state and copy — an unreadable ledger, an unreadable roadmap, a project without a roadmap and a roadmap without milestones are four different renders, never one "empty".

<!-- CN -->
- **工作流面板改为直接读取 store。** 右侧栏面板现在在页签可见时轮询一次 `mstar/panelSnapshot` 的 store 读取，并据此渲染，不再依赖经由 agent 自身 state 中转的 emission。代理执行页签及其投影面已退役：页签为任务迭代 / 项目路线图 / 事件记录，路线图页渲染方向、目标与里程碑及其未关闭议题，事件记录是单一按时间倒序的流转，行内含派发、结算与违规。每种降级读取都保留各自的状态与文案——账本不可读、路线图不可读、项目无路线图、路线图无里程碑是四种不同渲染，绝不合并为一个「空」。
