---
packages: root,cli,omp,commands,engine
---

- `init` no longer reports success for a failed host install: a refused link, install, or build step ends with a non-zero exit that names the cause and a recovery.
- omp install is deterministic about a pre-existing plugin tree (removes a stale entry through a supported route before linking, verifies the installed version), and no longer passes a scope flag the install path ignores.
- The omp coordinator tool's session parameter uses the two-argument `record` form, so the tool schema constructs under every host shim probed.
- A dsh incompatibility refusal now names the runtime, the plugin spec, and dsh's own `allow-version` recovery instead of relaying the rejection alone.
- Version values come from `package.json` at runtime; the Bun-version gate and version-comparison tests are gone.
- `init` installs the published `@mstar-harness/cli` latest globally when a newer version than the one running is published, and warns with both versions when they differ: a cached `npx` resolution can otherwise run an older CLI, and every step of `init` — including the global install — used to follow that older version. The registry probe is bounded, skipped by `--dry-run`, and silent when offline, so it never blocks or fails an init.

<!-- CN -->
- `init` 不再把失败的宿主安装当作成功：link / install / build 任一步被拒都会以非零退出结束，并给出原因与恢复路径。
- omp 安装对已存在的插件树改为确定性处理（先经支持的路径移除陈旧条目再 link，并校验实际安装版本），也不再向会忽略它的 install 路径传 scope。
- omp coordinator 工具的 session 参数改用双参 `record` 形式，使工具 schema 在已验证的各宿主 shim 下都能构造成功。
- dsh 的版本不兼容拒绝现在会给出运行时、插件 spec 与 dsh 自身的 `allow-version` 恢复命令，而不只是转发拒绝信息。
- 版本值一律在运行时从 `package.json` 读取；Bun 版本门禁与版本比较测试已删除。
- 当已发布的最新版比正在运行的版本更新时，`init` 会把该最新版 `@mstar-harness/cli` 全局装上，并在版本不同时打印两者：否则 `npx` 的缓存解析可能让较旧的 CLI 运行，而 `init` 的每一步（包括全局安装）都会跟随那个旧版本。registry 探测有超时上限、`--dry-run` 下跳过、离线时静默，因此既不会阻塞也不会让 init 失败。
