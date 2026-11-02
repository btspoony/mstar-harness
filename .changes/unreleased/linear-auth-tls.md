---
packages: cli
---

- **The authorization flow refuses a non-TLS endpoint.** The authorization code
  and its PKCE verifier travel to whatever the metadata advertises, so accepting a
  plaintext endpoint would hand both to anyone on the path. Every advertised
  endpoint must now be `https:`; loopback is the only exception, and only because
  it never leaves the machine.

<!-- CN -->
- **授权流程拒绝非 TLS 端点。** 授权码与它的 PKCE verifier 会被发送到元数据所声明的地址，
  接受明文端点等于把两者交给链路上的任何人。现在声明的每个端点都必须是 `https:`；
  唯一例外是回环地址，因为它从不离开本机。
