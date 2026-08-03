# 为 mstar-harness 新增 ZCode 主机适配器（修订版）

## 关键修订：CLI adapter 改为 Codex 式「直接写 marketplace 注册文件」

扫描本地 `~/.zcode/` 后确认 ZCode **有完整的磁盘 marketplace 机制**，与 Codex 几乎对称，不需要 Cursor 式 git-checkout + UI 提示的绕行方案：

| 文件 | 作用 | 对应 Codex |
|------|------|-----------|
| `~/.zcode/cli/plugins/known_marketplaces.json` | marketplace 注册表，`marketplaces[]` 每项 `{id, source, name, description, addedAt, pluginCount, lastUpdated}` | `~/.agents/plugins/marketplace.json` |
| `~/.zcode/cli/plugins/marketplaces/<id>/marketplace.json` | 单个 marketplace 的内容（标准 ZCode marketplace 格式：`name` + `plugins[]`，每项 `source` 支持 `directory`/`github`/`url`/`filesystem`） | 同一文件的 `plugins[]` |

`known_marketplaces.json` 真实结构（已读到）：
```json
{ "version": 1, "marketplaces": [
  { "id": "...", "source": {"source":"github","repo":"owner/repo"} | {"source":"url","url":"..."},
    "name": "...", "description": "...", "addedAt": ISO, "pluginCount": N, "lastUpdated": ISO }
]}
```

→ CLI adapter 仿照 `codex.ts`：注册一个 marketplace「mstar-local」(directory source 指向 `~/.mstar/harness`)，写 `known_marketplaces.json` + `marketplaces/mstar-local/marketplace.json` 两个文件。这比之前方案更完整、更可 doctor 校验。

---

## 目标

把 ZCode 作为 mstar-harness 的**第五个 host surface**，与 OpenCode / Cursor / Codex / Kimi 对齐。版本 `1.5.6`（与三个 manifest + 根 package.json 同步）。Tool 模型按当前 ZCode 会话工具写。

## 改动清单

### A. 核心语义 + 主机适配器 SSOT

**A1. 新建 `.zcode-plugin/plugin.json`**（模板：`.kimi-plugin/plugin.json`）
- `name: "morning-star-harness"`, `version: "1.5.6"`, `skills: "./skills/"`, `commands: "./commands/"`, `agents: "./agents/"`。
- `keywords` 加 `zcode-plugin`（替代 kimi-plugin）；`description`/`interface.longDescription` 加入 ZCode。
- **移除** Kimi 的 `sessionStart.skill`（ZCode 规范不支持该字段；改在 host reference doc 说明手动 `/morning-star-harness:pm` 入口）。
- 保留 `interface{...}`（displayName/shortDescription/longDescription/developerName/category/capabilities/brandColor/composerIcon/logo/logoDark/defaultPrompt）。

**A2. 新建 `skills/mstar-host/references/zcode.md`**（模板：`kimi.md`）
- 触发信号：`.zcode-plugin/plugin.json` 已装、`Agent`/`AskUserQuestion`/`EnterPlanMode`/`TodoWrite` 工具、`/morning-star-harness:*` 命令。
- Plan mode → 指向 `zcode-plan-mode-bridge.md`。
- **Tool map 按本会话真实工具逐行写**：`Agent`(dispatch, subagent_type) / `AskUserQuestion`(澄清) / `EnterPlanMode`+`ExitPlanMode`(Plan 签核) / `TodoWrite`(会话 todo) / `Bash` / `Read` / `Edit` / `Write` / `WebSearch` / `WebFetch` / `TaskOutput`+`TaskStop`(长任务)。
- **Role agents (C5)**：ZCode `Agent` 用内置 `subagent_type`（本会话见 `general-purpose`/`Explore`），**不**支持像 Codex TOML 注册自定义角色 agent → 复用 Kimi C5b「role-in-prompt binding」约束。
- PM dispatch 表 / QC default（sdd→N=3 / inline→N=1）/ SDD 串行 / Clarify / 路径表 / Git evidence / Gotchas 全部从 kimi.md 平移并改工具名。
- 安装：CLI（`npx @mstar-harness/cli init --target zcode`）+ TUI 两条路径。

