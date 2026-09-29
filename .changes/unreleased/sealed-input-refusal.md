---
category: Harness
packages: root
---

- A sealed input that is missing or unreadable now reports as a structured `coordination.assignment-stale` refusal everywhere instead of a raw filesystem error: the stale-pin adoption's plan half and the pre-activation readers of the recorded Assignment read once through one shared read-or-refuse helper (no `existsSync` check-then-act window — a deletion, move, or unreadable path between a check and its read can no longer leak an `ENOENT`/`EISDIR` out of a decision), and the message family names its input: `Assignment <path> changed or is gone` for the Assignment half, `plan document <path> changed or is gone` for the plan half, same code and same `path` detail on both transports.

<!-- CN -->
- 缺失或不可读的 sealed 输入现在统一以结构化的 `coordination.assignment-stale` 拒绝，而不再泄漏原始文件系统错误：stale-pin adoption 的 plan 半边与读取“已记录 Assignment 路径”的 pre-activation 读者都改经同一个 read-or-refuse 辅助函数一次性读取（不再有 `existsSync` 的 check-then-act 窗口——检查与读取之间的删除、移动或不可读路径不再能把 `ENOENT`/`EISDIR` 漏出判定），且文案族点明其输入：Assignment 半边为 `Assignment <path> changed or is gone`，plan 半边为 `plan document <path> changed or is gone`，两条 transport 的 code 与 `path` 细节一致。
