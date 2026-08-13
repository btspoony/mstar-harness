---
iteration_id: v9.9.9
start_date: 2026-08-01
status: locked
iteration_base_branch: dev-dsh
target_branch:
plans: [plan-a, "plan b"]
---

# Flow-array compass

Golden fixture covering the flow-style array form (`plans: [a, b]` — flat
scalar items only, quote-stripped) and an empty scalar value (`target_branch:`
→ `null`). Expected doc in `golden.json` under `flow-plans.md`.
