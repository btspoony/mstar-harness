---
packages: dsh
---

- **The `mstar:engine-status` context builds a workspace's payload once on first render.** A workspace that was not the boot one had no memo entry, so the render answered from a synchronous build and also kicked an async refresh that rebuilt the identical payload for the same key. The miss path now builds once, stores that payload with its build timestamp, and returns the summary of that same payload; the TTL-refresh path for an existing entry is unchanged.

<!-- CN -->
- **`mstar:engine-status` context 在首次渲染时只构建一次某工作区的 payload。** 非启动工作区没有 memo 条目，渲染因此先用同步构建作答，同时还会启动一次异步 refresh 为同一个 key 重建完全相同的 payload。现在未命中路径只构建一次、连同构建时间戳存入 memo，并返回同一 payload 的摘要；已存在条目的 TTL 刷新路径保持不变。
