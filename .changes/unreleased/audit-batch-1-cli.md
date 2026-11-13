---
category: Changed
packages: cli
---

- Made the five `--*-model` overrides independent: each flag now validates only itself, and roles whose
  group was not supplied keep OpenCode's default model. The previous shape refused a documented
  single-flag install four times and then wrote the roles from `--other-models`.
- A supplied `--*-model` value that names no model (`--dev-models ",,"`) now refuses instead of writing
  nothing; only an absent flag leaves the group alone.
- Replaced `linearAuthorize`'s hand-rolled browser launcher with the bounded opener the same effect
  object already used, so a platform opener that never starts now refuses with
  `capability.browser.unavailable` instead of hanging the authorization flow.
- Constrained `init --target` to the supported hosts and `--scope` to `global|project`, so a typo is a
  usage refusal rather than a project-scope write. `--yes` is still accepted; its only effect is to
  suppress the `Scope not provided; defaulting to project` notice — `init` never prompts.

<!-- CN -->
- **五个 `--*-model` 覆盖相互独立**：每个标志只校验自身，未提供的角色组保留 OpenCode 默认模型。
  旧实现会把文档化的单标志安装连拒四次，随后用 `--other-models` 填充其余角色。
- **空覆盖值拒绝**：`--dev-models ",,"` 这类「给了标志但没给模型」现在直接拒绝，不再静默什么都不写；
  只有标志缺席才保留该组不动。
- **`linearAuthorize` 改用有界打开器**：与同一效果对象已有的实现一致。平台打开器不启动时以
  `capability.browser.unavailable` 拒绝，而不是挂起授权流程。
- **`init` 选项校验收紧**：`--target` 限定为受支持宿主，`--scope` 限定 `global|project`，拼错即
  usage 拒绝而非按 project 写盘；`--yes` 仍被接受，唯一作用是抑制
  `Scope not provided; defaulting to project` 提示——`init` 从不交互提问。
