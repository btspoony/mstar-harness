---
packages: root, engine, cli
---

- Scope local verification and review to changed behavior, parallelize independent work, and keep routine QA on targeted unit evidence; full local suites require explicit user authorization.
- Accept explicit `scoped-check` evidence for documentation and policy changes without invented test files, while preserving executable-change test evidence.
- Add the independent `mstar-e2e` workflow and `/amazing-e2e-check` entry, including Codex project command installation, for explicitly requested browser, device, and installed-deployment scenarios.

<!-- CN -->
- 本地验证与审查限定于改动行为，独立工作并行，常规 QA 仅使用定向单元证据；全量本地测试须用户明确授权。
- 文档和策略修改可提交明确的 `scoped-check` 证据，无需虚构测试文件；可执行逻辑变更仍须真实测试证据。
- 新增独立 `mstar-e2e` workflow 与 `/amazing-e2e-check` 入口，包含 Codex 项目命令安装，用于用户明确请求的浏览器、真机及安装部署场景。
