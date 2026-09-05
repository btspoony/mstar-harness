---
packages: root
---
- PR review synthesis now uses a **tiered three-way vet**: must-fix / should-fix findings get the full attack (counter-example, simpler explanation, evidence verifiability); nits get evidence-verify only (open the cited file, confirm `file:line` supports the claim). Domain seats keep their full three-way attack — tiering applies to the main-agent synthesis pass only.

<!-- CN -->
- PR 评审综合阶段改为**分层三向 vet**：must-fix / should-fix 走完整三向攻击（反例、更简解释、证据可验证）；nit 仅做证据核验（打开被引文件，确认 `file:line` 支撑论断）。领域席位保持完整三向攻击——分层仅作用于主代理综合阶段。
