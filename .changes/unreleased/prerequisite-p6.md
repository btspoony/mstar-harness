---
category: Harness
packages: root
---

- Documented the shipped coordinator identity routes in the skill corpus: the host-owned `mstar_coordinator` entry (`bind`, `show-recovery`, `recover`), the local `plan bind --coordinator --session-id` form, the `mstar workflow recover-coordinator` verb, and the registered-plan pointer forms. The corpus now separates them explicitly from the active-store DB recovery (full execution token + stop attestation) and from the native one-shot handoff (`mstar-host/references/omp.md`, `mstar-use-cli/references/plan-and-workflow.md`, `mstar-use-cli/references/preconditions.md`).
- Registered plan pointers are documented as the **canonical absolute** `{PLAN_DIR}/<plan-id>.md` — a canonical absolute or normalized harness-relative input is accepted, the repository-relative `.mstar/plans/<id>.md` spelling is refused before the first journal/snapshot/root write — and the guarded `correctPlanFiles` correction is the only same-row repair, changing only `row.file` plus `updated_at` under the existing Prepare admission and double byte-version CAS (`mstar-artifacts/references/status-and-residuals.md`, `mstar-iteration/references/phase-1-prepare.md`).
- The corpus no longer presents the retired per-call `MSTAR_HOST_SESSION_ID` bash revision or a generated coordinator id as available routes: a coordinator identity is explicitly acquired, the inherited variable is a declared input form for a plan/assignment bind only, and a `plan bind --coordinator` attempted through the shell is refused with a redirect to the host-owned tool. The recovery projection is documented as public facts only — never envelope bytes, an envelope path or a credential.
- Documentation only: no source behaviour, flag or refusal code changes here, and no installed generation, released verb availability or operational handoff is claimed.

<!-- CN -->
- 在技能正文中记录已交付的 coordinator 身份路径：宿主自有入口 `mstar_coordinator`（`bind`、`show-recovery`、`recover`）、本地 `plan bind --coordinator --session-id` 形态、`mstar workflow recover-coordinator` 动词，以及注册 plan 的指针形式。正文现明确把它们与 active-store 的 DB 恢复（完整 execution token + stop 证明）和原生一次性 handoff 区分开（`mstar-host/references/omp.md`、`mstar-use-cli/references/plan-and-workflow.md`、`mstar-use-cli/references/preconditions.md`）。
- 注册 plan 的指针记录为**规范绝对路径** `{PLAN_DIR}/<plan-id>.md`——接受规范绝对路径或规范化 harness 相对路径，仓库相对拼写 `.mstar/plans/<id>.md` 在第一条 journal／snapshot／根写入之前即被拒绝；受守卫的 `correctPlanFiles` 修正是唯一的同行修复手段，在既有 Prepare 准入与双重字节版本 CAS 下只改动 `row.file` 与 `updated_at`（`mstar-artifacts/references/status-and-residuals.md`、`mstar-iteration/references/phase-1-prepare.md`）。
- 正文不再把已退役的逐次 `bash` 环境变量改写、以及「生成 coordinator id」当作可用路径：coordinator 身份必须显式获取，继承的环境变量仅是 plan/assignment 绑定的声明输入形式，通过 shell 发起的 `plan bind --coordinator` 会被拒绝并重定向到宿主自有工具。恢复的投影只记录公开事实——绝不含信封正文、信封路径或凭据。
- 仅文档变更：不改任何源码行为、标志或拒绝码，也不声称已安装代次、已发布动词可用性或真实 handoff。
