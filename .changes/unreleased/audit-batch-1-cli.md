---
category: Changed
packages: cli
---

- Made the five `--*-model` overrides independent: each flag now validates only itself, and roles whose
  group was not supplied keep OpenCode's default model. The previous shape refused a documented
  single-flag install four times and then wrote the roles from `--other-models`.
- Replaced `linearAuthorize`'s hand-rolled browser launcher with the bounded opener the same effect
  object already used, so a platform opener that never starts now refuses with
  `capability.browser.unavailable` instead of hanging the authorization flow.
- Constrained `init --target` to the supported hosts and `--scope` to `global|project`, so a typo is a
  usage refusal rather than a project-scope write. `--yes` keeps working but its help text now says what
  it does: `init` never prompts.

<!-- CN -->
- **五个 `--*-model` 覆盖相互独立**：每个标志只校验自身，未提供的角色组保留 OpenCode 默认模型。
  旧实现会把文档化的单标志安装连拒四次，随后用 `--other-models` 填充其余角色。
- **`linearAuthorize` 改用有界打开器**：与同一效果对象已有的实现一致。平台打开器不启动时以
  `capability.browser.unavailable` 拒绝，而不是挂起授权流程。
- **`init` 选项校验收紧**：`--target` 限定为受支持宿主，`--scope` 限定 `global|project`，拼错即
  usage 拒绝而非按 project 写盘；`--yes` 仍可用，但 help 说明它只是接受并忽略提示。
