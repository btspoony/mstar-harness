---
category: Changed
packages: engine
---

- Added the presence-only **Task budget (implement / ops rounds)** gate to the Assignment validator: implement/ops-round assignments without the header (or with an empty/`N/A` value) now fail validation with `assignment.field.task-budget-missing` (severity high); review/audit rounds and read-only orientation keep their existing complement semantics.

