---
category: Added
packages: commands
---

- **`mstar pr-review post` routes through a named publisher adapter:** the new `--provider <id>` option (default `github`) selects the registered forge publisher that resolves the PR, fetches the head-pinned diff and posts the review; an unregistered id refuses with `pr-review.post.unsupported-provider` naming the registered ids, and a forge no adapter serves follows the documented project-tooling path in `pr-delivery.md` or STOPs — never a hand-post. The engine URL parser now accepts any forge host (`<scheme>://<host>/{owner}/{repo}/pull/{n}`) and `ReviewPostPlan` carries the host.

<!-- CN -->
- **`mstar pr-review post` 经由具名 publisher 适配器执行**：新增 `--provider <id>` 选项（默认 `github`）选择注册的 forge publisher 来解析 PR、取 head 固定的 diff 并发帖；未注册的 id 以 `pr-review.post.unsupported-provider` 拒绝并列出已注册 id，无适配器服务的 forge 按 `pr-delivery.md` 中的项目工具路径发帖，否则 STOP——绝不手工发帖。引擎的 URL 解析现在接受任意 forge host（`<scheme>://<host>/{owner}/{repo}/pull/{n}`），`ReviewPostPlan` 携带 host。
