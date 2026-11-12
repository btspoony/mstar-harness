---
category: Fixed
packages: opencode-v2
---

- **The V2 package's live version citations follow the manifest pin.** `assets.ts` and `hooks/bootstrap.ts` still named `2.1.3` while the manifest pinned `2.2.5`, so a reader checking a projection claim landed on the wrong tag. Every live claim now states the pin, and the three that assert a shape cite the installed declaration they were checked against (the bootstrap anchor moved with the pinned interface). Historical receipts keep the version they recorded.
- **The OpenCode V2 host-presence note states the generation the installer ships.** The knowledge document named `@opencode/plugin` `2.0.26`; it now matches the manifest pin.

<!-- CN -->
- **V2 包中现行的版本引用现在跟随 manifest pin。** `assets.ts` 与 `hooks/bootstrap.ts` 仍写着 `2.1.3`，而 manifest 钉的是 `2.2.5`，读者核对投影声明时会落到错误的 tag 上。现在每条现行声明都给出该 pin，其中三条断言具体形状的声明还标出它们据以核对的已安装声明（bootstrap 的锚点随被钉接口移动）。历史收据保留其记录的版本。
- **OpenCode V2 host-presence 说明现在写的是安装器实际交付的那一代。** 知识文档写的是 `@opencode/plugin` `2.0.26`；现在与 manifest pin 一致。
