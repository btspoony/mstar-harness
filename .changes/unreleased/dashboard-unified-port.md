---
category: Harness
packages: cli,commands
---

- Rewrote the standalone `mstar dashboard` on the shared layer: the browser entry is React consuming `@mstar-harness/ui`, Preact and `htm` are gone with their last importer, and the build takes its CSS from the bundle's single asset output instead of a hand-maintained stylesheet. The generated artifact stays byte-deterministic **from the repo root and from `packages/cli`** (the generator now anchors to the package instead of inheriting the caller's working directory), and `NODE_ENV` is defined so React ships at 137 KB rather than 332 KB.
- All five destinations and their detail views now mount shared screens: Overview reads the new aggregated `/api/overview` in one snapshot, the four lists keep their state machines and the address-bar round-trip, and **Projects** carries the roadmap as a feature of a project alongside that project's Issues and Iterations. `#roadmap` is removed rather than aliased.
- Language and theme switches persist their choice, fall back on unreadable storage, and `<html lang>` follows the resolved locale. The skip link moves focus to the main landmark instead of navigating, and the shell's chrome strings resolve through the dictionary rather than being derived from route ids.
- Deleted `packages/cli/web/views/` and the two files that only referenced each other; a green suite that exercised an unpublished file is gone with them.

<!-- CN -->
- 用共享层重写独立 `mstar dashboard`：浏览器入口改为消费 `@mstar-harness/ui` 的 React，`preact` 与 `htm` 随最后一个引用者一并移除，构建改从 bundle 的单一 CSS 产物取样式，不再维护手写样式表。生成物**从仓库根与从 `packages/cli`** 都字节一致（生成器锚定到包内，不再继承调用者工作目录），并定义 `NODE_ENV`，使 React 体积从 332 KB 降到 137 KB。
- 五个目的地及其详情视图全部挂载共享屏幕：Overview 一次性读取新增的 `/api/overview` 聚合快照，四个列表保留各自状态机与地址栏往返，**Projects** 把路线图作为项目内的功能、与该项目的 Issues 和 Iterations 并列。`#roadmap` 是移除而非别名。
- 语言与主题开关持久化选择、在存储不可读时回退，`<html lang>` 跟随解析后的语言。跳过链接改为把焦点移到主地标而不是导航，外壳文案改由字典解析，不再从路由 id 派生。
- 删除 `packages/cli/web/views/` 以及两个只互相引用的文件；"绿着的套件在测一个不发布的文件"这种情况随之消失。
