---
category: Documentation
packages: root
---

- **The ZCode hook claim is bounded to the CLI hook surface.** `mstar-host` → `references/zcode.md` and `INSTALL.md` now state that the bundled `hooks/hooks.json` gates launch from the CLI hook surface: a desktop interface that does not launch plugin process hooks runs none of them, so the supported route there is a CLI session. The reference also records the platform follow-up — owner: host adapter maintainer; re-checked when ZCode exposes a supported hook launch path for desktop sessions or a user reports a gate that silently does not run — and that the follow-up is a `hooks/` change rather than a new host package.

<!-- CN -->
- **ZCode 的 hook 声明被限定在 CLI hook 面。** `mstar-host` → `references/zcode.md` 与 `INSTALL.md` 现在明确：内置的 `hooks/hooks.json` 三道门禁由 CLI hook 面启动，不启动插件 process hook 的桌面界面上一道门禁都不会运行，那里的受支持路径是 CLI 会话。参考文件同时记录了平台侧的后续项——负责人：host adapter 维护者；当 ZCode 为桌面会话提供受支持的 hook 启动路径，或有用户报告某道门禁静默未运行时重新核查——并说明该后续项是一次 `hooks/` 改动，而非新建宿主包。
