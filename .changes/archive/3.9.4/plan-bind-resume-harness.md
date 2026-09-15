---
category: Changed
packages: cli
---

- `plan bind --resume` now refuses a `--harness` override with a usage error (exit 2, no I/O) instead of silently dropping it — the `--assignment` form already rejects that mix, and the session envelope pins the harness root on its own.

<!-- CN -->
- `plan bind --resume` 现在对 `--harness` 覆盖值以用法错误拒绝（exit 2，无 I/O），不再静默丢弃——`--assignment` 形式本就拒绝该组合，且会话信封自身已固定 harness 根。
