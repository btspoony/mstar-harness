---
category: Harness
packages: root
---

- The protected `mstar persist` kinds (`status`, `snapshot`, `residuals`) now have exactly one writer: `--expect-version <absent|sha256:<hex>>` routes the put through the engine's locked `replaceCoordinatedArtifact` (same-host CAS), a coordinated `snapshot` replacement additionally requires `--session <coordinator envelope>`, and an injected `--store` module is refused because it cannot honour that contract. A missing / invalid / mixed flag fails closed as a usage error (exit `2`) before anything is read, and a version or session mismatch is an engine refusal (exit `1`) with the bytes intact.
- `mstar persist get <protected> --versioned` reports the token to pass back as `--expect-version`, so a read-modify-write is `get --versioned` → `put --expect-version`.

<!-- CN -->
- 受保护的 `mstar persist` 类型（`status`、`snapshot`、`residuals`）现在只有一个写入者：`--expect-version <absent|sha256:<hex>>` 把 put 路由到引擎加锁的 `replaceCoordinatedArtifact`（同机 CAS）；协调的 `snapshot` 替换还必须带 `--session <coordinator envelope>`；注入的 `--store` 模块因无法满足该契约而被拒绝。缺失／非法／混用标志在读入任何内容之前就 fail-closed（用法错误，退出码 `2`）；版本或会话不匹配是引擎拒绝（退出码 `1`），字节保持不变。
- `mstar persist get <受保护类型> --versioned` 会给出应回填给 `--expect-version` 的令牌，因此读-改-写就是 `get --versioned` → `put --expect-version`。
