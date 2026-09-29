---
category: Harness
packages: root
---

- A sealed input that is **gone** now reports as a structured `coordination.assignment-stale` refusal everywhere instead of a raw filesystem error: the stale-pin adoption's plan half and every pre-activation reader of the recorded Assignment read once through one shared read-or-refuse helper with **no** `existsSync` check-then-act window, so a deletion or move between a check and its read can no longer leak an `ENOENT` out of a decision. Only absence (`ENOENT`) is reclassified as staleness — a path that exists but cannot be read (a directory, a permission change, an I/O failure) is rethrown as itself, never dressed up as a stale input. The message family names its input: `Assignment <path> changed or is gone` for the Assignment half, `plan document <path> changed or is gone` for the plan half, same code and same `path` detail on both transports.

<!-- CN -->
- 已**缺失**的 sealed 输入现在统一以结构化的 `coordination.assignment-stale` 拒绝，而不再泄漏原始文件系统错误：stale-pin adoption 的 plan 半边与所有读取“已记录 Assignment 路径”的 pre-activation 读者都改经同一个 read-or-refuse 辅助函数一次性读取，**不再有** `existsSync` 的 check-then-act 窗口——检查与读取之间的删除或移动不再能把 `ENOENT` 漏出判定。只有“缺失”（`ENOENT`）才被归类为 staleness；路径存在但不可读（目录、权限变更、I/O 失败）按原样抛出，绝不伪装成 stale 输入。文案族点明其输入：Assignment 半边为 `Assignment <path> changed or is gone`，plan 半边为 `plan document <path> changed or is gone`，两条 transport 的 code 与 `path` 细节一致。
