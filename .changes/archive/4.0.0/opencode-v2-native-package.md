---
category: Added
packages: root, opencode, opencode-v2, commands, cli
---

- Added **`@mstar-harness/opencode-v2`** — the OpenCode **2.x** native plugin package, authored on the pinned `@opencode/plugin` **2.0.26** SDK. It registers the same bundled `mstar-*` skills, role agents, and iteration commands through the V2 native editor surface, and its `write`/`edit`/`subagent` gates **refuse for real** through the typed `Tool.Error` channel (the V1 package's warn-only no-refusal-channel limitation does not apply here). `patch`, `shell`, and Code Mode stay explicit non-claims; installed-host behavior is unverified.
- Made `mstar init --target opencode` / `doctor --target opencode` **generation-aware**: `--opencode-generation <v1|v2>` always wins; a real install otherwise probes `opencode --version` (major ≥ 2 → `@mstar-harness/opencode-v2`, 1.x → `@mstar-harness/opencode`); probe failure refuses with the flag recovery — no silent v1 fallback — and `--dry-run` previews with probes skipped (an unresolved generation is annotated, never guessed). Config markers are a consistency guard only.
- The V2 config write set keeps the V1 key untouched and preserves user values: plural `plugins` with owned-slot dedupe, `agents.<role>.model` only when supplied, a non-destructive `mcp.servers["morning-star"]` merge, and `$schema` preserved — never invented.
- Docs: new `packages/opencode-v2/README.md` + `INSTALL.md`, dual-generation pointers in the OpenCode (V1) package docs, the V2 section in the `mstar-host` OpenCode reference, and the root README install row.

<!-- CN -->
- 新增 **`@mstar-harness/opencode-v2`** —— OpenCode **2.x** 原生插件包，基于锁定的 `@opencode/plugin` **2.0.26** SDK 编写。经 V2 原生 editor 接口注册同一套打包的 `mstar-*` skills、角色 agents 与 iteration commands；其 `write`/`edit`/`subagent` 门禁通过类型化 `Tool.Error` 通道**真正拒绝**（V1 包"无拒绝通道、仅告警"的限制不适用于此）。`patch`、`shell` 与 Code Mode 仍为明确的不承诺面；installed-host 行为未经验证。
- `mstar init --target opencode` / `doctor --target opencode` 现为**代际感知**：`--opencode-generation <v1|v2>` 始终优先；真实安装否则探测 `opencode --version`（主版本 ≥ 2 → `@mstar-harness/opencode-v2`，1.x → `@mstar-harness/opencode`）；探测失败以该 flag 作为恢复方式拒绝——没有静默回退到 v1；`--dry-run` 跳过探测，未解析的代际以注解如实呈现而绝不猜测。配置 markers 仅作一致性护栏。
- V2 配置写入集不触碰 V1 键并保留用户取值：复数 `plugins`（owned-slot 去重）、仅在调用方提供时写入 `agents.<role>.model`、非破坏性合并 `mcp.servers["morning-star"]`、`$schema` 只保留不发明。
- 文档：新增 `packages/opencode-v2/README.md` 与 `INSTALL.md`、OpenCode（V1）包文档的双代际指针、`mstar-host` OpenCode 参考的 V2 章节，以及根 README 安装行。
