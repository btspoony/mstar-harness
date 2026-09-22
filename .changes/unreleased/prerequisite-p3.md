---
category: Changed
packages: engine, cli
---

- Extended the guarded **Prepare workflow amendment** (`amendPrepareWorkflow` / `mstar workflow amend-prepare`) with the optional `correctPlanFiles` list (prerequisite contract §4.1): each entry names one existing Todo row by the **exact pointer it holds now** (`expectedFile`) and that row's own canonical plan file (`file`), repairing a malformed repository-relative pointer without a raw snapshot edit. `appendPlans` stays present — a correction-only call passes an empty append array.
- A correction moves only the addressed row's `file` (plus the ordinary `updated_at`); every other row field, the root register and the review documents survive by value. It refuses an unknown or ambiguous row, a mismatch between the row's pointer and `expectedFile`, an old pointer that does not identify that same plan, a no-op pointer, an id that collides with an append or repeats, and a corrected pointer the shared `resolveRegisteredPlanFile` refuses — all without writes, under the unchanged coordinator identity, Prepare/no-execution admission, double byte-version CAS, exact compass plan-id set and last-moment compass recheck.
- The old pointer is accepted in only two forms: one the shared resolver accepts (canonical absolute or normalized harness-relative), or the exact repository-relative spelling derived from this control root's configured plan directory and the repository root that owns it. A foreign absolute path, a same-basename guess, an unrelated directory prefix and a copied plan document with a matching header all refuse; normal registration and readiness still do not accept that spelling.

<!-- CN -->
- 为受守卫的 **Prepare workflow 修订入口**（`amendPrepareWorkflow` / `mstar workflow amend-prepare`）新增可选 `correctPlanFiles` 列表（前置契约 §4.1）：每个条目以该行**当前持有的精确指针**（`expectedFile`）和该行自身的规范 plan 文件（`file`）定位一条既有 Todo 行，从而在无需手工改快照的前提下修复畸形的仓库相对指针。`appendPlans` 仍然存在——仅做修正的调用传空数组。
- 修正只移动被指向行的 `file`（以及常规 `updated_at`）；其余行字段、根注册表与 review 文档全部按值保留。未知行或指向有歧义的行、行指针与 `expectedFile` 不一致、旧指针并不指向同一 plan、不产生变化的指针、与 append 冲突或重复的 id、以及被共享解析器 `resolveRegisteredPlanFile` 拒绝的新指针，一律零写入拒绝；coordinator 身份、Prepare/no-execution admission、双重字节版本 CAS、compass plan-id 集合与最后一次 compass 复检保持不变。
- 旧指针只接受两种形式：共享解析器接受的形式（规范绝对路径或规范化 harness 相对路径），或由本控制根已配置的 plan 目录与拥有它的仓库根推导出的**精确**仓库相对拼写。越界绝对路径、同名猜测、无关目录前缀、以及带有匹配 header 的复制文档一律拒绝；常规注册与 readiness 仍不接受该拼写。
