---
category: Fixed
packages: engine
---

- **A close no longer blames the checkout for an unwritable `TMPDIR`.** When the delivery proof cannot create the scratch file its diff streams through, the refusal names that write and its path and tells the operator to point `TMPDIR` at a writable directory; the "Git availability requires a readable checkout" cause stays for a checkout Git genuinely cannot read. No fallback path and no retry were added.

<!-- CN -->
- **当 `TMPDIR` 不可写时，close 不再归咎于 checkout。** 交付证明无法创建 diff 所需的临时文件时，拒绝会点名该写入及其路径，并提示操作者把 `TMPDIR` 指向可写目录；「Git availability requires a readable checkout」这一原因仍保留给 Git 确实读不了的 checkout。未新增任何回退路径或重试。
