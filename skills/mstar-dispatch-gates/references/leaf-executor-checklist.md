# Leaf executor dispatch checklist

> Load **`mstar-harness-core`** first, then **`mstar-dispatch-gates`** SKILL.md.
>
> **First**: read the `**IDENTITY**` and `**CAPABILITY BOUNDARY**` blocks at the top of your Assignment. Those tell you who you ARE and what tools are NOT yours. Then read the `**You are a leaf executor. You MUST NOT:**` prohibitions. Those anti-patterns are customized for your specific role+context and are the authoritative dispatch boundaries for this assignment.

**Preamble — internalize before any action:**

I am a leaf executor. I personally complete all work. Task/subagent is NOT my tool. If I think about dispatching, I stop and return to my direct work or write `Blocked`.

Before any Task/subagent call (if I somehow forget the preamble):

1. What is my **`Execute as`**?
2. Does the Assignment include **`Delegation: allowed (...)`**? If no → **no** Task/subagent.
3. Is my next step a Task/subagent invoke? If yes without (2) → **stop**; use Read/Write/Shell/Edit in-session or **`Blocked`**.
4. Is `subagent_type` equal to my `Execute as`? If yes → **forbidden** (recursive dispatch).
5. Am I treating plain `role-id` mentions, Handoff, QA gate, Completion Report roles, or multi-plan/multi-track **design text** as invoke commands? If yes → **stop**; deliver in-session.
6. Am I invoking because the tool exists? **Available ≠ authorized.**
7. Need parallel work or PM-only dispatch? → **`Blocked`**; PM dispatches on the next round.

If blocked, report: `## Blocked — recursive dispatch refused (<which NEVER or reason>)`

Full NEVER/DO NOT list → **`mstar-dispatch-gates` SKILL.md**「承接方反递归红线」.
