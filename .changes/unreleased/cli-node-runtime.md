---
category: Fixed
packages: root
---

- **The published CLI is a Node entrypoint again.** `dist/mstar-harness.js` shipped a shebang that pointed at the repository's development runtime, so every plain `mstar-harness` and `npx @mstar-harness/cli` launch ran on whatever that runtime happened to be on `PATH` — even on a machine with a supported Node, and even though a package runner installs the package with the Node it already has. The bin now carries the Node shebang (`#!/usr/bin/env node`), and `@mstar-harness/cli` declares one runtime requirement (`node >=24.18.0`) instead of two.
- **User-facing runtime text names one runtime.** The `store.runtime-unsupported` refusal and its recovery, the `status validate` recovery, the `doctor` runtime-floor message, and the runtime recorded in SDD evidence now name the Node floor (`>=24.18.0`, native `node:sqlite`) and the runtime actually executing the entrypoint — never a second runtime as the requirement or the way out. `store.upgrade` also stopped answering a runtime refusal with the generic "correct the operator input" recovery.
- **Docs follow the entrypoint.** `INSTALL.md` (prerequisites, CLI install, MCP launch, doctor note), `README.md`/`README_CN.md`, and `docs/runtime-reference.md` state the Node floor as the only launch requirement, and the from-checkout steps now point at the maintainer material that owns the development-toolchain commands instead of spelling them out. Host-plugin READMEs attribute their runtime floor to the host that loads them.

<!-- CN -->
- **发布的 CLI 重新以 Node 作为入口运行时。** `dist/mstar-harness.js` 之前带的 shebang 指向本仓库的开发运行时，因此每次直接运行 `mstar-harness` 或 `npx @mstar-harness/cli` 都跑在 PATH 上碰巧存在的那个运行时上——即使在已有受支持 Node 的机器上，即使包运行器本就用本机 Node 安装。现在 bin 带 Node shebang（`#!/usr/bin/env node`），且 `@mstar-harness/cli` 只声明一个运行时要求（`node >=24.18.0`）。
- **面向用户的运行时文本只提一个运行时。** `store.runtime-unsupported` 的拒绝与其 recovery、`status validate` 的 recovery、`doctor` 的运行时下限提示，以及 SDD 证据中记录的运行时，现在只指明 Node 下限（`>=24.18.0`，原生 `node:sqlite`）与实际执行该入口的运行时，绝不再把第二个运行时写成要求或出路。`store.upgrade` 也不再拿“修正操作者输入”这类通用 recovery 回应运行时拒绝。
- **文档随入口对齐。** `INSTALL.md`（前置要求、CLI 安装、MCP 启动、doctor 说明）、`README.md`/`README_CN.md` 与 `docs/runtime-reference.md` 只把 Node 下限写成启动要求；从 checkout 的步骤改为指向拥有这些开发工具链命令的维护者文档，不再直接写出命令。宿主插件 README 把运行时下限归因于加载它的宿主。
