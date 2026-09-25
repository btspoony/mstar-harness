---
packages: omp
---

- Widened the optional host peer to `@oh-my-pi/pi-coding-agent@^18.3.0` (any 18.x host) and moved the development baseline in `devDependencies` to `18.3.0`, so the suite validates against the host users actually run. The exact `18.2.1` pin had already drifted from reality: omp 18.3.0 refuses any `bash` tool call that carries `env` without a service `name`, which is the contract the identity revision now honours by travelling in the command prefix instead.

<!-- CN -->
- 将可选宿主 peer 放宽为 `@oh-my-pi/pi-coding-agent@^18.3.0`（任意 18.x 宿主），并把 `devDependencies` 中的开发基线升至 `18.3.0`，使测试套件在用户实际运行的宿主上验证。精确的 `18.2.1` pin 早已与现实漂移：omp 18.3.0 会拒绝任何携带 `env` 但缺少服务名 `name` 的 `bash` 工具调用，身份注入现在改走命令前缀以遵守这一契约。
