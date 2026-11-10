---
category: Fixed
packages: dsh
---

- **The dsh host build owns its source-input provenance.** `bun run --cwd packages/dsh build` now runs `scripts/build-host.ts`, which after a successful build records `.dist-inputs.json`: the outputs it wrote plus a content fingerprint of every reachable input, taken from the build's own metafile rather than a directory walk. The stamp is removed up front and the build throws on failure, so a failed build cannot leave a current stamp over a stale `dist`.
- **Freshness is answered by content, not mtimes.** `checkHostBuild()` answers `current` / `stale` / `missing` and names the offending input, pairing every non-current answer with the single recovery `bun run --cwd packages/dsh build`. The packed-entry smoke consumes that check, so the mtime walk and its `CI_MTIME_GUARD_SKIP_REASON` CI bypass are gone: a regenerated-but-identical input stays `current`, an edited reachable input reads `stale`. The recorded set is the bundle's real inputs, which is why a fresh checkout's mtimes and the `cli:build`-regenerated `packages/commands/src` module no longer produce false answers.

<!-- CN -->
- **dsh host 构建自己掌握源输入溯源。** `bun run --cwd packages/dsh build` 现在执行 `scripts/build-host.ts`：构建成功后写入 `.dist-inputs.json`，记录它写出的输出，以及每个可达输入的内容指纹——可达性取自构建自身的 metafile，而不是目录遍历。stamp 在构建前先被删除，构建失败则抛错，因此失败的构建不可能把旧 `dist` 标成当前。
- **新鲜度按内容判定，而非 mtime。** `checkHostBuild()` 给出 `current` / `stale` / `missing` 并点明出问题的输入，非 `current` 的答案统一配上唯一修复路径 `bun run --cwd packages/dsh build`。打包入口冒烟消费该检查，mtime 遍历及其 `CI_MTIME_GUARD_SKIP_REASON` 的 CI 绕过随之删除：重新生成但内容相同的输入保持 `current`，可达输入被修改则读作 `stale`。记录集是打包产物真实的输入，因此全新检出的 mtime 顺序、以及 `cli:build` 重新生成的 `packages/commands/src` 模块都不再产生错误答案。
