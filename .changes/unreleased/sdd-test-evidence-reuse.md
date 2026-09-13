---
packages: engine, cli, opencode
---

- Added a **pure SDD test-evidence contract** in the engine: record schema + validation (`validateSddEvidenceRecord`), artifact verification (`verifySddEvidence`), deterministic two-pass input snapshot digests (`evidenceInputDigest`) and first-match reuse applicability (`assessSddEvidenceReuse`) that keeps integrity, process outcome, input applicability and coverage as four separate outputs — unknown dependency/runtime/environment scope stays uncertain and is never silently a reuse candidate.
- Added scoped **`mstar sdd evidence capture|verify`** CLI commands: one recorded execution of an already-authorized check retains literal argv (no shell), separate raw stdout/stderr logs, the tagged outcome and bounded input/tool/environment fingerprints under `{SDD_DIR}/evidence/<run-uuid>`; every retry gets a new run id. Read-only verify never re-runs the recorded child, reports integrity-only without `--target`, and emits a candidate/changed/uncertain verdict with `--target`. Capture supports POSIX linux/darwin in v1 with bounded logs, inputs, snapshots and timeout; the old `sdd exec` and manual scoped-check reports are unchanged.
- Wired the handoff into the skill corpus: PM publishes the fixed capture request, developers capture authorized checks, QC reviews code/coverage without executing, and QA maps acceptance criteria to the retained record (with an explicit AC/run/integrity/outcome/applicability/coverage/gap table) instead of repeating child commands.

<!-- CN -->
- 引擎新增**纯 SDD 测试证据契约**：记录 schema 与校验（`validateSddEvidenceRecord`）、工件验证（`verifySddEvidence`）、确定性的两遍输入快照摘要（`evidenceInputDigest`）以及首条匹配的复用适用性评估（`assessSddEvidenceReuse`），将完整性、进程结局、输入适用性与覆盖范围保持为四个独立输出 —— 未知的依赖/运行时/环境范围保持 uncertain，绝不静默成为复用候选。
- 新增限定范围的 **`mstar sdd evidence capture|verify`** CLI 命令：对已授权检查的一次执行在 `{SDD_DIR}/evidence/<run-uuid>` 下保留字面 argv（不经 shell）、分离的原始 stdout/stderr 日志、标记结局以及有界的输入/工具/环境指纹；每次重试使用新 run id。只读 verify 绝不重跑被记录的子命令：无 `--target` 时仅报告完整性，带 `--target` 时给出 candidate/changed/uncertain 结论。capture 在 v1 仅支持 POSIX linux/darwin，日志、输入、快照与超时均有界；旧 `sdd exec` 与手工 scoped-check 报告路径不变。
- 交接流程接入技能语料：PM 发布固定的捕获请求，开发者捕获已授权检查，QC 只审代码/覆盖不执行，QA 将验收标准映射到保留记录（含明确的 AC/run/完整性/结局/适用性/覆盖/差距表），不再重复子命令。
