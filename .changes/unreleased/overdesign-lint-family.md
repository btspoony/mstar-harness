---
category: Harness
packages: root
---

- Added an **over-design lint family** enforcing the frozen #341/#365 contracts in CI: `lint:refusal-quality` (structured-channel cause/recovery presence) and `lint:help-reachability` (recovery text must name reachable verbs/flags), alongside the now-CI-wired `lint:hash-gates` (`continue-on-error` pending tracked triage of pre-existing main findings). Bounded allowlists reference real tracking issues.
- Added a **QC judge lens** (`overdesign-judge.md`, required on engine/commands diffs): the rules AST cannot decide — gate necessity vs the declared operating model, gate-vs-contract agreement, self-written-output classification, protocol sizing — advisory by design so the judge never becomes a new over-gate.
- Added a **known-answer backtest suite** proving the family catches its historical instance classes from #340/#341, with honest not-covered rows routed to judged examples.

<!-- CN -->
- 新增**过度设计 lint 家族**在 CI 强制执行 #341/#365 冻结契约：`lint:refusal-quality`（结构化拒绝通道的 cause/recovery 存在性）与 `lint:help-reachability`（恢复文本必须指向可达动词/旗标），并入已接线的 `lint:hash-gates`（`continue-on-error`，待既有 main 违规分诊后翻阻断）；有界豁免清单均以真实跟踪 issue 为凭。
- 新增 **QC 判例透镜**（`overdesign-judge.md`，engine/commands diff 必读）：承载 AST 无法判定的规则——门限对运行模型的必要性、门限与契约一致性、自写记录重验、协议尺度——设计为 advisory，判例席自身不得成为新的过度门禁。
- 新增**已知答案回测套件**，证明该家族能抓住 #340/#341 的历史实例类，未覆盖类如实标注并转入判例审查。
