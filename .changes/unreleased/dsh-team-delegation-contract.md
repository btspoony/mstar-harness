---
category: Changed
packages: dsh
---

- The injected Agent Teams delegation contract now names the real channels: writable work defaults to one durable teammate per writable track (`subagent` / `subagent_fork`, legacy `spawn_teammate`) reused via `send_message`, and read-only seats/fan-out go to `workflow` — a `subagent` call on a Team-mode root joins the roster, so it is never the read-only route.

<!-- CN -->
- 注入的 Agent Teams 派发契约改为点名真实通道：可写工作默认按可写轨道复用一个耐久 teammate（`subagent` / `subagent_fork`，旧名 `spawn_teammate`），用 `send_message` 复用；只读席位与只读扇出走 `workflow`——Team-mode root 上的 `subagent` 调用会占用 roster，故绝不是只读通道。
