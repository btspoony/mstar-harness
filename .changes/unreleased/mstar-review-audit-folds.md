---
category: Harness
packages: root
---

- **QC deep-review lenses**: `deep-review-lenses.md` gains 5 new lenses — Lifecycle & Concurrency, Ownership / Derived-State, Bounds, Enforcement-Path, Real-Entry-Path — each with 2–4 structured questions answerable via diff/read/grep, plus deepened Testing / Contract lenses and signal-map seats (QC3 default += Enforcement-Path / Ownership; QC2 default += Bounds / Real-Entry-Path).
- **Audit playbook probes**: `mstar-audit` playbook §1/§2/§4/§5 gain 8 codebase-level probes (derived-state drift, bounds covering the final operation, enforcement bypass, real entry path, externally observable state, user-visible output is behavior, public-but-one-caller, unjustified defaults/public options); §5 adds the prove-or-reject methodology for DEBT findings (consumer three-way classification, hand-rolled vs dependency swap bar, mirrored-fact test, strong-candidate families, guards).
- **`/codebase-audit simplify`**: new `simplify` scope variant routes through the existing command — a DEBT-focused deep pass whose findings use Category DEBT and never inline TODOs.

<!-- CN -->
- **QC 深度评审透镜**：`deep-review-lenses.md` 新增 5 个透镜（Lifecycle & Concurrency、Ownership / Derived-State、Bounds、Enforcement-Path、Real-Entry-Path），每个含 2–4 条可由 diff/read/grep 回答的结构化追问；加深 Testing / Contract 透镜；信号映射默认席位同步（QC3 += Enforcement-Path / Ownership；QC2 += Bounds / Real-Entry-Path）。
- **审计 playbook 探针**：`mstar-audit` playbook §1/§2/§4/§5 补 8 条代码库级探针（derived-state drift、bounds covering the final operation、enforcement bypass、real entry path、externally observable state、user-visible output is behavior、public-but-one-caller、unjustified defaults/public options）；§5 新增 prove-or-reject 方法论（消费方三分类、hand-rolled 与依赖替换的门槛、mirrored-fact test、strong-candidate 家族、守卫）。
- **`/codebase-audit simplify`**：新增 `simplify` scope variant，复用现有命令路由——面向 DEBT 的深度扫描，findings 归 Category DEBT，绝不写 inline TODO。
