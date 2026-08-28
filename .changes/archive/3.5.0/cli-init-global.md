---
category: Harness
packages: root, cli
---

- `mstar-harness init` now auto-installs the **matching-version** `@mstar-harness/cli` globally after a successful run, so the `mstar-harness` binary lands on PATH for engine-check commands. The install is skipped when the PATH version already matches, is fail-soft on npm errors (init still exits 0), and can be opted out with `--no-global-cli`; `--dry-run` prints the would-run `npm i -g` command without executing it.
- `mstar-harness doctor` now prints a non-fatal CLI-on-PATH note (missing / mismatch / match) for every target.

<!-- CN -->
- `mstar-harness init` 成功运行后会自动全局安装**匹配版本**的 `@mstar-harness/cli`，使 `mstar-harness` 二进制进入 PATH 供引擎校验命令使用。PATH 上版本已匹配时跳过安装；npm 出错时 fail-soft（init 仍以 0 退出）；可用 `--no-global-cli` 跳过；`--dry-run` 只打印将执行的 `npm i -g` 命令而不执行。
- `mstar-harness doctor` 现在会对每个 target 打印一条非致命 CLI-on-PATH 提示（缺失 / 版本不匹配 / 匹配）。
