---
category: Harness
packages: root, commands, judgment
---

- Repaired the first red runs of the newly registered `test-judgment` / `test-commands` jobs: shadow-supervisor container-only cases now probe for their declared environment (Linux platform, listable `/proc`, writable `/mnt/output`) and skip with a visible reason naming the missing capability instead of failing on hosts without it, and the synthesis-pack tests assert `validatePack` content equality (`toEqual`) since validation intentionally returns a normalized derived copy, not the same reference.

<!-- CN -->
- 修复新注册的 `test-judgment` / `test-commands` 任务首轮红榜：shadow-supervisor 仅容器用例现在探测其声明环境（Linux 平台、可列出 `/proc`、可写 `/mnt/output`），缺失能力时以可见原因跳过（点名缺失能力）而非直接失败；synthesis-pack 测试改为断言 `validatePack` 内容相等（`toEqual`），因为校验有意返回规范化的派生副本而非同一引用。
