---
category: Harness
packages: dsh
---

- The dsh panel now carries the whole product instead of three sections: the right Sidebar mounts the shared shell (a `Focus` landing view plus the five destinations), and the main area mounts a keyed full-page seat from the **same** shell, so both seats resolve one destination set from one source. All four record types open from their lists and return; a project detail switches between its three features with `Roadmap` permanently default. A project opens from the reads the product has — its own roadmap plus its project-scoped issues and iterations — and its identity (title, lifecycle, path) comes from its catalog row, so a project that declares no roadmap still shows who it is instead of a name synthesised from its id. The shell declares the named `pane` container the shared responsive rules key off, so the product reflows at container widths inside the Sidebar rather than at window widths.
- Removed the real-time surfaces the owner rejected: the event-log section and its graph, the five-step gate stepper, the meta dock, the freshness footer, and the **5-second polling loop** behind them. The snapshot payload shrank to the session digest, and the plugin's own locale table went from 412 to 72 lines because most of it described surfaces that no longer exist.
- The read path is per-view and one-shot: no timer, no visibility gating, a bounded deadline per request, and a degraded member never rendered as "nothing here". A successful workflow pick re-reads what depends on the binding, so the product's only write is visibly effective. The **Iterations** destination reads its own page instead of waiting on a workflow binding, and discloses "showing N of M" when the store holds more rows than that page rather than capping quietly.
- The host is untouched: no patch, no fork, no `@deepseek-ai/*` value import in the client bundle, and no palette aliasing — the plugin resolves the host's colour *scheme* and lets the shared tokens own the palette.

<!-- CN -->
- dsh 面板现在承载完整产品而非三个分节：右侧栏挂载共享外壳（`Focus` 落地视图加五个目的地），主区域用**同一个**外壳挂载一个 keyed 全页面板，两个座位因此从同一来源解析同一组目的地。四种记录都能从列表打开并返回；项目详情在三个功能间切换，`Roadmap` 永久为默认。项目详情由产品确实拥有的读取组成 —— 它自己的路线图，加上按项目限定的 issues 与 iterations —— 身份（标题、生命周期、路径）取自其 catalog 行，因此声明无路线图的项目仍显示真实身份，而不是用 id 拼出来的名字。外壳声明了共享响应式规则所依赖的具名 `pane` 容器，产品因此在侧栏内按容器宽度重排，而不是跟随窗口宽度。
- 移除 owner 否决的实时面：事件记录分区及其 graph、五步门禁 stepper、meta dock、新鲜度页脚，以及支撑它们的 **5 秒轮询**。快照载荷收缩为会话摘要，插件自有语言表从 412 行降到 72 行，因为其中大部分描述的是已不存在的界面。
- 读路径改为按视图、一次性：无定时器、无可见性门控、每请求有超时上限，降级成员绝不渲染成"这里什么都没有"。workflow 选择成功后重读依赖该绑定的读，使产品唯一的写操作可见地生效。**Iterations** 目的地读取自己的列表页，不再等待 workflow 绑定；store 中的行数多于一页时明确写出 "showing N of M"，而不是悄悄截断。
- 宿主未被改动：无 patch、无 fork，客户端 bundle 无 `@deepseek-ai/*` 值导入，也不做调色板别名 —— 插件只解析宿主的颜色**方案**，调色板由共享令牌拥有。
