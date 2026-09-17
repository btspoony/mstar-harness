---
category: Harness
packages: root
---

- Added a host-agnostic **host hook anchor** contract to the host-adapter skill — `iteration-entry`, `phase-1-lock`, `phase-2-entry`, `rescheduling-checkpoint` — each carried by a marker in the shared lifecycle references and resolved by the active host reference.

- The OMP host reference now declares, per anchor, the coordinator calls that were previously documented but never wired, so a coordinator session actually executes them.

- Removed shared-corpus host-name leaks from the four densest files; the relocated per-host role-binding field and engine-scope detail now lives in the host references.

- The remaining corpus cleanup is tracked as a roadmap goal (`host-seam-corpus-cleanup`).

<!-- CN -->
- 在宿主适配 skill 中新增宿主无关的**宿主钩子锚点**契约——`iteration-entry` / `phase-1-lock` / `phase-2-entry` / `rescheduling-checkpoint`——每个锚点由共享生命周期引用中的标记承载，并按当前宿主引用解析。

- OMP 宿主引用现按锚点声明此前仅有文档、从未接线的协调器调用，协调器会话会真正执行它们。

- 清理了四个密度最高的共享文件中残留的宿主名泄漏；被迁出的逐宿主角色绑定字段与引擎作用域细节现落在宿主引用中。

- 剩余的语料清理登记为 roadmap 目标（`host-seam-corpus-cleanup`）。
