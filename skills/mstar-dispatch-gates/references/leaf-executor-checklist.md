# Leaf executor dispatch checklist

> Load **`mstar-harness-core`** first, then **`mstar-dispatch-gates`** SKILL.md.

Before any Task/subagent call:

1. What is my **`Execute as`**?
2. Does the Assignment include **`Delegation: allowed (...)`**? If no → **no** Task/subagent.
3. Is my next step a Task/subagent invoke? If yes without (2) → **stop**; use Read/Write/Shell/Edit in-session or **`Blocked`**.
4. Is `subagent_type` equal to my `Execute as`? If yes → **forbidden** (recursive dispatch).
5. Am I treating `@roles`, Handoff, QA note, Completion Report roles, or multi-plan/multi-track **design text** as invoke commands? If yes → **stop**; deliver in-session.
6. Am I invoking because the tool exists? **Available ≠ authorized.**
7. Need parallel work or PM-only `dispatching-parallel-agents`? → **`Blocked`**; PM dispatches on the next round.

If blocked, report: `## Blocked — recursive dispatch refused (<which NEVER or reason>)`

Full NEVER/DO NOT list → **`mstar-dispatch-gates` SKILL.md**「承接方反递归红线」.
