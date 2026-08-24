---
category: Harness
packages: root, opencode, dsh
---
- `mstar-roles` role references are now **identity-first**: mission, scope, and NEVER rules lead each leaf role file; topic `mstar-*` skills moved from top-of-file "Required Skill Dependencies" into a trailing **Skill Preset (PM-Activated)** section. Skills are presets the PM activates per Assignment via a new canonical `Skill presets:` field — without activation, leaf roles execute from identity + assignment and do not self-load topic skills. `project-manager` keeps its required-reading list unchanged as core orchestrator.
- **dsh plugin**: the fallbacks seed mandatory-load line now matches the preset model — `Load mstar-roles (references/<role-id>.md) first — identity comes before skills; load topic skills only when the Assignment activates them via its Skill presets field.` (mirrored in `tests/fallbacks-seeds.spec.ts` and both READMEs; pairing hashes re-recorded).

<!-- CN -->
- `mstar-roles` 角色提示词改为**身份优先**：leaf 角色文件以 mission / 职责 / NEVER 规则开头；原顶部 "Required Skill Dependencies" 下沉为文末 **Skill Preset (PM-Activated)** 预设区。专题 skill 由 PM 在 Assignment 中通过新增的 `Skill presets:` 字段拉起；未拉起时 leaf 角色仅凭身份 + Assignment 执行，不自行加载。`project-manager` 作为核心编排者保持 required reading 不变。

- **dsh 插件**：fallbacks 种子强制加载引导线同步预设模型 —— `Load mstar-roles (references/<role-id>.md) first — identity comes before skills; load topic skills only when the Assignment activates them via its Skill presets field.`（`tests/fallbacks-seeds.spec.ts` 与双语 README 镜像更新；配对哈希已重录）。