**A3. 新建 `skills/mstar-host/references/zcode-plan-mode-bridge.md`**（模板：`kimi-plan-mode-bridge.md`，同为 EnterPlanMode/ExitPlanMode 模型）

**A4. 更新 `skills/mstar-host/SKILL.md`**
- L3 `description` 主机列表加 `ZCode`；detect-host 表（L29-35）新增 ZCode 信号行 → `references/zcode.md`；兜底行参考清单加 `zcode.md`。

### B. CLI adapter（packages/cli）— Codex 式 marketplace 写入

**B1. `packages/cli/src/types.ts` L1**
`SUPPORTED_TARGETS = ["opencode","cursor","codex","zcode"] as const`。

**B2. 新建 `packages/cli/src/adapters/zcode.ts`**（模板：`codex.ts`，install 模式）
- 常量：`MARKETPLACE_ID = "mstar-local"`，`ZCODE_PLUGINS_ROOT = ~/.zcode/cli/plugins`，`KNOWN_MARKETPLACES_PATH = <root>/known_marketplaces.json`，`MARKETPLACE_DIR = <root>/marketplaces/mstar-local`，`MARKETPLACE_JSON = <dir>/marketplace.json`。
- 复用 shared-install 的 `ensureLocalHarnessRepo` / `validateLocalHarnessRepo` / `homeRelativeSourcePath` / `ensureObject` / `readJson` / `writeJson`。
- `mstarMarketplaceJson(scope)`：构建标准 ZCode marketplace.json ——
  ```json
  { "name": "mstar-local",
    "plugins": [{
      "name": "morning-star-harness",
      "source": { "source": "directory",
                  "path": scope==="global" ? "<~/.mstar/harness 相对 home>" : "<repo-root 相对>/.zcode/plugin-checkout" },
      "description": "...", "version": "1.5.6", "category": "Productivity" }] }
  ```
  > global 用 directory 指向 `~/.mstar/harness`；project 用 directory 指向 project 内 git checkout（仿 cursor 的 project scope real-checkout，因为 directory source 需要真实目录）。两种 scope 都不 symlink marketplace root。
- `upsertKnownMarketplace(raw, scope)`：维护 `known_marketplaces.json` 的 `marketplaces[]`，去重 by `id==="mstar-local"`，写 `{id, source:{source:"directory",path:<marketplaceDir 父> 或 github repo}, name, description, addedAt, pluginCount:1, lastUpdated: now}`。`source` 字段：global 写 `directory`(指向 `~/.mstar/harness`，因为 marketplace 本身就在 harness 根)；project 写 `github` repo（指向 `btspoony/mstar-harness`，避免 project 内相对路径脆弱）。
- `runInit(scope, dryRun)`：`ensureLocalHarnessRepo` → project scope 时 `ensureGitCheckout(REPO_URL, <projectRoot>/.zcode/plugin-checkout, dryRun)` + gitignore → 写 marketplace.json → upsert known_marketplaces → notes 打印「然后在 ZCode: Settings → Plugin Management → 刷新 → 安装 morning-star-harness」。
- `runDoctor(scope)`：`validateLocalHarnessRepo` + 校验两个 JSON 存在且 entry 形状正确 + project scope checkout + gitignore。
- 导出 `zcodeAdapter: AgentAdapter { target:"zcode", mode:"install", runInstallInit, runInstallDoctor }`。

**B3. `packages/cli/src/adapters/index.ts`** import + 注册 `zcode: zcodeAdapter`。

### C. shared-install marker

**C1. `packages/cli/src/adapters/shared-install.ts` L10**
`HARNESS_MARKERS = [".codex-plugin/plugin.json", ".zcode-plugin/plugin.json"]`（任一存在即过；让 ZCode checkout 也被认作合法 harness repo）。

