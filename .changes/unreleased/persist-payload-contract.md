---
category: Changed
packages: commands
---

- Declared per-kind `persist.write` payload schemas and explicitly identify arbitrary `json` persistence as parse-only validation.
- Surface aggregate status validation failures through the persist command while preserving coordinated replacement/version-conflict handling.

<!-- CN -->
- 为 `persist.write` 声明按 kind 区分的 payload schema，并明确任意 `json` 持久化仅执行语法解析验证。
- persist 命令聚合呈现 status 校验错误，同时保留协调式替换与版本冲突处理。
