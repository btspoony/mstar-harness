---
category: Fixed
packages: root
---

Stop pinning DSh's build output, which is not reproducible, and repair the two CI failures the previous iteration left on `main`.

<!-- CN -->

停止对 DSh 构建产物的字节固定——它本身不可复现——并修复上一轮迭代留在 `main` 上的两处 CI 失败。

<!-- CN -->

同时删除 `packages/cli/src` 里无人生成的陈旧产物及其 `.gitignore` 规则——它此前被计入 source 树摘要，导致本地与 CI 的文件数不一致。
