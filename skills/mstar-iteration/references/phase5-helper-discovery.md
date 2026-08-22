# Phase 5 helper skill discovery（babysit / greploop）

> Loaded by `mstar-iteration` §5 (iteration command layer) before the first merge-ready loop pass. Search for optional **non-`mstar-*`** helper skills；first readable `SKILL.md` wins per name. Does **not** enter `mstar-*` load order.

## Search paths（示例，按宿主扩展）

| Skill | Search paths |
|-------|--------------|
| `babysit` / `*-babysit` | `skills/babysit/SKILL.md`；`skills/*-babysit/SKILL.md`；`~/.cursor/skills-cursor/babysit/SKILL.md`；`~/.cursor/skills-cursor/*-babysit/SKILL.md`；`~/.agents/skills/babysit/SKILL.md`；`~/.agents/skills/*-babysit/SKILL.md` |
| `greploop`（optional） | `skills/greploop/SKILL.md`；`~/.cursor/skills-cursor/greploop/SKILL.md`；`~/.agents/skills/greploop/SKILL.md`；Codex plugin `skills/greploop/` — **only adopt when the repo uses Greptile / has greploop** |

## Mode selection（babysit-first）

| Priority | Condition | Read before loop | Primary done signal |
|----------|-----------|------------------|---------------------|
| 1 | `babysit` **or** any `*-babysit` found | that skill’s `SKILL.md`（prefer exact `babysit`, else first matching `*-babysit`） | Required CI **all green** + **all** review threads **resolved** |
| 2 | `greploop` found **and** repo has Greptile/greploop | `greploop` SKILL.md | Greptile score **5/5** on this PR（**additive** — does not replace priority-1 gates） |
| 3 | else neither babysit/`*-babysit` | —（command fallback = babysit 同级 CI + reviews 门禁） | Required CI **all green** + **all** review threads **resolved** |

**Both babysit/`*-babysit` and greploop apply**: run **babysit/`*-babysit` first**（CI + reviews），then optional greploop until Greptile **5/5**（串行）。Do **not** prefer greploop over babysit。

**No greploop / repo without Greptile**: skip greploop entirely — babysit/`*-babysit` or fallback only。

**All modes** share the §5.2 exit checklist（CI + reviews + mergeable；Greptile 5/5 only when greploop mode ran or repo shows a Greptile score）。