### D. 文档同步（bilingual）

**D1. `INSTALL.md`**
- Prerequisites 加 ZCode 链接。
- 新增 `### ZCode` 小节（CLI 流程 + project/global 说明 + 「init 后在 ZCode Settings → Plugin Management 安装」步骤），位置在 Codex 与 Kimi 之间。
- Manual install 段加 ZCode「Plugin source in this repository」块。
- Manual install 支持目标行（L111）加 `zcode`。
- Post-install PM 入口加 ZCode 行。

**D2. `README.md` + `README_CN.md`**
- 主机列表（L27/中文对应行）加 ZCode；Per-target examples（L42-45）加 ZCode 行；doctor targets（L47）加 `zcode`。

**D3. `AGENTS.md`**（维护策略 SSOT）
- L29 标题 `Cursor + OpenCode + Codex + Kimi Sync Policy` → 加 `+ ZCode`。
- L145 主机适配器路由行加 `.zcode-plugin/`。
- 新增 `ZCode plugin manifest -> .zcode-plugin/plugin.json` 行。
- L150 后新增 `ZCode install metadata generation -> packages/cli/src/adapters/zcode.ts`。

### E. 现有 manifest description 同步（避免 rule drift）

**E1. `.codex-plugin` / `.kimi-plugin` / `.cursor-plugin` 三个 `plugin.json`**
`description` / `interface.longDescription` 的 `OpenCode, Cursor, Codex, and Kimi Code` → `OpenCode, Cursor, Codex, Kimi Code, and ZCode`（三处统一）。

### F. 验证

- `cd packages/cli && bun run build`（types.ts 常量扩展 → Record<Target> 类型校验覆盖新 adapter）。
- `npx @mstar-harness/cli init --target zcode --dry-run --yes` 输出合理 notes（含 marketplace 注册 + ZCode 安装提示）。
- `npx @mstar-harness/cli doctor --target zcode --scope global`（真实跑，校验两个 JSON + harness repo）。
- `.zcode-plugin/plugin.json` JSON 合法 + name 满足 regex。
- 在真实 ZCode 客户端「Settings → Plugin Management → Discover」看到 mstar-local marketplace 并能安装（最终人工验证）。

## 不做的事（surgical）

- 不新建 `packages/zcode/` npm 包（ZCode 从 directory/github 加载，不走 npm）。
- 不做格式转换（ZCode 直接读 `agents/*.md`，与 Kimi 一致）。
- 不改 OpenCode `bundle-assets`。
- 不改 `.gitignore`（project scope checkout 由 CLI 运行时追加）。
- 不碰 `mstar-routing-eval`。

## 实现顺序（commit 友好）

1. **A1+A2+A3+A4** 核心 SSOT（manifest + host refs + SKILL.md）
2. **B1+B2+B3+C1** CLI adapter
3. **D1+D2+D3** 文档同步
4. **E1** manifest description 同步
5. 每步后 `bun run build` + dry-run 验证

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| ZCode marketplace JSON schema 未公开文档化（靠扫描本地推断） | 字段尽量贴近已读到的真实文件（known_marketplaces.json + 官方 marketplace.json）；doctor 严格校验形状；INSTALL.md 同时给 TUI github 注册路径作为 fallback |
| `source: directory` 是否被 ZCode 运行时接受（只在文档里见过，本地 cache 都是 filesystem/url） | global scope 同时提供「directory 指向 ~/.mstar/harness」+「TUI 用 github:btspoony/mstar-harness 注册」两条；若 directory 不被接受，用户走 github 路径仍可用 |
| project scope directory source 路径相对脆弱 | project scope 用 `github` repo source 注册 marketplace（不依赖本地路径），仅本地 checkout 用于 doctor 校验 |
| ZCode 无 `sessionStart` → 新会话不自动加载 pm | host doc 明确写手动 `/morning-star-harness:pm` 或 `/skill:pm` 入口，不依赖自动加载 |