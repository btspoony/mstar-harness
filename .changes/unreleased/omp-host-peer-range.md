---
packages: omp
---

- Widened the optional host peer to `@oh-my-pi/pi-coding-agent@^18.3.0` (any 18.x host) and moved the development baseline in `devDependencies` to `18.3.0`, so the suite validates against the host users actually run. The exact `18.2.1` pin had already drifted from reality: hosts in the omp 18.3.0 line refuse any `bash` tool call whose input carries `env` without a service `name` (`ready and env require a service name.`), a parameter-surface contract this package's shell-transport code must respect.

<!-- CN -->
- 将可选宿主 peer 放宽为 `@oh-my-pi/pi-coding-agent@^18.3.0`（任意 18.x 宿主），并把 `devDependencies` 中的开发基线升至 `18.3.0`，使测试套件在用户实际运行的宿主上验证。精确的 `18.2.1` pin 早已与现实漂移：omp 18.3.0 线宿主会拒绝任何输入携带 `env` 但缺少服务名 `name` 的 `bash` 工具调用（`ready and env require a service name.`），本包的 shell 传输代码必须遵守这一参数面契约。
