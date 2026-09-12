---
category: Changed
packages: dsh
---

- Session-scoped **multi-active workflow selection**: catalog cache keys include `session.header.id`, the panel `selectWorkflow` control durably binds one active lifecycle per session, and the engine-status response carries a live `binding` separate from the last model emission. Unbound N>1 is a picker error (`workflow.selection.unbound-multi-active`) — never `workflows[0]`.
