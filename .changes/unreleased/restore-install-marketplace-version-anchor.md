---
packages: root
---
- Restored the quoted `"version"` field in the INSTALL.md ZCode marketplace example that `release:prepare` bumps every release — its removal in #183 broke **Release prep** with `INSTALL.md: could not find quoted "version" field`. The snippet now documents the field as release-maintained so it is not removed again.

<!-- CN -->
- 恢复了 INSTALL.md ZCode marketplace 示例中带引号的 `"version"` 字段——`release:prepare` 每次发布都会 bump 它,#183 中的删除导致 **Release prep** 报 `INSTALL.md: could not find quoted "version" field`。示例现已注明该字段由发布流程维护,请勿手工移除。
