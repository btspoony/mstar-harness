---
packages: omp
---

- **The model-handoff session-identity injection moved from the `bash` call's `env` input field to a shell prefix** (`export MSTAR_HOST_SESSION_ID=<host session id>;` prepended to the command). Hosts in the omp 18.3.0 line refuse any `bash` call whose input carries `env` without a service `name` — `ready and env require a service name.` — so the 3.11.2 field-level revision failed **every** shell call of the session before execution. The child environment `mstar plan bind` inherits is unchanged, the revision stays `bash`-only and fail-safe on malformed input shapes, and a session with no id still injects nothing.

<!-- CN -->
- **model-handoff 的会话身份注入从 `bash` 调用的 `env` 输入字段改道为 shell 前缀**（在命令前拼接 `export MSTAR_HOST_SESSION_ID=<宿主会话 id>;`）。omp 18.3.0 线宿主拒绝任何输入携带 `env` 但缺少服务名 `name` 的 `bash` 调用——`ready and env require a service name.`——因此 3.11.2 的字段级注入会让**会话中每一次 shell 调用在执行前失败**。`mstar plan bind` 继承的子进程环境不变，注入仍仅限 `bash` 且对畸形输入保持 fail-safe，无 id 的会话仍然不注入。
