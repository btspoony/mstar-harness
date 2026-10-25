---
category: Harness
packages: dsh
---

- The dsh panel now carries the whole product instead of three sections: the right Sidebar mounts the shared shell (a `Focus` landing view plus the five destinations), and the main area mounts a keyed full-page seat from the **same** shell, so both seats resolve one destination set from one source. All four record types open from their lists and return; a project detail switches between its three features with `Roadmap` permanently default.
- Removed the real-time surfaces the owner rejected: the event-log section and its graph, the five-step gate stepper, the meta dock, the freshness footer, and the **5-second polling loop** behind them. The snapshot payload shrank to the session digest, and the plugin's own locale table went from 412 to 60 lines because most of it described surfaces that no longer exist.
- The read path is per-view and one-shot: no timer, no visibility gating, a bounded deadline per request, and a degraded member never rendered as "nothing here". A successful workflow pick re-reads what depends on the binding, so the product's only write is visibly effective.
- The host is untouched: no patch, no fork, no `@deepseek-ai/*` value import in the client bundle, and no palette aliasing — the plugin resolves the host's colour *scheme* and lets the shared tokens own the palette.

<!-- CN -->
- dsh 面板现在承载完整产品而非三个分节：右侧栏挂载共享外壳（`Focus` 落地视图加五个目的地），主区域用**同一个**外壳挂载一个 keyed 全页面板，两个座位因此从同一来源解析同一组目的地。四种记录都能从列表打开并返回；项目详情在三个功能间切换，`Roadmap` 永久为默认。
- 移除 owner 否决的实时面：事件记录分区及其 graph、五步门禁 stepper、meta dock、新鲜度页脚，以及支撑它们的 **5 秒轮询**。快照载荷收缩为会话摘要，插件自有语言表从 412 行降到 60 行，因为其中大部分描述的是已不存在的界面。
- 读路径改为按视图、一次性：无定时器、无可见性门控、每请求有超时上限，降级成员绝不渲染成"这里什么都没有"。workflow 选择成功后重读依赖该绑定的读，使产品唯一的写操作可见地生效。
- 宿主未被改动：无 patch、无 fork，客户端 bundle 无 `@deepseek-ai/*` 值导入，也不做调色板别名 —— 插件只解析宿主的颜色**方案**，调色板由共享令牌拥有。
