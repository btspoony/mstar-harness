---
category: Harness
packages: root, cli
---

- **Security:** Removed worker CLI attestation based on caller-controlled environment values and filesystem shape. Unauthenticated `review-advice` calls now fail before pilot/pack collection; worker-side submission remains unavailable until an authenticated launch adapter exists.

<!-- CN -->
- **安全性：**移除基于调用方可控环境变量和文件系统形状的 worker CLI 认证。未认证的 `review-advice` 调用会在收集 pilot/pack 前失败；在提供认证启动适配器前，worker 侧提交不可用。
