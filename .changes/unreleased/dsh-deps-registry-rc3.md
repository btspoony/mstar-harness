---
packages: root
---

- **dsh plugin**: `@deepseek-ai/dsh-*` peers upgraded to the `0.1.0-rc.3` line (`^0.1.0-rc.3`; `@deepseek-ai/cordis` `^4.0.1` — same-class alignment with the dsh-advisor upstream bump, `dsh-external/dsh-advisor#14`); every installed version below `0.1.0-rc.3` (old `0.0.1-rc.x` / `0.1.0-rc.2` lock entries and nested copies) was purged from `bun.lock` + `node_modules`. The monorepo root gains a `bun` `overrides` entry pinning `@deepseek-ai/dsh-llm` to `^0.1.0-rc.3`: bun otherwise installs same-version nested peer copies for each dependent dsh package, and TS 5.9 package-id resolution treats the copies as distinct modules — the plugin's `MessageSourceMap` augmentation (`mstar-engine-status` catalog kind) no longer merges into the union dsh-agent/dsh-session see, breaking `createUserMessage` typing at the `agent/pre-step` catalog push. `tests/peer-deps.spec.ts` pins `^0.1.0-rc.3`.

<!-- CN -->
- **dsh 插件**：`@deepseek-ai/dsh-*` peer 升级到 `0.1.0-rc.3` 线（`^0.1.0-rc.3`；`@deepseek-ai/cordis` `^4.0.1`——与 dsh-advisor 上游升级同类对齐，`dsh-external/dsh-advisor#14`）；所有低于 `0.1.0-rc.3` 的已装版本（旧 `0.0.1-rc.x` / `0.1.0-rc.2` 的 lock 条目与嵌套副本）已从 `bun.lock` + `node_modules` 清除。monorepo 根新增 `bun` `overrides` 条目，把 `@deepseek-ai/dsh-llm` 钉在 `^0.1.0-rc.3`：否则 bun 会为每个依赖它的 dsh 包安装同版本的嵌套 peer 副本，TS 5.9 的 package-id 解析把副本视为不同模块——插件在 `MessageSourceMap` 上的 augmentation（`mstar-engine-status` catalog kind）无法并入 dsh-agent/dsh-session 看到的联合类型，导致 `agent/pre-step` catalog push 处 `createUserMessage` 类型报错。`tests/peer-deps.spec.ts` 固定 `^0.1.0-rc.3`。
